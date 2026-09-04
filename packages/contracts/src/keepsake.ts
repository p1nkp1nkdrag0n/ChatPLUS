import { z } from "zod";

import {
  EntityIdSchema,
  JsonValueSchema,
  ShortTextSchema,
  UtcDateTimeSchema,
} from "./primitives.js";

const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const HEX_COLOR_PATTERN = /^#[a-fA-F0-9]{6}$/u;

export const KeepsakeSha256Schema = z
  .string()
  .regex(SHA_256_PATTERN, "Expected a lowercase SHA-256 digest");

export const KeepsakeKindSchema = z.enum([
  "postcard",
  "ticket_stub",
  "polaroid",
  "sketch",
  "pressed_flower",
  "recipe_or_note_card",
]);
export type KeepsakeKind = z.infer<typeof KeepsakeKindSchema>;

export const KeepsakeStatusSchema = z.enum([
  "pending",
  "generating",
  "ready",
  "failed",
]);
export type KeepsakeStatus = z.infer<typeof KeepsakeStatusSchema>;

export const KeepsakePartySchema = z.enum(["user", "agent"]);
export type KeepsakeParty = z.infer<typeof KeepsakePartySchema>;

export const KeepsakeCanonicalitySchema = z.enum([
  "canonical",
  "evidence_derived",
]);
export type KeepsakeCanonicality = z.infer<typeof KeepsakeCanonicalitySchema>;

export const KeepsakeSourceTypeSchema = z.enum([
  "life_outcome",
  "relationship_milestone",
  "reflection",
  "letter",
]);
export type KeepsakeSourceType = z.infer<typeof KeepsakeSourceTypeSchema>;

export const CharacterVisualProfileSchema = z
  .object({
    version: z.number().int().positive(),
    agentId: EntityIdSchema,
    characterVersion: z.number().int().positive(),
    stableAppearanceTraits: z.array(ShortTextSchema).max(12),
    periodAndSetting: ShortTextSchema,
    materialLanguage: z.array(ShortTextSchema).min(1).max(8),
    imageLanguage: z.array(ShortTextSchema).min(1).max(8),
    forbiddenElements: z.array(ShortTextSchema).max(16),
    profileHash: KeepsakeSha256Schema,
    createdAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((profile, context) => {
    for (const [field, values] of [
      ["stableAppearanceTraits", profile.stableAppearanceTraits],
      ["materialLanguage", profile.materialLanguage],
      ["imageLanguage", profile.imageLanguage],
      ["forbiddenElements", profile.forbiddenElements],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: `${field} must not contain duplicates`,
          path: [field],
        });
      }
    }
  });
export type CharacterVisualProfile = z.infer<
  typeof CharacterVisualProfileSchema
>;

/**
 * A bounded, provider-facing prompt. It deliberately excludes full character
 * source text, conversations, letter bodies, memory payloads, and raw events.
 */
export const VisualPromptSpecSchema = z
  .object({
    version: z.literal("keepsake_visual_v1"),
    kind: KeepsakeKindSchema,
    subject: ShortTextSchema,
    setting: ShortTextSchema,
    mood: ShortTextSchema,
    composition: ShortTextSchema,
    materials: z.array(ShortTextSchema).min(1).max(8),
    palette: z.array(z.string().regex(HEX_COLOR_PATTERN)).min(2).max(8),
    stableCharacterTraits: z.array(ShortTextSchema).max(8),
    forbiddenElements: z.array(ShortTextSchema).max(16),
    visualProfileHash: KeepsakeSha256Schema,
    semanticSourceHash: KeepsakeSha256Schema,
  })
  .strict()
  .superRefine((spec, context) => {
    for (const [field, values] of [
      ["materials", spec.materials],
      ["palette", spec.palette],
      ["stableCharacterTraits", spec.stableCharacterTraits],
      ["forbiddenElements", spec.forbiddenElements],
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: `${field} must not contain duplicates`,
          path: [field],
        });
      }
    }
  });
export type VisualPromptSpec = z.infer<typeof VisualPromptSpecSchema>;

export const KeepsakeVisualSpecSchema = z
  .object({
    version: z.literal("keepsake_visual_v1"),
    templateVersion: z.string().trim().min(1).max(80),
    theme: ShortTextSchema,
    caption: z.string().trim().min(1).max(500),
    palette: z.array(z.string().regex(HEX_COLOR_PATTERN)).min(2).max(8),
    materials: z.array(ShortTextSchema).min(1).max(8),
    visualPrompt: VisualPromptSpecSchema.optional(),
  })
  .strict();
export type KeepsakeVisualSpec = z.infer<typeof KeepsakeVisualSpecSchema>;

