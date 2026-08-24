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
import { ContinuityMemoryRepository } from "./continuity-memory-repository.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import {
  previewAgentMemoryRecall,
  recallAgentMemories,
} from "./memory-recall-service.js";
import {
  preflightMemoryCandidates,
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

  it("preflights a pending turn message with the same grounding used by persistence", () => {
    const pendingMessageId = "message-memory-pending-user";
    const grounded = stableUserCandidate();
    const ungrounded = stableUserCandidate({
      content: "The user has a cat named Moon.",
      tags: ["pet", "cat"],
    });

    const preflight = preflightMemoryCandidates({
      store,
      agentId: AGENT_ID,
      candidates: [grounded, ungrounded],
      nowUtc: NOW,
      maxCandidates: 2,
      authoritativeMessageId: pendingMessageId,
      authoritativeMessage: {
        id: pendingMessageId,
        role: "user",
        content: "I am vegetarian and prefer simple meals.",
        createdAtUtc: MESSAGE_TIME,
      },
    });

    expect(preflight.accepted).toHaveLength(1);
    expect(preflight.accepted[0]).toMatchObject({
      content: grounded.content,
      sourceMessageIds: [pendingMessageId],
      evidence: [
        expect.objectContaining({
          sourceType: "message",
          sourceId: pendingMessageId,
          quote: "I am vegetarian and prefer simple meals.",
        }),
      ],
    });
    expect(preflight.rejections).toEqual([
      expect.objectContaining({
        index: 1,
        reasonCode: "ungrounded_memory_candidate",
      }),
    ]);
    expect(readActiveMemoryRecords(store, AGENT_ID, NOW)).toEqual([]);

    insertMessage(
      database,
      pendingMessageId,
      "user",
      "I am vegetarian and prefer simple meals.",
    );
    const persisted = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: preflight.accepted,
      nowUtc: NOW,
      maxCandidates: 2,
      authoritativeMessageId: pendingMessageId,
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.content).toBe(grounded.content);
  });

  it("assigns one stable claim identity and supersedes an explicit correction", () => {
    const originalMessageId = "message-memory-cilantro-original";
    insertMessage(database, originalMessageId, "user", "我通常不吃香菜。", NOW);
    const [original] = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [
        stableUserCandidate({
          content: "我通常不吃香菜",
          tags: ["user_preference", "food", "cilantro"],
        }),
      ],
      nowUtc: NOW,
      maxCandidates: 1,
      authoritativeMessageId: originalMessageId,
    });
    expect(original?.claim?.subjectKey).toBe("user.preference.food.cilantro");

    const correctionMessageId = "message-memory-cilantro-correction";
    insertMessage(
      database,
      correctionMessageId,
      "user",
      "我纠正一下：前面说我不吃香菜太绝对了。准确说法是，我可以接受少量香菜，但不喜欢整把香菜。",
      NOW,
    );
    const [correction] = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [
        stableUserCandidate({
          content: "我可以接受少量香菜，但不喜欢整把香菜",
          tags: ["user_preference", "food", "cilantro"],
        }),
      ],
      nowUtc: NOW,
      maxCandidates: 1,
      authoritativeMessageId: correctionMessageId,
    });
    expect(correction?.claim?.subjectKey).toBe(original?.claim?.subjectKey);
    expect(correction?.tags).toContain("correction");

    const lifecycle = new MemoryLifecycleService(
      new ContinuityMemoryRepository(store),
      new FakeClock(NOW),
    );
    const [result] = lifecycle.reconcileNewMemories(
      AGENT_ID,
      [correction?.id ?? "missing"],
      {
        correlationId: "client-cilantro-correction",
        causationId: correctionMessageId,
      },
    );
    expect(result?.replayed).toBe(false);
    expect(result?.reconciliation.kind).toBe("supersede");
    expect(result?.changedMemoryIds).toEqual([original?.id]);

    expect(readActiveMemoryRecords(store, AGENT_ID, NOW)).toEqual([
      expect.objectContaining({
        id: correction?.id,
        content: "我可以接受少量香菜，但不喜欢整把香菜",
      }),
    ]);
    expect(
      database
        .prepare("SELECT status, superseded_by_id FROM memories WHERE id = ?")
        .get(original?.id),
    ).toEqual({ status: "superseded", superseded_by_id: correction?.id });
    expect(
      database
        .prepare(
          "SELECT correlation_id, causation_id FROM domain_events WHERE event_type = 'memory.claim.supersede'",
        )
        .get(),
    ).toEqual({
      correlation_id: "client-cilantro-correction",
      causation_id: correctionMessageId,
    });
    expect(
      lifecycle.reconcile({
        existingMemoryId: original?.id ?? "missing",
        incomingMemoryId: correction?.id ?? "missing",
      }),
    ).toMatchObject({ replayed: true, changedMemoryIds: [] });
  });

  it("keeps a Chinese person claim key stable across a relationship correction", () => {
    const originalMessageId = "message-memory-xiaolin-original";
    insertMessage(
      database,
      originalMessageId,
      "user",
      "我大学同学叫小林，她最近刚搬到苏州。",
      NOW,
    );
    const [original] = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: [
        stableUserCandidate({
          content: "我大学同学叫小林，她最近刚搬到苏州",
          tags: ["user fact", "person", "小林"],
        }),
      ],
      nowUtc: NOW,
      maxCandidates: 1,
      authoritativeMessageId: originalMessageId,
    });
    expect(original?.claim?.subjectKey).toBe("user.person.小林.profile");

    const correctionMessageId = "message-memory-xiaolin-correction";
    insertMessage(
      database,
      correctionMessageId,
      "user",
      "我纠正一下：小林不是我的大学同学，是我高中同学。她搬到苏州这件事没变。",
      NOW,
    );
    const correctionCandidate = stableUserCandidate({
      content: "小林是我高中同学。她搬到苏州",
      tags: ["user fact", "person", "小林", "correction"],
    });
    const preflight = preflightMemoryCandidates({
      store,
      agentId: AGENT_ID,
      candidates: [correctionCandidate],
      nowUtc: NOW,
      maxCandidates: 1,
      authoritativeMessageId: correctionMessageId,
    });
    expect(preflight.accepted).toEqual([
      expect.objectContaining({
        content: correctionCandidate.content,
        evidence: [
          expect.objectContaining({
            sourceId: correctionMessageId,
            quote:
              "我纠正一下：小林不是我的大学同学，是我高中同学。她搬到苏州这件事没变。",
          }),
        ],
      }),
    ]);
    const [correction] = validateMergeAndPersistMemories({
      store,
      agentId: AGENT_ID,
      candidates: preflight.accepted,
      nowUtc: NOW,
      maxCandidates: 1,
      authoritativeMessageId: correctionMessageId,
    });
    expect(correction?.claim?.subjectKey).toBe(original?.claim?.subjectKey);

    const lifecycle = new MemoryLifecycleService(
      new ContinuityMemoryRepository(store),
      new FakeClock(NOW),
    );
    const [result] = lifecycle.reconcileNewMemories(
      AGENT_ID,
      [correction?.id ?? "missing"],
      {
        correlationId: "client-xiaolin-correction",
        causationId: correctionMessageId,
      },
    );
    expect(result?.reconciliation.kind).toBe("supersede");
    expect(result?.changedMemoryIds).toEqual([original?.id]);
    expect(
      database
        .prepare("SELECT status, superseded_by_id FROM memories WHERE id = ?")
        .get(original?.id),
    ).toEqual({ status: "superseded", superseded_by_id: correction?.id });
  });

  it.each([
    {
      id: "message-memory-hypothesis",
      text: "假设我养了一只叫豆包的狗，我可能每天带它散步。这里只是举例。",
      content: "我养了一只叫豆包的狗",
      tags: ["user_fact", "pet", "豆包"],
    },
    {
      id: "message-memory-third-party-quote",
      text: "小林说她最喜欢香菜。这是她的偏好，不是我的。",
      content: "我最喜欢香菜",
      tags: ["user_preference", "food", "cilantro"],
    },
    {
      id: "message-memory-retraction",
      text: "刚才关于豆包只是举例，不要把它记成真实宠物。",
      content: "豆包是我的真实宠物",
      tags: ["user_fact", "pet", "豆包"],
    },
    {
      id: "message-memory-attributed-direct-contrast",
      text: "我纠正一下：小林不是我的大学同学，是我高中同学。根据张伟的说法。",
      content: "小林是我高中同学",
      tags: ["user_fact", "person", "小林", "correction"],
    },
    {
      id: "message-memory-attributed-marker-correction",
      text: "我纠正一下：准确说法是，我喜欢咖啡。信息来源是张伟。",
      content: "我喜欢咖啡",
      tags: ["user_preference", "coffee", "correction"],
    },
  ])("rejects $id as authority for a user-model fact", (scenario) => {
    const candidate = stableUserCandidate({
      content: scenario.content,
      tags: scenario.tags,
    });
    const result = preflightMemoryCandidates({
      store,
      agentId: AGENT_ID,
      candidates: [candidate],
      nowUtc: NOW,
      maxCandidates: 1,
      authoritativeMessageId: scenario.id,
      authoritativeMessage: {
        id: scenario.id,
        role: "user",
        content: scenario.text,
        createdAtUtc: NOW,
      },
    });
    expect(result.accepted).toEqual([]);
    expect(result.rejections).toEqual([
      expect.objectContaining({ reasonCode: "ungrounded_memory_candidate" }),
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

  it("bounds candidate evidence ids while preserving the full evidence audit trail", () => {
    let memoryId: string | undefined;
    for (let index = 0; index < 21; index += 1) {
      const messageId = `message-memory-jasmine-${index}`;
      insertMessage(database, messageId, "user", "I prefer jasmine tea.");
      const [memory] = validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [
          stableUserCandidate({
            content: "The user prefers jasmine tea.",
            tags: ["preference", "jasmine", "tea"],
          }),
        ],
        nowUtc: NOW,
        maxCandidates: 1,
        authoritativeMessageId: messageId,
      });
      expect(memory).toBeDefined();
      memoryId = memory?.id;
    }

    const evidence = readMemoryEvidence(store, [memoryId ?? "missing"]);
    expect(evidence).toHaveLength(21);

    const preview = previewAgentMemoryRecall(store, {
      agentId: AGENT_ID,
      query: "jasmine tea",
      nowUtc: NOW,
    });
    const candidate = preview.candidates.find(
      (item) => item.memoryId === memoryId,
    );
    expect(preview.evidenceCount).toBe(21);
    expect(candidate?.evidenceIds).toEqual(
      evidence.slice(0, 20).map((item) => item.id),
    );
  });

  it("recalls an exact Chinese person from authoritative user-model evidence", () => {
    const xiaolinMessageId = "message-memory-xiaolin";
    const xiaoliMessageId = "message-memory-xiaoli";
    insertMessage(
      database,
      xiaolinMessageId,
      "user",
      "我大学同学叫小林，她最近刚搬到苏州。",
    );
    insertMessage(
      database,
      xiaoliMessageId,
      "user",
      "我大学同学叫小李，她最近刚搬到无锡。",
    );
    const persisted = [
      ...validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [
          stableUserCandidate({
            content: "我大学同学叫小林，她最近刚搬到苏州",
            importance: 0.22,
            tags: ["user_fact", "person", "小林"],
          }),
        ],
        nowUtc: NOW,
        maxCandidates: 1,
        authoritativeMessageId: xiaolinMessageId,
      }),
      ...validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [
          stableUserCandidate({
            content: "我大学同学叫小李，她最近刚搬到无锡",
            importance: 1,
            tags: ["user_fact", "person", "小李"],
          }),
        ],
        nowUtc: NOW,
        maxCandidates: 1,
        authoritativeMessageId: xiaoliMessageId,
      }),
    ];
    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.claim?.subjectKey).toBe("user.person.小林.profile");

    const result = recallAgentMemories(store, {
      agentId: AGENT_ID,
      query: {
        query: "小林是谁？",
        namespaces: ["user_model"],
        purpose: "user_fact_query",
      },
      nowUtc: NOW,
    });
    expect(result.abstained).toBe(false);
    expect(result.selectedMemoryIds).toEqual([persisted[0]?.id]);
    if (!result.abstained) {
      expect(result.evidenceBundle.evidence[0]?.memoryContent).toContain(
        "苏州",
      );
    }
  });
});

function stableUserCandidate(
  overrides: Partial<MemoryCandidate> = {},
): MemoryCandidate {
  return MemoryCandidateSchema.parse({
    kind: "semantic",
    content: "The user is vegetarian and prefers simple meals.",
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

function sharedExperienceCandidate(): MemoryCandidate {
  return MemoryCandidateSchema.parse({
    kind: "episodic",
    content: "We watched colorful fireworks together.",
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
  createdAtUtc = MESSAGE_TIME,
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
      createdAtUtc,
    );
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
