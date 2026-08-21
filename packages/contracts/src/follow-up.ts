import { z } from "zod";

import {
  EntityIdSchema,
  ReasonCodeSchema,
  RevisionSchema,
  ShortTextSchema,
  UtcDateTimeSchema,
  isChronologicalRange,
} from "./primitives.js";

export const FollowUpSubjectTypeSchema = z.enum([
  "user_goal",
  "user_event",
  "shared_commitment",
  "character_commitment",
]);
export type FollowUpSubjectType = z.infer<typeof FollowUpSubjectTypeSchema>;

export const FollowUpStatusSchema = z.enum([
  "pending",
  "resolved",
  "sent",
  "expired",
  "cancelled",
]);
export type FollowUpStatus = z.infer<typeof FollowUpStatusSchema>;

export const FollowUpIntentSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    subjectType: FollowUpSubjectTypeSchema,
    contextSummary: z.string().trim().min(1).max(1_000),
    expectedOutcomeDescription: z.string().trim().min(1).max(1_000),
    sourceMessageId: EntityIdSchema,
    earliestAtUtc: UtcDateTimeSchema,
    expiresAtUtc: UtcDateTimeSchema,
    status: FollowUpStatusSchema,
    maxAttempts: z.literal(1),
    attemptCount: z.number().int().min(0).max(1),
    dedupeKey: z.string().trim().min(1).max(240),
    sentMessageId: EntityIdSchema.optional(),
    resolutionMessageId: EntityIdSchema.optional(),
    revision: RevisionSchema,
    generationEpoch: RevisionSchema,
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    if (!isChronologicalRange(intent.earliestAtUtc, intent.expiresAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "expiresAtUtc must be after earliestAtUtc",
        path: ["expiresAtUtc"],
      });
    }
    if (Date.parse(intent.updatedAtUtc) < Date.parse(intent.createdAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "updatedAtUtc must not be before createdAtUtc",
        path: ["updatedAtUtc"],
      });
    }
    if (intent.attemptCount > intent.maxAttempts) {
      context.addIssue({
        code: "custom",
        message: "attemptCount must not exceed maxAttempts",
        path: ["attemptCount"],
      });
    }
    if (intent.attemptCount === 1 && intent.sentMessageId === undefined) {
      context.addIssue({
        code: "custom",
        message: "An attempted follow-up must reference its sent message",
        path: ["sentMessageId"],
      });
    }
    if (intent.status === "sent" && intent.attemptCount !== 1) {
      context.addIssue({
        code: "custom",
        message: "A sent follow-up must consume its single attempt",
        path: ["attemptCount"],
      });
    }
    if (
      (intent.status === "resolved" || intent.status === "cancelled") &&
      intent.resolutionMessageId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          intent.status + " follow-up must reference its resolution message",
        path: ["resolutionMessageId"],
      });
    }
  });
export type FollowUpIntent = z.infer<typeof FollowUpIntentSchema>;

/**
 * A model may propose a fuzzy, quoted follow-up subject. Ownership, exact
 * timestamps, ids, state and retry policy remain server-owned.
 */
export const FollowUpCandidateSchema = z
  .object({
    subjectType: FollowUpSubjectTypeSchema,
    contextSummary: z.string().trim().min(1).max(1_000),
    expectedOutcomeDescription: z.string().trim().min(1).max(1_000),
    timingHint: z.string().trim().min(1).max(240),
    evidenceQuotes: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
    reasonCode: ReasonCodeSchema,
    reasonSummary: ShortTextSchema,
  })
  .strict();
export type FollowUpCandidate = z.infer<typeof FollowUpCandidateSchema>;

export const FollowUpTurnRefSchema = z
  .string()
  .regex(/^followup_[1-9]\d{0,2}$/u, "Expected a turn-local follow-up ref");

export const FollowUpTransitionProposalSchema = z
  .object({
    followUpRef: FollowUpTurnRefSchema,
    outcome: z.enum(["resolved", "cancelled"]),
    evidenceQuotes: z.array(z.string().trim().min(1).max(500)).min(1).max(4),
    reasonCode: ReasonCodeSchema,
    reasonSummary: ShortTextSchema,
  })
  .strict();
export type FollowUpTransitionProposal = z.infer<
  typeof FollowUpTransitionProposalSchema
>;

export const CareCueStatusSchema = z.enum([
  "active",
  "dismissed",
  "expired",
  "exhausted",
]);
export type CareCueStatus = z.infer<typeof CareCueStatusSchema>;

