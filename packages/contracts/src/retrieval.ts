import { z } from "zod";

import { ConversationContextPlanSchema } from "./conversation-context-plan.js";

import {
  MemoryAttributionSchema,
  MemoryCertaintySchema,
  MemoryKindSchema,
  MemoryNamespaceSchema,
  MemoryStabilitySchema,
} from "./memory.js";
import { MemoryEvidenceSchema } from "./memory-evidence.js";
import {
  EntityIdSchema,
  ShortTextSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
  isChronologicalRange,
} from "./primitives.js";
import { TemporalMetadataSchema, TemporalStatusSchema } from "./temporal.js";

export const MemoryRecallModeSchema = z.enum([
  "event_card",
  "verbatim_quote",
  "date_digest",
  "basic_memory",
  "none",
]);
export type MemoryRecallMode = z.infer<typeof MemoryRecallModeSchema>;

export const EvidenceBundleModeSchema = z.enum([
  "event_card",
  "verbatim_quote",
  "date_digest",
  "basic_memory",
]);
export type EvidenceBundleMode = z.infer<typeof EvidenceBundleModeSchema>;

export const TemporalQueryRangeSchema = z
  .object({
    fromUtc: UtcDateTimeSchema,
    toUtc: UtcDateTimeSchema,
    statuses: z.array(TemporalStatusSchema).min(1).max(5).optional(),
  })
  .strict()
  .refine((range) => isChronologicalRange(range.fromUtc, range.toUtc), {
    message: "toUtc must be later than fromUtc",
    path: ["toUtc"],
  });
export type TemporalQueryRange = z.infer<typeof TemporalQueryRangeSchema>;

export const MemoryRecallQuerySchema = z
  .object({
    query: z.string().trim().min(1).max(20_000),
    namespaces: z
      .array(MemoryNamespaceSchema)
      .min(1)
      .max(5)
      .refine((values) => new Set(values).size === values.length, {
        message: "namespace filters must be unique",
      })
      .optional(),
    timeRange: TemporalQueryRangeSchema.optional(),
    minimumScore: UnitIntervalSchema.optional(),
    /** Retrieval-only candidates; query remains the original fact/intent input. */
    contextPlan: ConversationContextPlanSchema.optional(),
  })
  .strict()
  .refine(
    (query) =>
      query.contextPlan === undefined ||
      query.contextPlan.originalQuery.trim() === query.query,
    {
      message: "Recall context must preserve the original query",
      path: ["contextPlan", "originalQuery"],
    },
  );
export type MemoryRecallQuery = z.infer<typeof MemoryRecallQuerySchema>;

export const RetrievalScoreBreakdownSchema = z
  .object({
    lexical: UnitIntervalSchema,
    tag: UnitIntervalSchema,
    importance: UnitIntervalSchema,
    recency: UnitIntervalSchema,
    temporal: UnitIntervalSchema,
    namespace: UnitIntervalSchema,
  })
  .strict();
export type RetrievalScoreBreakdown = z.infer<
  typeof RetrievalScoreBreakdownSchema
>;

export const RetrievedMemoryEvidenceSchema = z
  .object({
    memoryId: EntityIdSchema,
    memoryContent: z.string().trim().min(1).max(2_000),
    memoryKind: MemoryKindSchema,
    namespace: MemoryNamespaceSchema,
    certainty: MemoryCertaintySchema,
    attribution: MemoryAttributionSchema,
    stability: MemoryStabilitySchema,
    temporalMetadata: TemporalMetadataSchema.optional(),
    evidence: MemoryEvidenceSchema,
    score: UnitIntervalSchema,
    scoreBreakdown: RetrievalScoreBreakdownSchema,
  })
  .strict();
export type RetrievedMemoryEvidence = z.infer<
  typeof RetrievedMemoryEvidenceSchema
>;

export const EvidenceBundleSchema = z
  .object({
    query: z.string().trim().min(1).max(20_000),
    mode: EvidenceBundleModeSchema,
    generatedAtUtc: UtcDateTimeSchema,
    score: UnitIntervalSchema,
    evidence: z.array(RetrievedMemoryEvidenceSchema).min(1).max(8),
  })
  .strict()
  .refine(
    (bundle) =>
      new Set(bundle.evidence.map((item) => item.evidence.id)).size ===
      bundle.evidence.length,
    {
      message: "EvidenceBundle evidence ids must be unique",
      path: ["evidence"],
    },
  );
export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

const SelectedMemoryRecallResultSchema = z
  .object({
    mode: EvidenceBundleModeSchema,
    selectedMemoryIds: z.array(EntityIdSchema).min(1).max(8),
    selectedEvidenceIds: z.array(EntityIdSchema).min(1).max(8),
    score: UnitIntervalSchema,
    abstained: z.literal(false),
    evidenceBundle: EvidenceBundleSchema,
  })
  .strict()
  .superRefine((result, context) => {
    const memoryIds = [
      ...new Set(result.evidenceBundle.evidence.map((item) => item.memoryId)),
    ];
    const evidenceIds = result.evidenceBundle.evidence.map(
      (item) => item.evidence.id,
    );
    if (
      result.mode !== result.evidenceBundle.mode ||
      result.score !== result.evidenceBundle.score
    ) {
      context.addIssue({
        code: "custom",
        message: "Recall result metadata must match its EvidenceBundle",
        path: ["evidenceBundle"],
      });
    }
    if (memoryIds.join("\u0000") !== result.selectedMemoryIds.join("\u0000")) {
      context.addIssue({
        code: "custom",
        message: "selectedMemoryIds must match the EvidenceBundle",
        path: ["selectedMemoryIds"],
      });
    }
    if (
      evidenceIds.join("\u0000") !== result.selectedEvidenceIds.join("\u0000")
    ) {
      context.addIssue({
        code: "custom",
        message: "selectedEvidenceIds must match the EvidenceBundle",
        path: ["selectedEvidenceIds"],
      });
    }
  });

const AbstainedMemoryRecallResultSchema = z
  .object({
    mode: z.literal("none"),
    selectedMemoryIds: z.array(EntityIdSchema).max(0),
    selectedEvidenceIds: z.array(EntityIdSchema).max(0),
    score: UnitIntervalSchema,
    abstained: z.literal(true),
    abstentionReason: ShortTextSchema,
  })
  .strict();

export const MemoryRecallResultSchema = z.union([
  SelectedMemoryRecallResultSchema,
  AbstainedMemoryRecallResultSchema,
]);
export type MemoryRecallResult = z.infer<typeof MemoryRecallResultSchema>;
