import {
  MemoryRecallResultSchema,
  type JsonValue,
  type Memory,
  type MemoryRecallResult,
} from "@personasim/contracts";
import { recallMemory } from "@personasim/features";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import {
  RETRIEVAL_RUN_STAGE_NAMES,
  RetrievalRunRepository,
  type CreateRetrievalRunInput,
  type RetrievalReplayInput,
  type RetrievalRunCandidate,
  type RetrievalRunStage,
} from "./retrieval-run-repository.js";

const NOW = "2026-08-21T04:00:00.000Z";
const AGENT_ID = "agent_retrieval_run";
const SESSION_ID = "session_retrieval_run";
const MESSAGE_ID = "message_retrieval_run";
const MEMORY_ID = "memory_retrieval_selected";
const EXCLUDED_MEMORY_ID = "memory_retrieval_excluded";
const EVIDENCE_ID = "evidence_retrieval_selected";

describe("RetrievalRunRepository", () => {
  let database: Database;
  let repository: RetrievalRunRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    seedFoundation(database);
    repository = new RetrievalRunRepository(database);
  });

  afterEach(() => {
    database.close();
  });

  it("persists complete inspection snapshots and replays frozen inputs", () => {
    const input = replayInput();
    const result = evaluate(input);
    expect(result.abstained).toBe(false);
    const created = repository.create(
      createRunInput("retrieval_run_1", input, result),
    );

    expect(repository.findById(created.id)).toEqual(created);
    expect(repository.listByAgent(AGENT_ID)).toEqual([created]);
    expect(
      database
        .prepare(
          "SELECT json_extract(evidence_bundle_json, '$.mode') AS mode, candidate_count AS candidateCount, selected_count AS selectedCount FROM retrieval_runs WHERE id = ?",
        )
        .get(created.id),
    ).toEqual({
      mode: result.mode,
      candidateCount: 2,
      selectedCount: 1,
    });

    database
      .prepare("UPDATE memories SET content = ? WHERE id = ?")
      .run("The live memory was changed after retrieval.", MEMORY_ID);
    const frozen = repository.getReplayInput(created.id);
    expect(frozen?.memories[0]?.content).toBe(
      "The user plans a Kyoto trip in autumn.",
    );
    expect(frozen === undefined ? undefined : evaluate(frozen)).toEqual(result);

    expect(() =>
      database
        .prepare(
          "UPDATE retrieval_runs SET rendered_prompt_fragment = ? WHERE id = ?",
        )
        .run("tampered", created.id),
    ).toThrow(/immutable/iu);
    expect(() =>
      database
        .prepare("DELETE FROM retrieval_runs WHERE id = ?")
        .run(created.id),
    ).toThrow(/immutable/iu);
  });

  it("lists same-timestamp runs in insertion order with the newest first", () => {
    const input = replayInput();
    const result = evaluate(input);
    const first = repository.create(
      createRunInput("retrieval_run_z_first", input, result),
    );
    const second = repository.create(
      createRunInput("retrieval_run_a_second", input, result),
    );

    expect(repository.listByAgent(AGENT_ID, 2).map((run) => run.id)).toEqual([
      second.id,
      first.id,
    ]);
  });

  it("persists date-digest runs after the immutable table migration", () => {
    const baseInput = replayInput();
    const input: RetrievalReplayInput = {
      ...baseInput,
      strategyVersion: "continuity_hierarchy_v1",
      hierarchy: {
        finalTier: "date_digest",
        candidateTiers: baseInput.memories.map((memory) => ({
          memoryId: memory.id,
          tier: "date_digest" as const,
        })),
        temporalResolution: {
          kind: "resolved",
          expression: "yesterday",
          fromUtc: "2026-08-19T16:00:00.000Z",
          toUtc: "2026-08-20T16:00:00.000Z",
        },
      },
    };
    const evaluated = evaluate(input);
    if (evaluated.abstained) throw new Error("Expected recall evidence");
    const result = MemoryRecallResultSchema.parse({
      ...evaluated,
      mode: "date_digest",
      evidenceBundle: {
        ...evaluated.evidenceBundle,
        mode: "date_digest",
      },
    });

    const created = repository.create(
      createRunInput("retrieval_run_date_digest", input, result),
    );

    expect(
      database
        .prepare("SELECT mode FROM retrieval_runs WHERE id = ?")
        .get(created.id),
    ).toEqual({ mode: "date_digest" });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM schema_migrations WHERE name = ?",
        )
        .get("014_retrieval_run_date_digest.sql"),
    ).toEqual({ count: 1 });
    expect(repository.findById(created.id)).toEqual(created);
  });

  it("rejects incomplete stages and secret-bearing config snapshots", () => {
    const input = replayInput();
    const result = evaluate(input);
    const base = createRunInput("retrieval_run_invalid", input, result);

    expect(() =>
      repository.create({
        ...base,
        stages: base.stages.slice(0, -1),
      }),
    ).toThrow(/complete|length/iu);
    expect(() =>
      repository.create({
        ...base,
        configSnapshot: {
          ...base.configSnapshot,
          provider: { apiKey: "must-not-be-persisted" },
        },
      }),
    ).toThrow(/secrets/iu);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM retrieval_runs").get(),
    ).toEqual({ count: 0 });
  });
});

