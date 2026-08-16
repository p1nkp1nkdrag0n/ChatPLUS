import { describe, expect, it } from "vitest";

import {
  resolveMessageDelivery,
  sequentialAnimationSignature,
  sequentialChunkDelay,
  shouldAnimateLiveMessage,
} from "./messageDelivery";

const sequentialMessage = {
  id: "assistant-new",
  role: "assistant" as const,
  text: "第一句\n第二句",
  chunks: ["第一句", "第二句"],
  deliveryMode: "sequential" as const,
};

describe("message delivery", () => {
  it("renders legacy and single-block messages as one bubble", () => {
    expect(
      resolveMessageDelivery({
        text: "完整的一段话",
        chunks: ["完整的", "一段话"],
      }),
    ).toEqual({ mode: "single_block", chunks: ["完整的一段话"] });
  });

  it("keeps valid sequential chunks as separate bubbles", () => {
    expect(
      resolveMessageDelivery({
        text: "第一句\n第二句",
        chunks: ["第一句", "第二句"],
        deliveryMode: "sequential",
      }),
    ).toEqual({ mode: "sequential", chunks: ["第一句", "第二句"] });
  });

  it("falls back to one text bubble when sequential chunks are unavailable", () => {
    expect(
      resolveMessageDelivery({
        text: "仍然可以显示",
        chunks: [],
        deliveryMode: "sequential",
      }),
    ).toEqual({ mode: "single_block", chunks: ["仍然可以显示"] });
  });

  it("does not let mismatched chunks hide or rewrite the complete text", () => {
    expect(
      resolveMessageDelivery({
        text: "I am still here",
        chunks: ["Iam still here"],
        deliveryMode: "sequential",
      }),
    ).toEqual({ mode: "single_block", chunks: ["I am still here"] });
  });

  it("preserves meaningful whitespace and newlines in valid chunks", () => {
    expect(
      resolveMessageDelivery({
        text: " I am here \nnext line  ",
        chunks: [" I am here ", "next line  "],
        deliveryMode: "sequential",
      }),
    ).toEqual({
      mode: "sequential",
      chunks: [" I am here ", "next line  "],
    });
  });

  it("never animates history but recognizes an SSE-first live reply", () => {
    const historyContext = {
      sendPending: false,
      knownMessageIdsAtSendStart: null,
      explicitlyAnimatedIds: new Set<string>(),
      alreadyAnimatedIds: new Set<string>(),
    };
    expect(shouldAnimateLiveMessage(sequentialMessage, historyContext)).toBe(
      false,
    );
    expect(
      shouldAnimateLiveMessage(sequentialMessage, {
        ...historyContext,
        sendPending: true,
        knownMessageIdsAtSendStart: new Set(["older-message"]),
      }),
    ).toBe(true);
    expect(
      shouldAnimateLiveMessage(sequentialMessage, {
        ...historyContext,
        sendPending: true,
        knownMessageIdsAtSendStart: new Set([sequentialMessage.id]),
      }),
    ).toBe(false);
  });

  it("prevents a live message from being animated a second time", () => {
    expect(
      shouldAnimateLiveMessage(sequentialMessage, {
        sendPending: true,
        knownMessageIdsAtSendStart: new Set<string>(),
        explicitlyAnimatedIds: new Set([sequentialMessage.id]),
        alreadyAnimatedIds: new Set([sequentialMessage.id]),
      }),
    ).toBe(false);
  });

  it("keeps the animation identity stable across metadata reallocation", () => {
    expect(sequentialAnimationSignature(["第一句", "第二句"])).toBe(
      sequentialAnimationSignature([...sequentialMessage.chunks]),
    );
  });

  it("uses a short bounded pause between chat bubbles", () => {
    expect(sequentialChunkDelay("好")).toBe(500);
    expect(sequentialChunkDelay("这是一句稍微长一点的话。".repeat(20))).toBe(
      1_200,
    );
  });
});
