import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LlmProviderInputSchema,
  type LlmCatalog,
  type LlmProbeResult,
  type LlmProtocol,
  type LlmProviderView,
  type LlmSessionModel,
} from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { FakeClock } from "./runtime/clock.js";
import { LlmDiagnosticsService } from "./services/llm-diagnostics-service.js";
import { llmKeyPath } from "./services/llm-credential-service.js";
import type { ChatTurnResult } from "./services/conversation-service.js";

const NOW = "2026-09-09T00:00:00.000Z";
const SECRET = "synthetic-integration-api-key-never-networked";
const applications = new Set<PersonaSimApp>();
const directories: string[] = [];
const body = <T>(response: { body: string }): T =>
  JSON.parse(response.body) as T;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}
function requestBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string")
    throw new Error("Expected a JSON request body");
  return init.body;
}
function completion(
  text: string,
  protocol: LlmProtocol = "openai-compatible",
  model = "test-model",
): Response {
  if (protocol === "anthropic")
    return json({
      id: "synthetic",
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 3 },
    });
  if (protocol === "gemini")
    return json({
      modelVersion: model,
      candidates: [
        { content: { role: "model", parts: [{ text }] }, finishReason: "STOP" },
      ],
      usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3 },
    });
  return json({
    model,
    choices: [
      { message: { role: "assistant", content: text }, finish_reason: "stop" },
    ],
    usage: { prompt_tokens: 2, completion_tokens: 3 },
  });
}
function providerInput(overrides: Record<string, unknown> = {}) {
  return LlmProviderInputSchema.parse({
    name: "Synthetic provider",
    protocol: "openai-compatible",
    baseUrl: "http://192.168.1.80:8181/v1",
    apiKey: SECRET,
    models: [{ id: "test-model" }],
    ...overrides,
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup(
  fetchOverride: typeof fetch = vi.fn<typeof fetch>(() =>
    Promise.reject(new Error("Unexpected network call")),
  ),
) {
  const root = mkdtempSync(join(tmpdir(), "chatplus-llm-http-"));
  directories.push(root);
  const databasePath = join(root, "app.sqlite");
  const config = readConfig({
    nodeEnv: "test",
    profile: "test",
    databasePath,
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    correspondenceMode: "off",
    keepsakeMode: "off",
    llm: {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1000,
      maxRetries: 0,
    },
  });
  const app = await buildApp({
    config,
    clock: new FakeClock(NOW),
    seedDemo: false,
    startScheduler: false,
    logger: false,
    llmObservation: { fetch: fetchOverride },
  });
  applications.add(app);
  app.personasim.store.database
    .prepare(
      "INSERT INTO characters(id,current_version,status,tier,name,source_type,created_at_utc,updated_at_utc) VALUES('agent-http',1,'published','daily','test','original',?,?)",
    )
    .run(NOW, NOW);
  for (const id of ["session-a", "session-b"])
    app.personasim.store.database
      .prepare(
        "INSERT INTO sessions(id,agent_id,title,created_at_utc,updated_at_utc) VALUES(?,'agent-http','test',?,?)",
      )
      .run(id, NOW, NOW);
  return { app, root, databasePath, config };
}
async function createProvider(
  app: PersonaSimApp,
  overrides: Record<string, unknown> = {},
) {
  const response = await app.inject({
    method: "POST",
    url: "/api/llm/providers",
    payload: providerInput(overrides),
  });
  expect(response.statusCode, response.body).toBe(201);
  expect(response.body).not.toContain(SECRET);
  return body<LlmProviderView>(response);
}
const probe = (app: PersonaSimApp, provider: LlmProviderView) =>
  app.inject({
    method: "POST",
    url: "/api/llm/test",
    payload: {
      providerId: provider.id,
      revision: provider.revision,
      modelId: provider.models[0]!.id,
    },
  });
afterEach(async () => {
  for (const app of applications) await app.close();
  applications.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("LLM settings HTTP contract", () => {
  it("persists CRUD/default/session choices without returning credentials and leaves deleted selections invalid", async () => {
    const fetchOverride = vi.fn<typeof fetch>();
    const { app, databasePath } = await setup(fetchOverride);
    let provider = await createProvider(app);
    expect(existsSync(llmKeyPath(databasePath))).toBe(true);
    const selection = { providerId: provider.id, modelId: "test-model" };
    const defaults = await app.inject({
      method: "PATCH",
      url: "/api/llm/default",
      payload: { selection },
    });
    expect(defaults.statusCode).toBe(200);
    expect(body<LlmCatalog>(defaults).defaultSelection).toEqual(selection);
    const session = await app.inject({
      method: "PATCH",
      url: "/api/sessions/session-a/model",
      payload: { selection },
    });
    expect(session.statusCode).toBe(200);
    expect(body<LlmSessionModel>(session)).toMatchObject({
      selection,
      effective: { ...selection, revision: 1 },
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/llm/providers/${provider.id}`,
      payload: providerInput({
        name: "Edited",
        apiKey: undefined,
        expectedRevision: 1,
      }),
    });
    expect(updated.statusCode).toBe(200);
    provider = body<LlmProviderView>(updated);
    const catalog = await app.inject({
      method: "GET",
      url: "/api/llm/providers",
    });
    expect(catalog.headers["cache-control"]).toBe("no-store");
    expect(catalog.body).not.toContain(SECRET);
    expect(
      body<LlmCatalog>(catalog).providers.find(
        (item) => item.id === provider.id,
      ),
    ).toMatchObject({
      name: "Edited",
      revision: 2,
      referencedSessions: 1,
      hasApiKey: true,
    });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/llm/providers/${provider.id}`,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/llm/default",
          payload: {
            selection: {
              providerId: "fixture",
              modelId: "personasim-fixture-v1",
            },
          },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/llm/providers/${provider.id}`,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      body<LlmSessionModel>(
        await app.inject({
          method: "GET",
          url: "/api/sessions/session-a/model",
        }),
      ),
    ).toMatchObject({ selection, effective: null });
    expect(fetchOverride).not.toHaveBeenCalled();
  });

  it("rejects stale probe and send selections before any remote request", async () => {
    const fetchOverride = vi.fn<typeof fetch>();
    const { app } = await setup(fetchOverride);
    const provider = await createProvider(app);
    await app.inject({
      method: "PATCH",
      url: `/api/llm/providers/${provider.id}`,
      payload: providerInput({ expectedRevision: 1, name: "v2" }),
    });
    const stale = await probe(app, provider);
    expect(stale.statusCode).toBe(409);
    expect(body<{ error: { code: string } }>(stale).error.code).toBe(
      "model_configuration_changed",
    );
    const send = await app.inject({
      method: "POST",
      url: "/api/sessions/session-a/messages",
      payload: {
        agentId: "agent-http",
        clientMessageId: "stale-message",
        text: "你好",
        modelSelection: {
          providerId: provider.id,
          modelId: "test-model",
          revision: 1,
        },
      },
    });
    expect(send.statusCode, send.body).toBe(409);
    expect(body<{ error: { code: string } }>(send).error.code).toBe(
      "model_configuration_changed",
    );
    expect(fetchOverride).not.toHaveBeenCalled();
  });

  it("runs keyless LAN requests without authorization and rejects fixture diagnostics", async () => {
    const fetchOverride = vi.fn<typeof fetch>(() =>
      Promise.resolve(json({ data: [] })),
    );
    const { app, databasePath } = await setup(fetchOverride);
    const provider = await createProvider(app, { apiKey: "", models: [] });
    expect(existsSync(llmKeyPath(databasePath))).toBe(false);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/llm/models/discover",
          payload: { providerId: provider.id, revision: provider.revision },
        })
      ).statusCode,
    ).toBe(200);
    expect(
      new Headers(fetchOverride.mock.calls[0]?.[1]?.headers).has(
        "authorization",
      ),
    ).toBe(false);
    const fixture = await app.inject({
      method: "POST",
      url: "/api/llm/test",
      payload: { providerId: "fixture", modelId: "personasim-fixture-v1" },
    });
    expect(fixture.statusCode).toBe(400);
    expect(fetchOverride).toHaveBeenCalledTimes(1);
  });
});

describe("real-response diagnostics through HTTP", () => {
  it.each(["openai-compatible", "anthropic", "gemini"] as const)(
    "discovers and double-tests %s, redacts previews, and leaves conversation data untouched",
    async (protocol) => {
      let generated = 0;
      const fetchOverride = vi.fn<typeof fetch>((url) => {
        if (
          requestUrl(url).includes("/models") &&
          !requestUrl(url).includes(":generateContent")
        )
          return Promise.resolve(
            json(
              protocol === "gemini"
                ? {
                    models: [
                      {
                        name: "models/test-model",
                        supportedGenerationMethods: ["generateContent"],
                      },
                      {
                        name: "models/embedding",
                        supportedGenerationMethods: ["embedContent"],
                      },
                    ],
                  }
                : { data: [{ id: "test-model" }, { id: "test-model" }] },
            ),
          );
        generated++;
        return Promise.resolve(
          completion(
            generated === 1
              ? `你好 ${SECRET}`
              : JSON.stringify({ reply: `已连接 ${SECRET}` }),
            protocol,
          ),
        );
      });
      const { app } = await setup(fetchOverride);
      const provider = await createProvider(app, { protocol });
      const before = app.personasim.store.tableCounts();
      const discovery = await app.inject({
        method: "POST",
        url: "/api/llm/models/discover",
        payload: { providerId: provider.id, revision: provider.revision },
      });
      expect(discovery.statusCode, discovery.body).toBe(200);
      expect(
        body<{ models: Array<{ id: string }> }>(discovery).models.map(
          (model) => model.id,
        ),
      ).toEqual(["test-model"]);
      const tested = await probe(app, provider);
      expect(tested.statusCode, tested.body).toBe(200);
      const result = body<LlmProbeResult>(tested);
      expect(result).toMatchObject({
        status: "success",
        text: { status: "success" },
        structured: { status: "success" },
      });
      expect(result.text.reply).toContain("你好");
      expect(result.structured.reply).toContain("已连接");
      expect(tested.body).not.toContain(SECRET);
      expect(generated).toBe(2);
      const after = app.personasim.store.tableCounts();
      expect(after.messages).toBe(before.messages);
      expect(after.memories).toBe(before.memories);
      expect(after.llm_calls).toBe(before.llm_calls);
      const latest = await app.inject({
        method: "GET",
        url: `/api/llm/tests?providerId=${provider.id}&modelId=test-model`,
      });
      expect(body<{ result: LlmProbeResult }>(latest).result.status).toBe(
        "success",
      );
      expect(latest.body).not.toContain(SECRET);
      const headers = new Headers(
        fetchOverride.mock.calls.at(-1)?.[1]?.headers,
      );
      expect(
        headers.get(
          protocol === "openai-compatible"
            ? "authorization"
            : protocol === "anthropic"
              ? "x-api-key"
              : "x-goog-api-key",
        ),
      ).toBe(protocol === "openai-compatible" ? `Bearer ${SECRET}` : SECRET);
    },
  );

  it("does not confuse a working model list with a usable selected model", async () => {
    const fetchOverride = vi.fn<typeof fetch>((url) =>
      Promise.resolve(
        requestUrl(url).endsWith("/models")
          ? json({ data: [{ id: "test-model" }] })
          : json({ error: { message: `model absent ${SECRET}` } }, 404),
      ),
    );
    const { app } = await setup(fetchOverride);
    const provider = await createProvider(app);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/llm/models/discover",
          payload: { providerId: provider.id },
        })
      ).statusCode,
    ).toBe(200);
    const response = await probe(app, provider);
    expect(body<LlmProbeResult>(response)).toMatchObject({
      status: "failed",
      text: { status: "failed" },
      structured: { status: "skipped" },
    });
    expect(response.body).not.toContain(SECRET);
    expect(fetchOverride).toHaveBeenCalledTimes(2);
  });

  it("reports partial success when plain text works but the structured response is invalid", async () => {
    const fetchOverride = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(completion("你好"))
      .mockResolvedValueOnce(completion("不是 JSON"));
    const { app } = await setup(fetchOverride);
    const provider = await createProvider(app);
    expect(body<LlmProbeResult>(await probe(app, provider))).toMatchObject({
      status: "partial",
      text: { status: "success", reply: "你好" },
      structured: { status: "failed" },
    });
    expect(fetchOverride).toHaveBeenCalledTimes(2);
  });

  it.each(["empty-body", "empty-content", "thinking-only"])(
    "fails %s without a false-positive reply or automatic retry",
    async (kind) => {
      const fetchOverride = vi.fn<typeof fetch>(() =>
        Promise.resolve(
          kind === "empty-body"
            ? new Response("")
            : json({
                choices: [
                  {
                    message: {
                      content: kind === "empty-content" ? "" : null,
                      ...(kind === "thinking-only"
                        ? { reasoning_content: "hidden thinking" }
                        : {}),
                    },
                    finish_reason: "stop",
                  },
                ],
              }),
        ),
      );
      const { app } = await setup(fetchOverride);
      const provider = await createProvider(app);
      const result = body<LlmProbeResult>(await probe(app, provider));
      expect(result.status).toBe("failed");
      expect(result.text.status).toBe("failed");
      expect(result.text.reply).toBeUndefined();
      expect(result.structured.status).toBe("skipped");
      expect(fetchOverride).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["update", "delete"] as const)(
    "discards a probe result when its provider changes by %s during the request",
    async (change) => {
      const entered = deferred<void>();
      const release = deferred<void>();
      let calls = 0;
      const fetchOverride = vi.fn<typeof fetch>(async () => {
        calls++;
        if (calls === 1) return completion("你好");
        entered.resolve();
        await release.promise;
        return completion('{"reply":"已连接"}');
      });
      const { app } = await setup(fetchOverride);
      const provider = await createProvider(app);
      const pending = probe(app, provider);
      await entered.promise;
      const changed = await app.inject(
        change === "delete"
          ? { method: "DELETE", url: `/api/llm/providers/${provider.id}` }
          : {
              method: "PATCH",
              url: `/api/llm/providers/${provider.id}`,
              payload: providerInput({ expectedRevision: 1, name: "changed" }),
            },
      );
      expect(changed.statusCode).toBe(change === "delete" ? 204 : 200);
      release.resolve();
      const completed = await pending;
      expect(completed.statusCode, completed.body).toBe(200);
      expect(
        app.personasim.llm.settings!.latestProbe(provider.id, "test-model"),
      ).toBeUndefined();
    },
  );

  it("cancels an in-flight transport and neither starts phase two nor saves a result", async () => {
    const entered = deferred<void>();
    const fetchOverride = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
          entered.resolve();
        }),
    );
    const { app } = await setup(fetchOverride);
    const provider = await createProvider(app);
    const controller = new AbortController();
    const diagnostics = new LlmDiagnosticsService(
      app.personasim.llm.settings!,
      fetchOverride,
    );
    const pending = diagnostics.test(
      {
        providerId: provider.id,
        revision: provider.revision,
        modelId: "test-model",
      },
      controller.signal,
    );
    await entered.promise;
    controller.abort();
    const result = await pending;
    expect(result.status).toBe("failed");
    expect(result.structured.status).toBe("skipped");
    expect(fetchOverride).toHaveBeenCalledTimes(1);
    expect(
      app.personasim.llm.settings!.latestProbe(provider.id, "test-model"),
    ).toBeUndefined();
  });
});

describe("runtime execution selection", () => {
  it("routes complete HTTP turns and business repair to their selected models, then preserves committed replay after deletion", async () => {
    const wire: Array<{ model: string; repair: boolean }> = [];
    let forcedRepair = false;
    const repairedText = "你好呀，很高兴见到你。";
    const normalText = "你好，今天想聊些什么？";
    const fetchOverride = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(requestBody(init)) as {
        model: string;
        messages: Array<{ content: string }>;
      };
      const repair = request.messages.some((message) =>
        message.content.includes(
          "Repair only the in-character conversational reply",
        ),
      );
      wire.push({ model: request.model, repair });
      if (request.model === "model-a" && !repair && !forcedRepair) {
        forcedRepair = true;
        await switchDefault();
        // The envelope is valid, but its empty reply requires domain-level repair.
        return completion(
          JSON.stringify({ replyDecision: {}, worldEffects: {} }),
        );
      }
      return completion(
        JSON.stringify(
          repair
            ? { text: repairedText }
            : { replyDecision: { text: normalText }, worldEffects: {} },
        ),
      );
    });
    const { app } = await setup(fetchOverride);
    const makeCharacterSession = async () => {
      const generated = await app.inject({
        method: "POST",
        url: "/api/characters/generate",
        payload: {
          name: "林夏",
          worldSetting: "当代城市生活",
          workOrRole: "研究生与独立插画师",
          coreTraits: ["认真", "有主见", "温暖"],
          centralContradiction: "既重视学习计划，也珍惜重要关系",
          primaryGoal: "完成毕业作品",
          relationshipToUser: "熟悉的朋友",
          dialogueStyle: "自然、简洁、偶尔冷幽默",
          tier: "daily",
          timezone: "Asia/Shanghai",
        },
      });
      expect(generated.statusCode, generated.body).toBe(201);
      const character = body<{ character: { id: string; version: number } }>(
        generated,
      ).character;
      const published = await app.inject({
        method: "POST",
        url: `/api/characters/${character.id}/publish`,
        payload: { expectedVersion: character.version },
      });
      expect(published.statusCode, published.body).toBe(200);
      const created = await app.inject({
        method: "POST",
        url: `/api/agents/${character.id}/sessions`,
        payload: {},
      });
      expect(created.statusCode, created.body).toBe(201);
      return {
        agentId: character.id,
        sessionId: body<{ session: { id: string } }>(created).session.id,
      };
    };
    const first = await makeCharacterSession();
    const second = await makeCharacterSession();
    const a = await createProvider(app, {
      name: "A",
      models: [{ id: "model-a" }],
    });
    const b = await createProvider(app, {
      name: "B",
      models: [{ id: "model-b" }],
    });
    const aSelection = {
      providerId: a.id,
      modelId: "model-a",
      revision: a.revision,
    };
    const bSelection = {
      providerId: b.id,
      modelId: "model-b",
      revision: b.revision,
    };
    for (const [sessionId, selection] of [
      [first.sessionId, { providerId: a.id, modelId: "model-a" }],
      [second.sessionId, { providerId: b.id, modelId: "model-b" }],
    ] as const) {
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: `/api/sessions/${sessionId}/model`,
            payload: { selection },
          })
        ).statusCode,
      ).toBe(200);
    }
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/llm/default",
          payload: { selection: { providerId: a.id, modelId: "model-a" } },
        })
      ).statusCode,
    ).toBe(200);
    const switchDefault = async () => {
      expect(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/llm/default",
            payload: { selection: { providerId: b.id, modelId: "model-b" } },
          })
        ).statusCode,
      ).toBe(200);
    };
    const command = {
      agentId: first.agentId,
      clientMessageId: "http-turn-a",
      text: "你好",
      modelSelection: aSelection,
    };
    const turnSpy = vi.spyOn(app.personasim.conversations, "chat");
    const firstResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${first.sessionId}/messages`,
      payload: command,
    });
    expect(firstResponse.statusCode, firstResponse.body).toBe(201);
    expect(
      body<ChatTurnResult>(firstResponse).assistantMessage.metadata,
    ).not.toHaveProperty("modelSelection");
    const firstTurn = await (turnSpy.mock.results.at(-1)!
      .value as Promise<ChatTurnResult>);
    expect(firstTurn.assistantMessage.metadata.modelSelection).toEqual(
      aSelection,
    );
    expect(firstTurn.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(firstTurn.assistantMessage.content).toBe(repairedText);
    expect(wire).toContainEqual({ model: "model-a", repair: true });
    expect(
      wire.some((request) => request.model === "model-b" && request.repair),
    ).toBe(false);
    const secondResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${second.sessionId}/messages`,
      payload: {
        agentId: second.agentId,
        clientMessageId: "http-turn-b",
        text: "你好",
        modelSelection: bSelection,
      },
    });
    expect(secondResponse.statusCode, secondResponse.body).toBe(201);
    expect(
      (await (turnSpy.mock.results.at(-1)!.value as Promise<ChatTurnResult>))
        .assistantMessage.metadata.modelSelection,
    ).toEqual(bSelection);
    expect(body<ChatTurnResult>(secondResponse).assistantMessage.content).toBe(
      normalText,
    );
    expect(wire).toContainEqual({ model: "model-b", repair: false });
    const beforeReplay = fetchOverride.mock.calls.length;
    const conflict = await app.inject({
      method: "POST",
      url: `/api/sessions/${first.sessionId}/messages`,
      payload: { ...command, modelSelection: bSelection },
    });
    expect(conflict.statusCode, conflict.body).toBe(409);
    expect(body<{ error: { code: string } }>(conflict).error.code).toBe(
      "idempotency_key_reused",
    );
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/llm/providers/${a.id}`,
          payload: providerInput({
            expectedRevision: 1,
            name: "A revision 2",
            models: [{ id: "model-a" }],
          }),
        })
      ).statusCode,
    ).toBe(200);
    const stale = await app.inject({
      method: "POST",
      url: `/api/sessions/${first.sessionId}/messages`,
      payload: { ...command, clientMessageId: "http-turn-not-yet-committed" },
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/llm/providers/${a.id}`,
        })
      ).statusCode,
    ).toBe(204);
    const replay = await app.inject({
      method: "POST",
      url: `/api/sessions/${first.sessionId}/messages`,
      payload: command,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(body<ChatTurnResult>(replay)).toMatchObject({
      idempotentReplay: true,
      assistantMessage: {
        id: firstTurn.assistantMessage.id,
        content: repairedText,
      },
    });
    expect(fetchOverride).toHaveBeenCalledTimes(beforeReplay);
  });

  it("isolates concurrent session captures, freezes transport repair, and uses a new default for background calls", async () => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const requests: Array<{
      model: string;
      authorization: string | null;
      body: string;
    }> = [];
    let firstA = true;
    const fetchOverride = vi.fn<typeof fetch>(async (_url, init) => {
      const request = JSON.parse(requestBody(init)) as { model: string };
      requests.push({
        model: request.model,
        authorization: new Headers(init?.headers).get("authorization"),
        body: requestBody(init),
      });
      if (request.model === "model-a" && firstA) {
        firstA = false;
        entered.resolve();
        await release.promise;
        return completion("invalid JSON");
      }
      return completion(JSON.stringify({ reply: request.model }));
    });
    const { app } = await setup(fetchOverride);
    const a = await createProvider(app, {
      name: "A",
      models: [{ id: "model-a" }],
    });
    const b = await createProvider(app, {
      name: "B",
      apiKey: "synthetic-key-b",
      models: [{ id: "model-b" }],
    });
    const settings = app.personasim.llm.settings!;
    settings.setSessionModel("session-a", {
      providerId: a.id,
      modelId: "model-a",
    });
    settings.setSessionModel("session-b", {
      providerId: b.id,
      modelId: "model-b",
    });
    settings.setDefault({ providerId: a.id, modelId: "model-a" });
    const capturedA = app.personasim.llm.captureSession("session-a");
    const capturedB = app.personasim.llm.captureSession("session-b");
    const command = {
      purpose: "repair_chat_turn" as const,
      system: "Return JSON",
      prompt: "hello",
      schema: z.strictObject({ reply: z.string() }),
      maxRetries: 1,
    };
    const pendingA = capturedA.generateObject(command);
    await entered.promise;
    expect(await capturedB.generateObject(command)).toEqual({
      reply: "model-b",
    });
    settings.update(
      a.id,
      providerInput({
        name: "A changed",
        apiKey: "synthetic-key-a-new",
        models: [{ id: "model-a" }],
      }),
    );
    settings.setDefault({ providerId: b.id, modelId: "model-b" });
    settings.setSessionModel("session-a", {
      providerId: b.id,
      modelId: "model-b",
    });
    release.resolve();
    expect(await pendingA).toEqual({ reply: "model-a" });
    expect(
      requests.filter((request) => request.model === "model-a"),
    ).toHaveLength(2);
    expect(
      requests
        .filter((request) => request.model === "model-a")
        .every((request) => request.authorization === `Bearer ${SECRET}`),
    ).toBe(true);
    expect(requests.at(-1)?.body).toContain("STRUCTURED_OUTPUT_REPAIR");
    expect(
      await app.personasim.llm.generateObject({
        ...command,
        purpose: "checkpoint_autobiography",
      }),
    ).toEqual({ reply: "model-b" });
    expect(app.personasim.llm.captureSession("session-a").modelName).toBe(
      "model-b",
    );
    expect(capturedA.modelName).toBe("model-a");
    const audit = app.personasim.store.database
      .prepare(
        "SELECT provider_profile AS profile,model,purpose,config_revision AS configRevision FROM llm_calls ORDER BY rowid",
      )
      .all();
    expect(audit).toEqual(
      expect.arrayContaining([
        {
          profile: a.id,
          model: "model-a",
          purpose: "repair_chat_turn",
          configRevision: 1,
        },
        {
          profile: b.id,
          model: "model-b",
          purpose: "checkpoint_autobiography",
          configRevision: 1,
        },
      ]),
    );
  });

  it("starts and serves health/catalog/chat history after the default supplier's key file is lost", async () => {
    const fetchOverride = vi.fn<typeof fetch>();
    const f = await setup(fetchOverride);
    const provider = await createProvider(f.app);
    f.app.personasim.llm.settings!.setDefault({
      providerId: provider.id,
      modelId: "test-model",
    });
    await f.app.close();
    applications.delete(f.app);
    unlinkSync(llmKeyPath(f.databasePath));
    const restarted = await buildApp({
      config: f.config,
      clock: new FakeClock(NOW),
      seedDemo: false,
      startScheduler: false,
      logger: false,
      llmObservation: { fetch: fetchOverride },
    });
    applications.add(restarted);
    expect(
      (await restarted.inject({ method: "GET", url: "/api/health" }))
        .statusCode,
    ).toBe(200);
    const catalog = body<LlmCatalog>(
      await restarted.inject({ method: "GET", url: "/api/llm/providers" }),
    );
    expect(
      catalog.providers.find((item) => item.id === provider.id)
        ?.credentialStatus,
    ).toBe("unavailable");
    expect(
      (
        await restarted.inject({
          method: "GET",
          url: "/api/sessions/session-a/messages",
        })
      ).statusCode,
    ).toBe(200);
    expect(existsSync(llmKeyPath(f.databasePath))).toBe(false);
    expect((await probe(restarted, provider)).statusCode).toBe(409);
    expect(fetchOverride).not.toHaveBeenCalled();
  });
});
