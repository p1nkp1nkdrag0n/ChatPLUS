import { z } from "zod";

import {
  EntityIdSchema,
  RevisionSchema,
  SignedUnitIntervalSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import { RelationshipStateSchema } from "./relationship.js";

export const RuntimeStateSchema = z
  .object({
    agentId: EntityIdSchema,
    asOfUtc: UtcDateTimeSchema,
    moodValence: SignedUnitIntervalSchema,
    moodArousal: UnitIntervalSchema,
    energy: UnitIntervalSchema,
    stress: UnitIntervalSchema,
    socialBattery: UnitIntervalSchema,
    focus: UnitIntervalSchema,
    sleepDebtMinutes: z.number().int().min(0).max(720).default(0),
    currentActivityId: EntityIdSchema.optional(),
    locationContext: z.string().trim().min(1).max(240).optional(),
    relationship: RelationshipStateSchema,
    revision: RevisionSchema,
  })
  .strict();
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const RuntimeStateDeltaSchema = z
  .object({
    moodValence: SignedUnitIntervalSchema.optional(),
    moodArousal: SignedUnitIntervalSchema.optional(),
    energy: SignedUnitIntervalSchema.optional(),
    stress: SignedUnitIntervalSchema.optional(),
    socialBattery: SignedUnitIntervalSchema.optional(),
    focus: SignedUnitIntervalSchema.optional(),
    currentActivityId: z.union([EntityIdSchema, z.null()]).optional(),
    locationContext: z
      .union([z.string().trim().min(1).max(240), z.null()])
      .optional(),
  })
  .strict()
  .refine(
    (delta) => Object.values(delta).some((value) => value !== undefined),
    {
      message: "At least one state delta is required",
    },
  );
export type RuntimeStateDelta = z.infer<typeof RuntimeStateDeltaSchema>;

export const StateChangeRecordSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    beforeRevision: RevisionSchema,
    afterRevision: RevisionSchema,
    delta: RuntimeStateDeltaSchema,
    reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    reasonSummary: z.string().trim().min(1).max(240),
    occurredAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .refine((record) => record.afterRevision > record.beforeRevision, {
    message: "afterRevision must be greater than beforeRevision",
    path: ["afterRevision"],
  });
export type StateChangeRecord = z.infer<typeof StateChangeRecordSchema>;
