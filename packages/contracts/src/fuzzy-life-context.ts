import { z } from "zod";

import {
  DayPeriodSchema,
  DecisionAuthoritySchema,
  LifeActorSchema,
  LifeAvailabilitySchema,
  LifeDomainSchema,
  LifeSubjectSchema,
  LocalDateSchema,
  SupportModeSchema,
} from "./life.js";
import {
  EntityIdSchema,
  NonEmptyTextSchema,
  ShortTextSchema,
  UnitIntervalSchema,
} from "./primitives.js";

const IdListSchema = z.array(EntityIdSchema).max(64);
const PromptTextSchema = z.string().trim().min(1).max(2_000);

const PromptDecisionSchema = z
  .object({
    decisionId: EntityIdSchema,
    subject: LifeSubjectSchema,
    authority: DecisionAuthoritySchema,
    decidedBy: LifeActorSchema,
    selectionSummary: PromptTextSchema,
    authorizedByMessageId: EntityIdSchema.optional(),
    sourceMessageIds: IdListSchema,
  })
  .strict();

const PromptActionSchema = z
  .object({
    actionId: EntityIdSchema,
    decisionId: EntityIdSchema,
    subject: LifeSubjectSchema,
    performedBy: LifeActorSchema,
    actionKind: z.enum(["initiated", "advanced", "completed", "abandoned"]),
    summary: PromptTextSchema,
    sourceEvidenceIds: IdListSchema,
  })
  .strict();

const PromptOutcomeSchema = z
  .object({
    outcomeId: EntityIdSchema,
    decisionId: EntityIdSchema,
    subject: LifeSubjectSchema,
    actionIds: IdListSchema,
    causeKind: z.enum(["action", "external", "mixed"]),
    valence: z.enum(["positive", "negative", "mixed", "neutral"]),
    summary: PromptTextSchema,
    sourceEvidenceIds: IdListSchema,
  })
  .strict();

const PromptReflectionSchema = z
  .object({
    reflectionId: EntityIdSchema,
    decisionId: EntityIdSchema.optional(),
    outcomeId: EntityIdSchema.optional(),
    subject: LifeSubjectSchema,
    reflectedBy: LifeActorSchema,
    stanceTowardDecision: z.enum([
      "affirm",
      "question",
      "reverse",
      "mixed",
      "unclear",
    ]),
    summary: PromptTextSchema,
    sourceMessageIds: IdListSchema,
  })
  .strict();

/**
 * The persisted, day/period-granularity life view exposed to prompts and the UI.
 * It intentionally carries causal evidence separately: decisions are not actions,
 * and neither one is proof of an outcome.
 */
