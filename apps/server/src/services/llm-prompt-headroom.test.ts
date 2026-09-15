import { describe, expect, it } from "vitest";

import {
  LlmPromptHeadroomError,
  calculateLlmPromptTokenBudget,
  resolveChatTurnTokenBudget,
} from "./llm-prompt-headroom.js";

const BASE_CAPABILITIES = {
  structuredOutputMode: "native_schema" as const,
  supportsThinkingControl: true,
  supportsStreaming: false,
};

describe("calculateLlmPromptTokenBudget", () => {
  it("honors a separately reported input limit while reserving output from the total window", () => {
    expect(
      calculateLlmPromptTokenBudget({
        ...BASE_CAPABILITIES,
        maxContextTokens: 64_000,
        maxInputTokens: 24_000,
        maxOutputTokens: 4096,
      }),
    ).toBe(22_000);
  });
  it("uses the smaller provider window after reserving normal chat output", () => {
    expect(
      calculateLlmPromptTokenBudget({
        ...BASE_CAPABILITIES,
        maxContextTokens: 128_000,
        maxOutputTokens: 64_000,
      }),
    ).toBe(101_424);
  });

  it("caps a large provider at a 258,000-token total application window", () => {
    const budget = resolveChatTurnTokenBudget({
      ...BASE_CAPABILITIES,
      maxContextTokens: 1_000_000,
      maxOutputTokens: 32_768,
    });
    expect(budget).toEqual({
      maxInputTokens: 231_424,
      maxOutputTokens: 24_576,
    });
    expect(budget.maxInputTokens + budget.maxOutputTokens + 2_000).toBe(
      258_000,
    );
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

  it("reserves the actual primary output request when limits are not reported", () => {
    const budget = calculateLlmPromptTokenBudget(BASE_CAPABILITIES);

    expect(budget).toBe(5_424);
    expect(budget + 24_576 + 2_000).toBe(32_000);
  });

  it("does not reserve unused output capability for a normal chat turn", () => {
    expect(
      resolveChatTurnTokenBudget({
        ...BASE_CAPABILITIES,
        maxContextTokens: 65_536,
        maxOutputTokens: 64_000,
      }),
    ).toEqual({ maxInputTokens: 38_960, maxOutputTokens: 24_576 });
  });

  it("uses one capability-clamped output allowance for both sides of the budget", () => {
    const budget = resolveChatTurnTokenBudget({
      ...BASE_CAPABILITIES,
      maxContextTokens: 16_000,
      maxOutputTokens: 4_000,
    });
    expect(budget).toEqual({ maxInputTokens: 10_000, maxOutputTokens: 4_000 });
    expect(budget.maxInputTokens + budget.maxOutputTokens + 2_000).toBe(16_000);
  });
});
