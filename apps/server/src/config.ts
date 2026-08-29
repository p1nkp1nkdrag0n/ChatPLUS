import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConversationRetentionPolicySchema,
  LlmCapabilityProfileSchema,
  ReasoningEffortSchema,
  ReasoningRequestFormatSchema,
  type ConversationRetentionPolicy,
  type LlmCapabilityProfile,
} from "@personasim/contracts";
import { config as loadEnv } from "dotenv";
import { z } from "zod";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
loadEnv({ path: resolve(workspaceRoot, ".env"), quiet: true });

const booleanFromEnv = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const optionalPositiveIntegerFromEnv = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().int().positive().optional(),
);
const optionalApiKeyFromEnv = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().trim().min(1).optional(),
);
const falseByDefaultBooleanFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const activeLlmProfileNameFromEnv = z.preprocess(
  (value) => {
    if (typeof value !== "string") return value;
    const normalized = value.trim().toLowerCase();
    return normalized === "" ? undefined : normalized;
  },
  z
    .string()
    .regex(
      /^[a-z0-9][a-z0-9_-]*$/u,
      "LLM_ACTIVE_PROFILE must contain only letters, numbers, underscores, and hyphens, and must start with a letter or number.",
    )
    .optional(),
);

const structuredOutputModeFromEnv = z
  .enum(["native_schema", "json_object", "prompt_json"])
  .default("json_object");
const optionalReasoningEffortFromEnv = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  ReasoningEffortSchema.optional(),
);
const optionalReasoningRequestFormatFromEnv = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  ReasoningRequestFormatSchema.optional(),
);
const timeoutMsFromEnv = z.coerce.number().int().positive().default(120_000);
const maxRetriesFromEnv = z.coerce.number().int().min(0).max(3).default(1);
const maxOutputTokensFromEnv = z.coerce
  .number()
  .int()
  .positive()
  .max(64_000)
  .default(8_192);

const legacyLlmEnvironmentSchema = z.object({
  baseUrl: z.string().url().default("https://api.deepseek.com"),
  apiKey: optionalApiKeyFromEnv,
  model: z.string().default("deepseek-v4-flash"),
  timeoutMs: timeoutMsFromEnv,
  maxRetries: maxRetriesFromEnv,
  structuredOutputMode: structuredOutputModeFromEnv,
  reasoningEffort: optionalReasoningEffortFromEnv,
  reasoningRequestFormat: optionalReasoningRequestFormatFromEnv,
  supportsThinkingControl: booleanFromEnv,
  supportsStreaming: falseByDefaultBooleanFromEnv,
  maxContextTokens: optionalPositiveIntegerFromEnv,
  maxOutputTokens: maxOutputTokensFromEnv,
});

