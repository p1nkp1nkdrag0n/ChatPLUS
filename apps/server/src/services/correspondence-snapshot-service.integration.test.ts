import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CharacterSpecSchema,
  EffectivePersonaSnapshotSchema,
  type CharacterSpec,
  type RuntimeState,
  type TemporalTask,
} from "@personasim/contracts";
import { canonicalLetterGenerationSnapshot } from "@personasim/features";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { buildOriginalDraft, initialRuntimeState } from "../domain/defaults.js";
import { CorrespondenceRepository } from "../repositories/correspondence-repository.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";
import { ActorQueue } from "../runtime/actor-queue.js";
import { FakeClock } from "../runtime/clock.js";
import { CorrespondenceSnapshotService } from "./correspondence-snapshot-service.js";
import { PersonaRuntimeService } from "./persona-runtime-service.js";
import {
  TemporalCatchUpService,
  type OutboundArrivalTaskHandler,
  type TemporalLifeAdvancer,
} from "./temporal-catch-up-service.js";

const AGENT_ID = "agent-snapshot-as-of";
const CHARACTER_CREATED_AT = "2026-09-01T04:00:00.000Z";
const DISPATCHED_AT = "2026-09-03T12:00:00.000Z";
const BEFORE_ARRIVAL = "2026-09-07T08:00:00.000Z";
const ARRIVAL_DUE_AT = "2026-09-08T12:00:00.000Z";
const OBSERVED_AT = "2026-09-09T02:00:00.000Z";
const FUTURE_RETRY_AT = "2026-09-10T03:00:00.000Z";
const CONTENT_HASH = "a".repeat(64);
const ORIGINAL_BODY = "ORIGINAL_BODY_MUST_STAY_OUTSIDE_THE_SNAPSHOT";
const FUTURE_CHAT = "CHAT_FROM_SEPTEMBER_9_MUST_NOT_LEAK";
const FUTURE_MEMORY = "MEMORY_FROM_SEPTEMBER_9_MUST_NOT_LEAK";
const FUTURE_LIFE = "LIFE_FROM_SEPTEMBER_9_MUST_NOT_LEAK";
const SEALED_REPLY_CIPHERTEXT = "U0VBTEVEX1JFUExZX1NFQ1JFVA==";

class RecordingLifeAdvancer implements TemporalLifeAdvancer {
  readonly calls: string[] = [];

  advance(_agentId: string, toUtc: string): void {
    this.calls.push(toUtc);
  }
}

