import { z } from "zod";

import {
  SignedUnitIntervalSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";

/**
 * Synthetic counterpart used by the explicitly single-user local Demo.
 * This is a domain subject identifier, not an authenticated account id.
 */
export const LOCAL_USER_ID = "local-user" as const;

export const RelationshipStateSchema = z
  .object({
    userId: z.literal(LOCAL_USER_ID),
    closeness: UnitIntervalSchema,
    lastInteractionAtUtc: UtcDateTimeSchema.optional(),
  })
  .strict();
export type RelationshipState = z.infer<typeof RelationshipStateSchema>;

export const RelationshipDeltaSchema = z
  .object({
    closeness: SignedUnitIntervalSchema.optional(),
  })
  .strict()
  .refine((value) => value.closeness !== undefined, {
    message: "At least one relationship delta is required",
  });
export type RelationshipDelta = z.infer<typeof RelationshipDeltaSchema>;