const secureProfileBaseUrlFromEnv = z
  .string()
  .trim()
  .url()
  .superRefine((value, context) => {
    if (!URL.canParse(value)) {
      context.addIssue({
        code: "custom",
        message: "LLM profile BASE_URL must be a valid URL.",
      });
      return;
    }
    const parsed = new URL(value);
    const authority = value.slice(value.indexOf("//") + 2).split(/[/?#]/u)[0];

    if (parsed.protocol !== "https:") {
      context.addIssue({
        code: "custom",
        message: "LLM profile BASE_URL must use HTTPS.",
      });
    }
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      authority?.includes("@")
    ) {
      context.addIssue({
        code: "custom",
        message: "LLM profile BASE_URL must not contain user information.",
      });
    }
    if (value.includes("?")) {
      context.addIssue({
        code: "custom",
        message: "LLM profile BASE_URL must not contain a query string.",
      });
    }
    if (value.includes("#")) {
      context.addIssue({
        code: "custom",
        message: "LLM profile BASE_URL must not contain a fragment.",
      });
    }
  });

const liveProfileEnvironmentSchema = z.object({
  baseUrl: secureProfileBaseUrlFromEnv,
  apiKey: optionalApiKeyFromEnv,
  model: z.string().trim().min(1),
  timeoutMs: timeoutMsFromEnv,
  maxRetries: maxRetriesFromEnv,
  structuredOutputMode: structuredOutputModeFromEnv,
  reasoningEffort: optionalReasoningEffortFromEnv,
  reasoningRequestFormat: optionalReasoningRequestFormatFromEnv,
  supportsThinkingControl: falseByDefaultBooleanFromEnv,
  supportsStreaming: falseByDefaultBooleanFromEnv,
  maxContextTokens: optionalPositiveIntegerFromEnv,
  maxOutputTokens: maxOutputTokensFromEnv,
});

type ProfileEnvironmentField =
  | "BASE_URL"
  | "API_KEY"
  | "MODEL"
  | "TIMEOUT_MS"
  | "MAX_RETRIES"
  | "STRUCTURED_OUTPUT_MODE"
  | "REASONING_EFFORT"
  | "REASONING_FORMAT"
  | "SUPPORTS_THINKING_CONTROL"
  | "SUPPORTS_STREAMING"
  | "MAX_CONTEXT_TOKENS"
  | "MAX_OUTPUT_TOKENS";

function profileEnvironmentPrefix(profileName: string): string {
  return profileName.replaceAll("-", "_").toUpperCase();
}

function readLiveProfileEnvironment(profileName: string) {
  const prefix = `LLM_PROFILE_${profileEnvironmentPrefix(profileName)}_`;
  const read = (field: ProfileEnvironmentField) =>
    process.env[`${prefix}${field}`];

  return liveProfileEnvironmentSchema.parse({
    baseUrl: read("BASE_URL"),
    apiKey: read("API_KEY"),
    model: read("MODEL"),
    timeoutMs: read("TIMEOUT_MS"),
    maxRetries: read("MAX_RETRIES"),
    structuredOutputMode: read("STRUCTURED_OUTPUT_MODE"),
    reasoningEffort: read("REASONING_EFFORT"),
    reasoningRequestFormat: read("REASONING_FORMAT"),
    supportsThinkingControl: read("SUPPORTS_THINKING_CONTROL"),
    supportsStreaming: read("SUPPORTS_STREAMING"),
    maxContextTokens: read("MAX_CONTEXT_TOKENS"),
    maxOutputTokens: read("MAX_OUTPUT_TOKENS"),
  });
}

function readLegacyLlmEnvironment() {
  return legacyLlmEnvironmentSchema.parse({
    baseUrl: process.env.OPENAI_COMPATIBLE_BASE_URL ?? process.env.LLM_BASE_URL,
    apiKey: process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LLM_API_KEY,
    model: process.env.OPENAI_COMPATIBLE_MODEL ?? process.env.LLM_MODEL,
    timeoutMs:
      process.env.OPENAI_COMPATIBLE_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS,
    maxRetries:
      process.env.OPENAI_COMPATIBLE_MAX_RETRIES ?? process.env.LLM_MAX_RETRIES,
    structuredOutputMode: process.env.OPENAI_COMPATIBLE_STRUCTURED_OUTPUT_MODE,
    reasoningEffort:
      process.env.OPENAI_COMPATIBLE_REASONING_EFFORT ??
      process.env.LLM_REASONING_EFFORT,
    reasoningRequestFormat:
      process.env.OPENAI_COMPATIBLE_REASONING_FORMAT ??
      process.env.LLM_REASONING_FORMAT,
    supportsThinkingControl:
      process.env.OPENAI_COMPATIBLE_SUPPORTS_THINKING_CONTROL,
    supportsStreaming: process.env.OPENAI_COMPATIBLE_SUPPORTS_STREAMING,
    maxContextTokens: process.env.OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS,
    maxOutputTokens: process.env.OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS,
  });
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
  HOST: z.string().default("127.0.0.1"),
  WEB_ORIGIN: z.string().default("http://localhost:5173"),
  DATABASE_PATH: z.string().default("./data/persona-sim.sqlite"),
  PERSONASIM_PROFILE: z.string().default("development"),
  CLOCK_MODE: z.enum(["system", "fake"]).default("system"),
  FAKE_CLOCK_START: z.iso.datetime().default("2026-08-16T10:00:00.000Z"),
  LLM_PROVIDER: z.enum(["fixture", "openai-compatible"]).default("fixture"),
  LLM_ACTIVE_PROFILE: activeLlmProfileNameFromEnv,
  CONVERSATION_FULL_VERBATIM_HOURS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(24),
  CONVERSATION_SOFT_TOKEN_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(8_000),
  CONVERSATION_HARD_TOKEN_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(12_000),
  CONVERSATION_MINIMUM_TAIL_TOKENS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(3_000),
  CONVERSATION_MINIMUM_RECENT_TURNS: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(12),
  LOG_LEVEL: z.string().default("info"),
  SEED_DEMO: booleanFromEnv,
  CHAT_EFFECTS_MODE: z.enum(["off", "gated"]).default("gated"),
  SCHEDULE_NEGOTIATION_MODE: z
    .enum(["legacy", "shadow", "enforced"])
    .default("shadow"),
  SELF_INITIATED_PLANNING: z
    .enum(["off", "shadow", "enforced"])
    .default("enforced"),
  LIVE_WORLD_EFFECTS: z.enum(["off", "shadow", "enforced"]).default("enforced"),
  MEMORY_RECALL_MODE: z
    .enum(["legacy", "shadow", "enforced"])
    .default("legacy"),
  AUTOBIOGRAPHY_MODE: z.enum(["off", "shadow", "enforced"]).default("off"),
});