describe("CorrespondenceSnapshotService SQLite integration", () => {
  let database: Database;
  let store: DatabaseStore;
  let repository: CorrespondenceRepository;
  let actors: ActorQueue;
  let life: RecordingLifeAdvancer;
  let snapshotService: CorrespondenceSnapshotService;
  let outboundTask: TemporalTask;
  let fileDirectory: string | undefined;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    store = new DatabaseStore(database);
    repository = new CorrespondenceRepository(database);
    actors = new ActorQueue();
    life = new RecordingLifeAdvancer();
    seedCharacterTimeline(store);
    seedAsOfSources(store);
    outboundTask = seedOutboundLetter(repository, database);
    snapshotService = new CorrespondenceSnapshotService(store);
  });

  afterEach(() => {
    database.close();
    if (fileDirectory !== undefined) {
      rmSync(fileDirectory, { recursive: true, force: true });
      fileDirectory = undefined;
    }
  });

  it("atomically freezes an as-of snapshot and leaves model work pending in shadow", async () => {
    let claimedTask: Readonly<TemporalTask> | undefined;
    const baseHandler =
      snapshotService.createOutboundArrivalTaskHandler("shadow");
    const handler: OutboundArrivalTaskHandler = {
      mode: "shadow",
      commit: (context) => {
        expect(actors.activeActors).toBe(1);
        claimedTask = context.task;
        baseHandler.commit(context);
      },
    };
    const catchUp = createCatchUp(handler);

    const result = await catchUp.catchUpAgent(AGENT_ID, OBSERVED_AT);

    expect(result.completedTaskIds).toEqual([outboundTask.id]);
    expect(result.externalExecutionCount).toBe(0);
    expect(life.calls).toEqual([ARRIVAL_DUE_AT, OBSERVED_AT]);
    expect(repository.getLetter(outboundTask.entityId)).toMatchObject({
      status: "read",
      deliveredEffectiveAtUtc: ARRIVAL_DUE_AT,
      processedAtUtc: OBSERVED_AT,
      readAtUtc: ARRIVAL_DUE_AT,
    });

    const snapshot = repository.getSnapshotForIncomingLetter(
      outboundTask.entityId,
    );
    expect(snapshot).toBeDefined();
    expect(snapshot).toMatchObject({
      effectiveAtUtc: ARRIVAL_DUE_AT,
      characterVersion: 1,
      stateRevision: 8,
      contextJson: {
        schemaVersion: 1,
        effectiveAtUtc: ARRIVAL_DUE_AT,
        sourceWindow: {
          fromUtc: DISPATCHED_AT,
          throughUtc: ARRIVAL_DUE_AT,
        },
        character: {
          version: 1,
          identity: { name: "Character Before Arrival" },
        },
        relationship: {
          stateRevision: 8,
          asOfUtc: ARRIVAL_DUE_AT,
        },
      },
    });
    const serialized = JSON.stringify(snapshot!.contextJson);
    expect(serialized).toContain("CHAT_BEFORE_ARRIVAL");
    expect(serialized).toContain("MEMORY_BEFORE_ARRIVAL");
    expect(serialized).toContain("LIFE_BEFORE_ARRIVAL");
    expect(serialized).not.toContain(FUTURE_CHAT);
    expect(serialized).not.toContain(FUTURE_MEMORY);
    expect(serialized).not.toContain(FUTURE_LIFE);
    expect(serialized).not.toContain("Character After Arrival");
    expect(serialized).not.toContain(ORIGINAL_BODY);
    expect(serialized).not.toContain(SEALED_REPLY_CIPHERTEXT);
    expect(snapshot!.contextJson.priorCorrespondence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "letter-prior-sealed-reply",
          direction: "agent_to_user",
          status: "in_transit",
        }),
      ]),
    );

    expect(snapshot!.contextHash).toBe(
      createHash("sha256")
        .update(
          canonicalLetterGenerationSnapshot({
            contextJson: snapshot!.contextJson,
            evidenceIds: snapshot!.evidenceIds,
          }),
          "utf8",
        )
        .digest("hex"),
    );
    expect(snapshot!.evidenceIds).toEqual(
      [...snapshot!.evidenceIds].sort((left, right) =>
        left < right ? -1 : left > right ? 1 : 0,
      ),
    );
    expect(snapshot!.evidenceIds).toEqual(
      expect.arrayContaining([
        "activity-before-arrival",
        "evidence-before-arrival",
        "message-before-arrival",
      ]),
    );
    expect(snapshot!.evidenceIds).not.toContain(outboundTask.entityId);

    const replyTask = repository.getTaskByIdempotencyKey(
      `letter-reply-run:${outboundTask.entityId}:v1`,
    );
    expect(replyTask).toMatchObject({
      kind: "letter.reply_generation",
      entityId: outboundTask.entityId,
      dueAtUtc: ARRIVAL_DUE_AT,
      priority: 20,
      status: "pending",
      attempt: 0,
      payload: {
        incomingLetterId: outboundTask.entityId,
        snapshotId: snapshot!.id,
        generationEpoch: 0,
      },
    });
    expect(
      database
        .prepare(
          `SELECT event_type AS eventType FROM domain_events
            WHERE event_type LIKE 'letter.%'
            ORDER BY stream_version`,
        )
        .all(),
    ).toEqual([
      { eventType: "letter.arrived" },
      { eventType: "letter.snapshot_frozen" },
      { eventType: "letter.read" },
      { eventType: "letter.reply_generation_shadow_observed" },
    ]);
    expect(claimedTask).toBeDefined();
  });

  it("uses the character-local period boundary before freezing fuzzy-life evidence", async () => {
    const middayDispatch = "2026-09-03T05:00:00.000Z";
    const middayArrival = "2026-09-08T05:00:00.000Z";
    repository.closeThread(
      repository.findOpenThread(AGENT_ID)!.id,
      DISPATCHED_AT,
    );
    const periodThread = repository.createThread(AGENT_ID, {
      id: "thread-period-boundary",
      nowUtc: middayDispatch,
    });
    const periodDraft = repository.createDraftLetter({
      id: "letter-period-boundary",
      threadId: periodThread.id,
      agentId: AGENT_ID,
      body: "A letter arriving between the morning and afternoon periods",
      nowUtc: middayDispatch,
    });
    outboundTask = repository.sealLetter({
      letterId: periodDraft.id,
      contentHash: "d".repeat(64),
      transitPolicyVersion: "fixed_5d_v1",
      transitTimezone: "Asia/Shanghai",
      dispatchedAtUtc: middayDispatch,
      arrivalDueAtUtc: middayArrival,
      effectiveAuthorTimeUtc: middayDispatch,
      taskId: "task-period-boundary",
      taskPriority: 10,
      clientRequestId: "seal-period-boundary",
    }).task;
    const currentState = store.getRuntimeState(AGENT_ID)!;
    database
      .prepare(
        `UPDATE runtime_states SET state_json = ?, updated_at_utc = ?
          WHERE agent_id = ?`,
      )
      .run(
        JSON.stringify({ ...currentState, asOfUtc: middayArrival }),
        middayArrival,
        AGENT_ID,
      );
    seedFuzzyLifePeriodFixtures(database, "morning");
    seedFuzzyLifePeriodFixtures(database, "afternoon");
    snapshotService = new CorrespondenceSnapshotService(store, {
      verifiedLifeOutcomes: 1,
      dilemmas: 1,
      decisions: 1,
      actions: 1,
      outcomes: 1,
      reflections: 1,
      relationshipMilestones: 1,
      intervalLifeOutcomes: 1,
    });

    await createCatchUp(
      snapshotService.createOutboundArrivalTaskHandler("enforced"),
    ).catchUpAgent(AGENT_ID, OBSERVED_AT);

    const snapshot = repository.getSnapshotForIncomingLetter(
      outboundTask.entityId,
    )!;
    const serialized = JSON.stringify(snapshot.contextJson);
    for (const recordType of [
      "life-outcome",
      "dilemma",
      "decision",
      "action",
      "outcome",
      "reflection",
      "milestone",
    ]) {
      expect(serialized).toContain(`${recordType}-morning`);
      expect(serialized).not.toContain(`${recordType}-afternoon`);
    }
  });

  it("freezes bounded ready keepsake evidence without leaking pending or future artifacts", async () => {
    seedSnapshotKeepsake(database, {
      id: "keepsake-ready-before-arrival",
      title: "雨夜电影票根",
      createdAtUtc: "2026-09-06T09:00:00.000Z",
      readyAtUtc: "2026-09-07T09:00:00.000Z",
      sourceEventIds: ["milestone-cinema-before-arrival"],
    });
    seedSnapshotKeepsake(database, {
      id: "keepsake-ready-after-arrival",
      title: "未来才洗出的照片",
      createdAtUtc: "2026-09-07T10:00:00.000Z",
      readyAtUtc: OBSERVED_AT,
      sourceEventIds: ["milestone-after-arrival"],
    });
    seedSnapshotKeepsake(database, {
      id: "keepsake-pending-at-arrival",
      title: "还没完成的明信片",
      createdAtUtc: "2026-09-07T11:00:00.000Z",
      sourceEventIds: ["milestone-pending-at-arrival"],
    });
    snapshotService = new CorrespondenceSnapshotService(store, {
      readyKeepsakes: 1,
    });

    await createCatchUp(
      snapshotService.createOutboundArrivalTaskHandler("enforced"),
    ).catchUpAgent(AGENT_ID, OBSERVED_AT);

    const snapshot = repository.getSnapshotForIncomingLetter(
      outboundTask.entityId,
    )!;
    const readyKeepsakes =
      "readyKeepsakes" in snapshot.contextJson
        ? snapshot.contextJson.readyKeepsakes
        : [];
    expect(readyKeepsakes).toEqual([
      {
        id: "keepsake-ready-before-arrival",
        recordType: "keepsake",
        title: "雨夜电影票根",
        kind: "ticket_stub",
        description: "一张由已发生关系事件留下的票根。",
        sourceEventIds: ["milestone-cinema-before-arrival"],
        sourceMemoryIds: [],
        sourceLetterIds: [],
        createdEffectiveAtUtc: "2026-09-06T09:00:00.000Z",
        readyAtUtc: "2026-09-07T09:00:00.000Z",
      },
    ]);
    expect(snapshot.evidenceIds).toEqual(
      expect.arrayContaining([
        "keepsake-ready-before-arrival",
        "milestone-cinema-before-arrival",
      ]),
    );
    expect(JSON.stringify(snapshot.contextJson)).not.toContain(
      "keepsake-ready-after-arrival",
    );
    expect(JSON.stringify(snapshot.contextJson)).not.toContain(
      "keepsake-pending-at-arrival",
    );
    expect(snapshot.contextJson.budgets).toMatchObject({ readyKeepsakes: 1 });
  });

  it("reuses the immutable snapshot across retry and concurrent replay", async () => {
    let claimedTask: Readonly<TemporalTask> | undefined;
    const baseHandler =
      snapshotService.createOutboundArrivalTaskHandler("enforced");
    const handler: OutboundArrivalTaskHandler = {
      mode: "enforced",
      commit: (context) => {
        claimedTask = context.task;
        baseHandler.commit(context);
      },
    };
    await createCatchUp(handler).catchUpAgent(AGENT_ID, OBSERVED_AT);
    const first = repository.getSnapshotForIncomingLetter(
      outboundTask.entityId,
    )!;

    expect(claimedTask).toBeDefined();
    const [left, right] = await Promise.all([
      Promise.resolve().then(() =>
        snapshotService.freezeOutboundArrival({
          task: claimedTask!,
          observedNowUtc: FUTURE_RETRY_AT,
          mode: "enforced",
        }),
      ),
      Promise.resolve().then(() =>
        snapshotService.freezeOutboundArrival({
          task: claimedTask!,
          observedNowUtc: FUTURE_RETRY_AT,
          mode: "enforced",
        }),
      ),
    ]);

    expect(left.snapshot).toEqual(first);
    expect(right.snapshot).toEqual(first);
    expect(
      repository.getSnapshotForIncomingLetter(outboundTask.entityId),
    ).toEqual(first);
    expect(count("letter_generation_snapshots")).toBe(1);
    expect(countWhere("domain_events", "event_type LIKE 'letter.%'")).toBe(3);
  });

  it("passes historical identity, effective arrival and letter topic into real persona history, then reuses the frozen hash after reopening", async () => {
    const body = "这封信想和你聊聊工作烦恼，想听听你的近况。";
    fileDirectory = mkdtempSync(join(tmpdir(), "personasim-letter-persona-"));
    const path = join(fileDirectory, "snapshot.db");
    resetSnapshotFixture(body, path);
    const beforeSpec = store.getCharacterSpec(AGENT_ID, 1)!;
    const futureSpec = store.getCharacterSpec(AGENT_ID, 2)!;
    store.updateCharacterHead(beforeSpec);
    let runtime = new PersonaRuntimeService(
      store,
      new MemoryValidityRepository(store),
    );
    store.insertMessage({
      id: "message-persona-before-arrival",
      sessionId: "session-snapshot",
      agentId: AGENT_ID,
      role: "user",
      content: "我谈工作烦恼时，先听我说，不急着建议。",
      messageKind: "user",
      metadata: {},
      createdAtUtc: BEFORE_ARRIVAL,
    });
    const learned = runtime.captureExplicitPractice({
      baseSpec: beforeSpec,
      sourceMessageId: "message-persona-before-arrival",
      nowUtc: BEFORE_ARRIVAL,
      mode: "enforced",
    });
    expect(learned.acceptedAdaptationIds).toHaveLength(1);
    store.updateCharacterHead(futureSpec);
    runtime.retract({
      agentId: AGENT_ID,
      adaptationId: learned.acceptedAdaptationIds[0]!,
      expectedRevision: learned.revision,
      nowUtc: OBSERVED_AT,
      reason: "user_withdrew_after_arrival",
    });
    expect(
      runtime.snapshot({
        baseSpec: futureSpec,
        nowUtc: OBSERVED_AT,
        topicText: body,
      }).relationshipPractices,
    ).toEqual([]);
    const personaProvider = vi.fn(
      (baseSpec: CharacterSpec, nowUtc: string, topicText: string) =>
        runtime.snapshotAsOf({ baseSpec, nowUtc, topicText }),
    );
    snapshotService = new CorrespondenceSnapshotService(
      store,
      {},
      personaProvider,
    );
    let claimedTask: Readonly<TemporalTask> | undefined;
    const baseHandler =
      snapshotService.createOutboundArrivalTaskHandler("enforced");
    await createCatchUp({
      mode: "enforced",
      commit: (context) => {
        claimedTask = context.task;
        baseHandler.commit(context);
      },
    }).catchUpAgent(AGENT_ID, OBSERVED_AT);
    expect(personaProvider).toHaveBeenCalledTimes(1);
    expect(personaProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
      }),
      ARRIVAL_DUE_AT,
      body,
    );
    expect(personaProvider.mock.calls[0]?.[0].identity.name).toBe(
      "Character Before Arrival",
    );
    const first = repository.getSnapshotForIncomingLetter(
      outboundTask.entityId,
    )!;
    if (!("effectivePersona" in first.contextJson)) {
      throw new Error("Expected a frozen effective persona at arrival");
    }
    const persona = EffectivePersonaSnapshotSchema.parse(
      first.contextJson.effectivePersona,
    );
    expect(persona.baseCharacterVersion).toBe(1);
    expect(persona.revision).toBe(1);
    expect(persona.relationshipPractices.map((item) => item.id)).toEqual(
      learned.acceptedAdaptationIds,
    );
    expect(first.contextHash).toBe(
      createHash("sha256")
        .update(
          canonicalLetterGenerationSnapshot({
            contextJson: first.contextJson,
            evidenceIds: first.evidenceIds,
          }),
          "utf8",
        )
        .digest("hex"),
    );
    database.close();
    database = openDatabase(path);
    runMigrations(database);
    store = new DatabaseStore(database);
    repository = new CorrespondenceRepository(database);
    runtime = new PersonaRuntimeService(
      store,
      new MemoryValidityRepository(store),
    );
    snapshotService = new CorrespondenceSnapshotService(
      store,
      {},
      personaProvider,
    );
    const retry = snapshotService.freezeOutboundArrival({
      task: claimedTask!,
      observedNowUtc: FUTURE_RETRY_AT,
      mode: "enforced",
    });
    expect(retry.snapshot).toEqual(first);
    expect(
      repository.getSnapshotForIncomingLetter(outboundTask.entityId)
        ?.contextHash,
    ).toBe(first.contextHash);
    expect(personaProvider).toHaveBeenCalledTimes(1);
  });

  it("excludes a source corrected before arrival even when no persona turn has reconciled the invalidation", async () => {
    const body = "最近的工作让我有些烦恼，写信给你聊聊。";
    resetSnapshotFixture(body);
    const beforeSpec = store.getCharacterSpec(AGENT_ID, 1)!;
    const futureSpec = store.getCharacterSpec(AGENT_ID, 2)!;
    store.updateCharacterHead(beforeSpec);
    const runtime = new PersonaRuntimeService(
      store,
      new MemoryValidityRepository(store),
    );
    store.insertMessage({
      id: "message-persona-corrected-before-arrival",
      sessionId: "session-snapshot",
      agentId: AGENT_ID,
      role: "user",
      content: "我谈工作烦恼时，先听我说，不急着建议。",
      messageKind: "user",
      metadata: {},
      createdAtUtc: DISPATCHED_AT,
    });
    runtime.captureExplicitPractice({
      baseSpec: beforeSpec,
      sourceMessageId: "message-persona-corrected-before-arrival",
      nowUtc: DISPATCHED_AT,
      mode: "enforced",
    });
    const oldProjection = runtime.snapshotAsOf({
      baseSpec: beforeSpec,
      nowUtc: DISPATCHED_AT,
      topicText: body,
    });
    const sourceMemory = oldProjection.relationshipPractices[0]!.sources.find(
      (source) => source.sourceType === "memory",
    )!.sourceId;
    database
      .prepare(
        "UPDATE memories SET status = 'superseded', lifecycle_updated_at_utc = ? WHERE id = ?",
      )
      .run(BEFORE_ARRIVAL, sourceMemory);
    store.updateCharacterHead(futureSpec);
    const personaProvider = vi.fn(
      (baseSpec: CharacterSpec, nowUtc: string, topicText: string) =>
        runtime.snapshotAsOf({ baseSpec, nowUtc, topicText }),
    );
    snapshotService = new CorrespondenceSnapshotService(
      store,
      {},
      personaProvider,
    );
    await createCatchUp(
      snapshotService.createOutboundArrivalTaskHandler("enforced"),
    ).catchUpAgent(AGENT_ID, OBSERVED_AT);
    const frozen = repository.getSnapshotForIncomingLetter(
      outboundTask.entityId,
    )!;
    if (!("effectivePersona" in frozen.contextJson)) {
      throw new Error("Expected a frozen effective persona at arrival");
    }
    const persona = EffectivePersonaSnapshotSchema.parse(
      frozen.contextJson.effectivePersona,
    );
    expect(personaProvider).toHaveBeenCalledWith(
      expect.objectContaining({ version: 1 }),
      ARRIVAL_DUE_AT,
      body,
    );
    expect(persona.revision).toBe(1);
    expect(persona.relationshipPractices).toEqual([]);
    expect(persona.suppressedMemoryIds).toContain(sourceMemory);
    expect(
      runtime.snapshotAsOf({
        baseSpec: beforeSpec,
        nowUtc: DISPATCHED_AT,
        topicText: body,
      }),
    ).toEqual(oldProjection);
  });

  it("rolls the whole arrival bundle back when an audit event fails", async () => {
    const insertDomainEvent = store.insertDomainEvent.bind(store);
    vi.spyOn(store, "insertDomainEvent").mockImplementation((event) => {
      if (event.eventType === "letter.snapshot_frozen") {
        throw new Error("injected snapshot audit failure");
      }
      return insertDomainEvent(event);
    });

    await expect(
      createCatchUp(
        snapshotService.createOutboundArrivalTaskHandler("enforced"),
      ).catchUpAgent(AGENT_ID, OBSERVED_AT),
    ).rejects.toThrow("injected snapshot audit failure");

    const rolledBackLetter = repository.getLetter(outboundTask.entityId);
    expect(rolledBackLetter).toMatchObject({ status: "in_transit" });
    expect(rolledBackLetter?.deliveredEffectiveAtUtc).toBeUndefined();
    expect(rolledBackLetter?.readAtUtc).toBeUndefined();
    expect(repository.getSnapshotForIncomingLetter(outboundTask.entityId)).toBe(
      undefined,
    );
    expect(
      repository.getTaskByIdempotencyKey(
        `letter-reply-run:${outboundTask.entityId}:v1`,
      ),
    ).toBeUndefined();
    expect(repository.getTask(outboundTask.id)).toMatchObject({
      status: "retryable",
      attempt: 1,
      dueAtUtc: ARRIVAL_DUE_AT,
    });
    expect(countWhere("domain_events", "event_type LIKE 'letter.%'")).toBe(0);
  });

  it("fails closed and rolls delivery back when runtime state is newer than arrival", async () => {
    const current = store.getRuntimeState(AGENT_ID)!;
    store.updateRuntimeState({
      ...current,
      asOfUtc: OBSERVED_AT,
      revision: current.revision + 1,
    });

    await expect(
      createCatchUp(
        snapshotService.createOutboundArrivalTaskHandler("enforced"),
      ).catchUpAgent(AGENT_ID, OBSERVED_AT),
    ).rejects.toMatchObject({ code: "snapshot_as_of_violation" });

    const rolledBackLetter = repository.getLetter(outboundTask.entityId);
    expect(rolledBackLetter).toMatchObject({ status: "in_transit" });
    expect(rolledBackLetter?.deliveredEffectiveAtUtc).toBeUndefined();
    expect(count("letter_generation_snapshots")).toBe(0);
    expect(repository.getTask(outboundTask.id)).toMatchObject({
      status: "retryable",
      attempt: 1,
    });
  });

  function createCatchUp(
    handler: OutboundArrivalTaskHandler,
  ): TemporalCatchUpService {
    return new TemporalCatchUpService(
      repository,
      life,
      actors,
      new FakeClock(OBSERVED_AT),
      {
        outboundArrivalTaskHandler: handler,
        createClaimToken: (task) => `claim-${task.id}`,
      },
    );
  }

  function resetSnapshotFixture(body: string, path = ":memory:"): void {
    database.close();
    database = openDatabase(path);
    runMigrations(database);
    store = new DatabaseStore(database);
    repository = new CorrespondenceRepository(database);
    seedCharacterTimeline(store);
    seedAsOfSources(store);
    outboundTask = seedOutboundLetter(repository, database, body);
  }

  function count(table: string): number {
    return Number(
      (
        database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
          count: number;
        }
      ).count,
    );
  }

  function countWhere(table: string, where: string): number {
    return Number(
      (
        database
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
          .get() as { count: number }
      ).count,
    );
  }
});

