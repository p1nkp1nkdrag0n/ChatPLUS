import type {
  JsonValue,
  LlmCapabilityProfile,
  LlmPurpose,
} from "@personasim/contracts";
import {
  createFixtureLlmProvider,
  createOpenAiCompatibleLlmProvider,
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

export class LlmService {
  readonly providerName: "fixture" | "openai-compatible";
  readonly modelName: string;
  readonly capabilities: LlmCapabilityProfile;
  private readonly provider: LlmProvider;

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
    let success = false;
    let errorCode: string | undefined;
    let outputTokens = 0;
    try {
      const provider = this.fixtureProvider(input);
      const result = await provider.generateObject({
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
      this.store.recordLlmCall({
        ...(input.agentId ? { agentId: input.agentId } : {}),
        purpose: input.purpose,
        provider: this.providerName,
        model: this.modelName,
        inputTokens: approximateTokens(input.system + input.prompt),
        outputTokens,
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
    const fixtures = { [input.purpose]: toJsonValue(input.fixture) } as Partial<
      Record<LlmPurpose, JsonValue>
    >;
    return createFixtureLlmProvider({ fixtures });
  }
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
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
