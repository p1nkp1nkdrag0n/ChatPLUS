import { z } from "zod";

import { PersonaChatDeliveryModeSchema } from "./llm.js";
import {
  ScheduleNegotiationActionSchema,
  type ScheduleNegotiationAction,
} from "./schedule-negotiation.js";

/**
 * Lenient model-facing chat decision. When a turn is schedule-eligible the
 * live provider is asked for the conversational reply plus optional proposed
 * world effects. The envelope deliberately tolerates noisy action-shaped
 * extras: unknown keys are stripped, non-array collections are dropped, and
 * non-record entries are filtered out. Strict validation happens later, per
 * effect, so one malformed proposal can never void the whole reply.
 */
const PersonaChatDecisionShapeSchema = z
  .object({
    text: z.string().trim().min(1).max(20_000),
    toneTags: z.array(z.string().trim().min(1).max(64)).max(12).optional(),
    deliveryMode: PersonaChatDeliveryModeSchema.optional(),
    chunks: z
      .array(z.string().trim().min(1).max(4_000))
      .min(1)
      .max(12)
      .optional(),
    scheduleAction: ScheduleNegotiationActionSchema.default({ kind: "none" }),
    scheduleEffects: z
      .array(z.record(z.string(), z.unknown()))
      .max(8)
      .default([]),
    memoryCandidates: z
      .array(z.record(z.string(), z.unknown()))
      .max(8)
      .default([]),
    stateDelta: z.unknown().optional(),
    relationshipDelta: z.unknown().optional(),
    personalIntentCandidates: z
      .array(z.record(z.string(), z.unknown()))
      .max(8)
      .default([]),
  })
  .strip();

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looseRecords(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isPlainRecord).slice(0, 8);
}

