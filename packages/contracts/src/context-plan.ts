import { z } from "zod";

const ContextItemIdSchema = z.string().trim().min(1).max(160);
const ContextItemIdsSchema = z.array(ContextItemIdSchema).max(64);

export const ContextPlanTopicFatigueSchema = z
  .object({
    topicKey: z.string().trim().min(1).max(120),
    recentAssistantMentions: z.number().int().nonnegative().max(12),
    penalty: z.number().min(0).max(0.6),
  })
  .strict();
export type ContextPlanTopicFatigue = z.infer<
  typeof ContextPlanTopicFatigueSchema
>;

export const ContextPlanTraceItemSchema = z
  .object({
    itemType: z.string().trim().min(1).max(80),
    itemId: ContextItemIdSchema,
    score: z.number().finite(),
    included: z.boolean(),
    source: z.enum([
      "user_message",
      "selected_evidence",
      "current_activity",
      "continuity_cue",
      "none",
    ]),
    sourceId: ContextItemIdSchema.optional(),
    matchedText: z.string().trim().min(1).max(500).optional(),
    reasons: z.array(z.string().trim().min(1).max(240)).max(12),
  })
  .strict();
export type ContextPlanTraceItem = z.infer<typeof ContextPlanTraceItemSchema>;

/** Server-owned policy output describing exactly what this turn may see. */
export const ContextPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    activatedTraitIds: ContextItemIdsSchema,
    activatedValueIds: ContextItemIdsSchema,
    activatedContradictionIds: ContextItemIdsSchema,
    activatedGoalIds: ContextItemIdsSchema,
    activatedPreferenceIds: ContextItemIdsSchema,
    includeAutobiography: z.boolean(),
    includeCalendar: z.boolean(),
    includeFutureSchedule: z.boolean(),
    includeRetrievedEvidence: z.boolean(),
    suppressedGoalIds: ContextItemIdsSchema,
    topicFatigue: z.array(ContextPlanTopicFatigueSchema).max(64),
    trace: z.array(ContextPlanTraceItemSchema).max(256),
  })
  .strict();
export type ContextPlan = z.infer<typeof ContextPlanSchema>;
