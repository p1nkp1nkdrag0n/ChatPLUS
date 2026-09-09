import { z } from "zod";
import { LlmCapabilityProfileSchema } from "./llm-capability.js";

export const LlmProtocolSchema = z.enum([
  "openai-compatible",
  "anthropic",
  "gemini",
]);
export type LlmProtocol = z.infer<typeof LlmProtocolSchema>;

export function normalizeLlmBaseUrl(
  value: string,
  protocol: LlmProtocol,
): string {
  const url = new URL(value.trim());
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "API 地址须为 HTTP(S) 地址，且不能包含账号、查询参数或片段",
    );
  }
  let path = url.pathname.replace(/\/+$/u, "");
  if (protocol === "openai-compatible")
    path = path.replace(/\/chat\/completions$/u, "");
  if (protocol === "anthropic") path = path.replace(/\/messages$/u, "");
  if (protocol === "gemini")
    path = path.replace(/\/models\/[^/]+:generateContent$/u, "");
  return `${url.origin}${path}`;
}

export const LlmModelSettingsSchema = z.strictObject({
  id: z.string().trim().min(1).max(250),
  label: z.string().trim().max(250).optional(),
  capabilities: LlmCapabilityProfileSchema.default({
    structuredOutputMode: "prompt_json",
    supportsThinkingControl: false,
    supportsStreaming: false,
    maxOutputTokens: 8192,
  }),
  tokenParameter: z
    .enum(["max_tokens", "max_completion_tokens"])
    .default("max_tokens"),
  thinkingBudget: z.number().int().min(-1).max(1000000).optional(),
  thinkingLevel: z.enum(["minimal", "low", "medium", "high"]).optional(),
});
export type LlmModelSettings = z.infer<typeof LlmModelSettingsSchema>;

export const LlmProviderInputSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120),
    protocol: LlmProtocolSchema,
    baseUrl: z.string().trim().min(1).max(2048),
    apiKey: z.string().max(8192).optional(),
    clearApiKey: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(600000).default(120000),
    models: z.array(LlmModelSettingsSchema).max(2000).default([]),
    expectedRevision: z.number().int().positive().optional(),
  })
  .superRefine((input, ctx) => {
    try {
      normalizeLlmBaseUrl(input.baseUrl, input.protocol);
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["baseUrl"],
        message: "请填写有效的 HTTP(S) API 根地址，不含密钥或查询参数",
      });
    }
    if (input.clearApiKey && input.apiKey?.trim())
      ctx.addIssue({
        code: "custom",
        path: ["apiKey"],
        message: "不能同时清除和替换密钥",
      });
    if (
      new Set(input.models.map((model) => model.id)).size !==
      input.models.length
    )
      ctx.addIssue({
        code: "custom",
        path: ["models"],
        message: "模型 ID 不能重复",
      });
  });
export type LlmProviderInput = z.infer<typeof LlmProviderInputSchema>;

export const LlmSelectionSchema = z.strictObject({
  providerId: z.string().min(1).max(200),
  modelId: z.string().min(1).max(250),
});
export type LlmSelection = z.infer<typeof LlmSelectionSchema>;
export const LlmExecutionSelectionSchema = LlmSelectionSchema.extend({
  revision: z.number().int().positive(),
});
export type LlmExecutionSelection = z.infer<typeof LlmExecutionSelectionSchema>;

export interface LlmProviderView {
  id: string;
  name: string;
  protocol: LlmProtocol | "fixture";
  baseUrl: string;
  timeoutMs: number;
  revision: number;
  models: LlmModelSettings[];
  source: "managed" | "environment" | "fixture";
  hasApiKey: boolean;
  credentialStatus: "ready" | "unavailable";
  discoveredAt?: string;
  referencedSessions: number;
}
export interface LlmCatalog {
  providers: LlmProviderView[];
  defaultSelection: LlmSelection;
}
export interface LlmSessionModel {
  selection: LlmSelection | null;
  effective: LlmExecutionSelection | null;
  error?: string;
}
export const LlmTargetSchema = z
  .strictObject({
    providerId: z.string().min(1).optional(),
    revision: z.number().int().positive().optional(),
    draft: LlmProviderInputSchema.optional(),
    modelId: z.string().trim().min(1).max(250).optional(),
  })
  .refine(
    (target) => target.providerId || target.draft,
    "请选择供应商或填写配置",
  );
export type LlmTarget = z.infer<typeof LlmTargetSchema>;
export interface LlmDiscoveryResult {
  models: LlmModelSettings[];
  discoveredAt: string;
}
export interface LlmProbeStage {
  status: "success" | "failed" | "skipped";
  latencyMs: number;
  reply?: string;
  errorCode?: string;
  error?: string;
}
export interface LlmProbeResult {
  providerId?: string;
  modelId: string;
  configRevision?: number;
  testedAt: string;
  status: "success" | "partial" | "failed";
  text: LlmProbeStage;
  structured: LlmProbeStage;
}
