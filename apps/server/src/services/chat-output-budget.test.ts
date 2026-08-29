import { describe, expect, it } from "vitest";

import {
  CHAT_TURN_OUTPUT_TOKEN_TARGET,
  REPAIR_CHAT_TURN_OUTPUT_TOKEN_TARGET,
  resolveChatOutputTokenBudget,
} from "./chat-output-budget.js";

const capabilities = (maxOutputTokens?: number) => ({
  structuredOutputMode: "json_object" as const,
  supportsThinkingControl: false,
  supportsStreaming: false,
  ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
});

describe("chat output token budgets", () => {
  it("uses the generous primary and repair targets when the model allows them", () => {
    expect(
      resolveChatOutputTokenBudget(
        capabilities(32_768),
        CHAT_TURN_OUTPUT_TOKEN_TARGET,
        2_800,
      ),
    ).toBe(24_576);
    expect(
      resolveChatOutputTokenBudget(
        capabilities(32_768),
        REPAIR_CHAT_TURN_OUTPUT_TOKEN_TARGET,
        2_000,
      ),
    ).toBe(16_384);
  });

  it("never exceeds a lower model capability limit", () => {
    expect(
      resolveChatOutputTokenBudget(
        capabilities(8_192),
        CHAT_TURN_OUTPUT_TOKEN_TARGET,
        2_800,
      ),
    ).toBe(8_192);
  });

  it("preserves a larger future strategy requirement while retaining the cap", () => {
    expect(
      resolveChatOutputTokenBudget(
        capabilities(64_000),
        CHAT_TURN_OUTPUT_TOKEN_TARGET,
        40_000,
      ),
    ).toBe(40_000);
    expect(
      resolveChatOutputTokenBudget(
        capabilities(32_768),
        CHAT_TURN_OUTPUT_TOKEN_TARGET,
        40_000,
      ),
    ).toBe(32_768);
  });
});
