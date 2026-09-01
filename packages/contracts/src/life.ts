import { z } from "zod";

import {
  EntityIdSchema,
  IanaTimezoneSchema,
  NonEmptyTextSchema,
  RevisionSchema,
  ShortTextSchema,
  SignedUnitIntervalSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import { RelationshipDeltaSchema } from "./relationship.js";

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const LocalDateSchema = z
  .string()
  .regex(
    LOCAL_DATE_PATTERN,
    "Expected a local calendar date in YYYY-MM-DD format",
  )
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Expected a valid local calendar date");
export type LocalDate = z.infer<typeof LocalDateSchema>;

export const DayPeriodSchema = z.enum([
  "early_morning",
  "morning",
  "midday",
  "afternoon",
  "evening",
  "late_night",
  "anytime",
]);
export type DayPeriod = z.infer<typeof DayPeriodSchema>;

/**
 * Life facts deliberately stop at day or period precision. Exact UTC instants
 * are retained only as audit timestamps (`recordedAtUtc` / `updatedAtUtc`).
 */
export const TemporalPrecisionSchema = z.enum(["day", "period"]);
export type TemporalPrecision = z.infer<typeof TemporalPrecisionSchema>;

export const LifeSubjectSchema = z.enum(["user", "character", "shared"]);
export type LifeSubject = z.infer<typeof LifeSubjectSchema>;

export const LifeActorSchema = z.enum(["user", "character", "joint"]);
export type LifeActor = z.infer<typeof LifeActorSchema>;

export const LifeDomainSchema = z.enum([
  "work",
  "study",
  "creative",
  "health",
  "rest",
  "social",
  "household",
  "errand",
  "leisure",
  "self_reflection",
  "relationship",
  "identity",
  "other",
]);
export type LifeDomain = z.infer<typeof LifeDomainSchema>;

const IdListSchema = z.array(EntityIdSchema).max(64);
const EvidenceIdListSchema = z.array(EntityIdSchema).min(1).max(64);

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function addDuplicateIssue(
  values: readonly string[],
  path: string,
  context: z.RefinementCtx,
): void {
  if (hasDuplicates(values)) {
    context.addIssue({
      code: "custom",
      message: `${path} must not contain duplicate ids`,
      path: [path],
    });
  }
}

function validateAuditOrder(
  createdAtUtc: string,
  updatedAtUtc: string,
  context: z.RefinementCtx,
): void {
  if (Date.parse(updatedAtUtc) < Date.parse(createdAtUtc)) {
    context.addIssue({
      code: "custom",
      message: "updatedAtUtc must not be before createdAtUtc",
      path: ["updatedAtUtc"],
    });
  }
}

function validateLifeTime(
  value: {
    effectivePeriod?: DayPeriod | undefined;
    temporalPrecision: TemporalPrecision;
  },
  context: z.RefinementCtx,
): void {
  if (
    value.temporalPrecision === "period" &&
    (value.effectivePeriod === undefined || value.effectivePeriod === "anytime")
  ) {
    context.addIssue({
      code: "custom",
      message: "Period precision requires a concrete effectivePeriod",
      path: ["effectivePeriod"],
    });
  }
  if (
    value.temporalPrecision === "day" &&
    value.effectivePeriod !== undefined
  ) {
    context.addIssue({
      code: "custom",
      message: "Day precision must not claim an effectivePeriod",
      path: ["effectivePeriod"],
    });
  }
}

const LifeTimeFields = {
  effectiveLocalDate: LocalDateSchema,
  effectivePeriod: DayPeriodSchema.exclude(["anytime"]).optional(),
  temporalPrecision: TemporalPrecisionSchema,
  recordedAtUtc: UtcDateTimeSchema,
} as const;

const AuditFields = {
  schemaVersion: z.number().int().positive(),
  createdAtUtc: UtcDateTimeSchema,
  updatedAtUtc: UtcDateTimeSchema,
} as const;

export const DailyLifeContextStatusSchema = z.enum([
  "active",
  "settled",
  "superseded",
]);
export type DailyLifeContextStatus = z.infer<
  typeof DailyLifeContextStatusSchema
>;

export const LifeAvailabilitySchema = z.enum([
  "free",
  "interruptible",
  "occupied",
]);
export type LifeAvailability = z.infer<typeof LifeAvailabilitySchema>;

export const DailyLifeContextSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    localDate: LocalDateSchema,
    timezone: IanaTimezoneSchema,
    status: DailyLifeContextStatusSchema,
    currentPeriod: DayPeriodSchema.exclude(["anytime"]),
    availability: LifeAvailabilitySchema,
    availabilityConfidence: z.enum(["observed", "inferred"]),
    theme: ShortTextSchema.optional(),
    currentFocus: ShortTextSchema.optional(),
    todayFocus: z.array(ShortTextSchema).min(1).max(6),
    intentIds: z.array(EntityIdSchema).min(1).max(8),
    activeThreadIds: IdListSchema,
    currentPressureEpisodeIds: IdListSchema,
    recentOutcomeIds: IdListSchema,
    revision: RevisionSchema,
    ...AuditFields,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.intentIds, "intentIds", context);
    addDuplicateIssue(value.activeThreadIds, "activeThreadIds", context);
    addDuplicateIssue(
      value.currentPressureEpisodeIds,
      "currentPressureEpisodeIds",
      context,
    );
    addDuplicateIssue(value.recentOutcomeIds, "recentOutcomeIds", context);
    if (new Set(value.todayFocus).size !== value.todayFocus.length) {
      context.addIssue({
        code: "custom",
        message: "todayFocus must not contain duplicate entries",
        path: ["todayFocus"],
      });
    }
    validateAuditOrder(value.createdAtUtc, value.updatedAtUtc, context);
  });
