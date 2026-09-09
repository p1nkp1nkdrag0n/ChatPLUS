import {
  LlmModelSettingsSchema,
  normalizeLlmBaseUrl,
  type JsonValue,
  type LLMChatMessage,
  type LLMRequest,
  type LLMResponse,
  type LlmModelSettings,
  type LlmProtocol,
  type LlmPurpose,
} from "@personasim/contracts";
import { z, type ZodType } from "zod";
import {
  LlmProviderError,
  redactSensitiveText,
} from "./openai-compatible-llm.js";
import {
  normalizePurposeOutput,
  PURPOSE_OUTPUT_SCHEMAS,
} from "./purpose-schemas.js";
import { parseJsonText, StructuredOutputError } from "./safe-json.js";
import { prepareManagedSchema } from "./managed-schema.js";
import { hasVisibleText } from "./visible-text.js";
import type {
  CompletionInput,
  GenerateObjectInput,
  LlmCallMetric,
  LlmMetricSink,
  LlmProvider,
} from "./types.js";

export interface ManagedLlmConnectionOptions {
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey?: string | undefined;
  timeoutMs: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export interface ManagedLlmOptions extends ManagedLlmConnectionOptions {
  model: LlmModelSettings;
  maxRetries?: number;
  onMetric?: LlmMetricSink;
}

type RecordValue = Record<string, unknown>;
type UsageMetric = Pick<
  LlmCallMetric,
  | "responseModel"
  | "finishReason"
  | "usageSource"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "cacheReadSource"
  | "cacheWriteSource"
>;

function record(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
function strings(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
function first(value: unknown): RecordValue | undefined {
  return Array.isArray(value) ? record(value[0]) : undefined;
}
function connection(options: ManagedLlmConnectionOptions): {
  root: string;
  headers: Record<string, string>;
} {
  if (
    !Number.isFinite(options.timeoutMs) ||
    options.timeoutMs < 100 ||
    options.timeoutMs > 900_000
  )
    throw new TypeError("timeoutMs must be between 100 and 900000");
  const root = normalizeLlmBaseUrl(options.baseUrl, options.protocol);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const key = options.apiKey?.trim();
  if (options.protocol === "anthropic")
    headers["anthropic-version"] = "2023-06-01";
  if (key) {
    if (options.protocol === "openai-compatible")
      headers["Authorization"] = `Bearer ${key}`;
    if (options.protocol === "anthropic") headers["x-api-key"] = key;
    if (options.protocol === "gemini") headers["x-goog-api-key"] = key;
  }
  return { root, headers };
}
function retries(value: number | undefined): number {
  const result = value ?? 1;
  if (!Number.isInteger(result) || result < 0)
    throw new TypeError("maxRetries must be a non-negative integer");
  return Math.min(2, result);
}
function tokens(value: number | undefined): number {
  const result = value ?? 8192;
  if (!Number.isSafeInteger(result) || result < 1)
    throw new TypeError("maxOutputTokens must be a positive integer");
  return Math.min(64_000, result);
}
function safeError(
  error: unknown,
  options: ManagedLlmConnectionOptions,
  timedOut = false,
): LlmProviderError | StructuredOutputError {
  if (options.signal?.aborted)
    return new LlmProviderError("LLM request was cancelled", "CANCELLED");
  if (timedOut) return new LlmProviderError("LLM request timed out", "TIMEOUT");
  if (error instanceof StructuredOutputError)
    return new StructuredOutputError(
      redactSensitiveText(error.message, [options.apiKey ?? ""]),
      error.issues.map((issue) =>
        redactSensitiveText(issue, [options.apiKey ?? ""]).slice(0, 400),
      ),
    );
  if (error instanceof LlmProviderError) return error;
  return new LlmProviderError("LLM network request failed", "NETWORK_ERROR");
}

async function requestJson(
  options: ManagedLlmConnectionOptions,
  url: string,
  body?: RecordValue,
  observeStatus?: (status: number) => void,
): Promise<unknown> {
  const { headers } = connection(options);
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  if (options.signal?.aborted)
    throw new LlmProviderError("LLM request was cancelled", "CANCELLED");
  options.signal?.addEventListener("abort", cancel, { once: true });
  const timer = globalThis.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  try {
    const response = await (options.fetch ?? globalThis.fetch)(url, {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
      // Never forward credentials to a redirect target chosen by a provider.
      redirect: "error",
    });
    controller.signal.throwIfAborted();
    observeStatus?.(response.status);
    if (!response.ok)
      throw new LlmProviderError(
        `LLM provider returned HTTP ${response.status}`,
        `HTTP_${response.status}`,
        response.status,
      );
    try {
      const value: unknown = await response.json();
      controller.signal.throwIfAborted();
      return value;
    } catch {
      throw new LlmProviderError(
        "LLM response was not valid JSON",
        "INVALID_RESPONSE_ENVELOPE",
        response.status,
      );
    }
  } catch (error) {
    throw safeError(error, options, timedOut);
  } finally {
    globalThis.clearTimeout(timer);
    options.signal?.removeEventListener("abort", cancel);
  }
}

function usage(protocol: LlmProtocol, raw: unknown): UsageMetric {
  const envelope = record(raw);
  const values = record(
    envelope?.[protocol === "gemini" ? "usageMetadata" : "usage"],
  );
  const reason =
    protocol === "openai-compatible"
      ? first(envelope?.["choices"])?.["finish_reason"]
      : protocol === "anthropic"
        ? envelope?.["stop_reason"]
        : first(envelope?.["candidates"])?.["finishReason"];
  const model = strings(
    envelope?.[protocol === "gemini" ? "modelVersion" : "model"],
  );
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let cacheReadSource: string | undefined;
  let cacheWriteSource: string | undefined;
  if (protocol === "openai-compatible") {
    inputTokens = count(values?.["prompt_tokens"]);
    outputTokens = count(values?.["completion_tokens"]);
    const details = record(values?.["prompt_tokens_details"]);
    cacheReadTokens = count(details?.["cached_tokens"]);
    cacheReadSource = "usage.prompt_tokens_details.cached_tokens";
    if (cacheReadTokens === undefined) {
      cacheReadTokens = count(values?.["prompt_cache_hit_tokens"]);
      cacheReadSource = "usage.prompt_cache_hit_tokens";
    }
    cacheWriteTokens = count(details?.["cache_creation_input_tokens"]);
    cacheWriteSource =
      "usage.prompt_tokens_details.cache_creation_input_tokens";
  } else if (protocol === "anthropic") {
    inputTokens = count(values?.["input_tokens"]);
    outputTokens = count(values?.["output_tokens"]);
    cacheReadTokens = count(values?.["cache_read_input_tokens"]);
    cacheWriteTokens = count(values?.["cache_creation_input_tokens"]);
    if (inputTokens !== undefined)
      inputTokens += (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0);
    cacheReadSource = "usage.cache_read_input_tokens";
    cacheWriteSource = "usage.cache_creation_input_tokens";
  } else {
    inputTokens = count(values?.["promptTokenCount"]);
    outputTokens = count(values?.["candidatesTokenCount"]);
    if (outputTokens !== undefined)
      outputTokens += count(values?.["thoughtsTokenCount"]) ?? 0;
    cacheReadTokens = count(values?.["cachedContentTokenCount"]);
    cacheReadSource = "usageMetadata.cachedContentTokenCount";
  }
  return {
    usageSource: values === undefined ? "unavailable" : "provider",
    ...(model === undefined ? {} : { responseModel: model }),
    ...(typeof reason === "string" || reason === null
      ? { finishReason: reason }
      : {}),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined
      ? {}
      : { cacheReadTokens, cacheReadSource }),
    ...(cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens, cacheWriteSource: cacheWriteSource! }),
  };
}

function visibleContent(protocol: LlmProtocol, raw: unknown): string {
  const envelope = record(raw);
  let content = "";
  let reasoning = false;
  let reason: unknown;
  if (protocol === "openai-compatible") {
    const choice = first(envelope?.["choices"]);
    const message = record(choice?.["message"]);
    if (!message || !("content" in message))
      throw new LlmProviderError(
        "LLM response did not match the Chat Completions envelope",
        "INVALID_RESPONSE_ENVELOPE",
      );
    const value = message["content"];
    content =
      typeof value === "string"
        ? value
        : Array.isArray(value)
          ? value
              .map((part: unknown) => {
                const block = record(part);
                return block &&
                  [undefined, "text", "output_text"].includes(
                    block["type"] as string | undefined,
                  ) &&
                  typeof block["text"] === "string"
                  ? block["text"]
                  : "";
              })
              .join("")
          : "";
    reasoning = Boolean(
      strings(message["reasoning_content"]) ?? strings(message["reasoning"]),
    );
    reason = choice?.["finish_reason"];
    if (strings(message["refusal"]))
      throw new LlmProviderError(
        "The model refused the request",
        "MODEL_REFUSAL",
      );
  } else if (protocol === "anthropic") {
    if (!Array.isArray(envelope?.["content"]))
      throw new LlmProviderError(
        "LLM response did not match the Messages envelope",
        "INVALID_RESPONSE_ENVELOPE",
      );
    content = envelope["content"]
      .map((part: unknown) => {
        const block = record(part);
        if (
          block?.["type"] === "thinking" ||
          block?.["type"] === "redacted_thinking"
        )
          reasoning = true;
        return block?.["type"] === "text" && typeof block["text"] === "string"
          ? block["text"]
          : "";
      })
      .join("");
    reason = envelope["stop_reason"];
  } else {
    if (strings(record(envelope?.["promptFeedback"])?.["blockReason"]))
      throw new LlmProviderError(
        "The provider blocked the model request",
        "CONTENT_FILTERED",
      );
    const candidate = first(envelope?.["candidates"]);
    if (!candidate)
      throw new LlmProviderError(
        "LLM response contained no candidate",
        "EMPTY_RESPONSE",
      );
    const parts = record(candidate["content"])?.["parts"];
    content = Array.isArray(parts)
      ? parts
          .map((part: unknown) => {
            const block = record(part);
            if (block?.["thought"] === true) {
              reasoning = true;
              return "";
            }
            return typeof block?.["text"] === "string" ? block["text"] : "";
          })
          .join("")
      : "";
    reason = candidate["finishReason"];
  }
  if (["length", "max_tokens", "MAX_TOKENS"].includes(String(reason)))
    throw new LlmProviderError(
      "The model reached the output token limit before completing its reply",
      "OUTPUT_TRUNCATED",
    );
  if (
    [
      "content_filter",
      "SAFETY",
      "RECITATION",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII",
      "IMAGE_SAFETY",
    ].includes(String(reason))
  )
    throw new LlmProviderError(
      "The provider filtered the model reply",
      "CONTENT_FILTERED",
    );
  if (reason === "refusal")
    throw new LlmProviderError(
      "The model refused the request",
      "MODEL_REFUSAL",
    );
  if (
    [
      "tool_calls",
      "tool_call",
      "tool_use",
      "pause_turn",
      "MALFORMED_FUNCTION_CALL",
      "UNEXPECTED_TOOL_CALL",
    ].includes(String(reason))
  )
    throw new LlmProviderError(
      "The model did not return a completed text reply",
      "INCOMPLETE_RESPONSE",
    );
  if (
    typeof reason === "string" &&
    ((protocol === "gemini" && reason !== "STOP") ||
      (protocol === "anthropic" &&
        !["end_turn", "stop_sequence"].includes(reason)))
  )
    throw new LlmProviderError(
      "The model did not finish its reply normally",
      "INCOMPLETE_RESPONSE",
    );
  if (!hasVisibleText(content))
    throw new LlmProviderError(
      reasoning
        ? "The model returned reasoning without a visible final reply"
        : "The model returned empty content",
      reasoning ? "EMPTY_FINAL_AFTER_REASONING" : "EMPTY_RESPONSE",
    );
  return content.trim();
}

function thinking(
  protocol: LlmProtocol,
  model: LlmModelSettings,
  maxOutputTokens?: number,
): RecordValue {
  const capability = model.capabilities;
  const effort = capability.reasoningEffort;
  const format = capability.reasoningRequestFormat;
  if (protocol === "gemini") {
    if (
      effort !== undefined ||
      (model.thinkingBudget !== undefined && model.thinkingLevel !== undefined)
    )
      throw new LlmProviderError(
        "Gemini requires one native thinking level or budget, without a compatible-API reasoning format",
        "INVALID_CONFIGURATION",
      );
    return {
      ...(model.thinkingBudget === undefined
        ? {}
        : { thinkingBudget: model.thinkingBudget }),
      ...(model.thinkingLevel === undefined
        ? {}
        : { thinkingLevel: model.thinkingLevel.toUpperCase() }),
      ...(capability.supportsThinkingControl &&
      model.thinkingBudget === undefined &&
      model.thinkingLevel === undefined
        ? { thinkingBudget: 0 }
        : {}),
    };
  }
  if (protocol === "anthropic" && model.thinkingBudget !== undefined) {
    const budget = model.thinkingBudget;
    if (
      effort !== undefined ||
      model.thinkingLevel !== undefined ||
      !Number.isInteger(budget) ||
      (budget !== 0 && budget < 1024)
    )
      throw new LlmProviderError(
        "Anthropic thinking budget must be zero or at least 1024 tokens, without adaptive effort or a thinking level",
        "INVALID_CONFIGURATION",
      );
    if (maxOutputTokens !== undefined && budget >= maxOutputTokens)
      throw new LlmProviderError(
        "Anthropic thinking budget must be smaller than this request's output token limit to leave room for the final reply",
        "INVALID_CONFIGURATION",
      );
    return {
      thinking:
        budget === 0
          ? { type: "disabled" }
          : { type: "enabled", budget_tokens: budget },
    };
  }
  if (model.thinkingBudget !== undefined || model.thinkingLevel !== undefined)
    throw new LlmProviderError(
      "Native Gemini thinking settings cannot be used with this protocol",
      "INVALID_CONFIGURATION",
    );
  if (effort === undefined)
    return capability.supportsThinkingControl
      ? { thinking: { type: "disabled" } }
      : {};
  if (protocol === "anthropic" && format !== "anthropic_output_config")
    throw new LlmProviderError(
      "Anthropic requires its native reasoning format",
      "INVALID_CONFIGURATION",
    );
  if (format === "anthropic_output_config")
    return { thinking: { type: "adaptive" }, output_config: { effort } };
  return {
    reasoning_effort: effort,
    ...(format === "openai_reasoning_effort_with_thinking"
      ? { thinking: { type: "enabled" } }
      : {}),
  };
}

function modelPath(model: string): string {
  const id = model.replace(/^models\//u, "");
  if (id === "." || id === ".." || id.includes("/")) {
    throw new LlmProviderError(
      "Gemini model IDs must name a model rather than an API path",
      "INVALID_CONFIGURATION",
    );
  }
  return encodeURIComponent(id);
}

function requestBody(
  options: ManagedLlmOptions,
  messages: LLMChatMessage[],
  input: CompletionInput,
  schema?: RecordValue,
): RecordValue {
  const protocol = options.protocol;
  const model = options.model;
  const limit = Math.min(
    tokens(input.maxOutputTokens ?? model.capabilities.maxOutputTokens),
    tokens(model.capabilities.maxOutputTokens),
  );
  const controls = thinking(protocol, model, limit);
  const mode = model.capabilities.structuredOutputMode;
  const structured = schema !== undefined;
  const temperature =
    input.temperature === undefined ? {} : { temperature: input.temperature };
  if (protocol === "openai-compatible")
    return {
      model: model.id,
      messages,
      stream: false,
      [model.tokenParameter]: limit,
      ...controls,
      ...temperature,
      ...(structured && mode === "native_schema"
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: `personasim_${input.purpose.replace(/[^a-z0-9_-]/giu, "_").slice(0, 50)}`,
                strict: true,
                schema,
              },
            },
          }
        : {}),
      ...(structured && mode === "json_object"
        ? { response_format: { type: "json_object" } }
        : {}),
    };
  const systems = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content);
  const turns = messages.filter((message) => message.role !== "system");
  if (protocol === "anthropic") {
    if (structured && mode === "json_object")
      throw new LlmProviderError(
        "Anthropic does not support the JSON object response mode; select prompt JSON or native schema",
        "INVALID_CONFIGURATION",
      );
    return {
      model: model.id,
      messages: turns,
      ...(systems.length ? { system: systems.join("\n\n") } : {}),
      max_tokens: limit,
      stream: false,
      ...controls,
      ...temperature,
      ...(structured && mode === "native_schema"
        ? {
            output_config: {
              ...record(controls["output_config"]),
              format: { type: "json_schema", schema },
            },
          }
        : {}),
    };
  }
  return {
    contents: turns.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: message.content }],
    })),
    ...(systems.length
      ? { systemInstruction: { parts: systems.map((text) => ({ text })) } }
      : {}),
    generationConfig: {
      maxOutputTokens: limit,
      ...temperature,
      ...(Object.keys(controls).length ? { thinkingConfig: controls } : {}),
      ...(structured && mode !== "prompt_json"
        ? { responseMimeType: "application/json" }
        : {}),
      ...(structured && mode === "native_schema"
        ? { responseJsonSchema: schema }
        : {}),
    },
  };
}

