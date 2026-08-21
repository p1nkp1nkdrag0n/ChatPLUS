import {
  LlmCapabilityProfileSchema,
  type JsonValue,
  type LLMChatMessage,
  type LLMRequest,
  type LLMResponse,
  type LlmCapabilityProfile,
  type LlmPurpose,
} from "@personasim/contracts";
import { z, type ZodType } from "zod";

import { parseJsonText, StructuredOutputError } from "./safe-json.js";
import {
  normalizePurposeOutput,
  PURPOSE_OUTPUT_SCHEMAS,
} from "./purpose-schemas.js";
import type {
  CompletionInput,
  GenerateObjectInput,
  LlmCallMetric,
  LlmMetricSink,
  LlmProvider,
} from "./types.js";

const ChatCompletionResponseSchema = z
  .object({
    model: z.string().optional(),
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                content: z.union([
                  z.string(),
                  z.null(),
                  z.array(
                    z
                      .object({
                        type: z.string().optional(),
                        text: z.string().optional(),
                      })
                      .passthrough(),
                  ),
                ]),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type FetchLike = typeof fetch;

export interface OpenAiCompatibleLlmOptions {
  apiKey: string;
  capabilities?: LlmCapabilityProfile;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  maxRetries?: number;
  maxOutputTokens?: number;
  fetch?: FetchLike;
  onMetric?: LlmMetricSink;
  retryDelay?: (milliseconds: number) => Promise<void>;
}

export type OpenAICompatibleLlmOptions = OpenAiCompatibleLlmOptions;

export const DEFAULT_OPENAI_COMPATIBLE_CAPABILITIES: LlmCapabilityProfile = {
  structuredOutputMode: "json_object",
  supportsThinkingControl: true,
  supportsStreaming: false,
  maxOutputTokens: 8_192,
};

export class LlmProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LlmProviderError";
  }
}

export function redactSensitiveText(
  value: string,
  secrets: readonly string[] = [],
): string {
  let safe = value;
  for (const secret of secrets) {
    if (secret !== "") safe = safe.split(secret).join("[REDACTED]");
  }
  return safe
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]");
}

function endpoint(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/u, "");
  if (normalized === "") throw new TypeError("LLM base URL cannot be empty");
  return normalized.endsWith("/chat/completions")
    ? normalized
    : `${normalized}/chat/completions`;
}

function extractContent(
  value: z.infer<
    typeof ChatCompletionResponseSchema
  >["choices"][number]["message"]["content"],
): string {
  if (typeof value === "string") return value;
  if (value === null) return "";
  return value.map((part) => part.text ?? "").join("");
}

function finishReason(
  value: string | null | undefined,
): NonNullable<LLMResponse["finishReason"]> {
  if (value === "length") return "length";
  if (value === "content_filter") return "content_filter";
  if (value === "tool_calls" || value === "tool_call") return "tool_call";
  return "stop";
}

function normalizeRetries(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0)
    throw new TypeError("maxRetries must be a non-negative integer");
  return Math.min(2, value);
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? 60_000;
  if (!Number.isFinite(timeout) || timeout < 100 || timeout > 300_000) {
    throw new TypeError("timeoutMs must be between 100 and 300000");
  }
  return timeout;
}

function normalizeMaxTokens(
  value: number | undefined,
  fallback: number,
): number {
  const tokens = value ?? fallback;
  if (!Number.isInteger(tokens) || tokens < 1)
    throw new TypeError("maxOutputTokens must be positive");
  return Math.min(64_000, tokens);
}

function normalizeCapabilities(
  value: LlmCapabilityProfile | undefined,
): LlmCapabilityProfile {
  return LlmCapabilityProfileSchema.parse(
    value ?? DEFAULT_OPENAI_COMPATIBLE_CAPABILITIES,
  );
}

function responseFormat(
  capabilities: LlmCapabilityProfile,
  purpose: LlmPurpose,
  schema: ZodType<unknown> | undefined,
): Record<string, unknown> | undefined {
  if (capabilities.structuredOutputMode === "prompt_json") return undefined;
  if (capabilities.structuredOutputMode === "json_object") {
    return { type: "json_object" };
  }
  if (schema === undefined) {
    throw new LlmProviderError(
      "Native structured output requires a response schema",
      "MISSING_RESPONSE_SCHEMA",
    );
  }
  let jsonSchema: unknown;
  try {
    jsonSchema = z.toJSONSchema(schema);
  } catch (error) {
    throw new LlmProviderError(
      "The response schema cannot be converted to JSON Schema",
      "UNSUPPORTED_RESPONSE_SCHEMA",
      undefined,
      { cause: error },
    );
  }
  return {
    type: "json_schema",
    json_schema: {
      name: `personasim_${purpose}`,
      strict: true,
      schema: jsonSchema,
    },
  };
}

