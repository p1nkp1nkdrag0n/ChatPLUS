import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HostedControlStore } from "./control-store.js";
import { HostedModelGateway } from "./model-gateway.js";
import type { ResolvedLlmConfiguration } from "../services/llm-settings-service.js";
import type { LlmPurpose, LlmSelection } from "@personasim/contracts";

const opened: HostedControlStore[] = [];
afterEach(() => {
  for (const store of opened.splice(0)) {
    store.close();
    if (store.rootDirectory.startsWith(join(tmpdir(), "dearvale-byok-")))
      rmSync(store.rootDirectory, { recursive: true, force: true });
  }
});
function fixture() {
  const store = new HostedControlStore(
    mkdtempSync(join(tmpdir(), "dearvale-byok-")),
  );
  opened.push(store);
  const admin = store.createAdministrator("admin", "test-hash");
  const invite = store.createInvite(
    { maxUses: 2, initialBalanceMicros: 0 },
    admin.id,
  );
  const user = store.registerUser({
    username: "alice",
    passwordHash: "test-hash",
    inviteCode: invite.code,
  });
  store.upsertModel(
    {
      routeId: "platform",
      displayName: "平台模型",
      kind: "text",
      protocol: "openai-compatible",
      baseUrl: "https://platform.example/v1",
      apiKey: "PLATFORM_TEST_KEY",
      modelId: "platform-model",
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 1_000_000,
      cacheReadMicrosPerMillion: 1_000_000,
      maxOutputTokens: 512,
      enabled: true,
    },
    admin.id,
  );
  store.setPurposeDefault("default", "platform", admin.id);
  store.setLimits({ callsEnabled: true }, admin.id);
  const config: ResolvedLlmConfiguration = {
    selection: {
      providerId: "personal-provider",
      modelId: "personal-model",
      revision: 1,
    },
    protocol: "openai-compatible",
    baseUrl: "https://personal.example/custom/v1",
    apiKey: "PERSONAL_TEST_KEY",
    timeoutMs: 120_000,
    profileName: "personal-provider",
    model: {
      id: "personal-model",
      tokenParameter: "max_completion_tokens",
      capabilities: {
        structuredOutputMode: "prompt_json",
        supportsThinkingControl: false,
        supportsStreaming: false,
        maxContextTokens: 64_000,
        maxOutputTokens: 256,
      },
    },
  };
  return { store, admin, user, config };
}
function result(text = "hello", withUsage = true) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { content: JSON.stringify({ text }) },
          finish_reason: "stop",
        },
      ],
      ...(withUsage
        ? { usage: { prompt_tokens: 12, completion_tokens: 7 } }
        : {}),
    }),
    { headers: { "content-type": "application/json" } },
  );
}
function setupGateway(
  f: ReturnType<typeof fixture>,
  userFetch: typeof fetch,
  resolver: (
    purpose: LlmPurpose,
    selection?: LlmSelection,
  ) => ResolvedLlmConfiguration | undefined = () => f.config,
  lookup: (selection: LlmSelection) => ResolvedLlmConfiguration = () =>
    f.config,
) {
  const platformFetch = vi.fn<typeof fetch>(() =>
    Promise.resolve(result("platform")),
  );
  const gateway = new HostedModelGateway(f.store, platformFetch, userFetch);
  const observation = gateway.forUser(f.user.id, resolver, undefined, lookup);
  const generate = (operationId: string, purpose: LlmPurpose = "chat_turn") =>
    gateway.runOperation({ userId: f.user.id, operationId }, () =>
      observation.executionResolver!(purpose).provider.generateObject({
        purpose,
        system: "Return JSON",
        prompt: "hello",
        schema: z.object({ text: z.string() }),
      }),
    );
  return { gateway, platformFetch, generate, observation };
}

