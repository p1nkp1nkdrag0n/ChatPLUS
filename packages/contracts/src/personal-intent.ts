import { z } from "zod";

import {
  EntityIdSchema,
  ReasonCodeSchema,
  ShortTextSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
  isChronologicalRange,
} from "./primitives.js";
import { ScheduleCategorySchema } from "./schedule.js";

export const PersonalIntentBasisSchema = z.enum([
  "goal",
  "preference",
  "routine",
  "chat",
  "spontaneous",
]);
export type PersonalIntentBasis = z.infer<typeof PersonalIntentBasisSchema>;

export const PersonalIntentStatusSchema = z.enum([
  "pending",
  "planned",
  "consumed",
  "expired",
  "rejected",
  "superseded",
]);
export type PersonalIntentStatus = z.infer<typeof PersonalIntentStatusSchema>;

export const PersonalIntentSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    activity: z.string().trim().min(1).max(160),
    category: ScheduleCategorySchema,
    desiredDurationMinutes: z.number().int().min(5).max(1_440),
    earliestAtUtc: UtcDateTimeSchema.optional(),
    latestAtUtc: UtcDateTimeSchema.optional(),
    basisKind: PersonalIntentBasisSchema,
    basisRefIds: z.array(EntityIdSchema).max(20),
    evidenceMessageIds: z.array(EntityIdSchema).max(20),
    priority: UnitIntervalSchema,
    freshness: UnitIntervalSchema,
    status: PersonalIntentStatusSchema,
    dedupeKey: z.string().trim().min(1).max(240),
    specVersion: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
    attemptCount: z.number().int().nonnegative(),
    lastAttemptAtUtc: UtcDateTimeSchema.optional(),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((intent, context) => {
    if (
      intent.earliestAtUtc !== undefined &&
      intent.latestAtUtc !== undefined &&
      !isChronologicalRange(intent.earliestAtUtc, intent.latestAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "latestAtUtc must be after earliestAtUtc",
        path: ["latestAtUtc"],
      });
    }
    if (Date.parse(intent.updatedAtUtc) < Date.parse(intent.createdAtUtc)) {
      context.addIssue({
        code: "custom",
        message: "updatedAtUtc must not be before createdAtUtc",
        path: ["updatedAtUtc"],
      });
    }
  });
export type PersonalIntent = z.infer<typeof PersonalIntentSchema>;

/**
 * Model-facing chat proposal. Ownership, ids, status, source references and
 * exact timestamps are deliberately absent and therefore rejected by the
 * strict schema when a model attempts to supply them.
 */
export const PersonalIntentCandidateSchema = z
  .object({
    activity: z.string().trim().min(1).max(160),
    category: ScheduleCategorySchema.optional(),
    durationHint: z.string().trim().min(1).max(120).optional(),
    timingHint: z.string().trim().min(1).max(240).optional(),
    basisKind: z.literal("chat"),
    evidenceQuotes: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
    reasonCode: ReasonCodeSchema,
    reasonSummary: ShortTextSchema,
  })
  .strict();
export type PersonalIntentCandidate = z.infer<
  typeof PersonalIntentCandidateSchema
>;
