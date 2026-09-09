import {
  LlmModelSettingsSchema,
  type LlmModelSettings,
  type LlmProtocol,
  type LlmProviderInput,
  type LlmProviderView,
  type LlmSelection,
} from "@personasim/contracts";

export const protocolLabels: Record<LlmProviderView["protocol"], string> = {
  "openai-compatible": "OpenAI 兼容",
  anthropic: "Anthropic Messages",
  gemini: "Google Gemini",
  fixture: "Fixture 离线演示",
};
export const protocolUrls: Record<LlmProtocol, string> = {
  "openai-compatible": "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  gemini: "https://generativelanguage.googleapis.com/v1beta",
};
export function providerDraft(provider?: LlmProviderView): LlmProviderInput {
  return {
    name: provider?.name ?? "",
    protocol:
      provider?.protocol === "fixture"
        ? "openai-compatible"
        : (provider?.protocol ?? "openai-compatible"),
    baseUrl: provider?.baseUrl ?? protocolUrls["openai-compatible"],
    timeoutMs: provider?.timeoutMs ?? 120000,
    models: provider?.models ?? [],
    ...(provider?.source === "managed"
      ? { expectedRevision: provider.revision }
      : {}),
  };
}
export function newModel(id: string): LlmModelSettings {
  return LlmModelSettingsSchema.parse({ id: id.trim() });
}
export function selectionKey(selection: LlmSelection | null): string {
  return selection
    ? JSON.stringify([selection.providerId, selection.modelId])
    : "";
}
export function sameSelection(
  a: LlmSelection | null,
  b: LlmSelection | null,
): boolean {
  return selectionKey(a) === selectionKey(b);
}

/** A refreshed listing must not overwrite the user's per-model capability settings. */
export function mergeDiscoveredModels(
  saved: LlmModelSettings[],
  discovered: LlmModelSettings[],
): LlmModelSettings[] {
  const models = new Map(saved.map((model) => [model.id, model]));
  for (const model of discovered)
    if (!models.has(model.id)) models.set(model.id, model);
  return [...models.values()];
}

export function withThinkingEffort(
  model: LlmModelSettings,
  protocol: "openai-compatible" | "anthropic",
  effort: LlmModelSettings["capabilities"]["reasoningEffort"],
): LlmModelSettings {
  const next = {
    ...model,
    capabilities: { ...model.capabilities, supportsThinkingControl: false },
  };
  if (effort !== undefined) {
    next.capabilities.reasoningEffort = effort;
    next.capabilities.reasoningRequestFormat =
      protocol === "anthropic"
        ? "anthropic_output_config"
        : "openai_reasoning_effort";
    delete next.thinkingBudget;
    delete next.thinkingLevel;
  } else {
    delete next.capabilities.reasoningEffort;
    delete next.capabilities.reasoningRequestFormat;
  }
  return next;
}

export function withThinkingBudget(
  model: LlmModelSettings,
  budget: number | undefined,
): LlmModelSettings {
  const next = {
    ...model,
    capabilities: { ...model.capabilities, supportsThinkingControl: false },
  };
  if (budget !== undefined) {
    next.thinkingBudget = budget;
    delete next.thinkingLevel;
    delete next.capabilities.reasoningEffort;
    delete next.capabilities.reasoningRequestFormat;
  } else delete next.thinkingBudget;
  return next;
}

export function withThinkingLevel(
  model: LlmModelSettings,
  level: LlmModelSettings["thinkingLevel"],
): LlmModelSettings {
  const next = {
    ...model,
    capabilities: { ...model.capabilities, supportsThinkingControl: false },
  };
  if (level !== undefined) {
    next.thinkingLevel = level;
    delete next.thinkingBudget;
    delete next.capabilities.reasoningEffort;
    delete next.capabilities.reasoningRequestFormat;
  } else delete next.thinkingLevel;
  return next;
}
