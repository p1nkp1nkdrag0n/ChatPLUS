import { z } from "zod";

import {
  EntityIdSchema,
  ReasonCodeSchema,
  ShortTextSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import { FieldOriginSchema } from "./provenance.js";
import { MemoryEvidenceInputSchema } from "./memory-evidence.js";
import { TemporalMetadataSchema } from "./temporal.js";

export const MemoryKindSchema = z.enum([
  "semantic",
  "episodic",
  "relationship",
  "commitment",
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemoryNamespaceSchema = z.enum([
  "canon",
  "character_self",
  "user_model",
  "shared_relationship",
  "runtime_simulation",
]);
export type MemoryNamespace = z.infer<typeof MemoryNamespaceSchema>;

export const MemoryCertaintySchema = z.enum([
  "explicit",
  "inferred",
  "uncertain",
]);
export type MemoryCertainty = z.infer<typeof MemoryCertaintySchema>;

export const MemoryAttributionSchema = z.enum([
  "user_explicit",
  "character_decision",
  "simulation_event",
  "model_inference",
  "mixed",
]);
export type MemoryAttribution = z.infer<typeof MemoryAttributionSchema>;

export const MemoryStabilitySchema = z.enum([
  "one_off",
  "situational",
  "stable",
]);
export type MemoryStability = z.infer<typeof MemoryStabilitySchema>;

export const MemoryStatusSchema = z.enum([
  "active",
  "aging",
  "archived",
  "superseded",
  "merged",
  "forgotten",
  "needs_review",
]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

export const MemoryClaimDispositionSchema = z.enum([
  "affirmed",
  "negated",
  "cancelled",
  "completed",
]);
export type MemoryClaimDisposition = z.infer<
  typeof MemoryClaimDispositionSchema
>;

export const MemoryClaimSchema = z
  .object({
    subjectKey: z.string().trim().min(1).max(240),
    disposition: MemoryClaimDispositionSchema,
    recordedAtUtc: UtcDateTimeSchema,
  })
  .strict();
export type MemoryClaim = z.infer<typeof MemoryClaimSchema>;

const MemoryContentShape = {
  kind: MemoryKindSchema,
  content: z.string().trim().min(1).max(2_000),
  importance: UnitIntervalSchema,
  confidence: UnitIntervalSchema,
  occurredAtUtc: UtcDateTimeSchema.optional(),
  expiresAtUtc: UtcDateTimeSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(20),
  sourceMessageIds: z.array(EntityIdSchema).max(20),
  sourceActivityEventIds: z.array(EntityIdSchema).max(20),
  origin: FieldOriginSchema,
  namespace: MemoryNamespaceSchema.optional(),
  certainty: MemoryCertaintySchema.optional(),
  attribution: MemoryAttributionSchema.optional(),
  stability: MemoryStabilitySchema.optional(),
  claim: MemoryClaimSchema.optional(),
  temporalMetadata: TemporalMetadataSchema.optional(),
  /** @deprecated Use temporalMetadata. */
  temporal: TemporalMetadataSchema.optional(),
} as const;

export const MemoryCandidateSchema = z
  .object({
    ...MemoryContentShape,
    evidence: z.array(MemoryEvidenceInputSchema).max(20).optional(),
    shouldWrite: z.boolean().optional(),
    forbiddenOverclaims: z
      .array(z.string().trim().min(1).max(240))
      .max(20)
      .optional(),
    reasonCode: ReasonCodeSchema,
    reasonSummary: ShortTextSchema,
  })
  .strict()
  .superRefine((memory, context) => {
    if (
      memory.temporalMetadata !== undefined &&
      memory.temporal !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Use temporalMetadata or legacy temporal, not both",
        path: ["temporalMetadata"],
      });
    }
    if (
      memory.attribution === "model_inference" &&
      memory.certainty === "explicit"
    ) {
      context.addIssue({
        code: "custom",
        message: "A model inference cannot be explicit",
        path: ["certainty"],
      });
    }
    if (
      memory.occurredAtUtc !== undefined &&
      (memory.temporalMetadata ?? memory.temporal)?.temporalStatus === "planned"
    ) {
      context.addIssue({
        code: "custom",
        message: "occurredAtUtc cannot describe a merely planned event",
        path: ["occurredAtUtc"],
      });
    }
  })
  .refine(
    (memory) =>
      memory.expiresAtUtc === undefined ||
      memory.occurredAtUtc === undefined ||
      Date.parse(memory.expiresAtUtc) > Date.parse(memory.occurredAtUtc),
    {
      message: "expiresAtUtc must be later than occurredAtUtc",
      path: ["expiresAtUtc"],
    },
  );
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

/** Alias retained for feature modules that use proposal terminology. */
export const MemoryProposalSchema = MemoryCandidateSchema;
export type MemoryProposal = MemoryCandidate;

export const MemorySchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    ...MemoryContentShape,
    status: MemoryStatusSchema,
    dedupeKey: z.string().trim().min(1).max(240),
    supersededById: EntityIdSchema.optional(),
    mergedIntoId: EntityIdSchema.optional(),
    lastReinforcedAtUtc: UtcDateTimeSchema.optional(),
    lifecycleUpdatedAtUtc: UtcDateTimeSchema.optional(),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((memory, context) => {
    if (
      memory.expiresAtUtc !== undefined &&
      memory.occurredAtUtc !== undefined &&
      Date.parse(memory.expiresAtUtc) <= Date.parse(memory.occurredAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "expiresAtUtc must be later than occurredAtUtc",
        path: ["expiresAtUtc"],
      });
    }
    if (memory.status === "superseded" && memory.supersededById === undefined) {
      context.addIssue({
        code: "custom",
        message: "A superseded memory must reference its replacement",
        path: ["supersededById"],
      });
    }
    if (memory.status === "merged" && memory.mergedIntoId === undefined) {
      context.addIssue({
        code: "custom",
        message: "A merged memory must reference its merge target",
        path: ["mergedIntoId"],
      });
    }
    if (
      memory.temporalMetadata !== undefined &&
      memory.temporal !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Use temporalMetadata or legacy temporal, not both",
        path: ["temporalMetadata"],
      });
    }
    if (
      memory.attribution === "model_inference" &&
      memory.certainty === "explicit"
    ) {
      context.addIssue({
        code: "custom",
        message: "A model inference cannot be explicit",
        path: ["certainty"],
      });
    }
    if (
      memory.occurredAtUtc !== undefined &&
      (memory.temporalMetadata ?? memory.temporal)?.temporalStatus === "planned"
    ) {
      context.addIssue({
        code: "custom",
        message: "occurredAtUtc cannot describe a merely planned event",
        path: ["occurredAtUtc"],
      });
    }
  });
export type Memory = z.infer<typeof MemorySchema>;