function createRunInput(
  id: string,
  inputSnapshot: RetrievalReplayInput,
  result: MemoryRecallResult,
): CreateRetrievalRunInput {
  return {
    id,
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    sourceMessageId: MESSAGE_ID,
    inputSnapshot,
    stages: stages(inputSnapshot, result),
    candidates: candidates(inputSnapshot, result),
    result,
    configSnapshot: {
      strategy: {
        name: "keyword_evidence_v1",
        candidateLimit: inputSnapshot.candidateLimit,
        maxEvidence: inputSnapshot.maxEvidence,
        minimumScore: inputSnapshot.minimumScore,
      },
      scoreWeights: {
        lexical: 0.34,
        tag: 0.14,
        importance: 0.16,
        recency: 0.1,
        temporal: 0.16,
        namespace: 0.1,
      },
    },
    renderedPromptFragment:
      "Retrieved evidence:\n- The user plans a Kyoto trip in autumn.",
    createdAtUtc: NOW,
  };
}

function stages(
  input: RetrievalReplayInput,
  result: MemoryRecallResult,
): RetrievalRunStage[] {
  const snapshots: JsonValue[] = [
    { query: jsonSnapshot(input.query) },
    { timeRange: jsonSnapshot(input.query.timeRange ?? null) },
    { namespaces: input.query.namespaces ?? [] },
    { memoryIds: input.memories.map((memory) => memory.id) },
    { evidenceIds: input.evidence.map((evidence) => evidence.id) },
    {
      minimumScore: input.minimumScore,
      scoreKinds: [
        "lexical",
        "semantic",
        "temporal",
        "importance",
        "relationship",
      ],
    },
    {
      selectedMemoryIds: result.selectedMemoryIds,
      abstained: result.abstained,
    },
    { rendered: true },
  ];
  return RETRIEVAL_RUN_STAGE_NAMES.map((name, ordinal) => ({
    name,
    ordinal,
    status: "completed",
    ...(name === "candidate_generation"
      ? { inputCount: input.memories.length }
      : {}),
    ...(name === "selection"
      ? { outputCount: result.selectedMemoryIds.length }
      : {}),
    durationMs: ordinal / 10,
    snapshot: snapshots[ordinal] ?? null,
  }));
}

