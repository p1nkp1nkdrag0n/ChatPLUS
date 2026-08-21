import { describe, expect, it } from "vitest";

import {
  LlmPromptHeadroomError,
  calculateLlmPromptTokenBudget,
} from "./llm-prompt-headroom.js";

const BASE_CAPABILITIES = {
  structuredOutputMode: "native_schema" as const,
  supportsThinkingControl: true,
  supportsStreaming: false,
};

describe("calculateLlmPromptTokenBudget", () => {
  it("caps ample provider headroom at 24,000 tokens", () => {
    expect(
      calculateLlmPromptTokenBudget({
        ...BASE_CAPABILITIES,
        maxContextTokens: 128_000,
        maxOutputTokens: 64_000,
      }),
    ).toBe(24_000);
  });

  it("uses exactly context minus output minus the reserved allowance", () => {
    expect(
      calculateLlmPromptTokenBudget({
        ...BASE_CAPABILITIES,
        maxContextTokens: 16_000,
        maxOutputTokens: 4_000,
      }),
    ).toBe(10_000);
  });

  it("accepts the minimum 4,000-token boundary without exceeding it", () => {
    expect(
      calculateLlmPromptTokenBudget({
        ...BASE_CAPABILITIES,
        maxContextTokens: 6_256,
        maxOutputTokens: 256,
      }),
    ).toBe(4_000);
  });

  it("rejects a provider profile below the minimum instead of borrowing headroom", () => {
    expect.assertions(5);
    try {
      calculateLlmPromptTokenBudget({
        ...BASE_CAPABILITIES,
        maxContextTokens: 4_096,
        maxOutputTokens: 256,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(LlmPromptHeadroomError);
      expect(error).toMatchObject({
        code: "insufficient_llm_prompt_headroom",
        details: {
          maxContextTokens: 4_096,
          maxOutputTokens: 256,
          reservedTokens: 2_000,
          availablePromptTokens: 1_840,
          minimumPromptTokens: 4_000,
        },
      });
      expect((error as Error).message).toContain("1840 prompt tokens");
      expect((error as Error).message).toContain("at least 4000");
      expect((error as Error).message).toContain("maxContextTokens");
    }
  });

  it("uses conservative defaults when limits are not reported", () => {
    const budget = calculateLlmPromptTokenBudget(BASE_CAPABILITIES);

    expect(budget).toBe(21_808);
    expect(budget + 8_192 + 2_000).toBe(32_000);
  });
});
