import { describe, expect, it, vi } from "vitest";

import { LongRunV2Observer } from "./companion-long-run-v2-observer.js";
import {
  providerAccountingMetric,
  summarizeProviderMetrics,
} from "./provider-metrics-summary.js";

describe("LongRunV2Observer", () => {
  it("retains provider call identity and exact input across independent or resumed observers", () => {
    const observed = [
      "provider-call-before-restart",
      "provider-call-after-restart",
    ].flatMap((id) => {
      const observer = new LongRunV2Observer();
      const cursor = observer.cursor();
      observer.onLogicalCall({
        stage: "started",
        index: 1,
        purpose: "chat_turn",
        system: "system",
        prompt: "prompt",
        createdAtUtc: "2026-09-01T01:00:00.000Z",
      });
      observer.onMetric({
        provider: "openai-compatible",
        model: "test",
        purpose: "chat_turn",
        logicalCallId: id,
        attempt: 1,
        latencyMs: 1,
        success: true,
        usageSource: "provider",
        inputTokens: 100,
        cacheReadTokens: 60,
      });
      observer.onLogicalCall({
        stage: "completed",
        index: 1,
        purpose: "chat_turn",
        success: true,
        parsedOutput: { reply: "estimated output" },
        latencyMs: 1,
        completedAtUtc: "2026-09-01T01:00:00.000Z",
      });
      return observer.slice(cursor).providerAttempts;
    });
    expect(observed.map((attempt) => attempt.logicalCallId)).toEqual([
      "logical-call-000001",
      "logical-call-000001",
    ]);
    expect(observed.map((attempt) => attempt.usageSource)).toEqual([
      "estimated",
      "estimated",
    ]);
    const restored = JSON.parse(JSON.stringify(observed)) as typeof observed;
    const summary = summarizeProviderMetrics(
      restored.map(providerAccountingMetric),
    );
    expect(summary).toMatchObject({
      logicalCalls: 2,
      logicalIdUnknownAttempts: 0,
      cacheReadRate: { value: 0.6, inputTokens: 200, includedAttempts: 2 },
    });
    const legacy = { ...restored[0]! };
    delete legacy.providerLogicalCallId;
    expect(
      summarizeProviderMetrics([providerAccountingMetric(legacy)]),
    ).toMatchObject({ logicalCalls: null, logicalIdUnknownAttempts: 1 });
  });
  it("joins logical prompt, raw response and exact Provider metric without headers", async () => {
    const observer = new LongRunV2Observer(() => "2026-09-01T01:00:00.000Z");
    const cursor = observer.cursor();
    observer.onLogicalCall({
      stage: "started",
      index: 1,
      purpose: "chat_turn",
      system: "same system",
      prompt: "same prompt",
      createdAtUtc: "2026-09-01T01:00:00.000Z",
    });
    const delegate = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "provider-model",
          choices: [{ message: { content: "{}" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const wrapped = observer.wrapFetch(delegate);
    await wrapped(
      "https://embedded-user:embedded-password@provider.example/v1/chat/completions?api_key=never-record-query",
      {
        method: "POST",
        headers: { Authorization: "Bearer never-record-this" },
        body: JSON.stringify({ model: "requested-model", messages: [] }),
      },
    );
    observer.onMetric({
      provider: "openai-compatible",
      model: "requested-model",
      responseModel: "provider-model",
      purpose: "chat_turn",
      attempt: 1,
      latencyMs: 42,
      success: true,
      status: 200,
      inputTokens: 12,
      outputTokens: 3,
      usageSource: "provider",
    });
    observer.onLogicalCall({
      stage: "completed",
      index: 1,
      purpose: "chat_turn",
      success: true,
      parsedOutput: { reply: "ok" },
      latencyMs: 42,
      completedAtUtc: "2026-09-01T01:00:00.000Z",
    });

    const result = observer.slice(cursor);
    expect(result.logicalCalls).toHaveLength(1);
    expect(result.logicalCalls[0]?.promptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.providerAttempts[0]).toMatchObject({
      requestUrl: "https://provider.example/v1/chat/completions",
      requestModel: "requested-model",
      responseModel: "provider-model",
      inputTokens: 12,
      rawResponse: { model: "provider-model" },
    });
    expect(JSON.stringify(result)).not.toContain("never-record-this");
    expect(JSON.stringify(result)).not.toContain("embedded-password");
    expect(JSON.stringify(result)).not.toContain("never-record-query");
  });

  it("uses the existing character estimate only when Provider usage is absent", async () => {
    const observer = new LongRunV2Observer(() => "2026-09-01T01:00:00.000Z");
    const cursor = observer.cursor();
    observer.onLogicalCall({
      stage: "started",
      index: 2,
      purpose: "chat_turn",
      system: "system",
      prompt: "请自然回复这句话。",
      createdAtUtc: "2026-09-01T01:00:00.000Z",
    });
    const wrapped = observer.wrapFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: "provider-model",
            choices: [
              {
                message: { content: '{"reply":"你好"}' },
                finish_reason: "stop",
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    await wrapped("https://provider.example/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "requested-model" }),
    });
    observer.onMetric({
      provider: "openai-compatible",
      model: "requested-model",
      purpose: "chat_turn",
      attempt: 1,
      latencyMs: 10,
      success: true,
      status: 200,
      usageSource: "unavailable",
    });
    observer.onLogicalCall({
      stage: "completed",
      index: 2,
      purpose: "chat_turn",
      success: true,
      parsedOutput: { reply: "你好" },
      latencyMs: 10,
      completedAtUtc: "2026-09-01T01:00:00.000Z",
    });

    const attempt = observer.slice(cursor).providerAttempts[0];
    expect(attempt?.usageSource).toBe("estimated");
    expect(typeof attempt?.inputTokens).toBe("number");
    expect(typeof attempt?.outputTokens).toBe("number");
  });

  it("binds physical attempts to distinct same-purpose logical calls", async () => {
    const observer = new LongRunV2Observer(() => "2026-09-01T01:00:00.000Z");
    const cursor = observer.cursor();
    const delegate = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ model: "action-model", choices: [] }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ model: "message-model", choices: [] }), {
          status: 200,
        }),
      );
    const wrapped = observer.wrapFetch(delegate);

    observer.onLogicalCall({
      stage: "started",
      index: 1,
      purpose: "chat_turn",
      system: "action system",
      prompt: "action prompt",
      maxRetries: 2,
      maxOutputTokens: 20_000,
      createdAtUtc: "2026-09-01T01:00:00.000Z",
    });
    await wrapped("https://provider.example/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "action-request" }),
    });
    observer.onMetric({
      provider: "openai-compatible",
      model: "action-request",
      purpose: "chat_turn",
      attempt: 1,
      latencyMs: 11,
      success: true,
    });
    observer.onLogicalCall({
      stage: "completed",
      index: 1,
      purpose: "chat_turn",
      success: true,
      parsedOutput: { phase: "action" },
      latencyMs: 12,
      completedAtUtc: "2026-09-01T01:00:00.000Z",
    });

    observer.onLogicalCall({
      stage: "started",
      index: 1,
      purpose: "chat_turn",
      system: "message system",
      prompt: "message prompt",
      createdAtUtc: "2026-09-01T01:00:00.000Z",
    });
    await wrapped("https://provider.example/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "message-request" }),
    });
    observer.onMetric({
      provider: "openai-compatible",
      model: "message-request",
      purpose: "chat_turn",
      attempt: 1,
      latencyMs: 21,
      success: true,
    });
    observer.onLogicalCall({
      stage: "completed",
      index: 1,
      purpose: "chat_turn",
      success: true,
      parsedOutput: { phase: "message" },
      latencyMs: 22,
      completedAtUtc: "2026-09-01T01:00:00.000Z",
    });

    const slice = observer.slice(cursor);
    expect(slice.logicalCalls.map((call) => call.logicalCallId)).toEqual([
      "logical-call-000001",
      "logical-call-000002",
    ]);
    expect(slice.logicalCalls[0]).toMatchObject({
      maxRetries: 2,
      maxOutputTokens: 20_000,
      latencyMs: 12,
    });
    expect(
      slice.providerAttempts.map((attempt) => ({
        requestModel: attempt.requestModel,
        logicalCallId: attempt.logicalCallId,
      })),
    ).toEqual([
      {
        requestModel: "action-request",
        logicalCallId: "logical-call-000001",
      },
      {
        requestModel: "message-request",
        logicalCallId: "logical-call-000002",
      },
    ]);
  });
});
