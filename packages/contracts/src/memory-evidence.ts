import { z } from "zod";

import { EntityIdSchema, UtcDateTimeSchema } from "./primitives.js";

export const ContextAttachmentTypeSchema = z.enum([
  "user_visible_text",
  "runtime_time_context",
  "runtime_state_context",
  "schedule_context",
  "memory_evidence",
  "system_policy",
]);
export type ContextAttachmentType = z.infer<typeof ContextAttachmentTypeSchema>;

export const FormalEvidenceContextAttachmentTypeSchema =
  z.literal("user_visible_text");
export type FormalEvidenceContextAttachmentType = z.infer<
  typeof FormalEvidenceContextAttachmentTypeSchema
>;

export const RuntimeContextAttachmentTypeSchema = z.enum([
  "runtime_time_context",
  "runtime_state_context",
  "schedule_context",
  "memory_evidence",
  "system_policy",
]);
export type RuntimeContextAttachmentType = z.infer<
  typeof RuntimeContextAttachmentTypeSchema
>;

export function isFormalEvidenceContextAttachmentType(
  attachmentType: ContextAttachmentType,
): attachmentType is FormalEvidenceContextAttachmentType {
  return attachmentType === "user_visible_text";
}

export const MemoryEvidenceSourceTypeSchema = z.enum([
  "message",
  "activity_event",
  "schedule_event",
  "character_source",
  "manual",
]);
export type MemoryEvidenceSourceType = z.infer<
  typeof MemoryEvidenceSourceTypeSchema
>;

export const FormalMemoryEvidenceSourceTypeSchema = z.enum([
  "message",
  "activity_event",
  "character_source",
  "manual",
]);
export type FormalMemoryEvidenceSourceType = z.infer<
  typeof FormalMemoryEvidenceSourceTypeSchema
>;

export function isFormalMemoryEvidenceSourceType(
  sourceType: MemoryEvidenceSourceType,
): sourceType is FormalMemoryEvidenceSourceType {
  return sourceType !== "schedule_event";
}

const EvidenceDetailShape = {
  sourceId: EntityIdSchema,
  quote: z.string().trim().min(1).max(2_000).optional(),
  contextSummary: z.string().trim().min(1).max(1_000).optional(),
} as const;

/**
 * Evidence proposed before a Memory exists. Runtime-only prompt attachments and
 * schedule projections are intentionally not accepted by this boundary.
 */
export const MemoryEvidenceInputSchema = z
  .object({
    sourceType: FormalMemoryEvidenceSourceTypeSchema,
    ...EvidenceDetailShape,
    recordedAtUtc: UtcDateTimeSchema.optional(),
  })
  .strict();
export type MemoryEvidenceInput = z.infer<typeof MemoryEvidenceInputSchema>;

export const MemoryEvidenceSchema = z
  .object({
    id: EntityIdSchema,
    memoryId: EntityIdSchema,
    sourceType: MemoryEvidenceSourceTypeSchema,
    ...EvidenceDetailShape,
    recordedAtUtc: UtcDateTimeSchema,
  })
  .strict();
export type MemoryEvidence = z.infer<typeof MemoryEvidenceSchema>;
