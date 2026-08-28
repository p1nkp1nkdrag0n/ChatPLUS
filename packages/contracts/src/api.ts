import { z } from "zod";

import {
  CharacterSpecDraftSchema,
  CharacterSpecSchema,
  CharacterSourceKindSchema,
  CharacterStatusSchema,
  ImportedCharacterInputSchema,
  OriginalCharacterInputSchema,
} from "./character.js";
import { PersonaChatDeliveryModeSchema } from "./llm.js";
import { MemoryRecallRuntimeDiagnosticSchema } from "./memory-recall-preview.js";
import {
  EntityIdSchema,
  ReasonCodeSchema,
  RevisionSchema,
  ShortTextSchema,
  SimulationTierSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import {
  ScheduleItemSchema,
  ScheduleSourceSchema,
  ScheduleStateEffectsSchema,
} from "./schedule.js";
import { RuntimeStateSchema } from "./state.js";

export const ApiErrorCodeSchema = z.enum([
  "bad_request",
  "validation_error",
  "not_found",
  "conflict",
  "payload_too_large",
  "unsupported_media_type",
  "proposal_rejected",
  "provider_error",
  "service_unavailable",
  "internal_error",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiValidationIssueSchema = z
  .object({
    path: z
      .array(z.union([z.string(), z.number().int().nonnegative()]))
      .max(32),
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(1_000),
  })
  .strict();
export type ApiValidationIssue = z.infer<typeof ApiValidationIssueSchema>;

export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        code: ApiErrorCodeSchema,
        message: z.string().min(1).max(1_000),
        requestId: EntityIdSchema.optional(),
        issues: z.array(ApiValidationIssueSchema).max(100).optional(),
      })
      .strict(),
  })
  .strict();
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const AgentParamsSchema = z.object({ agentId: EntityIdSchema }).strict();
export type AgentParams = z.infer<typeof AgentParamsSchema>;
export const SessionParamsSchema = z
  .object({ agentId: EntityIdSchema, sessionId: EntityIdSchema })
  .strict();
export type SessionParams = z.infer<typeof SessionParamsSchema>;

export const CharacterSummarySchema = z
  .object({
    id: EntityIdSchema,
    currentVersion: z.number().int().positive(),
    version: z.number().int().positive(),
    name: z.string().trim().min(1).max(120),
    workOrRole: z.string().trim().min(1).max(240),
    tier: SimulationTierSchema,
    status: CharacterStatusSchema,
    sourceType: CharacterSourceKindSchema,
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict();
export type CharacterSummary = z.infer<typeof CharacterSummarySchema>;

export const ListCharactersResponseSchema = z
  .object({
    characters: z.array(CharacterSummarySchema).max(1_000),
    items: z.array(CharacterSummarySchema).max(1_000),
  })
  .strict();
export type ListCharactersResponse = z.infer<
  typeof ListCharactersResponseSchema
>;

export const CreateOriginalCharacterRequestSchema =
  OriginalCharacterInputSchema;
export type CreateOriginalCharacterRequest = z.input<
  typeof CreateOriginalCharacterRequestSchema
>;
export const ImportCharacterRequestSchema = ImportedCharacterInputSchema;
export type ImportCharacterRequest = z.input<
  typeof ImportCharacterRequestSchema
>;

export const CharacterMutationResponseSchema = z
  .object({ character: CharacterSpecSchema })
  .strict();
export type CharacterMutationResponse = z.infer<
  typeof CharacterMutationResponseSchema
>;

export const UpdateCharacterDraftRequestSchema = z
  .object({
    draft: CharacterSpecDraftSchema,
    expectedVersion: z.number().int().positive(),
  })
  .strict();
export type UpdateCharacterDraftRequest = z.infer<
  typeof UpdateCharacterDraftRequestSchema
>;

export const PublishCharacterRequestSchema = z
  .object({ expectedVersion: z.number().int().positive().optional() })
  .strict();
export type PublishCharacterRequest = z.infer<
  typeof PublishCharacterRequestSchema
>;

export const PublishCharacterResponseSchema = z
  .object({
    character: CharacterSpecSchema,
    schedule: z.array(ScheduleItemSchema).max(200),
  })
  .strict();
export type PublishCharacterResponse = z.infer<
  typeof PublishCharacterResponseSchema
>;

export const ApiStoredMessageSchema = z
  .object({
    id: EntityIdSchema,
    sessionId: EntityIdSchema,
    agentId: EntityIdSchema,
    role: z.enum(["user", "assistant", "system"]),
    content: z.string().min(1).max(20_000),
    messageKind: z.enum([
      "user",
      "assistant_reply",
      "assistant_proactive",
      "system_notice",
    ]),
    triggerEventId: EntityIdSchema.optional(),
    clientMessageId: EntityIdSchema.optional(),
    inReplyToMessageId: EntityIdSchema.optional(),
    metadata: z.record(z.string(), z.unknown()),
    createdAtUtc: UtcDateTimeSchema,
  })
  .strict();
export type ApiStoredMessage = z.infer<typeof ApiStoredMessageSchema>;

export const ApiStoredActivityEventSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    scheduleItemId: EntityIdSchema.optional(),
    eventType: z.enum([
      "started",
      "completed",
      "partial",
      "skipped",
      "cancelled",
    ]),
    occurredAtUtc: UtcDateTimeSchema,
    summary: z.string().trim().min(1).max(1_000),
    outcomeFacts: z.array(z.string().trim().min(1).max(1_000)).max(100),
    stateDelta: ScheduleStateEffectsSchema,
    origin: z.enum(["deterministic", "seeded_probability", "llm_enriched"]),
    effectTrace: z.record(z.string(), z.unknown()).optional(),
    idempotencyKey: z.string().trim().min(1).max(240),
  })
  .strict();
