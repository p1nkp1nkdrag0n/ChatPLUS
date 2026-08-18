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
    value["memoryCandidates"] === undefined
      ? nestedReply?.["memoryCandidates"]
      : value["memoryCandidates"],
  );
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
  };
}, PersonaChatDecisionShapeSchema);

export type PersonaChatDecision = z.infer<typeof PersonaChatDecisionSchema>;