function isRetryable(error: unknown): boolean {
  if (error instanceof StructuredOutputError) return true;
  if (error instanceof LlmProviderError) {
    if (
      [
        "TIMEOUT",
        "NETWORK_ERROR",
        "INVALID_RESPONSE_ENVELOPE",
        "EMPTY_RESPONSE",
      ].includes(error.code)
    ) {
      return true;
    }
    return (
      error.status === 408 ||
      error.status === 409 ||
      error.status === 429 ||
      (error.status ?? 0) >= 500
    );
  }
  return (
    error instanceof TypeError ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

function safeCode(error: unknown): string {
  if (error instanceof LlmProviderError) return error.code;
  if (error instanceof StructuredOutputError) return error.code;
  if (error instanceof DOMException && error.name === "AbortError")
    return "TIMEOUT";
  return "NETWORK_ERROR";
}

function isEmptyJsonObject(value: JsonValue): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

function repairMessage(issues: readonly string[]): LLMChatMessage {
  const issueLines =
    issues.length === 0
      ? ["- <root>: the previous response was not valid JSON"]
      : issues.slice(0, 12).map((issue) => `- ${issue}`);
  return {
    role: "user",
    content: [
      "STRUCTURED_OUTPUT_REPAIR",
      "The previous response failed validation against the original JSON schema.",
      "Return one complete replacement JSON object only. Do not return a patch, Markdown, commentary, or reasoning.",
      "LATEST_VALIDATION_ISSUES",
      ...issueLines,
    ].join("\n"),
  };
}

function asMessages(
  request: LLMRequest,
  repairIssues?: readonly string[],
): LLMChatMessage[] {
  const jsonInstruction: LLMChatMessage = {
    role: "system",
    content:
      "Return exactly one valid JSON object. Do not include Markdown fences, hidden reasoning, or chain-of-thought.",
  };
  const payload: LLMChatMessage = {
    role: "user",
    content: `INPUT_PAYLOAD_JSON\n${JSON.stringify(request.payload)}\nReturn the requested result as JSON.`,
  };
  const originalMessages = request.messages ?? [];
  const messages = [jsonInstruction, ...originalMessages];
  if (originalMessages.length === 0 || !isEmptyJsonObject(request.payload)) {
    messages.push(payload);
  }
  if (repairIssues !== undefined) messages.push(repairMessage(repairIssues));
  return messages;
}

interface RawCallResult {
  content: string;
  data: JsonValue;
  response: z.infer<typeof ChatCompletionResponseSchema>;
  latencyMs: number;
  status: number;
}

export class OpenAiCompatibleLlmProvider implements LlmProvider {
  readonly name = "openai-compatible";
  readonly model: string;
  readonly capabilities: LlmCapabilityProfile;
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #maxOutputTokens: number;
  readonly #fetch: FetchLike;
  readonly #onMetric: LlmMetricSink | undefined;
  readonly #retryDelay: (milliseconds: number) => Promise<void>;

  constructor(options: OpenAiCompatibleLlmOptions) {
    if (options.apiKey.trim() === "")
      throw new TypeError("LLM API key is required");
    this.capabilities = normalizeCapabilities(options.capabilities);
    this.#apiKey = options.apiKey;
    this.#endpoint = endpoint(options.baseUrl ?? "https://api.deepseek.com");
    this.model = options.model ?? "deepseek-v4-flash";
    this.#timeoutMs = normalizeTimeout(options.timeoutMs);
    this.#maxRetries = normalizeRetries(options.maxRetries, 1);
    this.#maxOutputTokens = Math.min(
      normalizeMaxTokens(options.maxOutputTokens, 8_192),
      normalizeMaxTokens(this.capabilities.maxOutputTokens, 64_000),
    );
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#onMetric = options.onMetric;
    this.#retryDelay =
      options.retryDelay ??
      ((milliseconds) =>
        new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds)));
  }

  #emitMetric(metric: LlmCallMetric): void {
    try {
      this.#onMetric?.(metric);
    } catch {
      // Telemetry must never alter the model call result.
    }
  }

  async #callOnce(
    request: LLMRequest,
    attempt: number,
    schema?: ZodType<unknown>,
    repairIssues?: readonly string[],
  ): Promise<RawCallResult> {
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(
      () => controller.abort(),
      this.#timeoutMs,
    );
    const startedAt = Date.now();
    let status: number | undefined;
    try {
      const structuredFormat = responseFormat(
        this.capabilities,
        request.purpose,
        schema,
      );
      const response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          messages: asMessages(request, repairIssues),
          ...(this.capabilities.supportsThinkingControl
            ? { thinking: { type: "disabled" } }
            : {}),
          ...(structuredFormat === undefined
            ? {}
            : { response_format: structuredFormat }),
          stream: false,
          max_tokens: Math.min(
            normalizeMaxTokens(request.maxOutputTokens, this.#maxOutputTokens),
            this.#maxOutputTokens,
          ),
          ...(request.temperature === undefined
            ? {}
            : { temperature: request.temperature }),
        }),
        signal: controller.signal,
      });
      status = response.status;
      if (!response.ok) {
        // Consume the body, but never place provider details (which may echo input) in errors/logs.
        await response.text().catch(() => "");
        throw new LlmProviderError(
          `LLM request failed with HTTP ${response.status}`,
          "HTTP_ERROR",
          response.status,
        );
      }
      let untrusted: unknown;
      try {
        untrusted = (await response.json()) as unknown;
      } catch (error) {
        throw new LlmProviderError(
          "LLM response was not valid JSON",
          "INVALID_RESPONSE_ENVELOPE",
          status,
          {
            cause: error,
          },
        );
      }
      const envelope = ChatCompletionResponseSchema.safeParse(untrusted);
      if (!envelope.success) {
        throw new LlmProviderError(
          "LLM response did not match the Chat Completions envelope",
          "INVALID_RESPONSE_ENVELOPE",
          status,
        );
      }
      const choice = envelope.data.choices[0];
      if (choice === undefined) {
        throw new LlmProviderError(
          "LLM response contained no choice",
          "EMPTY_RESPONSE",
          status,
        );
      }
      if (choice.finish_reason === "length") {
        throw new LlmProviderError(
          "LLM JSON was truncated at the output token limit",
          "OUTPUT_TRUNCATED",
          status,
        );
      }
      const content = extractContent(choice.message.content).trim();
      if (content === "") {
        throw new LlmProviderError(
          "LLM returned empty content",
          "EMPTY_RESPONSE",
          status,
        );
      }
      const data = parseJsonText(content) as JsonValue;
      const latencyMs = Date.now() - startedAt;
      const usage = envelope.data.usage;
      this.#emitMetric({
        provider: this.name,
        model: this.model,
        purpose: request.purpose,
        attempt,
        latencyMs,
        success: true,
        status,
        ...(usage?.prompt_tokens === undefined
          ? {}
          : { inputTokens: usage.prompt_tokens }),
        ...(usage?.completion_tokens === undefined
          ? {}
          : { outputTokens: usage.completion_tokens }),
      });
      return { content, data, response: envelope.data, latencyMs, status };
    } catch (error) {
      const safeError =
        error instanceof LlmProviderError ||
        error instanceof StructuredOutputError
          ? error
          : error instanceof DOMException && error.name === "AbortError"
            ? new LlmProviderError("LLM request timed out", "TIMEOUT", status, {
                cause: error,
              })
            : new LlmProviderError(
                "LLM network request failed",
                "NETWORK_ERROR",
                status,
                {
                  cause: error,
                },
              );
      this.#emitMetric({
        provider: this.name,
        model: this.model,
        purpose: request.purpose,
        attempt,
        latencyMs: Date.now() - startedAt,
        success: false,
        ...(status === undefined ? {} : { status }),
        errorCode: safeCode(safeError),
      });
      throw safeError;
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  async #request<T>(
    request: LLMRequest,
    schema?: ZodType<T>,
    retryOverride?: number,
  ): Promise<{ value: T | JsonValue; raw: RawCallResult }> {
    const retries = normalizeRetries(retryOverride, this.#maxRetries);
    let lastError: unknown;
    let latestStructuredIssues: readonly string[] | undefined;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const raw = await this.#callOnce(
          request,
          attempt + 1,
          schema,
          latestStructuredIssues,
        );
        if (schema === undefined) return { value: raw.data, raw };
        const parsed = schema.safeParse(
          normalizePurposeOutput(request.purpose, raw.data),
        );
        if (!parsed.success) {
          const issues = parsed.error.issues.slice(0, 12).map((issue) => {
            const path =
              issue.path.length === 0 ? "<root>" : issue.path.join(".");
            return `${path}: ${issue.message}`;
          });
          throw new StructuredOutputError(
            "The model JSON did not match the requested schema",
            issues,
          );
        }
        return { value: parsed.data, raw };
      } catch (error) {
        lastError = error;
        if (error instanceof StructuredOutputError) {
          latestStructuredIssues = error.issues
            .slice(0, 12)
            .map((issue) =>
              redactSensitiveText(issue, [this.#apiKey]).slice(0, 400),
            );
        }
        if (attempt >= retries || !isRetryable(error)) break;
        await this.#retryDelay(125 * (attempt + 1));
      }
    }
    const message = redactSensitiveText(
      lastError instanceof Error
        ? lastError.message
        : "Unknown LLM provider failure",
      [this.#apiKey],
    );
    if (lastError instanceof StructuredOutputError) {
      throw new StructuredOutputError(message, lastError.issues, {
        cause: lastError,
      });
    }
    if (lastError instanceof LlmProviderError) {
      throw new LlmProviderError(message, lastError.code, lastError.status, {
        cause: lastError,
      });
    }
    throw new LlmProviderError(message, "UNKNOWN_ERROR", undefined, {
      cause: lastError,
    });
  }

  async generate(request: LLMRequest): Promise<LLMResponse> {
    const { value, raw } = await this.#request(
      request,
      PURPOSE_OUTPUT_SCHEMAS[request.purpose] as ZodType<JsonValue>,
    );
    const usage = raw.response.usage;
    const inputTokens = usage?.prompt_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? 0;
    return {
      content: raw.content,
      data: value,
      model: raw.response.model ?? this.model,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: Math.max(
          usage?.total_tokens ?? 0,
          inputTokens + outputTokens,
        ),
      },
      finishReason: finishReason(raw.response.choices[0]?.finish_reason),
    };
  }

  async generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
    let schemaDescription = "";
    try {
      schemaDescription = `\nEXPECTED_JSON_SCHEMA\n${JSON.stringify(z.toJSONSchema(input.schema))}`;
    } catch {
      // Runtime validation remains authoritative if a custom Zod transform is not JSON-schema compatible.
    }
    const request: LLMRequest = {
      purpose: input.purpose as LlmPurpose,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: `${input.prompt}${schemaDescription}` },
      ],
      // The prompt is already present in the user message. Keep the payload
      // empty so asMessages does not serialize the same (potentially large)
      // input a second time.
      payload: {},
      ...(input.temperature === undefined
        ? {}
        : { temperature: input.temperature }),
      ...(input.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.maxOutputTokens }),
    };
    const { value } = await this.#request(
      request,
      input.schema,
      input.maxRetries,
    );
    return value as T;
  }

  completeStructured<T>(input: GenerateObjectInput<T>): Promise<T> {
    return this.generateObject(input);
  }

  async complete(input: CompletionInput): Promise<string> {
    const response = await this.generate({
      purpose: input.purpose as LlmPurpose,
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.prompt },
      ],
      payload: {},
      ...(input.temperature === undefined
        ? {}
        : { temperature: input.temperature }),
      ...(input.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.maxOutputTokens }),
    });
    return response.content ?? JSON.stringify(response.data);
  }
}

