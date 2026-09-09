import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  LlmModelSettingsSchema,
  type LlmProtocol,
} from "@personasim/contracts";
import { createManagedLlmProvider, discoverLlmModels } from "./managed-llm.js";
import { prepareManagedSchema } from "./managed-schema.js";
import { PURPOSE_OUTPUT_SCHEMAS } from "./purpose-schemas.js";
import type { LlmCallMetric } from "./types.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function fetchJson(value: unknown, status = 200): Promise<Response> {
  return Promise.resolve(json(value, status));
}
function requestUrl(value: Parameters<typeof fetch>[0] | undefined): string {
  if (value === undefined) return "";
  return value instanceof Request ? value.url : value.toString();
}
function reply(protocol: LlmProtocol, text: string): unknown {
  if (protocol === "openai-compatible")
    return {
      model: "actual",
      choices: [{ message: { content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    };
  if (protocol === "anthropic")
    return {
      model: "actual",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 3 },
    };
  return {
    modelVersion: "actual",
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 },
  };
}
function body(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string")
    throw new TypeError("Expected a JSON request body");
  return JSON.parse(init.body) as Record<string, unknown>;
}
const input = {
  purpose: "provider_probe",
  system: "Reply briefly.",
  prompt: "Reply OK.",
};

describe("managed LLM production and probe transport", () => {
  it.each(["openai-compatible", "anthropic", "gemini"] as const)(
    "%s performs plain text without JSON instructions and validates structured output",
    async (protocol) => {
      const calls: { url: string; init?: RequestInit }[] = [];
      const metrics: LlmCallMetric[] = [];
      const fetcher: typeof fetch = (url, init) => {
        calls.push({
          url: requestUrl(url),
          ...(init === undefined ? {} : { init }),
        });
        return fetchJson(
          reply(protocol, calls.length === 1 ? "OK" : '{"text":"Ready"}'),
        );
      };
      const provider = createManagedLlmProvider({
        protocol,
        baseUrl: "http://127.0.0.1:9000/api",
        timeoutMs: 1000,
        model: LlmModelSettingsSchema.parse({ id: "test-model" }),
        fetch: fetcher,
        onMetric: (metric) => metrics.push(metric),
        maxRetries: 0,
      });
      expect(await provider.completeText(input)).toBe("OK");
      expect(
        await provider.generateObject({
          ...input,
          schema: z.object({ text: z.string().min(1) }).strict(),
        }),
      ).toEqual({ text: "Ready" });
      expect(JSON.stringify(body(calls[0]?.init))).not.toContain("JSON");
      expect(JSON.stringify(body(calls[1]?.init))).toContain(
        "EXPECTED_JSON_SCHEMA",
      );
      expect(new Headers(calls[0]?.init?.headers).has("authorization")).toBe(
        false,
      );
      expect(new Headers(calls[0]?.init?.headers).has("x-api-key")).toBe(false);
      expect(new Headers(calls[0]?.init?.headers).has("x-goog-api-key")).toBe(
        false,
      );
      expect(calls[0]?.init?.redirect).toBe("error");
      expect(metrics).toHaveLength(2);
      expect(
        metrics.every(
          (metric) =>
            metric.success &&
            metric.inputTokens === 10 &&
            metric.outputTokens === 3 &&
            metric.responseModel === "actual",
        ),
      ).toBe(true);
      const expectedSuffix =
        protocol === "openai-compatible"
          ? "/chat/completions"
          : protocol === "anthropic"
            ? "/messages"
            : "/models/test-model:generateContent";
      expect(calls[0]?.url).toBe(`http://127.0.0.1:9000/api${expectedSuffix}`);
    },
  );

  it("preserves OpenAI compatible auth, max completion tokens and explicit reasoning", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      fetchJson(reply("openai-compatible", "Ready")),
    );
    const provider = createManagedLlmProvider({
      protocol: "openai-compatible",
      baseUrl: "https://provider.invalid/v1/chat/completions/",
      apiKey: "test-token",
      timeoutMs: 1000,
      model: LlmModelSettingsSchema.parse({
        id: "chosen",
        tokenParameter: "max_completion_tokens",
        capabilities: {
          structuredOutputMode: "prompt_json",
          supportsThinkingControl: false,
          supportsStreaming: false,
          reasoningEffort: "high",
          reasoningRequestFormat: "openai_reasoning_effort",
          maxOutputTokens: 16384,
        },
      }),
      fetch: fetcher,
    });
    await provider.completeText(input);
    const request = body(fetcher.mock.calls[0]?.[1]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://provider.invalid/v1/chat/completions",
    );
    expect(request).toMatchObject({
      model: "chosen",
      max_completion_tokens: 16384,
      reasoning_effort: "high",
    });
    expect(request).not.toHaveProperty("max_tokens");
    expect(request).not.toHaveProperty("thinking");
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer test-token");
  });

  it("maps Anthropic native schema, system messages and adaptive effort without exposing thinking", async () => {
    const metrics: LlmCallMetric[] = [];
    const fetcher = vi.fn<typeof fetch>(() =>
      fetchJson({
        model: "actual",
        content: [
          { type: "thinking", thinking: "HIDDEN_SENTINEL" },
          { type: "text", text: '{"text":"ok"}' },
        ],
        stop_reason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
        },
      }),
    );
    const provider = createManagedLlmProvider({
      protocol: "anthropic",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "test-token",
      timeoutMs: 1000,
      model: LlmModelSettingsSchema.parse({
        id: "claude",
        capabilities: {
          structuredOutputMode: "native_schema",
          supportsThinkingControl: false,
          supportsStreaming: false,
          reasoningEffort: "high",
          reasoningRequestFormat: "anthropic_output_config",
        },
      }),
      fetch: fetcher,
      onMetric: (metric) => metrics.push(metric),
    });
    expect(
      await provider.generateObject({
        ...input,
        schema: z.object({ text: z.string().min(1).max(20) }).strict(),
      }),
    ).toEqual({ text: "ok" });
    const request = body(fetcher.mock.calls[0]?.[1]);
    expect(request).toMatchObject({
      system: expect.stringContaining("Reply briefly.") as unknown,
      thinking: { type: "adaptive" },
      output_config: { effort: "high", format: { type: "json_schema" } },
    });
    expect(
      (request["messages"] as { role: string }[]).every(
        (message) => message.role !== "system",
      ),
    ).toBe(true);
    const format = (
      request["output_config"] as {
        format: { schema: { properties: { text: unknown } } };
      }
    ).format;
    expect(format.schema.properties.text).toMatchObject({
      type: "string",
      description: expect.stringContaining("minLength=1") as unknown,
    });
    expect(format.schema.properties.text).not.toHaveProperty("minLength");
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-api-key"),
    ).toBe("test-token");
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("anthropic-version"),
    ).toBe("2023-06-01");
    expect(metrics[0]).toMatchObject({
      inputTokens: 35,
      outputTokens: 4,
      cacheReadTokens: 20,
      cacheWriteTokens: 5,
      cacheReadSource: "usage.cache_read_input_tokens",
    });
    expect(JSON.stringify(metrics)).not.toContain("HIDDEN_SENTINEL");
  });

  it("maps Gemini schema, roles, level and usage, omitting thought parts", async () => {
    const metrics: LlmCallMetric[] = [];
    const fetcher = vi.fn<typeof fetch>(() =>
      fetchJson({
        modelVersion: "actual-gemini",
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: "HIDDEN_SENTINEL" },
                { text: '{"text":"ok"}' },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 8,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 10,
          cachedContentTokenCount: 4,
        },
      }),
    );
    const provider = createManagedLlmProvider({
      protocol: "gemini",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "test-token",
      timeoutMs: 1000,
      model: LlmModelSettingsSchema.parse({
        id: "models/gemini-test",
        thinkingLevel: "low",
        capabilities: {
          structuredOutputMode: "native_schema",
          supportsThinkingControl: false,
          supportsStreaming: false,
        },
      }),
      fetch: fetcher,
      onMetric: (metric) => metrics.push(metric),
    });
    expect(
      await provider.generateObject({
        ...input,
        schema: z.object({ text: z.string() }),
      }),
    ).toEqual({ text: "ok" });
    const request = body(fetcher.mock.calls[0]?.[1]);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://provider.invalid/v1beta/models/gemini-test:generateContent",
    );
    expect(request).toMatchObject({
      systemInstruction: { parts: expect.any(Array) as unknown },
      generationConfig: {
        thinkingConfig: { thinkingLevel: "LOW" },
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object" },
      },
    });
    expect(
      new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-goog-api-key"),
    ).toBe("test-token");
    expect(metrics[0]).toMatchObject({
      inputTokens: 8,
      outputTokens: 13,
      cacheReadTokens: 4,
      cacheReadSource: "usageMetadata.cachedContentTokenCount",
      responseModel: "actual-gemini",
    });
    expect(JSON.stringify(metrics)).not.toContain("HIDDEN_SENTINEL");
  });

  it.each([
    [
      "openai-compatible",
      {
        choices: [
          {
            message: { content: "", reasoning_content: "secret thoughts" },
            finish_reason: "stop",
          },
        ],
      },
      "EMPTY_FINAL_AFTER_REASONING",
    ],
    [
      "anthropic",
      {
        content: [{ type: "thinking", thinking: "secret thoughts" }],
        stop_reason: "end_turn",
      },
      "EMPTY_FINAL_AFTER_REASONING",
    ],
    [
      "gemini",
      {
        candidates: [
          {
            content: { parts: [{ thought: true, text: "secret thoughts" }] },
            finishReason: "STOP",
          },
        ],
      },
      "EMPTY_FINAL_AFTER_REASONING",
    ],
    [
      "openai-compatible",
      {
        choices: [{ message: { content: "partial" }, finish_reason: "length" }],
      },
      "OUTPUT_TRUNCATED",
    ],
    [
      "anthropic",
      { content: [{ type: "text", text: "declined" }], stop_reason: "refusal" },
      "MODEL_REFUSAL",
    ],
    [
      "gemini",
      { promptFeedback: { blockReason: "SAFETY" } },
      "CONTENT_FILTERED",
    ],
    [
      "gemini",
      {
        candidates: [
          {
            content: { parts: [{ text: "partial" }] },
            finishReason: "MAX_TOKENS",
          },
        ],
      },
      "OUTPUT_TRUNCATED",
    ],
  ] as const)(
    "rejects unusable %s output with %s",
    async (protocol, response, code) => {
      const provider = createManagedLlmProvider({
        protocol,
        baseUrl: "https://provider.invalid/v1",
        timeoutMs: 1000,
        model: LlmModelSettingsSchema.parse({ id: "selected" }),
        fetch: () => fetchJson(response),
        maxRetries: 0,
      });
      await expect(provider.completeText(input)).rejects.toMatchObject({
        code,
      });
    },
  );

  it("validates and repairs JSON while retaining a metric for each billed attempt", async () => {
    const metrics: LlmCallMetric[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(reply("anthropic", '{"text":""}')))
      .mockResolvedValueOnce(json(reply("anthropic", '{"text":"fixed"}')));
    const provider = createManagedLlmProvider({
      protocol: "anthropic",
      baseUrl: "https://provider.invalid/v1",
      timeoutMs: 1000,
      model: LlmModelSettingsSchema.parse({ id: "selected" }),
      fetch: fetcher,
      maxRetries: 1,
      onMetric: (metric) => metrics.push(metric),
    });
    expect(
      await provider.generateObject({
        ...input,
        schema: z.object({ text: z.string().min(1) }),
      }),
    ).toEqual({ text: "fixed" });
    expect(JSON.stringify(body(fetcher.mock.calls[1]?.[1]))).toContain(
      "STRUCTURED_OUTPUT_REPAIR",
    );
    expect(metrics.map((metric) => metric.success)).toEqual([false, true]);
    expect(metrics[0]?.logicalCallId).toBe(metrics[1]?.logicalCallId);
    expect(metrics[0]).toMatchObject({
      outputTokens: 3,
      errorCode: "INVALID_STRUCTURED_OUTPUT",
    });
  });

  it("does not silently downgrade an unsupported configuration or retry unauthorized requests", async () => {
    const fetcher = vi.fn<typeof fetch>(() =>
      fetchJson({ error: { message: "test-token" } }, 401),
    );
    const provider = createManagedLlmProvider({
      protocol: "anthropic",
      baseUrl: "https://provider.invalid/v1",
      apiKey: "test-token",
      timeoutMs: 1000,
      model: LlmModelSettingsSchema.parse({ id: "selected" }),
      fetch: fetcher,
    });
    await expect(provider.completeText(input)).rejects.toMatchObject({
      code: "HTTP_401",
      message: "LLM provider returned HTTP 401",
      status: 401,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const incompatible = createManagedLlmProvider({
      protocol: "anthropic",
      baseUrl: "https://provider.invalid/v1",
      timeoutMs: 1000,
      model: LlmModelSettingsSchema.parse({
        id: "selected",
        capabilities: {
          structuredOutputMode: "json_object",
          supportsThinkingControl: false,
          supportsStreaming: false,
        },
      }),
      fetch: fetcher,
    });
    await expect(
      incompatible.generateObject({
        ...input,
        schema: z.object({ text: z.string() }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not infer absent usage as zero and isolates failing metric sinks", async () => {
    const metrics: LlmCallMetric[] = [];
    const provider = createManagedLlmProvider({
      protocol: "openai-compatible",
      baseUrl: "https://provider.invalid/v1",
      timeoutMs: 1000,
      model: LlmModelSettingsSchema.parse({ id: "selected" }),
      fetch: () => fetchJson({ choices: [{ message: { content: "OK" } }] }),
      onMetric: (metric) => {
        metrics.push(metric);
        throw new Error("telemetry failed");
      },
    });
    expect(await provider.completeText(input)).toBe("OK");
    expect(metrics[0]).toMatchObject({
      usageSource: "unavailable",
      success: true,
    });
    expect(metrics[0]).not.toHaveProperty("inputTokens");
  });

  it("cancels a running request without retries", async () => {
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetcher = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(new DOMException("secret network message", "AbortError")),
            { once: true },
          );
          started?.();
        }),
    );
    const provider = createManagedLlmProvider({
      protocol: "gemini",
      baseUrl: "https://provider.invalid/v1beta",
      timeoutMs: 1000,
      model: LlmModelSettingsSchema.parse({ id: "selected" }),
      fetch: fetcher,
      signal: controller.signal,
    });
    const request = provider.completeText(input);
    await began;
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "CANCELLED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("times out through the fetch signal and keeps the error independent of sensitive network details", async () => {
    const fetcher: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("secret-token")),
          { once: true },
        );
      });
    const provider = createManagedLlmProvider({
      protocol: "openai-compatible",
      baseUrl: "https://provider.invalid/v1",
      timeoutMs: 100,
      model: LlmModelSettingsSchema.parse({ id: "selected" }),
      fetch: fetcher,
      maxRetries: 0,
    });
    await expect(provider.completeText(input)).rejects.toMatchObject({
      code: "TIMEOUT",
      message: "LLM request timed out",
    });
  });
});

