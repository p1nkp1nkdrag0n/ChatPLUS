import { z } from "zod";

import {
  EntityIdSchema,
  ReasonCodeSchema,
  ShortTextSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import { FieldOriginSchema } from "./provenance.js";

export const MemoryKindSchema = z.enum([
  "semantic",
  "episodic",
  "relationship",
  "commitment",
]);
export type MemoryKind = z.infer<typeof MemoryKindSchema>;

export const MemoryStatusSchema = z.enum(["active", "superseded", "forgotten"]);
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;

const MemoryContentShape = {
  kind: MemoryKindSchema,
  content: z.string().trim().min(1).max(2_000),
  importance: UnitIntervalSchema,
  confidence: UnitIntervalSchema,
  occurredAtUtc: UtcDateTimeSchema.optional(),
  expiresAtUtc: UtcDateTimeSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(20),
  sourceMessageIds: z.array(EntityIdSchema).max(20),
  sourceActivityEventIds: z.array(EntityIdSchema).max(20),
  origin: FieldOriginSchema,
} as const;

export const MemoryCandidateSchema = z
  .object({
    ...MemoryContentShape,
    reasonCode: ReasonCodeSchema,
    reasonSummary: ShortTextSchema,
  })
  .strict()
  .refine(
    (memory) =>
      memory.expiresAtUtc === undefined ||
      memory.occurredAtUtc === undefined ||
      Date.parse(memory.expiresAtUtc) > Date.parse(memory.occurredAtUtc),
    {
      message: "expiresAtUtc must be later than occurredAtUtc",
      path: ["expiresAtUtc"],
    },
  );
export type MemoryCandidate = z.infer<typeof MemoryCandidateSchema>;

/** Alias retained for feature modules that use proposal terminology. */
export const MemoryProposalSchema = MemoryCandidateSchema;
export type MemoryProposal = MemoryCandidate;

export const MemorySchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    ...MemoryContentShape,
    status: MemoryStatusSchema,
    dedupeKey: z.string().trim().min(1).max(240),
    supersededById: EntityIdSchema.optional(),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((memory, context) => {
    if (
      memory.expiresAtUtc !== undefined &&
      memory.occurredAtUtc !== undefined &&
      Date.parse(memory.expiresAtUtc) <= Date.parse(memory.occurredAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "expiresAtUtc must be later than occurredAtUtc",
        path: ["expiresAtUtc"],
      });
    }
    if (memory.status === "superseded" && memory.supersededById === undefined) {
      context.addIssue({
        code: "custom",
        message: "A superseded memory must reference its replacement",
        path: ["supersededById"],
      });
    }
  });
export type Memory = z.infer<typeof MemorySchema>;