export type DailyLifeContext = z.infer<typeof DailyLifeContextSchema>;

export const DailyLifeIntentStatusSchema = z.enum([
  "intended",
  "deferred",
  "cancelled",
  "superseded",
]);
export type DailyLifeIntentStatus = z.infer<typeof DailyLifeIntentStatusSchema>;

export const DailyLifeIntentSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    contextId: EntityIdSchema,
    localDate: LocalDateSchema,
    title: z.string().trim().min(1).max(160),
    summary: NonEmptyTextSchema,
    domain: LifeDomainSchema,
    period: DayPeriodSchema,
    durationBand: z.enum([
      "brief",
      "part_of_period",
      "most_of_period",
      "open_ended",
    ]),
    commitmentLevel: z.enum(["anchor", "priority", "optional"]),
    status: DailyLifeIntentStatusSchema,
    sourceKind: z.enum([
      "routine",
      "goal",
      "life_thread",
      "chat",
      "spontaneous",
      "carryover",
    ]),
    shareable: z.boolean(),
    importance: UnitIntervalSchema,
    threadIds: IdListSchema,
    goalRefIds: IdListSchema,
    evidenceMessageIds: IdListSchema,
    deferredToLocalDate: LocalDateSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(240),
    revision: RevisionSchema,
    ...AuditFields,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.threadIds, "threadIds", context);
    addDuplicateIssue(value.goalRefIds, "goalRefIds", context);
    addDuplicateIssue(value.evidenceMessageIds, "evidenceMessageIds", context);
    if (value.sourceKind === "chat" && value.evidenceMessageIds.length === 0) {
      context.addIssue({
        code: "custom",
        message: "A chat-derived intent requires message evidence",
        path: ["evidenceMessageIds"],
      });
    }
    if (value.status === "deferred") {
      if (value.deferredToLocalDate === undefined) {
        context.addIssue({
          code: "custom",
          message: "A deferred intent requires deferredToLocalDate",
          path: ["deferredToLocalDate"],
        });
      } else if (value.deferredToLocalDate <= value.localDate) {
        context.addIssue({
          code: "custom",
          message: "deferredToLocalDate must be after localDate",
          path: ["deferredToLocalDate"],
        });
      }
    } else if (value.deferredToLocalDate !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only a deferred intent may have deferredToLocalDate",
        path: ["deferredToLocalDate"],
      });
    }
    validateAuditOrder(value.createdAtUtc, value.updatedAtUtc, context);
  });
