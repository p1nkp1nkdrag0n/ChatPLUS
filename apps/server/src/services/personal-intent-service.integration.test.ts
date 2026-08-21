import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CharacterSpecSchema, type CharacterSpec } from "@personasim/contracts";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { buildOriginalDraft } from "../domain/defaults.js";
import { FakeClock } from "../runtime/clock.js";
import { PersonalIntentService } from "./personal-intent-service.js";

const AGENT_ID = "agent-intent-integration";
const SESSION_ID = "session-intent-integration";
const MESSAGE_ID_1 = "message-intent-user-1";
const MESSAGE_ID_2 = "message-intent-user-2";
const START_UTC = "2026-08-21T04:00:00.000Z";

describe("PersonalIntentService SQLite integration", () => {
  let database: Database;
  let store: DatabaseStore;
  let clock: FakeClock;
  let service: PersonalIntentService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    store = new DatabaseStore(database);
    clock = new FakeClock(START_UTC);
    seedCharacterAndMessages(store);
    service = new PersonalIntentService(store, clock);
  });

  afterEach(() => {
    database.close();
  });

  it("creates a server-owned chat intent and records command lineage", () => {
    const result = service.upsertOrMerge(
      chatCommand({
        idempotencyKey: "intent-command-create-1",
        correlationId: "correlation-chat-1",
        causationId: "message-cause-1",
      }),
    );

    expect(result).toMatchObject({
      action: "created",
      replayed: false,
      intent: {
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
        activity: "Riverside night photography",
        category: "leisure",
        desiredDurationMinutes: 30,
        earliestAtUtc: "2026-08-22T10:00:00.000Z",
        latestAtUtc: "2026-08-22T15:00:00.000Z",
        evidenceMessageIds: [MESSAGE_ID_1],
        createdAtUtc: START_UTC,
        updatedAtUtc: START_UTC,
      },
    });
    expect(result.intent.id).toMatch(/^intent_/);
    expect(service.listActive(AGENT_ID)).toEqual([result.intent]);
    expect(service.read(AGENT_ID, result.intent.id)).toEqual(result.intent);

    const row = database
      .prepare(
        `SELECT id, created_at_utc, updated_at_utc, record_json
         FROM personal_intentions WHERE id = ?`,
      )
      .get(result.intent.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      id: result.intent.id,
      created_at_utc: START_UTC,
      updated_at_utc: START_UTC,
    });
    expect(JSON.parse(String(row["record_json"]))).toEqual(result.intent);

    const [event] = store.listDomainEvents(AGENT_ID, 10);
    expect(event).toMatchObject({
      streamType: "personal_intent",
      streamId: result.intent.id,
      streamVersion: 1,
      eventType: "personal_intent.created",
      correlationId: "correlation-chat-1",
      causationId: "message-cause-1",
      idempotencyKey: "intent-command-create-1",
      payload: {
        action: "created",
        intentId: result.intent.id,
        evidenceMessageIds: [MESSAGE_ID_1],
        evidenceQuotes: ["the riverside looks beautiful at night"],
      },
    });
  });

  it("rejects model attempts to provide persisted ids and exact times", () => {
    expect(() =>
      service.upsertOrMerge(
        chatCommand({
          idempotencyKey: "intent-command-forged",
          candidateOverrides: {
            id: "intent-forged-by-model",
            earliestAtUtc: "2030-01-01T00:00:00.000Z",
            createdAtUtc: "2030-01-01T00:00:00.000Z",
            status: "consumed",
            source: "model",
          },
        }),
      ),
    ).toThrow();

    expect(tableCount(database, "personal_intentions")).toBe(0);
    expect(tableCount(database, "domain_events")).toBe(0);
  });

  it("merges active duplicates and replays the command idempotently", () => {
    const created = service.upsertOrMerge(
      chatCommand({ idempotencyKey: "intent-command-dedupe-create" }),
    );
    const merged = service.upsertOrMerge(
      chatCommand({
        idempotencyKey: "intent-command-dedupe-merge",
        evidenceMessageId: MESSAGE_ID_2,
        priority: 0.9,
      }),
    );

    expect(merged).toMatchObject({
      action: "merged",
      replayed: false,
      intent: {
        id: created.intent.id,
        priority: 0.9,
        evidenceMessageIds: [MESSAGE_ID_1, MESSAGE_ID_2],
      },
    });
    const replayed = service.upsertOrMerge(
      chatCommand({
        idempotencyKey: "intent-command-dedupe-merge",
        candidateOverrides: {
          id: "ignored-on-idempotent-replay",
          earliestAtUtc: "2030-01-01T00:00:00.000Z",
        },
      }),
    );
    expect(replayed).toMatchObject({
      action: "merged",
      replayed: true,
      intent: { id: created.intent.id },
    });
    expect(tableCount(database, "personal_intentions")).toBe(1);
    expect(tableCount(database, "domain_events")).toBe(2);
    expect(
      store
        .listDomainEvents(AGENT_ID, 10)
        .map((event) => event["streamVersion"])
        .sort(),
    ).toEqual([1, 2]);
  });

  it("grounds derived refs against the authoritative CharacterSpec", () => {
    expect(() =>
      service.upsertOrMerge({
        agentId: AGENT_ID,
        proposal: {
          basisKind: "preference",
          activity: "Riverside night photography",
          basisRefIds: ["preference-missing"],
          reasonCode: "preference_activity",
          reasonSummary: "A preference suggested this activity.",
        },
        idempotencyKey: "intent-command-invalid-ref",
      }),
    ).toThrow(/preference-missing/);
    expect(tableCount(database, "personal_intentions")).toBe(0);

    const valid = service.upsertOrMerge({
      agentId: AGENT_ID,
      proposal: {
        basisKind: "preference",
        activity: "Riverside night photography",
        durationHint: "45 minutes",
        timingHint: "within 3 days",
        basisRefIds: ["preference-photo"],
        reasonCode: "preference_activity",
        reasonSummary: "A grounded preference suggested this activity.",
      },
      idempotencyKey: "intent-command-valid-ref",
    });
    expect(valid.intent).toMatchObject({
      basisKind: "preference",
      basisRefIds: ["preference-photo"],
      category: "leisure",
      desiredDurationMinutes: 45,
      priority: 0.85,
      specVersion: 2,
    });
  });

  it("expires stale pending intents and consumes only eligible intents", () => {
    const expiring = service.upsertOrMerge(
      chatCommand({
        idempotencyKey: "intent-command-expiring-create",
        activity: "Take riverside photographs",
        timingHint: "within 1 hours",
      }),
    ).intent;
    clock.advance({ hours: 2 });

    const expired = service.expire({
      agentId: AGENT_ID,
      intentId: expiring.id,
      idempotencyKey: "intent-command-expire",
      correlationId: "correlation-expiry",
      causationId: "hourly-tick-1",
    });
    expect(expired).toMatchObject({
      transitioned: true,
      replayed: false,
      intent: { status: "expired" },
    });
    expect(
      service.expire({
        agentId: AGENT_ID,
        intentId: expiring.id,
        idempotencyKey: "intent-command-expire",
      }),
    ).toMatchObject({ transitioned: false, replayed: true });
    expect(() =>
      service.markConsumed({
        agentId: AGENT_ID,
        intentId: expiring.id,
        idempotencyKey: "intent-command-consume-expired",
      }),
    ).toThrow(/cannot be consumed/);

    const consumable = service.upsertOrMerge(
      chatCommand({
        idempotencyKey: "intent-command-consumable-create",
        activity: "Read a novel",
        timingHint: "within 3 days",
      }),
    ).intent;
    const consumed = service.markConsumed({
      agentId: AGENT_ID,
      intentId: consumable.id,
      idempotencyKey: "intent-command-consume",
      correlationId: "correlation-planner",
      causationId: "self-plan-1",
    });
    expect(consumed).toMatchObject({
      transitioned: true,
      replayed: false,
      intent: { status: "consumed" },
    });
    expect(service.listActive(AGENT_ID)).toEqual([]);
    expect(service.read(AGENT_ID, expiring.id).status).toBe("expired");
    expect(service.read(AGENT_ID, consumable.id).status).toBe("consumed");

    const eventTypes = store
      .listDomainEvents(AGENT_ID, 20)
      .map((event) => event["eventType"]);
    expect(eventTypes).toContain("personal_intent.expired");
    expect(eventTypes).toContain("personal_intent.consumed");
  });

  it("re-evaluates stale spec-backed intents and rejects invalidated refs", () => {
    const created = service.upsertOrMerge({
      agentId: AGENT_ID,
      proposal: {
        basisKind: "preference",
        activity: "Riverside night photography",
        category: "leisure",
        basisRefIds: ["preference-photo"],
        reasonCode: "preference_activity",
        reasonSummary: "A grounded preference suggested this activity.",
      },
      idempotencyKey: "intent-spec-create",
    }).intent;
    publishNextSpec(store, (current) => current);

    expect(() =>
      service.markConsumed({
        agentId: AGENT_ID,
        intentId: created.id,
        idempotencyKey: "intent-spec-stale-consume",
      }),
    ).toThrow(/must be re-evaluated/i);
    const revalidated = service.reevaluateActiveForCurrentSpec({
      agentId: AGENT_ID,
      correlationId: "correlation-spec-3",
      causationId: "character-version-3",
    });
    expect(revalidated).toEqual({
      revalidatedIntentIds: [created.id],
      rejectedIntentIds: [],
    });
    expect(service.read(AGENT_ID, created.id)).toMatchObject({
      status: "pending",
      specVersion: 3,
    });
    const eventCountAfterRevalidation = tableCount(database, "domain_events");
    expect(
      service.reevaluateActiveForCurrentSpec({ agentId: AGENT_ID }),
    ).toEqual({ revalidatedIntentIds: [], rejectedIntentIds: [] });
    expect(tableCount(database, "domain_events")).toBe(
      eventCountAfterRevalidation,
    );

    publishNextSpec(store, (current) => ({
      ...current,
      persona: { ...current.persona, preferences: [] },
    }));
    const rejected = service.reevaluateActiveForCurrentSpec({
      agentId: AGENT_ID,
      correlationId: "correlation-spec-4",
      causationId: "character-version-4",
    });
    expect(rejected).toEqual({
      revalidatedIntentIds: [],
      rejectedIntentIds: [created.id],
    });
    expect(service.read(AGENT_ID, created.id).status).toBe("rejected");
    expect(service.listActive(AGENT_ID)).toEqual([]);

    const lifecycleEvents = store.listDomainEvents(AGENT_ID, 20);
    const revalidatedEvent = lifecycleEvents.find(
      (event) => event["eventType"] === "personal_intent.revalidated",
    );
    expect(revalidatedEvent).toMatchObject({
      correlationId: "correlation-spec-3",
    });
    expect(revalidatedEvent?.["payload"]).toMatchObject({
      intentId: created.id,
      previousSpecVersion: 2,
      targetSpecVersion: 3,
    });
    const rejectedEvent = lifecycleEvents.find(
      (event) => event["eventType"] === "personal_intent.rejected",
    );
    expect(rejectedEvent).toMatchObject({
      correlationId: "correlation-spec-4",
    });
    expect(rejectedEvent?.["payload"]).toMatchObject({
      intentId: created.id,
      previousSpecVersion: 3,
      targetSpecVersion: 4,
      reasonCode: "invalid_basis_ref",
    });
  });

  it("revalidates stale chat grounding from owned user evidence", () => {
    const created = service.upsertOrMerge(
      chatCommand({ idempotencyKey: "intent-chat-spec-create" }),
    ).intent;
    publishNextSpec(store, (current) => current);

    expect(
      service.reevaluateActiveForCurrentSpec({
        agentId: AGENT_ID,
        correlationId: "correlation-chat-spec",
      }),
    ).toEqual({
      revalidatedIntentIds: [created.id],
      rejectedIntentIds: [],
    });
    expect(service.read(AGENT_ID, created.id).specVersion).toBe(3);
    const event = store
      .listDomainEvents(AGENT_ID, 20)
      .find((item) => item["eventType"] === "personal_intent.revalidated");
    expect(event?.["payload"]).toMatchObject({
      intentId: created.id,
      reasonCode: "chat_evidence_revalidated",
    });
  });

  it("keeps spontaneous creation server-disabled and enforces rolling count", () => {
    expect(() =>
      service.upsertOrMerge(
        spontaneousCommand(
          "Sketch in the park",
          "intent-spontaneous-caller-bypass",
        ),
      ),
    ).toThrow(/disabled by default/i);
    expect(tableCount(database, "personal_intentions")).toBe(0);

    const enabled = new PersonalIntentService(store, clock, {
      spontaneous: {
        enabled: true,
        maxAcceptedIntents: 1,
        rollingWindowHours: 24,
      },
    });
    const first = enabled.upsertOrMerge(
      spontaneousCommand("Sketch in the park", "intent-spontaneous-first"),
    );
    expect(first.intent.basisKind).toBe("spontaneous");
    const event = store
      .listDomainEvents(AGENT_ID, 20)
      .find((item) => item["idempotencyKey"] === "intent-spontaneous-first");
    expect(event?.["payload"]).toMatchObject({
      spontaneousFrequency: {
        policySource: "server",
        rollingWindowHours: 24,
        maxAcceptedIntents: 1,
        acceptedCountBefore: 0,
      },
    });

    expect(() =>
      enabled.upsertOrMerge(
        spontaneousCommand(
          "Visit a quiet gallery",
          "intent-spontaneous-frequency-bypass",
        ),
      ),
    ).toThrow(/frequency policy rejected/i);
    expect(tableCount(database, "personal_intentions")).toBe(1);

    clock.advance({ hours: 25 });
    expect(
      enabled.upsertOrMerge(
        spontaneousCommand(
          "Visit a quiet gallery",
          "intent-spontaneous-next-window",
        ),
      ).intent.basisKind,
    ).toBe("spontaneous");
    expect(tableCount(database, "personal_intentions")).toBe(2);
  });

  it("does not mutate state when an idempotency key belongs to another command", () => {
    const created = service.upsertOrMerge(
      chatCommand({ idempotencyKey: "intent-command-conflict" }),
    ).intent;

    expect(() =>
      service.markConsumed({
        agentId: AGENT_ID,
        intentId: created.id,
        idempotencyKey: "intent-command-conflict",
      }),
    ).toThrow(/idempotency key belongs to a different command/i);
    expect(service.read(AGENT_ID, created.id).status).toBe("pending");
    expect(tableCount(database, "domain_events")).toBe(1);
  });
});

