import {
  LlmProviderInputSchema,
  type CharacterInterviewAnswers,
} from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";

const PRIVATE = "synthetic-provider-key-and-private-response";
const ANSWERS: CharacterInterviewAnswers = {
  gender: "女性",
  name: "林澈",
  ageText: "二十多岁",
  worldSetting: "江南的一座小城",
  workOrRole: "古籍修复师",
  personality: "习惯先听别人说完",
};

describe("model errors from character interview compilation", () => {
  let app: PersonaSimApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  async function start(fetchOverride: typeof fetch) {
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        databasePath: ":memory:",
        profile: "lightweight",
        correspondenceMode: "off",
        keepsakeMode: "off",
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "fixture",
          timeoutMs: 1000,
          maxRetries: 0,
        },
      }),
      startScheduler: false,
      logger: false,
      llmObservation: { fetch: fetchOverride },
    });
    const settings = app.personasim.llm.settings!;
    const fixture = settings.catalog().defaultSelection;
    const provider = settings.create(
      LlmProviderInputSchema.parse({
        name: "Synthetic provider",
        protocol: "openai-compatible",
        baseUrl: "https://example.invalid/v1",
        apiKey: PRIVATE,
        models: [{ id: "test-model" }],
      }),
    );
    settings.setDefault({ providerId: provider.id, modelId: "test-model" });
    return { server: app, settings, fixture };
  }

  it("reports truncation safely, creates no partial draft, and allows the same request to succeed on retry", async () => {
    const fetchOverride = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", content: PRIVATE },
              finish_reason: "length",
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const { server, settings, fixture } = await start(fetchOverride);
    const warn = vi.spyOn(server.log, "warn");
    const payload = { answers: ANSWERS, requestId: "retry-compile" };
    const failed = await server.inject({
      method: "POST",
      url: "/api/characters/interview/compile",
      headers: { "x-request-id": "http-truncated" },
      payload,
    });

    expect(fetchOverride).toHaveBeenCalledTimes(1);
    const outboundBody = fetchOverride.mock.calls[0]?.[1]?.body;
    if (typeof outboundBody !== "string")
      throw new Error("Expected a JSON model request body");
    const outbound: unknown = JSON.parse(outboundBody);
    expect(outbound).toMatchObject({ max_tokens: 8192 });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({
      error: {
        code: "llm_output_truncated",
        requestId: "http-truncated",
      },
    });
    expect(
      failed.json<{ error: { message: string } }>().error.message,
    ).toContain("输出 token 上限");
    expect(failed.body).not.toContain(PRIVATE);
    expect(failed.body).not.toContain("internal server error");
    expect(warn).toHaveBeenCalledWith(
      { code: "llm_output_truncated" },
      "model request failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(PRIVATE);
    expect(server.personasim.store.countCharacters()).toBe(0);
    expect(
      server.personasim.store.database
        .prepare("SELECT * FROM character_sources")
        .all(),
    ).toEqual([]);

    settings.setDefault(fixture);
    const retry = await server.inject({
      method: "POST",
      url: "/api/characters/interview/compile",
      payload,
    });
    expect(retry.statusCode, retry.body).toBe(201);
    expect(server.personasim.store.countCharacters()).toBe(1);
  });

  it("distinguishes supplier authentication failure from the app session without exposing the supplier body", async () => {
    const fetchOverride = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(PRIVATE, { status: 401 }));
    const { server } = await start(fetchOverride);
    const failed = await server.inject({
      method: "POST",
      url: "/api/characters/interview/compile",
      payload: { answers: ANSWERS },
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json()).toMatchObject({
      error: {
        code: "llm_authentication_failed",
      },
    });
    expect(
      failed.json<{ error: { message: string } }>().error.message,
    ).toContain("API Key");
    expect(failed.body).not.toContain(PRIVATE);
    expect(server.personasim.store.countCharacters()).toBe(0);
  });
});
