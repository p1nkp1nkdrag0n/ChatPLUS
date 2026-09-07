import type {
  JsonValue,
  LlmCapabilityProfile,
  LlmPurpose,
  ReasoningEffort,
  ReasoningRequestFormat,
} from "@personasim/contracts";
import {
  createFixtureLlmProvider,
  createOpenAiCompatibleLlmProvider,
  type LlmMetricSink,
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

export type LlmLogicalCallEvent =
  | {
      stage: "started";
      index: number;
      purpose: LlmPurpose;
      agentId?: string;
      system: string;
      prompt: string;
      maxRetries?: number;
      maxOutputTokens?: number;
      createdAtUtc: string;
    }
  | {
      stage: "completed";
      index: number;
      purpose: LlmPurpose;
      agentId?: string;
      success: boolean;
      parsedOutput?: unknown;
      errorCode?: string;
      latencyMs: number;
      completedAtUtc: string;
    };

export interface LlmServiceObservationOptions {
  /** Isolated acceptance runners may meter each physical request at transport. */
  fetch?: typeof fetch;
  onMetric?: LlmMetricSink;
  promptDiagnostics?: boolean;
  onLogicalCall?: (event: LlmLogicalCallEvent) => void;
}

const REDACTED_LETTER_REPLY_OBSERVATION = "[redacted:letter_reply]";

export class LlmService {
  readonly providerName: "fixture" | "openai-compatible";
  readonly profileName: string;
  readonly modelName: string;
  readonly capabilities: LlmCapabilityProfile;
  readonly reasoningEffort: ReasoningEffort | undefined;
  readonly reasoningRequestFormat: ReasoningRequestFormat | undefined;
  private readonly provider: LlmProvider;
  private logicalCallSequence = 0;

  constructor(
    config: ServerConfig["llm"],
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly observation: LlmServiceObservationOptions = {},
  ) {
    this.providerName = config.provider;
    this.profileName =
      config.profileName ??
      (config.provider === "openai-compatible" ? "legacy" : "fixture");
    if (config.provider === "openai-compatible") {
      if (!config.apiKey) {
        const credentialEnvironment = config.profileName
          ? `LLM_PROFILE_${config.profileName.replaceAll("-", "_").toUpperCase()}_API_KEY`
          : "OPENAI_COMPATIBLE_API_KEY";
        throw new LlmServiceError(
          `${credentialEnvironment} is required for the configured provider profile.`,
          "missing_api_key",
        );
      }
      this.provider = createOpenAiCompatibleLlmProvider({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        model: config.model,
        timeoutMs: config.timeoutMs,
        maxRetries: config.maxRetries,
        ...(observation.fetch === undefined
          ? {}
          : { fetch: observation.fetch }),
        ...(observation.promptDiagnostics === undefined
          ? {}
          : { promptDiagnostics: observation.promptDiagnostics }),
        ...(config.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: config.maxOutputTokens }),
        ...(config.capabilities === undefined
          ? {}
          : {
              capabilities: config.capabilities,
            }),
        ...(observation.onMetric === undefined
          ? {}
          : { onMetric: observation.onMetric }),
      });
    } else {
      this.provider = createFixtureLlmProvider();
    }
    this.modelName = this.provider.model;
    this.capabilities = this.provider.capabilities;
    this.reasoningEffort = this.capabilities.reasoningEffort;
    this.reasoningRequestFormat = this.capabilities.reasoningRequestFormat;
  }

  async generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
    const logicalCallIndex = ++this.logicalCallSequence;
    this.emitLogicalCall({
      stage: "started",
      index: logicalCallIndex,
      purpose: input.purpose,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      system:
        input.purpose === "letter_reply"
          ? REDACTED_LETTER_REPLY_OBSERVATION
          : input.system,
      prompt:
        input.purpose === "letter_reply"
          ? REDACTED_LETTER_REPLY_OBSERVATION
          : input.prompt,
      ...(input.maxRetries === undefined
        ? {}
        : { maxRetries: input.maxRetries }),
      ...(input.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.maxOutputTokens }),
      createdAtUtc: this.clock.nowUtc(),
    });
    const startedAt = performance.now();
    let success = false;
    let errorCode: string | undefined;
    let outputTokens = 0;
    let parsedOutput: unknown;
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
      parsedOutput = result;
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
      this.emitLogicalCall({
        stage: "completed",
        index: logicalCallIndex,
        purpose: input.purpose,
        ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
        success,
        ...(parsedOutput === undefined || input.purpose === "letter_reply"
          ? {}
          : { parsedOutput }),
        ...(errorCode === undefined ? {} : { errorCode }),
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        completedAtUtc: this.clock.nowUtc(),
      });
      this.store.recordLlmCall({
        ...(input.agentId ? { agentId: input.agentId } : {}),
        purpose: input.purpose,
        provider: this.providerName,
        providerProfile: this.profileName,
        model: this.modelName,
        ...(this.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: this.reasoningEffort }),
        ...(this.reasoningRequestFormat === undefined
          ? {}
          : { reasoningRequestFormat: this.reasoningRequestFormat }),
        inputTokens: approximateTokens(input.system + input.prompt),
        outputTokens,
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)),
        success,
        ...(errorCode ? { errorCode } : {}),
        createdAtUtc: this.clock.nowUtc(),
      });
    }
  }

  private emitLogicalCall(event: LlmLogicalCallEvent): void {
    try {
      this.observation.onLogicalCall?.(event);
    } catch {
      // Evaluation telemetry must never alter an application turn.
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
