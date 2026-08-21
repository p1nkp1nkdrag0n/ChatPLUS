import { z } from "zod";

import {
  MemoryAttributionSchema,
  MemoryCertaintySchema,
  MemoryNamespaceSchema,
} from "./memory.js";
import {
  EntityIdSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import { TemporalMetadataSchema, TemporalStatusSchema } from "./temporal.js";

export const ContinuityEvidenceSourceTypeSchema = z.enum([
  "message_archive",
  "activity_event",
  "memory_evidence",
  "domain_event",
]);
export type ContinuityEvidenceSourceType = z.infer<
  typeof ContinuityEvidenceSourceTypeSchema
>;

export const ContinuityEvidenceReliabilitySchema = z.enum([
  "fact",
  "reported",
  "context",
]);
export type ContinuityEvidenceReliability = z.infer<
  typeof ContinuityEvidenceReliabilitySchema
>;

export const ContinuityEvidenceRefSchema = z
  .object({
    id: EntityIdSchema,
    sourceType: ContinuityEvidenceSourceTypeSchema,
    sourceId: EntityIdSchema,
    quote: z.string().trim().min(1).max(2_000).optional(),
    contextSummary: z.string().trim().min(1).max(1_000).optional(),
    temporalStatus: TemporalStatusSchema.optional(),
    reliability: ContinuityEvidenceReliabilitySchema,
    recordedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.quote === undefined && evidence.contextSummary === undefined) {
      context.addIssue({
        code: "custom",
        message: "Continuity evidence requires a quote or context summary",
        path: ["contextSummary"],
      });
    }
    if (
      evidence.sourceType === "message_archive" &&
      evidence.reliability === "fact"
    ) {
      context.addIssue({
        code: "custom",
        message: "A message is reported evidence, not an observed fact",
        path: ["reliability"],
      });
    }
  });
export type ContinuityEvidenceRef = z.infer<typeof ContinuityEvidenceRefSchema>;

export const EventCardKindSchema = z.enum([
  "conversation",
  "activity",
  "user_event",
  "shared_experience",
  "relationship_change",
  "goal",
  "commitment",
]);
export type EventCardKind = z.infer<typeof EventCardKindSchema>;

export const EventCardSourceKindSchema = z.enum([
  "checkpoint",
  "activity_event",
  "memory",
  "autobiography_entry",
  "domain_event",
]);
export type EventCardSourceKind = z.infer<typeof EventCardSourceKindSchema>;

export const EventCardStatusSchema = z.enum([
  "active",
  "superseded",
  "archived",
]);
export type EventCardStatus = z.infer<typeof EventCardStatusSchema>;

const EventCardContentShape = {
  cardKind: EventCardKindSchema,
  sourceKind: EventCardSourceKindSchema,
  sourceId: EntityIdSchema,
  dedupeKey: z.string().trim().min(1).max(240),
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().min(1).max(2_000),
  tags: z
    .array(z.string().trim().min(1).max(64))
    .max(20)
    .refine((values) => new Set(values).size === values.length, {
      message: "Event card tags must be unique",
    }),
  namespace: MemoryNamespaceSchema,
  certainty: MemoryCertaintySchema,
  attribution: MemoryAttributionSchema,
  temporalMetadata: TemporalMetadataSchema,
  importance: UnitIntervalSchema,
  evidence: z
    .array(ContinuityEvidenceRefSchema)
    .min(1)
    .max(20)
    .refine(
      (values) => new Set(values.map((item) => item.id)).size === values.length,
      { message: "Event card evidence ids must be unique" },
    ),
} as const;

function addEventCardIssues(
  card: {
    attribution: z.infer<typeof MemoryAttributionSchema>;
    temporalMetadata: z.infer<typeof TemporalMetadataSchema>;
    evidence: z.infer<typeof ContinuityEvidenceRefSchema>[];
  },
  context: z.core.$RefinementCtx<unknown>,
): void {
  if (
    card.temporalMetadata.temporalStatus === "occurred" &&
    !card.evidence.some(
      (item) => item.reliability === "fact" || item.reliability === "reported",
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "An occurred event card requires occurrence evidence",
      path: ["evidence"],
    });
  }
  if (
    card.attribution === "user_explicit" &&
    !card.evidence.some(
      (item) =>
        item.sourceType === "message_archive" ||
        item.sourceType === "memory_evidence",
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "Explicit user attribution requires user-visible evidence",
      path: ["evidence"],
    });
  }
}

export const EventCardDraftSchema = z
  .object(EventCardContentShape)
  .strict()
  .superRefine(addEventCardIssues);
export type EventCardDraft = z.infer<typeof EventCardDraftSchema>;

export const EventCardSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    checkpointId: EntityIdSchema.optional(),
    ...EventCardContentShape,
    sourceEvidenceIds: z
      .array(EntityIdSchema)
      .min(1)
      .max(20)
      .refine((values) => new Set(values).size === values.length, {
        message: "sourceEvidenceIds must be unique",
      }),
    status: EventCardStatusSchema,
    indexVersion: z.number().int().positive(),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((card, context) => {
    addEventCardIssues(card, context);
    const evidenceIds = card.evidence.map((item) => item.id);
    if (evidenceIds.join("\u0000") !== card.sourceEvidenceIds.join("\u0000")) {
      context.addIssue({
        code: "custom",
        message: "sourceEvidenceIds must match evidence in order",
        path: ["sourceEvidenceIds"],
      });
    }
  });
export type EventCard = z.infer<typeof EventCardSchema>;
