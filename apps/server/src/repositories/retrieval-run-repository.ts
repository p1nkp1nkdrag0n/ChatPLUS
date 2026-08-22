import {
  EntityIdSchema,
  EvidenceBundleSchema,
  JsonValueSchema,
  MemoryEvidenceSchema,
  MemoryNamespaceSchema,
  MemoryRecallQuerySchema,
  MemoryRecallResultSchema,
  MemorySchema,
  ReasonCodeSchema,
  RetrievalScoreBreakdownSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
  type EvidenceBundle,
  type JsonValue,
  type MemoryRecallResult,
} from "@personasim/contracts";
import { z } from "zod";

import type { Database } from "../db/connection.js";
import { createEntityId } from "../domain/id.js";

export const RETRIEVAL_RUN_STAGE_NAMES = [
  "query_normalization",
  "temporal_resolution",
  "namespace_filter",
  "candidate_generation",
  "evidence_verification",
  "scoring",
  "selection",
  "prompt_rendering",
] as const;

export type RetrievalRunStageName = (typeof RETRIEVAL_RUN_STAGE_NAMES)[number];

export const RetrievalRunStageSchema = z
  .object({
    name: z.enum(RETRIEVAL_RUN_STAGE_NAMES),
    ordinal: z
      .number()
      .int()
      .min(0)
      .max(RETRIEVAL_RUN_STAGE_NAMES.length - 1),
    status: z.enum(["completed", "skipped", "failed"]),
    inputCount: z.number().int().nonnegative().max(10_000).optional(),
    outputCount: z.number().int().nonnegative().max(10_000).optional(),
    durationMs: z.number().finite().nonnegative(),
    reasonCode: ReasonCodeSchema.optional(),
    snapshot: JsonValueSchema.optional(),
  })
  .strict();
export type RetrievalRunStage = z.infer<typeof RetrievalRunStageSchema>;

const RetrievalRunStagesSchema = z
  .array(RetrievalRunStageSchema)
  .length(RETRIEVAL_RUN_STAGE_NAMES.length)
  .superRefine((stages, context) => {
    RETRIEVAL_RUN_STAGE_NAMES.forEach((name, index) => {
      const stage = stages[index];
      if (stage?.name !== name || stage.ordinal !== index) {
        context.addIssue({
          code: "custom",
          message: "Retrieval stages must be complete and in canonical order",
          path: [index],
        });
      }
    });
  });

export const RetrievalRunCandidateSchema = z
  .object({
    memoryId: EntityIdSchema,
    namespace: MemoryNamespaceSchema,
    evidenceIds: z
      .array(EntityIdSchema)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Candidate evidence ids must be unique",
      }),
    score: UnitIntervalSchema,
    scoreBreakdown: RetrievalScoreBreakdownSchema,
    semanticScore: UnitIntervalSchema.nullable(),
    relationshipScore: UnitIntervalSchema.nullable(),
    decision: z.enum(["selected", "excluded"]),
    reasonCode: ReasonCodeSchema,
    reasonSummary: z.string().trim().min(1).max(1_000).optional(),
    selectionRank: z.number().int().min(1).max(3).optional(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (
      candidate.decision === "selected" &&
      candidate.selectionRank === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Selected candidates require selectionRank",
        path: ["selectionRank"],
      });
    }
    if (
      candidate.decision === "excluded" &&
      candidate.selectionRank !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Excluded candidates cannot have selectionRank",
        path: ["selectionRank"],
      });
    }
  });
export type RetrievalRunCandidate = z.infer<typeof RetrievalRunCandidateSchema>;

export const RetrievalHierarchySnapshotSchema = z
  .object({
    finalTier: z.enum([
      "event_card",
      "verbatim_quote",
      "date_digest",
      "basic_memory",
      "none",
    ]),
    candidateTiers: z
      .array(
        z
          .object({
            memoryId: EntityIdSchema,
            tier: z.enum([
              "event_card",
              "verbatim_quote",
              "date_digest",
              "basic_memory",
            ]),
          })
          .strict(),
      )
      .max(500),
    temporalResolution: JsonValueSchema.optional(),
    abstentionReason: ReasonCodeSchema.optional(),
    abstentionScore: UnitIntervalSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const candidateIds = snapshot.candidateTiers.map((item) => item.memoryId);
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({
        code: "custom",
        message: "Hierarchy candidate ids must be unique",
        path: ["candidateTiers"],
      });
    }
    if (snapshot.finalTier === "none") {
      if (snapshot.abstentionReason === undefined) {
        context.addIssue({
          code: "custom",
          message: "An abstained hierarchy replay requires a reason",
          path: ["abstentionReason"],
        });
      }
      if (snapshot.abstentionScore === undefined) {
        context.addIssue({
          code: "custom",
          message: "An abstained hierarchy replay requires a score",
          path: ["abstentionScore"],
        });
      }
    }
  });