export type DailyLifeIntent = z.infer<typeof DailyLifeIntentSchema>;

export const LifeThreadStatusSchema = z.enum([
  "active",
  "paused",
  "resolved",
  "abandoned",
]);
export type LifeThreadStatus = z.infer<typeof LifeThreadStatusSchema>;

export const LifeThreadMilestoneSchema = z
  .object({
    id: EntityIdSchema,
    afterDays: z.number().int().min(0).max(3_650),
    title: z.string().trim().min(1).max(160),
    focus: z.string().trim().min(1).max(1_000),
    nextStepHint: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type LifeThreadMilestone = z.infer<typeof LifeThreadMilestoneSchema>;

/**
 * A thread owns the civil clock used to advance its frozen plan. This keeps a
 * published goal stable even if a later character version changes timezone or
 * moves to a different story-era anchor.
 */
export const LifeThreadClockSchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("realtime"),
      timezone: IanaTimezoneSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("anchored_story"),
      timezone: IanaTimezoneSchema,
      storyAnchorLocalDate: LocalDateSchema,
      systemAnchorUtc: UtcDateTimeSchema,
    })
    .strict(),
]);
export type LifeThreadClock = z.infer<typeof LifeThreadClockSchema>;

export const LifeThreadTimelinePlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceGoalId: EntityIdSchema,
    sourceCharacterVersion: z.number().int().positive(),
    origin: z.enum(["character_spec", "legacy_fallback_v1"]),
    timeBasis: LifeThreadClockSchema,
    milestones: z.array(LifeThreadMilestoneSchema).min(2).max(12),
    planSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u, "Expected a SHA-256 timeline plan hash"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.milestones[0]?.afterDays !== 0) {
      context.addIssue({
        code: "custom",
        message: "The first life-thread milestone must start at day 0",
        path: ["milestones", 0, "afterDays"],
      });
    }
    const ids = new Set<string>();
    for (const [index, milestone] of value.milestones.entries()) {
      if (ids.has(milestone.id)) {
        context.addIssue({
          code: "custom",
          message: "Life-thread milestone ids must be unique",
          path: ["milestones", index, "id"],
        });
      }
      ids.add(milestone.id);
      if (
        index > 0 &&
        milestone.afterDays <= value.milestones[index - 1]!.afterDays
      ) {
        context.addIssue({
          code: "custom",
          message: "Life-thread milestone day offsets must increase strictly",
          path: ["milestones", index, "afterDays"],
        });
      }
    }
  });
export type LifeThreadTimelinePlan = z.infer<
  typeof LifeThreadTimelinePlanSchema
>;

