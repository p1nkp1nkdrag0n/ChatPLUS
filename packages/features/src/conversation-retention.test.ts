import { describe, expect, it } from "vitest";

import {
  estimateConversationTokens,
  groupConversationTurns,
  selectConversationRetention,
  type RetentionMessageLike,
} from "./conversation-retention.js";

const NOW = "2026-08-21T10:00:00.000Z";

describe("conversation retention", () => {
  it("estimates Han characters directly and other text in four-character units", () => {
    expect(estimateConversationTokens("hello")).toBe(2);
    expect(estimateConversationTokens("\u4f60\u597dabcde")).toBe(4);
  });

  it("selects only complete reactive turns at a soft boundary", () => {
    const messages = [
      message("u1", "user", "a".repeat(40), 1),
      message("a1", "assistant", "b".repeat(40), 2),
      message("u2", "user", "c".repeat(40), 3),
      message("a2", "assistant", "d".repeat(40), 4),
      message("u3", "user", "latest", 5),
      message("a3", "assistant", "reply", 6),
    ];
    const selected = selectConversationRetention({
      messages,
      nowUtc: NOW,
      policy: {
        fullVerbatimHours: 0,
        softTokenLimit: 20,
        hardTokenLimit: 40,
        minimumTailTokens: 0,
        minimumRecentTurns: 1,
      },
    });

    expect(selected.messages.map((item) => item.id)).toEqual(["u3", "a3"]);
    expect(selected.checkpointThroughMessageId).toBe("a2");
    expect(selected.omittedMessageCount).toBe(4);
  });

  it("keeps a dangling latest user message", () => {
    const messages = [
      message("u1", "user", "old", 1),
      message("a1", "assistant", "old reply", 2),
      message("u2", "user", "pending question", 3),
    ];
    const selected = selectConversationRetention({
      messages,
      nowUtc: NOW,
      policy: {
        fullVerbatimHours: 0,
        softTokenLimit: 4,
        hardTokenLimit: 20,
        minimumTailTokens: 0,
        minimumRecentTurns: 1,
      },
    });

    expect(selected.messages.map((item) => item.id)).toEqual(["u2"]);
    expect(selected.turns[0]?.complete).toBe(false);
  });

  it("treats proactive assistant messages as their own complete turns", () => {
    const messages = [
      message("u1", "user", "pending", 1),
      message("p1", "assistant", "proactive", 2, "proactive"),
      message("u2", "user", "reply later", 3),
      message("a2", "assistant", "answer", 4),
    ];

    const turns = groupConversationTurns(messages);

    expect(turns.map((turn) => turn.messages.map((item) => item.id))).toEqual([
      ["u1"],
      ["p1"],
      ["u2", "a2"],
    ]);
    expect(turns[1]).toMatchObject({ complete: true, proactive: true });
  });

  it("never exceeds the hard limit even for one oversized turn", () => {
    const selected = selectConversationRetention({
      messages: [message("u1", "user", "\u4f60".repeat(100), 1)],
      nowUtc: NOW,
      policy: {
        fullVerbatimHours: 24,
        softTokenLimit: 20,
        hardTokenLimit: 30,
        minimumTailTokens: 20,
        minimumRecentTurns: 1,
      },
    });

    expect(selected.estimatedTokens).toBeLessThanOrEqual(30);
    expect(selected.truncatedForHardLimit).toBe(true);
    expect(selected.messages).toHaveLength(1);
  });

  it("keeps a bounded tail after ten thousand historical messages", () => {
    const messages = Array.from({ length: 10_000 }, (_, index) =>
      message(
        "m" + index,
        index % 2 === 0 ? "user" : "assistant",
        "x".repeat(40),
        index,
      ),
    );
    const selected = selectConversationRetention({
      messages,
      nowUtc: NOW,
      policy: {
        fullVerbatimHours: 0,
        softTokenLimit: 200,
        hardTokenLimit: 300,
        minimumTailTokens: 100,
        minimumRecentTurns: 5,
      },
    });

    expect(selected.estimatedTokens).toBeLessThanOrEqual(300);
    expect(selected.messages.length).toBeLessThan(40);
    expect(selected.messages.at(-1)?.id).toBe("m9999");
  });
});

function message(
  id: string,
  role: RetentionMessageLike["role"],
  text: string,
  minute: number,
  origin: RetentionMessageLike["origin"] = role === "user"
    ? "user"
    : "reactive",
): RetentionMessageLike {
  return {
    id,
    role,
    text,
    origin,
    createdAtUtc: new Date(
      Date.parse(NOW) - (10_000 - minute) * 60_000,
    ).toISOString(),
  };
}
