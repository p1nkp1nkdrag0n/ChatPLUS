import { z } from "zod";

import { CharacterPersonaSchema, DialogueStyleSchema } from "./character.js";
import { EntityIdSchema, UtcDateTimeSchema } from "./primitives.js";

export const PERSONA_RUNTIME_POLICY_VERSION = "scoped_practice_v1";
export const PersonaRuntimeModeSchema = z.enum(["off", "shadow", "enforced"]);
export type PersonaRuntimeMode = z.infer<typeof PersonaRuntimeModeSchema>;

export const PersonaEvidenceSourceSchema = z
  .object({
    sourceType: z.enum(["memory", "message", "activity_event", "domain_event"]),
    sourceId: EntityIdSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export type PersonaEvidenceSource = z.infer<typeof PersonaEvidenceSourceSchema>;

export const PersonaPracticeScopeSchema = z
  .object({
    userId: EntityIdSchema,
    topic: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export type PersonaPracticeScope = z.infer<typeof PersonaPracticeScopeSchema>;

export const PersonaPracticeProposalSchema = z
  .object({
    kind: z.literal("relationship_practice"),
    facet: z.enum(["advice_timing", "follow_up_questions"]),
    practice: z.enum(["listen_first", "fewer_questions"]),
    scope: PersonaPracticeScopeSchema,
    /** The complete original user request, not a model explanation of their psychology. */
    content: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .refine(
    (proposal) =>
      (proposal.facet === "advice_timing") ===
      (proposal.practice === "listen_first"),
    { message: "Practice must match its finite facet", path: ["practice"] },
  );
export type PersonaPracticeProposal = z.infer<
  typeof PersonaPracticeProposalSchema
>;

export const PersonaAdaptationSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    proposal: PersonaPracticeProposalSchema,
    baseCharacterVersion: z.number().int().min(1),
    revision: z.number().int().min(1),
    sourceMessageId: EntityIdSchema,
    sources: z.array(PersonaEvidenceSourceSchema).min(2).max(4),
    status: z.enum(["accepted", "superseded", "retracted", "needs_review"]),
    effectiveFromUtc: UtcDateTimeSchema,
    effectiveToUtc: UtcDateTimeSchema.optional(),
    policyVersion: z.literal(PERSONA_RUNTIME_POLICY_VERSION),
  })
  .strict()
  .superRefine((adaptation, context) => {
    if (
      !adaptation.sources.some((source) => source.sourceType === "memory") ||
      !adaptation.sources.some(
        (source) =>
          source.sourceType === "message" &&
          source.sourceId === adaptation.sourceMessageId,
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A practice needs both its durable memory and root user message",
        path: ["sources"],
      });
    }
    if (
      adaptation.effectiveToUtc !== undefined &&
      adaptation.effectiveToUtc < adaptation.effectiveFromUtc
    ) {
      context.addIssue({
        code: "custom",
        message: "Effective end precedes its start",
        path: ["effectiveToUtc"],
      });
    }
  });
export type PersonaAdaptation = z.infer<typeof PersonaAdaptationSchema>;

export const EffectivePersonaSnapshotSchema = z
  .object({
    policyVersion: z.literal(PERSONA_RUNTIME_POLICY_VERSION),
    agentId: EntityIdSchema,
    baseCharacterVersion: z.number().int().min(1),
    revision: z.number().int().nonnegative(),
    memoryRevision: z.number().int().nonnegative(),
    persona: CharacterPersonaSchema,
    dialogue: DialogueStyleSchema,
    relationshipPractices: z.array(PersonaAdaptationSchema).max(100),
    excludedAdaptationIds: z.array(EntityIdSchema).max(1_000),
    suppressedMemoryIds: z.array(EntityIdSchema).max(1_000),
  })
  .strict();
export type EffectivePersonaSnapshot = z.infer<
  typeof EffectivePersonaSnapshotSchema
>;
