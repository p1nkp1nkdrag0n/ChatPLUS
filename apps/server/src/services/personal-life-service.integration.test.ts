import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CharacterSpecSchema,
  type CharacterSpec,
  type SelfPlanBundle,
} from "@personasim/contracts";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { buildOriginalDraft, initialRuntimeState } from "../domain/defaults.js";
import { runtimeStateSchema, scheduleItemSchema } from "../domain/schemas.js";
import { FakeClock } from "../runtime/clock.js";
import { SseHub } from "../sse/hub.js";
import { LlmService } from "./llm-service.js";
import { PersonalIntentService } from "./personal-intent-service.js";
import {
  PersonalLifeService,
  type PersonalLifeMode,
} from "./personal-life-service.js";
import { ScheduleService } from "./schedule-service.js";
import {
  SelfPlanningService,
  type SelfPlanningServiceResult,
} from "./self-planning-service.js";

const AGENT_ID = "agent-personal-life";
const NOW_UTC = "2026-06-01T08:00:00.000Z";
const HORIZON_UTC = "2026-06-04T08:00:00.000Z";
const SLEEP_ID = "schedule-personal-life-sleep";
const PREFERENCE_ID = "preference-night-sky";

type Harness = {
  database: Database;
  store: DatabaseStore;
  clock: FakeClock;
  intents: PersonalIntentService;
  schedules: ScheduleService;
  planner: SelfPlanningService;
  sse: SseHub;
  intentId: string;
};

const openedDatabases: Database[] = [];

