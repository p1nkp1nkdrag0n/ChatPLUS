import { z } from "zod";

import {
  CharacterSpecDraftSchema,
  ImportedCharacterInputSchema,
  OriginalCharacterInputSchema,
} from "./character.js";
import { LLMChatMessageSchema } from "./messages.js";
import {
  JsonValueSchema,
  ReasonCodeSchema,
  ShortTextSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import {
  ScheduleCategorySchema,
  SchedulePlanProposalSchema,
  ScheduleStatusSchema,
} from "./schedule.js";
import { ActivityEventKindSchema } from "./simulation.js";
import { RuntimeStateDeltaSchema } from "./state.js";
import { AgentTurnDecisionSchema } from "./turn.js";

export const LlmPurposeSchema = z.enum([
  "compile_character",
  "import_character",
  "plan_schedule",
  "chat_turn",
  "repair_chat_turn",
  "enrich_activity",
  "compose_proactive_message",
  "checkpoint_autobiography",
  "letter_reply",
]);
export const LLMPurposeSchema = LlmPurposeSchema;
export type LlmPurpose = z.infer<typeof LlmPurposeSchema>;
export type LLMPurpose = LlmPurpose;

export const LLMUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (usage) => usage.totalTokens >= usage.inputTokens + usage.outputTokens,
    {
      message: "totalTokens must cover inputTokens and outputTokens",
      path: ["totalTokens"],
    },
  );
export type LLMUsage = z.infer<typeof LLMUsageSchema>;

export const LLMRequestSchema = z
  .object({
    purpose: LlmPurposeSchema,
    messages: z.array(LLMChatMessageSchema).max(200).optional(),
    payload: JsonValueSchema,
    seed: z.string().min(1).max(128).optional(),
    temperature: z.number().finite().min(0).max(2).optional(),
    maxOutputTokens: z.number().int().min(1).max(64_000).optional(),
  })
  .strict();
export type LLMRequest = z.infer<typeof LLMRequestSchema>;

export const LLMResponseSchema = z
  .object({
    content: z.string().max(500_000).optional(),
    data: JsonValueSchema.optional(),
    usage: LLMUsageSchema.optional(),
    model: z.string().trim().min(1).max(160).optional(),
    reasonCode: ReasonCodeSchema.optional(),
    finishReason: z
      .enum(["stop", "length", "content_filter", "tool_call", "error"])
      .optional(),
  })
  .strict()
  .refine(
    (response) => response.content !== undefined || response.data !== undefined,
    {
      message: "An LLM response must contain content or data",
    },
  );
export type LLMResponse = z.infer<typeof LLMResponseSchema>;

export const PersonaChatDeliveryModeSchema = z.enum([
  "single_block",
  "sequential",
]);
export type PersonaChatDeliveryMode = z.infer<
  typeof PersonaChatDeliveryModeSchema
>;

const PersonaChatResponseShapeSchema = z
  .object({
    text: z.string().trim().min(1).max(20_000),
    toneTags: z.array(z.string().trim().min(1).max(64)).max(12).optional(),
    deliveryMode: PersonaChatDeliveryModeSchema.optional(),
    chunks: z
      .array(z.string().trim().min(1).max(4_000))
      .min(1)
      .max(12)
      .optional(),
  })
  .strip();

/**
 * Minimal model-facing chat response. Legacy or provider-specific wrapper
 * fields are normalized away before the response reaches the strict server
 * decision and persistence contracts.
 */
export const PersonaChatResponseSchema = z.preprocess((value) => {
  if (!isPlainRecord(value)) return value;

  const reply = value["reply"];
  const nestedReply = isPlainRecord(reply) ? reply : undefined;
  const text =
    typeof value["text"] === "string"
      ? value["text"]
      : typeof value["content"] === "string"
        ? value["content"]
        : typeof reply === "string"
          ? reply
          : nestedReply?.["text"];
  const toneTags =
    value["toneTags"] === undefined
      ? nestedReply?.["toneTags"]
      : value["toneTags"];
  const deliveryMode = normalizeDeliveryMode(
    value["deliveryMode"] === undefined
      ? nestedReply?.["deliveryMode"]
      : value["deliveryMode"],
  );
  const chunks = normalizeReplyChunks(
    value["chunks"] === undefined ? nestedReply?.["chunks"] : value["chunks"],
  );

  return {
    text,
    toneTags: normalizeToneTags(toneTags),
    ...(deliveryMode === undefined ? {} : { deliveryMode }),
    ...(chunks === undefined ? {} : { chunks }),
  };
}, PersonaChatResponseShapeSchema);
export type PersonaChatResponse = z.infer<typeof PersonaChatResponseSchema>;

export const CharacterCompilationRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("original"),
      input: OriginalCharacterInputSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("imported_character"),
      input: ImportedCharacterInputSchema,
    })
    .strict(),
]);
export type CharacterCompilationRequest = z.infer<
  typeof CharacterCompilationRequestSchema