function candidates(
  input: RetrievalReplayInput,
  result: MemoryRecallResult,
): RetrievalRunCandidate[] {
  if (result.abstained) return [];
  const selectedById = new Map(
    result.evidenceBundle.evidence.map((item) => [item.memoryId, item]),
  );
  return input.memories.map((memory) => {
    const selected = selectedById.get(memory.id);
    if (selected !== undefined) {
      return {
        memoryId: memory.id,
        namespace: selected.namespace,
        evidenceIds: [selected.evidence.id],
        score: selected.score,
        scoreBreakdown: selected.scoreBreakdown,
        semanticScore: null,
        relationshipScore: 0,
        decision: "selected",
        reasonCode: "top_ranked",
        selectionRank: result.selectedMemoryIds.indexOf(memory.id) + 1,
      };
    }
    return {
      memoryId: memory.id,
      namespace: memory.namespace ?? "runtime_simulation",
      evidenceIds: [],
      score: 0.08,
      scoreBreakdown: zeroBreakdown(),
      semanticScore: null,
      relationshipScore: 0,
      decision: "excluded",
      reasonCode: "below_threshold",
      reasonSummary: "The candidate did not meet the configured threshold.",
    };
  });
}

function replayInput(): RetrievalReplayInput {
  return {
    agentId: AGENT_ID,
    query: {
      query: "What did I say about my Kyoto trip?",
      namespaces: ["user_model"],
      minimumScore: 0.1,
    },
    nowUtc: NOW,
    memories: [
      selectedMemory(),
      {
        ...selectedMemory(),
        id: EXCLUDED_MEMORY_ID,
        content: "The user likes plain tea.",
        tags: ["tea"],
        dedupeKey: "memory:tea",
      },
    ],
    evidence: [
      {
        id: EVIDENCE_ID,
        memoryId: MEMORY_ID,
        sourceType: "message",
        sourceId: MESSAGE_ID,
        quote: "I plan to visit Kyoto this autumn.",
        recordedAtUtc: NOW,
      },
    ],
    minimumScore: 0.1,
    maxEvidence: 3,
    candidateLimit: 200,
  };
}

function selectedMemory(): Memory {
  return {
    id: MEMORY_ID,
    agentId: AGENT_ID,
    kind: "semantic",
    content: "The user plans a Kyoto trip in autumn.",
    importance: 0.8,
    confidence: 1,
    tags: ["kyoto", "trip"],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "situational",
    status: "active",
    dedupeKey: "memory:kyoto-trip",
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  };
}

function evaluate(input: RetrievalReplayInput): MemoryRecallResult {
  return recallMemory({
    query: input.query,
    memories: input.memories,
    evidence: input.evidence,
    nowUtc: input.nowUtc,
    minimumScore: input.minimumScore,
    maxEvidence: input.maxEvidence,
  });
}

function zeroBreakdown(): {
  lexical: number;
  tag: number;
  importance: number;
  recency: number;
  temporal: number;
  namespace: number;
} {
  return {
    lexical: 0,
    tag: 0,
    importance: 0,
    recency: 0,
    temporal: 0,
    namespace: 0,
  };
}

function jsonSnapshot(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function seedFoundation(database: Database): void {
  database
    .prepare(
      "INSERT INTO characters(id, current_version, status, tier, name, source_type, created_at_utc, updated_at_utc) VALUES (?, 1, 'published', 'daily', 'Retrieval Run', 'original', ?, ?)",
    )
    .run(AGENT_ID, NOW, NOW);
  database
    .prepare(
      "INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc) VALUES (?, ?, 'Retrieval Run', ?, ?)",
    )
    .run(SESSION_ID, AGENT_ID, NOW, NOW);
  database
    .prepare(
      "INSERT INTO messages(id, session_id, agent_id, role, content, message_kind, created_at_utc) VALUES (?, ?, ?, 'user', 'I plan to visit Kyoto this autumn.', 'user', ?)",
    )
    .run(MESSAGE_ID, SESSION_ID, AGENT_ID, NOW);
  const memory = selectedMemory();
  database
    .prepare(
      "INSERT INTO memories(id, agent_id, type, content, tags_json, importance, confidence, created_at_utc, memory_json, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
      memory.status,
    );
}
