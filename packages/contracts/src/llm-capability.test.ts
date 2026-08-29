import { describe, expect, it } from "vitest";

import { LlmCapabilityProfileSchema } from "./llm-capability.js";

describe("LlmCapabilityProfileSchema", () => {
  it("accepts an explicit provider capability profile", () => {
    expect(
      LlmCapabilityProfileSchema.parse({
        structuredOutputMode: "json_object",
        supportsThinkingControl: true,
        supportsStreaming: false,
        reasoningEffort: "medium",
        reasoningRequestFormat: "openai_reasoning_effort",
        maxContextTokens: 128_000,
        maxOutputTokens: 8_192,
      }),
    ).toEqual({
      structuredOutputMode: "json_object",
      supportsThinkingControl: true,
      supportsStreaming: false,
      reasoningEffort: "medium",
      reasoningRequestFormat: "openai_reasoning_effort",
      maxContextTokens: 128_000,
      maxOutputTokens: 8_192,
    });
  });

  it("rejects an output budget that consumes the full context window", () => {
    expect(
      LlmCapabilityProfileSchema.safeParse({
        structuredOutputMode: "prompt_json",
        supportsThinkingControl: false,
        supportsStreaming: false,
        maxContextTokens: 4_096,
        maxOutputTokens: 4_096,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown capability fields", () => {
    expect(
      LlmCapabilityProfileSchema.safeParse({
        structuredOutputMode: "native_schema",
        supportsThinkingControl: false,
        supportsStreaming: true,
        vendorExtension: true,
      }).success,
    ).toBe(false);
  });

  it("requires reasoning effort and request format to be configured together", () => {
    expect(
      LlmCapabilityProfileSchema.safeParse({
        structuredOutputMode: "json_object",
        supportsThinkingControl: false,
        supportsStreaming: false,
        reasoningEffort: "medium",
      }).success,
    ).toBe(false);
  });
});