function seedCharacterTimeline(store: DatabaseStore): void {
  const before = createCharacterSpec(
    1,
    "Character Before Arrival",
    CHARACTER_CREATED_AT,
  );
  store.insertCharacter(before);
  store.insertDomainEvent({
    agentId: AGENT_ID,
    streamType: "character",
    streamId: AGENT_ID,
    streamVersion: 1,
    eventType: "character.published",
    recordedAtUtc: CHARACTER_CREATED_AT,
    effectiveAtUtc: CHARACTER_CREATED_AT,
    payload: { version: 1, tier: before.tier },
    idempotencyKey: `character:${AGENT_ID}:version:1:published`,
  });

  const archivedBefore = CharacterSpecSchema.parse({
    ...before,
    status: "archived",
    updatedAtUtc: OBSERVED_AT,
  });
  store.replaceVersion(archivedBefore);
  const after = createCharacterSpec(2, "Character After Arrival", OBSERVED_AT);
  store.insertCharacterVersion(after);
  store.updateCharacterHead(after);
  store.insertDomainEvent({
    agentId: AGENT_ID,
    streamType: "character",
    streamId: AGENT_ID,
    streamVersion: 2,
    eventType: "character.published",
    recordedAtUtc: OBSERVED_AT,
    effectiveAtUtc: OBSERVED_AT,
    payload: { version: 2, tier: after.tier },
    idempotencyKey: `character:${AGENT_ID}:version:2:published`,
  });

  const initial = initialRuntimeState(AGENT_ID, ARRIVAL_DUE_AT, before);
  const state: RuntimeState = {
    ...initial,
    revision: 8,
    relationship: {
      ...initial.relationship,
      closeness: 0.72,
      trust: 0.81,
      lastInteractionAtUtc: BEFORE_ARRIVAL,
    },
  };
  store.insertInitialState(state, "2026-09-11T12:00:00.000Z");
}