export type ApiStoredActivityEvent = z.infer<
  typeof ApiStoredActivityEventSchema
>;

export const AgentActivationSettlementSchema = z
  .object({
    agentId: EntityIdSchema,
    fromUtc: UtcDateTimeSchema,
    toUtc: UtcDateTimeSchema,
    idempotencyKey: z.string().trim().min(1).max(240),
    alreadySettled: z.boolean(),
    activityEvents: z.array(ApiStoredActivityEventSchema).max(400),
    updatedScheduleItems: z.array(ScheduleItemSchema).max(300),
    state: RuntimeStateSchema,
  })
  .strict();
export type AgentActivationSettlement = z.infer<
  typeof AgentActivationSettlementSchema
>;

export const AgentCapabilitiesSchema = z
  .object({
    schedule: z.boolean(),
    offlineSettlement: z.boolean(),
    dynamicState: z.boolean(),
    longTermMemory: z.boolean(),
    relationshipDynamics: z.boolean(),
    relationshipDeltaScale: z.number().min(0).max(1),
    proactiveDialogue: z.boolean(),
    personaGuard: z.boolean(),
    activityEnrichment: z.boolean(),
    memoryCandidatesPerTurn: z.number().int().min(0).max(100),
  })
  .strict();
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;

export const AgentCursorResponseSchema = z
  .object({
    agentId: EntityIdSchema,
    lastSettledAtUtc: UtcDateTimeSchema,
    scheduleHorizonEndUtc: UtcDateTimeSchema,
    lastHourlyBucket: z.string().trim().min(1).max(64).optional(),
    revision: RevisionSchema,
  })
  .strict();
export type AgentCursorResponse = z.infer<typeof AgentCursorResponseSchema>;

export const ActivateAgentResponseSchema = z
  .object({
    agentId: EntityIdSchema,
    character: CharacterSpecSchema,
    capabilities: AgentCapabilitiesSchema,
    state: RuntimeStateSchema,
    cursor: AgentCursorResponseSchema,
    serverTimeUtc: UtcDateTimeSchema,
    characterLocalTime: z.string().trim().min(1).max(64),
    currentActivity: ScheduleItemSchema.optional(),
    schedule: z.array(ScheduleItemSchema).max(300),
    settlement: AgentActivationSettlementSchema.optional(),
    proactiveMessage: ApiStoredMessageSchema.optional(),
  })
  .strict();
export type ActivateAgentResponse = z.infer<typeof ActivateAgentResponseSchema>;

export const ApiStoredSessionSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    title: z.string().trim().min(1).max(200),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
  })
  .strict();
export type ApiStoredSession = z.infer<typeof ApiStoredSessionSchema>;

export const CreateSessionRequestSchema = z
  .object({ title: z.string().trim().min(1).max(200).optional() })
  .strict();
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export const CreateSessionResponseSchema = z
  .object({ session: ApiStoredSessionSchema })
  .strict();
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;

export const ListSessionsResponseSchema = z
  .object({ sessions: z.array(ApiStoredSessionSchema).max(1_000) })
  .strict();
export type ListSessionsResponse = z.infer<typeof ListSessionsResponseSchema>;

export const ListMessagesQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
export type ListMessagesQuery = z.input<typeof ListMessagesQuerySchema>;
export const ListMessagesResponseSchema = z
  .object({ messages: z.array(ApiStoredMessageSchema).max(500) })
  .strict();
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

export const SendMessageResponseSchema = z
  .object({
    idempotentReplay: z.boolean(),
    userMessage: ApiStoredMessageSchema,
    assistantMessage: ApiStoredMessageSchema,
    scheduleChanges: z.array(ScheduleItemSchema).max(300),
    state: RuntimeStateSchema,
    memoryRecall: MemoryRecallRuntimeDiagnosticSchema.optional(),
    decision: z
      .object({
        reasonCode: ReasonCodeSchema,
        reasonSummary: ShortTextSchema,
        toneTags: z.array(z.string().trim().min(1).max(64)).max(12),
        deliveryMode: PersonaChatDeliveryModeSchema,
        chunks: z.array(z.string().trim().min(1).max(4_000)).min(1).max(12),
      })
      .strict(),
  })
  .strict();
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

export const TimelineQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(100),
  })
  .strict();
export type TimelineQuery = z.input<typeof TimelineQuerySchema>;

