import { z } from "zod";

import { ScheduleRigiditySchema } from "./character.js";
import {
  EntityIdSchema,
  IanaTimezoneSchema,
  ReasonCodeSchema,
  RevisionSchema,
  SignedUnitIntervalSchema,
  ShortTextSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
  isChronologicalRange,
} from "./primitives.js";

export const ScheduleStatusSchema = z.enum([
  "planned",
  "in_progress",
  "completed",
  "partial",
  "skipped",
  "cancelled",
]);
export type ScheduleStatus = z.infer<typeof ScheduleStatusSchema>;

export const ScheduleCategorySchema = z.enum([
  "sleep",
  "work",
  "study",
  "meal",
  "exercise",
  "social",
  "travel",
  "leisure",
  "self_care",
  "errand",
  "other",
]);
export type ScheduleCategory = z.infer<typeof ScheduleCategorySchema>;

export const ScheduleSourceSchema = z.enum([
  "routine",
  "initial_plan",
  "user_invitation",
  "runtime_replan",
  "manual",
]);
export type ScheduleSource = z.infer<typeof ScheduleSourceSchema>;

export const ScheduleStateEffectsSchema = z
  .object({
    moodValence: SignedUnitIntervalSchema.optional(),
    moodArousal: SignedUnitIntervalSchema.optional(),
    energy: SignedUnitIntervalSchema.optional(),
    stress: SignedUnitIntervalSchema.optional(),
    socialBattery: SignedUnitIntervalSchema.optional(),
    focus: SignedUnitIntervalSchema.optional(),
  })
  .strict();
export type ScheduleStateEffects = z.infer<typeof ScheduleStateEffectsSchema>;

const ScheduleDraftShape = {
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().max(1_000),
  category: ScheduleCategorySchema,
  startAtUtc: UtcDateTimeSchema,
  endAtUtc: UtcDateTimeSchema,
  timezone: IanaTimezoneSchema,
  rigidity: ScheduleRigiditySchema,
  priority: UnitIntervalSchema,
  source: ScheduleSourceSchema,
  adherenceProbability: UnitIntervalSchema,
  narrativeImportance: UnitIntervalSchema,
  shareable: z.boolean(),
  stateEffects: ScheduleStateEffectsSchema,
  sourceRoutineId: EntityIdSchema.optional(),
} as const;

export const ScheduleItemDraftSchema = z
  .object(ScheduleDraftShape)
  .strict()
  .refine((item) => isChronologicalRange(item.startAtUtc, item.endAtUtc), {
    message: "endAtUtc must be after startAtUtc",
    path: ["endAtUtc"],
  });
export type ScheduleItemDraft = z.infer<typeof ScheduleItemDraftSchema>;

export const ScheduleItemSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    ...ScheduleDraftShape,
    status: ScheduleStatusSchema,
    revision: RevisionSchema,
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((item, context) => {
    if (!isChronologicalRange(item.startAtUtc, item.endAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "endAtUtc must be after startAtUtc",
        path: ["endAtUtc"],
      });
    }
  });
export type ScheduleItem = z.infer<typeof ScheduleItemSchema>;

const ProposalReasonShape = {
  reasonCode: ReasonCodeSchema,
  reasonSummary: ShortTextSchema,
} as const;

export const CreateScheduleEffectProposalSchema = z
  .object({
    operation: z.literal("create"),
    item: ScheduleItemDraftSchema,
    ...ProposalReasonShape,
  })
  .strict();
export type CreateScheduleEffectProposal = z.infer<
  typeof CreateScheduleEffectProposalSchema
>;

export const RescheduleEffectProposalSchema = z
  .object({
    operation: z.literal("reschedule"),
    itemId: EntityIdSchema,
    newStartAtUtc: UtcDateTimeSchema,
    newEndAtUtc: UtcDateTimeSchema,
    ...ProposalReasonShape,
  })
  .strict()
  .refine(
    (proposal) =>
      isChronologicalRange(proposal.newStartAtUtc, proposal.newEndAtUtc),
    {
      message: "newEndAtUtc must be after newStartAtUtc",
      path: ["newEndAtUtc"],
    },
  );
export type RescheduleEffectProposal = z.infer<
  typeof RescheduleEffectProposalSchema
>;

export const CancelScheduleEffectProposalSchema = z
  .object({
    operation: z.literal("cancel"),
    itemId: EntityIdSchema,
    ...ProposalReasonShape,
  })
  .strict();
export type CancelScheduleEffectProposal = z.infer<
  typeof CancelScheduleEffectProposalSchema
>;

export const ScheduleEffectProposalSchema = z.discriminatedUnion("operation", [
  CreateScheduleEffectProposalSchema,
  RescheduleEffectProposalSchema,
  CancelScheduleEffectProposalSchema,
]);
export type ScheduleEffectProposal = z.infer<
  typeof ScheduleEffectProposalSchema
>;

export const SchedulePlanProposalSchema = z
  .object({
    horizonStartAtUtc: UtcDateTimeSchema,
    horizonEndAtUtc: UtcDateTimeSchema,
    items: z.array(ScheduleItemDraftSchema).max(100),
    reasonCode: ReasonCodeSchema,
    reasonSummary: ShortTextSchema,
  })
  .strict()
  .refine(
    (proposal) =>
      isChronologicalRange(
        proposal.horizonStartAtUtc,
        proposal.horizonEndAtUtc,
      ),
    {
      message: "horizonEndAtUtc must be after horizonStartAtUtc",
      path: ["horizonEndAtUtc"],
    },
  );
export type SchedulePlanProposal = z.infer<typeof SchedulePlanProposalSchema>;