describe("PersonalLifeService SQLite integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of openedDatabases.splice(0)) {
      if (database.open) database.close();
    }
  });

  it("is a strict no-op while mode is off", () => {
    const harness = createHarness("shadow");
    const before = snapshotCounts(harness.database);
    const listActive = vi.spyOn(harness.intents, "listActive");
    const plan = vi.spyOn(harness.planner, "ensureSelfInitiatedPlans");
    const listSchedule = vi.spyOn(harness.schedules, "list");
    const publish = vi.spyOn(harness.sse, "publish");
    const service = coordinator(harness, "off");

    const result = service.ensureSelfInitiatedPlans(AGENT_ID);

    expect(result).toMatchObject({
      status: "off",
      mode: "off",
      planning: undefined,
      consumedIntentId: undefined,
      stateChanged: false,
    });
    expect(listActive).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(listSchedule).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(snapshotCounts(harness.database)).toEqual(before);
  });

  it("returns a shadow audit without schedule, intent, or state writes", () => {
    const harness = createHarness("shadow");
    const before = snapshotCounts(harness.database);
    const stateBefore = harness.store.getRuntimeState(AGENT_ID);
    const expire = vi.spyOn(harness.intents, "expire");
    const markConsumed = vi.spyOn(harness.intents, "markConsumed");
    const publish = vi.spyOn(harness.sse, "publish");
    const service = coordinator(harness, "shadow");

    const result = service.ensureSelfInitiatedPlans(AGENT_ID);

    expect(result.status).toBe("shadowed");
    expect(result.planning).toMatchObject({
      status: "shadowed",
      mode: "shadow",
      bundle: { intentId: harness.intentId },
    });
    expect(expire).not.toHaveBeenCalled();
    expect(markConsumed).not.toHaveBeenCalled();
    expect(harness.intents.read(AGENT_ID, harness.intentId).status).toBe(
      "pending",
    );
    expect(harness.store.listSchedule(AGENT_ID)).toEqual([]);
    expect(harness.store.getRuntimeState(AGENT_ID)).toEqual(stateBefore);
    expect(snapshotCounts(harness.database)).toEqual(before);
    expect(publish).not.toHaveBeenCalled();
  });

  it("atomically commits a night bundle without realizing sleep debt early", () => {
    const harness = createHarness("enforced", 650);
    seedSleep(harness.store);
    publishNextCharacterSpec(harness.store);
    const claim = vi.spyOn(harness.intents, "markConsumed");
    const applyBundle = vi.spyOn(harness.schedules, "applySelfPlanBundle");
    const transactions = installBundlePlanner(
      harness,
      validNightBundle(harness.intentId),
    );
    const publish = vi.spyOn(harness.sse, "publish");
    const service = coordinator(harness, "enforced");

    const result = service.ensureSelfInitiatedPlans(AGENT_ID);
    const claimOrder = claim.mock.invocationCallOrder[0] ?? Number.MAX_VALUE;
    const effectOrder = applyBundle.mock.invocationCallOrder[0] ?? -1;
    expect(claimOrder).toBeLessThan(effectOrder);

    expect(result).toMatchObject({
      status: "committed",
      consumedIntentId: harness.intentId,
      revalidatedIntentIds: [harness.intentId],
      rejectedIntentIds: [],
      stateChanged: false,
      planning: {
        status: "committed",
        lostSleepMinutes: 120,
      },
      state: {
        sleepDebtMinutes: 650,
        revision: 0,
      },
    });
    expect(transactions).toEqual(["caller_owned"]);
    expect(harness.intents.read(AGENT_ID, harness.intentId).status).toBe(
      "consumed",
    );
    expect(harness.store.getScheduleItem(SLEEP_ID)).toMatchObject({
      startAtUtc: "2026-06-02T01:00:00.000Z",
      endAtUtc: "2026-06-02T07:00:00.000Z",
      plannedSleepReductionMinutes: 120,
      revision: 1,
    });
    const [created] = harness.store
      .listSchedule(AGENT_ID)
      .filter((item) => item.source === "self_initiated");
    expect(created).toMatchObject({
      title: "Night stargazing",
      source: "self_initiated",
      sourceIntentId: harness.intentId,
    });
    expect(created?.correlationId).toMatch(/^self_plan_/u);
    expect(created?.causationId).toBe(created?.correlationId);
    const consumedEvent = harness.store
      .listDomainEvents(AGENT_ID, 100)
      .find((event) => event["eventType"] === "personal_intent.consumed");
    expect(consumedEvent).toMatchObject({
      correlationId: created?.correlationId,
      causationId: created?.correlationId,
    });
    const selfPlanEvent = harness.store
      .listDomainEvents(AGENT_ID, 100)
      .find((event) => event["eventType"] === "self_plan.committed");
    expect(selfPlanEvent).toMatchObject({
      streamType: "self_plan",
      streamId: harness.intentId,
      correlationId: created?.correlationId,
      causationId: created?.correlationId,
      idempotencyKey: `personal-life:${AGENT_ID}:${harness.intentId}:self-plan-committed`,
    });
    expect(selfPlanEvent?.["payload"]).toMatchObject({
      intentId: harness.intentId,
      createdScheduleItemIds: [created?.id],
      changedScheduleItemIds: [SLEEP_ID, created?.id].sort(),
      lostSleepMinutes: 120,
      sleepAdjustment: validNightBundle(harness.intentId).sleepAdjustment,
      correlationId: created?.correlationId,
      causationId: created?.correlationId,
    });
    expect(harness.store.getRuntimeState(AGENT_ID)).toMatchObject({
      sleepDebtMinutes: 650,
      revision: 0,
    });
    expect(sleepDebtColumn(harness.database)).toBe(650);
    expect(publish.mock.calls.map(([event]) => event.type)).toEqual([
      "schedule.updated",
    ]);
    const scheduleBeforeReplay = harness.store.listSchedule(AGENT_ID);
    const stateBeforeReplay = harness.store.getRuntimeState(AGENT_ID);
    const eventsBeforeReplay = harness.store.listDomainEvents(AGENT_ID, 100);
    const countsBeforeReplay = snapshotCounts(harness.database);
    publish.mockClear();

    const replay = service.ensureSelfInitiatedPlans(AGENT_ID);

    expect(replay).toMatchObject({
      status: "already_claimed",
      consumedIntentId: harness.intentId,
      planning: undefined,
      stateChanged: false,
    });
    expect(transactions).toEqual(["caller_owned", "caller_owned"]);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(applyBundle).toHaveBeenCalledTimes(1);
    expect(harness.store.listSchedule(AGENT_ID)).toEqual(scheduleBeforeReplay);
    expect(harness.store.getRuntimeState(AGENT_ID)).toEqual(stateBeforeReplay);
    expect(harness.store.listDomainEvents(AGENT_ID, 100)).toEqual(
      eventsBeforeReplay,
    );
    expect(snapshotCounts(harness.database)).toEqual(countsBeforeReplay);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not consume an intent when final schedule validation rejects", () => {
    const harness = createHarness("enforced", 650);
    seedSleep(harness.store);
    const transactions = installBundlePlanner(
      harness,
      invalidNightBundle(harness.intentId),
    );
    const stateBefore = harness.store.getRuntimeState(AGENT_ID);
    const publish = vi.spyOn(harness.sse, "publish");
    const service = coordinator(harness, "enforced");

    const result = service.ensureSelfInitiatedPlans(AGENT_ID);

    expect(result).toMatchObject({
      status: "rejected",
      consumedIntentId: undefined,
      stateChanged: false,
      planning: {
        status: "rejected",
        failureReason: "validation_failed",
      },
    });
    expect(transactions).toEqual(["caller_owned"]);
    expect(harness.intents.read(AGENT_ID, harness.intentId).status).toBe(
      "pending",
    );
    expect(harness.store.listSchedule(AGENT_ID)).toEqual([
      expect.objectContaining({
        id: SLEEP_ID,
        startAtUtc: "2026-06-01T23:00:00.000Z",
        revision: 0,
      }),
    ]);
    expect(harness.store.getRuntimeState(AGENT_ID)).toEqual(stateBefore);
    expect(
      harness.store
        .listDomainEvents(AGENT_ID, 100)
        .filter((event) => event["eventType"] === "personal_intent.consumed"),
    ).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not persist runtime state while a sleep reduction remains planned", () => {
    const harness = createHarness("enforced", 650);
    seedSleep(harness.store);
    installBundlePlanner(harness, validNightBundle(harness.intentId));
    const applyBundle = vi.spyOn(harness.schedules, "applySelfPlanBundle");
    const persistState = vi.spyOn(harness.store, "updateRuntimeState");
    const service = coordinator(harness, "enforced");

    const result = service.ensureSelfInitiatedPlans(AGENT_ID);

    expect(result).toMatchObject({ status: "committed", stateChanged: false });
    expect(applyBundle).toHaveBeenCalledTimes(1);
    expect(persistState).not.toHaveBeenCalled();
    expect(harness.store.getScheduleItem(SLEEP_ID)).toMatchObject({
      plannedSleepReductionMinutes: 120,
    });
    expect(sleepDebtColumn(harness.database)).toBe(650);
  });

  it("rolls back claim, schedule metadata, and lineage on audit failure", () => {
    const harness = createHarness("enforced", 650);
    seedSleep(harness.store);
    installBundlePlanner(harness, validNightBundle(harness.intentId));
    const stateBefore = harness.store.getRuntimeState(AGENT_ID);
    const publish = vi.spyOn(harness.sse, "publish");
    const insertDomainEvent = harness.store.insertDomainEvent.bind(
      harness.store,
    );
    vi.spyOn(harness.store, "insertDomainEvent").mockImplementation((input) =>
      input.eventType === "self_plan.committed"
        ? false
        : insertDomainEvent(input),
    );
    const service = coordinator(harness, "enforced");

    expect(() => service.ensureSelfInitiatedPlans(AGENT_ID)).toThrow(
      "Failed to record self-plan commit lineage",
    );

    expect(harness.intents.read(AGENT_ID, harness.intentId).status).toBe(
      "pending",
    );
    expect(harness.store.listSchedule(AGENT_ID)).toEqual([
      expect.objectContaining({
        id: SLEEP_ID,
        startAtUtc: "2026-06-01T23:00:00.000Z",
        endAtUtc: "2026-06-02T07:00:00.000Z",
        revision: 0,
      }),
    ]);
    expect(harness.store.getRuntimeState(AGENT_ID)).toEqual(stateBefore);
    expect(sleepDebtColumn(harness.database)).toBe(650);
    const eventTypes = harness.store
      .listDomainEvents(AGENT_ID, 100)
      .map((event) => event["eventType"]);
    expect(eventTypes).not.toContain("personal_intent.consumed");
    expect(eventTypes).not.toContain("self_plan.committed");
    expect(publish).not.toHaveBeenCalled();
  });
});