describe("model discovery", () => {
  it("follows Anthropic pagination and preserves conservative model defaults", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          data: [
            {
              id: "b",
              display_name: "B",
              max_input_tokens: 100000,
              max_tokens: 32000,
            },
          ],
          has_more: true,
          last_id: "cursor",
        }),
      )
      .mockResolvedValueOnce(json({ data: [{ id: "a" }], has_more: false }));
    const result = await discoverLlmModels({
      protocol: "anthropic",
      baseUrl: "https://provider.invalid/v1",
      timeoutMs: 1000,
      fetch: fetcher,
    });
    expect(result.map((model) => model.id)).toEqual(["a", "b"]);
    expect(result[1]).toMatchObject({
      label: "B",
      capabilities: {
        structuredOutputMode: "prompt_json",
        maxContextTokens: 100000,
        maxOutputTokens: 32000,
      },
    });
    expect(requestUrl(fetcher.mock.calls[1]?.[0])).toContain("after_id=cursor");
  });

  it("follows Gemini pagination, removes models/ prefix and filters non-generative models", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          models: [
            {
              name: "models/embed",
              supportedGenerationMethods: ["embedContent"],
            },
            {
              name: "models/gemini-a",
              displayName: "Gemini A",
              supportedGenerationMethods: ["generateContent"],
            },
          ],
          nextPageToken: "next",
        }),
      )
      .mockResolvedValueOnce(
        json({
          models: [
            {
              name: "models/gemini-b",
              supportedGenerationMethods: ["generateContent"],
              inputTokenLimit: 20000,
              outputTokenLimit: 4000,
            },
          ],
        }),
      );
    const result = await discoverLlmModels({
      protocol: "gemini",
      baseUrl: "https://provider.invalid/v1beta",
      apiKey: "test-token",
      timeoutMs: 1000,
      fetch: fetcher,
    });
    expect(result.map((model) => model.id)).toEqual(["gemini-a", "gemini-b"]);
    expect(requestUrl(fetcher.mock.calls[1]?.[0])).toContain("pageToken=next");
    expect(requestUrl(fetcher.mock.calls[0]?.[0])).not.toContain("test-token");
  });

  it("rejects repeated cursors instead of hanging or claiming a complete list", async () => {
    const fetcher: typeof fetch = () =>
      fetchJson({ data: [{ id: "model" }], has_more: true, last_id: "same" });
    await expect(
      discoverLlmModels({
        protocol: "anthropic",
        baseUrl: "https://provider.invalid/v1",
        timeoutMs: 1000,
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE_ENVELOPE" });
  });

  it("does not turn a malformed model catalog or a missing catalog endpoint into success", async () => {
    await expect(
      discoverLlmModels({
        protocol: "openai-compatible",
        baseUrl: "http://localhost:1234/v1",
        timeoutMs: 1000,
        fetch: () => fetchJson({ error: "wrong shape" }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE_ENVELOPE" });
    await expect(
      discoverLlmModels({
        protocol: "openai-compatible",
        baseUrl: "http://localhost:1234/v1",
        timeoutMs: 1000,
        fetch: () => fetchJson({}, 404),
      }),
    ).rejects.toMatchObject({ code: "HTTP_404" });
  });
});

describe("native schema compatibility", () => {
  it("supports all current business schemas without weakening the runtime Zod validators", () => {
    for (const schema of Object.values(PURPOSE_OUTPUT_SCHEMAS)) {
      for (const protocol of [
        "openai-compatible",
        "anthropic",
        "gemini",
      ] as const) {
        expect(() => prepareManagedSchema(schema, protocol)).not.toThrow();
      }
    }
  });

  it("makes OpenAI optional fields nullable on the wire and restores their omission for validation", () => {
    const schema = z
      .object({
        text: z.string(),
        nested: z.object({ tag: z.string().optional() }).optional(),
      })
      .strict();
    const compiled = prepareManagedSchema(schema, "openai-compatible");
    expect(compiled.jsonSchema["required"]).toEqual(["text", "nested"]);
    expect(
      schema.parse(compiled.normalize({ text: "ok", nested: { tag: null } })),
    ).toEqual({ text: "ok", nested: {} });
  });

  it("preserves intentional nulls and uses the matching discriminated union branch", () => {
    const schema = z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("first"),
        value: z.string().nullable().optional(),
      }),
      z.object({ kind: z.literal("second"), value: z.string().optional() }),
    ]);
    const compiled = prepareManagedSchema(schema, "openai-compatible");
    expect(
      schema.parse(compiled.normalize({ kind: "first", value: null })),
    ).toEqual({ kind: "first", value: null });
    expect(
      schema.parse(compiled.normalize({ kind: "second", value: null })),
    ).toEqual({ kind: "second" });
  });
});
