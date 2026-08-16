import { z } from "zod";

import {
  EntityIdSchema,
  RevisionSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
  isChronologicalRange,
} from "./primitives.js";
import { ScheduleCategorySchema, ScheduleStatusSchema } from "./schedule.js";
import { RuntimeStateDeltaSchema } from "./state.js";

export const ActivityEventKindSchema = z.enum([
  "started",
  "completed",
  "partial",
  "skipped",
  "cancelled",
]);
export type ActivityEventKind = z.infer<typeof ActivityEventKindSchema>;

export const ActivityEventSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    scheduleItemId: EntityIdSchema,
    kind: ActivityEventKindSchema,
    category: ScheduleCategorySchema,
    scheduleStatus: ScheduleStatusSchema,
    startedAtUtc: UtcDateTimeSchema,
    endedAtUtc: UtcDateTimeSchema.optional(),
    occurredAtUtc: UtcDateTimeSchema,
    summary: z.string().trim().min(1).max(1_000),
    completionRatio: UnitIntervalSchema,
    importance: UnitIntervalSchema,
    shareable: z.boolean(),
    stateDelta: RuntimeStateDeltaSchema.optional(),
    idempotencyKey: z.string().trim().min(1).max(240),
    createdAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.endedAtUtc !== undefined &&
      !isChronologicalRange(event.startedAtUtc, event.endedAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "endedAtUtc must be after startedAtUtc",
        path: ["endedAtUtc"],
      });
    }
    if (event.kind === "started" && event.endedAtUtc !== undefined) {
      context.addIssue({
        code: "custom",
        message: "A started event cannot already have endedAtUtc",
        path: ["endedAtUtc"],
      });
    }
  });
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

export const ProactiveCandidateStatusSchema = z.enum([
  "pending",
  "sent",
  "expired",
  "suppressed",
  "merged",
]);
export type ProactiveCandidateStatus = z.infer<
  typeof ProactiveCandidateStatusSchema
>;

export const ProactiveCandidateSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    activityEventId: EntityIdSchema,
    category: ScheduleCategorySchema,
    status: ProactiveCandidateStatusSchema,
    summary: z.string().trim().min(1).max(1_000),
    importance: UnitIntervalSchema,
    earliestSendAtUtc: UtcDateTimeSchema,
    expiresAtUtc: UtcDateTimeSchema,
    dedupeKey: z.string().trim().min(1).max(240),
    mergedIntoId: EntityIdSchema.optional(),
    sentMessageId: EntityIdSchema.optional(),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
    revision: RevisionSchema,
  })
  .strict()
  .superRefine((candidate, context) => {
    if (
      !isChronologicalRange(candidate.earliestSendAtUtc, candidate.expiresAtUtc)
    ) {
      context.addIssue({
        code: "custom",
        message: "expiresAtUtc must be after earliestSendAtUtc",
        path: ["expiresAtUtc"],
      });
    }
    if (candidate.status === "merged" && candidate.mergedIntoId === undefined) {
      context.addIssue({
        code: "custom",
        message: "A merged candidate must reference its target",
        path: ["mergedIntoId"],
      });
    }
    if (candidate.status === "sent" && candidate.sentMessageId === undefined) {
      context.addIssue({
        code: "custom",
        message: "A sent candidate must reference its message",
        path: ["sentMessageId"],
      });
    }
  });
export type ProactiveCandidate = z.infer<typeof ProactiveCandidateSchema>;

export const SimulationCursorSchema = z
  .object({
    agentId: EntityIdSchema,
    lastSettledAtUtc: UtcDateTimeSchema,
    revision: RevisionSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict();
export type SimulationCursor = z.infer<typeof SimulationCursorSchema>;

export const SettlementReasonSchema = z.enum([
  "activation",
  "hourly",
  "chat_turn",
  "manual",
]);
export type SettlementReason = z.infer<typeof SettlementReasonSchema>;

export const SettlementResultSchema = z
  .object({
    agentId: EntityIdSchema,
    fromUtc: UtcDateTimeSchema,
    toUtc: UtcDateTimeSchema,
    reason: SettlementReasonSchema,
    idempotencyKey: z.string().trim().min(1).max(240),
    startedItemIds: z.array(EntityIdSchema).max(200),
    settledItemIds: z.array(EntityIdSchema).max(200),
    activityEventIds: z.array(EntityIdSchema).max(400),
    proactiveCandidateIds: z.array(EntityIdSchema).max(100),
    stateRevision: RevisionSchema,
    cursorRevision: RevisionSchema,
  })
  .strict()
  .refine((result) => Date.parse(result.fromUtc) <= Date.parse(result.toUtc), {
    message: "toUtc must not be before fromUtc",
    path: ["toUtc"],
  });
export type SettlementResult = z.infer<typeof SettlementResultSchema>;