export const ApiTimelineEventSchema = z
  .object({
    id: EntityIdSchema,
    type: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(160).optional(),
    summary: z.string().trim().min(1).max(1_000),
    occurredAtUtc: UtcDateTimeSchema,
    scheduleItemId: EntityIdSchema.optional(),
    activityEventId: EntityIdSchema.optional(),
    memoryId: EntityIdSchema.optional(),
    proactiveCandidateId: EntityIdSchema.optional(),
    messageId: EntityIdSchema.optional(),
    source: ScheduleSourceSchema.optional(),
    sourceIntentId: EntityIdSchema.optional(),
    correlationId: EntityIdSchema.optional(),
    causationId: EntityIdSchema.optional(),
  })
  .strict();
export type ApiTimelineEvent = z.infer<typeof ApiTimelineEventSchema>;

export const ApiDomainEventSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    streamType: z.string().trim().min(1).max(80),
    streamId: EntityIdSchema,
    streamVersion: RevisionSchema,
    eventType: z.string().trim().min(1).max(120),
    recordedAtUtc: UtcDateTimeSchema,
    effectiveAtUtc: UtcDateTimeSchema.nullable(),
    correlationId: EntityIdSchema.nullable(),
    causationId: EntityIdSchema.nullable(),
    idempotencyKey: z.string().trim().min(1).max(240),
    payload: z.unknown(),
  })
  .strict();
export type ApiDomainEvent = z.infer<typeof ApiDomainEventSchema>;

export const TimelineResponseSchema = z
  .object({
    events: z.array(ApiTimelineEventSchema).max(500),
    activityEvents: z.array(ApiStoredActivityEventSchema).max(500),
    scheduleItems: z.array(ScheduleItemSchema).max(1_000),
    domainEvents: z.array(ApiDomainEventSchema).max(500),
  })
  .strict();
export type TimelineResponse = z.infer<typeof TimelineResponseSchema>;

export const ApiMemorySummarySchema = z
  .object({
    id: EntityIdSchema,
    type: z.string().trim().min(1).max(80),
    content: z.string().trim().min(1).max(2_000),
    tags: z.array(z.string().trim().min(1).max(64)).max(20),
    importance: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    sourceMessageId: EntityIdSchema.nullable(),
    sourceEventId: EntityIdSchema.nullable(),
    createdAtUtc: UtcDateTimeSchema,
    validUntilUtc: UtcDateTimeSchema.nullable(),
  })
  .strict();
export type ApiMemorySummary = z.infer<typeof ApiMemorySummarySchema>;
export const MemoriesResponseSchema = z
  .object({ memories: z.array(ApiMemorySummarySchema).max(1_000) })
  .strict();
export type MemoriesResponse = z.infer<typeof MemoriesResponseSchema>;

export const GetSettingsResponseSchema = z
  .object({
    settings: z.record(z.string(), z.unknown()),
    runtime: z
      .object({
        llmProvider: z.enum(["fixture", "openai-compatible"]),
        llmModel: z.string().trim().min(1).max(160),
        llmBaseUrl: z.url(),
        hasApiKey: z.boolean(),
        clockMode: z.enum(["system", "fake"]),
        profile: z.string().trim().min(1).max(120),
      })
      .strict(),
  })
  .strict();
export type GetSettingsResponse = z.infer<typeof GetSettingsResponseSchema>;
export const UpdateSettingsRequestSchema = z.record(z.string(), z.unknown());
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequestSchema>;
export const UpdateSettingsResponseSchema = z
  .object({ settings: z.record(z.string(), z.unknown()) })
  .strict();
export type UpdateSettingsResponse = z.infer<
  typeof UpdateSettingsResponseSchema
>;

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    serverTimeUtc: UtcDateTimeSchema,
    profile: z.string().trim().min(1).max(120),
    llmProvider: z.enum(["fixture", "openai-compatible"]),
    clockMode: z.enum(["system", "fake"]),
  })
  .strict();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

const SseBaseShape = {
  id: EntityIdSchema,
  agentId: EntityIdSchema,
  occurredAtUtc: UtcDateTimeSchema,
  emittedAtUtc: UtcDateTimeSchema,
} as const;

export const ServerSentEventSchema = z.discriminatedUnion("type", [
  z
    .object({
      ...SseBaseShape,
      type: z.literal("message.created"),
      data: ApiStoredMessageSchema,
    })
    .strict(),
  z
    .object({
      ...SseBaseShape,
      type: z.literal("schedule.updated"),
      data: z.array(ScheduleItemSchema).max(300),
    })
    .strict(),
  z
    .object({
      ...SseBaseShape,
      type: z.literal("state.updated"),
      data: RuntimeStateSchema,
    })
    .strict(),
  z
    .object({
      ...SseBaseShape,
      type: z.literal("settlement.completed"),
      data: AgentActivationSettlementSchema,
    })
    .strict(),
  z
    .object({
      ...SseBaseShape,
      type: z.literal("activity.created"),
      data: ApiStoredActivityEventSchema,
    })
    .strict(),
]);
export type ServerSentEvent = z.infer<typeof ServerSentEventSchema>;
