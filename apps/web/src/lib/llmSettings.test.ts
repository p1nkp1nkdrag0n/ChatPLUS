import { describe, expect, it } from "vitest";
import {
  mergeDiscoveredModels,
  newModel,
  providerDraft,
  withThinkingBudget,
  withThinkingEffort,
  withThinkingLevel,
} from "./llmSettings";

describe("provider form state", () => {
  it("preserves per-model tuning when a refreshed listing contains duplicates", () => {
    const tuned = { ...newModel("model-a"), thinkingBudget: 2048 };
    expect(
      mergeDiscoveredModels(
        [tuned],
        [newModel("model-a"), newModel("model-b"), newModel("model-b")],
      ),
    ).toEqual([tuned, newModel("model-b")]);
  });
  it("omits secrets from the initial form and leaves thinking to the model", () => {
    expect(providerDraft()).not.toHaveProperty("apiKey");
    expect(newModel("model-a").capabilities).toMatchObject({
      structuredOutputMode: "prompt_json",
      supportsThinkingControl: false,
    });
    expect(newModel("model-a").capabilities.reasoningEffort).toBeUndefined();
  });
  it("replaces Gemini budget and level without retaining conflicting controls", () => {
    const budget = withThinkingBudget(newModel("gemini"), 2048);
    const level = withThinkingLevel(budget, "high");
    expect(level.thinkingLevel).toBe("high");
    expect(level).not.toHaveProperty("thinkingBudget");
    const disabled = withThinkingBudget(level, 0);
    expect(disabled.thinkingBudget).toBe(0);
    expect(disabled).not.toHaveProperty("thinkingLevel");
    expect(withThinkingBudget(disabled, undefined)).not.toHaveProperty(
      "thinkingBudget",
    );
    expect(budget.thinkingBudget).toBe(2048);
  });
  it("switches Anthropic effort and fixed budget without adaptive-thinking conflicts", () => {
    const initial = newModel("claude");
    const effort = withThinkingEffort(initial, "anthropic", "high");
    expect(effort.capabilities.reasoningRequestFormat).toBe(
      "anthropic_output_config",
    );
    const budget = withThinkingBudget(effort, 1024);
    expect(budget.thinkingBudget).toBe(1024);
    expect(budget.capabilities).not.toHaveProperty("reasoningEffort");
    expect(budget.capabilities).not.toHaveProperty("reasoningRequestFormat");
    expect(withThinkingEffort(budget, "anthropic", "max")).not.toHaveProperty(
      "thinkingBudget",
    );
    expect(initial.capabilities.reasoningEffort).toBeUndefined();
  });
  it("preserves max effort for compatible APIs and removes both fields for model default", () => {
    const tuned = withThinkingEffort(
      newModel("openai"),
      "openai-compatible",
      "max",
    );
    expect(tuned.capabilities).toMatchObject({
      reasoningEffort: "max",
      reasoningRequestFormat: "openai_reasoning_effort",
    });
    const modelDefault = withThinkingEffort(
      tuned,
      "openai-compatible",
      undefined,
    );
    expect(modelDefault.capabilities).not.toHaveProperty("reasoningEffort");
    expect(modelDefault.capabilities).not.toHaveProperty(
      "reasoningRequestFormat",
    );
  });
  it("clears imported automatic thinking control only when the user chooses a control", () => {
    const imported = newModel("imported");
    imported.capabilities.supportsThinkingControl = true;
    expect(
      withThinkingEffort(imported, "openai-compatible", undefined).capabilities
        .supportsThinkingControl,
    ).toBe(false);
    expect(
      withThinkingBudget(imported, 2048).capabilities.supportsThinkingControl,
    ).toBe(false);
    expect(
      withThinkingLevel(imported, "high").capabilities.supportsThinkingControl,
    ).toBe(false);
    expect(imported.capabilities.supportsThinkingControl).toBe(true);
  });
});
