import { describe, expect, it } from "vitest";
import { mergeDiscoveredModels, newModel, providerDraft } from "./llmSettings";

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
});
