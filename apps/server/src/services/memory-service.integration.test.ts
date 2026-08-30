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
        subjectKey: "user_fact:notebook:storage",
        oldFragment: "绿色",
        newFragment: "藏青色",
      },
      {
        initialTurn: 38,
        correctionTurn: 42,
        subjectKey: "user_fact:decision_option:B:reply_deadline",
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
