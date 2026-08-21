import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CharacterSpecSchema } from "@personasim/contracts";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { buildOriginalDraft, initialRuntimeState } from "../domain/defaults.js";
import { scheduleItemSchema } from "../domain/schemas.js";
import { FakeClock } from "../runtime/clock.js";
import { SseHub } from "../sse/hub.js";
import { LlmService } from "./llm-service.js";
import { ScheduleService } from "./schedule-service.js";
import { SettlementService } from "./settlement-service.js";

const AGENT_ID = "agent-proactive-atomic";
const CANDIDATE_ID = "proactive-candidate-atomic";
const TRIGGER_EVENT_ID = "activity-event-proactive-atomic";
const NOW_UTC = "2026-08-21T12:00:00.000Z";
const HORIZON_UTC = "2026-08-24T12:00:00.000Z";
const SETTLEMENT_TO_UTC = "2026-08-21T13:00:00.000Z";

type Harness = {
  database: Database;
  store: DatabaseStore;
  clock: FakeClock;
  service: SettlementService;
  sessionId: string;
};

const openedDatabases: Database[] = [];
const temporaryDirectories: string[] = [];

describe("SettlementService atomic proactive delivery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const database of openedDatabases.splice(0)) {
      if (database.open) database.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("claims and sends one pending candidate exactly once", () => {
    const harness = createHarness();

    const first = harness.service.deliverOneProactive(AGENT_ID);
    const repeated = harness.service.deliverOneProactive(AGENT_ID);

    expect(first).toMatchObject({
      agentId: AGENT_ID,
      messageKind: "assistant_proactive",
      triggerEventId: TRIGGER_EVENT_ID,
      metadata: { proactiveCandidateId: CANDIDATE_ID },
    });
    expect(repeated).toBeUndefined();
    const candidate = readCandidate(harness.database);
    expect(candidate).toMatchObject({ status: "sent", revision: 2 });
    expect(candidate.claimToken).toEqual(expect.any(String));
    expect(proactiveMessageCount(harness.database)).toBe(1);
    expect(proactiveAuditTypes(harness.store)).toEqual([
      "conversation.proactive_message_sent",
      "proactive.claimed",
    ]);
  });

  it("does not duplicate a candidate or message when settlement repeats", async () => {
    const harness = createHarness({ seedCandidate: false });
    seedShareableScheduleItem(harness.store);
    harness.clock.setUtc(SETTLEMENT_TO_UTC);

    const firstSettlement = await harness.service.settle(AGENT_ID, {
      toUtc: SETTLEMENT_TO_UTC,
    });
    const repeatedSettlement = await harness.service.settle(AGENT_ID, {
      toUtc: SETTLEMENT_TO_UTC,
    });

    expect(firstSettlement.alreadySettled).toBe(false);
    expect(
      firstSettlement.activityEvents.some(
        (event) => event.eventType === "completed",
      ),
    ).toBe(true);
    expect(repeatedSettlement.alreadySettled).toBe(true);
    expect(candidateCount(harness.database)).toBe(1);

    expect(harness.service.deliverOneProactive(AGENT_ID)).toBeDefined();
    expect(harness.service.deliverOneProactive(AGENT_ID)).toBeUndefined();
    expect(proactiveMessageCount(harness.database)).toBe(1);
    expect(candidateCount(harness.database)).toBe(1);
    expect(
      proactiveAuditTypes(harness.store).filter(
        (eventType) => eventType === "conversation.proactive_message_sent",
      ),
    ).toHaveLength(1);
  });

  it("preserves delivery idempotency after reopening the same SQLite file", () => {
    const directory = mkdtempSync(join(tmpdir(), "personasim-proactive-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "proactive.sqlite");
    const first = createHarness({ databasePath });

    expect(first.service.deliverOneProactive(AGENT_ID)).toBeDefined();
    first.database.close();

    const reopened = createHarness({
      databasePath,
      seed: false,
      clock: first.clock,
    });
    expect(reopened.service.deliverOneProactive(AGENT_ID)).toBeUndefined();
    expect(proactiveMessageCount(reopened.database)).toBe(1);
    expect(readCandidate(reopened.database)).toMatchObject({
      status: "sent",
      revision: 2,
    });
    expect(proactiveAuditTypes(reopened.store)).toEqual([
      "conversation.proactive_message_sent",
      "proactive.claimed",
    ]);
  });

  it("rolls back claim, message, sent state, and audit events together", () => {
    const harness = createHarness();
    const insertDomainEvent = harness.store.insertDomainEvent.bind(
      harness.store,
    );
    let auditWrites = 0;
    const failure = vi
      .spyOn(harness.store, "insertDomainEvent")
      .mockImplementation((input) => {
        auditWrites += 1;
        if (auditWrites === 2) return false;
        return insertDomainEvent(input);
      });

    expect(() => harness.service.deliverOneProactive(AGENT_ID)).toThrow(
      "Proactive delivery audit event was not inserted",
    );
    expect(readCandidate(harness.database)).toEqual({
      status: "pending",
      revision: 0,
      claimToken: null,
    });
    expect(proactiveMessageCount(harness.database)).toBe(0);
    expect(proactiveAuditTypes(harness.store)).toEqual([]);

    failure.mockRestore();
    expect(harness.service.deliverOneProactive(AGENT_ID)).toBeDefined();
    expect(proactiveMessageCount(harness.database)).toBe(1);
  });

  it("keeps quiet hours effective without consuming the candidate", () => {
    const harness = createHarness();
    harness.clock.setUtc("2026-08-21T23:30:00.000Z");

    expect(harness.service.deliverOneProactive(AGENT_ID)).toBeUndefined();
    expect(readCandidate(harness.database)).toEqual({
      status: "pending",
      revision: 0,
      claimToken: null,
    });
    expect(proactiveMessageCount(harness.database)).toBe(0);
  });

  it("keeps the daily proactive limit effective", () => {
    const harness = createHarness();
    seedSentMessages(harness.store, harness.sessionId);

    expect(harness.service.deliverOneProactive(AGENT_ID)).toBeUndefined();
    expect(readCandidate(harness.database)).toEqual({
      status: "pending",
      revision: 0,
      claimToken: null,
    });
    expect(proactiveMessageCount(harness.database)).toBe(2);
    expect(proactiveAuditTypes(harness.store)).toEqual([]);
  });
});

function createHarness(
  options: {
    databasePath?: string;
    seed?: boolean;
    seedCandidate?: boolean;
    clock?: FakeClock;
  } = {},
): Harness {
  const database = openDatabase(options.databasePath ?? ":memory:");
  openedDatabases.push(database);
  runMigrations(database);
  const store = new DatabaseStore(database);
  if (options.seed !== false) {
    seedFixture(store, options.seedCandidate !== false);
  }
  const clock = options.clock ?? new FakeClock(NOW_UTC);
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
  const service = new SettlementService(
    store,
    clock,
    llm,
    schedules,
    new SseHub(),
    { proactiveCommitMode: "atomic" },
  );
  const session = store.listSessions(AGENT_ID)[0];
  if (!session) throw new Error("Proactive test session is missing");
  return { database, store, clock, service, sessionId: session.id };
}

function seedFixture(store: DatabaseStore, seedCandidate: boolean): void {
  const draft = buildOriginalDraft({
    name: "Atomic Proactive Agent",
    worldSetting: "A contemporary city",
    workOrRole: "Illustrator",
    coreTraits: ["Warm", "Reliable", "Independent"],
    coreContradiction: "Values focus but also values close relationships",
    mainGoal: "Complete a portfolio",
    initialRelationship: "Close friend",
    dialogueStyle: "Brief and warm",
    tier: "high_fidelity",
    timezone: "UTC",
  });
  const spec = CharacterSpecSchema.parse({
    ...draft,
    id: AGENT_ID,
    version: 1,
    status: "published",
    createdAtUtc: NOW_UTC,
    updatedAtUtc: NOW_UTC,
  });
  store.insertCharacter(spec);
  store.insertInitialState(
    initialRuntimeState(AGENT_ID, NOW_UTC, draft),
    HORIZON_UTC,
  );
  store.createSession(AGENT_ID, "Atomic proactive integration", NOW_UTC);
  if (!seedCandidate) return;

  store.insertActivityEvent({
    id: TRIGGER_EVENT_ID,
    agentId: AGENT_ID,
    eventType: "completed",
    occurredAtUtc: "2026-08-21T11:30:00.000Z",
    summary: "Completed a shareable city walk.",
    outcomeFacts: ["Completed the city walk"],
    stateDelta: {},
    origin: "deterministic",
    idempotencyKey: "activity:proactive-atomic:completed",
  });
  store.database
    .prepare(
      [
        "INSERT INTO proactive_candidates(",
        "id, agent_id, trigger_event_id, intent, summary, draft_message,",
        "earliest_at_utc, expires_at_utc, priority, cooldown_key, status,",
        "created_at_utc",
        ") VALUES (?, ?, ?, 'share_experience', ?, ?, ?, ?, ?, ?,",
        "'pending', ?)",
      ].join(" "),
    )
    .run(
      CANDIDATE_ID,
      AGENT_ID,
      TRIGGER_EVENT_ID,
      "Completed a shareable city walk.",
      "The city walk was worth sharing.",
      "2026-08-21T11:45:00.000Z",
      "2026-08-23T12:00:00.000Z",
      0.9,
      "share:travel:2026-08-21",
      NOW_UTC,
    );
}

function seedShareableScheduleItem(store: DatabaseStore): void {
  store.insertScheduleItem(
    scheduleItemSchema.parse({
      id: "schedule-proactive-atomic",
      agentId: AGENT_ID,
      title: "City walk",
      description: "Walk through the old neighborhood.",
      category: "travel",
      startAtUtc: "2026-08-21T12:10:00.000Z",
      endAtUtc: "2026-08-21T12:40:00.000Z",
      timezone: "UTC",
      status: "planned",
      rigidity: "flexible",
      priority: 0.9,
      source: "manual",
      adherenceProbability: 1,
      narrativeImportance: 0.9,
      shareable: true,
      stateEffects: { moodValence: 0.1 },
      revision: 0,
      createdAtUtc: NOW_UTC,
      updatedAtUtc: NOW_UTC,
    }),
  );
}

function seedSentMessages(store: DatabaseStore, sessionId: string): void {
  for (const [id, createdAtUtc] of [
    ["message-proactive-daily-1", "2026-08-21T09:00:00.000Z"],
    ["message-proactive-daily-2", "2026-08-21T10:00:00.000Z"],
  ] as const) {
    store.insertMessage({
      id,
      sessionId,
      agentId: AGENT_ID,
      role: "assistant",
      content: "Previously sent proactive message.",
      messageKind: "assistant_proactive",
      metadata: {},
      createdAtUtc,
    });
  }
}

function readCandidate(database: Database): {
  status: string;
  revision: number;
  claimToken: string | null;
} {
  const row = database
    .prepare(
      "SELECT status, revision, claim_token AS claimToken FROM proactive_candidates WHERE id = ?",
    )
    .get(CANDIDATE_ID) as
    { status: string; revision: number; claimToken: string | null } | undefined;
  if (!row) throw new Error("Proactive test candidate is missing");
  return row;
}

function proactiveMessageCount(database: Database): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE agent_id = ? AND message_kind = 'assistant_proactive'",
    )
    .get(AGENT_ID) as { count: number };
  return Number(row.count);
}

function candidateCount(database: Database): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS count FROM proactive_candidates WHERE agent_id = ?",
    )
    .get(AGENT_ID) as { count: number };
  return Number(row.count);
}

function proactiveAuditTypes(store: DatabaseStore): string[] {
  return store
    .listDomainEvents(AGENT_ID, 100)
    .map((event) => String(event["eventType"]))
    .filter(
      (eventType) =>
        eventType === "proactive.claimed" ||
        eventType === "conversation.proactive_message_sent",
    )
    .sort();
}