function createCharacterSpec(
  version: number,
  name: string,
  createdAtUtc: string,
): CharacterSpec {
  const draft = buildOriginalDraft({
    name,
    worldSetting: "A contemporary city",
    workOrRole: "photographer",
    coreTraits: ["thoughtful", "independent", "warm"],
    coreContradiction: "care and independence",
    mainGoal: "finish a long-running photo essay",
    initialRelationship: "trusted friend",
    dialogueStyle: "warm and concrete",
    tier: "high_fidelity",
    timezone: "Asia/Shanghai",
  });
  return CharacterSpecSchema.parse({
    ...draft,
    id: AGENT_ID,
    version,
    status: "published",
    createdAtUtc,
    updatedAtUtc: createdAtUtc,
  });
}

function seedAsOfSources(store: DatabaseStore): void {
  const database = store.database;
  database
    .prepare(
      `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
       VALUES ('session-snapshot', ?, 'Snapshot timeline', ?, ?)`,
    )
    .run(AGENT_ID, CHARACTER_CREATED_AT, OBSERVED_AT);
  const insertMessage = database.prepare(
    `INSERT INTO messages(
       id, session_id, agent_id, role, content, message_kind,
       metadata_json, created_at_utc
     ) VALUES (?, 'session-snapshot', ?, ?, ?, ?, '{}', ?)`,
  );
  insertMessage.run(
    "message-before-arrival",
    AGENT_ID,
    "user",
    "CHAT_BEFORE_ARRIVAL",
    "user",
    BEFORE_ARRIVAL,
  );
  insertMessage.run(
    "message-after-arrival",
    AGENT_ID,
    "user",
    FUTURE_CHAT,
    "user",
    OBSERVED_AT,
  );

  seedMemory(
    database,
    "memory-before-arrival",
    "evidence-before-arrival",
    "message-before-arrival",
    "MEMORY_BEFORE_ARRIVAL",
    BEFORE_ARRIVAL,
  );
  seedMemory(
    database,
    "memory-after-arrival",
    "evidence-after-arrival",
    "message-after-arrival",
    FUTURE_MEMORY,
    OBSERVED_AT,
  );
  seedActivity(
    store,
    "activity-before-arrival",
    "LIFE_BEFORE_ARRIVAL",
    BEFORE_ARRIVAL,
  );
  seedActivity(store, "activity-after-arrival", FUTURE_LIFE, OBSERVED_AT);
}

