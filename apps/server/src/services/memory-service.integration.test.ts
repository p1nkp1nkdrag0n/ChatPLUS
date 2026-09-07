import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MemoryCandidateSchema,
  MemorySchema,
  type MemoryCandidate,
} from "@personasim/contracts";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { FakeClock } from "../runtime/clock.js";
import { companionLongRunV3Manifest } from "../scenarios/companion-long-run-v3-manifest.js";
import { deriveServerOwnedUserMemoryCandidates } from "./turn-decision-service.js";
import { ContinuityMemoryRepository } from "./continuity-memory-repository.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import {
  previewAgentMemoryRecall,
  recallAgentMemories,
} from "./memory-recall-service.js";
import {
  readActiveMemoryRecords,
  readMemoryEvidence,
  validateMergeAndPersistMemories,
} from "./memory-service.js";

const AGENT_ID = "agent-memory-integration";
const SESSION_ID = "session-memory-integration";
const MESSAGE_ID = "message-memory-user";
const ACTIVITY_ID = "activity-memory-run";
const NOW = "2026-08-21T12:00:00.000Z";
const MESSAGE_TIME = "2026-08-21T10:00:00.000Z";
const ACTIVITY_TIME = "2026-08-21T11:00:00.000Z";

describe("memory service evidence integration", () => {
  let database: Database;
  let store: DatabaseStore;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    seedSources(database);
    store = new DatabaseStore(database);
  });

  afterEach(() => {
    database.close();
  });

  it.each([
    ["我没有辞职，只是考虑过。", "用户已经辞职。"],
    ["我不是不喜欢父亲，今天只是不想谈。", "用户不喜欢父亲。"],
    ["她说自己准备搬家。", "用户准备搬家。"],
    ["如果拿到录取，我就搬过去。", "用户已经决定搬家。"],
    ["今天我什么人都不想见。", "用户不喜欢社交。"],
    ["我已经通过面试。", "系统独立验证用户已通过面试。"],
  ])(
    "does not persist a model's unsupported interpretation: %s",
    (original, invented) => {
      const messageId = "semantic-source";
      insertMessage(database, messageId, "user", original);
      const memories = validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        nowUtc: NOW,
        maxCandidates: 4,
        authoritativeMessageId: messageId,
        candidates: [stableUserCandidate({ content: invented })],
      });
      expect(memories.some((memory) => memory.content === invented)).toBe(
        false,
      );
      for (const memory of memories.filter((item) =>
        item.tags.includes("source report"),
      )) {
        expect(memory).toMatchObject({
          content: `用户在对话中说过：「${original}」`,
          stability: "one_off",
          temporalMetadata: { temporalStatus: "unknown" },
        });
        expect(memory.claim).toBeUndefined();
        expect(readMemoryEvidence(store, [memory.id])[0]?.quote).toBe(original);
      }
      expect(
        readActiveMemoryRecords(store, AGENT_ID, NOW).some(
          (memory) => memory.content === invented,
        ),
      ).toBe(false);
    },
  );

  it("does not truncate an oversized source into independent memory evidence", () => {
    const original =
      "我已经通过面试。".repeat(250) + "以上是引用朋友的话，我自己没有通过。";
    insertMessage(database, "oversized-source", "user", original);
    const memories = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      nowUtc: NOW,
      maxCandidates: 4,
      authoritativeMessageId: "oversized-source",
      candidates: [stableUserCandidate({ content: "用户已经通过面试。" })],
    });
    expect(memories).toEqual([]);
    expect(
      database
        .prepare("SELECT content FROM messages WHERE id = ?")
        .get("oversized-source"),
    ).toEqual({ content: original });
  });

  it("restores canonical claim disposition and time instead of trusting copied server wording", () => {
    const sourceId = "canonical-forgery-source";
    const original = "我计划每周四晚上画画。";
    insertMessage(database, sourceId, "user", original);
    const canonical = deriveServerOwnedUserMemoryCandidates(original, NOW)[0]!;
    const malicious = {
      ...canonical,
      claim: {
        ...canonical.claim!,
        disposition: "negated" as const,
        revisionIntent: "explicit_correction" as const,
      },
      temporalMetadata: {
        recordedAtUtc: NOW,
        occurredStartAtUtc: NOW,
        temporalCertainty: "exact" as const,
        temporalStatus: "occurred" as const,
      },
      evidence: [
        {
          sourceType: "message" as const,
          sourceId,
          quote: original,
          recordedAtUtc: NOW,
        },
      ],
    };
    const [persisted] = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      nowUtc: NOW,
      maxCandidates: 1,
      candidates: [malicious],
    });
    expect(persisted).toMatchObject({
      content: canonical.content,
      claim: canonical.claim,
      temporalMetadata: { temporalStatus: "planned" },
    });
    expect(persisted?.claim?.revisionIntent).toBeUndefined();
    expect(persisted?.temporalMetadata?.occurredStartAtUtc).toBeUndefined();
  });

  it("adds semantic defaults and persists verified ActivityEvent evidence", () => {
    const persisted = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [
        {
          kind: "episodic",
          content: "Completed the morning run.",
          importance: 0.8,
          confidence: 1,
          occurredAtUtc: ACTIVITY_TIME,
          tags: ["activity_outcome", "running"],
          sourceMessageIds: [],
          sourceActivityEventIds: [ACTIVITY_ID],
          origin: "runtime_simulation",
          reasonCode: "activity_outcome",
          reasonSummary: "A settled activity produced this outcome.",
        },
      ],
      nowUtc: NOW,
      maxCandidates: 1,
      authoritativeActivityEventId: ACTIVITY_ID,
    });

    expect(persisted).toHaveLength(1);
    const memory = persisted[0];
    expect(memory?.namespace).toBe("runtime_simulation");
    expect(memory?.certainty).toBe("explicit");
    expect(memory?.attribution).toBe("simulation_event");
    expect(memory?.stability).toBe("one_off");
    expect(memory?.temporalMetadata?.temporalStatus).toBe("occurred");
    expect(memory?.temporalMetadata?.occurredStartAtUtc).toBe(ACTIVITY_TIME);

    const evidence = readMemoryEvidence(store, [memory?.id ?? "missing"]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.sourceType).toBe("activity_event");
    expect(evidence[0]?.sourceId).toBe(ACTIVITY_ID);

    const row = database
      .prepare(
        [
          "SELECT namespace, certainty, attribution, stability, status,",
          "temporal_status, occurred_start_at_utc",
          "FROM memories WHERE id = ?",
        ].join(" "),
      )
      .get(memory?.id) as Record<string, unknown>;
    expect(row).toMatchObject({
      namespace: "runtime_simulation",
      certainty: "explicit",
      attribution: "simulation_event",
      stability: "one_off",
      status: "active",
      temporal_status: "occurred",
      occurred_start_at_utc: ACTIVITY_TIME,
    });
  });

  it("rejects forged evidence and accepts a grounded stable user fact", () => {
    const forged = stableUserCandidate({
      sourceMessageIds: ["message-not-owned"],
      evidence: [
        {
          sourceType: "message",
          sourceId: "message-not-owned",
          quote: "I am vegetarian.",
          recordedAtUtc: NOW,
        },
      ],
    });
    expect(
      validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [forged],
        nowUtc: NOW,
        maxCandidates: 1,
      }),
    ).toEqual([]);

    const persisted = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [stableUserCandidate()],
      nowUtc: NOW,
      maxCandidates: 1,
      authoritativeMessageId: MESSAGE_ID,
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.namespace).toBe("user_model");
    expect(persisted[0]?.stability).toBe("stable");
    expect(readMemoryEvidence(store, [persisted[0]?.id ?? "missing"])).toEqual([
      expect.objectContaining({
        sourceType: "message",
        sourceId: MESSAGE_ID,
        quote: "I am vegetarian and prefer simple meals.",
      }),
    ]);
  });

  it("keeps the complete authoritative user quote over a model-proposed excerpt", () => {
    const [persisted] = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [
        stableUserCandidate({
          evidence: [
            {
              sourceType: "message",
              sourceId: MESSAGE_ID,
              quote: "I am vegetarian.",
              recordedAtUtc: NOW,
            },
          ],
        }),
      ],
      nowUtc: NOW,
      maxCandidates: 1,
      authoritativeMessageId: MESSAGE_ID,
    });

    expect(persisted).toBeDefined();
    expect(readMemoryEvidence(store, [persisted?.id ?? "missing"])).toEqual([
      expect.objectContaining({
        sourceType: "message",
        sourceId: MESSAGE_ID,
        quote: "I am vegetarian and prefer simple meals.",
      }),
    ]);
  });

  it("structures and supersedes an explicit correction to a short user fact", () => {
    const firstMessageId = "message-memory-xiaolin-old";
    insertMessage(database, firstMessageId, "user", "小林是我大学同学");
    const [first] = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [
        stableUserCandidate({
          content: "小林是我大学同学",
          tags: ["user_fact", "小林"],
        }),
      ],
      nowUtc: NOW,
      maxCandidates: 1,
      authoritativeMessageId: firstMessageId,
    });
    expect(first?.claim).toMatchObject({
      subjectKey: "user_fact:relationship:小林",
      disposition: "affirmed",
    });

    const correctedAt = "2026-08-21T12:01:00.000Z";
    const correctedMessageId = "message-memory-xiaolin-corrected";
    insertMessage(
      database,
      correctedMessageId,
      "user",
      "更正：小林是我高中同学",
    );
    const [corrected] = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [
        stableUserCandidate({
          content: "小林是我高中同学",
          tags: ["user_fact", "小林"],
        }),
      ],
      nowUtc: correctedAt,
      maxCandidates: 1,
      authoritativeMessageId: correctedMessageId,
    });
    expect(corrected?.id).not.toBe(first?.id);
    expect(corrected?.claim).toEqual({
      subjectKey: "user_fact:relationship:小林",
      disposition: "affirmed",
      recordedAtUtc: correctedAt,
      revisionIntent: "explicit_correction",
    });

    const lifecycle = new MemoryLifecycleService(
      new ContinuityMemoryRepository(store),
      new FakeClock(correctedAt),
    );
    const results = lifecycle.reconcileNewMemories(AGENT_ID, [
      corrected?.id ?? "missing",
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.reconciliation).toMatchObject({
      kind: "supersede",
      reasonCode: "explicit_user_correction",
    });

    const rows = database
      .prepare(
        `SELECT id, status, superseded_by_id AS supersededById
         FROM memories WHERE id IN (?, ?) ORDER BY id`,
      )
      .all(first?.id, corrected?.id) as Array<Record<string, unknown>>;
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first?.id,
          status: "superseded",
          supersededById: corrected?.id,
        }),
        expect.objectContaining({
          id: corrected?.id,
          status: "active",
        }),
      ]),
    );
    expect(
      readMemoryEvidence(store, [first?.id ?? "", corrected?.id ?? ""]),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sourceId: firstMessageId }),
        expect.objectContaining({ sourceId: correctedMessageId }),
      ]),
    );
  });

  it("persists and reconciles an activity-specific weekly correction without claiming execution", () => {
    const firstId = "message-weekly-initial";
    insertMessage(
      database,
      firstId,
      "user",
      "我计划每周四晚上画画。我计划每周六上午游泳。",
    );
    const originals = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [],
      nowUtc: NOW,
      maxCandidates: 4,
      authoritativeMessageId: firstId,
    });
    const original = originals.find(
      (memory) => memory.claim?.subjectKey === "user_fact:weekly_plan:画画",
    );
    const otherActivity = originals.find(
      (memory) => memory.claim?.subjectKey === "user_fact:weekly_plan:游泳",
    );
    expect(original).toBeDefined();
    expect(otherActivity).toBeDefined();

    const correctionId = "message-weekly-correction";
    const correctedAt = offsetNow(1);
    insertMessage(
      database,
      correctionId,
      "user",
      "早啊。你昨晚休息了吗？留给画画的时间其实定在每周二晚上，不是周四。只是还没真正稳定执行。你今天忙吗？",
    );
    const [corrected] = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [],
      nowUtc: correctedAt,
      maxCandidates: 4,
      authoritativeMessageId: correctionId,
    });
    expect(corrected?.id).not.toBe(original?.id);
    expect(corrected?.claim).toEqual({
      subjectKey: "user_fact:weekly_plan:画画",
      disposition: "affirmed",
      recordedAtUtc: correctedAt,
      revisionIntent: "explicit_correction",
    });
    expect(corrected?.temporalMetadata?.temporalStatus).toBe("planned");
    expect(corrected?.occurredAtUtc).toBeUndefined();
    const lifecycle = new MemoryLifecycleService(
      new ContinuityMemoryRepository(store),
      new FakeClock(correctedAt),
    );
    expect(
      lifecycle.reconcileNewMemories(AGENT_ID, [corrected!.id])[0]
        ?.reconciliation.kind,
    ).toBe("supersede");
    const repository = new ContinuityMemoryRepository(store);
    expect(repository.getLifecycleMemory(original!.id)?.memory).toMatchObject({
      status: "superseded",
      supersededById: corrected!.id,
    });
    expect(
      repository.getLifecycleMemory(otherActivity!.id)?.memory.status,
    ).toBe("active");
    expect(
      readMemoryEvidence(store, [original!.id, corrected!.id]).map(
        (evidence) => evidence.sourceId,
      ),
    ).toEqual(expect.arrayContaining([firstId, correctionId]));
    const beforeConflicts = database
      .prepare("SELECT COUNT(*) AS count FROM memory_conflicts")
      .get();
    lifecycle.reconcileNewMemories(AGENT_ID, [corrected!.id]);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memory_conflicts").get(),
    ).toEqual(beforeConflicts);
  });

  it("does not grant another topic a weekly correction's authority", () => {
    const sourceId = "message-weekly-other-topic";
    insertMessage(
      database,
      sourceId,
      "user",
      "画画的时间改到每周二晚上。我计划每周六上午游泳。护照放在玄关柜的抽屉里。",
    );
    const memories = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [],
      nowUtc: NOW,
      maxCandidates: 5,
      authoritativeMessageId: sourceId,
    });
    expect(
      memories.find(
        (memory) => memory.claim?.subjectKey === "user_fact:weekly_plan:画画",
      )?.claim?.revisionIntent,
    ).toBe("explicit_correction");
    for (const subjectKey of [
      "user_fact:weekly_plan:游泳",
      "user_fact:item:护照:storage",
    ]) {
      const memory = memories.find(
        (item) => item.claim?.subjectKey === subjectKey,
      );
      expect(memory, subjectKey).toBeDefined();
      expect(memory?.claim?.revisionIntent, subjectKey).toBeUndefined();
    }
  });

  it("rejects a forged weekly slot or execution status despite a real user source", () => {
    const sourceId = "message-weekly-proposal-source";
    insertMessage(database, sourceId, "user", "我计划每周四晚上画画。");
    for (const overrides of [
      {
        namespace: "canon" as const,
        claim: {
          subjectKey: "user_fact:weekly_plan:画画",
          disposition: "affirmed" as const,
          recordedAtUtc: NOW,
        },
      },
      {
        claim: {
          subjectKey: "user_fact:weekly_plan:游泳",
          disposition: "affirmed" as const,
          recordedAtUtc: NOW,
          revisionIntent: "explicit_correction" as const,
        },
      },
      {
        temporalMetadata: {
          recordedAtUtc: NOW,
          occurredStartAtUtc: NOW,
          temporalCertainty: "exact" as const,
          temporalStatus: "occurred" as const,
        },
      },
    ]) {
      const result = validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [
          stableUserCandidate({
            content: "用户将画画的时间安排在每周四晚上。",
            tags: ["user_fact", "weekly_plan"],
            sourceMessageIds: [sourceId],
            ...overrides,
          }),
        ],
        nowUtc: NOW,
        maxCandidates: 3,
      });
      expect(result).toEqual([]);
    }
  });

  it("rejects a mixed weekly candidate while splitting a multi-activity user source into atomic memories", () => {
    const sourceId = "message-weekly-atomic";
    insertMessage(
      database,
      sourceId,
      "user",
      "画画的时间改到每周二晚上。我计划每周六上午游泳。",
    );
    for (const content of [
      "用户将画画时间安排在每周二晚上。用户将游泳时间安排在每周五下午。",
      "用户将画画时间安排在每周二晚上。用户将游泳时间安排在每周六上午。",
    ]) {
      expect(
        validateMergeAndPersistMemories({
          store,
          agentId: AGENT_ID,
          candidates: [
            stableUserCandidate({
              content,
              sourceMessageIds: [sourceId],
              tags: ["user_fact", "weekly_plan"],
            }),
          ],
          nowUtc: NOW,
          maxCandidates: 4,
        }),
      ).toEqual([]);
    }
    expect(
      validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [],
        authoritativeMessageId: sourceId,
        nowUtc: NOW,
        maxCandidates: 4,
      }).map((memory) => memory.claim?.subjectKey),
    ).toEqual(["user_fact:weekly_plan:画画", "user_fact:weekly_plan:游泳"]);
  });

  it("lazily aligns only the corrected legacy activity from original evidence and preserves its history", () => {
    const old = createLegacyWeeklyMemory(
      database,
      store,
      "legacy-drawing",
      "我计划每周四晚上画画。",
    );
    const other = createLegacyWeeklyMemory(
      database,
      store,
      "legacy-swimming",
      "我计划每周六上午游泳。",
    );
    const repository = new ContinuityMemoryRepository(store);
    const original = repository.getLifecycleMemory(old.id)!.memory;
    const originalEvidence = readMemoryEvidence(store, [old.id]);
    expect(original.claim).toBeUndefined();
    const correction = createWeeklyCorrection(database, store);
    const lifecycle = new MemoryLifecycleService(
      repository,
      new FakeClock(offsetNow(1)),
    );
    lifecycle.maintainAgent(AGENT_ID);
    expect(repository.getLifecycleMemory(old.id)?.memory.claim).toBeUndefined();
    expect(
      lifecycle.reconcileNewMemories(AGENT_ID, [correction.id])[0]
        ?.reconciliation.kind,
    ).toBe("supersede");
    const aligned = repository.getLifecycleMemory(old.id)!.memory;
    expect(aligned).toMatchObject({
      id: old.id,
      content: original.content,
      createdAtUtc: original.createdAtUtc,
      sourceMessageIds: original.sourceMessageIds,
      claim: {
        subjectKey: "user_fact:weekly_plan:画画",
        recordedAtUtc: original.createdAtUtc,
      },
      status: "superseded",
      supersededById: correction.id,
    });
    expect(aligned.temporalMetadata).toEqual(original.temporalMetadata);
    expect(readMemoryEvidence(store, [old.id])).toEqual(originalEvidence);
    expect(repository.getLifecycleMemory(other.id)?.memory).toMatchObject({
      status: "active",
    });
    expect(
      repository.getLifecycleMemory(other.id)?.memory.claim,
    ).toBeUndefined();
    const events = database
      .prepare(
        "SELECT payload_json FROM domain_events WHERE event_type = 'memory.claim.legacy_aligned'",
      )
      .all() as Array<{ payload_json: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload_json)).toMatchObject({
      memoryId: old.id,
      sourceMessageId: old.sourceId,
      sourceEvidenceId: originalEvidence[0]?.id,
      correctionMemoryId: correction.id,
    });
    lifecycle.reconcileNewMemories(AGENT_ID, [correction.id]);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'memory.claim.legacy_aligned'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM memory_conflicts").get(),
    ).toEqual({ count: 1 });
  });

  it.each([
    "question",
    "quotation",
    "summary_only",
    "missing_source",
    "forged_quote",
    "unrelated_quote",
    "assistant_source",
    "foreign_agent",
    "future_source",
    "future_memory",
    "inferred_memory",
  ] as const)("does not align unsupported legacy evidence: %s", (scenario) => {
    const old = createLegacyWeeklyMemory(
      database,
      store,
      `legacy-${scenario}`,
      "我计划每周四晚上画画。",
    );
    if (
      scenario === "question" ||
      scenario === "quotation" ||
      scenario === "summary_only"
    ) {
      const content =
        scenario === "question"
          ? "我在想，能不能把画画时间定在每周四晚上？"
          : scenario === "quotation"
            ? "朋友说：我计划每周四晚上画画。"
            : "我的护照放在抽屉里。";
      database
        .prepare("UPDATE messages SET content = ? WHERE id = ?")
        .run(content, old.sourceId);
      database
        .prepare("UPDATE memory_evidence SET quote = ? WHERE memory_id = ?")
        .run(content, old.id);
    } else if (scenario === "missing_source") {
      database
        .prepare(
          "UPDATE memory_evidence SET source_id = 'missing-user-source' WHERE memory_id = ?",
        )
        .run(old.id);
    } else if (scenario === "forged_quote" || scenario === "unrelated_quote") {
      database
        .prepare("UPDATE memory_evidence SET quote = ? WHERE memory_id = ?")
        .run(
          scenario === "forged_quote" ? "我计划每周二晚上画画。" : "每周四",
          old.id,
        );
    } else if (scenario === "assistant_source") {
      database
        .prepare(
          "UPDATE messages SET role = 'assistant', message_kind = 'assistant_reply' WHERE id = ?",
        )
        .run(old.sourceId);
    } else if (scenario === "foreign_agent") {
      database
        .prepare(
          "INSERT INTO characters(id, current_version, status, tier, name, source_type, created_at_utc, updated_at_utc) VALUES ('agent-foreign-weekly', 1, 'published', 'daily', 'Foreign', 'original', ?, ?)",
        )
        .run(NOW, NOW);
      database
        .prepare(
          "UPDATE messages SET agent_id = 'agent-foreign-weekly' WHERE id = ?",
        )
        .run(old.sourceId);
    } else if (scenario === "future_source") {
      database
        .prepare("UPDATE messages SET created_at_utc = ? WHERE id = ?")
        .run(offsetNow(10), old.sourceId);
    } else if (scenario === "future_memory") {
      database
        .prepare("UPDATE memories SET created_at_utc = ? WHERE id = ?")
        .run(offsetNow(10), old.id);
    } else {
      database
        .prepare(
          "UPDATE memories SET attribution = 'model_inference', certainty = 'inferred' WHERE id = ?",
        )
        .run(old.id);
    }
    const correction = createWeeklyCorrection(database, store);
    const repository = new ContinuityMemoryRepository(store);
    const lifecycle = new MemoryLifecycleService(
      repository,
      new FakeClock(offsetNow(1)),
    );
    expect(lifecycle.reconcileNewMemories(AGENT_ID, [correction.id])).toEqual(
      [],
    );
    expect(repository.getLifecycleMemory(old.id)?.memory.claim).toBeUndefined();
    expect(repository.getLifecycleMemory(old.id)?.memory.status).toBe("active");
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'memory.claim.legacy_aligned'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("does not align legacy data without a verified new correction", () => {
    const old = createLegacyWeeklyMemory(
      database,
      store,
      "legacy-no-correction",
      "我计划每周四晚上画画。",
    );
    const correction = createWeeklyCorrection(database, store);
    database
      .prepare(
        "UPDATE messages SET content = '我计划每周二晚上画画。' WHERE id = ?",
      )
      .run(correction.sourceMessageIds[0]);
    database
      .prepare(
        "UPDATE memory_evidence SET quote = '我计划每周二晚上画画。' WHERE memory_id = ?",
      )
      .run(correction.id);
    const repository = new ContinuityMemoryRepository(store);
    expect(
      new MemoryLifecycleService(
        repository,
        new FakeClock(offsetNow(1)),
      ).reconcileNewMemories(AGENT_ID, [correction.id]),
    ).toEqual([]);
    expect(repository.getLifecycleMemory(old.id)?.memory.claim).toBeUndefined();
  });

  it("persists every reviewed v3 fact from authoritative user evidence", () => {
    for (const candidateNumber of [12, 13, 15, 16, 17, 37, 38, 39, 40, 41]) {
      const messageId = `message-v3-${candidateNumber}`;
      insertMessage(database, messageId, "user", manifestText(candidateNumber));
      const persisted = validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [],
        nowUtc: offsetNow(candidateNumber),
        maxCandidates: 4,
        authoritativeMessageId: messageId,
      });

      expect(persisted.length, `T${candidateNumber}`).toBeGreaterThanOrEqual(1);
      for (const memory of persisted) {
        expect(
          memory.sourceMessageIds,
          `T${candidateNumber}:${memory.id}`,
        ).toEqual([messageId]);
        expect(readMemoryEvidence(store, [memory.id])).toEqual([
          expect.objectContaining({
            memoryId: memory.id,
            sourceType: "message",
            sourceId: messageId,
            quote: manifestText(candidateNumber),
          }),
        ]);
      }
    }
  });

  it("supersedes the notebook, deadline, and friend destination with evidence-bound corrections", () => {
    const corrections = [
      {
        initialTurn: 13,
        correctionTurn: 14,
        subjectKey: "user_fact:item:notes:storage",
        oldFragment: "绿色",
        newFragment: "藏青色",
      },
      {
        initialTurn: 38,
        correctionTurn: 42,
        subjectKey: "user_fact:deadline:山鸣影像:reply",
        oldFragment: "9月14日",
        newFragment: "9月16日",
      },
      {
        initialTurn: 15,
        correctionTurn: 99,
        subjectKey: "user_fact:person:许宁:destination",
        oldFragment: "重庆",
        newFragment: "成都",
      },
    ] as const;

    const lifecycle = new MemoryLifecycleService(
      new ContinuityMemoryRepository(store),
      new FakeClock(offsetNow(200)),
    );
    for (const item of corrections) {
      const initialMessageId = `message-v3-${item.initialTurn}`;
      insertMessage(
        database,
        initialMessageId,
        "user",
        manifestText(item.initialTurn),
      );
      const initial = validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [],
        nowUtc: offsetNow(item.initialTurn),
        maxCandidates: 4,
        authoritativeMessageId: initialMessageId,
      }).find((memory) => memory.claim?.subjectKey === item.subjectKey);
      expect(initial, `T${item.initialTurn}`).toBeDefined();
      expect(initial?.content).toContain(item.oldFragment);

      const correctionMessageId = `message-v3-${item.correctionTurn}`;
      insertMessage(
        database,
        correctionMessageId,
        "user",
        manifestText(item.correctionTurn),
      );
      const corrected = validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [],
        nowUtc: offsetNow(item.correctionTurn),
        maxCandidates: 4,
        authoritativeMessageId: correctionMessageId,
      }).find((memory) => memory.claim?.subjectKey === item.subjectKey);
      expect(corrected, `T${item.correctionTurn}`).toBeDefined();
      expect(corrected?.id).not.toBe(initial?.id);
      expect(corrected?.content).toContain(item.newFragment);
      expect(corrected?.claim?.revisionIntent, item.subjectKey).toBe(
        "explicit_correction",
      );

      const reconciled = lifecycle.reconcileNewMemories(AGENT_ID, [
        corrected?.id ?? "missing",
      ]);
      expect(reconciled).toHaveLength(1);
      expect(reconciled[0]?.reconciliation).toMatchObject({
        kind: "supersede",
        reasonCode: "explicit_user_correction",
      });

      const rows = database
        .prepare(
          `SELECT id, content, status, superseded_by_id AS supersededById
           FROM memories WHERE agent_id = ? AND claim_subject_key = ?
           ORDER BY rowid`,
        )
        .all(AGENT_ID, item.subjectKey) as Array<Record<string, unknown>>;
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: initial?.id,
            status: "superseded",
            supersededById: corrected?.id,
          }),
          expect.objectContaining({
            id: corrected?.id,
            status: "active",
          }),
        ]),
      );
      expect(readMemoryEvidence(store, [corrected?.id ?? "missing"])).toEqual([
        expect.objectContaining({ sourceId: correctionMessageId }),
      ]);
    }
  });

  it("rejects model-proposed memories on reviewed unknown and unfinished-plan turns", () => {
    for (const candidateNumber of [18, 19, 23, 102, 103, 104]) {
      const messageId = `message-v3-unsupported-${candidateNumber}`;
      insertMessage(database, messageId, "user", manifestText(candidateNumber));
      const persisted = validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [
          stableUserCandidate({
            kind: candidateNumber === 23 ? "semantic" : "episodic",
            content:
              candidateNumber === 23
                ? "用户已经整理完采访笔记。"
                : "用户确认这件未知或共同事件已经发生。",
            tags:
              candidateNumber === 23
                ? ["user_fact", "activity_outcome"]
                : ["shared_experience"],
            namespace:
              candidateNumber === 23 ? "user_model" : "shared_relationship",
            attribution: "user_explicit",
            temporalMetadata: {
              occurredStartAtUtc: offsetNow(candidateNumber),
              recordedAtUtc: offsetNow(candidateNumber),
              temporalCertainty: "approximate",
              temporalStatus: "occurred",
            },
          }),
        ],
        nowUtc: offsetNow(candidateNumber),
        maxCandidates: 4,
        authoritativeMessageId: messageId,
      });
      expect(persisted, `T${candidateNumber}`).toEqual([]);
    }
  });

  it("does not promote an unverified causal accusation into fact and persists the later ownership correction", () => {
    const accusationMessageId = "message-v3-causal-accusation";
    insertMessage(database, accusationMessageId, "user", manifestText(93));
    const poisonedCandidate = stableUserCandidate({
      content: "用户一直后悔被角色强迫辞职，角色应为用户辞职的行动负责。",
      tags: ["user_fact", "causal_attribution", "coercion"],
      reasonCode: "model_causal_summary",
      reasonSummary:
        "The model converted the current accusation into a durable fact.",
    });
    expect(
      validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [poisonedCandidate],
        nowUtc: offsetNow(93),
        maxCandidates: 4,
        authoritativeMessageId: accusationMessageId,
      }),
    ).toEqual([]);

    const correctionMessageId = "message-v3-causal-correction";
    insertMessage(database, correctionMessageId, "user", manifestText(94));
    const corrected = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [poisonedCandidate],
      nowUtc: offsetNow(94),
      maxCandidates: 4,
      authoritativeMessageId: correctionMessageId,
    });
    expect(corrected).toHaveLength(1);
    expect(corrected[0]).toMatchObject({
      kind: "relationship",
      namespace: "shared_relationship",
      certainty: "explicit",
      attribution: "mixed",
      content:
        "责任更正：用户明确说明曾授权角色作出选择，之后由用户自己执行行动；建议、决定与行动的责任必须分开记录。",
      claim: {
        subjectKey: "relationship:causality:decision_and_action_ownership",
        disposition: "affirmed",
        revisionIntent: "explicit_correction",
      },
    });
    expect(corrected[0]?.tags).toEqual(
      expect.arrayContaining([
        "relationship causal correction",
        "episode decision responsibility",
        "subject shared",
        "actor user",
      ]),
    );
    expect(readMemoryEvidence(store, [corrected[0]?.id ?? "missing"])).toEqual([
      expect.objectContaining({
        sourceType: "message",
        sourceId: correctionMessageId,
        quote: manifestText(94),
      }),
    ]);
  });

  it("does not promote speculative third-party consent into an explicit stable memory", () => {
    const messageId = "message-speculative-consent";
    const userText = "姨妈也许愿意让我单独看修复稿。";
    insertMessage(database, messageId, "user", userText);

    const persisted = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [
        stableUserCandidate({
          content: "姨妈愿意让用户单独看修复稿。",
          tags: ["user_fact", "third_party_consent"],
          reasonCode: "model_consent_summary",
          reasonSummary:
            "The model incorrectly upgraded possible consent to granted consent.",
        }),
        stableUserCandidate({
          content: "姨妈已经授权用户公开和转发修复稿。",
          tags: ["user_fact", "third_party_consent", "scope_expansion"],
          reasonCode: "model_consent_scope_expansion",
          reasonSummary:
            "The model expanded a possible private view into publication and forwarding.",
        }),
      ],
      nowUtc: NOW,
      maxCandidates: 4,
      authoritativeMessageId: messageId,
    });

    expect(persisted).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM memories WHERE agent_id = ? AND content LIKE '%修复稿%'",
        )
        .get(AGENT_ID),
    ).toEqual({ count: 0 });
  });

  it("does not treat a third-party consent question as memory evidence", () => {
    const messageId = "message-consent-question";
    insertMessage(database, messageId, "user", "姨妈愿意让我看修复稿吗？");

    const persisted = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [
        stableUserCandidate({
          content: "姨妈已经授权用户查看修复稿。",
          tags: ["user_fact", "third_party_consent"],
        }),
      ],
      nowUtc: NOW,
      maxCandidates: 4,
      authoritativeMessageId: messageId,
    });

    expect(persisted).toEqual([]);
  });

  it("keeps an unrelated explicit fact from a mixed speculative-consent turn", () => {
    const messageId = "message-mixed-speculative-consent";
    const userText = "姨妈也许愿意让我单独看修复稿；我最近很喜欢在阳台画画。";
    insertMessage(database, messageId, "user", userText);

    const persisted = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [
        stableUserCandidate({
          content: "姨妈已经授权用户单独看修复稿。",
          tags: ["user_fact", "third_party_consent"],
        }),
        stableUserCandidate({
          content: "我最近很喜欢在阳台画画。",
          tags: ["user_preference", "drawing"],
        }),
      ],
      nowUtc: NOW,
      maxCandidates: 4,
      authoritativeMessageId: messageId,
    });

    expect(
      persisted.some((memory) => memory.content.includes("阳台画画")),
    ).toBe(true);
    expect(
      persisted.some((memory) => memory.content.includes("姨妈已经授权")),
    ).toBe(false);
    expect(persisted[0]).toMatchObject({
      content: `用户在对话中说过：「${userText}」`,
      stability: "one_off",
      tags: ["source report"],
      temporalMetadata: { temporalStatus: "unknown" },
    });
  });

  it("rejects runtime and system context that lacks content-grounded formal evidence", () => {
    const runtimeCandidate = stableUserCandidate({
      content: "The character's current energy is low.",
      tags: ["runtime", "energy"],
      namespace: "runtime_simulation",
      certainty: "inferred",
      attribution: "model_inference",
      stability: "situational",
      reasonCode: "runtime_state_context",
      reasonSummary: "Derived only from runtime state context.",
    });
    expect(
      validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [runtimeCandidate],
        nowUtc: NOW,
        maxCandidates: 1,
        authoritativeMessageId: MESSAGE_ID,
      }),
    ).toEqual([]);

    const systemMessageId = "message-memory-system";
    insertMessage(
      database,
      systemMessageId,
      "system",
      "The character's current energy is low.",
    );
    const systemCandidate = MemoryCandidateSchema.parse({
      ...runtimeCandidate,
      namespace: "character_self",
      certainty: "explicit",
      attribution: "character_decision",
      evidence: [
        {
          sourceType: "message",
          sourceId: systemMessageId,
          quote: "The character's current energy is low.",
          recordedAtUtc: NOW,
        },
      ],
    });
    expect(
      validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [systemCandidate],
        nowUtc: NOW,
        maxCandidates: 1,
      }),
    ).toEqual([]);

    expect(
      recallAgentMemories(store, {
        agentId: AGENT_ID,
        query: "current energy",
        nowUtc: NOW,
      }),
    ).toMatchObject({ mode: "none", abstained: true });
  });

  it("requires an actual shared event or occurred shared-message source", () => {
    const nonEventMessageId = "message-memory-fireworks-opinion";
    insertMessage(
      database,
      nonEventMessageId,
      "user",
      "I love colorful fireworks.",
    );
    expect(
      validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [sharedExperienceCandidate()],
        nowUtc: NOW,
        maxCandidates: 1,
        authoritativeMessageId: nonEventMessageId,
      }),
    ).toEqual([]);

    const sharedMessageId = "message-memory-fireworks-shared";
    insertMessage(
      database,
      sharedMessageId,
      "user",
      "We watched colorful fireworks together yesterday.",
    );
    const persisted = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [sharedExperienceCandidate()],
      nowUtc: NOW,
      maxCandidates: 1,
      authoritativeMessageId: sharedMessageId,
    });

    expect(persisted).toHaveLength(1);
    expect(readMemoryEvidence(store, [persisted[0]?.id ?? "missing"])).toEqual([
      expect.objectContaining({
        sourceType: "message",
        sourceId: sharedMessageId,
      }),
    ]);
  });

  it("recalls only active verified evidence and exposes a preview", () => {
    const [active] = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [stableUserCandidate()],
      nowUtc: NOW,
      maxCandidates: 1,
      authoritativeMessageId: MESSAGE_ID,
    });
    expect(active).toBeDefined();
    insertNeedsReviewMemory(database);

    const activeRecords = readActiveMemoryRecords(store, AGENT_ID, NOW, 20);
    expect(activeRecords.map((memory) => memory.id)).toEqual([active?.id]);

    const result = recallAgentMemories(store, {
      agentId: AGENT_ID,
      query: "vegetarian meals",
      nowUtc: NOW,
    });
    expect(result.abstained).toBe(false);
    if (!result.abstained) {
      expect(result.mode).toBe("verbatim_quote");
      expect(result.selectedMemoryIds).toEqual([active?.id]);
      expect(result.evidenceBundle.evidence).toHaveLength(1);
    }

    const preview = previewAgentMemoryRecall(store, {
      agentId: AGENT_ID,
      query: "vegetarian meals",
      nowUtc: NOW,
    });
    expect(preview.candidateCount).toBe(1);
    expect(preview.evidenceCount).toBe(1);
    expect(preview.candidates).toEqual([
      expect.objectContaining({
        memoryId: active?.id,
        selected: true,
      }),
    ]);
  });
});

