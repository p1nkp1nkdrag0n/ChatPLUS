import { z } from "zod";

import { KeepsakeKindSchema, KeepsakeSourceTypeSchema } from "./keepsake.js";
import {
  EntityIdSchema,
  ShortTextSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import { LetterDirectionSchema, LetterStatusSchema } from "./correspondence.js";

const ArchiveBaseShape = {
  id: EntityIdSchema,
  agentId: EntityIdSchema,
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().min(1).max(2_000),
  effectiveAtUtc: UtcDateTimeSchema,
  recordedAtUtc: UtcDateTimeSchema,
  href: z.string().trim().min(1).max(1_000),
  sourceIds: z.array(EntityIdSchema).min(1).max(72),
} as const;

export const RelationshipArchiveLetterEntrySchema = z
  .object({
    ...ArchiveBaseShape,
    entryType: z.literal("letter"),
    letterId: EntityIdSchema,
    threadId: EntityIdSchema,
    direction: LetterDirectionSchema,
    status: LetterStatusSchema,
    postmark: ShortTextSchema,
    waitingDays: z.number().int().nonnegative().max(3_650),
    previewText: z.string().trim().min(1).max(240).optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.direction === "agent_to_user" &&
      entry.status !== "read" &&
      entry.previewText !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "An unopened agent reply cannot expose an archive preview",
        path: ["previewText"],
      });
    }
    if (!entry.sourceIds.includes(entry.letterId)) {
      context.addIssue({
        code: "custom",
        message: "A letter archive entry must cite its letter id",
        path: ["sourceIds"],
      });
    }
  });
export type RelationshipArchiveLetterEntry = z.infer<
  typeof RelationshipArchiveLetterEntrySchema
>;

export const RelationshipArchiveTurningPointEntrySchema = z
  .object({
    ...ArchiveBaseShape,
    entryType: z.literal("turning_point"),
    sourceType: z.enum([
      "life_outcome",
      "relationship_milestone",
      "reflection",
    ]),
    significance: z.number().finite().min(0).max(1),
  })
  .strict();
export type RelationshipArchiveTurningPointEntry = z.infer<
  typeof RelationshipArchiveTurningPointEntrySchema
>;

export const RelationshipArchiveLifeEntrySchema = z
  .object({
    ...ArchiveBaseShape,
    entryType: z.literal("life"),
    periodLabel: ShortTextSchema,
  })
  .strict();
export type RelationshipArchiveLifeEntry = z.infer<
  typeof RelationshipArchiveLifeEntrySchema
>;

export const RelationshipArchiveKeepsakeEntrySchema = z
  .object({
    ...ArchiveBaseShape,
    entryType: z.literal("keepsake"),
    keepsakeId: EntityIdSchema,
    keepsakeKind: KeepsakeKindSchema,
    thumbnailUrl: z.string().trim().min(1).max(1_000),
  })
  .strict()
  .superRefine((entry, context) => {
    if (!entry.sourceIds.includes(entry.keepsakeId)) {
      context.addIssue({
        code: "custom",
        message: "A keepsake archive entry must cite its keepsake id",
        path: ["sourceIds"],
      });
    }
  });
export type RelationshipArchiveKeepsakeEntry = z.infer<
  typeof RelationshipArchiveKeepsakeEntrySchema
>;

export const RelationshipArchiveEntrySchema = z.union([
  RelationshipArchiveLetterEntrySchema,
  RelationshipArchiveTurningPointEntrySchema,
  RelationshipArchiveLifeEntrySchema,
  RelationshipArchiveKeepsakeEntrySchema,
]);
export type RelationshipArchiveEntry = z.infer<
  typeof RelationshipArchiveEntrySchema
>;

export const RelationshipArchiveFilterSchema = z.enum([
  "all",
  "correspondence",
  "turning_points",
  "life",
  "keepsakes",
]);
export type RelationshipArchiveFilter = z.infer<
  typeof RelationshipArchiveFilterSchema
>;

export const RelationshipArchiveEntryIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^(?:letter|relationship_milestone|outcome_record|life_outcome|reflection|domain_event|keepsake):[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u,
    "Expected a valid relationship archive entry id",
  );
export type RelationshipArchiveEntryId = z.infer<
  typeof RelationshipArchiveEntryIdSchema
>;

const RelationshipArchivePreviewTextFlagSchema = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((value) => (typeof value === "boolean" ? value : value === "true"))
  .default(true);

export const RelationshipArchiveQuerySchema = z
  .object({
    filter: RelationshipArchiveFilterSchema.default("all"),
    cursor: z.string().trim().min(1).max(1_000).optional(),
    entryId: RelationshipArchiveEntryIdSchema.optional(),
    includePreviewText: RelationshipArchivePreviewTextFlagSchema,
    limit: z.coerce.number().int().min(1).max(100).default(40),
  })
  .strict()
  .refine(
    (query) => query.cursor === undefined || query.entryId === undefined,
    {
      message: "cursor and entryId are mutually exclusive",
      path: ["entryId"],
    },
  );
export type RelationshipArchiveQuery = z.infer<
  typeof RelationshipArchiveQuerySchema
>;

export const RelationshipArchivePageResponseSchema = z
  .object({
    items: z.array(RelationshipArchiveEntrySchema).max(100),
    nextCursor: z.string().trim().min(1).max(1_000).optional(),
    serverTimeUtc: UtcDateTimeSchema,
  })
  .strict();
export type RelationshipArchivePageResponse = z.infer<
  typeof RelationshipArchivePageResponseSchema
>;

export const ShareRedactionSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    label: z.enum(["name", "place", "custom"]),
  })
  .strict()
  .refine((redaction) => redaction.start < redaction.end, {
    message: "A redaction range must be non-empty",
    path: ["end"],
  });
export type ShareRedaction = z.infer<typeof ShareRedactionSchema>;

export const ShareComposerSelectionSchema = z
  .object({
    templateVersion: z.literal("relationship-share-v1"),
    letterId: EntityIdSchema.optional(),
    keepsakeId: EntityIdSchema.optional(),
    includeEnvelope: z.boolean().default(true),
    includePostmark: z.boolean().default(true),
    includeWaitingDays: z.boolean().default(true),
    includeKeepsake: z.boolean().default(false),
    includeExcerpt: z.boolean().default(false),
    excerpt: z.string().min(1).max(500).optional(),
    redactions: z.array(ShareRedactionSchema).max(32).default([]),
  })
  .strict()
  .superRefine((selection, context) => {
    if (selection.includeExcerpt) {
      if (selection.letterId === undefined || selection.excerpt === undefined) {
        context.addIssue({
          code: "custom",
          message:
            "A shared excerpt requires an explicitly selected letter and text",
          path: ["excerpt"],
        });
      }
    } else if (
      selection.excerpt !== undefined ||
      selection.redactions.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Excerpt text and redactions are forbidden while sharing is off",
        path: ["includeExcerpt"],
      });
    }
    if (selection.includeKeepsake && selection.keepsakeId === undefined) {
      context.addIssue({
        code: "custom",
        message: "Including a keepsake requires an explicit keepsake selection",
        path: ["keepsakeId"],
      });
    }
    if (selection.excerpt !== undefined) {
      let previousEnd = 0;
      for (const [index, redaction] of selection.redactions.entries()) {
        if (redaction.end > selection.excerpt.length) {
          context.addIssue({
            code: "custom",
            message: "A redaction range must stay inside the selected excerpt",
            path: ["redactions", index, "end"],
          });
        }
        if (index > 0 && redaction.start < previousEnd) {
          context.addIssue({
            code: "custom",
            message: "Redaction ranges must be ordered and non-overlapping",
            path: ["redactions", index, "start"],
          });
        }
        previousEnd = redaction.end;
      }
    }
  });
export type ShareComposerSelection = z.infer<
  typeof ShareComposerSelectionSchema
