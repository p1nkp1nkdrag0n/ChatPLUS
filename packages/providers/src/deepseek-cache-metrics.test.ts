import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createOpenAiCompatibleLlmProvider } from "./openai-compatible-llm.js";
import type { LlmCallMetric } from "./types.js";

const deepseekSource = "usage.prompt_cache_hit_tokens";
const nestedSource = "usage.prompt_tokens_details.cached_tokens";
const input = {
  purpose: "chat_turn",
  system: "Return JSON.",
  prompt: "Return an object with ok set to true.",
  schema: z.object({ ok: z.literal(true) }).strict(),
};

function response(usage: unknown, content = '{"ok":true}', status = 200) {
  return new Response(
    JSON.stringify({
      model: "deepseek-v4-flash",
      choices: [{ message: { content }, finish_reason: "stop" }],
      usage,
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

describe("DeepSeek cache metrics", () => {
  it.each([
    { name: "missing", value: undefined, expected: undefined },
    { name: "zero", value: 0, expected: 0 },
    { name: "positive", value: 60, expected: 60 },
    { name: "negative", value: -1, expected: undefined },
    { name: "fractional", value: 1.5, expected: undefined },
    { name: "string", value: "60", expected: undefined },
    { name: "null", value: null, expected: undefined },
    { name: "boolean", value: false, expected: undefined },
    { name: "non-finite", value: Infinity, expected: undefined },
    {
      name: "unsafe integer",
      value: Number.MAX_SAFE_INTEGER + 1,
      expected: undefined,
    },
  ])("preserves $name cache reads", async ({ value, expected }) => {
    const metrics: LlmCallMetric[] = [];
    const provider = createOpenAiCompatibleLlmProvider({
      apiKey: "test-key",
      maxRetries: 0,
      onMetric: (metric) => metrics.push(metric),
      fetch: () =>
        Promise.resolve(
          response({
            prompt_tokens: 100,
            completion_tokens: 7,
            prompt_cache_hit_tokens: value,
            prompt_cache_miss_tokens: 40,
          }),
        ),
    });

    await expect(provider.generateObject(input)).resolves.toEqual({ ok: true });
    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({
      success: true,
      usageSource: "provider",
      inputTokens: 100,
      outputTokens: 7,
    });
    if (expected === undefined) {
      expect(metrics[0]).not.toHaveProperty("cacheReadTokens");
      expect(metrics[0]).not.toHaveProperty("cacheReadSource");
    } else {
      expect(metrics[0]).toMatchObject({
        cacheReadTokens: expected,
        cacheReadSource: deepseekSource,
      });
    }
    expect(metrics[0]).not.toHaveProperty("cacheWriteTokens");
    expect(metrics[0]).not.toHaveProperty("cacheWriteSource");
  });

  it.each([
    { nested: 30, expected: 30, source: nestedSource },
    { nested: 0, expected: 0, source: nestedSource },
    { nested: undefined, expected: 60, source: deepseekSource },
    { nested: null, expected: 60, source: deepseekSource },
    { nested: -1, expected: 60, source: deepseekSource },
    { nested: "30", expected: 60, source: deepseekSource },
  ])(
    "uses a single read count when nested alias is $nested",
    async ({ nested, expected, source }) => {
      const metrics: LlmCallMetric[] = [];
      const provider = createOpenAiCompatibleLlmProvider({
        apiKey: "test-key",
        maxRetries: 0,
        onMetric: (metric) => metrics.push(metric),
        fetch: () =>
          Promise.resolve(
            response({
              prompt_tokens: 100,
              prompt_cache_hit_tokens: 60,
              prompt_cache_miss_tokens: 40,
              prompt_tokens_details: { cached_tokens: nested },
            }),
          ),
      });

      await expect(provider.generateObject(input)).resolves.toEqual({
        ok: true,
      });
      expect(metrics).toHaveLength(1);
      expect(metrics[0]).toMatchObject({
        cacheReadTokens: expected,
        cacheReadSource: source,
      });
      expect(metrics[0]).not.toHaveProperty("cacheWriteTokens");
    },
  );

  it.each([
    {
      name: "HTTP",
      content: '{"ok":true}',
      status: 503,
      errorCode: "HTTP_ERROR",
    },
    {
      name: "structured validation",
      content: '{"ok":false}',
      status: 200,
      errorCode: "INVALID_STRUCTURED_OUTPUT",
    },
  ])(
    "retains billed reads on $name failure and retry",
    async ({ content, status, errorCode }) => {
      const metrics: LlmCallMetric[] = [];
      let attempt = 0;
      const provider = createOpenAiCompatibleLlmProvider({
        apiKey: "test-key",
        maxRetries: 1,
        retryDelay: () => Promise.resolve(),
        onMetric: (metric) => metrics.push(metric),
        fetch: () => {
          attempt += 1;
          return Promise.resolve(
            response(
              {
                prompt_tokens: 100,
                completion_tokens: attempt,
                prompt_cache_hit_tokens: attempt === 1 ? 0 : 60,
                prompt_cache_miss_tokens: attempt === 1 ? 100 : 40,
              },
              attempt === 1 ? content : '{"ok":true}',
              attempt === 1 ? status : 200,
            ),
          );
        },
      });

      await expect(provider.generateObject(input)).resolves.toEqual({
        ok: true,
      });
      expect(metrics).toHaveLength(2);
      expect(metrics[0]).toMatchObject({
        attempt: 1,
        success: false,
        errorCode,
        inputTokens: 100,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheReadSource: deepseekSource,
      });
      expect(metrics[1]).toMatchObject({
        attempt: 2,
        success: true,
        inputTokens: 100,
        outputTokens: 2,
        cacheReadTokens: 60,
        cacheReadSource: deepseekSource,
      });
      expect(metrics[0]?.logicalCallId).toEqual(expect.any(String));
      expect(metrics[1]?.logicalCallId).toBe(metrics[0]?.logicalCallId);
      for (const metric of metrics) {
        expect(metric).not.toHaveProperty("cacheWriteTokens");
        expect(metric).not.toHaveProperty("cacheWriteSource");
      }
    },
  );
});