export const LifeThreadSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    subject: LifeSubjectSchema,
    title: z.string().trim().min(1).max(160),
    summary: NonEmptyTextSchema,
    domain: LifeDomainSchema,
    status: LifeThreadStatusSchema,
    currentStage: ShortTextSchema,
    progressNote: NonEmptyTextSchema.optional(),
    nextStepHint: ShortTextSchema.optional(),
    timelinePlan: LifeThreadTimelinePlanSchema.optional(),
    currentMilestoneId: EntityIdSchema.optional(),
    startedLocalDate: LocalDateSchema,
    lastAdvancedLocalDate: LocalDateSchema.optional(),
    closedLocalDate: LocalDateSchema.optional(),
    sourceMessageIds: IdListSchema,
    parentThreadId: EntityIdSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(240),
    revision: RevisionSchema,
    ...AuditFields,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.sourceMessageIds, "sourceMessageIds", context);
    if (
      (value.timelinePlan === undefined) !==
      (value.currentMilestoneId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "timelinePlan and currentMilestoneId must be provided together",
        path: ["currentMilestoneId"],
      });
    }
    if (value.timelinePlan !== undefined) {
      const ids = new Set(
        value.timelinePlan.milestones.map((milestone) => milestone.id),
      );
      if (
        value.currentMilestoneId !== undefined &&
        !ids.has(value.currentMilestoneId)
      ) {
        context.addIssue({
          code: "custom",
          message: "currentMilestoneId must belong to milestonePlan",
          path: ["currentMilestoneId"],
        });
      }
    }
    if (
      value.lastAdvancedLocalDate !== undefined &&
      value.lastAdvancedLocalDate < value.startedLocalDate
    ) {
      context.addIssue({
        code: "custom",
        message: "lastAdvancedLocalDate must not be before startedLocalDate",
        path: ["lastAdvancedLocalDate"],
      });
    }
    const isClosed =
      value.status === "resolved" || value.status === "abandoned";
    if (isClosed && value.closedLocalDate === undefined) {
      context.addIssue({
        code: "custom",
        message: "A terminal life thread requires closedLocalDate",
        path: ["closedLocalDate"],
      });
    }
    if (!isClosed && value.closedLocalDate !== undefined) {
      context.addIssue({
        code: "custom",
        message: "An active or paused life thread cannot have closedLocalDate",
        path: ["closedLocalDate"],
      });
    }
    if (
      value.closedLocalDate !== undefined &&
      value.closedLocalDate < value.startedLocalDate
    ) {
      context.addIssue({
        code: "custom",
        message: "closedLocalDate must not be before startedLocalDate",
        path: ["closedLocalDate"],
      });
    }
    validateAuditOrder(value.createdAtUtc, value.updatedAtUtc, context);
  });
export type LifeThread = z.infer<typeof LifeThreadSchema>;

export const LifeOutcomeSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    intentId: EntityIdSchema,
    outcomeKind: z.enum([
      "completed",
      "partial",
      "skipped",
      "deferred",
      "cancelled",
    ]),
    summary: NonEmptyTextSchema,
    outcomeFacts: z.array(ShortTextSchema).min(1).max(16),
    origin: z.enum([
      "simulation",
      "conversation_evidence",
      "user_report",
      "character_report",
    ]),
    threadIds: IdListSchema,
    sourceEvidenceIds: EvidenceIdListSchema,
    importance: UnitIntervalSchema,
    stateEffects: z
      .object({
        energy: SignedUnitIntervalSchema.optional(),
        stress: SignedUnitIntervalSchema.optional(),
        mood: SignedUnitIntervalSchema.optional(),
      })
      .strict()
      .refine(
        (effects) =>
          effects.energy !== undefined ||
          effects.stress !== undefined ||
          effects.mood !== undefined,
        "At least one state effect is required",
      )
      .optional(),
    idempotencyKey: z.string().trim().min(1).max(240),
    schemaVersion: z.number().int().positive(),
    ...LifeTimeFields,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.threadIds, "threadIds", context);
    addDuplicateIssue(value.sourceEvidenceIds, "sourceEvidenceIds", context);
    if (new Set(value.outcomeFacts).size !== value.outcomeFacts.length) {
      context.addIssue({
        code: "custom",
        message: "outcomeFacts must not contain duplicates",
        path: ["outcomeFacts"],
      });
    }
    validateLifeTime(value, context);
  });
export type LifeOutcome = z.infer<typeof LifeOutcomeSchema>;

export const DilemmaOptionSchema = z
  .object({
    id: EntityIdSchema,
    label: z.string().trim().min(1).max(160),
    description: NonEmptyTextSchema,
    likelyTradeoffs: z.array(ShortTextSchema).min(1).max(12),
    valuesAtStake: z.array(ShortTextSchema).max(12),
  })
  .strict();
export type DilemmaOption = z.infer<typeof DilemmaOptionSchema>;