function chatCommand(options: {
  idempotencyKey: string;
  correlationId?: string;
  causationId?: string;
  evidenceMessageId?: string;
  candidateOverrides?: Record<string, unknown>;
  activity?: string;
  timingHint?: string;
  priority?: number;
}) {
  return {
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    proposal: {
      basisKind: "chat" as const,
      evidenceMessageId: options.evidenceMessageId ?? MESSAGE_ID_1,
      candidate: {
        activity: options.activity ?? "Riverside night photography",
        category: "leisure",
        durationHint: "half an hour",
        timingHint: options.timingHint ?? "tomorrow evening",
        basisKind: "chat",
        evidenceQuotes: ["the riverside looks beautiful at night"],
        reasonCode: "chat_inspiration",
        reasonSummary: "The user inspired a possible activity.",
        ...options.candidateOverrides,
      },
      ...(options.priority === undefined ? {} : { priority: options.priority }),
    },
    ...(options.correlationId === undefined
      ? {}
      : { correlationId: options.correlationId }),
    ...(options.causationId === undefined
      ? {}
      : { causationId: options.causationId }),
    idempotencyKey: options.idempotencyKey,
  };
}

function spontaneousCommand(activity: string, idempotencyKey: string) {
  return {
    agentId: AGENT_ID,
    proposal: {
      basisKind: "spontaneous" as const,
      activity,
      category: "leisure" as const,
      durationHint: "30 minutes",
      timingHint: "within 1 day",
      reasonCode: "spontaneous_low_risk",
      reasonSummary: "A low-risk spontaneous activity passed policy.",
      spontaneousPolicy: {
        enabled: true,
        budgetAvailable: true,
        categoryAllowlist: ["leisure"] as const,
        riskAllowed: true,
        frequencyAllowed: true,
        personaBoundaryAllowed: true,
        scheduleAllowed: true,
      },
    },
    idempotencyKey,
  };
}