export const CareCueSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    contextSummary: z.string().trim().min(1).max(1_000),
    mentionGuidance: z.string().trim().min(1).max(1_000),
    sourceMessageId: EntityIdSchema,
    earliestAtUtc: UtcDateTimeSchema.optional(),
    expiresAtUtc: UtcDateTimeSchema,
    status: CareCueStatusSchema,
    maxMentions: z.number().int().min(1).max(3),
    mentionCount: z.number().int().min(0).max(3),
    dedupeKey: z.string().trim().min(1).max(240),
    lastMentionedMessageId: EntityIdSchema.optional(),
    dismissedByMessageId: EntityIdSchema.optional(),
    revision: RevisionSchema,
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((cue, context) => {
    if (
      cue.earliestAtUtc !== undefined &&
      !isChronologicalRange(cue.earliestAtUtc, cue.expiresAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "expiresAtUtc must be after earliestAtUtc",
        path: ["expiresAtUtc"],
      });
    }
    if (Date.parse(cue.expiresAtUtc) <= Date.parse(cue.createdAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "expiresAtUtc must be after createdAtUtc",
        path: ["expiresAtUtc"],
      });
    }
    if (Date.parse(cue.updatedAtUtc) < Date.parse(cue.createdAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "updatedAtUtc must not be before createdAtUtc",
        path: ["updatedAtUtc"],
      });
    }
    if (cue.mentionCount > cue.maxMentions) {
      context.addIssue({
        code: "custom",
        message: "mentionCount must not exceed maxMentions",
        path: ["mentionCount"],
      });
    }
    if (cue.status === "active" && cue.mentionCount >= cue.maxMentions) {
      context.addIssue({
        code: "custom",
        message: "A cue at its mention limit must be exhausted",
        path: ["status"],
      });
    }
    if (cue.status === "exhausted" && cue.mentionCount !== cue.maxMentions) {
      context.addIssue({
        code: "custom",
        message: "An exhausted cue must have reached maxMentions",
        path: ["mentionCount"],
      });
    }
    if (cue.status === "dismissed" && cue.dismissedByMessageId === undefined) {
      context.addIssue({
        code: "custom",
        message: "A dismissed cue must reference the dismissing message",
        path: ["dismissedByMessageId"],
      });
    }
  });
export type CareCue = z.infer<typeof CareCueSchema>;

export const CareCueCandidateSchema = z
  .object({
    contextSummary: z.string().trim().min(1).max(1_000),
    mentionGuidance: z.string().trim().min(1).max(1_000),
    timingHint: z.string().trim().min(1).max(240).optional(),
    evidenceQuotes: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
    reasonCode: ReasonCodeSchema,
    reasonSummary: ShortTextSchema,
  })
  .strict();
export type CareCueCandidate = z.infer<typeof CareCueCandidateSchema>;
/**
 * Minimal model-facing continuity proposals. They intentionally exclude ids,
 * exact timestamps, lifecycle state, retry counters, dedupe keys and persisted
 * reason metadata. The server materializes strict candidates from these fuzzy
 * semantic hints and verified turn text.
 */
export const ModelFollowUpCandidateSchema = z
  .object({
    subjectType: FollowUpSubjectTypeSchema.optional(),
    contextSummary: z.string().trim().min(1).max(1_000).optional(),
    expectedOutcomeDescription: z.string().trim().min(1).max(1_000).optional(),
    timingHint: z.string().trim().min(1).max(500).optional(),
    evidenceQuotes: z
      .array(z.string().trim().min(1).max(500))
      .max(8)
      .default([]),
  })
  .strip();
export type ModelFollowUpCandidate = z.infer<
  typeof ModelFollowUpCandidateSchema
>;

export const ModelCareCueCandidateSchema = z
  .object({
    cueType: z.string().trim().min(1).max(120).optional(),
    contextSummary: z.string().trim().min(1).max(1_000).optional(),
    mentionGuidance: z.string().trim().min(1).max(1_000).optional(),
    timingHint: z.string().trim().min(1).max(500).optional(),
    evidenceQuotes: z
      .array(z.string().trim().min(1).max(500))
      .max(8)
      .default([]),
  })
  .strip();
export type ModelCareCueCandidate = z.infer<typeof ModelCareCueCandidateSchema>;