function stableUserCandidate(
  overrides: Partial<MemoryCandidate> = {},
): MemoryCandidate {
  return MemoryCandidateSchema.parse({
    kind: "semantic",
    content: "I am vegetarian and prefer simple meals.",
    importance: 0.9,
    confidence: 1,
    tags: ["diet", "vegetarian"],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "stable",
    temporalMetadata: {
      mentionedAtUtc: MESSAGE_TIME,
      recordedAtUtc: NOW,
      temporalCertainty: "exact",
      temporalStatus: "unknown",
    },
    evidence: [],
    shouldWrite: true,
    forbiddenOverclaims: [],
    reasonCode: "stable_user_preference",
    reasonSummary: "The user stated this directly.",
    ...overrides,
  });
}

function createLegacyWeeklyMemory(
  database: Database,
  store: DatabaseStore,
  sourceId: string,
  content: string,
) {
  insertMessage(database, sourceId, "user", content);
  const [memory] = validateMergeAndPersistMemories({
    store,
    agentId: AGENT_ID,
    candidates: [],
    authoritativeMessageId: sourceId,
    nowUtc: NOW,
    maxCandidates: 1,
  });
  if (memory === undefined)
    throw new Error(
      "Expected a sourced weekly memory in the isolated fixture.",
    );
  // Simulate the old schema projection in this test database, preserving the
  // actual source message and evidence instead of seeding an unsupported claim.
  database
    .prepare(
      "UPDATE memories SET claim_subject_key = NULL, claim_disposition = NULL, memory_json = json_remove(memory_json, '$.claim') WHERE id = ?",
    )
    .run(memory.id);
  return { id: memory.id, sourceId };
}