export type ServerConfig = {
  nodeEnv: "development" | "test" | "production";
  profile: string;
  port: number;
  host: string;
  webOrigin: string;
  databasePath: string;
  clockMode: "system" | "fake";
  fakeClockStart: string;
  llm: {
    provider: "fixture" | "openai-compatible";
    profileName?: string;
    baseUrl: string;
    apiKey?: string;
    model: string;
    timeoutMs: number;
    maxRetries: number;
    maxOutputTokens?: number;
    capabilities?: LlmCapabilityProfile;
  };
  conversationRetention: ConversationRetentionPolicy;
  logLevel: string;
  seedDemo: boolean;
  developerRoutes: boolean;
  chatEffectsMode: "off" | "gated";
  scheduleNegotiationMode: "legacy" | "shadow" | "enforced";
  selfInitiatedPlanningMode: "off" | "shadow" | "enforced";
  liveWorldEffectsMode: "off" | "shadow" | "enforced";
  memoryRecallMode: "legacy" | "shadow" | "enforced";
  autobiographyMode: "off" | "shadow" | "enforced";
};

export function readConfig(
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  const env = envSchema.parse(process.env);
  if (
    env.LLM_ACTIVE_PROFILE !== undefined &&
    env.LLM_PROVIDER !== "openai-compatible"
  ) {
    throw new TypeError(
      "LLM_ACTIVE_PROFILE requires LLM_PROVIDER=openai-compatible.",
    );
  }
  const llmEnvironment =
    env.LLM_ACTIVE_PROFILE === undefined
      ? readLegacyLlmEnvironment()
      : readLiveProfileEnvironment(env.LLM_ACTIVE_PROFILE);

  const base: ServerConfig = {
    nodeEnv: env.NODE_ENV,
    profile: env.PERSONASIM_PROFILE,
    port: env.PORT,
    host: env.HOST,
    webOrigin: env.WEB_ORIGIN,
    databasePath: resolve(workspaceRoot, env.DATABASE_PATH),
    clockMode: env.CLOCK_MODE,
    fakeClockStart: env.FAKE_CLOCK_START,
    llm: {
      provider: env.LLM_PROVIDER,
      ...(env.LLM_ACTIVE_PROFILE === undefined
        ? {}
        : { profileName: env.LLM_ACTIVE_PROFILE }),
      baseUrl: llmEnvironment.baseUrl.replace(/\/$/, ""),
      ...(llmEnvironment.apiKey ? { apiKey: llmEnvironment.apiKey } : {}),
      model: llmEnvironment.model,
      timeoutMs: llmEnvironment.timeoutMs,
      maxRetries: llmEnvironment.maxRetries,
      maxOutputTokens: llmEnvironment.maxOutputTokens,
      capabilities: LlmCapabilityProfileSchema.parse({
        structuredOutputMode: llmEnvironment.structuredOutputMode,
        supportsThinkingControl: llmEnvironment.supportsThinkingControl,
        supportsStreaming: llmEnvironment.supportsStreaming,
        ...(llmEnvironment.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: llmEnvironment.reasoningEffort }),
        ...(llmEnvironment.reasoningRequestFormat === undefined
          ? {}
          : {
              reasoningRequestFormat: llmEnvironment.reasoningRequestFormat,
            }),
        ...(llmEnvironment.maxContextTokens === undefined
          ? {}
          : {
              maxContextTokens: llmEnvironment.maxContextTokens,
            }),
        maxOutputTokens: llmEnvironment.maxOutputTokens,
      }),
    },
    conversationRetention: {
      fullVerbatimHours: env.CONVERSATION_FULL_VERBATIM_HOURS,
      softTokenLimit: env.CONVERSATION_SOFT_TOKEN_LIMIT,
      hardTokenLimit: env.CONVERSATION_HARD_TOKEN_LIMIT,
      minimumTailTokens: env.CONVERSATION_MINIMUM_TAIL_TOKENS,
      minimumRecentTurns: env.CONVERSATION_MINIMUM_RECENT_TURNS,
    },
    logLevel: env.LOG_LEVEL,
    seedDemo: env.SEED_DEMO,
    developerRoutes: env.NODE_ENV !== "production",
    chatEffectsMode: env.CHAT_EFFECTS_MODE,
    scheduleNegotiationMode: env.SCHEDULE_NEGOTIATION_MODE,
    selfInitiatedPlanningMode: env.SELF_INITIATED_PLANNING,
    liveWorldEffectsMode: env.LIVE_WORLD_EFFECTS,
    memoryRecallMode: env.MEMORY_RECALL_MODE,
    autobiographyMode: env.AUTOBIOGRAPHY_MODE,
  };

  const merged = {
    ...base,
    ...overrides,
    llm: { ...base.llm, ...overrides.llm },
  };
  return {
    ...merged,
    conversationRetention: ConversationRetentionPolicySchema.parse(
      merged.conversationRetention,
    ),
  };
}
