import { describe, expect, it } from "vitest";

import {
  canonicalCheckpointSource,
  estimateCheckpointTokens,
  selectConversationRetentionWindow,
  type CheckpointRetentionMessageLike,
} from "./checkpoint.js";

const NOW = "2026-08-21T12:00:00.000Z";
const OLD = "2026-08-19T12:00:00.000Z";

function turn(index: number): CheckpointRetentionMessageLike[] {
  const userId = `message-user-${index}`;
  return [
    {
      id: userId,
      role: "user",
      messageKind: "user",
      content: "aaaa",
      createdAtUtc: OLD,
    },
    {
      id: `message-assistant-${index}`,
      role: "assistant",
      messageKind: "assistant_reply",
      content: "bbbb",
      replyToMessageId: userId,
      createdAtUtc: OLD,
    },
  ];
}

const POLICY = {
  fullVerbatimHours: 0,
  softTokenLimit: 20,
  hardTokenLimit: 60,
  minimumTailTokens: 1,
  minimumRecentTurns: 1,
};

describe("conversation retention", () => {
  it("uses a conservative mixed Chinese and Latin token estimate", () => {
    expect(estimateCheckpointTokens("abcd")).toBe(1);
    expect(estimateCheckpointTokens("\u65e9\u4e0aabcd")).toBe(3);
  });

  it("selects only a complete prefix and protects the recent tail", () => {
    const messages = [...turn(1), ...turn(2)];
    const result = selectConversationRetentionWindow({
      messages,
      nowUtc: NOW,
      policy: POLICY,
    });

    expect(result.shouldCheckpoint).toBe(true);
    expect(result.checkpointMessages.map((message) => message.id)).toEqual([
      "message-user-1",
      "message-assistant-1",
    ]);
    expect(result.liveTail.map((message) => message.id)).toEqual([
      "message-user-2",
      "message-assistant-2",
    ]);
  });

  it("never checkpoints across a dangling user message", () => {
    const dangling: CheckpointRetentionMessageLike = {
      id: "message-dangling",
      role: "user",
      messageKind: "user",
      content: "x".repeat(80),
      createdAtUtc: OLD,
    };
    const result = selectConversationRetentionWindow({
      messages: [dangling, ...turn(2)],
      nowUtc: NOW,
      policy: POLICY,
    });

    expect(result.shouldCheckpoint).toBe(false);
    expect(result.checkpointMessages).toEqual([]);
    expect(result.reason).toBe("protected_tail_only");
  });

  it("applies the hard limit without splitting turns", () => {
    const result = selectConversationRetentionWindow({
      messages: [...turn(1), ...turn(2), ...turn(3)],
      nowUtc: NOW,
      policy: { ...POLICY, hardTokenLimit: 25 },
    });

    expect(result.shouldCheckpoint).toBe(true);
    expect(result.checkpointMessages).toHaveLength(2);
    expect(result.hardLimitApplied).toBe(true);
    expect(result.liveTail.map((message) => message.id)).toEqual([
      "message-user-3",
      "message-assistant-3",
    ]);
    expect(result.droppedFromLiveContextIds).toEqual([
      "message-user-2",
      "message-assistant-2",
    ]);
  });

  it("canonicalizes only source-controlled message fields", () => {
    const messages = turn(1);
    expect(canonicalCheckpointSource(messages)).toBe(
      canonicalCheckpointSource(structuredClone(messages)),
    );
  });
});