const JSON_INSTRUCTION: LLMChatMessage = {
  role: "system",
  content:
    "Return exactly one valid JSON object. Do not include Markdown fences or reasoning.",
};
function retryable(error: LlmProviderError | StructuredOutputError): boolean {
  if (error instanceof StructuredOutputError) return true;
  return (
    [
      "TIMEOUT",
      "NETWORK_ERROR",
      "EMPTY_RESPONSE",
      "EMPTY_FINAL_AFTER_REASONING",
      "INVALID_RESPONSE_ENVELOPE",
    ].includes(error.code) ||
    [408, 409, 429].includes(error.status ?? 0) ||
    (error.status ?? 0) >= 500
  );
}

class ManagedLlmProvider implements LlmProvider {
  readonly name: LlmProtocol;
  readonly model: string;
  readonly capabilities: LlmModelSettings["capabilities"];
  readonly #options: ManagedLlmOptions;
  readonly #endpoint: string;

  constructor(options: ManagedLlmOptions) {
    const model = LlmModelSettingsSchema.parse(options.model);
    this.#options = { ...options, model: structuredClone(model) };
    this.name = options.protocol;
    this.model = model.id;
    this.capabilities = structuredClone(model.capabilities);
    const { root } = connection(options);
    this.#endpoint =
      options.protocol === "openai-compatible"
        ? `${root}/chat/completions`
        : options.protocol === "anthropic"
          ? `${root}/messages`
          : `${root}/models/${modelPath(model.id)}:generateContent`;
    retries(options.maxRetries);
    thinking(options.protocol, model);
  }