export const DilemmaEpisodeSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    threadId: EntityIdSchema.optional(),
    subject: LifeSubjectSchema,
    title: z.string().trim().min(1).max(160),
    summary: NonEmptyTextSchema,
    domain: LifeDomainSchema,
    options: z.array(DilemmaOptionSchema).min(2).max(12),
    status: z.enum(["open", "closed", "abandoned"]),
    closureKind: z.enum(["decision", "circumstance", "abandoned"]).optional(),
    closureSummary: NonEmptyTextSchema.optional(),
    closingDecisionId: EntityIdSchema.optional(),
    sourceMessageIds: EvidenceIdListSchema,
    idempotencyKey: z.string().trim().min(1).max(240),
    schemaVersion: z.number().int().positive(),
    ...LifeTimeFields,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.sourceMessageIds, "sourceMessageIds", context);
    const optionIds = value.options.map((option) => option.id);
    addDuplicateIssue(optionIds, "options", context);
    if (value.status === "open") {
      if (
        value.closureKind !== undefined ||
        value.closureSummary !== undefined ||
        value.closingDecisionId !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "An open dilemma cannot contain closure fields",
          path: ["status"],
        });
      }
    } else {
      if (
        value.closureKind === undefined ||
        value.closureSummary === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "A terminal dilemma requires closureKind and closureSummary",
          path: ["closureKind"],
        });
      }
      if (
        value.closureKind === "decision" &&
        value.closingDecisionId === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "A decision closure requires closingDecisionId",
          path: ["closingDecisionId"],
        });
      }
      if (
        value.closureKind !== undefined &&
        value.closureKind !== "decision" &&
        value.closingDecisionId !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "Only a decision closure may reference a decision",
          path: ["closingDecisionId"],
        });
      }
      if (
        value.status === "abandoned" &&
        value.closureKind !== undefined &&
        value.closureKind !== "abandoned"
      ) {
        context.addIssue({
          code: "custom",
          message: "An abandoned dilemma requires abandoned closureKind",
          path: ["closureKind"],
        });
      }
      if (value.status === "closed" && value.closureKind === "abandoned") {
        context.addIssue({
          code: "custom",
          message: "A closed dilemma cannot use abandoned closureKind",
          path: ["closureKind"],
        });
      }
    }
    if (Date.parse(value.updatedAtUtc) < Date.parse(value.recordedAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "updatedAtUtc must not be before recordedAtUtc",
        path: ["updatedAtUtc"],
      });
    }
    validateLifeTime(value, context);
  });
export type DilemmaEpisode = z.infer<typeof DilemmaEpisodeSchema>;

export const SupportModeSchema = z.enum([
  "listen_only",
  "deliberate",
  "recommend",
  "delegated_decision",
]);
export type SupportMode = z.infer<typeof SupportModeSchema>;

export const SupportInterventionSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema,
    dilemmaId: EntityIdSchema.optional(),
    pressureEpisodeId: EntityIdSchema.optional(),
    mode: SupportModeSchema,
    offeredBy: z.enum(["user", "character"]),
    receivedBy: z.enum(["user", "character"]),
    summary: NonEmptyTextSchema,
    intendedEffect: ShortTextSchema,
    recommendationOptionId: EntityIdSchema.optional(),
    sourceMessageId: EntityIdSchema,
    idempotencyKey: z.string().trim().min(1).max(240),
    schemaVersion: z.number().int().positive(),
    ...LifeTimeFields,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.dilemmaId === undefined &&
      value.pressureEpisodeId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "An intervention must address a dilemma or pressure episode",
        path: ["dilemmaId"],
      });
    }
    if (value.offeredBy === value.receivedBy) {
      context.addIssue({
        code: "custom",
        message: "offeredBy and receivedBy must identify different parties",
        path: ["receivedBy"],
      });
    }
    const requiresOption =
      value.mode === "recommend" || value.mode === "delegated_decision";
    if (requiresOption && value.recommendationOptionId === undefined) {
      context.addIssue({
        code: "custom",
        message: `${value.mode} support requires recommendationOptionId`,
        path: ["recommendationOptionId"],
      });
    }
    if (!requiresOption && value.recommendationOptionId !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Listening or deliberation must not claim a recommendation",
        path: ["recommendationOptionId"],
      });
    }
    validateLifeTime(value, context);
  });
