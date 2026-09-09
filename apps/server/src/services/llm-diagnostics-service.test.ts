import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LlmModelSettingsSchema,
  type LlmProtocol,
  type LlmTarget,
} from "@personasim/contracts";
import { ApiError } from "../domain/errors.js";
import { LlmDiagnosticsService } from "./llm-diagnostics-service.js";
import type { ResolvedLlmConfiguration } from "./llm-settings-service.js";

const target: LlmTarget = {
  providerId: "provider-test",
  revision: 7,
  modelId: "chosen-model",
};
function configuration(
  protocol: LlmProtocol = "openai-compatible",
): ResolvedLlmConfiguration {
  return {
    selection: {
      providerId: "provider-test",
      modelId: "chosen-model",
      revision: 7,
    },
    protocol,
    baseUrl: "http://127.0.0.1:9999/v1",
    apiKey: "test-only-secret",
    timeoutMs: 1000,
    model: LlmModelSettingsSchema.parse({ id: "chosen-model" }),
    profileName: "test-profile",
  };
}
function settings(config: ResolvedLlmConfiguration) {
  return {
    resolveTarget: vi.fn(() => config),
    rememberDiscovery: vi.fn(),
    rememberProbe: vi.fn(),
  };
}
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function envelope(protocol: LlmProtocol, text: string): unknown {
  if (protocol === "anthropic")
    return {
      model: "chosen-model",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    };
  if (protocol === "gemini")
    return {
      candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    };
  return { choices: [{ message: { content: text }, finish_reason: "stop" }] };
}
function requestBody(init?: RequestInit): Record<string, unknown> {
  if (typeof init?.body !== "string") throw new TypeError("Expected JSON body");
  return JSON.parse(init.body) as Record<string, unknown>;
}
function twoReplies(protocol: LlmProtocol) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json(envelope(protocol, "你好")))
    .mockResolvedValueOnce(json(envelope(protocol, '{"reply":"连接成功"}')));
}

afterEach(() => vi.restoreAllMocks());

