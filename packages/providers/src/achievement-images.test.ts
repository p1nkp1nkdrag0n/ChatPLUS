import { afterEach, describe, expect, it, vi } from "vitest";
import type { AchievementBadgeVisualSpec } from "@personasim/contracts";
import {
  ImageProviderError,
  normalizeImageBaseUrl,
  RemoteImageGenerationProvider,
  imagePrompt,
} from "./achievement-images.js";
import { createFixtureImageGenerationProvider } from "./image-generation.js";
import * as imageDownloads from "./safe-image-download.js";

const spec: AchievementBadgeVisualSpec = {
  version: "achievement_badge_v1",
  subject: "<灯塔与书页>",
  setting: "雨后的山城",
  motifs: ["翻开的书", "路灯"],
  palette: ["#E8DCC3", "#385152", "#BC8A52"],
  theme: "第一次相遇",
};
const input = {
  visualSpec: spec,
  width: 1_024,
  height: 1_024,
  idempotencyKey: "badge:first_message",
};
const bytes = new Uint8Array([137, 80, 78, 71]);
const base64 = btoa(String.fromCharCode(...bytes));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
function remote(
  request: typeof fetch,
  protocol: "openai-compatible" | "gemini" = "openai-compatible",
  extra: { signal?: AbortSignal; timeoutMs?: number; apiKey?: string } = {},
) {
  return new RemoteImageGenerationProvider({
    settings: {
      protocol,
      baseUrl: "https://images.example.test",
      model: protocol === "gemini" ? "gemini-image" : "gpt-image",
    },
    apiKey: "private-provider-key",
    fetch: request,
    ...extra,
  });
}
function oversizedStream(chunkSize: number, chunks: number) {
  const cancel = vi.fn();
  const chunk = new Uint8Array(chunkSize);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < chunks) controller.enqueue(chunk);
      else controller.close();
    },
    cancel,
  });
  return { response: new Response(body), cancel };
}

afterEach(() => vi.restoreAllMocks());

