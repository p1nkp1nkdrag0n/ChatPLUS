import type {
  JsonValue,
  LlmCapabilityProfile,
  LlmPurpose,
  ReasoningEffort,
  ReasoningRequestFormat,
  LlmProtocol,
  LlmSelection,
  LlmExecutionSelection,
  LlmProviderView,
} from "@personasim/contracts";
import {
  createFixtureLlmProvider,
  createOpenAiCompatibleLlmProvider,
  createManagedLlmProvider,
  type LlmMetricSink,
  type LlmProvider,
} from "@personasim/providers";
import type { ZodType } from "zod";

import type { ServerConfig } from "../config.js";
import type { DatabaseStore } from "../db/store.js";
import type { Clock } from "../runtime/clock.js";
import type { LlmSettingsService } from "./llm-settings-service.js";

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
const CAPTURED_EXECUTION = Symbol("captured-llm-execution");

export class LlmService {
  private readonly initialProviderName: "fixture" | LlmProtocol;
  private readonly initialProfileName: string;
  private readonly initialModelName: string;
  private readonly initialCapabilities: LlmCapabilityProfile;
  private readonly provider: LlmProvider;
  private logicalCallSequence = 0;
  settings: LlmSettingsService | undefined;
  readonly selection: LlmExecutionSelection | undefined;
  private readonly executions = new Map<string, LlmService>();
  private origin: LlmService | undefined;

  constructor(
    config: ServerConfig["llm"],
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly observation: LlmServiceObservationOptions = {},
    execution?: {
      provider: LlmProvider;
      protocol: LlmProtocol | "fixture";
      selection: LlmExecutionSelection;
    },
  ) {
    this.initialProviderName = execution?.protocol ?? config.provider;
    this.selection = execution?.selection;
    this.initialProfileName =
      config.profileName ??
      (config.provider === "openai-compatible" ? "legacy" : "fixture");
    if (execution) {
      this.provider = execution.provider;
    } else if (config.provider === "openai-compatible") {
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
    this.initialModelName = this.provider.model;
    this.initialCapabilities = this.provider.capabilities;
  }

  private currentView():
    { provider: LlmProviderView; modelId: string } | undefined {
    if (!this.settings) return undefined;
    const catalog = this.settings.catalog();
    const provider = catalog.providers.find(
      (item) => item.id === catalog.defaultSelection.providerId,
    );
    return provider
      ? { provider, modelId: catalog.defaultSelection.modelId }
      : undefined;
  }

  get providerName(): "fixture" | LlmProtocol {
    return this.currentView()?.provider.protocol ?? this.initialProviderName;
  }
  get profileName(): string {
    const view = this.currentView();
    return view
      ? view.provider.id.replace(/^env:/u, "")
      : this.initialProfileName;
  }
  get modelName(): string {
    return this.currentView()?.modelId ?? this.initialModelName;
  }
  get capabilities(): LlmCapabilityProfile {
    const view = this.currentView();
    return (
      view?.provider.models.find((model) => model.id === view.modelId)
        ?.capabilities ?? this.initialCapabilities
    );
  }
  get reasoningEffort(): ReasoningEffort | undefined {
    return this.capabilities.reasoningEffort;
  }
  get reasoningRequestFormat(): ReasoningRequestFormat | undefined {
    return this.capabilities.reasoningRequestFormat;
  }

  captureDefault(): LlmService {
    return this.captureSelection();
  }

  captureSelection(
    selection?: LlmSelection,
    expectedRevision?: number,
  ): LlmService {
    if (!this.settings) return this;
    const resolved = this.settings.resolve(selection, expectedRevision);
    const key = JSON.stringify(resolved.selection);
    const cached = this.executions.get(key);
    if (cached) return cached;
    if (resolved.legacyConfig) {
      const captured = new LlmService(
        resolved.legacyConfig,
        this.store,
        this.clock,
        this.observation,
        {
          provider:
            resolved.protocol === "fixture"
              ? createFixtureLlmProvider()
              : createOpenAiCompatibleLlmProvider({
                  ...resolved.legacyConfig,
                  apiKey: resolved.apiKey,
                  ...(this.observation.fetch === undefined
                    ? {}
                    : { fetch: this.observation.fetch }),
                  ...(this.observation.onMetric === undefined
                    ? {}
                    : { onMetric: this.observation.onMetric }),
                  ...(this.observation.promptDiagnostics === undefined
                    ? {}
                    : {
                        promptDiagnostics: this.observation.promptDiagnostics,
                      }),
                }),
          protocol: resolved.protocol,
          selection: resolved.selection,
        },
      );
      captured.origin = this;
      this.executions.set(key, captured);
      return captured;
    }
    const provider =
      resolved.protocol === "fixture"
        ? createFixtureLlmProvider()
        : createManagedLlmProvider({
            protocol: resolved.protocol,
            baseUrl: resolved.baseUrl,
            apiKey: resolved.apiKey,
            model: resolved.model,
            timeoutMs: resolved.timeoutMs,
            maxRetries: 1,
            ...(this.observation.fetch === undefined
              ? {}
              : { fetch: this.observation.fetch }),
            ...(this.observation.onMetric === undefined
              ? {}
              : { onMetric: this.observation.onMetric }),
          });
    const captured = new LlmService(
      {
        provider:
          resolved.protocol === "fixture" ? "fixture" : "openai-compatible",
        profileName: resolved.profileName,
        model: resolved.model.id,
        baseUrl: resolved.baseUrl,
        apiKey: resolved.apiKey,
        timeoutMs: resolved.timeoutMs,
        maxRetries: 1,
        capabilities: resolved.model.capabilities,
      },
      this.store,
      this.clock,
      this.observation,
      { provider, protocol: resolved.protocol, selection: resolved.selection },
    );
    if (this.executions.size >= 64)
      this.executions.delete(this.executions.keys().next().value!);
    captured.origin = this;
    this.executions.set(key, captured);
    return captured;
  }

  captureSession(
    sessionId: string,
    expected?: LlmExecutionSelection,
  ): LlmService {
    if (expected)
      return this.captureSelection(
        { providerId: expected.providerId, modelId: expected.modelId },
        expected.revision,
      );
    if (!this.settings) return this;
    const session = this.settings.sessionModel(sessionId);
    return this.captureSelection(session.selection ?? undefined);
  }

  async generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
    const execution = (
      input as GenerateObjectInput<T> & { [CAPTURED_EXECUTION]?: LlmService }
    )[CAPTURED_EXECUTION];
    if (execution) return execution.generateCapturedObject(input);
    if (this.origin) {
      const command = { ...input };
      // Preserve the public generation/observation seam while carrying a
      // private, non-serializable binding through decorators of that seam.
      Object.defineProperty(command, CAPTURED_EXECUTION, { value: this });
      return this.origin.generateObject(command);
    }
    if (this.settings)
      return this.captureDefault().generateCapturedObject(input);
    return this.generateCapturedObject(input);
  }

  private async generateCapturedObject<T>(
    input: GenerateObjectInput<T>,
  ): Promise<T> {
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
        ...(this.selection === undefined
          ? this.providerName === "fixture"
            ? { configRevision: 1 }
            : {}
          : { configRevision: this.selection.revision }),
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