/** The text model may propose only story/visual content and source references. */
export const KeepsakeSpecSchema = z
  .object({
    kind: KeepsakeKindSchema,
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().min(1).max(2_000),
    theme: ShortTextSchema,
    caption: z.string().trim().min(1).max(500),
    sourceEventIds: z.array(EntityIdSchema).max(24),
    sourceMemoryIds: z.array(EntityIdSchema).max(24),
    sourceLetterIds: z.array(EntityIdSchema).max(24),
  })
  .strict()
  .superRefine((spec, context) => {
    validateUniqueSources(spec, context);
    if (sourceCount(spec) === 0) {
      context.addIssue({
        code: "custom",
        message: "A keepsake proposal requires at least one source",
        path: ["sourceEventIds"],
      });
    }
  });
export type KeepsakeSpec = z.infer<typeof KeepsakeSpecSchema>;

export const KeepsakeSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    title: z.string().trim().min(1).max(160),
    kind: KeepsakeKindSchema,
    description: z.string().trim().min(1).max(2_000),
    createdBy: KeepsakePartySchema,
    ownedBy: KeepsakePartySchema,
    givenTo: KeepsakePartySchema.optional(),
    sourceEventIds: z.array(EntityIdSchema).max(24),
    sourceMemoryIds: z.array(EntityIdSchema).max(24),
    sourceLetterIds: z.array(EntityIdSchema).max(24),
    canonicality: KeepsakeCanonicalitySchema,
    status: KeepsakeStatusSchema,
    visualSpecJson: KeepsakeVisualSpecSchema,
    visualSpecHash: KeepsakeSha256Schema,
    primaryAssetId: EntityIdSchema.optional(),
    createdEffectiveAtUtc: UtcDateTimeSchema,
    giftedAtUtc: UtcDateTimeSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(240),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((keepsake, context) => {
    validateUniqueSources(keepsake, context);
    if (sourceCount(keepsake) === 0) {
      context.addIssue({
        code: "custom",
        message: "A keepsake requires at least one durable source",
        path: ["sourceEventIds"],
      });
    }
    if (keepsake.status === "ready" && keepsake.primaryAssetId === undefined) {
      context.addIssue({
        code: "custom",
        message: "A ready keepsake requires a primary asset",
        path: ["primaryAssetId"],
      });
    }
    if (keepsake.status !== "ready" && keepsake.primaryAssetId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only a ready keepsake may expose a primary asset",
        path: ["primaryAssetId"],
      });
    }
    if (keepsake.giftedAtUtc !== undefined && keepsake.givenTo === undefined) {
      context.addIssue({
        code: "custom",
        message: "A gifted timestamp requires a recipient",
        path: ["givenTo"],
      });
    }
    if (
      keepsake.giftedAtUtc !== undefined &&
      Date.parse(keepsake.giftedAtUtc) <
        Date.parse(keepsake.createdEffectiveAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "A keepsake cannot be gifted before it exists",
        path: ["giftedAtUtc"],
      });
    }
    if (Date.parse(keepsake.updatedAtUtc) < Date.parse(keepsake.createdAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "updatedAtUtc cannot precede createdAtUtc",
        path: ["updatedAtUtc"],
      });
    }
  });
export type Keepsake = z.infer<typeof KeepsakeSchema>;

export const KeepsakeAssetSchema = z
  .object({
    id: EntityIdSchema,
    keepsakeId: EntityIdSchema,
    storageKey: z.string().trim().min(1).max(500),
    thumbnailStorageKey: z.string().trim().min(1).max(500),
    mimeType: z.enum(["image/svg+xml", "image/png", "image/webp"]),
    width: z.number().int().positive().max(8_192),
    height: z.number().int().positive().max(8_192),
    sha256: KeepsakeSha256Schema,
    thumbnailSha256: KeepsakeSha256Schema,
    provider: z.string().trim().min(1).max(120),
    model: z.string().trim().min(1).max(160),
    promptSpecHash: KeepsakeSha256Schema,
    generationRunId: EntityIdSchema.optional(),
    createdAtUtc: UtcDateTimeSchema,
  })
  .strict();
export type KeepsakeAsset = z.infer<typeof KeepsakeAssetSchema>;

export const KeepsakeSourceLinkSchema = z
  .object({
    type: KeepsakeSourceTypeSchema,
    id: EntityIdSchema,
    label: ShortTextSchema,
    effectiveAtUtc: UtcDateTimeSchema.optional(),
    href: z.string().trim().min(1).max(500),
  })
  .strict();
export type KeepsakeSourceLink = z.infer<typeof KeepsakeSourceLinkSchema>;

export const KeepsakeSummaryResponseSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    title: z.string().trim().min(1).max(160),
    kind: KeepsakeKindSchema,
    description: z.string().trim().min(1).max(2_000),
    status: KeepsakeStatusSchema,
    primaryAssetId: EntityIdSchema.optional(),
    createdEffectiveAtUtc: UtcDateTimeSchema,
    giftedAtUtc: UtcDateTimeSchema.optional(),
    thumbnailUrl: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
export type KeepsakeSummaryResponse = z.infer<
  typeof KeepsakeSummaryResponseSchema
>;

export const KeepsakeDetailResponseSchema = z
  .object({
    keepsake: KeepsakeSchema,
    assets: z.array(KeepsakeAssetSchema).max(20),
    sources: z.array(KeepsakeSourceLinkSchema).min(1).max(72),
  })
  .strict();
export type KeepsakeDetailResponse = z.infer<
  typeof KeepsakeDetailResponseSchema
>;

export const KeepsakeArchivePeriodSchema = z
  .string()
  .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/u, "Expected a YYYY-MM period");
export type KeepsakeArchivePeriod = z.infer<typeof KeepsakeArchivePeriodSchema>;

export const KeepsakeFilterOptionsSchema = z
  .object({
    kinds: z.array(KeepsakeKindSchema).max(KeepsakeKindSchema.options.length),
    sourceTypes: z
      .array(KeepsakeSourceTypeSchema)
      .max(KeepsakeSourceTypeSchema.options.length),
    periods: z.array(KeepsakeArchivePeriodSchema),
  })
  .strict();
export type KeepsakeFilterOptions = z.infer<typeof KeepsakeFilterOptionsSchema>;

export const KeepsakePageResponseSchema = z
  .object({
    items: z.array(KeepsakeSummaryResponseSchema).max(100),
    nextCursor: z.string().trim().min(1).max(500).optional(),
    filterOptions: KeepsakeFilterOptionsSchema,
  })
  .strict();
export type KeepsakePageResponse = z.infer<typeof KeepsakePageResponseSchema>;

export const KeepsakeGenerationPayloadSchema = z
  .object({
    sourceType: KeepsakeSourceTypeSchema,
    sourceId: EntityIdSchema,
    requestedKind: KeepsakeKindSchema.optional(),
    semanticSignature: KeepsakeSha256Schema,
    visualSpecHash: KeepsakeSha256Schema.optional(),
    generationEpoch: z.number().int().nonnegative(),
  })
  .strict();
export type KeepsakeGenerationPayload = z.infer<
  typeof KeepsakeGenerationPayloadSchema
>;

export const KeepsakeGenerationResultSchema = z
  .object({
    keepsake: KeepsakeSchema,
    asset: KeepsakeAssetSchema,
    replayed: z.boolean(),
  })
  .strict();
export type KeepsakeGenerationResult = z.infer<
  typeof KeepsakeGenerationResultSchema
>;

export const TriggerKeepsakeGenerationRequestSchema = z
  .object({
    sourceType: KeepsakeSourceTypeSchema,
    sourceId: EntityIdSchema,
    requestedKind: KeepsakeKindSchema.optional(),
  })
  .strict();
export type TriggerKeepsakeGenerationRequest = z.infer<
  typeof TriggerKeepsakeGenerationRequestSchema
>;

export const ProcessKeepsakeTaskRequestSchema = z.object({}).strict();

export const KeepsakeListQuerySchema = z
  .object({
    cursor: z.string().trim().min(1).max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    kind: KeepsakeKindSchema.optional(),
    sourceType: KeepsakeSourceTypeSchema.optional(),
    period: KeepsakeArchivePeriodSchema.optional(),
  })
  .strict();
export type KeepsakeListQuery = z.infer<typeof KeepsakeListQuerySchema>;

export const KeepsakeTemplatePayloadSchema = z
  .object({
    visualSpec: KeepsakeVisualSpecSchema,
    sourceProjection: JsonValueSchema,
  })
  .strict();
export type KeepsakeTemplatePayload = z.infer<
  typeof KeepsakeTemplatePayloadSchema
>;

type SourceCollections = {
  readonly sourceEventIds: readonly string[];
  readonly sourceMemoryIds: readonly string[];
  readonly sourceLetterIds: readonly string[];
};

function sourceCount(value: SourceCollections): number {
  return (
    value.sourceEventIds.length +
    value.sourceMemoryIds.length +
    value.sourceLetterIds.length
  );
}

function validateUniqueSources(
  value: SourceCollections,
  context: z.RefinementCtx,
): void {
  for (const [field, ids] of [
    ["sourceEventIds", value.sourceEventIds],
    ["sourceMemoryIds", value.sourceMemoryIds],
    ["sourceLetterIds", value.sourceLetterIds],
  ] as const) {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: `${field} must not contain duplicates`,
        path: [field],
      });
    }
  }
}