function createWeeklyCorrection(database: Database, store: DatabaseStore) {
  const sourceId = "message-legacy-weekly-correction";
  insertMessage(database, sourceId, "user", "画画的时间改到每周二晚上。");
  const [memory] = validateMergeAndPersistMemories({
    store,
    agentId: AGENT_ID,
    candidates: [],
    authoritativeMessageId: sourceId,
    nowUtc: offsetNow(1),
    maxCandidates: 1,
  });
  if (memory === undefined)
    throw new Error(
      "Expected a sourced weekly correction in the isolated fixture.",
    );
  return memory;
}

function sharedExperienceCandidate(): MemoryCandidate {
  return MemoryCandidateSchema.parse({
    kind: "episodic",
    content: "We watched colorful fireworks together yesterday.",
    importance: 0.8,
    confidence: 0.95,
    tags: ["shared_experience", "fireworks"],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "shared_relationship",
    certainty: "explicit",
    attribution: "mixed",
    stability: "one_off",
    temporalMetadata: {
      occurredStartAtUtc: MESSAGE_TIME,
      recordedAtUtc: NOW,
      temporalCertainty: "approximate",
      temporalStatus: "occurred",
    },
    evidence: [],
    shouldWrite: true,
    forbiddenOverclaims: [],
    reasonCode: "shared_experience",
    reasonSummary: "A visible source described an occurred shared event.",
  });
}

