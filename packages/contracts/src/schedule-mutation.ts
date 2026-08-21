import { z } from "zod";

import { ScheduleItemDraftSchema } from "./schedule.js";
import {
  EntityIdSchema,
  RevisionSchema,
  UtcDateTimeSchema,
  isChronologicalRange,
} from "./primitives.js";

/**
 * Server capability that owns a mutation bundle. This is deliberately not a
 * schedule source and is never accepted by PersonaChatDecision. The server
 * maps the capability to a persisted ScheduleSource at the projection edge.
 */
export const ScheduleMutationOwnerSchema = z.enum([
  "routine",
  "user_negotiation",
  "self_planner",
  "manual",
]);
export type ScheduleMutationOwner = z.infer<typeof ScheduleMutationOwnerSchema>;

/**
 * A create draft without source. Source is intentionally impossible to supply
 * here; it is derived from ScheduleMutationOwner by server-owned code.
 */
export const ServerScheduleItemDraftSchema = z
  .object({
    title: ScheduleItemDraftSchema.shape.title,
    description: ScheduleItemDraftSchema.shape.description,
    category: ScheduleItemDraftSchema.shape.category,
    startAtUtc: ScheduleItemDraftSchema.shape.startAtUtc,
    endAtUtc: ScheduleItemDraftSchema.shape.endAtUtc,
    timezone: ScheduleItemDraftSchema.shape.timezone,
    rigidity: ScheduleItemDraftSchema.shape.rigidity,
    priority: ScheduleItemDraftSchema.shape.priority,
    adherenceProbability: ScheduleItemDraftSchema.shape.adherenceProbability,
    narrativeImportance: ScheduleItemDraftSchema.shape.narrativeImportance,
    shareable: ScheduleItemDraftSchema.shape.shareable,
    stateEffects: ScheduleItemDraftSchema.shape.stateEffects,
    sourceRoutineId: ScheduleItemDraftSchema.shape.sourceRoutineId,
  })
  .strict()
  .refine((item) => isChronologicalRange(item.startAtUtc, item.endAtUtc), {
    message: "endAtUtc must be after startAtUtc",
    path: ["endAtUtc"],
  });
export type ServerScheduleItemDraft = z.infer<
  typeof ServerScheduleItemDraftSchema
>;

export const ServerScheduleAdjustmentSchema = z
  .object({
    itemId: EntityIdSchema,
    expectedRevision: RevisionSchema.optional(),
    newStartAtUtc: UtcDateTimeSchema,
    newEndAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .refine(
    (adjustment) =>
      isChronologicalRange(adjustment.newStartAtUtc, adjustment.newEndAtUtc),
    {
      message: "newEndAtUtc must be after newStartAtUtc",
      path: ["newEndAtUtc"],
    },
  );
export type ServerScheduleAdjustment = z.infer<
  typeof ServerScheduleAdjustmentSchema
>;

export const ServerScheduleCancellationSchema = z
  .object({
    itemId: EntityIdSchema,
    expectedRevision: RevisionSchema.optional(),
  })
  .strict();
export type ServerScheduleCancellation = z.infer<
  typeof ServerScheduleCancellationSchema
>;

export const ScheduleMutationBundleSchema = z
  .object({
    owner: ScheduleMutationOwnerSchema,
    create: z.array(ServerScheduleItemDraftSchema).max(100).optional(),
    reschedule: z.array(ServerScheduleAdjustmentSchema).max(100).optional(),
    cancel: z.array(ServerScheduleCancellationSchema).max(100).optional(),
  })
  .strict()
  .superRefine((bundle, context) => {
    const count =
      (bundle.create?.length ?? 0) +
      (bundle.reschedule?.length ?? 0) +
      (bundle.cancel?.length ?? 0);
    if (count === 0 || count > 100) {
      context.addIssue({
        code: "custom",
        message:
          count === 0
            ? "A schedule mutation bundle must contain at least one change"
            : "A schedule mutation bundle cannot exceed 100 changes",
        path: ["create"],
      });
    }
  });
export type ScheduleMutationBundle = z.infer<
  typeof ScheduleMutationBundleSchema
>;

export const SleepAdjustmentSchema = z
  .object({
    sleepItemId: EntityIdSchema,
    newStartAtUtc: UtcDateTimeSchema,
    newEndAtUtc: UtcDateTimeSchema,
    lostSleepMinutes: z.number().int().nonnegative().max(720),
  })
  .strict()
  .refine(
    (adjustment) =>
      isChronologicalRange(adjustment.newStartAtUtc, adjustment.newEndAtUtc),
    {
      message: "newEndAtUtc must be after newStartAtUtc",
      path: ["newEndAtUtc"],
    },
  );
export type SleepAdjustment = z.infer<typeof SleepAdjustmentSchema>;

export const SelfPlanBundleSchema = z
  .object({
    intentId: EntityIdSchema,
    activity: ServerScheduleItemDraftSchema,
    sleepAdjustment: SleepAdjustmentSchema.optional(),
  })
  .strict();
export type SelfPlanBundle = z.infer<typeof SelfPlanBundleSchema>;