describe("LLM diagnostics through production adapters", () => {
  it.each(["openai-compatible", "anthropic", "gemini"] as const)(
    "%s uses two requests with the same selected model and preserves configured controls",
    async (protocol) => {
      const config = configuration(protocol);
      config.model.capabilities.maxOutputTokens = 512;
      if (protocol === "gemini") config.model.thinkingLevel = "low";
      else {
        config.model.capabilities.reasoningEffort = "high";
        config.model.capabilities.reasoningRequestFormat =
          protocol === "anthropic"
            ? "anthropic_output_config"
            : "openai_reasoning_effort";
      }
      const before = structuredClone(config);
      const storage = settings(config);
      const fetcher = twoReplies(protocol);
      const result = await new LlmDiagnosticsService(storage, fetcher).test(
        target,
      );
      expect(result).toMatchObject({
        status: "success",
        modelId: "chosen-model",
        configRevision: 7,
        text: { status: "success", reply: "你好" },
        structured: { status: "success", reply: "连接成功" },
      });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(storage.rememberProbe).toHaveBeenCalledWith(result);
      expect(config).toEqual(before);
      for (const [, init] of fetcher.mock.calls) {
        const body = requestBody(init);
        if (protocol === "gemini")
          expect(body).toMatchObject({
            generationConfig: {
              maxOutputTokens: 512,
              thinkingConfig: { thinkingLevel: "LOW" },
            },
          });
        else
          expect(body).toMatchObject({
            model: "chosen-model",
            max_tokens: 512,
            ...(protocol === "anthropic"
              ? {
                  thinking: { type: "adaptive" },
                  output_config: { effort: "high" },
                }
              : { reasoning_effort: "high" }),
          });
      }
      expect(
        JSON.stringify(requestBody(fetcher.mock.calls[0]?.[1])),
      ).not.toContain("EXPECTED_JSON_SCHEMA");
      expect(JSON.stringify(requestBody(fetcher.mock.calls[1]?.[1]))).toContain(
        "EXPECTED_JSON_SCHEMA",
      );
    },
  );

  it("uses the legacy environment structured adapter and its actual defaults and output cap", async () => {
    const config = configuration();
    config.legacyConfig = {
      provider: "openai-compatible",
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model.id,
      timeoutMs: 1000,
      maxRetries: 2,
      maxOutputTokens: 192,
    };
    const fetcher = twoReplies("openai-compatible");
    const result = await new LlmDiagnosticsService(
      settings(config),
      fetcher,
    ).test(target);
    expect(result.status).toBe("success");
    const plain = requestBody(fetcher.mock.calls[0]?.[1]);
    const structured = requestBody(fetcher.mock.calls[1]?.[1]);
    expect(plain).toMatchObject({
      max_tokens: 192,
      thinking: { type: "disabled" },
    });
    expect(plain).not.toHaveProperty("response_format");
    expect(structured).toMatchObject({
      max_tokens: 192,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retains the legacy native schema serialization instead of silently using the managed schema converter", async () => {
    const config = configuration();
    config.legacyConfig = {
      provider: "openai-compatible",
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model.id,
      timeoutMs: 1000,
      maxRetries: 2,
      capabilities: {
        structuredOutputMode: "native_schema",
        supportsThinkingControl: false,
        supportsStreaming: false,
      },
    };
    const fetcher = twoReplies("openai-compatible");
    expect(
      (await new LlmDiagnosticsService(settings(config), fetcher).test(target))
        .status,
    ).toBe("success");
    expect(requestBody(fetcher.mock.calls[1]?.[1])).toMatchObject({
      response_format: {
        json_schema: {
          schema: { $schema: "https://json-schema.org/draft/2020-12/schema" },
        },
      },
    });
  });

  it("turns a constructor failure into a failed text stage without sending requests", async () => {
    const config = configuration("gemini");
    config.model.thinkingBudget = 100;
    config.model.thinkingLevel = "low";
    const fetcher = vi.fn<typeof fetch>();
    const result = await new LlmDiagnosticsService(
      settings(config),
      fetcher,
    ).test(target);
    expect(result).toMatchObject({
      status: "failed",
      text: {
        status: "failed",
        errorCode: "INVALID_CONFIGURATION",
        error: expect.stringContaining("参数无效") as unknown,
      },
      structured: { status: "skipped" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports an incompatible structured mode separately after a working text response", async () => {
    const config = configuration("anthropic");
    config.model.capabilities.structuredOutputMode = "json_object";
    const fetcher = twoReplies("anthropic");
    const result = await new LlmDiagnosticsService(
      settings(config),
      fetcher,
    ).test(target);
    expect(result).toMatchObject({
      status: "partial",
      text: { status: "success" },
      structured: { status: "failed", errorCode: "INVALID_CONFIGURATION" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports a JSON validation failure without retrying or falling back", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(envelope("openai-compatible", "你好")))
      .mockResolvedValueOnce(
        json(envelope("openai-compatible", '{"wrong":"test-only-secret"}')),
      );
    const result = await new LlmDiagnosticsService(
      settings(configuration()),
      fetcher,
    ).test(target);
    expect(result).toMatchObject({
      status: "partial",
      text: { status: "success" },
      structured: {
        errorCode: "INVALID_STRUCTURED_OUTPUT",
        error: expect.stringContaining("格式未通过") as unknown,
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("test-only-secret");
  });

  it.each([
    [401, "身份验证"],
    [403, "无权访问"],
    [404, "未找到"],
    [429, "额度不足"],
    [500, "暂时不可用"],
    [503, "暂时不可用"],
  ])("translates HTTP %i and makes no retry", async (status, message) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json(
          {
            error: { message: "test-only-secret and private provider detail" },
          },
          Number(status),
        ),
      );
    const result = await new LlmDiagnosticsService(
      settings(configuration()),
      fetcher,
    ).test(target);
    expect(result).toMatchObject({
      status: "failed",
      text: {
        errorCode: `HTTP_${status}`,
        error: expect.stringContaining(String(message)) as unknown,
      },
      structured: { status: "skipped" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("test-only-secret");
    expect(JSON.stringify(result)).not.toContain("private provider detail");
  });

  it.each([
    [
      {
        choices: [
          {
            message: { content: "", reasoning_content: "private thoughts" },
            finish_reason: "stop",
          },
        ],
      },
      "EMPTY_FINAL_AFTER_REASONING",
      "只返回了思考",
    ],
    [
      {
        choices: [{ message: { content: "partial" }, finish_reason: "length" }],
      },
      "OUTPUT_TRUNCATED",
      "4096",
    ],
  ])(
    "shows a visible failure for unusable model output",
    async (response, errorCode, message) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(response));
      const result = await new LlmDiagnosticsService(
        settings(configuration()),
        fetcher,
      ).test(target);
      expect(result.text).toMatchObject({
        status: "failed",
        errorCode,
        error: expect.stringContaining(String(message)) as unknown,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("private thoughts");
    },
  );

  it("rejects an explicit thinking budget that leaves no final-response budget without silently lowering it", async () => {
    const config = configuration("gemini");
    config.model.thinkingBudget = 4096;
    const fetcher = vi.fn<typeof fetch>();
    const result = await new LlmDiagnosticsService(
      settings(config),
      fetcher,
    ).test(target);
    expect(result.text).toMatchObject({
      status: "failed",
      errorCode: "TEST_BUDGET_EXCEEDED",
      error: expect.stringContaining("最终回复") as unknown,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(config.model.thinkingBudget).toBe(4096);
  });

  it("keeps the explicit 120-second and 4096-token test ceilings", async () => {
    const config = configuration();
    config.timeoutMs = 300000;
    config.model.capabilities.maxOutputTokens = 32000;
    const timer = vi.spyOn(globalThis, "setTimeout");
    const fetcher = twoReplies("openai-compatible");
    await new LlmDiagnosticsService(settings(config), fetcher).test(target);
    expect(timer.mock.calls.map((call) => call[1])).toEqual([120000, 120000]);
    expect(
      fetcher.mock.calls.map((call) => requestBody(call[1])["max_tokens"]),
    ).toEqual([4096, 4096]);
    expect(config.timeoutMs).toBe(300000);
  });

  it("does not persist draft probes", async () => {
    const config = configuration();
    const storage = settings(config);
    const draft: LlmTarget = {
      ...target,
      draft: {
        name: "draft",
        protocol: "openai-compatible",
        baseUrl: config.baseUrl,
        timeoutMs: 1000,
        models: [config.model],
      },
    };
    expect(
      (
        await new LlmDiagnosticsService(
          storage,
          twoReplies("openai-compatible"),
        ).test(draft)
      ).status,
    ).toBe("success");
    expect(storage.rememberProbe).not.toHaveBeenCalled();
  });

  it("cancels the legacy structured stage through the combined signal and does not save a partial result", async () => {
    const config = configuration();
    config.legacyConfig = {
      provider: "openai-compatible",
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model.id,
      timeoutMs: 1000,
      maxRetries: 2,
    };
    const storage = settings(config);
    const controller = new AbortController();
    let started: (() => void) | undefined;
    const structuredStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(envelope("openai-compatible", "你好")))
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new DOMException("cancelled", "AbortError")),
              { once: true },
            );
            started?.();
          }),
      );
    const pending = new LlmDiagnosticsService(storage, fetcher).test(
      target,
      controller.signal,
    );
    await structuredStarted;
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({
      status: "partial",
      text: { status: "success" },
      structured: {
        status: "failed",
        errorCode: "CANCELLED",
        error: "测试已取消",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(storage.rememberProbe).not.toHaveBeenCalled();
  });

  it("does not issue requests or cache results for an already cancelled probe", async () => {
    const storage = settings(configuration());
    const fetcher = vi.fn<typeof fetch>();
    const result = await new LlmDiagnosticsService(storage, fetcher).test(
      target,
      AbortSignal.abort(),
    );
    expect(result.text).toMatchObject({
      errorCode: "CANCELLED",
      error: "测试已取消",
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(storage.rememberProbe).not.toHaveBeenCalled();
  });
});

describe("discovery persistence", () => {
  it("persists clean targets and keeps dirty drafts temporary", async () => {
    const config = configuration();
    const storage = settings(config);
    const fetcher: typeof fetch = () =>
      Promise.resolve(json({ data: [{ id: "detected" }] }));
    const service = new LlmDiagnosticsService(storage, fetcher);
    const result = await service.discover({
      providerId: target.providerId!,
      revision: 7,
    });
    expect(storage.rememberDiscovery).toHaveBeenCalledWith(
      target.providerId,
      7,
      result.models,
      result.discoveredAt,
    );
    storage.rememberDiscovery.mockClear();
    await service.discover({
      ...target,
      draft: {
        name: "draft",
        protocol: "openai-compatible",
        baseUrl: config.baseUrl,
        timeoutMs: 1000,
        models: [],
      },
    });
    expect(storage.rememberDiscovery).not.toHaveBeenCalled();
  });

  it("preserves revision conflicts as 409 instead of relabeling them a network failure", async () => {
    const storage = settings(configuration());
    storage.rememberDiscovery.mockImplementation(() => {
      throw new ApiError(409, "model_configuration_changed", "配置已更新");
    });
    await expect(
      new LlmDiagnosticsService(storage, () =>
        Promise.resolve(json({ data: [] })),
      ).discover(target),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "model_configuration_changed",
    });
  });

  it("uses safe Chinese discovery errors and does not cache a cancelled response", async () => {
    const storage = settings(configuration());
    await expect(
      new LlmDiagnosticsService(storage, () =>
        Promise.resolve(json({ error: "test-only-secret" }, 401)),
      ).discover(target),
    ).rejects.toMatchObject({
      statusCode: 502,
      code: "HTTP_401",
      message: expect.stringContaining("身份验证") as unknown,
    });
    expect(storage.rememberDiscovery).not.toHaveBeenCalled();
    await expect(
      new LlmDiagnosticsService(storage).discover(target, AbortSignal.abort()),
    ).rejects.toMatchObject({ code: "CANCELLED" });
  });
});
