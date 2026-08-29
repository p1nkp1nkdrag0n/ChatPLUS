import { describe, expect, it, vi } from "vitest";

import { LongRunV2Observer } from "./companion-long-run-v2-observer.js";

describe("LongRunV2Observer", () => {
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
    await wrapped("https://provider.example/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: "Bearer never-record-this" },
      body: JSON.stringify({ model: "requested-model", messages: [] }),
    });
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
      completedAtUtc: "2026-09-01T01:00:00.000Z",
    });

    const result = observer.slice(cursor);
    expect(result.logicalCalls).toHaveLength(1);
    expect(result.logicalCalls[0]?.promptSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.providerAttempts[0]).toMatchObject({
      requestModel: "requested-model",
      responseModel: "provider-model",
      inputTokens: 12,
      rawResponse: { model: "provider-model" },
    });
    expect(JSON.stringify(result)).not.toContain("never-record-this");
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
      completedAtUtc: "2026-09-01T01:00:00.000Z",
    });

    const attempt = observer.slice(cursor).providerAttempts[0];
    expect(attempt?.usageSource).toBe("estimated");
    expect(typeof attempt?.inputTokens).toBe("number");
    expect(typeof attempt?.outputTokens).toBe("number");
  });
});