function looseScheduleAction(
  value: unknown,
): ScheduleNegotiationAction | undefined {
  const parsed = ScheduleNegotiationActionSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function looseTextList(value: unknown, maximum: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .slice(0, maximum);
}

export const PersonaChatDecisionSchema = z.preprocess((value) => {
  if (!isPlainRecord(value)) return value;

  const reply = value["replyDecision"] ?? value["reply"];
  const nestedReply = isPlainRecord(reply) ? reply : undefined;
  const nestedWorldEffects = isPlainRecord(value["worldEffects"])
    ? value["worldEffects"]
    : undefined;
  const text =
    typeof value["text"] === "string"
      ? value["text"]
      : typeof value["content"] === "string"
        ? value["content"]
        : typeof reply === "string"
          ? reply
          : nestedReply?.["text"];

  const scheduleEffects = looseRecords(
    value["scheduleEffects"] === undefined
      ? nestedReply?.["scheduleEffects"]
      : value["scheduleEffects"],
  );
  const scheduleAction = looseScheduleAction(
    value["scheduleAction"] === undefined
      ? nestedReply?.["scheduleAction"]
      : value["scheduleAction"],
  );
  const memoryCandidates = looseRecords(
    nestedWorldEffects?.["memoryCandidates"] ??
      value["memoryCandidates"] ??
      nestedReply?.["memoryCandidates"],
  );
  const personalIntentCandidates = looseRecords(
    nestedWorldEffects?.["personalIntentCandidates"] ??
      value["personalIntentCandidates"],
  );
  const stateDelta = nestedWorldEffects?.["stateDelta"] ?? value["stateDelta"];
  const relationshipDelta =
    nestedWorldEffects?.["relationshipDelta"] ?? value["relationshipDelta"];
  const toneTags = looseTextList(
    value["toneTags"] === undefined
      ? nestedReply?.["toneTags"]
      : value["toneTags"],
    12,
  );
  const chunks = looseTextList(
    value["chunks"] === undefined ? nestedReply?.["chunks"] : value["chunks"],
    12,
  );

  return {
    ...(text === undefined ? {} : { text }),
    ...(toneTags === undefined ? {} : { toneTags }),
    ...(value["deliveryMode"] === undefined &&
    nestedReply?.["deliveryMode"] === undefined
      ? {}
      : {
          deliveryMode: value["deliveryMode"] ?? nestedReply?.["deliveryMode"],
        }),
    ...(chunks === undefined ? {} : { chunks }),
    ...(scheduleAction === undefined ? {} : { scheduleAction }),
    ...(scheduleEffects === undefined ? {} : { scheduleEffects }),
    ...(memoryCandidates === undefined ? {} : { memoryCandidates }),
    ...(stateDelta === undefined ? {} : { stateDelta }),
    ...(relationshipDelta === undefined ? {} : { relationshipDelta }),
    ...(personalIntentCandidates === undefined
      ? {}
      : { personalIntentCandidates }),
  };
}, PersonaChatDecisionShapeSchema);

export type PersonaChatDecision = z.infer<typeof PersonaChatDecisionSchema>;

export const PersonaReplyDecisionSchema = PersonaChatDecisionShapeSchema.omit({
  scheduleEffects: true,
  memoryCandidates: true,
  stateDelta: true,
  relationshipDelta: true,
  personalIntentCandidates: true,
});
export type PersonaReplyDecision = z.infer<typeof PersonaReplyDecisionSchema>;

const PersonaTurnWorldEffectsSchema = z
  .object({
    stateDelta: z.unknown().optional(),
    relationshipDelta: z.unknown().optional(),
    memoryCandidates: z.unknown().optional(),
    personalIntentCandidates: z.unknown().optional(),
    continuityEffects: z.unknown().optional(),
  })
  .strip();

const PersonaTurnProviderEnvelopeShapeSchema = z
  .object({
    replyDecision: z.unknown(),
    worldEffects: PersonaTurnWorldEffectsSchema.default({}),
    scheduleEffects: z.unknown().optional(),
  })
  .strip();

/**
 * Raw provider boundary for canonical live chat. It deliberately does not
 * validate replyDecision: the reply and each world-effect field have separate
 * repair/validation lifecycles in ConversationService. Legacy flat replies are
 * normalized into the same boundary during rollout.
 */
export const PersonaTurnProviderEnvelopeSchema = z.preprocess((value) => {
  if (!isPlainRecord(value)) {
    return { replyDecision: value, worldEffects: {} };
  }

  const replyDecision = value["replyDecision"] ?? value["reply"] ?? value;
  const nestedReply = isPlainRecord(replyDecision) ? replyDecision : undefined;
  const nestedWorldEffects = isPlainRecord(value["worldEffects"])
    ? value["worldEffects"]
    : undefined;
  const effect = (key: string): unknown =>
    nestedWorldEffects?.[key] ?? value[key];
  const scheduleEffects =
    value["scheduleEffects"] ?? nestedReply?.["scheduleEffects"];

  return {
    replyDecision,
    worldEffects: {
      ...(effect("stateDelta") === undefined
        ? {}
        : { stateDelta: effect("stateDelta") }),
      ...(effect("relationshipDelta") === undefined
        ? {}
        : { relationshipDelta: effect("relationshipDelta") }),
      ...(effect("memoryCandidates") === undefined
        ? {}
        : { memoryCandidates: effect("memoryCandidates") }),
      ...(effect("personalIntentCandidates") === undefined
        ? {}
        : { personalIntentCandidates: effect("personalIntentCandidates") }),
      ...(effect("continuityEffects") === undefined
        ? {}
        : { continuityEffects: effect("continuityEffects") }),
    },
    ...(scheduleEffects === undefined ? {} : { scheduleEffects }),
  };
}, PersonaTurnProviderEnvelopeShapeSchema);

export type PersonaTurnProviderEnvelope = z.infer<
  typeof PersonaTurnProviderEnvelopeSchema
>;

/**
 * Model-facing turn envelope. Reply validity is the only parse-level gate;
 * each world effect stays untrusted until the independent feature validator.
 * Legacy flat replies are accepted during rollout, while server-owned schedule
 * fields are stripped and can never become a mutation command.
 */
export const PersonaTurnEnvelopeSchema = z.preprocess(
  (value) => {
    if (!isPlainRecord(value)) return value;

    const replySource = isPlainRecord(value["replyDecision"])
      ? value["replyDecision"]
      : value;
    const reply = PersonaChatDecisionSchema.safeParse(replySource);
    if (!reply.success) return value;

    const nestedWorldEffects = isPlainRecord(value["worldEffects"])
      ? value["worldEffects"]
      : undefined;
    const effect = (key: string): unknown =>
      nestedWorldEffects?.[key] ?? value[key];

    return {
      replyDecision: {
        text: reply.data.text,
        ...(reply.data.toneTags === undefined
          ? {}
          : { toneTags: reply.data.toneTags }),
        ...(reply.data.deliveryMode === undefined
          ? {}
          : { deliveryMode: reply.data.deliveryMode }),
        ...(reply.data.chunks === undefined
          ? {}
          : { chunks: reply.data.chunks }),
        scheduleAction: reply.data.scheduleAction,
      },
      worldEffects: {
        ...(effect("stateDelta") === undefined
          ? {}
          : { stateDelta: effect("stateDelta") }),
        ...(effect("relationshipDelta") === undefined
          ? {}
          : { relationshipDelta: effect("relationshipDelta") }),
        ...(effect("memoryCandidates") === undefined
          ? {}
          : { memoryCandidates: effect("memoryCandidates") }),
        ...(effect("personalIntentCandidates") === undefined
          ? {}
          : { personalIntentCandidates: effect("personalIntentCandidates") }),
        ...(effect("continuityEffects") === undefined
          ? {}
          : { continuityEffects: effect("continuityEffects") }),
      },
    };
  },
  z
    .object({
      replyDecision: PersonaReplyDecisionSchema,
      worldEffects: PersonaTurnWorldEffectsSchema.default({}),
    })
    .strip(),
);

export type PersonaTurnEnvelope = z.infer<typeof PersonaTurnEnvelopeSchema>;
