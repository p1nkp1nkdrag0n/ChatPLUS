import {
  MemorySchema,
  type AutobiographyRevisionProposal,
  type ContinuityEvidenceRef,
  type EventCard,
  type Memory,
} from "@personasim/contracts";
import { boundedRecallHanBigrams } from "@personasim/features";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore, type StoredMessage } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import {
  AutobiographyService,
  type VerifiedContinuityEvidence,
} from "./autobiography-service.js";
import {
  CheckpointService,
  checkpointSourceHash,
  type CheckpointAutobiographyModel,
  type CheckpointAutobiographyModelInput,
} from "./checkpoint-service.js";
import { ContinuityIndexService } from "./continuity-index-service.js";
import { ContinuityMemoryRepository } from "./continuity-memory-repository.js";
import { ContinuityRepository } from "./continuity-repository.js";
import { DateDigestService } from "./date-digest-service.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";

const AGENT_ID = "agent_continuity";
const SESSION_ID = "session_continuity";
const NOW_UTC = "2026-08-21T12:00:00.000Z";
const RETENTION_POLICY = {
  fullVerbatimHours: 0,
  softTokenLimit: 256,
  hardTokenLimit: 512,
  minimumTailTokens: 1,
  minimumRecentTurns: 1,
} as const;

describe("continuity services", () => {
  let database: Database;
  let store: DatabaseStore;
  let clock: FakeClock;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    store = new DatabaseStore(database);
    clock = new FakeClock(NOW_UTC);
    seedCharacterAndSession(database);
  });

  afterEach(() => {
    database.close();
  });

  it("prioritizes bounded Han bigrams for paraphrased continuity search", () => {
    insertMessage(store, {
      id: "msg_han_preference",
      role: "user",
      messageKind: "user",
      content:
        "\u6211\u4e0d\u53c2\u52a0\u5e86\u529f\u5bb4\uff1b\u4efb\u52a1\u5b8c\u6210\u540e\uff0c\u6211\u66f4\u559c\u6b22\u53bb\u5b89\u9759\u7684\u6cb3\u8fb9\u6563\u6b65\u590d\u76d8\u3002",
      createdAtUtc: "2026-08-21T11:00:00.000Z",
    });
    insertMessage(store, {
      id: "msg_han_secondary",
      role: "user",
      messageKind: "user",
      content: "\u4efb\u52a1\u5df2\u7ecf\u5b8c\u6210\u3002",
      createdAtUtc: "2026-08-21T11:10:00.000Z",
    });
    insertMessage(store, {
      id: "msg_han_distractor",
      role: "user",
      messageKind: "user",
      content: "\u5b8c\u6210\u4e86\u7761\u7720\u3002",
      createdAtUtc: "2026-08-21T11:20:00.000Z",
    });
    insertActivity(
      database,
      "activity_han_preference",
      "2026-08-21T11:30:00.000Z",
      "\u4efb\u52a1\u5b8c\u6210\u540e\u6ca1\u6709\u53c2\u52a0\u5e86\u529f\u5bb4\uff0c\u53bb\u4e86\u5b89\u9759\u7684\u6cb3\u8fb9\u6563\u6b65\u590d\u76d8\u3002",
    );
    insertActivity(
      database,
      "activity_han_secondary",
      "2026-08-21T11:40:00.000Z",
      "\u4efb\u52a1\u5df2\u7ecf\u5b8c\u6210",
    );
    insertActivity(
      database,
      "activity_han_distractor",
      "2026-08-21T11:50:00.000Z",
      "\u5b8c\u6210\u4e86\u7761\u7720",
    );
    const repository = new ContinuityRepository(store);
    const index = new ContinuityIndexService(repository, clock);
    index.rebuildAgent(AGENT_ID);
    const query =
      "\u6211\u4e0d\u559c\u6b22\u54ea\u4e00\u79cd\u5e86\u529f\u65b9\u5f0f\uff1f\u4efb\u52a1\u5b8c\u6210\u540e\u6211\u66f4\u559c\u6b22\u53bb\u54ea\u91cc\u3001\u505a\u4ec0\u4e48\uff1f";

    expect(
      repository
        .searchArchivedMessages({ agentId: AGENT_ID, query, limit: 5 })
        .map((message) => message.id),
    ).toEqual(["msg_han_preference", "msg_han_secondary"]);
    expect(
      repository
        .searchEventCards({ agentId: AGENT_ID, query, limit: 5 })
        .map((card) => card.sourceId),
    ).toEqual(["activity_han_preference", "activity_han_secondary"]);
    expect(
      repository
        .searchArchivedMessages({ agentId: AGENT_ID, query, limit: 1 })
        .map((message) => message.id),
    ).toEqual(["msg_han_preference"]);
    expect(
      repository
        .searchEventCards({ agentId: AGENT_ID, query, limit: 1 })
        .map((card) => card.sourceId),
    ).toEqual(["activity_han_preference"]);
  });

  it("keeps tail exact IDs and Han anchors visible in bounded continuity searches", () => {
    insertMessage(store, {
      id: "msg_tail_rare_code",
      role: "user",
      messageKind: "user",
      content: "两字暗号蓝鲸；仪式代号 BGW-7419 对应蓝色玻璃鲸。",
      createdAtUtc: "2026-08-21T11:00:00.000Z",
    });
    insertActivity(
      database,
      "activity_tail_rare_code",
      "2026-08-21T11:30:00.000Z",
      "完成了蓝鲸暗号和 BGW-7419 对应的蓝色玻璃鲸仪式。",
    );
    const genericHan = longHanPrefix(4);
    insertMessage(store, {
      id: "msg_generic_han_head",
      role: "user",
      messageKind: "user",
      content: "干扰" + genericHan + "内容",
      createdAtUtc: "2026-08-21T11:45:00.000Z",
    });
    insertActivity(
      database,
      "activity_generic_han_head",
      "2026-08-21T11:50:00.000Z",
      "干扰" + genericHan + "活动",
    );
    const repository = new ContinuityRepository(store);
    const index = new ContinuityIndexService(repository, clock);
    index.rebuildAgent(AGENT_ID);

    const exactQuery = alphabeticFillerWords(30).join(" ") + " BGW-7419";
    expect(
      repository
        .searchArchivedMessages({
          agentId: AGENT_ID,
          query: exactQuery,
          limit: 5,
        })
        .map((message) => message.id),
    ).toContain("msg_tail_rare_code");
    expect(
      repository
        .searchEventCards({
          agentId: AGENT_ID,
          query: exactQuery,
          limit: 5,
        })
        .map((card) => card.sourceId),
    ).toContain("activity_tail_rare_code");

    const hanQuery = longHanPrefix(90) + " 蓝色玻璃鲸";
    const boundedHanTerms = boundedRecallHanBigrams(hanQuery, 64);
    expect(boundedHanTerms).toHaveLength(64);
    expect(boundedHanTerms).toContain(longHanPrefix(2));
    expect(boundedHanTerms).toEqual(
      expect.arrayContaining(["蓝色", "色玻", "玻璃", "璃鲸"]),
    );
    expect(
      repository
        .searchArchivedMessages({
          agentId: AGENT_ID,
          query: hanQuery,
          limit: 5,
        })
        .map((message) => message.id),
    ).toContain("msg_tail_rare_code");
    expect(
      repository
        .searchEventCards({
          agentId: AGENT_ID,
          query: hanQuery,
          limit: 5,
        })
        .map((card) => card.sourceId),
    ).toContain("activity_tail_rare_code");

    const twoCharacterHanQuery = longHanPrefix(90) + " 蓝鲸";
    expect(boundedRecallHanBigrams(twoCharacterHanQuery, 64)).toContain("蓝鲸");
    expect(
      repository
        .searchArchivedMessages({
          agentId: AGENT_ID,
          query: twoCharacterHanQuery,
          limit: 1,
        })
        .map((message) => message.id),
    ).toEqual(["msg_tail_rare_code"]);
    expect(
      repository
        .searchEventCards({
          agentId: AGENT_ID,
          query: twoCharacterHanQuery,
          limit: 1,
        })
        .map((card) => card.sourceId),
    ).toEqual(["activity_tail_rare_code"]);

    const mixedQuery = longHanPrefix(90) + " BGW-7419";
    expect(
      repository
        .searchArchivedMessages({
          agentId: AGENT_ID,
          query: mixedQuery,
          limit: 1,
        })
        .map((message) => message.id),
    ).toEqual(["msg_tail_rare_code"]);
    expect(
      repository
        .searchEventCards({
          agentId: AGENT_ID,
          query: mixedQuery,
          limit: 1,
        })
        .map((card) => card.sourceId),
    ).toEqual(["activity_tail_rare_code"]);
  });

  it("invalidates an in-flight checkpoint on revision change, preserves the old head, retries, and rebuilds both indexes", async () => {
    insertMessage(store, {
      id: "msg_old_user",
      role: "user",
      messageKind: "user",
      content: "Earlier conversation boundary.",
      createdAtUtc: "2026-08-21T01:00:00.000Z",
    });
    insertMessage(store, {
      id: "msg_old_assistant",
      role: "assistant",
      messageKind: "assistant_reply",
      inReplyToMessageId: "msg_old_user",
      content: "Earlier boundary reply.",
      createdAtUtc: "2026-08-21T01:01:00.000Z",
    });
    const repository = new ContinuityRepository(store);
    seedCommittedCheckpoint(repository, database);
    for (let index = 0; index < 4; index += 1) {
      insertLargeTurn(store, index);
    }

    const model = new FakeCheckpointModel();
    const services = createServices(repository, model, clock);
    let insertedDuringGeneration = false;
    model.beforeReturn = () => {
      insertedDuringGeneration = true;
      insertMessage(store, {
        id: "msg_racing_user",
        role: "user",
        messageKind: "user",
        content:
          "A user message arrived while checkpoint generation was running.",
        createdAtUtc: "2026-08-21T11:00:00.000Z",
      });
    };

    const conflicted = await services.checkpoints.createIfNeeded({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
    expect(insertedDuringGeneration).toBe(true);
    expect(conflicted.status).toBe("invalidated");
    if (conflicted.status !== "invalidated") {
      throw new Error("Expected checkpoint invalidation.");
    }
    expect(conflicted.reason).toBe("source_changed");
    expect(
      database
        .prepare(
          "SELECT status FROM conversation_checkpoints WHERE id = 'checkpoint_old'",
        )
        .get(),
    ).toEqual({ status: "committed" });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM autobiography_snapshots")
        .get(),
    ).toEqual({ count: 0 });

    model.beforeReturn = undefined;
    const retried = await services.checkpoints.createIfNeeded({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
    expect(retried.status).toBe("committed");
    if (retried.status !== "committed") {
      throw new Error("Expected checkpoint retry to commit.");
    }
    expect(retried.checkpoint.previousCheckpointId).toBe("checkpoint_old");
    const autobiography = repository.getLatestAutobiography(AGENT_ID);
    expect(autobiography?.snapshot.sourceEvidenceIds.length).toBeGreaterThan(0);
    expect(autobiography?.entries[0]?.evidence[0]?.sourceType).toBe(
      "message_archive",
    );
    expect(retried.eventCards[0]?.sourceEvidenceIds).toEqual(
      autobiography?.entries[0]?.sourceEvidenceIds,
    );

    insertActivity(
      database,
      "activity_rebuild_stable",
      "2026-08-20T10:30:00.000Z",
      "Completed a stable mountain walk.",
    );

    const rawMessageCount = (
      database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE agent_id = ?")
        .get(AGENT_ID) as { count: number }
    ).count;
    database
      .prepare("DELETE FROM message_archive WHERE agent_id = ?")
      .run(AGENT_ID);
    database
      .prepare("DELETE FROM event_cards WHERE agent_id = ?")
      .run(AGENT_ID);
    const rebuilt = services.index.rebuildAgent(AGENT_ID);
    expect(rebuilt.archivedMessageCount).toBe(rawMessageCount);
    expect(rebuilt.eventCardCount).toBeGreaterThan(0);
    expect(
      services.index.searchVerbatim({
        agentId: AGENT_ID,
        query: "mountain",
      }).length,
    ).toBeGreaterThan(0);
    expect(
      services.index.searchEventCards({
        agentId: AGENT_ID,
        query: "mountain",
      }).length,
    ).toBeGreaterThan(0);
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM messages WHERE agent_id = ?")
        .get(AGENT_ID),
    ).toEqual({ count: rawMessageCount });
    const stableCards = readIndexedCards(database);
    const stableActivityCard = stableCards.find(
      (card) => card.sourceId === "activity_rebuild_stable",
    );
    if (stableActivityCard === undefined) {
      throw new Error("Expected the rebuilt ActivityEvent card.");
    }
    expect(stableActivityCard).toMatchObject({
      createdAtUtc: "2026-08-20T10:30:00.000Z",
      updatedAtUtc: "2026-08-20T10:30:00.000Z",
    });
    const stableRanking = services.index
      .searchEventCards({
        agentId: AGENT_ID,
        query: "mountain",
        limit: 100,
      })
      .map((card) => card.id);

    clock.advance({ days: 30 });
    const rebuiltLater = services.index.rebuildAgent(AGENT_ID);
    expect(rebuiltLater.eventCardCount).toBe(rebuilt.eventCardCount);
    expect(readIndexedCards(database)).toEqual(stableCards);
    expect(
      services.index
        .searchEventCards({
          agentId: AGENT_ID,
          query: "mountain",
          limit: 100,
        })
        .map((card) => card.id),
    ).toEqual(stableRanking);
  });

  it("keeps planned autobiography and event-card facts planned", async () => {
    for (let index = 0; index < 4; index += 1) {
      insertLargeTurn(store, index);
    }
    const repository = new ContinuityRepository(store);
    const model = new FakeCheckpointModel("planned");
    const services = createServices(repository, model, clock);
    const result = await services.checkpoints.createIfNeeded({
      agentId: AGENT_ID,
      sessionId: SESSION_ID,
    });
    expect(result.status).toBe("committed");
    const entry = database
      .prepare(
        `SELECT temporal_status, from_utc
         FROM autobiography_entries LIMIT 1`,
      )
      .get();
    expect(entry).toEqual({
      temporal_status: "planned",
      from_utc: "2026-08-22T09:00:00.000Z",
    });
    const card = database
      .prepare(
        `SELECT temporal_status, planned_start_at_utc,
          occurred_start_at_utc, occurred_end_at_utc
         FROM event_cards WHERE source_kind = 'checkpoint' LIMIT 1`,
      )
      .get();
    expect(card).toEqual({
      temporal_status: "planned",
      planned_start_at_utc: "2026-08-22T09:00:00.000Z",
      occurred_start_at_utc: null,
      occurred_end_at_utc: null,
    });
  });

  it("builds range-safe date digests and applies aging, supersede, and merge lifecycle transitions", () => {
    insertActivity(
      database,
      "activity_inside",
      "2026-08-20T10:00:00.000Z",
      "Completed a reliable mountain walk.",
    );
    insertActivity(
      database,
      "activity_outside",
      "2026-08-19T10:00:00.000Z",
      "Completed an out-of-range walk.",
    );
    insertMessage(store, {
      id: "msg_memory_evidence",
      role: "user",
      messageKind: "user",
      content: "We completed the shared dinner yesterday.",
      createdAtUtc: "2026-08-20T11:00:00.000Z",
    });
    insertMemory(database, {
      id: "memory_shared",
      content: "We completed the shared dinner.",
      namespace: "shared_relationship",
      certainty: "explicit",
      attribution: "user_explicit",
      temporalStatus: "occurred",
      occurredStartAtUtc: "2026-08-20T11:00:00.000Z",
      evidenceSourceId: "msg_memory_evidence",
    });
    insertMemory(database, {
      id: "memory_inferred",
      content: "An inferred event must not enter the digest.",
      namespace: "user_model",
      certainty: "inferred",
      attribution: "model_inference",
      temporalStatus: "occurred",
      occurredStartAtUtc: "2026-08-20T12:00:00.000Z",
      evidenceSourceId: "msg_memory_evidence",
    });
    insertMemory(database, {
      id: "memory_planned",
      content: "A planned event must not enter the digest.",
      namespace: "shared_relationship",
      certainty: "explicit",
      attribution: "user_explicit",
      temporalStatus: "planned",
      evidenceSourceId: "msg_memory_evidence",
    });

    const memoryRepository = new ContinuityMemoryRepository(store);
    const dates = new DateDigestService(memoryRepository);
    const query = dates.query({
      agentId: AGENT_ID,
      text: "yesterday",
      nowUtc: NOW_UTC,
      timezone: "UTC",
    });
    expect(query.resolution.kind).toBe("resolved");
    if (query.resolution.kind !== "resolved") {
      throw new Error("Expected a resolved temporal query.");
    }
    expect(query.digest?.items.map((item) => item.sourceId).sort()).toEqual([
      "activity_inside",
      "memory_shared",
    ]);

    insertLifecycleMemory(database, {
      id: "memory_aging",
      content: "A low importance situational memory.",
      createdAtUtc: "2026-06-01T00:00:00.000Z",
    });
    insertLifecycleMemory(database, {
      id: "memory_goal_old",
      content: "I plan to prepare for the entrance exam.",
      createdAtUtc: "2026-07-01T00:00:00.000Z",
      claim: {
        subjectKey: "goal:entrance_exam",
        disposition: "affirmed",
        recordedAtUtc: "2026-07-01T00:00:00.000Z",
      },
    });
    insertLifecycleMemory(database, {
      id: "memory_goal_new",
      content: "I decided to cancel the entrance exam plan.",
      createdAtUtc: "2026-08-20T00:00:00.000Z",
      claim: {
        subjectKey: "goal:entrance_exam",
        disposition: "cancelled",
        recordedAtUtc: "2026-08-20T00:00:00.000Z",
      },
    });
    insertLifecycleMemory(database, {
      id: "memory_merge_target",
      content: "I enjoy mountain hiking every weekend.",
      createdAtUtc: "2026-08-01T00:00:00.000Z",
      claim: {
        subjectKey: "preference:mountain_hiking",
        disposition: "affirmed",
        recordedAtUtc: "2026-08-01T00:00:00.000Z",
      },
    });
    insertLifecycleMemory(database, {
      id: "memory_merge_source",
      content: "I enjoy mountain hiking every weekend.",
      createdAtUtc: "2026-08-20T00:00:00.000Z",
      claim: {
        subjectKey: "preference:mountain_hiking",
        disposition: "affirmed",
        recordedAtUtc: "2026-08-20T00:00:00.000Z",
      },
    });

    const lifecycle = new MemoryLifecycleService(memoryRepository, clock, {
      activeToAgingDays: 30,
      agingToArchivedDays: 90,
      protectedImportance: 0.8,
    });
    const maintenance = lifecycle.maintainAgent(AGENT_ID);
    expect(maintenance.transitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memoryId: "memory_aging",
          toStatus: "aging",
        }),
      ]),
    );
    const superseded = lifecycle.reconcile({
      existingMemoryId: "memory_goal_old",
      incomingMemoryId: "memory_goal_new",
    });
    expect(superseded.reconciliation.kind).toBe("supersede");
    expect(
      database
        .prepare(
          `SELECT status, superseded_by_id
           FROM memories WHERE id = 'memory_goal_old'`,
        )
        .get(),
    ).toEqual({
      status: "superseded",
      superseded_by_id: "memory_goal_new",
    });
    expect(
      database
        .prepare("SELECT resolution FROM memory_conflicts WHERE id = ?")
        .get(superseded.conflictId),
    ).toEqual({ resolution: "superseded" });

    const merged = lifecycle.reconcile({
      existingMemoryId: "memory_merge_target",
      incomingMemoryId: "memory_merge_source",
    });
    expect(merged.reconciliation.kind).toBe("merge");
    expect(
      database
        .prepare(
          `SELECT status, merged_into_id
           FROM memories WHERE id = 'memory_merge_source'`,
        )
        .get(),
    ).toEqual({
      status: "merged",
      merged_into_id: "memory_merge_target",
    });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM memory_merge_history")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("keeps an explicit correction canonical across conflicting and equivalent old claims", () => {
    const subjectKey = "user_preference:usual_drink";
    insertLifecycleMemory(database, {
      id: "memory_drink_conflict",
      content: "I usually drink jasmine tea.",
      createdAtUtc: "2026-08-19T00:00:00.000Z",
      claim: {
        subjectKey,
        disposition: "affirmed",
        recordedAtUtc: "2026-08-19T00:00:00.000Z",
      },
    });
    insertLifecycleMemory(database, {
      id: "memory_drink_equivalent",
      content: "I usually drink warm water.",
      createdAtUtc: "2026-08-20T00:00:00.000Z",
      claim: {
        subjectKey,
        disposition: "affirmed",
        recordedAtUtc: "2026-08-20T00:00:00.000Z",
      },
    });
    insertLifecycleMemory(database, {
      id: "memory_drink_correction",
      content: "I usually drink warm water.",
      createdAtUtc: "2026-08-21T00:00:00.000Z",
      claim: {
        subjectKey,
        disposition: "affirmed",
        recordedAtUtc: "2026-08-21T00:00:00.000Z",
        revisionIntent: "explicit_correction",
      },
    });

    const repository = new ContinuityMemoryRepository(store);
    const lifecycle = new MemoryLifecycleService(repository, clock);
    const results = lifecycle.reconcileNewMemories(AGENT_ID, [
      "memory_drink_correction",
    ]);

    expect(results).toHaveLength(2);
    expect(results.map((result) => result.reconciliation.kind).sort()).toEqual([
      "merge",
      "supersede",
    ]);
    expect(
      database
        .prepare(
          `SELECT id, status, superseded_by_id, merged_into_id
           FROM memories WHERE id LIKE 'memory_drink_%' ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: "memory_drink_conflict",
        status: "superseded",
        superseded_by_id: "memory_drink_correction",
        merged_into_id: null,
      },
      {
        id: "memory_drink_correction",
        status: "active",
        superseded_by_id: null,
        merged_into_id: null,
      },
      {
        id: "memory_drink_equivalent",
        status: "merged",
        superseded_by_id: null,
        merged_into_id: "memory_drink_correction",
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM memories AS source
           JOIN memories AS target ON target.id = source.superseded_by_id
           WHERE target.status = 'merged'`,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          `SELECT resolution, winner_memory_id
           FROM memory_conflicts ORDER BY left_memory_id, right_memory_id`,
        )
        .all(),
    ).toEqual([
      {
        resolution: "superseded",
        winner_memory_id: "memory_drink_correction",
      },
      {
        resolution: "merged",
        winner_memory_id: "memory_drink_correction",
      },
    ]);
    expect(
      database
        .prepare(
          `SELECT target_memory_id, source_memory_id
           FROM memory_merge_history`,
        )
        .get(),
    ).toEqual({
      target_memory_id: "memory_drink_correction",
      source_memory_id: "memory_drink_equivalent",
    });
    expect(
      database
        .prepare(
          `SELECT event_type FROM domain_events
           WHERE event_type LIKE 'memory.claim.%' ORDER BY event_type`,
        )
        .all(),
    ).toEqual([
      { event_type: "memory.claim.merge" },
      { event_type: "memory.claim.supersede" },
    ]);

    const replay = lifecycle.reconcileNewMemories(AGENT_ID, [
      "memory_drink_correction",
    ]);
    expect(replay).toHaveLength(2);
    expect(replay.every((result) => result.replayed)).toBe(true);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memory_conflicts").get(),
    ).toEqual({ count: 2 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM memory_merge_history")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("rolls back the full explicit-correction batch when an audit write fails", () => {
    const subjectKey = "user_fact:relationship:friend";
    for (const memory of [
      {
        id: "memory_relation_old_a",
        content: "Lin was my university classmate.",
        createdAtUtc: "2026-08-19T00:00:00.000Z",
      },
      {
        id: "memory_relation_old_b",
        content: "Lin was my coworker.",
        createdAtUtc: "2026-08-20T00:00:00.000Z",
      },
    ]) {
      insertLifecycleMemory(database, {
        ...memory,
        claim: {
          subjectKey,
          disposition: "affirmed",
          recordedAtUtc: memory.createdAtUtc,
        },
      });
    }
    insertLifecycleMemory(database, {
      id: "memory_relation_correction",
      content: "Lin was my high-school classmate.",
      createdAtUtc: "2026-08-21T00:00:00.000Z",
      claim: {
        subjectKey,
        disposition: "affirmed",
        recordedAtUtc: "2026-08-21T00:00:00.000Z",
        revisionIntent: "explicit_correction",
      },
    });

    const repository = new ContinuityMemoryRepository(store);
    const originalInsert = repository.insertMemoryConflict.bind(repository);
    let conflictWrites = 0;
    const insertSpy = vi
      .spyOn(repository, "insertMemoryConflict")
      .mockImplementation((conflict) => {
        conflictWrites += 1;
        if (conflictWrites === 2) throw new Error("simulated audit failure");
        return originalInsert(conflict);
      });
    const lifecycle = new MemoryLifecycleService(repository, clock);

    expect(() =>
      lifecycle.reconcileNewMemories(AGENT_ID, ["memory_relation_correction"]),
    ).toThrow("simulated audit failure");
    insertSpy.mockRestore();

    expect(
      database
        .prepare(
          `SELECT id, status, superseded_by_id, merged_into_id
           FROM memories WHERE id LIKE 'memory_relation_%' ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: "memory_relation_correction",
        status: "active",
        superseded_by_id: null,
        merged_into_id: null,
      },
      {
        id: "memory_relation_old_a",
        status: "active",
        superseded_by_id: null,
        merged_into_id: null,
      },
      {
        id: "memory_relation_old_b",
        status: "active",
        superseded_by_id: null,
        merged_into_id: null,
      },
    ]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memory_conflicts").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM memory_merge_history")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare(
          `SELECT COUNT(*) AS count FROM domain_events
           WHERE event_type LIKE 'memory.claim.%'`,
        )
        .get(),
    ).toEqual({ count: 0 });
  });
});

class FakeCheckpointModel implements CheckpointAutobiographyModel {
  beforeReturn: (() => void | Promise<void>) | undefined;

  constructor(
    private readonly temporalStatus: "unknown" | "planned" = "unknown",
  ) {}

  async generateAutobiography(
    input: CheckpointAutobiographyModelInput,
  ): Promise<AutobiographyRevisionProposal> {
    await this.beforeReturn?.();
    const evidence = input.evidence[0];
    if (evidence === undefined) throw new Error("Missing checkpoint evidence.");
    const content = evidence.text.slice(0, 500).trim();
    return {
      summaryFirstPerson: content,
      entries: [
        {
          entryKind: "important_experience",
          content,
          temporalStatus: this.temporalStatus,
          ...(this.temporalStatus === "planned"
            ? { fromUtc: "2026-08-22T09:00:00.000Z" }
            : {}),
          evidence: [toEvidenceRef(evidence)],
        },
      ],
    };
  }
}

function createServices(
  repository: ContinuityRepository,
  model: CheckpointAutobiographyModel,
  clock: FakeClock,
): {
  checkpoints: CheckpointService;
  index: ContinuityIndexService;
} {
  const autobiography = new AutobiographyService(repository);
  const index = new ContinuityIndexService(repository, clock);
  return {
    checkpoints: new CheckpointService(
      repository,
      clock,
      model,
      autobiography,
      index,
      RETENTION_POLICY,
    ),
    index,
  };
}

function seedCharacterAndSession(database: Database): void {
  database
    .prepare(
      `INSERT INTO characters(
        id, current_version, status, tier, name, source_type,
        created_at_utc, updated_at_utc
      ) VALUES (?, 1, 'published', 'daily', 'Continuity', 'original', ?, ?)`,
    )
    .run(AGENT_ID, NOW_UTC, NOW_UTC);
  database
    .prepare(
      `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
       VALUES (?, ?, 'Continuity', ?, ?)`,
    )
    .run(SESSION_ID, AGENT_ID, NOW_UTC, NOW_UTC);
}

function insertMessage(
  store: DatabaseStore,
  input: Omit<StoredMessage, "sessionId" | "agentId" | "metadata">,
): void {
  store.insertMessage({
    ...input,
    sessionId: SESSION_ID,
    agentId: AGENT_ID,
    metadata: {},
  });
}

function insertLargeTurn(store: DatabaseStore, index: number): void {
  const userId = `msg_user_${index}`;
  const content = `turn ${index} mountain hiking memory `.repeat(45);
  insertMessage(store, {
    id: userId,
    role: "user",
    messageKind: "user",
    content,
    createdAtUtc: `2026-08-21T0${index + 2}:00:00.000Z`,
  });
  insertMessage(store, {
    id: `msg_assistant_${index}`,
    role: "assistant",
    messageKind: "assistant_reply",
    inReplyToMessageId: userId,
    content,
    createdAtUtc: `2026-08-21T0${index + 2}:01:00.000Z`,
  });
}

function seedCommittedCheckpoint(
  repository: ContinuityRepository,
  database: Database,
): void {
  const messages = repository.listArchivedMessageRange(
    SESSION_ID,
    "msg_old_user",
    "msg_old_assistant",
  );
  database
    .prepare(
      `INSERT INTO conversation_checkpoints(
        id, agent_id, session_id, from_message_id, through_message_id,
        source_hash, source_revision, source_message_count,
        source_token_estimate, artifact_json, status, created_at_utc,
        updated_at_utc, committed_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, 2, 2, 20, '{}', 'committed', ?, ?, ?)`,
    )
    .run(
      "checkpoint_old",
      AGENT_ID,
      SESSION_ID,
      "msg_old_user",
      "msg_old_assistant",
      checkpointSourceHash(messages),
      "2026-08-21T01:02:00.000Z",
      "2026-08-21T01:02:00.000Z",
      "2026-08-21T01:02:00.000Z",
    );
}

function readIndexedCards(database: Database): EventCard[] {
  return (
    database
      .prepare("SELECT card_json FROM event_cards ORDER BY dedupe_key")
      .all() as Array<{ card_json: string }>
  ).map((row) => JSON.parse(row.card_json) as EventCard);
}

function insertActivity(
  database: Database,
  id: string,
  occurredAtUtc: string,
  summary: string,
): void {
  database
    .prepare(
      `INSERT INTO activity_events(
        id, agent_id, event_type, occurred_at_utc, summary,
        outcome_facts_json, state_delta_json, origin, idempotency_key,
        event_json
      ) VALUES (?, ?, 'completed', ?, ?, '[]', '{}', 'deterministic', ?, '{}')`,
    )
    .run(id, AGENT_ID, occurredAtUtc, summary, `activity:${id}`);
}

function insertMemory(
  database: Database,
  input: {
    id: string;
    content: string;
    namespace: Memory["namespace"];
    certainty: Memory["certainty"];
    attribution: Memory["attribution"];
    temporalStatus: "occurred" | "planned";
    occurredStartAtUtc?: string;
    evidenceSourceId: string;
  },
): void {
  const createdAtUtc = input.occurredStartAtUtc ?? "2026-08-20T09:00:00.000Z";
  const memory = MemorySchema.parse({
    id: input.id,
    agentId: AGENT_ID,
    kind: "episodic",
    content: input.content,
    importance: 0.6,
    confidence: 0.9,
    ...(input.occurredStartAtUtc === undefined
      ? {}
      : { occurredAtUtc: input.occurredStartAtUtc }),
    tags: [],
    sourceMessageIds: [input.evidenceSourceId],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: input.namespace,
    certainty: input.certainty,
    attribution: input.attribution,
    stability: "one_off",
    temporalMetadata:
      input.temporalStatus === "occurred"
        ? {
            occurredStartAtUtc: input.occurredStartAtUtc,
            recordedAtUtc: createdAtUtc,
            temporalCertainty: "exact",
            temporalStatus: "occurred",
          }
        : {
            plannedStartAtUtc: "2026-08-22T09:00:00.000Z",
            recordedAtUtc: createdAtUtc,
            temporalCertainty: "exact",
            temporalStatus: "planned",
          },
    status: "active",
    dedupeKey: `dedupe:${input.id}`,
    createdAtUtc,
    updatedAtUtc: createdAtUtc,
  });
  persistMemory(database, memory);
  database
    .prepare(
      `INSERT INTO memory_evidence(
        id, memory_id, source_type, source_id, quote,
        recorded_at_utc, evidence_json
      ) VALUES (?, ?, 'message', ?, ?, ?, '{}')`,
    )
    .run(
      `evidence_${input.id}`,
      input.id,
      input.evidenceSourceId,
      input.content,
      createdAtUtc,
    );
}

function insertLifecycleMemory(
  database: Database,
  input: {
    id: string;
    content: string;
    createdAtUtc: string;
    claim?: NonNullable<Memory["claim"]>;
  },
): void {
  const memory = MemorySchema.parse({
    id: input.id,
    agentId: AGENT_ID,
    kind: input.claim === undefined ? "episodic" : "commitment",
    content: input.content,
    importance: 0.2,
    confidence: 0.95,
    tags: [],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "situational",
    ...(input.claim === undefined ? {} : { claim: input.claim }),
    status: "active",
    dedupeKey: `dedupe:${input.id}`,
    createdAtUtc: input.createdAtUtc,
    updatedAtUtc: input.createdAtUtc,
  });
  persistMemory(database, memory);
}

function persistMemory(database: Database, memory: Memory): void {
  const temporal = memory.temporalMetadata;
  database
    .prepare(
      `INSERT INTO memories(
        id, agent_id, type, content, tags_json, importance, confidence,
        source_message_id, source_event_id, created_at_utc, valid_until_utc,
        memory_json, namespace, certainty, attribution, stability, status,
        mentioned_at_utc, planned_start_at_utc, planned_end_at_utc,
        occurred_start_at_utc, occurred_end_at_utc, recorded_at_utc,
        temporal_certainty, temporal_status, claim_subject_key,
        claim_disposition, superseded_by_id, merged_into_id,
        last_reinforced_at_utc, lifecycle_updated_at_utc
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?, ?
      )`,
    )
    .run(
      memory.id,
      memory.agentId,
      memory.kind,
      memory.content,
      JSON.stringify(memory.tags),
      memory.importance,
      memory.confidence,
      memory.sourceMessageIds[0] ?? null,
      memory.sourceActivityEventIds[0] ?? null,
      memory.createdAtUtc,
      memory.expiresAtUtc ?? null,
      JSON.stringify(memory),
      memory.namespace ?? "runtime_simulation",
      memory.certainty ?? "uncertain",
      memory.attribution ?? "mixed",
      memory.stability ?? "situational",
      memory.status,
      temporal?.mentionedAtUtc ?? null,
      temporal?.plannedStartAtUtc ?? null,
      temporal?.plannedEndAtUtc ?? null,
      temporal?.occurredStartAtUtc ?? null,
      temporal?.occurredEndAtUtc ?? null,
      temporal?.recordedAtUtc ?? memory.createdAtUtc,
      temporal?.temporalCertainty ?? "unknown",
      temporal?.temporalStatus ?? "unknown",
      memory.claim?.subjectKey ?? null,
      memory.claim?.disposition ?? null,
      memory.supersededById ?? null,
      memory.mergedIntoId ?? null,
      memory.lastReinforcedAtUtc ?? memory.createdAtUtc,
      memory.lifecycleUpdatedAtUtc ?? memory.createdAtUtc,
    );
}

function alphabeticFillerWords(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const high = String.fromCharCode(97 + Math.floor(index / 26));
    const low = String.fromCharCode(97 + (index % 26));
    return "preface" + high + low;
  });
}

function longHanPrefix(length: number): string {
  return Array.from({ length }, (_, index) =>
    String.fromCodePoint(0x4e00 + index),
  ).join("");
}

function toEvidenceRef(
  evidence: VerifiedContinuityEvidence,
): ContinuityEvidenceRef {
  return {
    id: evidence.id,
    sourceType: evidence.sourceType,
    sourceId: evidence.sourceId,
    ...(evidence.quote === undefined ? {} : { quote: evidence.quote }),
    ...(evidence.contextSummary === undefined
      ? {}
      : { contextSummary: evidence.contextSummary }),
    ...(evidence.temporalStatus === undefined
      ? {}
      : { temporalStatus: evidence.temporalStatus }),
    reliability: evidence.reliability,
    recordedAtUtc: evidence.recordedAtUtc,
  };
}
