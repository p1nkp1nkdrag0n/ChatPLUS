import { z } from "zod";

import {
  SignedUnitIntervalSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";

export const LOCAL_USER_ID = "local-user" as const;

export const RelationshipStateSchema = z
  .object({
    userId: z.literal(LOCAL_USER_ID),
    closeness: UnitIntervalSchema,
    trust: UnitIntervalSchema,
    familiarity: UnitIntervalSchema,
    recentInteractionValence: SignedUnitIntervalSchema,
    lastInteractionAtUtc: UtcDateTimeSchema.optional(),
  })
  .strict();
export type RelationshipState = z.infer<typeof RelationshipStateSchema>;

export const RelationshipDeltaSchema = z
  .object({
    closeness: SignedUnitIntervalSchema.optional(),
    trust: SignedUnitIntervalSchema.optional(),
    familiarity: SignedUnitIntervalSchema.optional(),
    recentInteractionValence: SignedUnitIntervalSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.closeness !== undefined ||
      value.trust !== undefined ||
      value.familiarity !== undefined ||
      value.recentInteractionValence !== undefined,
    { message: "At least one relationship delta is required" },
  );
export type RelationshipDelta = z.infer<typeof RelationshipDeltaSchema>;