  async #run<T>(
    messages: LLMChatMessage[],
    input: CompletionInput,
    schema?: ZodType<T>,
    retryOverride?: number,
  ): Promise<{ content: string; data?: T; metric: UsageMetric }> {
    const options = this.#options;
    const maximumRetries = retries(retryOverride ?? options.maxRetries);
    const logicalCallId = globalThis.crypto.randomUUID();
    const native =
      schema !== undefined &&
      this.capabilities.structuredOutputMode === "native_schema"
        ? prepareManagedSchema(schema, this.name)
        : undefined;
    const normalizedMessages = [...messages];
    let format: RecordValue | undefined;
    if (schema !== undefined) {
      normalizedMessages.unshift(JSON_INSTRUCTION);
      if (native) format = native.jsonSchema;
      else {
        format = {};
        try {
          const firstTurn = normalizedMessages.findIndex(
            (message) => message.role !== "system",
          );
          normalizedMessages.splice(
            firstTurn < 0 ? normalizedMessages.length : firstTurn,
            0,
            {
              role: "user",
              content: `EXPECTED_JSON_SCHEMA\n${JSON.stringify(z.toJSONSchema(schema))}`,
            },
          );
        } catch {
          /* Original Zod validation stays authoritative. */
        }
      }
    }
    let issues: readonly string[] | undefined;
    for (let attempt = 0; ; attempt++) {
      const activeMessages =
        issues === undefined
          ? normalizedMessages
          : [
              ...normalizedMessages,
              {
                role: "user" as const,
                content: `STRUCTURED_OUTPUT_REPAIR\nReturn one complete replacement JSON object, not a patch. Fix these validation issues:\n${issues.join("\n")}`,
              },
            ];
      // Configuration and schema errors are local failures, not physical attempts.
      const body = requestBody(options, activeMessages, input, format);
      let status: number | undefined;
      let raw: unknown;
      let failure: LlmProviderError | StructuredOutputError | undefined;
      const startedAt = Date.now();
      try {
        raw = await requestJson(options, this.#endpoint, body, (value) => {
          status = value;
        });
        const content = visibleContent(this.name, raw);
        const metric = usage(this.name, raw);
        if (schema === undefined) return { content, metric };
        const parsedJson = parseJsonText(content);
        const parsed = schema.safeParse(
          normalizePurposeOutput(
            input.purpose as LlmPurpose,
            native ? native.normalize(parsedJson) : parsedJson,
          ),
        );
        if (!parsed.success)
          throw new StructuredOutputError(
            "The model JSON did not match the requested schema",
            parsed.error.issues
              .slice(0, 12)
              .map(
                (issue) =>
                  `${issue.path.join(".") || "<root>"}: ${issue.message}`,
              ),
          );
        return { content, data: parsed.data, metric };
      } catch (error) {
        failure = safeError(error, options);
        if (failure instanceof StructuredOutputError)
          issues = failure.issues.length
            ? failure.issues
            : ["Return valid JSON only"];
        if (attempt >= maximumRetries || !retryable(failure)) throw failure;
      } finally {
        try {
          options.onMetric?.({
            provider: this.name,
            model: this.model,
            purpose: input.purpose,
            logicalCallId,
            attempt: attempt + 1,
            latencyMs: Math.max(0, Date.now() - startedAt),
            success: failure === undefined,
            ...(status === undefined ? {} : { status }),
            ...usage(this.name, raw),
            ...(failure === undefined ? {} : { errorCode: failure.code }),
          });
        } catch {
          /* Metrics must never alter generation. */
        }
      }
      // Keep retry backoff bounded and cancellable, without retaining abort listeners.
      if (options.signal?.aborted)
        throw new LlmProviderError("LLM request was cancelled", "CANCELLED");
      await new Promise<void>((resolve) =>
        globalThis.setTimeout(resolve, 125 * (attempt + 1)),
      );
    }
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const messages = [...(request.messages ?? [])];
    const payload = record(request.payload);
    if (messages.length === 0 || !payload || Object.keys(payload).length > 0)
      messages.push({
        role: "user",
        content: `INPUT_PAYLOAD_JSON\n${JSON.stringify(request.payload)}\nReturn the requested result as JSON.`,
      });
    const result = await this.#run(
      messages,
      {
        purpose: request.purpose,
        system: "",
        prompt: "",
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
        ...(request.temperature === undefined
          ? {}
          : { temperature: request.temperature }),
      },
      PURPOSE_OUTPUT_SCHEMAS[request.purpose] as ZodType<JsonValue>,
    );
    const input = result.metric.inputTokens;
    const output = result.metric.outputTokens;
    return {
      content: result.content,
      ...(result.data === undefined ? {} : { data: result.data }),
      model: result.metric.responseModel ?? this.model,
      finishReason: "stop",
      ...(input === undefined || output === undefined
        ? {}
        : {
            usage: {
              inputTokens: input,
              outputTokens: output,
              totalTokens: input + output,
            },
          }),
    };
  }

  async generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
    const result = await this.#run(
      [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      input,
      input.schema,
      input.maxRetries,
    );
    return result.data as T;
  }
  completeStructured<T>(input: GenerateObjectInput<T>): Promise<T> {
    return this.generateObject(input);
  }
  async complete(input: CompletionInput): Promise<string> {
    const result = await this.generate({
      purpose: input.purpose as LlmPurpose,
      payload: {},
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      ...(input.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.maxOutputTokens }),
      ...(input.temperature === undefined
        ? {}
        : { temperature: input.temperature }),
    });
    return result.content ?? JSON.stringify(result.data);
  }
  async completeText(input: CompletionInput): Promise<string> {
    return (
      await this.#run(
        [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ].filter((message) => message.content !== "") as LLMChatMessage[],
        input,
      )
    ).content;
  }
}

