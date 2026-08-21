import { describe, expect, it, vi } from "vitest";
import { CharacterSpecSchema } from "@personasim/contracts";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { buildOriginalDraft, initialRuntimeState } from "../domain/defaults.js";
import {
  ConversationActivityTracker,
  type UserTurnLease,
} from "../services/conversation-activity-tracker.js";
import type { LlmService } from "../services/llm-service.js";
import { ProactiveDeliveryService } from "../services/proactive-delivery-service.js";
import { ProactiveGenerationRepository } from "../services/proactive-generation-repository.js";
import { ProactiveGenerationService } from "../services/proactive-generation-service.js";

import type { PersonalLifeService } from "../services/personal-life-service.js";
import type { SettlementService } from "../services/settlement-service.js";
import { SseHub } from "../sse/hub.js";
import { ActorQueue } from "./actor-queue.js";
import { FakeClock } from "./clock.js";
import { HourlyScheduler } from "./hourly-scheduler.js";

const AGENT_ID = "agent-hourly-lifecycle";
const NOW_UTC = "2026-08-21T04:37:00.000Z";
const BUCKET_UTC = "2026-08-21T04:00:00.000Z";

describe("HourlyScheduler personal life ordering", () => {
  it("runs settlement and personal planning in the actor queue, then two-phase delivery", async () => {
    const clock = new FakeClock(NOW_UTC);
    const sse = new SseHub();
    vi.spyOn(sse, "getActiveAgentIds").mockReturnValue([AGENT_ID]);
    const actors = new ActorQueue();
    const order: string[] = [];
    const activeActorCounts: number[] = [];
    const settleAndExtend = vi.fn(() => {
      order.push("settle");
      activeActorCounts.push(actors.activeActors);
      return Promise.resolve();
    });
    const settlements = {
      settleAndExtend,
    } as unknown as SettlementService;
    const ensureSelfInitiatedPlans = vi.fn(() => {
      order.push("plan");
      activeActorCounts.push(actors.activeActors);
    });
    const personalLife = {
      ensureSelfInitiatedPlans,
    } as unknown as Pick<PersonalLifeService, "ensureSelfInitiatedPlans">;
    const deliverNext = vi.fn(() => {
      order.push("deliver");
      activeActorCounts.push(actors.activeActors);
    });
    const proactiveDelivery = {
      deliverNext,
    } as unknown as Pick<ProactiveDeliveryService, "deliverNext">;
    const logger = { error: vi.fn() };
    const scheduler = new HourlyScheduler(
      clock,
      sse,
      actors,
      settlements,
      logger,
      personalLife,
      proactiveDelivery,
    );

    let releaseGate: () => void = () => undefined;
    let markEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      markEntered = () => resolve();
    });
    const gate = new Promise<void>((resolve) => {
      releaseGate = () => resolve();
    });
    const blocker = actors.runExclusive(AGENT_ID, async () => {
      markEntered();
      await gate;
    });
    await entered;

    const tick = scheduler.tick();
    await Promise.resolve();
    expect(order).toEqual([]);

    releaseGate();
    await Promise.all([blocker, tick]);

    expect(order).toEqual(["settle", "plan", "deliver"]);
    expect(activeActorCounts).toEqual([1, 1, 0]);
    expect(settleAndExtend).toHaveBeenCalledWith(AGENT_ID, {
      toUtc: NOW_UTC,
      hourlyBucket: BUCKET_UTC,
    });
    expect(ensureSelfInitiatedPlans).toHaveBeenCalledWith(AGENT_ID);
    expect(deliverNext).toHaveBeenCalledWith(AGENT_ID);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

const DELIVERY_NOW_UTC = "2026-08-21T12:37:00.000Z";
const DELIVERY_CANDIDATE_ID = "candidate-hourly-delivery";

describe("HourlyScheduler two-phase proactive delivery", () => {
  it("releases the outer actor for compose and emits SSE only after postflight commit", async () => {
    const harness = createDeliveryHarness(false);
    try {
      const scheduler = createDeliveryScheduler(harness);
      await scheduler.tick();

      expect(harness.settlementActorCounts).toEqual([1]);
      expect(harness.composeActorCounts).toEqual([0]);
      expect(harness.legacyDelivery).not.toHaveBeenCalled();
      expect(harness.messageCreatedEvents).toHaveLength(1);
      expect(harness.publishRunStatuses).toEqual(["committed"]);
      expect(readLatestGenerationStatus(harness.database)).toBe("committed");
      expect(countProactiveMessages(harness.database)).toBe(1);
      expect(harness.logger.error).not.toHaveBeenCalled();
    } finally {
      harness.endUserTurn();
      harness.database.close();
    }
  });

  it("does not emit SSE when a user arrival makes postflight stale", async () => {
    const harness = createDeliveryHarness(true);
    try {
      const scheduler = createDeliveryScheduler(harness);
      await scheduler.tick();

      expect(harness.settlementActorCounts).toEqual([1]);
      expect(harness.composeActorCounts).toEqual([0]);
      expect(harness.messageCreatedEvents).toEqual([]);
      expect(harness.publishRunStatuses).toEqual([]);
      expect(readLatestGenerationStatus(harness.database)).toBe(
        "stale_discarded",
      );
      expect(countProactiveMessages(harness.database)).toBe(0);
      expect(harness.logger.error).not.toHaveBeenCalled();
    } finally {
      harness.endUserTurn();
      harness.database.close();
    }
  });
});

function createDeliveryHarness(returnUserDuringCompose: boolean) {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const store = new DatabaseStore(database);
  seedDeliveryFixture(store);
  const clock = new FakeClock(DELIVERY_NOW_UTC);
  const sse = new SseHub();
  vi.spyOn(sse, "getActiveAgentIds").mockReturnValue([AGENT_ID]);
  const actors = new ActorQueue();
  const tracker = new ConversationActivityTracker(database);
  const composeActorCounts: number[] = [];
  let userTurn: UserTurnLease | undefined;
  const llm = {
    generateObject: vi.fn((input: { fixture?: unknown }) => {
      composeActorCounts.push(actors.activeActors);
      if (returnUserDuringCompose) {
        userTurn = tracker.beginUserTurn(AGENT_ID);
      }
      if (input.fixture === undefined) {
        throw new Error("Proactive delivery fixture is missing.");
      }
      return Promise.resolve(input.fixture);
    }),
  } as unknown as LlmService;
  const deliveryRef: { current?: ProactiveDeliveryService } = {};
  const generations = new ProactiveGenerationService(
    new ProactiveGenerationRepository(database),
    tracker,
    actors,
    clock,
    (agentId, nowUtc) => {
      const current = deliveryRef.current;
      if (current === undefined) {
        throw new Error("Proactive delivery policy loader is not ready.");
      }
      return current.loadPolicy(agentId, nowUtc);
    },
  );
  const delivery = new ProactiveDeliveryService(
    store,
    clock,
    llm,
    sse,
    generations,
  );
  deliveryRef.current = delivery;
  const settlementActorCounts: number[] = [];
  const legacyDelivery = vi.fn();
  const settlements = {
    settleAndExtend: vi.fn(() => {
      settlementActorCounts.push(actors.activeActors);
      return Promise.resolve();
    }),
    deliverOneProactive: legacyDelivery,
  } as unknown as SettlementService;
  const logger = { error: vi.fn() };
  const messageCreatedEvents: unknown[] = [];
  const publishRunStatuses: string[] = [];
  vi.spyOn(sse, "publish").mockImplementation((event) => {
    if (event.type !== "message.created") return;
    messageCreatedEvents.push(event);
    publishRunStatuses.push(readLatestGenerationStatus(database) ?? "missing");
  });
  return {
    database,
    clock,
    sse,
    actors,
    delivery,
    settlements,
    logger,
    settlementActorCounts,
    composeActorCounts,
    legacyDelivery,
    messageCreatedEvents,
    publishRunStatuses,
    endUserTurn: () => userTurn?.end(),
  };
}

function createDeliveryScheduler(
  harness: ReturnType<typeof createDeliveryHarness>,
): HourlyScheduler {
  return new HourlyScheduler(
    harness.clock,
    harness.sse,
    harness.actors,
    harness.settlements,
    harness.logger,
    { ensureSelfInitiatedPlans: vi.fn() },
    harness.delivery,
  );
}

function seedDeliveryFixture(store: DatabaseStore): void {
  const draft = buildOriginalDraft({
    name: "Hourly Delivery Agent",
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
    createdAtUtc: DELIVERY_NOW_UTC,
    updatedAtUtc: DELIVERY_NOW_UTC,
  });
  store.insertCharacter(spec);
  store.insertInitialState(
    initialRuntimeState(AGENT_ID, DELIVERY_NOW_UTC, draft),
    "2026-08-24T12:37:00.000Z",
  );
  store.createSession(AGENT_ID, "Hourly delivery", DELIVERY_NOW_UTC);
  store.insertActivityEvent({
    id: "event-hourly-delivery",
    agentId: AGENT_ID,
    eventType: "completed",
    occurredAtUtc: "2026-08-21T12:00:00.000Z",
    summary: "Completed a shareable city walk.",
    outcomeFacts: ["Completed the city walk"],
    stateDelta: {},
    origin: "deterministic",
    idempotencyKey: "activity:hourly-delivery:completed",
  });
  store.database
    .prepare(
      `INSERT INTO proactive_candidates(
        id, agent_id, trigger_event_id, intent, summary, draft_message,
        earliest_at_utc, expires_at_utc, priority, cooldown_key, status,
        created_at_utc
      ) VALUES (
        ?, ?, 'event-hourly-delivery', 'share_experience',
        'Completed a shareable city walk.',
        'The city walk was worth sharing.',
        '2026-08-21T12:00:00.000Z', '2026-08-23T12:00:00.000Z',
        0.9, 'share:walk:2026-08-21', 'pending', ?
      )`,
    )
    .run(DELIVERY_CANDIDATE_ID, AGENT_ID, DELIVERY_NOW_UTC);
}

function readLatestGenerationStatus(database: Database): string | undefined {
  const row = database
    .prepare(
      "SELECT status FROM proactive_generation_runs ORDER BY rowid DESC LIMIT 1",
    )
    .get() as { status: string } | undefined;
  return row?.status;
}

function countProactiveMessages(database: Database): number {
  const row = database
    .prepare(
      "SELECT COUNT(*) AS count FROM messages WHERE message_kind = 'assistant_proactive'",
    )
    .get() as { count: number };
  return Number(row.count);
}