export type SupportIntervention = z.infer<typeof SupportInterventionSchema>;

export const DecisionAuthoritySchema = z.enum([
  "subject",
  "shared",
  "delegated",
]);
export type DecisionAuthority = z.infer<typeof DecisionAuthoritySchema>;

export const DecisionRecordSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema,
    dilemmaId: EntityIdSchema,
    subject: LifeSubjectSchema,
    supportMode: SupportModeSchema,
    authority: DecisionAuthoritySchema,
    decidedBy: LifeActorSchema,
    selectedOptionId: EntityIdSchema,
    selectionSummary: NonEmptyTextSchema,
    reasoningSummary: NonEmptyTextSchema,
    supportInterventionIds: IdListSchema,
    sourceMessageIds: EvidenceIdListSchema,
    authorizedByMessageId: EntityIdSchema.optional(),
    confidence: UnitIntervalSchema,
    status: z.enum(["current", "superseded", "retracted"]),
    supersedesDecisionId: EntityIdSchema.optional(),
    supersededByDecisionId: EntityIdSchema.optional(),
    retractedByMessageId: EntityIdSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(240),
    schemaVersion: z.number().int().positive(),
    ...LifeTimeFields,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(
      value.supportInterventionIds,
      "supportInterventionIds",
      context,
    );
    addDuplicateIssue(value.sourceMessageIds, "sourceMessageIds", context);
    if (value.authority === "delegated") {
      if (value.supportMode !== "delegated_decision") {
        context.addIssue({
          code: "custom",
          message: "Delegated authority requires delegated supportMode",
          path: ["supportMode"],
        });
      }
      if (value.authorizedByMessageId === undefined) {
        context.addIssue({
          code: "custom",
          message:
            "A delegated decision requires explicit message authorization",
          path: ["authorizedByMessageId"],
        });
      }
      if (
        (value.subject === "user" && value.decidedBy !== "character") ||
        (value.subject === "character" && value.decidedBy !== "user") ||
        (value.subject === "shared" && value.decidedBy === "joint")
      ) {
        context.addIssue({
          code: "custom",
          message: "A delegated decision must be made by a non-subject party",
          path: ["decidedBy"],
        });
      }
    } else {
      if (value.supportMode === "delegated_decision") {
        context.addIssue({
          code: "custom",
          message: "Delegated supportMode requires delegated authority",
          path: ["authority"],
        });
      }
      if (value.authorizedByMessageId !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Only delegated decisions may reference authorization",
          path: ["authorizedByMessageId"],
        });
      }
    }
    if (value.authority === "shared" && value.decidedBy !== "joint") {
      context.addIssue({
        code: "custom",
        message: "Shared authority requires a joint decision",
        path: ["decidedBy"],
      });
    }
    if (
      value.authority === "subject" &&
      ((value.subject === "user" && value.decidedBy !== "user") ||
        (value.subject === "character" && value.decidedBy !== "character") ||
        (value.subject === "shared" && value.decidedBy !== "joint"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Subject authority must be exercised by the subject",
        path: ["decidedBy"],
      });
    }
    if (
      value.status === "superseded" &&
      value.supersededByDecisionId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "A superseded decision requires supersededByDecisionId",
        path: ["supersededByDecisionId"],
      });
    }
    if (
      value.status !== "superseded" &&
      value.supersededByDecisionId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Only a superseded decision may have supersededByDecisionId",
        path: ["supersededByDecisionId"],
      });
    }
    if (
      value.status === "retracted" &&
      value.retractedByMessageId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "A retracted decision requires retractedByMessageId",
        path: ["retractedByMessageId"],
      });
    }
    if (
      value.status !== "retracted" &&
      value.retractedByMessageId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Only a retracted decision may have retractedByMessageId",
        path: ["retractedByMessageId"],
      });
    }
    validateLifeTime(value, context);
  });
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** An observed action. A decision is not evidence that this action happened. */
export const ActionRecordSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    decisionId: EntityIdSchema,
    subject: LifeSubjectSchema,
    performedBy: LifeActorSchema,
    actionKind: z.enum(["initiated", "advanced", "completed", "abandoned"]),
    summary: NonEmptyTextSchema,
    sourceEvidenceIds: EvidenceIdListSchema,
    idempotencyKey: z.string().trim().min(1).max(240),
    schemaVersion: z.number().int().positive(),
    ...LifeTimeFields,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.sourceEvidenceIds, "sourceEvidenceIds", context);
    validateLifeTime(value, context);
  });