>;

export const RelationshipShareEnvelopeSchema = z
  .object({
    letterId: EntityIdSchema,
    direction: LetterDirectionSchema,
    status: LetterStatusSchema,
    envelope: z.boolean(),
    postmark: ShortTextSchema.optional(),
    waitingDays: z.number().int().nonnegative().max(3_650).optional(),
  })
  .strict();
export type RelationshipShareEnvelope = z.infer<
  typeof RelationshipShareEnvelopeSchema
>;

export const RelationshipShareKeepsakeSchema = z
  .object({
    keepsakeId: EntityIdSchema,
    title: z.string().trim().min(1).max(160),
    kind: KeepsakeKindSchema,
    assetUrl: z.string().trim().min(1).max(1_000),
  })
  .strict();
export type RelationshipShareKeepsake = z.infer<
  typeof RelationshipShareKeepsakeSchema
>;

/**
 * A local-only, deterministic render projection. It deliberately has no URL,
 * upload destination, full body, ciphertext, prompt, or model-authored fields.
 */
export const RelationshipShareProjectionSchema = z
  .object({
    version: z.literal("relationship_share_projection_v1"),
    templateVersion: z.literal("relationship-share-v1"),
    exportMode: z.literal("local_png"),
    agentId: EntityIdSchema,
    generatedAtUtc: UtcDateTimeSchema,
    envelope: RelationshipShareEnvelopeSchema.optional(),
    keepsake: RelationshipShareKeepsakeSchema.optional(),
    redactedExcerpt: z.string().min(1).max(500).optional(),
    sourceIds: z.array(EntityIdSchema).min(1).max(2),
  })
  .strict()
  .superRefine((projection, context) => {
    if (
      projection.envelope !== undefined &&
      !projection.sourceIds.includes(projection.envelope.letterId)
    ) {
      context.addIssue({
        code: "custom",
        message: "The share projection must cite its selected letter",
        path: ["sourceIds"],
      });
    }
    if (
      projection.keepsake !== undefined &&
      !projection.sourceIds.includes(projection.keepsake.keepsakeId)
    ) {
      context.addIssue({
        code: "custom",
        message: "The share projection must cite its selected keepsake",
        path: ["sourceIds"],
      });
    }
  });
export type RelationshipShareProjection = z.infer<
  typeof RelationshipShareProjectionSchema
>;

export const RelationshipRecapItemSchema = z
  .object({
    title: ShortTextSchema,
    summary: z.string().trim().min(1).max(1_000),
    sourceType: KeepsakeSourceTypeSchema.or(
      z.enum(["keepsake", "domain_event"]),
    ),
    sourceIds: z.array(EntityIdSchema).min(1).max(24),
  })
  .strict();
export type RelationshipRecapItem = z.infer<typeof RelationshipRecapItemSchema>;

export const RelationshipRecapSchema = z
  .object({
    version: z.literal("relationship_recap_v1"),
    agentId: EntityIdSchema,
    periodStartUtc: UtcDateTimeSchema,
    periodEndUtc: UtcDateTimeSchema,
    items: z.array(RelationshipRecapItemSchema).min(1).max(40),
    generatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .refine(
    (recap) =>
      Date.parse(recap.periodStartUtc) < Date.parse(recap.periodEndUtc),
    { message: "A recap period must increase", path: ["periodEndUtc"] },
  );
export type RelationshipRecap = z.infer<typeof RelationshipRecapSchema>;

export const RelationshipRecapQuerySchema = z
  .object({
    fromUtc: UtcDateTimeSchema,
    toUtc: UtcDateTimeSchema,
    limit: z.coerce.number().int().min(1).max(40).default(20),
  })
  .strict()
  .refine((query) => Date.parse(query.fromUtc) < Date.parse(query.toUtc), {
    message: "A recap query period must increase",
    path: ["toUtc"],
  });
export type RelationshipRecapQuery = z.infer<
  typeof RelationshipRecapQuerySchema
>;
