import { describe, expect, it } from "vitest";

import {
  ConversationCheckpointSchema,
  ConversationRetentionPolicySchema,
  DEFAULT_CONVERSATION_RETENTION_POLICY,
} from "./checkpoint.js";

const NOW = "2026-08-21T12:00:00.000Z";

describe("checkpoint contracts", () => {
  it("accepts the recommended retention defaults", () => {
    expect(
      ConversationRetentionPolicySchema.parse(
        DEFAULT_CONVERSATION_RETENTION_POLICY,
      ),
    ).toEqual(DEFAULT_CONVERSATION_RETENTION_POLICY);
  });

  it("rejects a retention policy whose soft boundary is not safe", () => {
    expect(
      ConversationRetentionPolicySchema.safeParse({
        ...DEFAULT_CONVERSATION_RETENTION_POLICY,
        softTokenLimit: 12_000,
        hardTokenLimit: 12_000,
      }).success,
    ).toBe(false);
    expect(
      ConversationRetentionPolicySchema.safeParse({
        ...DEFAULT_CONVERSATION_RETENTION_POLICY,
        minimumTailTokens: 9_000,
      }).success,
    ).toBe(false);
  });

  it("requires terminal metadata for terminal checkpoint states", () => {
    const base = {
      id: "checkpoint-1",
      agentId: "agent-1",
      sessionId: "session-1",
      fromMessageId: "message-1",
      throughMessageId: "message-2",
      sourceHash: "a".repeat(64),
      sourceRevision: 2,
      sourceMessageCount: 2,
      sourceTokenEstimate: 400,
      createdAtUtc: NOW,
      updatedAtUtc: NOW,
    };
    expect(
      ConversationCheckpointSchema.safeParse({
        ...base,
        status: "committed",
      }).success,
    ).toBe(false);
    expect(
      ConversationCheckpointSchema.parse({
        ...base,
        status: "committed",
        committedAtUtc: NOW,
      }).status,
    ).toBe("committed");
  });
});
