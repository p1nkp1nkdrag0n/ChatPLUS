import { z } from "zod";

import {
  EntityIdSchema,
  ReasonCodeSchema,
  ShortTextSchema,
  UtcDateTimeSchema,
} from "./primitives.js";
import { LOCAL_USER_ID } from "./relationship.js";

export const MessageRoleSchema = z.enum(["user", "assistant"]);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export const MessageOriginSchema = z.enum([
  "user",
  "reactive",
  "proactive",
  "deterministic_fallback",
]);
export type MessageOrigin = z.infer<typeof MessageOriginSchema>;

export type DeliveredTextMode = "single_block" | "sequential";

export interface CanonicalDeliveredText {
  text: string;
  reconstructedText: string;
  chunksMatch: boolean;
}

const UNICODE_SPACE_PATTERN = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]/gu;

function canonicalizeTextBlock(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(UNICODE_SPACE_PATTERN, " ")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd();
}

/**
 * Canonical representation shared by persistence, delivery, and acceptance
 * checks. Sequential bubbles are separated by one newline, matching the
 * persisted message contract.
 */
export function canonicalizeDeliveredText(input: {
  text: string;
  chunks: readonly string[];
  deliveryMode: DeliveredTextMode;
}): CanonicalDeliveredText {
  const text = canonicalizeTextBlock(input.text);
  const canonicalChunks = input.chunks.map(canonicalizeTextBlock);
  const reconstructedText = canonicalizeTextBlock(
    input.deliveryMode === "sequential"
      ? canonicalChunks.join("\n")
      : (canonicalChunks[0] ?? ""),
  );
  return {
    text,
    reconstructedText,
    chunksMatch: canonicalChunks.length > 0 && reconstructedText === text,
  };
}

export const MessageSchema = z
  .object({
    id: EntityIdSchema,
    sessionId: EntityIdSchema,
    agentId: EntityIdSchema,
    role: MessageRoleSchema,
    text: z.string().trim().min(1).max(20_000),
    chunks: z.array(z.string().trim().min(1).max(4_000)).min(1).max(12),
    origin: MessageOriginSchema,
    triggerActivityEventId: EntityIdSchema.optional(),
    replyToMessageId: EntityIdSchema.optional(),
    model: z.string().trim().min(1).max(160).optional(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    createdAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((message, context) => {
    if (
      !canonicalizeDeliveredText({
        text: message.text,
        chunks: message.chunks,
        deliveryMode: message.chunks.length > 1 ? "sequential" : "single_block",
      }).chunksMatch
    ) {
      context.addIssue({
        code: "custom",
        message: "text must equal chunks joined with a newline",
        path: ["chunks"],
      });
    }
    if (message.role === "user" && message.origin !== "user") {
      context.addIssue({
        code: "custom",
        message: "User messages must have user origin",
        path: ["origin"],
      });
    }
    if (
      message.origin === "proactive" &&
      message.triggerActivityEventId === undefined
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A proactive message must reference its triggering activity event",
        path: ["triggerActivityEventId"],
      });
    }
  });
export type Message = z.infer<typeof MessageSchema>;

/** A provider-facing prompt message. It deliberately has no database identifiers. */
export const LLMChatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1).max(100_000),
  })
  .strict();
export type LLMChatMessage = z.infer<typeof LLMChatMessageSchema>;

export const SessionStatusSchema = z.enum(["active", "archived"]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

export const SessionSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    userId: z.literal(LOCAL_USER_ID),
    title: z.string().trim().min(1).max(160).optional(),
    status: SessionStatusSchema,
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
    lastMessageAtUtc: UtcDateTimeSchema.optional(),
  })
  .strict();
export type Session = z.infer<typeof SessionSchema>;

export const AgentReplySchema = z
  .object({
    text: z.string().trim().min(1).max(20_000),
    chunks: z.array(z.string().trim().min(1).max(4_000)).min(1).max(12),
    toneTags: z.array(z.string().trim().min(1).max(64)).max(12),
  })
  .strict()
  .refine(
    (reply) =>
      canonicalizeDeliveredText({
        text: reply.text,
        chunks: reply.chunks,
        deliveryMode: reply.chunks.length > 1 ? "sequential" : "single_block",
      }).chunksMatch,
    {
      message: "text must equal chunks joined with a newline",
      path: ["chunks"],
    },
  );
export type AgentReply = z.infer<typeof AgentReplySchema>;

export const SendMessageRequestSchema = z
  .object({
    content: z.string().trim().min(1).max(20_000),
    clientMessageId: EntityIdSchema.optional(),
  })
  .strict();
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/** Server command envelope used before a chat message is persisted. */
export const ServerChatMessageInputSchema = z
  .object({
    agentId: EntityIdSchema,
    clientMessageId: EntityIdSchema,
    text: z.string().trim().min(1).max(20_000),
  })
  .strict();
export type ServerChatMessageInput = z.infer<
  typeof ServerChatMessageInputSchema
>;

export const ProactiveMessageProposalSchema = z
  .object({
    content: z.string().trim().min(1).max(4_000),
    reasonCode: ReasonCodeSchema,
    reasonSummary: ShortTextSchema,
  })
  .strict();
export type ProactiveMessageProposal = z.infer<
  typeof ProactiveMessageProposalSchema
>;