function insertMessage(
  database: Database,
  id: string,
  role: "user" | "assistant" | "system",
  content: string,
): void {
  database
    .prepare(
      "INSERT INTO messages(id, session_id, agent_id, role, content, message_kind, metadata_json, created_at_utc) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)",
    )
    .run(
      id,
      SESSION_ID,
      AGENT_ID,
      role,
      content,
      role === "user" ? "user" : "assistant_reply",
      MESSAGE_TIME,
    );
}

function manifestText(candidateNumber: number): string {
  const turn = companionLongRunV3Manifest.sharedTurns[candidateNumber - 1];
  if (turn === undefined || typeof turn.userText !== "string") {
    throw new Error(`T${candidateNumber} does not have a literal user input.`);
  }
  return turn.userText;
}

function offsetNow(minutes: number): string {
  return new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
}

function seedSources(database: Database): void {
  database
    .prepare(
      [
        "INSERT INTO characters(",
        "id, current_version, status, tier, name, source_type,",
        "created_at_utc, updated_at_utc",
        ") VALUES (?, 1, 'published', 'daily', ?, 'original', ?, ?)",
      ].join(" "),
    )
    .run(AGENT_ID, "Memory Test Agent", MESSAGE_TIME, MESSAGE_TIME);
  database
    .prepare(
      [
        "INSERT INTO sessions(",
        "id, agent_id, title, created_at_utc, updated_at_utc",
        ") VALUES (?, ?, ?, ?, ?)",
      ].join(" "),
    )
    .run(
      SESSION_ID,
      AGENT_ID,
      "Memory integration",
      MESSAGE_TIME,
      MESSAGE_TIME,
    );
  database
    .prepare(
      [
        "INSERT INTO messages(",
        "id, session_id, agent_id, role, content, message_kind,",
        "metadata_json, created_at_utc",
        ") VALUES (?, ?, ?, 'user', ?, 'user', '{}', ?)",
      ].join(" "),
    )
    .run(
      MESSAGE_ID,
      SESSION_ID,
      AGENT_ID,
      "I am vegetarian and prefer simple meals.",
      MESSAGE_TIME,
    );
  database
    .prepare(
      [
        "INSERT INTO activity_events(",
        "id, agent_id, event_type, occurred_at_utc, summary,",
        "outcome_facts_json, state_delta_json, origin,",
        "idempotency_key, event_json",
        ") VALUES (?, ?, 'completed', ?, ?, '[]', '{}',",
        "'deterministic', ?, '{}')",
      ].join(" "),
    )
    .run(
      ACTIVITY_ID,
      AGENT_ID,
      ACTIVITY_TIME,
      "Completed the morning run.",
      "memory-integration-activity",
    );
}