function seedMemory(
  database: Database,
  memoryId: string,
  evidenceId: string,
  sourceMessageId: string,
  content: string,
  recordedAtUtc: string,
): void {
  database
    .prepare(
      `INSERT INTO memories(
         id, agent_id, type, content, tags_json, importance, confidence,
         source_message_id, memory_json, created_at_utc, recorded_at_utc,
         mentioned_at_utc, lifecycle_updated_at_utc, status
       ) VALUES (?, ?, 'episodic', ?, '[]', 0.8, 0.9, ?, ?, ?, ?, ?, ?, 'active')`,
    )
    .run(
      memoryId,
      AGENT_ID,
      content,
      sourceMessageId,
      JSON.stringify({ id: memoryId, content }),
      recordedAtUtc,
      recordedAtUtc,
      recordedAtUtc,
      recordedAtUtc,
    );
  database
    .prepare(
      `INSERT INTO memory_evidence(
         id, memory_id, source_type, source_id, recorded_at_utc, evidence_json
       ) VALUES (?, ?, 'message', ?, ?, ?)`,
    )
    .run(
      evidenceId,
      memoryId,
      sourceMessageId,
      recordedAtUtc,
      JSON.stringify({ id: evidenceId, sourceMessageId }),
    );
}

function seedActivity(
  store: DatabaseStore,
  id: string,
  summary: string,
  occurredAtUtc: string,
): void {
  store.database
    .prepare(
      `INSERT INTO activity_events(
         id, agent_id, event_type, occurred_at_utc, summary,
         outcome_facts_json, state_delta_json, origin,
         idempotency_key, event_json
       ) VALUES (?, ?, 'completed', ?, ?, ?, '{}', 'simulation', ?, ?)`,
    )
    .run(
      id,
      AGENT_ID,
      occurredAtUtc,
      summary,
      JSON.stringify([summary]),
      `activity:${id}`,
      JSON.stringify({ id, summary, temporalStatus: "occurred" }),
    );
  store.insertDomainEvent({
    agentId: AGENT_ID,
    streamType: "simulation",
    streamId: AGENT_ID,
    streamVersion: id === "activity-before-arrival" ? 11 : 12,
    eventType: "simulation.settled",
    recordedAtUtc: occurredAtUtc,
    effectiveAtUtc: occurredAtUtc,
    payload: { activityEventIds: [id] },
    idempotencyKey: `domain:activity:${id}`,
  });
}