function publishNextSpec(
  store: DatabaseStore,
  transform: (current: CharacterSpec) => CharacterSpec,
): CharacterSpec {
  const current = store.getCharacterSpec(AGENT_ID);
  if (current === undefined) throw new Error("Missing test character");
  const transformed = transform(structuredClone(current));
  const next = CharacterSpecSchema.parse({
    ...transformed,
    id: current.id,
    version: current.version + 1,
    status: "published",
    updatedAtUtc: START_UTC,
  });
  store.insertCharacterVersion(next);
  store.updateCharacterHead(next);
  return next;
}

function seedCharacterAndMessages(store: DatabaseStore): void {
  const draft = buildOriginalDraft({
    name: "Intent Test Agent",
    worldSetting: "A contemporary city",
    workOrRole: "Photographer",
    coreTraits: ["Curious", "Steady", "Kind"],
    coreContradiction: "Values routine but also follows creative impulses",
    mainGoal: "Stay healthy",
    initialRelationship: "Friend",
    dialogueStyle: "Brief and warm",
    tier: "daily",
    timezone: "Asia/Shanghai",
  });
  const spec = CharacterSpecSchema.parse({
    ...draft,
    persona: {
      ...draft.persona,
      goals: [
        {
          id: "goal-health",
          title: "Stay healthy",
          description: "Exercise every week",
          priority: 0.9,
          progress: 0.2,
          origin: "user_spec",
          sourceRefs: [],
        },
      ],
      preferences: [
        {
          id: "preference-photo",
          subject: "Photography",
          preference: "Likes city and riverside night photography",
          intensity: 0.85,
          conditions: [],
          origin: "user_spec",
          sourceRefs: [],
        },
      ],
    },
    routines: [
      {
        id: "routine-run",
        title: "Morning run",
        category: "exercise",
        recurrence: "every weekday",
        preferredStartLocal: "07:00",
        preferredDurationMinutes: 45,
        rigidity: "flexible",
        priority: 0.8,
      },
    ],
    id: AGENT_ID,
    version: 2,
    status: "published",
    createdAtUtc: START_UTC,
    updatedAtUtc: START_UTC,
  });
  store.insertCharacter(spec);
  store.database
    .prepare(
      `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(SESSION_ID, AGENT_ID, "Intent integration", START_UTC, START_UTC);
  for (const [id, createdAtUtc] of [
    [MESSAGE_ID_1, START_UTC],
    [MESSAGE_ID_2, "2026-08-21T04:01:00.000Z"],
  ] as const) {
    store.insertMessage({
      id,
      sessionId: SESSION_ID,
      agentId: AGENT_ID,
      role: "user",
      content: "The riverside looks beautiful at night.",
      messageKind: "user",
      metadata: {},
      createdAtUtc,
    });
  }
}

function tableCount(database: Database, table: string): number {
  const allowed = new Set(["personal_intentions", "domain_events"]);
  if (!allowed.has(table)) throw new Error("Unexpected test table");
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as { count: number };
  return Number(row.count);
}
