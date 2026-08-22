import {
  MemoryCandidateSchema,
  MemorySchema,
  type MemoryCandidate,
} from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { previewAgentMemoryRecall } from "./memory-recall-service.js";
import {
  readActiveMemoryRecords,
  readRecallCandidateRecords,
  validateMergeAndPersistMemories,
} from "./memory-service.js";

const AGENT_ID = "agent-recall-pool";
const SESSION_ID = "session-recall-pool";
const NOW_UTC = "2026-08-21T12:00:00.000Z";
const QUERY = "What tea do I prefer? jasmine tea";
const FILLER_COUNT = 250;
const TARGET_MEMORY_IMPORTANCE = 0.3;

describe("recall candidate keyword prefilter", () => {
  it("recalls a keyword-matched memory ranked below the importance pool cutoff", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new DatabaseStore(database);
      seedPoolFixture(store);

      // The keyword-matched memory is structurally outside the legacy
      // importance-ordered pool.
      const importancePool = readActiveMemoryRecords(
        store,
        AGENT_ID,
        NOW_UTC,
        200,
      );
      expect(importancePool).toHaveLength(200);
      expect(
        importancePool.some((memory) => memory.content.includes("jasmine")),
      ).toBe(false);
      const importanceTies = importancePool
        .filter((memory) => memory.importance === 0.9)
        .map((memory) => memory.id);
      expect(importanceTies).toEqual([...importanceTies].sort());

      const boundedPool = readRecallCandidateRecords(store, AGENT_ID, NOW_UTC, {
        candidateLimit: 37,
        query: QUERY,
        keywordLimit: 50,
      });
      expect(boundedPool).toHaveLength(37);
      expect(
        boundedPool.some((memory) => memory.content.includes("jasmine")),
      ).toBe(true);
      const keywordTies = boundedPool
        .filter((memory) => memory.importance === 0.9)
        .map((memory) => memory.id);
      expect(keywordTies).toEqual([...keywordTies].sort());

      const preview = previewAgentMemoryRecall(store, {
        agentId: AGENT_ID,
        query: QUERY,
        nowUtc: NOW_UTC,
      });

      const matched = preview.candidates.find((candidate) =>
        candidate.content.includes("jasmine"),
      );
      expect(matched).toBeDefined();
      expect(preview.candidates).toHaveLength(200);
      expect(preview.result.abstained).toBe(false);
      expect(preview.result.selectedMemoryIds).toContain(matched?.memoryId);
    } finally {
      database.close();
    }
  });

  it("recalls a low-importance memory from a one-character Han query", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new DatabaseStore(database);
      seedPoolFixture(store);
      const messageId = "message-recall-pool-cat";
      store.insertMessage({
        id: messageId,
        sessionId: SESSION_ID,
        agentId: AGENT_ID,
        role: "user",
        content: "\u6211\u559c\u6b22\u732b\u3002",
        messageKind: "user",
        metadata: {},
        createdAtUtc: NOW_UTC,
      });
      const [target] = validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [catMemory()],
        nowUtc: NOW_UTC,
        maxCandidates: 1,
        authoritativeMessageId: messageId,
      });
      if (target === undefined) throw new Error("Cat memory was not persisted");

      expect(
        readActiveMemoryRecords(store, AGENT_ID, NOW_UTC, 200).some(
          (memory) => memory.id === target.id,
        ),
      ).toBe(false);
      const preview = previewAgentMemoryRecall(store, {
        agentId: AGENT_ID,
        query: "\u732b",
        nowUtc: NOW_UTC,
      });

      expect(preview.candidates).toHaveLength(200);
      expect(preview.result.abstained).toBe(false);
      expect(preview.result.selectedMemoryIds).toContain(target.id);
    } finally {
      database.close();
    }
  });

  it("keeps a tail exact ID visible beyond 40 query tokens and 200 importance decoys", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const store = new DatabaseStore(database);
      seedPoolFixture(store);
      const sourceId = "source-recall-pool-rare-code";
      const memoryContent =
        "重要演讲仪式的代号 BGW-7419 对应蓝色玻璃鲸，并放在左口袋。";
      store.insertCharacterSource({
        id: sourceId,
        characterId: AGENT_ID,
        sourceType: "test_fixture",
        title: "Rare code fact",
        contentExcerpt: memoryContent,
        sourceHash: "hash-recall-pool-rare-code",
        createdAtUtc: NOW_UTC,
      });
      const [target] = validateMergeAndPersistMemories({
        store,
        agentId: AGENT_ID,
        candidates: [
          MemoryCandidateSchema.parse({
            kind: "episodic",
            content: memoryContent,
            importance: 0.2,
            confidence: 1,
            tags: ["BGW-7419", "演讲仪式"],
            sourceMessageIds: [],
            sourceActivityEventIds: [],
            origin: "runtime_simulation",
            namespace: "character_self",
            certainty: "inferred",
            attribution: "model_inference",
            stability: "stable",
            evidence: [
              {
                sourceType: "character_source",
                sourceId,
                contextSummary: memoryContent,
                recordedAtUtc: NOW_UTC,
              },
            ],
            reasonCode: "character_source",
            reasonSummary: "Grounded by the character source fixture.",
          }),
        ],
        nowUtc: NOW_UTC,
        maxCandidates: 1,
      });
      if (target === undefined) {
        throw new Error("Rare-code memory was not persisted");
      }
      const query = alphabeticFillerWords(60).join(" ") + " BGW-7419";

      expect(
        readActiveMemoryRecords(store, AGENT_ID, NOW_UTC, 200).some(
          (memory) => memory.id === target.id,
        ),
      ).toBe(false);
      const boundedPool = readRecallCandidateRecords(store, AGENT_ID, NOW_UTC, {
        candidateLimit: 200,
        query,
        keywordLimit: 50,
      });
      expect(boundedPool).toHaveLength(200);
      expect(boundedPool.some((memory) => memory.id === target.id)).toBe(true);

      const preview = previewAgentMemoryRecall(store, {
        agentId: AGENT_ID,
        query,
        nowUtc: NOW_UTC,
      });
      expect(preview.result.abstained).toBe(false);
      expect(preview.result.selectedMemoryIds).toContain(target.id);
      if (preview.result.abstained) {
        throw new Error("Expected the rare-code memory to be recalled");
      }
      expect(
        preview.result.evidenceBundle.evidence.some(
          (item) =>
            item.memoryId === target.id &&
            item.evidence.sourceType === "character_source" &&
            item.evidence.sourceId === sourceId,
        ),
      ).toBe(true);
    } finally {
      database.close();
    }
  });
});