export type RetrievalHierarchySnapshot = z.infer<
  typeof RetrievalHierarchySnapshotSchema
>;

export const RetrievalReplayInputSchema = z
  .object({
    agentId: EntityIdSchema,
    query: MemoryRecallQuerySchema,
    nowUtc: UtcDateTimeSchema,
    memories: z.array(MemorySchema).max(500),
    evidence: z.array(MemoryEvidenceSchema).max(10_000),
    minimumScore: UnitIntervalSchema,
    maxEvidence: z.number().int().min(1).max(3),
    candidateLimit: z.number().int().min(1).max(500),
    strategyVersion: z.literal("continuity_hierarchy_v1").optional(),
    hierarchy: RetrievalHierarchySnapshotSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const memoryIds = new Set<string>();
    for (const [index, memory] of snapshot.memories.entries()) {
      if (memory.agentId !== snapshot.agentId) {
        context.addIssue({
          code: "custom",
          message: "Replay memories must belong to the run agent",
          path: ["memories", index, "agentId"],
        });
      }
      if (memoryIds.has(memory.id)) {
        context.addIssue({
          code: "custom",
          message: "Replay memory ids must be unique",
          path: ["memories", index, "id"],
        });
      }
      memoryIds.add(memory.id);
    }
    const evidenceIds = new Set<string>();
    for (const [index, evidence] of snapshot.evidence.entries()) {
      if (!memoryIds.has(evidence.memoryId)) {
        context.addIssue({
          code: "custom",
          message: "Replay evidence must reference a snapshotted memory",
          path: ["evidence", index, "memoryId"],
        });
      }
      if (evidenceIds.has(evidence.id)) {
        context.addIssue({
          code: "custom",
          message: "Replay evidence ids must be unique",
          path: ["evidence", index, "id"],
        });
      }
      evidenceIds.add(evidence.id);
    }
    if (
      (snapshot.strategyVersion === "continuity_hierarchy_v1") !==
      (snapshot.hierarchy !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Continuity hierarchy strategy and snapshot must coexist",
        path: ["hierarchy"],
      });
    }
    if (snapshot.hierarchy !== undefined) {
      const hierarchyIds = snapshot.hierarchy.candidateTiers.map(
        (item) => item.memoryId,
      );
      if (!sameStringSet(hierarchyIds, [...memoryIds])) {
        context.addIssue({
          code: "custom",
          message: "Hierarchy candidate tiers must cover every replay memory",
          path: ["hierarchy", "candidateTiers"],
        });
      }
      const finalTier = snapshot.hierarchy.finalTier;
      if (
        finalTier !== "none" &&
        !snapshot.hierarchy.candidateTiers.some(
          (item) => item.tier === finalTier,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "The final hierarchy tier requires a candidate",
          path: ["hierarchy", "finalTier"],
        });
      }
    }
  });
export type RetrievalReplayInput = z.infer<typeof RetrievalReplayInputSchema>;

const RetrievalConfigSnapshotSchema = z
  .record(z.string().min(1).max(128), JsonValueSchema)
  .superRefine((snapshot, context) => {
    const sensitivePath = findSensitiveConfigPath(snapshot);
    if (sensitivePath !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Retrieval config snapshots cannot contain secrets",
        path: sensitivePath,
      });
    }
  });