function seedOutboundLetter(
  repository: CorrespondenceRepository,
  database: Database,
  body = ORIGINAL_BODY,
): TemporalTask {
  const thread = repository.createThread(AGENT_ID, {
    id: "thread-snapshot",
    nowUtc: DISPATCHED_AT,
  });
  const draft = repository.createDraftLetter({
    id: "letter-current-incoming",
    threadId: thread.id,
    agentId: AGENT_ID,
    subject: "A letter in transit",
    body,
    nowUtc: DISPATCHED_AT,
  });
  const task = repository.sealLetter({
    letterId: draft.id,
    contentHash: CONTENT_HASH,
    transitPolicyVersion: "fixed_5d_v1",
    transitTimezone: "Asia/Shanghai",
    dispatchedAtUtc: DISPATCHED_AT,
    arrivalDueAtUtc: ARRIVAL_DUE_AT,
    effectiveAuthorTimeUtc: DISPATCHED_AT,
    taskId: "task-current-outbound-arrival",
    taskPriority: 10,
    clientRequestId: "seal-current-incoming",
  }).task;
  seedPriorCorrespondence(database, thread.id);
  return task;
}

function seedPriorCorrespondence(database: Database, threadId: string): void {
  database
    .prepare(
      `INSERT INTO letters(
         id, thread_id, agent_id, direction, status, content_hash,
         encrypted_ciphertext, encrypted_iv, encrypted_auth_tag,
         encrypted_key_version, encrypted_aad_hash, encrypted_created_at_utc,
         transit_policy_version, transit_timezone, dispatched_at_utc,
         arrival_due_at_utc, effective_author_time_utc,
         created_at_utc, updated_at_utc
       ) VALUES (
         'letter-prior-sealed-reply', ?, ?, 'agent_to_user', 'in_transit', ?,
         ?, 'MTIzNDU2Nzg5MDEy', 'YWJjZGVmZ2hpamtsbW5vcA==', 1, ?, ?,
         'fixed_5d_v1', 'Asia/Shanghai', ?, ?, ?, ?, ?
       )`,
    )
    .run(
      threadId,
      AGENT_ID,
      "b".repeat(64),
      SEALED_REPLY_CIPHERTEXT,
      "c".repeat(64),
      "2026-09-05T04:00:00.000Z",
      "2026-09-05T04:00:00.000Z",
      "2026-09-10T04:00:00.000Z",
      "2026-09-05T04:00:00.000Z",
      "2026-09-05T04:00:00.000Z",
      "2026-09-05T04:00:00.000Z",
    );
}