function createHarness(
  plannerMode: "shadow" | "enforced",
  sleepDebtMinutes = 0,
): Harness {
  const database = openDatabase(":memory:");
  openedDatabases.push(database);
  runMigrations(database);
  const store = new DatabaseStore(database);
  const clock = new FakeClock(NOW_UTC);
  const draft = buildOriginalDraft({
    name: "Personal Life Agent",
    worldSetting: "A contemporary city",
    workOrRole: "Illustrator",
    coreTraits: ["Curious", "Steady", "Warm"],
    coreContradiction: "Values routine and occasional night exploration",
    mainGoal: "Complete a portfolio",
    initialRelationship: "Close friend",
    dialogueStyle: "Brief and warm",
    tier: "high_fidelity",
    timezone: "UTC",
  });
  draft.persona.preferences = [
    {
      id: PREFERENCE_ID,
      subject: "Night stargazing",
      preference: "Enjoys night stargazing and observing the sky",
      intensity: 0.95,
      conditions: ["clear nights"],
      origin: "user_spec",
      sourceRefs: [],
    },
  ];
  const character = CharacterSpecSchema.parse({
    ...draft,
    id: AGENT_ID,
    version: 1,
    status: "published",
    createdAtUtc: NOW_UTC,
    updatedAtUtc: NOW_UTC,
  });
  store.insertCharacter(character);
  const initialState = runtimeStateSchema.parse({
    ...initialRuntimeState(AGENT_ID, NOW_UTC, draft),
    sleepDebtMinutes,
  });
  store.insertInitialState(initialState, HORIZON_UTC);

  const intents = new PersonalIntentService(store, clock);
  const created = intents.upsertOrMerge({
    agentId: AGENT_ID,
    proposal: {
      basisKind: "preference",
      activity: "Night stargazing",
      category: "leisure",
      durationHint: "120 minutes",
      timingHint: "within 3 days",
      basisRefIds: [PREFERENCE_ID],
      reasonCode: "night_preference",
      reasonSummary: "A grounded preference supports night stargazing.",
      priority: 0.95,
      freshness: 1,
    },
    idempotencyKey: "fixture:personal-life:intent-created",
  });
  const llm = new LlmService(
    {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
    store,
    clock,
  );
  const schedules = new ScheduleService(store, clock, llm);
  const planner = new SelfPlanningService(schedules, clock, plannerMode);
  return {
    database,
    store,
    clock,
    intents,
    schedules,
    planner,
    sse: new SseHub(),
    intentId: created.intent.id,
  };
}

function coordinator(
  harness: Harness,
  mode: PersonalLifeMode,
): PersonalLifeService {
  return new PersonalLifeService(
    harness.store,
    harness.clock,
    harness.intents,
    harness.planner,
    harness.schedules,
    harness.sse,
    mode,
  );
}

function publishNextCharacterSpec(store: DatabaseStore): CharacterSpec {
  const current = store.getCharacterSpec(AGENT_ID);
  if (current === undefined) throw new Error("Missing test character");
  const next = CharacterSpecSchema.parse({
    ...current,
    version: current.version + 1,
    status: "published",
    updatedAtUtc: NOW_UTC,
  });
  store.insertCharacterVersion(next);
  store.updateCharacterHead(next);
  return next;
}

function seedSleep(store: DatabaseStore): void {
  store.insertScheduleItem(
    scheduleItemSchema.parse({
      id: SLEEP_ID,
      agentId: AGENT_ID,
      title: "Sleep",
      description: "Night sleep",
      category: "sleep",
      startAtUtc: "2026-06-01T23:00:00.000Z",
      endAtUtc: "2026-06-02T07:00:00.000Z",
      timezone: "UTC",
      status: "planned",
      rigidity: "fixed",
      priority: 1,
      source: "initial_plan",
      adherenceProbability: 1,
      narrativeImportance: 0.2,
      shareable: false,
      stateEffects: { energy: 0.25, stress: -0.08 },
      revision: 0,
      createdAtUtc: NOW_UTC,
      updatedAtUtc: NOW_UTC,
    }),
  );
}

function validNightBundle(intentId: string): SelfPlanBundle {
  return {
    intentId,
    activity: {
      title: "Night stargazing",
      description: "Observe the night sky.",
      category: "leisure",
      startAtUtc: "2026-06-01T23:00:00.000Z",
      endAtUtc: "2026-06-02T01:00:00.000Z",
      timezone: "UTC",
      rigidity: "flexible",
      priority: 0.8,
      adherenceProbability: 0.85,
      narrativeImportance: 0.8,
      shareable: true,
      stateEffects: { energy: -0.1 },
    },
    sleepAdjustment: {
      sleepItemId: SLEEP_ID,
      newStartAtUtc: "2026-06-02T01:00:00.000Z",
      newEndAtUtc: "2026-06-02T07:00:00.000Z",
      lostSleepMinutes: 120,
    },
  };
}

function invalidNightBundle(intentId: string): SelfPlanBundle {
  const bundle = validNightBundle(intentId);
  return {
    ...bundle,
    sleepAdjustment: {
      ...bundle.sleepAdjustment!,
      lostSleepMinutes: 60,
    },
  };
}

function installBundlePlanner(
  harness: Harness,
  bundle: SelfPlanBundle,
): Array<unknown> {
  const transactions: Array<unknown> = [];
  vi.spyOn(harness.planner, "ensureSelfInitiatedPlans").mockImplementation(
    (input): SelfPlanningServiceResult => {
      transactions.push(input.transaction);
      input.beforeCommit?.(bundle);
      const commit = harness.schedules.applySelfPlanBundle(AGENT_ID, bundle, {
        ...(input.transaction === undefined
          ? {}
          : { transaction: input.transaction }),
        ...(input.correlationId === undefined
          ? {}
          : { correlationId: input.correlationId }),
        ...(input.causationId === undefined
          ? {}
          : { causationId: input.causationId }),
        minimumSleepMinutes: 360,
      });
      const planning = {
        bundle,
        selectedIntentId: bundle.intentId,
        targetLocalDay: "2026-06-01",
        seed: "personal-life-night-fixture",
        rankedCandidates: [
          {
            intentId: bundle.intentId,
            priority: 0.95,
            freshness: 1,
            affinity: 1,
            stateCompatibility: 1,
          },
        ],
        skipped: [],
      };
      if (!commit.ok) {
        return {
          status: "rejected",
          mode: "enforced",
          bundle,
          failureReason: commit.reason,
          planning,
          commit,
          changedItems: [],
          createdItems: [],
          lostSleepMinutes: 0,
        };
      }
      return {
        status: "committed",
        mode: "enforced",
        bundle,
        planning,
        commit,
        changedItems: commit.changedItems,
        createdItems: commit.createdItems,
        lostSleepMinutes: commit.lostSleepMinutes,
      };
    },
  );
  return transactions;
}

function sleepDebtColumn(database: Database): number {
  const row = database
    .prepare(
      "SELECT sleep_debt_minutes AS sleepDebtMinutes FROM runtime_states WHERE agent_id = ?",
    )
    .get(AGENT_ID) as { sleepDebtMinutes: number };
  return Number(row.sleepDebtMinutes);
}
function snapshotCounts(database: Database): {
  personalIntents: number;
  scheduleItems: number;
  domainEvents: number;
} {
  const personalIntents = database
    .prepare("SELECT COUNT(*) AS count FROM personal_intentions")
    .get() as { count: number };
  const scheduleItems = database
    .prepare("SELECT COUNT(*) AS count FROM schedule_items")
    .get() as { count: number };
  const domainEvents = database
    .prepare("SELECT COUNT(*) AS count FROM domain_events")
    .get() as { count: number };
  return {
    personalIntents: Number(personalIntents.count),
    scheduleItems: Number(scheduleItems.count),
    domainEvents: Number(domainEvents.count),
  };
}