export const RetrievalRunSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    sourceMessageId: EntityIdSchema.optional(),
    inputSnapshot: RetrievalReplayInputSchema,
    stages: RetrievalRunStagesSchema,
    candidates: z.array(RetrievalRunCandidateSchema).max(500),
    result: MemoryRecallResultSchema,
    evidenceBundle: EvidenceBundleSchema.optional(),
    configSnapshot: RetrievalConfigSnapshotSchema,
    renderedPromptFragment: z.string().max(100_000).optional(),
    createdAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (run.inputSnapshot.agentId !== run.agentId) {
      context.addIssue({
        code: "custom",
        message: "Replay snapshot agent must match the run agent",
        path: ["inputSnapshot", "agentId"],
      });
    }

    const candidateIds = run.candidates.map((candidate) => candidate.memoryId);
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({
        code: "custom",
        message: "Retrieval candidate memory ids must be unique",
        path: ["candidates"],
      });
    }
    const snapshotMemoryIds = run.inputSnapshot.memories.map(
      (memory) => memory.id,
    );
    if (!sameStringSet(candidateIds, snapshotMemoryIds)) {
      context.addIssue({
        code: "custom",
        message: "Candidates must cover every snapshotted memory exactly once",
        path: ["candidates"],
      });
    }
    if (run.inputSnapshot.memories.length > run.inputSnapshot.candidateLimit) {
      context.addIssue({
        code: "custom",
        message: "Replay memories cannot exceed candidateLimit",
        path: ["inputSnapshot", "memories"],
      });
    }
    const evidenceById = new Map(
      run.inputSnapshot.evidence.map((evidence) => [evidence.id, evidence]),
    );
    run.candidates.forEach((candidate, index) => {
      if (
        candidate.evidenceIds.some(
          (id) => evidenceById.get(id)?.memoryId !== candidate.memoryId,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Candidate evidence must reference the same memory",
          path: ["candidates", index, "evidenceIds"],
        });
      }
    });
    const selected = run.candidates.filter(
      (candidate) => candidate.decision === "selected",
    );
    const ranks = selected.flatMap((candidate) =>
      candidate.selectionRank === undefined ? [] : [candidate.selectionRank],
    );
    if (new Set(ranks).size !== ranks.length) {
      context.addIssue({
        code: "custom",
        message: "Selected candidate ranks must be unique",
        path: ["candidates"],
      });
    }
    if (
      !sameStringSet(
        selected.map((candidate) => candidate.memoryId),
        run.result.selectedMemoryIds,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Selected candidates must match the recall result",
        path: ["candidates"],
      });
    }

    if (run.result.abstained) {
      if (run.evidenceBundle !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Abstained runs cannot contain an EvidenceBundle",
          path: ["evidenceBundle"],
        });
      }
      return;
    }
    if (
      run.evidenceBundle === undefined ||
      JSON.stringify(run.evidenceBundle) !==
        JSON.stringify(run.result.evidenceBundle)
    ) {
      context.addIssue({
        code: "custom",
        message: "RetrievalRun EvidenceBundle must match the recall result",
        path: ["evidenceBundle"],
      });
    }
  });
export type RetrievalRun = z.infer<typeof RetrievalRunSchema>;

export type CreateRetrievalRunInput = Omit<
  RetrievalRun,
  "id" | "evidenceBundle"
> & {
  id?: string;
};

interface RetrievalRunRow {
  id: string;
  agent_id: string;
  session_id: string | null;
  source_message_id: string | null;
  mode: MemoryRecallResult["mode"];
  candidate_count: number;
  selected_count: number;
  query_json: string;
  input_snapshot_json: string;
  stages_json: string;
  candidates_json: string;
  result_json: string;
  evidence_bundle_json: string | null;
  config_snapshot_json: string;
  rendered_prompt_fragment: string | null;
  created_at_utc: string;
}

export class RetrievalRunRepository {
  constructor(private readonly database: Database) {}

  create(input: CreateRetrievalRunInput): RetrievalRun {
    const result = MemoryRecallResultSchema.parse(input.result);
    const run = RetrievalRunSchema.parse({
      ...input,
      id: input.id ?? createEntityId("retrievalrun"),
      result,
      ...(result.abstained ? {} : { evidenceBundle: result.evidenceBundle }),
    });
    this.database
      .prepare(
        `INSERT INTO retrieval_runs(
          id, agent_id, session_id, source_message_id, mode, candidate_count,
          selected_count, query_json, input_snapshot_json, stages_json,
          candidates_json, result_json, evidence_bundle_json,
          config_snapshot_json, rendered_prompt_fragment, created_at_utc
        ) VALUES (
          @id, @agentId, @sessionId, @sourceMessageId, @mode, @candidateCount,
          @selectedCount, @queryJson, @inputSnapshotJson, @stagesJson,
          @candidatesJson, @resultJson, @evidenceBundleJson,
          @configSnapshotJson, @renderedPromptFragment, @createdAtUtc
        )`,
      )
      .run(toParameters(run));
    return run;
  }

