import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ConversationRetentionPolicySchema,
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
const falseByDefaultBooleanFromEnv = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

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
  OPENAI_COMPATIBLE_BASE_URL: z
    .string()
    .url()
    .default("https://api.deepseek.com"),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  OPENAI_COMPATIBLE_MODEL: z.string().default("deepseek-v4-flash"),
  OPENAI_COMPATIBLE_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(120_000),
  OPENAI_COMPATIBLE_MAX_RETRIES: z.coerce
    .number()
    .int()
    .min(0)
    .max(3)
    .default(1),
  OPENAI_COMPATIBLE_STRUCTURED_OUTPUT_MODE: z
    .enum(["native_schema", "json_object", "prompt_json"])
    .default("json_object"),
  OPENAI_COMPATIBLE_SUPPORTS_THINKING_CONTROL: booleanFromEnv,
  OPENAI_COMPATIBLE_SUPPORTS_STREAMING: falseByDefaultBooleanFromEnv,
  OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS: optionalPositiveIntegerFromEnv,
  OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .positive()
    .max(64_000)
    .default(8_192),
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
  const env = envSchema.parse({
    ...process.env,
    OPENAI_COMPATIBLE_BASE_URL:
      process.env.OPENAI_COMPATIBLE_BASE_URL ?? process.env.LLM_BASE_URL,
    OPENAI_COMPATIBLE_API_KEY:
      process.env.OPENAI_COMPATIBLE_API_KEY ?? process.env.LLM_API_KEY,
    OPENAI_COMPATIBLE_MODEL:
      process.env.OPENAI_COMPATIBLE_MODEL ?? process.env.LLM_MODEL,
    OPENAI_COMPATIBLE_TIMEOUT_MS:
      process.env.OPENAI_COMPATIBLE_TIMEOUT_MS ?? process.env.LLM_TIMEOUT_MS,
    OPENAI_COMPATIBLE_MAX_RETRIES:
      process.env.OPENAI_COMPATIBLE_MAX_RETRIES ?? process.env.LLM_MAX_RETRIES,
  });

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
      baseUrl: env.OPENAI_COMPATIBLE_BASE_URL.replace(/\/$/, ""),
      ...(env.OPENAI_COMPATIBLE_API_KEY
        ? { apiKey: env.OPENAI_COMPATIBLE_API_KEY }
        : {}),
      model: env.OPENAI_COMPATIBLE_MODEL,
      timeoutMs: env.OPENAI_COMPATIBLE_TIMEOUT_MS,
      maxRetries: env.OPENAI_COMPATIBLE_MAX_RETRIES,
      maxOutputTokens: env.OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS,
      capabilities: {
        structuredOutputMode: env.OPENAI_COMPATIBLE_STRUCTURED_OUTPUT_MODE,
        supportsThinkingControl:
          env.OPENAI_COMPATIBLE_SUPPORTS_THINKING_CONTROL,
        supportsStreaming: env.OPENAI_COMPATIBLE_SUPPORTS_STREAMING,
        ...(env.OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS === undefined
          ? {}
          : {
              maxContextTokens: env.OPENAI_COMPATIBLE_MAX_CONTEXT_TOKENS,
            }),
        maxOutputTokens: env.OPENAI_COMPATIBLE_MAX_OUTPUT_TOKENS,
      },
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
