import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createOpenAiCompatibleLlmProvider } from "./openai-compatible-llm.js";
import type { LlmCallMetric } from "./types.js";

const readSource = "usage.prompt_tokens_details.cached_tokens";
const writeSource = "usage.prompt_tokens_details.cache_creation_input_tokens";
const objectInput = {
  purpose: "chat_turn",
  system: "Return JSON.",
  prompt: "PRIVATE_PROMPT_SENTINEL",
  schema: z.object({ ok: z.literal(true) }).strict(),
};

function envelope(usage: unknown, content = '{"ok":true}') {
  return {
    model: "routed-provider-model",
    choices: [{ message: { content }, finish_reason: "stop" }],
    ...(usage === undefined ? {} : { usage }),
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenAI-compatible provider cache metrics", () => {
  it.each([
    {
      name: "missing usage",
      usage: undefined,
      expected: { usageSource: "unavailable" },
    },
    {
      name: "null usage",
      usage: null,
      expected: { usageSource: "unavailable" },
    },
    {
      name: "string usage",
      usage: "invalid",
      expected: { usageSource: "unavailable" },
    },
    {
      name: "array usage",
      usage: [],
      expected: { usageSource: "unavailable" },
    },
    {
      name: "missing cache details",
      usage: { prompt_tokens: 100, completion_tokens: 7 },
      expected: { inputTokens: 100, outputTokens: 7 },
    },
    {
      name: "null cache details",
      usage: { prompt_tokens: 100, prompt_tokens_details: null },
      expected: { inputTokens: 100 },
    },
    {
      name: "array cache details",
      usage: { prompt_tokens_details: [] },
      expected: { usageSource: "provider" },
    },
    {
      name: "unverified protocol fields",
      usage: {
        prompt_tokens: 100,
        cached_tokens: 60,
        cache_read_input_tokens: 60,
        cache_creation_input_tokens: 40,
      },
      expected: { inputTokens: 100 },
    },
    {
      name: "negative counts",
      usage: {
        prompt_tokens_details: {
          cached_tokens: -1,
          cache_creation_input_tokens: -2,
        },
      },
      expected: { usageSource: "provider" },
    },
    {
      name: "fractional counts",
      usage: {
        prompt_tokens_details: {
          cached_tokens: 1.5,
          cache_creation_input_tokens: 0.2,
        },
      },
      expected: { usageSource: "provider" },
    },
    {
      name: "string counts",
      usage: {
        prompt_tokens_details: {
          cached_tokens: "0",
          cache_creation_input_tokens: "2",
        },
      },
      expected: { usageSource: "provider" },
    },
    {
      name: "non-finite and unsafe counts",
      usage: {
        prompt_tokens_details: {
          cached_tokens: Infinity,
          cache_creation_input_tokens: Number.MAX_SAFE_INTEGER + 1,
        },
      },
      expected: { usageSource: "provider" },
    },
    {
      name: "explicit zero",
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: {
          cached_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      expected: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    {
      name: "reported reads and writes",
      usage: {
        prompt_tokens: 100,
        prompt_tokens_details: {
          cached_tokens: 60,
          cache_creation_input_tokens: 32,
        },
      },
      expected: { inputTokens: 100, cacheReadTokens: 60, cacheWriteTokens: 32 },
    },
    {
      name: "valid write with invalid read",
      usage: {
        prompt_tokens_details: {
          cached_tokens: null,
          cache_creation_input_tokens: 32,
        },
      },
      expected: { cacheWriteTokens: 32 },
    },
    {
      name: "valid read with invalid write",
      usage: {
        prompt_tokens_details: {
          cached_tokens: 60,
          cache_creation_input_tokens: false,
        },
      },
      expected: { cacheReadTokens: 60 },
    },
    {
      name: "valid cache fields with malformed base usage",
      usage: {
        prompt_tokens: -100,
        completion_tokens: "7",
        total_tokens: null,
        prompt_tokens_details: {
          cached_tokens: 60,
          cache_creation_input_tokens: 0,
        },
      },
      expected: { cacheReadTokens: 60, cacheWriteTokens: 0 },
    },
  ])(
    "preserves known and unknown fields: $name",
    async ({ usage, expected }) => {
      const metrics: LlmCallMetric[] = [];
      const provider = createOpenAiCompatibleLlmProvider({
        apiKey: "private-test-api-key",
        fetch: () => Promise.resolve(jsonResponse(envelope(usage))),
        maxRetries: 0,
        onMetric: (metric) => metrics.push(metric),
      });

      await expect(provider.generateObject(objectInput)).resolves.toEqual({
        ok: true,
      });
      expect(metrics).toHaveLength(1);
      const metric = metrics[0];
      expect(metric).toMatchObject({ ...expected, success: true });
      for (const field of [
        "inputTokens",
        "outputTokens",
        "cacheReadTokens",
        "cacheWriteTokens",
      ] as const) {
        if (!(field in expected)) expect(metric).not.toHaveProperty(field);
      }
      if ("cacheReadTokens" in expected) {
        expect(metric).toHaveProperty("cacheReadSource", readSource);
      } else {
        expect(metric).not.toHaveProperty("cacheReadSource");
      }
      if ("cacheWriteTokens" in expected) {
        expect(metric).toHaveProperty("cacheWriteSource", writeSource);
      } else {
        expect(metric).not.toHaveProperty("cacheWriteSource");
      }
    },
  );

  it.each([
    {
      name: "schema validation",
      content: '{"ok":false}',
      code: "INVALID_STRUCTURED_OUTPUT",
      status: 200,
    },
    {
      name: "JSON parsing",
      content: "not valid JSON",
      code: "INVALID_STRUCTURED_OUTPUT",
      status: 200,
    },
    {
      name: "envelope validation",
      content: '{"ok":true}',
      code: "INVALID_RESPONSE_ENVELOPE",
      status: 200,
    },
    {
      name: "HTTP rejection",
      content: '{"ok":true}',
      code: "HTTP_ERROR",
      status: 503,
    },
    {
      name: "empty final content",
      content: "",
      code: "EMPTY_RESPONSE",
      status: 200,
    },
  ])(
    "retains cache usage for $name failures and each retry",
    async ({ content, code, status, name }) => {
      const metrics: LlmCallMetric[] = [];
      let attempts = 0;
      const provider = createOpenAiCompatibleLlmProvider({
        apiKey: "private-test-api-key",
        maxRetries: 1,
        retryDelay: () => Promise.resolve(),
        onMetric: (metric) => metrics.push(metric),
        fetch: () => {
          attempts += 1;
          const result = envelope(
            {
              prompt_tokens: 100,
              completion_tokens: attempts,
              prompt_tokens_details: {
                cached_tokens: attempts === 1 ? 0 : 60,
                cache_creation_input_tokens: attempts === 1 ? 60 : 0,
              },
            },
            attempts === 1 ? content : '{"ok":true}',
          );
          if (name === "envelope validation" && attempts === 1)
            result.choices = [];
          return Promise.resolve(
            jsonResponse(
              { ...result, error: "PRIVATE_RESPONSE_SENTINEL" },
              attempts === 1 ? status : 200,
            ),
          );
        },
      });

      await expect(provider.completeStructured(objectInput)).resolves.toEqual({
        ok: true,
      });
      expect(metrics).toHaveLength(2);
      expect(metrics[0]).toMatchObject({
        attempt: 1,
        success: false,
        errorCode: code,
        status,
        inputTokens: 100,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 60,
        cacheReadSource: readSource,
        cacheWriteSource: writeSource,
      });
      expect(metrics[1]).toMatchObject({
        attempt: 2,
        success: true,
        inputTokens: 100,
        outputTokens: 2,
        cacheReadTokens: 60,
        cacheWriteTokens: 0,
        cacheReadSource: readSource,
        cacheWriteSource: writeSource,
      });
      expect(metrics[0]?.logicalCallId).toEqual(expect.any(String));
      expect(metrics[1]?.logicalCallId).toBe(metrics[0]?.logicalCallId);
      expect(JSON.stringify(metrics)).not.toContain("PRIVATE_");
      expect(JSON.stringify(metrics)).not.toContain("private-test-api-key");
    },
  );

  it("retains billed usage when truncation terminates without a retry", async () => {
    const metrics: LlmCallMetric[] = [];
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "private-test-api-key",
      maxRetries: 2,
      onMetric: (metric) => metrics.push(metric),
      fetch: () =>
        Promise.resolve(
          jsonResponse({
            choices: [
              { message: { content: '{"ok":' }, finish_reason: "length" },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 4096,
              prompt_tokens_details: { cached_tokens: 60 },
            },
          }),
        ),
    });

    await expect(provider.generateObject(objectInput)).rejects.toMatchObject({
      code: "OUTPUT_TRUNCATED",
    });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      success: false,
      errorCode: "OUTPUT_TRUNCATED",
      inputTokens: 100,
      outputTokens: 4096,
      cacheReadTokens: 60,
      cacheReadSource: readSource,
    });
  });

  it("does not count local request validation as a physical provider attempt", async () => {
    const metrics: LlmCallMetric[] = [];
    let fetched = false;
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "private-test-api-key",
      capabilities: {
        structuredOutputMode: "native_schema",
        supportsThinkingControl: false,
        supportsStreaming: false,
      },
      onMetric: (metric) => metrics.push(metric),
      fetch: () => {
        fetched = true;
        return Promise.resolve(jsonResponse(envelope(undefined)));
      },
    });

    await expect(
      provider.generateObject({
        ...objectInput,
        schema: z.object({
          ok: z.boolean().transform((value) => String(value)),
        }),
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_RESPONSE_SCHEMA" });
    expect(fetched).toBe(false);
    expect(metrics).toEqual([]);
  });

  it("keeps complete and generate metrics independent and uses only non-streaming requests", async () => {
    const metrics: LlmCallMetric[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    const content = JSON.stringify({
      content: "完成",
      reasonCode: "activity_share",
      reasonSummary: "分享已完成活动",
    });
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "private-test-api-key",
      onMetric: (metric) => metrics.push(metric),
      fetch: (_input, init) => {
        if (typeof init?.body !== "string")
          throw new TypeError("Expected a serialized JSON request body");
        bodies.push(JSON.parse(init.body) as Record<string, unknown>);
        return Promise.resolve(
          jsonResponse(
            envelope(
              {
                prompt_tokens: 100,
                prompt_tokens_details: { cached_tokens: 60 },
              },
              content,
            ),
          ),
        );
      },
    });

    await Promise.all([
      provider.complete({
        purpose: "compose_proactive_message",
        system: "Return JSON.",
        prompt: "Test",
      }),
      provider.generate({ purpose: "compose_proactive_message", payload: {} }),
    ]);
    expect(metrics).toHaveLength(2);
    expect(new Set(metrics.map((metric) => metric.logicalCallId)).size).toBe(2);
    for (const metric of metrics) {
      expect(metric).toMatchObject({
        attempt: 1,
        success: true,
        cacheReadTokens: 60,
        cacheReadSource: readSource,
      });
      expect(metric.logicalCallId).toEqual(expect.any(String));
    }
    for (const body of bodies) {
      expect(body.stream).toBe(false);
      expect(JSON.stringify(body)).not.toContain("cache_control");
      expect(JSON.stringify(body)).not.toContain("cache_creation_input_tokens");
    }
  });
});
