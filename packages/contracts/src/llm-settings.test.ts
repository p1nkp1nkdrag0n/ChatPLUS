import { describe, expect, it } from "vitest";
import {
  LlmModelSettingsSchema,
  LlmProviderInputSchema,
  normalizeLlmBaseUrl,
} from "./llm-settings.js";

describe("model settings contracts", () => {
  it("normalizes cloud and unauthenticated local endpoints without duplicated suffixes", () => {
    expect(
      normalizeLlmBaseUrl(
        "http://127.0.0.1:11434/v1/chat/completions/",
        "openai-compatible",
      ),
    ).toBe("http://127.0.0.1:11434/v1");
    expect(
      normalizeLlmBaseUrl(
        "https://gateway.example/proxy/v1/messages",
        "anthropic",
      ),
    ).toBe("https://gateway.example/proxy/v1");
    expect(
      normalizeLlmBaseUrl(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent",
        "gemini",
      ),
    ).toBe("https://generativelanguage.googleapis.com/v1beta");
  });
  it("rejects credential-bearing addresses and duplicate models", () => {
    const base = {
      name: "Local",
      protocol: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
    };
    for (const baseUrl of [
      "file:///secret",
      "https://key@example.com/v1",
      "https://example.com/v1?key=secret",
      "https://example.com/#key",
    ]) {
      expect(
        LlmProviderInputSchema.safeParse({ ...base, baseUrl }).success,
      ).toBe(false);
    }
    expect(
      LlmProviderInputSchema.safeParse({
        ...base,
        models: [{ id: "a" }, { id: "a" }],
      }).success,
    ).toBe(false);
    expect(
      LlmProviderInputSchema.safeParse({
        ...base,
        apiKey: "replacement",
        clearApiKey: true,
      }).success,
    ).toBe(false);
  });
  it("defaults new models to prompt JSON without altering model thinking", () => {
    const model = LlmModelSettingsSchema.parse({ id: "my-model" });
    expect(model.capabilities).toMatchObject({
      structuredOutputMode: "prompt_json",
      supportsThinkingControl: false,
    });
    expect(model.capabilities.reasoningEffort).toBeUndefined();
    expect(model.thinkingBudget).toBeUndefined();
    expect(
      LlmProviderInputSchema.parse({
        name: "Local",
        protocol: "openai-compatible",
        baseUrl: "http://localhost:11434/v1",
      }).apiKey,
    ).toBeUndefined();
  });
});