export const ModelContinuityTurnEffectsSchema = z
  .object({
    followUpCandidates: z.array(z.unknown()).max(4).default([]),
    followUpTransitions: z.array(z.unknown()).max(8).default([]),
    careCueCandidates: z.array(z.unknown()).max(4).default([]),
  })
  .strip();
export type ModelContinuityTurnEffects = z.infer<
  typeof ModelContinuityTurnEffectsSchema
>;

export const ContinuityTurnEffectsSchema = z
  .object({
    followUpCandidates: z.array(FollowUpCandidateSchema).max(4).default([]),
    followUpTransitions: z
      .array(FollowUpTransitionProposalSchema)
      .max(8)
      .default([]),
    careCueCandidates: z.array(CareCueCandidateSchema).max(4).default([]),
  })
  .strict();
export type ContinuityTurnEffects = z.infer<typeof ContinuityTurnEffectsSchema>;

export const ProactiveDeliverySubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("activity_candidate"),
      candidateId: EntityIdSchema,
      revision: RevisionSchema,
      generationEpoch: RevisionSchema,
      earliestAtUtc: UtcDateTimeSchema,
      expiresAtUtc: UtcDateTimeSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("follow_up"),
      followUpIntentId: EntityIdSchema,
      revision: RevisionSchema,
      generationEpoch: RevisionSchema,
      earliestAtUtc: UtcDateTimeSchema,
      expiresAtUtc: UtcDateTimeSchema,
      maxAttempts: z.literal(1),
      attemptCount: z.number().int().min(0).max(1),
    })
    .strict(),
]);
export type ProactiveDeliverySubject = z.infer<
  typeof ProactiveDeliverySubjectSchema
>;

export const ProactiveGenerationStatusSchema = z.enum([
  "generating",
  "committed",
  "stale_discarded",
  "failed",
]);
export type ProactiveGenerationStatus = z.infer<
  typeof ProactiveGenerationStatusSchema
>;

export const ProactiveGenerationRunSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sourceKind: z.enum(["activity_candidate", "follow_up"]),
    proactiveCandidateId: EntityIdSchema.optional(),
    followUpIntentId: EntityIdSchema.optional(),
    generationEpoch: z.number().int().positive(),
    claimToken: EntityIdSchema,
    status: ProactiveGenerationStatusSchema,
    sessionId: EntityIdSchema,
    preflightSpecVersion: z.number().int().positive(),
    preflightStateRevision: RevisionSchema,
    preflightSourceRevision: RevisionSchema,
    preflightMessageRowid: RevisionSchema,
    preflightLastUserMessageRowid: RevisionSchema,
    preflightUserArrivalEpoch: RevisionSchema,
    generatedContent: z.string().trim().min(1).max(4_000).optional(),
    messageId: EntityIdSchema.optional(),
    reasonCode: ReasonCodeSchema.optional(),
    startedAtUtc: UtcDateTimeSchema,
    completedAtUtc: UtcDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((run, context) => {
    const activitySource = run.proactiveCandidateId !== undefined;
    const followUpSource = run.followUpIntentId !== undefined;
    if (activitySource === followUpSource) {
      context.addIssue({
        code: "custom",
        message: "A generation run must reference exactly one source",
        path: ["sourceKind"],
      });
    }
    if (
      (run.sourceKind === "activity_candidate" && !activitySource) ||
      (run.sourceKind === "follow_up" && !followUpSource)
    ) {
      context.addIssue({
        code: "custom",
        message: "sourceKind must match the referenced source",
        path: ["sourceKind"],
      });
    }
    if (run.status === "generating" && run.completedAtUtc !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A generating run cannot already be completed",
        path: ["completedAtUtc"],
      });
    }
    if (run.status !== "generating" && run.completedAtUtc === undefined) {
      context.addIssue({
        code: "custom",
        message: "A terminal generation run needs completedAtUtc",
        path: ["completedAtUtc"],
      });
    }
    if (run.status === "committed" && run.messageId === undefined) {
      context.addIssue({
        code: "custom",
        message: "A committed generation run must reference its message",
        path: ["messageId"],
      });
    }
    if (
      (run.status === "stale_discarded" || run.status === "failed") &&
      run.reasonCode === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "A discarded or failed run must retain a reasonCode",
        path: ["reasonCode"],
      });
    }
  });
export type ProactiveGenerationRun = z.infer<
  typeof ProactiveGenerationRunSchema
>;