export type ActionRecord = z.infer<typeof ActionRecordSchema>;

export const OutcomeRecordSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    decisionId: EntityIdSchema,
    actionIds: IdListSchema,
    causeKind: z.enum(["action", "external", "mixed"]),
    valence: z.enum(["positive", "negative", "mixed", "neutral"]),
    summary: NonEmptyTextSchema,
    consequenceFacts: z.array(ShortTextSchema).min(1).max(20),
    sourceEvidenceIds: EvidenceIdListSchema,
    confidence: UnitIntervalSchema,
    status: z.enum(["observed", "confirmed", "superseded"]),
    supersededByOutcomeId: EntityIdSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(240),
    schemaVersion: z.number().int().positive(),
    ...LifeTimeFields,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.actionIds, "actionIds", context);
    addDuplicateIssue(value.sourceEvidenceIds, "sourceEvidenceIds", context);
    if (
      (value.causeKind === "action" || value.causeKind === "mixed") &&
      value.actionIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: `${value.causeKind} outcomes require at least one action`,
        path: ["actionIds"],
      });
    }
    if (value.causeKind === "external" && value.actionIds.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "An external outcome must not claim action causation",
        path: ["actionIds"],
      });
    }
    if (
      value.status === "superseded" &&
      value.supersededByOutcomeId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "A superseded outcome requires supersededByOutcomeId",
        path: ["supersededByOutcomeId"],
      });
    }
    if (
      value.status !== "superseded" &&
      value.supersededByOutcomeId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Only a superseded outcome may have supersededByOutcomeId",
        path: ["supersededByOutcomeId"],
      });
    }
    if (
      new Set(value.consequenceFacts).size !== value.consequenceFacts.length
    ) {
      context.addIssue({
        code: "custom",
        message: "consequenceFacts must not contain duplicates",
        path: ["consequenceFacts"],
      });
    }
    validateLifeTime(value, context);
  });
export type OutcomeRecord = z.infer<typeof OutcomeRecordSchema>;

export const ReflectionRecordSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    subject: LifeSubjectSchema,
    reflectedBy: LifeActorSchema,
    decisionId: EntityIdSchema.optional(),
    outcomeId: EntityIdSchema.optional(),
    summary: NonEmptyTextSchema,
    lessons: z.array(ShortTextSchema).min(1).max(12),
    stanceTowardDecision: z.enum([
      "affirm",
      "question",
      "reverse",
      "mixed",
      "unclear",
    ]),
    changedInterpretation: z.boolean(),
    sourceMessageIds: EvidenceIdListSchema,
    idempotencyKey: z.string().trim().min(1).max(240),
    schemaVersion: z.number().int().positive(),
    ...LifeTimeFields,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.decisionId === undefined && value.outcomeId === undefined) {
      context.addIssue({
        code: "custom",
        message: "A reflection must reference a decision or outcome",
        path: ["decisionId"],
      });
    }
    addDuplicateIssue(value.sourceMessageIds, "sourceMessageIds", context);
    if (new Set(value.lessons).size !== value.lessons.length) {
      context.addIssue({
        code: "custom",
        message: "lessons must not contain duplicates",
        path: ["lessons"],
      });
    }
    validateLifeTime(value, context);
  });
export type ReflectionRecord = z.infer<typeof ReflectionRecordSchema>;

