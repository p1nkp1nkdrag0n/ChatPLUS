import { AsyncLocalStorage } from "node:async_hooks";

import type {
  JsonValue,
  LlmCapabilityProfile,
  LlmPurpose,
} from "@personasim/contracts";
import {
  createFixtureLlmProvider,
  createOpenAiCompatibleLlmProvider,
  type LlmCallMetric,
  type LlmProvider,
} from "@personasim/providers";
import type { ZodType } from "zod";

import type { ServerConfig } from "../config.js";
import type { DatabaseStore } from "../db/store.js";
import type { Clock } from "../runtime/clock.js";

export class LlmServiceError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "LlmServiceError";
  }
}

export type GenerateObjectInput<T> = {
  purpose: LlmPurpose;
  system: string;
  prompt: string;
  schema: ZodType<T>;
  agentId?: string;
  maxRetries?: number;
  maxOutputTokens?: number;
  fixture?: T;
};

type ProviderUsageAccumulator = {
  inputTokens: number;
  outputTokens: number;
  hasInputTokens: boolean;
  hasOutputTokens: boolean;
  inputUsageAttemptCount: number;
  outputUsageAttemptCount: number;
  attemptCount: number;
  failedAttemptCount: number;
};

export class LlmService {
  readonly providerName: "fixture" | "openai-compatible";
  readonly modelName: string;
  readonly capabilities: LlmCapabilityProfile;
  private readonly provider: LlmProvider;
  private readonly providerUsage =
    new AsyncLocalStorage<ProviderUsageAccumulator>();

  constructor(
    config: ServerConfig["llm"],
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
  ) {
    this.providerName = config.provider;
    if (config.provider === "openai-compatible") {
      if (!config.apiKey) {
        throw new LlmServiceError(
          "OPENAI_COMPATIBLE_API_KEY is required for the configured provider.",
          "missing_api_key",
        );
      }
      this.provider = createOpenAiCompatibleLlmProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        onMetric: (metric) => this.captureProviderMetric(metric),
        ...(config.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: config.maxOutputTokens }),
        ...(config.capabilities === undefined
          ? {}
          : {
              capabilities: config.capabilities,
            }),
      });
    } else {
      this.provider = createFixtureLlmProvider();
    }
    this.modelName = this.provider.model;
    this.capabilities = this.provider.capabilities;
  }

  async generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
    const startedAt = performance.now();
    const providerUsage: ProviderUsageAccumulator = {
      inputTokens: 0,
      outputTokens: 0,
      hasInputTokens: false,
      hasOutputTokens: false,
      inputUsageAttemptCount: 0,
      outputUsageAttemptCount: 0,
      attemptCount: 0,
      failedAttemptCount: 0,
    };
    let providerCallStarted = false;
    let success = false;
    let errorCode: string | undefined;
    let outputTokens = 0;
    try {
      const result = await this.providerUsage.run(providerUsage, async () => {
        const provider = this.fixtureProvider(input);
        providerCallStarted = true;
        return provider.generateObject({
          purpose: input.purpose,
          system: input.system,
          prompt: input.prompt,
          schema: input.schema,
          ...(input.maxRetries === undefined
            ? {}
            : { maxRetries: input.maxRetries }),
          ...(input.maxOutputTokens === undefined
            ? {}
            : { maxOutputTokens: input.maxOutputTokens }),
        });
      });
      success = true;
      outputTokens = approximateTokens(JSON.stringify(result) ?? "");
      return result;
    } catch (error) {
      errorCode = errorCodeFrom(error);
      throw error instanceof Error
        ? error
        : new LlmServiceError(
            "The configured LLM provider failed.",
            errorCode,
            error,
          );
    } finally {
      const attemptCount =
        this.providerName === "openai-compatible"
          ? providerUsage.attemptCount
          : providerCallStarted
            ? 1
            : 0;
      const failedAttemptCount =
        this.providerName === "openai-compatible"
          ? providerUsage.failedAttemptCount
          : providerCallStarted && !success
            ? 1
            : 0;
      this.store.recordLlmCall({
        ...(input.agentId ? { agentId: input.agentId } : {}),
        purpose: input.purpose,
        provider: this.providerName,
        model: this.modelName,
        inputTokens: approximateTokens(input.system + input.prompt),
        outputTokens,
        ...(providerUsage.hasInputTokens
          ? { providerInputTokens: providerUsage.inputTokens }
          : {}),
        ...(providerUsage.hasOutputTokens
          ? { providerOutputTokens: providerUsage.outputTokens }
          : {}),
        usageSource:
          providerUsage.hasInputTokens || providerUsage.hasOutputTokens
            ? "provider"
            : "estimated",
        attemptCount,
        failedAttemptCount,
        providerInputUsageAttemptCount: providerUsage.inputUsageAttemptCount,
        providerOutputUsageAttemptCount: providerUsage.outputUsageAttemptCount,
        attemptTelemetrySource: "exact",
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        success,
        ...(errorCode ? { errorCode } : {}),
        createdAtUtc: this.clock.nowUtc(),
      });
    }
  }

  private fixtureProvider<T>(input: GenerateObjectInput<T>): LlmProvider {
    if (this.providerName !== "fixture" || input.fixture === undefined)
      return this.provider;
    const fixtures = {
      [input.purpose]: fixtureValueForPurpose(input.purpose, input.fixture),
    } as Partial<Record<LlmPurpose, JsonValue>>;
    return createFixtureLlmProvider({ fixtures });
  }

  private captureProviderMetric(metric: LlmCallMetric): void {
    const usage = this.providerUsage.getStore();
    if (usage === undefined) return;
    usage.attemptCount += 1;
    if (!metric.success) usage.failedAttemptCount += 1;
    if (
      metric.inputTokens !== undefined &&
      Number.isSafeInteger(metric.inputTokens) &&
      metric.inputTokens >= 0
    ) {
      usage.inputTokens += metric.inputTokens;
      usage.hasInputTokens = true;
      usage.inputUsageAttemptCount += 1;
    }
    if (
      metric.outputTokens !== undefined &&
      Number.isSafeInteger(metric.outputTokens) &&
      metric.outputTokens >= 0
    ) {
      usage.outputTokens += metric.outputTokens;
      usage.hasOutputTokens = true;
      usage.outputUsageAttemptCount += 1;
    }
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function fixtureValueForPurpose(
  purpose: LlmPurpose,
  value: unknown,
): JsonValue {
  const serialized = toJsonValue(value);
  if (
    purpose === "chat_turn" &&
    (typeof serialized !== "object" ||
      serialized === null ||
      Array.isArray(serialized) ||
      !Object.prototype.hasOwnProperty.call(serialized, "replyDecision"))
  ) {
    throw new LlmServiceError(
      "chat_turn fixture overrides must use the canonical provider envelope.",
      "invalid_fixture_contract",
    );
  }
  return serialized;
}

function errorCodeFrom(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.name : "unknown_error";
}

function approximateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}
