import { z } from "zod";

import {
  EntityIdSchema,
  ShortTextSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";

export const FieldOriginSchema = z.enum([
  "user_spec",
  "canon_extract",
  "model_inference",
  "synthetic_extension",
  "runtime_simulation",
]);
export type FieldOrigin = z.infer<typeof FieldOriginSchema>;

export const CanonicalitySchema = z.enum([
  "canon",
  "strong_inference",
  "weak_inference",
  "noncanon_extension",
  "runtime_only",
]);
export type Canonicality = z.infer<typeof CanonicalitySchema>;

export const TimelineScopeSchema = z
  .object({
    from: z.string().trim().min(1).max(160).optional(),
    to: z.string().trim().min(1).max(160).optional(),
  })
  .strict()
  .refine((value) => value.from !== undefined || value.to !== undefined, {
    message: "At least one timeline boundary is required",
  });
export type TimelineScope = z.infer<typeof TimelineScopeSchema>;

export const FieldProvenanceSchema = z
  .object({
    origin: FieldOriginSchema,
    canonicality: CanonicalitySchema,
    confidence: UnitIntervalSchema,
    sourceRefs: z.array(EntityIdSchema).max(32),
    canonId: z.string().trim().min(1).max(160).optional(),
    adaptationId: z.string().trim().min(1).max(160).optional(),
    localizationId: z.string().trim().min(1).max(160).optional(),
    timelineScope: TimelineScopeSchema.optional(),
    relationshipScope: z.string().trim().min(1).max(160).optional(),
  })
  .strict();
export type FieldProvenance = z.infer<typeof FieldProvenanceSchema>;

export const CharacterSourceTypeSchema = z.enum([
  "user_spec",
  "canon_text",
  "model_inference",
  "synthetic_extension",
  "runtime_event",
]);
export type CharacterSourceType = z.infer<typeof CharacterSourceTypeSchema>;

export const CharacterSourceRefSchema = z
  .object({
    id: EntityIdSchema,
    sourceType: CharacterSourceTypeSchema,
    label: z.string().trim().min(1).max(200),
    workTitle: z.string().trim().min(1).max(200).optional(),
    locator: z.string().trim().min(1).max(240).optional(),
    excerpt: z.string().trim().min(1).max(1_000).optional(),
    checksum: z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .optional(),
    createdAtUtc: UtcDateTimeSchema.optional(),
  })
  .strict();
export type CharacterSourceRef = z.infer<typeof CharacterSourceRefSchema>;

export const ProvenancedTextSchema = z
  .object({
    value: ShortTextSchema,
    provenance: FieldProvenanceSchema,
  })
  .strict();
export type ProvenancedText = z.infer<typeof ProvenancedTextSchema>;
