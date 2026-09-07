import { z } from "zod";

import { MemoryEvidenceSchema } from "./memory-evidence.js";
import { MemoryNamespaceSchema } from "./memory.js";
import {
  EntityIdSchema,
  ReasonCodeSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import {
  MemoryRecallQuerySchema,
  MemoryRecallResultSchema,
  RetrievedMemoryEvidenceSchema,
} from "./retrieval.js";
import { TemporalStatusSchema } from "./temporal.js";

export const MemoryRecallRolloutModeSchema = z.enum([
  "legacy",
  "shadow",
  "enforced",
]);
export type MemoryRecallRolloutMode = z.infer<
  typeof MemoryRecallRolloutModeSchema
>;

export const MemoryRecallPreviewRequestSchema = z
  .object({ message: z.string().trim().min(1).max(20_000) })
  .strict();
export type MemoryRecallPreviewRequest = z.infer<
  typeof MemoryRecallPreviewRequestSchema
>;

export const MemoryRecallPreviewCandidateSchema = z
  .object({
    memoryId: EntityIdSchema,
    content: z.string().trim().min(1).max(2_000),
    namespace: MemoryNamespaceSchema,
    temporalStatus: TemporalStatusSchema,
    evidenceIds: z.array(EntityIdSchema).max(20),
    score: UnitIntervalSchema,
    selected: z.boolean(),
    rejectionReason: ReasonCodeSchema.optional(),
  })
  .strict();
export type MemoryRecallPreviewCandidate = z.infer<
  typeof MemoryRecallPreviewCandidateSchema
>;

export const MemoryRecallPreviewRejectionSchema = z
  .object({
    targetType: z.enum(["memory", "evidence"]),
    targetId: EntityIdSchema,
    memoryId: EntityIdSchema,
    reasonCode: ReasonCodeSchema,
    score: UnitIntervalSchema.optional(),
  })
  .strict();
export type MemoryRecallPreviewRejection = z.infer<
  typeof MemoryRecallPreviewRejectionSchema
>;

export const MemoryRecallPreviewStrategySchema = z
  .object({
    name: z.enum([
      "keyword_evidence_v1",
      "continuity_hierarchy_v1",
      "continuity_context_v2",
    ]),
    minimumScore: UnitIntervalSchema,
    maxEvidence: z.number().int().min(1).max(8),
    candidateLimit: z.number().int().min(1).max(500),
  })
  .strict();
export type MemoryRecallPreviewStrategy = z.infer<
  typeof MemoryRecallPreviewStrategySchema
>;

export const MemoryRecallTimingSchema = z
  .object({
    evaluatedAtUtc: UtcDateTimeSchema,
    durationMs: z.number().finite().nonnegative(),
  })
  .strict();
export type MemoryRecallTiming = z.infer<typeof MemoryRecallTimingSchema>;

export const MemoryRecallPreviewResponseSchema = z
  .object({
    agentId: EntityIdSchema,
    query: MemoryRecallQuerySchema,
    candidateCount: z.number().int().nonnegative().max(500),
    evidenceCount: z.number().int().nonnegative().max(500),
    candidates: z.array(MemoryRecallPreviewCandidateSchema).max(500),
    selectedItems: z.array(RetrievedMemoryEvidenceSchema).max(8),
    evidence: z.array(MemoryEvidenceSchema).max(8),
    rejections: z.array(MemoryRecallPreviewRejectionSchema).max(1_000),
    strategy: MemoryRecallPreviewStrategySchema,
    timing: MemoryRecallTimingSchema,
    result: MemoryRecallResultSchema,
  })
  .strict();
export type MemoryRecallPreviewResponse = z.infer<
  typeof MemoryRecallPreviewResponseSchema
>;

export const MemoryRecallRuntimeDiagnosticSchema = z
  .object({
    rolloutMode: MemoryRecallRolloutModeSchema,
    promptStrategy: z.enum(["legacy_active", "evidence_selected"]),
    legacyPromptMemoryIds: z.array(EntityIdSchema).max(12),
    promptMemoryIds: z.array(EntityIdSchema).max(12),
    selectedMemoryIds: z.array(EntityIdSchema).max(8),
    selectedEvidenceIds: z.array(EntityIdSchema).max(8),
    rejectedMemoryIds: z.array(EntityIdSchema).max(500),
    recallMode: z.enum([
      "event_card",
      "verbatim_quote",
      "date_digest",
      "basic_memory",
      "none",
    ]),
    score: UnitIntervalSchema,
    abstained: z.boolean(),
    abstentionReason: ReasonCodeSchema.optional(),
    durationMs: z.number().finite().nonnegative(),
  })
  .strict();
export type MemoryRecallRuntimeDiagnostic = z.infer<
  typeof MemoryRecallRuntimeDiagnosticSchema
>;