describe("user-supplied model gateway", () => {
  it("retains the initially captured model when generation echoes its explicit selection", () => {
    const f = fixture();
    let current = f.config;
    const g = setupGateway(f, vi.fn(), () => current);
    g.gateway.runOperation(
      { userId: f.user.id, operationId: "stable-turn" },
      () => {
        const captured = g.observation.executionResolver!("chat_turn");
        current = {
          ...f.config,
          selection: { ...f.config.selection, revision: 2 },
          model: {
            ...f.config.model,
            capabilities: {
              ...f.config.model.capabilities,
              maxContextTokens: 16_000,
            },
          },
        };
        const generation = g.observation.executionResolver!(
          "chat_turn",
          captured.selection,
          {},
        );
        expect(generation.selection.revision).toBe(1);
        expect(generation.provider.capabilities?.maxContextTokens).toBe(64_000);
      },
    );
  });
  it("uses the user's URL, key and token parameter without touching a zero-balance wallet, and records research", async () => {
    const f = fixture();
    const request = vi.fn<typeof fetch>(() => Promise.resolve(result()));
    const g = setupGateway(f, request);
    const before = f.store.wallet(f.user.id);
    expect(await g.generate("own-1")).toEqual({ text: "hello" });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toBe(
      "https://personal.example/custom/v1/chat/completions",
    );
    expect(
      new Headers(request.mock.calls[0]![1]?.headers).get("authorization"),
    ).toBe("Bearer PERSONAL_TEST_KEY");
    expect(JSON.parse(request.mock.calls[0]![1]?.body as string)).toMatchObject(
      {
        model: "personal-model",
        max_completion_tokens: 256,
      },
    );
    expect(g.platformFetch).not.toHaveBeenCalled();
    expect(f.store.wallet(f.user.id)).toEqual(before);
    expect(
      f.store
        .listLedger(f.user.id)
        .filter((entry) => entry.kind === "llm_charge"),
    ).toHaveLength(0);
    const attempt = f.store.listAttempts()[0]!;
    expect(attempt).toMatchObject({
      status: "settled",
      maximumCostMicros: 0,
      costMicros: 0,
      modelSnapshot: {
        billingSource: "user",
        baseUrl: "https://user-provider.invalid",
      },
    });
    expect(f.store.readAttemptResponse(attempt.id)?.body).toContain("hello");
    const records = f.store.researchDatabase
      .prepare("SELECT kind,payload_encrypted FROM research_records")
      .all();
    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain("PERSONAL_TEST_KEY");
    expect(
      JSON.stringify(
        f.store.database.prepare("SELECT model_json FROM attempts").all(),
      ),
    ).not.toContain("personal.example");
  });

  it("accepts a successful response with unknown usage without freezing credits", async () => {
    const f = fixture();
    const g = setupGateway(
      f,
      vi.fn<typeof fetch>(() => Promise.resolve(result("no usage", false))),
    );
    expect(await g.generate("missing-usage")).toEqual({ text: "no usage" });
    expect(f.store.listAttempts()[0]).toMatchObject({
      status: "settled",
      costMicros: 0,
      usage: { source: "unavailable", billingSource: "user" },
    });
    expect(f.store.wallet(f.user.id).reservedMicros).toBe(0);
  });

  it("durably replays a completed reply even after the user's provider is removed", async () => {
    const f = fixture();
    const request = vi.fn<typeof fetch>(() => Promise.resolve(result()));
    const g = setupGateway(f, request);
    await g.generate("replay");
    const fail = () => {
      throw new Error("deleted provider");
    };
    const resumed = setupGateway(f, request, fail, fail);
    expect(await resumed.generate("replay")).toEqual({ text: "hello" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("uses independent purpose bindings and requires platform funds only for the platform call", async () => {
    const f = fixture();
    const request = vi.fn<typeof fetch>(() => Promise.resolve(result()));
    const g = setupGateway(f, request, (purpose) =>
      purpose === "chat_turn" ? f.config : undefined,
    );
    expect(await g.generate("chat")).toEqual({ text: "hello" });
    await expect(g.generate("diary", "diary_generation")).rejects.toMatchObject(
      { code: "insufficient_balance" },
    );
    expect(g.platformFetch).not.toHaveBeenCalled();
    expect(f.store.listAttempts()).toHaveLength(1);
  });

  it("does not fall back to platform credentials when the user provider fails", async () => {
    const f = fixture();
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(
        new Response('{"error":{"message":"PERSONAL_TEST_KEY invalid"}}', {
          status: 401,
        }),
      ),
    );
    const g = setupGateway(f, request);
    await expect(g.generate("bad-key")).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
    expect(g.platformFetch).not.toHaveBeenCalled();
    expect(f.store.listAttempts()[0]).toMatchObject({
      status: "settled",
      costMicros: 0,
    });
    expect(
      f.store.readAttemptResponse(f.store.listAttempts()[0]!.id)?.body,
    ).not.toContain("PERSONAL_TEST_KEY");
  });

  it("rechecks provider existence before dispatch and prevents cross-user operation contexts", async () => {
    const f = fixture();
    const request = vi.fn<typeof fetch>(() => Promise.resolve(result()));
    const g = setupGateway(
      f,
      request,
      () => f.config,
      () => {
        throw new Error("provider removed");
      },
    );
    await expect(g.generate("removed")).rejects.toThrow("provider removed");
    expect(request).not.toHaveBeenCalled();
    expect(() =>
      g.gateway.runOperation(
        { userId: "someone-else", operationId: "cross-owner" },
        () => g.observation.executionResolver!("chat_turn"),
      ),
    ).toThrow("账号与模型任务不匹配");
  });

  it("records explicit discovery and probes without a platform ledger entry", async () => {
    const f = fixture();
    const request = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response('{"data":[{"id":"personal-model"}]}')),
    );
    const g = setupGateway(f, request);
    const response = await g.gateway.userDiagnosticsFetch(f.user.id)(
      "https://personal.example/v1/models",
      { method: "GET", headers: { authorization: "Bearer PERSONAL_TEST_KEY" } },
    );
    expect(await response.json()).toEqual({ data: [{ id: "personal-model" }] });
    expect(f.store.listAttempts()[0]).toMatchObject({
      purpose: "user_model_diagnostic",
      status: "settled",
      costMicros: 0,
    });
    expect(
      f.store
        .listLedger(f.user.id)
        .filter((entry) => entry.kind === "llm_charge"),
    ).toHaveLength(0);
  });
});