>;

export const CharacterCompilationProposalSchema = z
  .object({
    draft: CharacterSpecDraftSchema,
    reasonCode: ReasonCodeSchema,
    reasonSummary: ShortTextSchema,
  })
  .strict();
export type CharacterCompilationProposal = z.infer<
  typeof CharacterCompilationProposalSchema
>;

/**
 * Restores fields owned by the simulation runtime before validating an
 * untrusted character-compilation response. The strict proposal schema stays
 * authoritative for every other field.
 */
export function normalizeCharacterCompilationModelOutput(
  value: unknown,
): unknown {
  if (!isPlainRecord(value)) return value;
  const draft = value["draft"];
  if (!isPlainRecord(draft)) return value;
  const schedulePolicy = draft["schedulePolicy"];
  const sources = Array.isArray(draft["sources"])
    ? draft["sources"].map(stripRuntimeOwnedSourceFields)
    : draft["sources"];

  return {
    ...value,
    draft: {
      ...draft,
      ...(sources === undefined ? {} : { sources }),
      ...(isPlainRecord(schedulePolicy)
        ? {
            schedulePolicy: {
              ...schedulePolicy,
              horizonHours: 72,
            },
          }
        : {}),
    },
  };
}

function stripRuntimeOwnedSourceFields(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  const normalized = { ...value };
  for (const key of [
    "workTitle",
    "locator",
    "excerpt",
    "checksum",
    "createdAtUtc",
  ]) {
    delete normalized[key];
  }
  return normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToneTags(value: unknown): string[] {
  const candidates = typeof value === "string" ? [value] : value;
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0 && candidate.length <= 64)
    .slice(0, 12);
}

function normalizeDeliveryMode(
  value: unknown,
): PersonaChatDeliveryMode | undefined {
  return value === "single_block" || value === "sequential" ? value : undefined;
}

function normalizeReplyChunks(value: unknown): string[] | undefined {
  const candidates = typeof value === "string" ? [value] : value;
  if (!Array.isArray(candidates)) return undefined;
  const chunks = candidates
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0 && candidate.length <= 4_000)
    .slice(0, 12);
  return chunks.length === 0 ? undefined : chunks;
}

export const ActivityEnrichmentProposalSchema = z
  .object({
    event: z
      .object({
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
      })
      .strict(),
    reasonCode: ReasonCodeSchema,
    reasonSummary: ShortTextSchema,
  })
  .strict();
export type ActivityEnrichmentProposal = z.infer<
  typeof ActivityEnrichmentProposalSchema
>;

export const ActivityEnrichmentMemoryCandidateSchema = z
  .object({
    type: z.enum([
      "activity_outcome",
      "relationship",
      "preference",
      "commitment",
    ]),
    content: z.string().trim().min(1).max(2_000),
    tags: z.array(z.string().trim().min(1).max(64)).max(20),
    importance: UnitIntervalSchema,
    confidence: UnitIntervalSchema,
  })
  .strict();
export type ActivityEnrichmentMemoryCandidate = z.infer<
  typeof ActivityEnrichmentMemoryCandidateSchema
>;

export const ActivityEnrichmentItemSchema = z
  .object({
    eventId: z.string().min(1).max(128),
    summary: z.string().trim().min(1).max(1_000),
    outcomeFacts: z.array(z.string().trim().min(1).max(500)).max(10),
    memoryCandidates: z.array(ActivityEnrichmentMemoryCandidateSchema).max(10),
    proactiveSummary: z.string().trim().min(1).max(1_000).optional(),
  })
  .strict();
export type ActivityEnrichmentItem = z.infer<
  typeof ActivityEnrichmentItemSchema
>;

/** One LLM call may enrich every important event settled in the same batch. */
export const ActivityEnrichmentBatchSchema = z
  .object({
    events: z.array(ActivityEnrichmentItemSchema).min(1).max(100),
  })
  .strict()
  .refine(
    (batch) =>
      new Set(batch.events.map((event) => event.eventId)).size ===
      batch.events.length,
    { message: "eventId values must be unique", path: ["events"] },
  );
export type ActivityEnrichmentBatch = z.infer<
  typeof ActivityEnrichmentBatchSchema
>;

export const ProposalEnvelopeSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("character"),
      proposal: CharacterCompilationProposalSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("schedule_plan"),
      proposal: SchedulePlanProposalSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("agent_turn"),
      proposal: AgentTurnDecisionSchema,
    })
    .strict(),
]);
export type ProposalEnvelope = z.infer<typeof ProposalEnvelopeSchema>;

export const PersonaConsistencyAssessmentSchema = z
  .object({
    accepted: z.boolean(),
    score: UnitIntervalSchema,
    reasonCode: ReasonCodeSchema,
    reasonSummary: ShortTextSchema,
  })
  .strict();
export type PersonaConsistencyAssessment = z.infer<
  typeof PersonaConsistencyAssessmentSchema
>;