describe("achievement image providers", () => {
  it.each(["gold", "mother-of-pearl-aurora"] as const)(
    "requests transparent style C wax with %s finish and restrained thematic engraving",
    async (finish) => {
      const v2 = { ...spec, version: "achievement_badge_v2" as const, finish };
      const prompt = imagePrompt({ ...input, visualSpec: v2 });
      expect(prompt).toContain("actual satin sealing wax");
      expect(prompt).toContain("transparent alpha background");
      expect(prompt).toContain("recessed engraving");
      expect(prompt).toContain("Dearvale");
      expect(prompt).toContain(spec.subject);
      expect(prompt).toContain(
        finish === "gold" ? "#C69A4F" : "pink, cyan, violet",
      );
      expect(prompt).not.toContain("enamel medallion");
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ data: [{ b64_json: base64 }] }));
      await remote(request).generate({
        ...input,
        visualSpec: v2,
        idempotencyKey: "badge:test:v2",
      });
      expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
        "idempotency-key": "badge:test:v2",
      });
      expect(
        JSON.parse(request.mock.calls[0]![1]!.body as string),
      ).toMatchObject({ background: "transparent", output_format: "png" });
      const svg = new TextDecoder().decode(
        (
          await createFixtureImageGenerationProvider().generate({
            ...input,
            visualSpec: v2,
          })
        ).bytes,
      );
      expect(svg).not.toContain("<text");
      expect(svg).not.toContain("<rect");
      expect(svg).toContain(
        finish === "gold" ? 'fill="#C69A4F"' : 'fill="url(#aurora)"',
      );
    },
  );

  it("does not send GPT-only transparency fields to a generic image model", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ data: [{ b64_json: base64 }] }));
    const provider = new RemoteImageGenerationProvider({
      settings: {
        protocol: "openai-compatible",
        baseUrl: "https://images.example.test/v1",
        model: "custom-image",
      },
      apiKey: "",
      fetch: request,
    });
    await provider.generate({
      ...input,
      visualSpec: { ...spec, version: "achievement_badge_v2", finish: "gold" },
    });
    const body: unknown = JSON.parse(request.mock.calls[0]![1]!.body as string);
    expect(body).not.toHaveProperty("background");
    expect(body).not.toHaveProperty("output_format");
  });
  it("supports deterministic badge fixtures with XML escaping and bounded dimensions", async () => {
    const provider = createFixtureImageGenerationProvider();
    const first = await provider.generate(input);
    expect(first.bytes).toEqual((await provider.generate(input)).bytes);
    expect(new TextDecoder().decode(first.bytes)).toContain(
      "&lt;灯塔与书页&gt;",
    );
    await expect(
      provider.generate({ ...input, height: 4_097 }),
    ).rejects.toThrow("Image dimensions");
  });

  it("sends the generic OpenAI request and decodes base64 without exposing credentials", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ data: [{ b64_json: base64 }] }));
    const output = await remote(request).generate(input);
    expect(output).toEqual({
      bytes,
      mimeType: "image/png",
      width: 1_024,
      height: 1_024,
    });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://images.example.test/v1/images/generations");
    expect(init?.headers).toMatchObject({
      authorization: "Bearer private-provider-key",
    });
    expect(init?.redirect).toBe("error");
    expect(JSON.parse(init?.body as string)).toMatchObject({
      model: "gpt-image",
      n: 1,
      size: "1024x1024",
    });
    expect(init?.body).not.toContain("private-provider-key");
    expect(init?.body).not.toContain("response_format");
  });

  it("delegates URL downloads to the pinned socket boundary without passing provider credentials", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ data: [{ url: "https://asset.example.test/badge.png" }] }),
      );
    const download = vi
      .spyOn(imageDownloads, "downloadImageAsset")
      .mockResolvedValue({ bytes, contentType: "image/webp; charset=binary" });
    expect((await remote(request).generate(input)).mimeType).toBe("image/webp");
    const [url, options] = download.mock.calls[0]!;
    expect(url).toBe("https://asset.example.test/badge.png");
    expect(options).toMatchObject({
      providerBaseUrl: "https://images.example.test/v1",
      maxBytes: 32 * 1024 * 1024,
    });
    expect(options).not.toHaveProperty("headers");
    expect(JSON.stringify(options)).not.toContain("private-provider-key");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reads Gemini visible inline images while ignoring thought images and text", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        candidates: [
          {
            content: {
              parts: [
                {
                  thought: true,
                  inlineData: {
                    mimeType: "image/png",
                    data: btoa("secret thought"),
                  },
                },
                { text: "Here is your badge" },
                { inline_data: { mime_type: "image/jpeg", data: base64 } },
              ],
            },
          },
        ],
      }),
    );
    expect(await remote(request, "gemini").generate(input)).toMatchObject({
      bytes,
      mimeType: "image/jpeg",
    });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe(
      "https://images.example.test/v1beta/models/gemini-image:generateContent",
    );
    expect(init?.headers).toMatchObject({
      "x-goog-api-key": "private-provider-key",
    });
    expect(init?.headers).not.toHaveProperty("authorization");
    expect(JSON.parse(init?.body as string)).toMatchObject({
      generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
    });
  });

  it.each([
    { protocol: "openai-compatible" as const, value: { data: [] } },
    {
      protocol: "gemini" as const,
      value: {
        candidates: [
          {
            content: {
              parts: [
                { text: "no image" },
                {
                  thought: true,
                  inlineData: { mimeType: "image/png", data: base64 },
                },
              ],
            },
          },
        ],
      },
    },
  ])(
    "rejects missing visible output from $protocol",
    async ({ protocol, value }) => {
      await expect(
        remote(
          vi.fn<typeof fetch>().mockResolvedValue(json(value)),
          protocol,
        ).generate(input),
      ).rejects.toMatchObject({
        code: "image_missing_output",
        retryable: false,
      });
    },
  );

  it.each(["%%%", "A", "abc==", "===="])(
    "rejects invalid base64 %s",
    async (value) => {
      await expect(
        remote(
          vi
            .fn<typeof fetch>()
            .mockResolvedValue(json({ data: [{ b64_json: value }] })),
        ).generate(input),
      ).rejects.toMatchObject({
        code: "image_invalid_base64",
        retryable: false,
      });
    },
  );

  it.each([401, 403, 429, 503, 500])(
    "classifies HTTP %i without copying response text or automatically retrying",
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response("private-provider-key private diagnostic", { status }),
        );
      const expected =
        status === 401 || status === 403
          ? "image_credentials_rejected"
          : status === 429 || status === 503
            ? "image_temporarily_unavailable"
            : "image_provider_rejected";
      await expect(remote(request).generate(input)).rejects.toMatchObject({
        code: expected,
        message: expected,
        retryable: status === 429 || status === 503,
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["file:///etc/passwd", "https://key:secret@asset.example.test/file"])(
    "rejects an unsafe result URL before downloading it",
    async (url) => {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ data: [{ url }] }));
      await expect(remote(request).generate(input)).rejects.toMatchObject({
        code: "image_invalid_url",
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects unsupported MIME and empty downloaded images", async () => {
    const download = vi.spyOn(imageDownloads, "downloadImageAsset");
    for (const [content, type, code] of [
      ["abc", "text/html", "image_unsupported_type"],
      ["", "image/png", "image_invalid_size"],
    ]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          json({ data: [{ url: "https://assets.example.test/file" }] }),
        );
      download.mockResolvedValue({
        bytes: new TextEncoder().encode(content),
        contentType: type!,
      });
      await expect(remote(request).generate(input)).rejects.toMatchObject({
        code,
      });
    }
  });

  it("bounds provider JSON and preserves safe-download size rejections", async () => {
    const raw = oversizedStream(8 * 1024 * 1024, 10);
    await expect(
      remote(vi.fn<typeof fetch>().mockResolvedValue(raw.response)).generate(
        input,
      ),
    ).rejects.toMatchObject({ code: "image_response_too_large" });
    expect(raw.cancel).toHaveBeenCalled();
    vi.spyOn(imageDownloads, "downloadImageAsset").mockRejectedValue(
      new imageDownloads.ImageDownloadError("image_response_too_large"),
    );
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ data: [{ url: "https://assets.example.test/file" }] }),
      );
    await expect(remote(request).generate(input)).rejects.toMatchObject({
      code: "image_response_too_large",
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("treats timeout and caller cancellation as unknown outcomes that must not be auto-retried", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init!.signal!;
          if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
          else
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              {
                once: true,
              },
            );
        }),
    );
    await expect(
      remote(request, "openai-compatible", { timeoutMs: 10 }).generate(input),
    ).rejects.toMatchObject({
      code: "image_outcome_unknown",
      retryable: false,
    });
    await expect(
      remote(request, "openai-compatible", {
        signal: AbortSignal.abort(),
      }).generate(input),
    ).rejects.toMatchObject({
      code: "image_outcome_unknown",
      retryable: false,
    });
  });

  it("does not auto-retry a connection failure after the generation may have been accepted", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("private-key in socket error"));
    await expect(remote(request).generate(input)).rejects.toMatchObject({
      code: "image_request_failed",
      message: "image_request_failed",
      retryable: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("validates dimensions and input before making a billable request", async () => {
    const request = vi.fn<typeof fetch>();
    for (const width of [0, 63, 4_097, 100.5, Number.NaN]) {
      await expect(
        remote(request).generate({ ...input, width }),
      ).rejects.toMatchObject({ code: "image_invalid_dimensions" });
    }
    await expect(
      remote(request).generate({
        ...input,
        visualSpec: { ...spec, palette: ["not a color"] },
      }),
    ).rejects.toBeInstanceOf(ImageProviderError);
    expect(request).not.toHaveBeenCalled();
  });

  it("normalizes endpoints and reports invalid base URLs with a credential-free error", () => {
    expect(
      normalizeImageBaseUrl(
        "https://api.example.test/v1/images/generations/",
        "openai-compatible",
      ),
    ).toBe("https://api.example.test/v1");
    expect(
      normalizeImageBaseUrl(
        "https://api.example.test/v1beta/models/image:generateContent",
        "gemini",
      ),
    ).toBe("https://api.example.test/v1beta");
    for (const url of [
      "not a url",
      "file:///x",
      "https://key:secret@example.test",
      "https://example.test/?key=secret",
      "https://example.test/#key",
    ]) {
      expect(() => normalizeImageBaseUrl(url, "openai-compatible")).toThrow(
        "image_invalid_base_url",
      );
    }
  });
});
