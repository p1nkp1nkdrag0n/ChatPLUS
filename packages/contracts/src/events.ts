import { z } from "zod";

import { CharacterSourceKindSchema } from "./character.js";
import {
  EntityIdSchema,
  ReasonCodeSchema,
  RevisionSchema,
  ShortTextSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import { ScheduleStatusSchema } from "./schedule.js";
import { SettlementReasonSchema } from "./simulation.js";

const DomainEventBaseShape = {
  id: EntityIdSchema,
  agentId: EntityIdSchema.optional(),
  occurredAtUtc: UtcDateTimeSchema,
  idempotencyKey: z.string().trim().min(1).max(240).optional(),
  correlationId: EntityIdSchema.optional(),
  causationId: EntityIdSchema.optional(),
} as const;

const CharacterCreatedEventSchema = z
  .object({
    ...DomainEventBaseShape,
    type: z.literal("character.created"),
    payload: z
      .object({
        version: z.number().int().positive(),
        sourceType: CharacterSourceKindSchema,
      })
      .strict(),
  })
  .strict();

const CharacterPublishedEventSchema = z
  .object({
    ...DomainEventBaseShape,
    type: z.literal("character.published"),
    payload: z.object({ version: z.number().int().positive() }).strict(),
  })
  .strict();

const ScheduleChangedEventSchema = z
  .object({
    ...DomainEventBaseShape,
    type: z.literal("schedule.changed"),
    payload: z
      .object({
        scheduleItemId: EntityIdSchema,
        operation: z.enum(["create", "reschedule", "cancel", "settle"]),
        status: ScheduleStatusSchema,
        revision: RevisionSchema,
        reasonCode: ReasonCodeSchema,
        reasonSummary: ShortTextSchema,
      })
      .strict(),
  })
  .strict();

const RuntimeStateUpdatedEventSchema = z
  .object({
    ...DomainEventBaseShape,
    type: z.literal("runtime_state.updated"),
    payload: z
      .object({ revision: RevisionSchema, reasonCode: ReasonCodeSchema })
      .strict(),
  })
  .strict();

const MemoryCreatedEventSchema = z
  .object({
    ...DomainEventBaseShape,
    type: z.literal("memory.created"),
    payload: z.object({ memoryId: EntityIdSchema }).strict(),
  })
  .strict();

const MessageCreatedEventSchema = z
  .object({
    ...DomainEventBaseShape,
    type: z.literal("message.created"),
    payload: z
      .object({
        messageId: EntityIdSchema,
        sessionId: EntityIdSchema,
        proactive: z.boolean(),
      })
      .strict(),
  })
  .strict();

const ActivityRecordedEventSchema = z
  .object({
    ...DomainEventBaseShape,
    type: z.literal("activity.recorded"),
    payload: z
      .object({
        activityEventId: EntityIdSchema,
        scheduleItemId: EntityIdSchema,
      })
      .strict(),
  })
  .strict();

const SettlementCompletedEventSchema = z
  .object({
    ...DomainEventBaseShape,
    type: z.literal("settlement.completed"),
    payload: z
      .object({
        fromUtc: UtcDateTimeSchema,
        toUtc: UtcDateTimeSchema,
        reason: SettlementReasonSchema,
        settledCount: z.number().int().nonnegative().max(1_000),
        cursorRevision: RevisionSchema,
      })
      .strict(),
  })
  .strict();

const ProactiveCandidateCreatedEventSchema = z
  .object({
    ...DomainEventBaseShape,
    type: z.literal("proactive_candidate.created"),
    payload: z
      .object({ candidateId: EntityIdSchema, activityEventId: EntityIdSchema })
      .strict(),
  })
  .strict();

const ProactiveMessageSentEventSchema = z
  .object({
    ...DomainEventBaseShape,
    type: z.literal("proactive_message.sent"),
    payload: z
      .object({ candidateId: EntityIdSchema, messageId: EntityIdSchema })
      .strict(),
  })
  .strict();

export const DomainEventSchema = z.discriminatedUnion("type", [
  CharacterCreatedEventSchema,
  CharacterPublishedEventSchema,
  ScheduleChangedEventSchema,
  RuntimeStateUpdatedEventSchema,
  MemoryCreatedEventSchema,
  MessageCreatedEventSchema,
  ActivityRecordedEventSchema,
  SettlementCompletedEventSchema,
  ProactiveCandidateCreatedEventSchema,
  ProactiveMessageSentEventSchema,
]);
export type DomainEvent = z.infer<typeof DomainEventSchema>;
export type DomainEventType = DomainEvent["type"];

export interface PersonaSimEventMap {
  "domain.event": DomainEvent;
  "message.created": { readonly agentId: string; readonly messageId: string };
  "schedule.changed": {
    readonly agentId: string;
    readonly scheduleItemId: string;
  };
  "runtime_state.updated": {
    readonly agentId: string;
    readonly revision: number;
  };
  "settlement.completed": {
    readonly agentId: string;
    readonly fromUtc: string;
    readonly toUtc: string;
  };
}
