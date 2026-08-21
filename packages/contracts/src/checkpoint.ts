import { z } from "zod";

import {
  EntityIdSchema,
  JsonValueSchema,
  ReasonCodeSchema,
  RevisionSchema,
  ShortTextSchema,
  UtcDateTimeSchema,
} from "./primitives.js";

export const ConversationRetentionPolicySchema = z
  .object({
    fullVerbatimHours: z
      .number()
      .int()
      .nonnegative()
      .max(24 * 365),
    softTokenLimit: z.number().int().min(256).max(1_000_000),
    hardTokenLimit: z.number().int().min(512).max(2_000_000),
    minimumTailTokens: z.number().int().min(1).max(1_000_000),
    minimumRecentTurns: z.number().int().min(1).max(1_000),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.softTokenLimit >= policy.hardTokenLimit) {
      context.addIssue({
        code: "custom",
        message: "softTokenLimit must be lower than hardTokenLimit",
        path: ["softTokenLimit"],
      });
    }
    if (policy.minimumTailTokens > policy.softTokenLimit) {
      context.addIssue({
        code: "custom",
        message: "minimumTailTokens cannot exceed softTokenLimit",
        path: ["minimumTailTokens"],
      });
    }
  });
export type ConversationRetentionPolicy = z.infer<
  typeof ConversationRetentionPolicySchema
>;

export const DEFAULT_CONVERSATION_RETENTION_POLICY: ConversationRetentionPolicy =
  {
    fullVerbatimHours: 24,
    softTokenLimit: 8_000,
    hardTokenLimit: 12_000,
    minimumTailTokens: 3_000,
    minimumRecentTurns: 12,
  };

export const CheckpointSourceMessageSchema = z
  .object({
    id: EntityIdSchema,
    sessionId: EntityIdSchema,
    agentId: EntityIdSchema,
    role: z.enum(["user", "assistant"]),
    messageKind: z.enum(["user", "assistant_reply", "assistant_proactive"]),
    content: z.string().trim().min(1).max(20_000),
    replyToMessageId: EntityIdSchema.optional(),
    createdAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((message, context) => {
    if (message.role === "user" && message.messageKind !== "user") {
      context.addIssue({
        code: "custom",
        message: "User checkpoint messages must use the user message kind",
        path: ["messageKind"],
      });
    }
    if (message.role === "assistant" && message.messageKind === "user") {
      context.addIssue({
        code: "custom",
        message:
          "Assistant checkpoint messages cannot use the user message kind",
        path: ["messageKind"],
      });
    }
  });
export type CheckpointSourceMessage = z.infer<
  typeof CheckpointSourceMessageSchema
>;

export const ConversationCheckpointStatusSchema = z.enum([
  "pending",
  "committed",
  "invalidated",
  "failed",
]);
export type ConversationCheckpointStatus = z.infer<
  typeof ConversationCheckpointStatusSchema
>;

export const ConversationCheckpointSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema,
    previousCheckpointId: EntityIdSchema.optional(),
    fromMessageId: EntityIdSchema,
    throughMessageId: EntityIdSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceRevision: RevisionSchema,
    sourceMessageCount: z.number().int().positive().max(100_000),
    sourceTokenEstimate: z.number().int().positive().max(2_000_000),
    autobiographySnapshotId: EntityIdSchema.optional(),
    artifact: JsonValueSchema.optional(),
    status: ConversationCheckpointStatusSchema,
    failureCode: ReasonCodeSchema.optional(),
    failureSummary: ShortTextSchema.optional(),
    createdAtUtc: UtcDateTimeSchema,
    updatedAtUtc: UtcDateTimeSchema,
    committedAtUtc: UtcDateTimeSchema.optional(),
    invalidatedAtUtc: UtcDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (
      checkpoint.status === "committed" &&
      checkpoint.committedAtUtc === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "A committed checkpoint requires committedAtUtc",
        path: ["committedAtUtc"],
      });
    }
    if (
      checkpoint.status === "invalidated" &&
      checkpoint.invalidatedAtUtc === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "An invalidated checkpoint requires invalidatedAtUtc",
        path: ["invalidatedAtUtc"],
      });
    }
    if (
      checkpoint.status === "failed" &&
      (checkpoint.failureCode === undefined ||
        checkpoint.failureSummary === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A failed checkpoint requires a failure code and summary",
        path: ["failureCode"],
      });
    }
    if (
      checkpoint.status === "pending" &&
      (checkpoint.committedAtUtc !== undefined ||
        checkpoint.invalidatedAtUtc !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A pending checkpoint cannot have a terminal timestamp",
        path: ["status"],
      });
    }
  });
export type ConversationCheckpoint = z.infer<
  typeof ConversationCheckpointSchema
>;