function insertNeedsReviewMemory(database: Database): void {
  const memory = MemorySchema.parse({
    id: "memory-needs-review",
    agentId: AGENT_ID,
    kind: "semantic",
    content: "Unverified vegetarian rumor.",
    importance: 1,
    confidence: 1,
    tags: ["vegetarian"],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "model_inference",
    namespace: "user_model",
    certainty: "uncertain",
    attribution: "model_inference",
    stability: "stable",
    temporalMetadata: {
      recordedAtUtc: NOW,
      temporalCertainty: "unknown",
      temporalStatus: "unknown",
    },
    status: "needs_review",
    dedupeKey: "needs-review-key",
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  });
  database
    .prepare(
      [
        "INSERT INTO memories(",
        "id, agent_id, type, content, tags_json, importance, confidence,",
        "created_at_utc, memory_json, namespace, certainty, attribution,",
        "stability, status, recorded_at_utc, temporal_certainty, temporal_status",
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" "),
    )
    .run(
      memory.id,
      memory.agentId,
      memory.kind,
      memory.content,
      JSON.stringify(memory.tags),
      memory.importance,
      memory.confidence,
      memory.createdAtUtc,
      JSON.stringify(memory),
      memory.namespace,
      memory.certainty,
      memory.attribution,
      memory.stability,
      memory.status,
      memory.temporalMetadata?.recordedAtUtc,
      memory.temporalMetadata?.temporalCertainty,
      memory.temporalMetadata?.temporalStatus,
    );
}