function seedSnapshotKeepsake(
  database: Database,
  input: {
    id: string;
    title: string;
    createdAtUtc: string;
    readyAtUtc?: string;
    sourceEventIds: readonly string[];
  },
): void {
  const digest = createHash("sha256").update(input.id).digest("hex");
  database
    .prepare(
      `INSERT INTO keepsakes(
         id, agent_id, title, kind, description, created_by, owned_by,
         source_event_ids_json, source_memory_ids_json, source_letter_ids_json,
         semantic_key, semantic_signature, canonicality, status,
         visual_spec_json, visual_spec_hash, created_effective_at_utc,
         idempotency_key, created_at_utc, updated_at_utc
       ) VALUES (?, ?, ?, 'ticket_stub',
                 '一张由已发生关系事件留下的票根。', 'agent', 'user', ?, '[]',
                 '[]', ?, ?, 'evidence_derived', 'pending', '{}', ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      AGENT_ID,
      input.title,
      JSON.stringify(input.sourceEventIds),
      `cinema:${input.id}`,
      digest,
      digest,
      input.createdAtUtc,
      `keepsake-fixture:${input.id}`,
      input.createdAtUtc,
      input.createdAtUtc,
    );
  if (input.readyAtUtc === undefined) return;

  const taskId = `task-${input.id}`;
  const runId = `run-${input.id}`;
  const assetId = `asset-${input.id}`;
  database
    .prepare(
      `INSERT INTO temporal_tasks(
         id, agent_id, kind, entity_id, due_at_utc, priority, status, attempt,
         max_attempts, idempotency_key, payload_json, created_at_utc,
         updated_at_utc
       ) VALUES (?, ?, 'keepsake.generate', ?, '2099-01-01T00:00:00.000Z', 40,
                 'pending', 0, 3, ?, '{}', ?, ?)`,
    )
    .run(
      taskId,
      AGENT_ID,
      input.id,
      `task-fixture:${input.id}`,
      input.createdAtUtc,
      input.createdAtUtc,
    );
  database
    .prepare(
      `INSERT INTO keepsake_generation_runs(
         id, task_id, keepsake_id, agent_id, generation_epoch,
         visual_spec_hash, status, attempt, created_at_utc, updated_at_utc
       ) VALUES (?, ?, ?, ?, 0, ?, 'pending', 0, ?, ?)`,
    )
    .run(
      runId,
      taskId,
      input.id,
      AGENT_ID,
      digest,
      input.createdAtUtc,
      input.createdAtUtc,
    );
  database
    .prepare(
      `UPDATE keepsakes SET status = 'generating', updated_at_utc = ?
        WHERE id = ?`,
    )
    .run(input.readyAtUtc, input.id);
  database
    .prepare(
      `UPDATE keepsake_generation_runs
          SET status = 'generating', attempt = 1, updated_at_utc = ?
        WHERE id = ?`,
    )
    .run(input.readyAtUtc, runId);
  database
    .prepare(
      `INSERT INTO keepsake_assets(
         id, keepsake_id, agent_id, storage_key, thumbnail_storage_key,
         mime_type, width, height, sha256, thumbnail_sha256, provider, model,
         prompt_spec_hash, generation_run_id, created_at_utc
       ) VALUES (?, ?, ?, ?, ?, 'image/webp', 100, 60, ?, ?, 'fixture',
                 'fixture-v1', ?, ?, ?)`,
    )
    .run(
      assetId,
      input.id,
      AGENT_ID,
      `${AGENT_ID}/${digest}.webp`,
      `${AGENT_ID}/${digest}-thumb.webp`,
      digest,
      digest,
      digest,
      runId,
      input.readyAtUtc,
    );
  database
    .prepare(
      `UPDATE keepsake_generation_runs
          SET status = 'committed', provider = 'fixture', model = 'fixture-v1',
              result_hash = ?, committed_at_utc = ?, updated_at_utc = ?
        WHERE id = ?`,
    )
    .run(digest, input.readyAtUtc, input.readyAtUtc, runId);
  database
    .prepare(
      `UPDATE keepsakes
          SET status = 'ready', primary_asset_id = ?, given_to = 'user',
              gifted_at_utc = ?, updated_at_utc = ?
        WHERE id = ?`,
    )
    .run(assetId, input.readyAtUtc, input.readyAtUtc, input.id);
}

function seedFuzzyLifePeriodFixtures(
  database: Database,
  period: "morning" | "afternoon",
): void {
  const auditAt = "2026-09-07T01:00:00.000Z";
  const localDate = "2026-09-08";
  const suffix = period;
  const contextId = "life-context-period-boundary";
  const intentId = `life-intent-${suffix}`;
  const dilemmaId = `dilemma-${suffix}`;
  const decisionId = `decision-${suffix}`;
  const actionId = `action-${suffix}`;
  const outcomeId = `outcome-${suffix}`;
  const reflectionId = `reflection-${suffix}`;

  database.transaction(() => {
    database
      .prepare(
        `INSERT OR IGNORE INTO daily_life_contexts(
           id, agent_id, local_date, timezone, status, current_period,
           availability, availability_confidence, today_focus_json,
           intent_ids_json, active_thread_ids_json,
           current_pressure_episode_ids_json, recent_outcome_ids_json,
           revision, schema_version, context_json, created_at_utc, updated_at_utc
         ) VALUES (?, ?, ?, 'Asia/Shanghai', 'active', 'morning', 'free',
                   'inferred', '["边界测试"]', '["life-intent-morning"]',
                   '[]', '[]', '[]', 1, 1, '{}', ?, ?)`,
      )
      .run(contextId, AGENT_ID, localDate, auditAt, auditAt);
    database
      .prepare(
        `INSERT INTO daily_life_intents(
           id, agent_id, context_id, local_date, title, summary, domain,
           period, duration_band, commitment_level, status, source_kind,
           shareable, importance, thread_ids_json, goal_ref_ids_json,
           evidence_message_ids_json, idempotency_key, revision,
           schema_version, intent_json, created_at_utc, updated_at_utc
         ) VALUES (?, ?, ?, ?, ?, ?, 'work', ?, 'brief', 'optional',
                   'intended', 'spontaneous', 0, 0.5, '[]', '[]', '[]', ?, 1,
                   1, '{}', ?, ?)`,
      )
      .run(
        intentId,
        AGENT_ID,
        contextId,
        localDate,
        `intent-${suffix}`,
        `intent-${suffix}`,
        period,
        `snapshot-intent-${suffix}`,
        auditAt,
        auditAt,
      );
    database
      .prepare(
        `INSERT INTO life_outcomes(
           id, agent_id, intent_id, outcome_kind, summary,
           outcome_facts_json, origin, thread_ids_json,
           source_evidence_ids_json, importance, effective_local_date,
           effective_period, temporal_precision, recorded_at_utc,
           idempotency_key, schema_version, outcome_json
         ) VALUES (?, ?, ?, 'completed', ?, '["事实"]', 'simulation', '[]',
                   '["message-before-arrival"]', 0.7, ?, ?, 'period', ?, ?, 1, ?)`,
      )
      .run(
        `life-outcome-${suffix}`,
        AGENT_ID,
        intentId,
        `life-outcome-${suffix}`,
        localDate,
        period,
        auditAt,
        `snapshot-life-outcome-${suffix}`,
        JSON.stringify({ marker: `life-outcome-${suffix}` }),
      );
    database
      .prepare(
        `INSERT INTO dilemma_episodes(
           id, agent_id, session_id, subject, title, summary, domain,
           options_json, status, source_message_ids_json,
           effective_local_date, effective_period, temporal_precision,
           recorded_at_utc, updated_at_utc, idempotency_key, schema_version,
           episode_json
         ) VALUES (?, ?, 'session-snapshot', 'character', ?, ?, 'work',
                   '[{},{}]', 'open', '["message-before-arrival"]', ?, ?,
                   'period', ?, ?, ?, 1, ?)`,
      )
      .run(
        dilemmaId,
        AGENT_ID,
        `dilemma-${suffix}`,
        `dilemma-${suffix}`,
        localDate,
        period,
        auditAt,
        auditAt,
        `snapshot-dilemma-${suffix}`,
        JSON.stringify({ marker: `dilemma-${suffix}` }),
      );
    database
      .prepare(
        `INSERT INTO decision_records(
           id, agent_id, session_id, dilemma_id, subject, support_mode,
           authority, decided_by, selected_option_id, selection_summary,
           reasoning_summary, support_intervention_ids_json,
           source_message_ids_json, confidence, status, effective_local_date,
           effective_period, temporal_precision, recorded_at_utc,
           idempotency_key, schema_version, decision_json
         ) VALUES (?, ?, 'session-snapshot', ?, 'character', 'deliberate',
                   'subject', 'character', 'option-a', ?, ?, '[]',
                   '["message-before-arrival"]', 0.8, 'current', ?, ?,
                   'period', ?, ?, 1, ?)`,
      )
      .run(
        decisionId,
        AGENT_ID,
        dilemmaId,
        `decision-${suffix}`,
        `decision-${suffix}`,
        localDate,
        period,
        auditAt,
        `snapshot-decision-${suffix}`,
        JSON.stringify({ marker: `decision-${suffix}` }),
      );
    database
      .prepare(
        `INSERT INTO action_records(
           id, agent_id, session_id, decision_id, subject, performed_by,
           action_kind, summary, source_evidence_ids_json,
           effective_local_date, effective_period, temporal_precision,
           recorded_at_utc, idempotency_key, schema_version, action_json
         ) VALUES (?, ?, 'session-snapshot', ?, 'character', 'character',
                   'initiated', ?, '["message-before-arrival"]', ?, ?,
                   'period', ?, ?, 1, ?)`,
      )
      .run(
        actionId,
        AGENT_ID,
        decisionId,
        `action-${suffix}`,
        localDate,
        period,
        auditAt,
        `snapshot-action-${suffix}`,
        JSON.stringify({ marker: `action-${suffix}` }),
      );
    database
      .prepare(
        `INSERT INTO outcome_records(
           id, agent_id, session_id, decision_id, action_ids_json, cause_kind,
           valence, summary, consequence_facts_json, source_evidence_ids_json,
           confidence, status, effective_local_date, effective_period,
           temporal_precision, recorded_at_utc, idempotency_key,
           schema_version, outcome_json
         ) VALUES (?, ?, 'session-snapshot', ?, ?, 'action', 'positive', ?,
                   '["结果"]', '["message-before-arrival"]', 0.8, 'confirmed',
                   ?, ?, 'period', ?, ?, 1, ?)`,
      )
      .run(
        outcomeId,
        AGENT_ID,
        decisionId,
        JSON.stringify([actionId]),
        `outcome-${suffix}`,
        localDate,
        period,
        auditAt,
        `snapshot-outcome-${suffix}`,
        JSON.stringify({ marker: `outcome-${suffix}` }),
      );
    database
      .prepare(
        `INSERT INTO reflection_records(
           id, agent_id, session_id, subject, reflected_by, decision_id,
           outcome_id, summary, lessons_json, stance_toward_decision,
           changed_interpretation, source_message_ids_json,
           effective_local_date, effective_period, temporal_precision,
           recorded_at_utc, idempotency_key, schema_version, reflection_json
         ) VALUES (?, ?, 'session-snapshot', 'character', 'character', ?, ?, ?,
                   '["领悟"]', 'affirm', 0, '["message-before-arrival"]', ?, ?,
                   'period', ?, ?, 1, ?)`,
      )
      .run(
        reflectionId,
        AGENT_ID,
        decisionId,
        outcomeId,
        `reflection-${suffix}`,
        localDate,
        period,
        auditAt,
        `snapshot-reflection-${suffix}`,
        JSON.stringify({ marker: `reflection-${suffix}` }),
      );
    database
      .prepare(
        `INSERT INTO relationship_milestones(
           id, agent_id, session_id, kind, title, summary, significance,
           intervention_ids_json, decision_ids_json, outcome_ids_json,
           reflection_ids_json, source_message_ids_json, effective_local_date,
           effective_period, temporal_precision, recorded_at_utc,
           idempotency_key, schema_version, milestone_json
         ) VALUES (?, ?, 'session-snapshot', 'turning_point', ?, ?, 0.8, '[]',
                   ?, ?, ?, '["message-before-arrival"]', ?, ?, 'period', ?, ?,
                   1, ?)`,
      )
      .run(
        `milestone-${suffix}`,
        AGENT_ID,
        `milestone-${suffix}`,
        `milestone-${suffix}`,
        JSON.stringify([decisionId]),
        JSON.stringify([outcomeId]),
        JSON.stringify([reflectionId]),
        localDate,
        period,
        auditAt,
        `snapshot-milestone-${suffix}`,
        JSON.stringify({ marker: `milestone-${suffix}` }),
      );
  })();
}
