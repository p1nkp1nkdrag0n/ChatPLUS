import { afterEach, describe, expect, it, vi } from "vitest";
import { llmApi } from "./llm";
import { ApiError } from "./types";

describe("model settings transport", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("forwards cancellation and sends credentials only in a JSON request body", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ status: "failed" })));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    await llmApi.test(
      {
        draft: {
          name: "Local",
          protocol: "openai-compatible",
          baseUrl: "http://localhost:8080/v1",
          timeoutMs: 120000,
          apiKey: "draft-secret",
          models: [],
        },
        modelId: "model-a",
      },
      controller.signal,
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/llm/test",
      expect.objectContaining({ signal: controller.signal, method: "POST" }),
    );
    const init = fetch.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toMatchObject({
      draft: { apiKey: "draft-secret" },
      modelId: "model-a",
    });
  });
  it("never exposes a raw provider HTML error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("<html>private-token</html>", { status: 502 }),
        ),
    );
    await expect(llmApi.catalog()).rejects.toMatchObject({
      message: "请求失败（502）",
      code: "HTTP_ERROR",
    });
  });
  it("keeps structured API validation errors and handles empty deletion responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              error: { code: "REVISION_CONFLICT", message: "配置已被更新" },
            }),
            { status: 409 },
          ),
        )
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    await expect(
      llmApi.setDefault({ providerId: "a", modelId: "b" }),
    ).rejects.toBeInstanceOf(ApiError);
    await expect(llmApi.remove("a/b")).resolves.toBeUndefined();
  });
});