export function createManagedLlmProvider(
  options: ManagedLlmOptions,
): LlmProvider & { completeText(input: CompletionInput): Promise<string> } {
  return new ManagedLlmProvider(options);
}

export async function discoverLlmModels(
  options: ManagedLlmConnectionOptions,
): Promise<LlmModelSettings[]> {
  const { root } = connection(options);
  const models = new Map<string, LlmModelSettings>();
  let cursor: string | undefined;
  const visited = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const url = new URL(`${root}/models`);
    if (options.protocol === "anthropic") url.searchParams.set("limit", "100");
    if (options.protocol === "gemini") url.searchParams.set("pageSize", "1000");
    if (cursor !== undefined)
      url.searchParams.set(
        options.protocol === "gemini" ? "pageToken" : "after_id",
        cursor,
      );
    const envelope = record(await requestJson(options, url.toString()));
    const items = envelope?.[options.protocol === "gemini" ? "models" : "data"];
    if (!Array.isArray(items))
      throw new LlmProviderError(
        "The model list response had an unexpected format",
        "INVALID_RESPONSE_ENVELOPE",
      );
    for (const item of items) {
      const entry = record(item);
      if (!entry) continue;
      if (
        options.protocol === "gemini" &&
        (!Array.isArray(entry["supportedGenerationMethods"]) ||
          !entry["supportedGenerationMethods"].includes("generateContent"))
      )
        continue;
      const rawId = strings(
        entry[options.protocol === "gemini" ? "name" : "id"],
      );
      if (!rawId) continue;
      const id =
        options.protocol === "gemini" ? rawId.replace(/^models\//u, "") : rawId;
      const label = strings(
        entry[options.protocol === "gemini" ? "displayName" : "display_name"],
      );
      const context = count(
        entry[
          options.protocol === "gemini" ? "inputTokenLimit" : "max_input_tokens"
        ],
      );
      const output = count(
        entry[
          options.protocol === "gemini" ? "outputTokenLimit" : "max_tokens"
        ],
      );
      // Model metadata provides limits, never evidence that replies or JSON work.
      const capabilities = {
        structuredOutputMode: "prompt_json" as const,
        supportsThinkingControl: false,
        supportsStreaming: false,
        maxOutputTokens: Math.min(
          output && output > 0 ? output : 8192,
          context && context > 1 ? context - 1 : 64_000,
          64_000,
        ),
        ...(context && context <= 10_000_000
          ? { maxContextTokens: context }
          : {}),
      };
      const parsed = LlmModelSettingsSchema.safeParse({
        id,
        ...(label === undefined ? {} : { label }),
        capabilities,
      });
      if (parsed.success) models.set(parsed.data.id, parsed.data);
      if (models.size > 2000)
        throw new LlmProviderError(
          "The provider returned more than 2000 models; narrow the provider catalog",
          "MODEL_LIST_TOO_LARGE",
        );
    }
    const next =
      options.protocol === "gemini"
        ? strings(envelope?.["nextPageToken"])
        : options.protocol === "anthropic" && envelope?.["has_more"] === true
          ? strings(envelope["last_id"])
          : undefined;
    if (next === undefined) {
      if (options.protocol === "anthropic" && envelope?.["has_more"] === true)
        throw new LlmProviderError(
          "The model list was missing its pagination cursor",
          "INVALID_RESPONSE_ENVELOPE",
        );
      return [...models.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
    }
    if (visited.has(next))
      throw new LlmProviderError(
        "The model list repeated a pagination cursor",
        "INVALID_RESPONSE_ENVELOPE",
      );
    visited.add(next);
    cursor = next;
  }
  throw new LlmProviderError(
    "The provider model list exceeded the pagination limit",
    "MODEL_LIST_TOO_LARGE",
  );
}