export const FuzzyLifePromptContextSchema = z
  .object({
    authority: z.literal("server_persisted_fuzzy_life"),
    semantics: z
      .object({
        intentionsAreNotOccurrences: z.literal(true),
        decisionsAreNotActions: z.literal(true),
        actionsAreNotOutcomes: z.literal(true),
        characterTimePrecision: z.literal("day_or_period"),
        characterLifeOwner: z.literal("character"),
        lifeThreadStagesAdvanceByCharacterLocalDate: z.literal(true),
        lifeThreadStageIsNotDailyOutcome: z.literal(true),
        lifeThreadStageIsNotProofOfExternalSuccess: z.literal(true),
      })
      .strict(),
    today: z
      .object({
        subject: z.literal("character"),
        localDate: LocalDateSchema,
        currentPeriod: DayPeriodSchema,
        availability: LifeAvailabilitySchema,
        currentFocus: ShortTextSchema.optional(),
        intentions: z
          .array(
            z
              .object({
                title: z.string().trim().min(1).max(160),
                period: DayPeriodSchema,
                commitmentLevel: z.enum(["anchor", "priority", "optional"]),
                status: z.enum([
                  "intended",
                  "deferred",
                  "cancelled",
                  "superseded",
                ]),
              })
              .strict(),
          )
          .max(8),
      })
      .strict(),
    ongoingThreads: z
      .array(
        z
          .object({
            subject: z.literal("character"),
            title: z.string().trim().min(1).max(160),
            currentStage: NonEmptyTextSchema,
            progressNote: NonEmptyTextSchema.optional(),
            nextStepHint: NonEmptyTextSchema.optional(),
          })
          .strict(),
      )
      .max(16),
    verifiedRecentOutcomes: z
      .array(
        z
          .object({
            subject: z.literal("character"),
            effectiveLocalDate: LocalDateSchema,
            outcomeKind: z.enum([
              "completed",
              "partial",
              "skipped",
              "deferred",
              "cancelled",
            ]),
            summary: PromptTextSchema,
          })
          .strict(),
      )
      .max(16),
    unresolvedDilemmas: z
      .array(
        z
          .object({
            id: EntityIdSchema,
            subject: LifeSubjectSchema,
            domain: LifeDomainSchema,
            title: z.string().trim().min(1).max(160),
            summary: PromptTextSchema,
            options: z.array(z.string().trim().min(1).max(160)).max(12),
          })
          .strict(),
      )
      .max(4),
    recentDecisionDilemmas: z
      .array(
        z
          .object({
            id: EntityIdSchema,
            subject: LifeSubjectSchema,
            domain: LifeDomainSchema,
            status: z.enum(["open", "closed", "abandoned"]),
            title: z.string().trim().min(1).max(160),
            summary: PromptTextSchema,
            options: z
              .array(
                z
                  .object({
                    id: EntityIdSchema,
                    label: z.string().trim().min(1).max(160),
                  })
                  .strict(),
              )
              .max(12),
            sourceMessageIds: IdListSchema,
            closingDecisionId: EntityIdSchema.optional(),
          })
          .strict(),
      )
      .max(4),
    activePressure: z
      .array(
        z
          .object({
            id: EntityIdSchema,
            subject: LifeSubjectSchema,
            pressureKind: z.enum([
              "work",
              "relationship",
              "identity",
              "health",
              "grief",
              "decision",
              "other",
            ]),
            dilemmaId: EntityIdSchema.optional(),
            threadId: EntityIdSchema.optional(),
            triggerSummary: PromptTextSchema,
            status: z.enum(["open", "improving", "worsening", "resolved"]),
            currentPressure: UnitIntervalSchema,
            currentClarity: UnitIntervalSchema,
            currentFeltUnderstood: UnitIntervalSchema,
            sourceMessageIds: IdListSchema,
            latestEvidenceMessageId: EntityIdSchema,
          })
          .strict(),
      )
      .max(4),
    relationshipMilestones: z
      .array(
        z
          .object({
            id: EntityIdSchema,
            subject: z.literal("shared"),
            kind: z.enum([
              "meaningful_support",
              "shared_decision",
              "disagreement",
              "repair",
              "turning_point",
              "mutual_vulnerability",
              "other",
            ]),
            summary: PromptTextSchema,
            interventionIds: IdListSchema,
            decisionIds: IdListSchema,
            outcomeIds: IdListSchema,
            reflectionIds: IdListSchema,
            sourceMessageIds: IdListSchema,
            effectiveLocalDate: LocalDateSchema,
          })
          .strict(),
      )
      .max(4),
    evidencedSupport: z
      .array(
        z
          .object({
            id: EntityIdSchema,
            dilemmaId: EntityIdSchema.optional(),
            pressureEpisodeId: EntityIdSchema.optional(),
            mode: SupportModeSchema,
            offeredBy: z.enum(["user", "character"]),
            receivedBy: z.enum(["user", "character"]),
            summary: PromptTextSchema,
            intendedEffect: ShortTextSchema,
            sourceMessageId: EntityIdSchema,
            effectiveLocalDate: LocalDateSchema,
          })
          .strict(),
      )
      .max(8),
    recentDecisions: z
      .array(
        z
          .object({
            id: EntityIdSchema,
            dilemmaId: EntityIdSchema,
            subject: LifeSubjectSchema,
            authority: DecisionAuthoritySchema,
            decidedBy: LifeActorSchema,
            selectionSummary: PromptTextSchema,
            supportInterventionIds: IdListSchema,
            sourceMessageIds: IdListSchema,
            authorizedByMessageId: EntityIdSchema.optional(),
            effectiveLocalDate: LocalDateSchema,
          })
          .strict(),
      )
      .max(4),
    canonicalCausalFacts: z
      .array(
        z
          .object({
            dilemmaId: EntityIdSchema,
            subject: LifeSubjectSchema,
            decision: PromptDecisionSchema,
            actions: z.array(PromptActionSchema).max(4),
            outcomes: z.array(PromptOutcomeSchema).max(4),
            reflections: z.array(PromptReflectionSchema).max(4),
          })
          .strict(),
      )
      .max(4),
    evidencedActions: z
      .array(
        z
          .object({
            id: EntityIdSchema,
            decisionId: EntityIdSchema,
            subject: LifeSubjectSchema,
            performedBy: LifeActorSchema,
            actionKind: z.enum([
              "initiated",
              "advanced",
              "completed",
              "abandoned",
            ]),
            summary: PromptTextSchema,
            sourceEvidenceIds: IdListSchema,
            effectiveLocalDate: LocalDateSchema,
          })
          .strict(),
      )
      .max(4),
    evidencedConsequences: z
      .array(
        z
          .object({
            id: EntityIdSchema,
            decisionId: EntityIdSchema,
            subject: LifeSubjectSchema.optional(),
            decisionAuthority: DecisionAuthoritySchema.optional(),
            decidedBy: LifeActorSchema.optional(),
            actionIds: IdListSchema,
            causeKind: z.enum(["action", "external", "mixed"]),
            valence: z.enum(["positive", "negative", "mixed", "neutral"]),
            status: z.enum(["observed", "confirmed", "superseded"]),
            summary: PromptTextSchema,
            sourceEvidenceIds: IdListSchema,
            effectiveLocalDate: LocalDateSchema,
          })
          .strict(),
      )
      .max(4),
    reflections: z
      .array(
        z
          .object({
            id: EntityIdSchema,
            decisionId: EntityIdSchema.optional(),
            outcomeId: EntityIdSchema.optional(),
            subject: LifeSubjectSchema,
            reflectedBy: LifeActorSchema,
            stanceTowardDecision: z.enum([
              "affirm",
              "question",
              "reverse",
              "mixed",
              "unclear",
            ]),
            summary: PromptTextSchema,
            sourceMessageIds: IdListSchema,
            effectiveLocalDate: LocalDateSchema,
          })
          .strict(),
      )
      .max(4),
  })
  .strict();

export type FuzzyLifePromptContext = z.infer<
  typeof FuzzyLifePromptContextSchema
>;
