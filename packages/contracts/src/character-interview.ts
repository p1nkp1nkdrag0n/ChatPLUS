import { z } from "zod";
import {
  CharacterAuthorityAuditSchema,
  CharacterIdentitySchema,
  CharacterSpecSchema,
  CharacterStatusSchema,
} from "./character.js";
import {
  EntityIdSchema,
  IanaTimezoneSchema,
  SimulationTierSchema,
} from "./primitives.js";

/** Author responses, not model claims. Empty optional answers remain optional. */
export const CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH = 2_000;

export const CharacterInterviewAnswersSchema = z
  .object({
    gender: z.string().trim().min(1).max(CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH),
    name: z.string().trim().min(1).max(CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH),
    ageText: z
      .string()
      .trim()
      .min(1)
      .max(CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH),
    worldSetting: z.string().trim().min(1).max(4_000),
    workOrRole: z
      .string()
      .trim()
      .min(1)
      .max(CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH),
    appearanceDescription: z.string().trim().max(2_000).optional(),
    personality: z
      .string()
      .trim()
      .min(1)
      .max(CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH),
    dailyHabits: z
      .string()
      .trim()
      .max(CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH)
      .optional(),
    importantExperience: z
      .string()
      .trim()
      .max(CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH)
      .optional(),
    dialogueStyle: z
      .string()
      .trim()
      .max(CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH)
      .optional(),
    currentFocus: z
      .string()
      .trim()
      .max(CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH)
      .optional(),
    additionalDetails: z.string().trim().max(6_000).optional(),
    followUps: z
      .array(
        z
          .object({
            id: EntityIdSchema,
            question: z.string().trim().min(1).max(240),
            answer: z
              .string()
              .trim()
              .max(CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH),
          })
          .strict(),
      )
      .max(2)
      .optional(),
    advanced: z
      .object({
        tier: SimulationTierSchema.optional(),
        timezone: IanaTimezoneSchema.optional(),
        storyEra: z
          .string()
          .trim()
          .max(CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH)
          .optional(),
        storyAnchorYear: z.number().int().min(1000).max(9999).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CharacterInterviewAnswers = z.infer<
  typeof CharacterInterviewAnswersSchema
>;

export const CharacterInterviewFollowUpsRequestSchema = z
  .object({
    answers: CharacterInterviewAnswersSchema,
  })
  .strict();
/** The provider supplies question text only; stable UI IDs belong to the server. */
export const CharacterInterviewProposalSchema = z
  .object({
    questions: z.array(z.string().trim().min(1).max(240)).max(2),
  })
  .strict();
export const CharacterInterviewFollowUpsResponseSchema = z
  .object({
    questions: z
      .array(
        z
          .object({ id: EntityIdSchema, text: z.string().min(1).max(240) })
          .strict(),
      )
      .max(2),
  })
  .strict();
export type CharacterInterviewFollowUpsResponse = z.infer<
  typeof CharacterInterviewFollowUpsResponseSchema
>;

export const CharacterInterviewCompileRequestSchema = z
  .object({
    answers: CharacterInterviewAnswersSchema,
    characterId: EntityIdSchema.optional(),
    expectedVersion: z.number().int().positive().optional(),
    requestId: EntityIdSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Boolean(value.characterId) !== (value.expectedVersion !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["expectedVersion"],
        message:
          "Updating an interview requires both characterId and expectedVersion",
      });
    }
  });
export type CharacterInterviewCompileRequest = z.infer<
  typeof CharacterInterviewCompileRequestSchema
>;

export const CharacterInterviewRefineRequestSchema = z
  .object({
    characterId: EntityIdSchema,
    expectedVersion: z.number().int().positive(),
    feedback: z.string().trim().min(1).max(5_000),
    requestId: EntityIdSchema,
  })
  .strict();
export type CharacterInterviewRefineRequest = z.infer<
  typeof CharacterInterviewRefineRequestSchema
>;

export const CharacterCreationPreviewSchema = z
  .object({
    characterId: EntityIdSchema,
    characterVersion: z.number().int().positive(),
    status: CharacterStatusSchema,
    identity: CharacterIdentitySchema.pick({
      name: true,
      gender: true,
      ageText: true,
      workOrRole: true,
    }),
    canReviseInterview: z.boolean(),
    canRefine: z.boolean().optional(),
    paragraphs: z.array(z.string().min(1).max(12_000)).min(1).max(12),
    answers: CharacterInterviewAnswersSchema,
    factsHash: z.string().regex(/^[a-f0-9]{64}$/),
    authorityReview: CharacterAuthorityAuditSchema.optional(),
  })
  .strict();
export type CharacterCreationPreview = z.infer<
  typeof CharacterCreationPreviewSchema
>;
export const CharacterInterviewCompileResponseSchema = z
  .object({
    character: CharacterSpecSchema,
    preview: CharacterCreationPreviewSchema,
  })
  .strict();
export type CharacterInterviewCompileResponse = z.infer<
  typeof CharacterInterviewCompileResponseSchema
>;

export const CharacterInterviewProseSchema = z
  .object({
    paragraphs: z.array(z.string().trim().min(1).max(12_000)).min(2).max(12),
  })
  .strict();

// Provider-selected revision scope is limited to character content. Audit,
// sources, locks and application-owned relationship state are never writable.
export const CHARACTER_REFINEMENT_PATHS = [
  "identity.name",
  "identity.gender",
  "identity.ageText",
  "identity.worldSetting",
  "identity.workOrRole",
  "identity.appearance",
  "identity.selfDescription",
  "identity.timezone",
  "identity.temporalFrame",
  "persona.traits",
  "persona.values",
  "persona.contradictions",
  "persona.goals",
  "persona.preferences",
  "persona.biography",
  "persona.boundaries",
  "dialogue.primaryLanguage",
  "dialogue.formality",
  "dialogue.directness",
  "dialogue.warmth",
  "dialogue.verbosity",
  "dialogue.humor",
  "dialogue.averageMessageLength",
  "dialogue.averageChunksPerTurn",
  "dialogue.frequentPhrases",
  "dialogue.avoidedPhrases",
  "dialogue.greetingPatterns",
  "dialogue.refusalPatterns",
  "dialogue.comfortingPatterns",
  "dialogue.authorGuidance",
  "dialogue.understoodLanguages",
  "dialogue.spokenLanguages",
  "dialogue.rules",
  "routines",
  "knowledge.knownFacts",
  "knowledge.uncertainFacts",
  "tier",
  "schedulePolicy",
  "proactivePolicy",
] as const;
export type CharacterRefinementPath =
  (typeof CHARACTER_REFINEMENT_PATHS)[number];
export const CharacterRefinementPlanSchema = z
  .object({
    answersPatch: CharacterInterviewAnswersSchema.partial(),
    removedFacts: z
      .array(z.string().trim().min(1).max(1_000))
      .max(200)
      .optional(),
    changedPaths: z
      .array(z.enum(CHARACTER_REFINEMENT_PATHS))
      .max(CHARACTER_REFINEMENT_PATHS.length),
  })
  .strict();
