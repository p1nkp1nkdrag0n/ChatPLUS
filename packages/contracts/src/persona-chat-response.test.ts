import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentTurnDecisionSchema, PersonaChatResponseSchema } from "./index.js";

describe("PersonaChatResponseSchema", () => {
  it.each([
    { input: { text: "你好" }, label: "top-level text" },
    { input: { content: "你好" }, label: "top-level content" },
    { input: { reply: "你好" }, label: "string reply" },
    { input: { reply: { text: "你好" } }, label: "nested reply.text" },
  ])("normalizes $label", ({ input }) => {
    expect(PersonaChatResponseSchema.parse(input)).toEqual({
      text: "你好",
      toneTags: [],
    });
  });

  it("keeps optional tone tags and ignores unrelated model fields", () => {
    expect(
      PersonaChatResponseSchema.parse({
        text: "好，我在听。",
        toneTags: ["warm"],
        debug: { candidateCount: 3 },
      }),
    ).toEqual({ text: "好，我在听。", toneTags: ["warm"] });

    expect(
      PersonaChatResponseSchema.parse({
        reply: {
          text: "今晚我想先想一想。",
          toneTags: ["thoughtful"],
          scheduleEffects: [{ operation: "cancel", itemId: "schedule-1" }],
        },
        reasonCode: "legacy_shape",
        memoryCandidates: [{ content: "not part of this boundary" }],
      }),
    ).toEqual({
      text: "今晚我想先想一想。",
      toneTags: ["thoughtful"],
    });
  });

  it("normalizes string tone tags and never rejects valid text for bad tags", () => {
    expect(
      PersonaChatResponseSchema.parse({ text: "好。", toneTags: " warm " }),
    ).toEqual({ text: "好。", toneTags: ["warm"] });

    expect(
      PersonaChatResponseSchema.parse({
        text: "这条回复仍然有效。",
        toneTags: { unexpected: true },
      }),
    ).toEqual({ text: "这条回复仍然有效。", toneTags: [] });

    const validTags = Array.from({ length: 14 }, (_, index) => `tag-${index}`);
    expect(
      PersonaChatResponseSchema.parse({
        text: "数组中的坏标签也不会阻塞回复。",
        toneTags: ["  ", 42, "x".repeat(65), ...validTags, null],
      }).toneTags,
    ).toEqual(validTags.slice(0, 12));
  });

  it("keeps delivery hints optional and never rejects text for bad hints", () => {
    expect(
      PersonaChatResponseSchema.parse({
        text: "先听我说。然后我们再慢慢想。",
        deliveryMode: "sequential",
        chunks: ["先听我说。", "然后我们再慢慢想。"],
      }),
    ).toEqual({
      text: "先听我说。然后我们再慢慢想。",
      toneTags: [],
      deliveryMode: "sequential",
      chunks: ["先听我说。", "然后我们再慢慢想。"],
    });

    expect(
      PersonaChatResponseSchema.parse({
        text: "正文仍然有效。",
        deliveryMode: "many_tiny_messages",
        chunks: [42, "", "x".repeat(4_001)],
      }),
    ).toEqual({ text: "正文仍然有效。", toneTags: [] });
  });

  it("rejects missing, blank, and oversized reply text", () => {
    expect(PersonaChatResponseSchema.safeParse({}).success).toBe(false);
    expect(PersonaChatResponseSchema.safeParse({ text: "   " }).success).toBe(
      false,
    );
    expect(
      PersonaChatResponseSchema.safeParse({ text: "x".repeat(20_001) }).success,
    ).toBe(false);
    expect(
      PersonaChatResponseSchema.safeParse({ text: "x".repeat(20_000) }).success,
    ).toBe(true);
  });

  it("publishes a provider JSON Schema with only text required", () => {
    const jsonSchema = z.toJSONSchema(PersonaChatResponseSchema) as {
      required?: string[];
      properties?: Record<string, unknown>;
    };

    expect(jsonSchema.required).toEqual(["text"]);
    expect(Object.keys(jsonSchema.properties ?? {})).toEqual([
      "text",
      "toneTags",
      "deliveryMode",
      "chunks",
    ]);
  });

  it("does not weaken the persisted AgentTurnDecision contract", () => {
    expect(
      AgentTurnDecisionSchema.safeParse({ text: "仅有回复文本" }).success,
    ).toBe(false);
  });
});