function seedPoolFixture(store: DatabaseStore): void {
  store.database
    .prepare(
      `INSERT INTO characters(
        id, current_version, status, tier, name, source_type,
        created_at_utc, updated_at_utc
      ) VALUES (?, 1, 'published', 'high_fidelity', ?, 'original', ?, ?)`,
    )
    .run(AGENT_ID, "Recall Pool Agent", NOW_UTC, NOW_UTC);
  store.database
    .prepare(
      `INSERT INTO runtime_states(agent_id, state_json, revision, updated_at_utc)
       VALUES (?, '{}', 0, ?)`,
    )
    .run(AGENT_ID, NOW_UTC);
  store.database
    .prepare(
      `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
       VALUES (?, ?, 'Recall pool', ?, ?)`,
    )
    .run(SESSION_ID, AGENT_ID, NOW_UTC, NOW_UTC);

  store.insertMessage({
    id: "message-recall-pool-tea",
    sessionId: SESSION_ID,
    agentId: AGENT_ID,
    role: "user",
    content: "I prefer jasmine tea.",
    messageKind: "user",
    metadata: {},
    createdAtUtc: NOW_UTC,
  });
  const [target] = validateMergeAndPersistMemories({
    store,
    agentId: AGENT_ID,
    candidates: [jasmineTeaMemory()],
    nowUtc: NOW_UTC,
    maxCandidates: 1,
    authoritativeMessageId: "message-recall-pool-tea",
  });
  if (target === undefined) throw new Error("Target memory was not persisted");

  insertFillerMemories(store.database);
}

function jasmineTeaMemory(): MemoryCandidate {
  return MemoryCandidateSchema.parse({
    kind: "semantic",
    content: "The user prefers jasmine tea.",
    importance: TARGET_MEMORY_IMPORTANCE,
    confidence: 1,
    tags: ["tea", "jasmine"],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "stable",
    reasonCode: "user_statement",
    reasonSummary: "User stated the preference explicitly.",
  });
}

function catMemory(): MemoryCandidate {
  return MemoryCandidateSchema.parse({
    kind: "semantic",
    content: "\u7528\u6237\u559c\u6b22\u732b\u3002",
    importance: 0.2,
    confidence: 1,
    tags: ["\u732b"],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "stable",
    reasonCode: "user_statement",
    reasonSummary: "User stated the preference explicitly.",
  });
}

function insertFillerMemories(database: Database): void {
  const insert = database.prepare(
    `INSERT INTO memories(
       id, agent_id, type, content, tags_json, importance, confidence,
       created_at_utc, memory_json, namespace, certainty, attribution,
       stability, status, recorded_at_utc, temporal_certainty, temporal_status
     ) VALUES (?, ?, 'semantic', ?, '["filler"]', ?, 1, ?, ?, 'user_model',
       'inferred', 'model_inference', 'situational', 'active', ?,
       'unknown', 'unknown')`,
  );
  for (let index = 0; index < FILLER_COUNT; index += 1) {
    const memory = MemorySchema.parse({
      id: `memory-filler-${index}`,
      agentId: AGENT_ID,
      kind: "semantic",
      content: `Routine tea note ${index} about the weekly schedule. Similar code BGW-7419${1000 + index}.`,
      importance: 0.9 - (index % 4) * 0.1,
      confidence: 1,
      tags: ["filler"],
      sourceMessageIds: [],
      sourceActivityEventIds: [],
      origin: "runtime_simulation",
      namespace: "user_model",
      certainty: "inferred",
      attribution: "model_inference",
      stability: "situational",
      temporalMetadata: {
        recordedAtUtc: NOW_UTC,
        temporalCertainty: "unknown",
        temporalStatus: "unknown",
      },
      status: "active",
      dedupeKey: `filler-${index}`,
      createdAtUtc: NOW_UTC,
      updatedAtUtc: NOW_UTC,
    });
    insert.run(
      memory.id,
      AGENT_ID,
      memory.content,
      memory.importance,
      NOW_UTC,
      JSON.stringify(memory),
      NOW_UTC,
    );
  }
}

function alphabeticFillerWords(count: number): string[] {
  return Array.from({ length: count }, (_, index) => {
    const high = String.fromCharCode(97 + Math.floor(index / 26));
    const low = String.fromCharCode(97 + (index % 26));
    return "preface" + high + low;
  });
}