  findById(id: string): RetrievalRun | undefined {
    const row = this.database
      .prepare("SELECT * FROM retrieval_runs WHERE id = ?")
      .get(id) as RetrievalRunRow | undefined;
    return row === undefined ? undefined : parseRow(row);
  }

  listByAgent(agentId: string, limit = 50): RetrievalRun[] {
    const bounded = boundedLimit(limit);
    return (
      this.database
        .prepare(
          `SELECT * FROM retrieval_runs
           WHERE agent_id = ?
           ORDER BY created_at_utc DESC, rowid DESC
           LIMIT ?`,
        )
        .all(agentId, bounded) as RetrievalRunRow[]
    ).map(parseRow);
  }

  getReplayInput(id: string): RetrievalReplayInput | undefined {
    const row = this.database
      .prepare("SELECT input_snapshot_json FROM retrieval_runs WHERE id = ?")
      .get(id) as { input_snapshot_json: string } | undefined;
    return row === undefined
      ? undefined
      : RetrievalReplayInputSchema.parse(
          JSON.parse(row.input_snapshot_json) as unknown,
        );
  }
}

function toParameters(run: RetrievalRun): Record<string, unknown> {
  return {
    id: run.id,
    agentId: run.agentId,
    sessionId: run.sessionId ?? null,
    sourceMessageId: run.sourceMessageId ?? null,
    mode: run.result.mode,
    candidateCount: run.candidates.length,
    selectedCount: run.result.selectedMemoryIds.length,
    queryJson: JSON.stringify(run.inputSnapshot.query),
    inputSnapshotJson: JSON.stringify(run.inputSnapshot),
    stagesJson: JSON.stringify(run.stages),
    candidatesJson: JSON.stringify(run.candidates),
    resultJson: JSON.stringify(run.result),
    evidenceBundleJson:
      run.evidenceBundle === undefined
        ? null
        : JSON.stringify(run.evidenceBundle),
    configSnapshotJson: JSON.stringify(run.configSnapshot),
    renderedPromptFragment: run.renderedPromptFragment ?? null,
    createdAtUtc: run.createdAtUtc,
  };
}

function parseRow(row: RetrievalRunRow): RetrievalRun {
  const inputSnapshot = RetrievalReplayInputSchema.parse(
    JSON.parse(row.input_snapshot_json) as unknown,
  );
  const query = MemoryRecallQuerySchema.parse(
    JSON.parse(row.query_json) as unknown,
  );
  if (JSON.stringify(query) !== JSON.stringify(inputSnapshot.query)) {
    throw new TypeError(
      "RetrievalRun query column does not match input snapshot",
    );
  }
  const result = MemoryRecallResultSchema.parse(
    JSON.parse(row.result_json) as unknown,
  );
  const run = RetrievalRunSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.source_message_id === null
      ? {}
      : { sourceMessageId: row.source_message_id }),
    inputSnapshot,
    stages: JSON.parse(row.stages_json) as unknown,
    candidates: JSON.parse(row.candidates_json) as unknown,
    result,
    ...(row.evidence_bundle_json === null
      ? {}
      : {
          evidenceBundle: JSON.parse(
            row.evidence_bundle_json,
          ) as EvidenceBundle,
        }),
    configSnapshot: JSON.parse(row.config_snapshot_json) as unknown,
    ...(row.rendered_prompt_fragment === null
      ? {}
      : { renderedPromptFragment: row.rendered_prompt_fragment }),
    createdAtUtc: row.created_at_utc,
  });
  if (
    run.result.mode !== row.mode ||
    run.candidates.length !== row.candidate_count ||
    run.result.selectedMemoryIds.length !== row.selected_count
  ) {
    throw new TypeError("RetrievalRun indexed columns do not match snapshots");
  }
  return run;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function findSensitiveConfigPath(
  value: JsonValue,
  path: Array<string | number> = [],
): Array<string | number> | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSensitiveConfigPath(item, [...path, index]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (
      /^(?:api[_-]?key|secret|access[_-]?token|password|authorization)$/iu.test(
        key,
      )
    ) {
      return [...path, key];
    }
    const found = findSensitiveConfigPath(item, [...path, key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function boundedLimit(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("Retrieval run list limit must be finite");
  }
  return Math.max(1, Math.min(500, Math.trunc(value)));
}