export function createOpenAiCompatibleLlmProvider(
  options: OpenAiCompatibleLlmOptions,
): OpenAiCompatibleLlmProvider {
  return new OpenAiCompatibleLlmProvider(options);
}

export const createOpenAICompatibleLlmProvider =
  createOpenAiCompatibleLlmProvider;

export function createOpenAiCompatibleLlmProviderFromEnv(
  env: Record<string, string | undefined>,
): OpenAiCompatibleLlmProvider {
  const apiKey = env.LLM_API_KEY;
  if (apiKey === undefined || apiKey.trim() === "") {
    throw new TypeError("LLM_API_KEY is required for the live provider");
  }
  const timeout =
    env.LLM_TIMEOUT_MS === undefined ? undefined : Number(env.LLM_TIMEOUT_MS);
  const retries =
    env.LLM_MAX_RETRIES === undefined ? undefined : Number(env.LLM_MAX_RETRIES);
  const maxTokens =
    env.LLM_MAX_TOKENS === undefined ? undefined : Number(env.LLM_MAX_TOKENS);
  return new OpenAiCompatibleLlmProvider({
    apiKey,
    ...(env.LLM_BASE_URL === undefined ? {} : { baseUrl: env.LLM_BASE_URL }),
    ...(env.LLM_MODEL === undefined ? {} : { model: env.LLM_MODEL }),
    ...(timeout === undefined ? {} : { timeoutMs: timeout }),
    ...(retries === undefined ? {} : { maxRetries: retries }),
    ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }),
  });
}

export const createOpenAICompatibleLlmProviderFromEnv =
  createOpenAiCompatibleLlmProviderFromEnv;