export const PressureEpisodeSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    threadId: EntityIdSchema.optional(),
    dilemmaId: EntityIdSchema.optional(),
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
    triggerSummary: NonEmptyTextSchema,
    status: z.enum(["open", "improving", "worsening", "resolved"]),
    initialPressure: UnitIntervalSchema,
    currentPressure: UnitIntervalSchema,
    initialClarity: UnitIntervalSchema,
    currentClarity: UnitIntervalSchema,
    initialFeltUnderstood: UnitIntervalSchema,
    currentFeltUnderstood: UnitIntervalSchema,
    interventionIds: IdListSchema,
    outcomeIds: IdListSchema,
    sourceMessageIds: EvidenceIdListSchema,
    latestEvidenceMessageId: EntityIdSchema,
    resolutionEvidenceMessageId: EntityIdSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(240),
    schemaVersion: z.number().int().positive(),
    ...LifeTimeFields,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.interventionIds, "interventionIds", context);
    addDuplicateIssue(value.outcomeIds, "outcomeIds", context);
    addDuplicateIssue(value.sourceMessageIds, "sourceMessageIds", context);
    if (!value.sourceMessageIds.includes(value.latestEvidenceMessageId)) {
      context.addIssue({
        code: "custom",
        message: "latestEvidenceMessageId must be present in sourceMessageIds",
        path: ["latestEvidenceMessageId"],
      });
    }
    if (value.status === "resolved") {
      if (value.resolutionEvidenceMessageId === undefined) {
        context.addIssue({
          code: "custom",
          message: "A resolved pressure episode requires resolution evidence",
          path: ["resolutionEvidenceMessageId"],
        });
      } else if (
        !value.sourceMessageIds.includes(value.resolutionEvidenceMessageId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Resolution evidence must be present in sourceMessageIds",
          path: ["resolutionEvidenceMessageId"],
        });
      }
    } else if (value.resolutionEvidenceMessageId !== undefined) {
      context.addIssue({
        code: "custom",
        message:
          "Only a resolved pressure episode may have resolution evidence",
        path: ["resolutionEvidenceMessageId"],
      });
    }
    if (Date.parse(value.updatedAtUtc) < Date.parse(value.recordedAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "updatedAtUtc must not be before recordedAtUtc",
        path: ["updatedAtUtc"],
      });
    }
    validateLifeTime(value, context);
  });
export type PressureEpisode = z.infer<typeof PressureEpisodeSchema>;

export const RelationshipMilestoneSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    kind: z.enum([
      "meaningful_support",
      "shared_decision",
      "disagreement",
      "repair",
      "turning_point",
      "mutual_vulnerability",
      "other",
    ]),
    title: z.string().trim().min(1).max(160),
    summary: NonEmptyTextSchema,
    significance: UnitIntervalSchema,
    relationshipDelta: RelationshipDeltaSchema.optional(),
    interventionIds: IdListSchema,
    decisionIds: IdListSchema,
    outcomeIds: IdListSchema,
    reflectionIds: IdListSchema,
    sourceMessageIds: EvidenceIdListSchema,
    idempotencyKey: z.string().trim().min(1).max(240),
    schemaVersion: z.number().int().positive(),
    ...LifeTimeFields,
  })
  .strict()
  .superRefine((value, context) => {
    addDuplicateIssue(value.interventionIds, "interventionIds", context);
    addDuplicateIssue(value.decisionIds, "decisionIds", context);
    addDuplicateIssue(value.outcomeIds, "outcomeIds", context);
    addDuplicateIssue(value.reflectionIds, "reflectionIds", context);
    addDuplicateIssue(value.sourceMessageIds, "sourceMessageIds", context);
    const causalReferenceCount =
      value.interventionIds.length +
      value.decisionIds.length +
      value.outcomeIds.length +
      value.reflectionIds.length;
    if (causalReferenceCount === 0) {
      context.addIssue({
        code: "custom",
        message: "A relationship milestone requires a causal domain reference",
        path: ["interventionIds"],
      });
    }
    validateLifeTime(value, context);
  });
export type RelationshipMilestone = z.infer<typeof RelationshipMilestoneSchema>;
