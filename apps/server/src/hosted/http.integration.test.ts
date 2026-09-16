import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { finished } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { createFixtureLlmProvider } from "@personasim/providers";
import type { LlmExecutionSelection } from "@personasim/contracts";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../config.js";
import { buildHostedApps } from "./app.js";
import { HostedControlStore } from "./control-store.js";

vi.hoisted(() => {
  process.env.PERSONASIM_LOAD_ENV = "false";
});
const publicOrigin = "https://friends.example";
const adminOrigin = "http://127.0.0.1:3002";
const opened: Array<{
  root: string;
  app?: Awaited<ReturnType<typeof buildHostedApps>> | undefined;
}> = [];
const characterInput = {
  name: "林夏",
  worldSetting: "当代城市生活",
  workOrRole: "研究生与独立插画师",
  coreTraits: ["认真", "有主见", "温暖"],
  centralContradiction: "既重视学习计划，也珍惜重要关系",
  primaryGoal: "完成毕业作品",
  relationshipToUser: "熟悉的朋友",
  dialogueStyle: "自然、简洁",
  tier: "lightweight",
  timezone: "Asia/Shanghai",
};
function client(app: FastifyInstance, origin: string) {
  const jar = new Map<string, string>();
  let csrfToken = "";
  return {
    cookies: () => [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
    async request(
      method: "GET" | "POST" | "PATCH" | "DELETE",
      url: string,
      payload?: object | string,
      extra: Record<string, string> = {},
    ) {
      const response = await app.inject({
        method,
        url,
        ...(payload ? { payload } : {}),
        headers: {
          host: new URL(origin).host,
          origin,
          cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
          "x-csrf-token": csrfToken,
          ...extra,
        },
      });
      for (const cookie of response.cookies) jar.set(cookie.name, cookie.value);
      try {
        const token: unknown = response.json<{ csrfToken?: unknown }>()
          .csrfToken;
        if (typeof token === "string") csrfToken = token;
      } catch {
        /* assets/non-JSON */
      }
      return response;
    },
  };
}
async function fixture(startSchedulers = false) {
  const root = mkdtempSync(join(tmpdir(), "dearvale-http-"));
  const openedEntry = {
    root,
    app: undefined as Awaited<ReturnType<typeof buildHostedApps>> | undefined,
  };
  opened.push(openedEntry);
  let app: Awaited<ReturnType<typeof buildHostedApps>>;
  const calls: { model: string; purpose: string }[] = [];
  const provider = createFixtureLlmProvider();
  const transport: typeof fetch = async (_url, init) => {
    if (typeof init?.body !== "string")
      throw new Error("Expected a JSON-string provider request body");
    const request = JSON.parse(init.body) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    const attempt = app.control.listAttempts({ status: "sent", limit: 1 })[0]!;
    calls.push({ model: request.model, purpose: attempt.purpose });
    const data = await provider.generateObject({
      purpose: attempt.purpose,
      system: request.messages.find((m) => m.role === "system")?.content ?? "",
      prompt: request.messages
        .filter((m) => m.role === "user")
        .map((m) => m.content)
        .join("\n"),
      schema: z.unknown(),
    });
    return new Response(
      JSON.stringify({
        id: `mock-${calls.length}`,
        model: "private-model-reported",
        choices: [
          { message: { content: JSON.stringify(data) }, finish_reason: "stop" },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 40 },
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
  };
  const baseConfig = readConfig({
    nodeEnv: "test",
    profile: "test",
    databasePath: ":memory:",
    seedDemo: false,
    developerRoutes: false,
    keepsakeMode: "off",
    correspondenceMode: "off",
    lifePlanningMode: "legacy_exact",
    scheduleNegotiationMode: "legacy",
    llm: {
      provider: "fixture",
      baseUrl: "https://mock.invalid",
      model: "fixture",
      maxRetries: 0,
      timeoutMs: 1000,
    },
  });
  app = await buildHostedApps({
    rootDirectory: root,
    publicOrigin,
    adminOrigin,
    baseConfig,
    startSchedulers,
    transport,
  });
  openedEntry.app = app;
  const admin = client(app.adminApp, adminOrigin);
  expect(
    (await admin.request("GET", "/api/hosted/info")).json<{
      bootstrapRequired: boolean;
    }>().bootstrapRequired,
  ).toBe(true);
  const bootstrap = await admin.request("POST", "/api/hosted/auth/bootstrap", {
    username: "operator",
    password: "testing-operator-password",
  });
  expect(bootstrap.statusCode, bootstrap.body).toBe(200);
  const adminId: string = bootstrap.json<{ user: { id: string } }>().user.id;
  app.control.upsertModel(
    {
      routeId: "friendly",
      displayName: "朋友模型",
      kind: "text",
      protocol: "openai-compatible",
      baseUrl: "https://private-provider.invalid/v1",
      modelId: "private-model-id",
      apiKey: "mock-key-private-only",
      inputMicrosPerMillion: 1_000_000,
      outputMicrosPerMillion: 2_000_000,
      cacheReadMicrosPerMillion: 100_000,
      maxOutputTokens: 8192,
      enabled: true,
    },
    adminId,
  );
  app.control.setPurposeDefault("default", "friendly", adminId);
  app.control.setLimits(
    { callsEnabled: true, registrationEnabled: true },
    adminId,
  );
  async function register(username: string) {
    const friend = client(app.userApp, publicOrigin);
    await friend.request("GET", "/api/hosted/info");
    const { code } = app.control.createInvite(
      { initialBalanceMicros: 100_000_000 },
      adminId,
    );
    const response = await friend.request("POST", "/api/hosted/auth/register", {
      username,
      password: "testing-friend-password",
      inviteCode: code,
    });
    expect(response.statusCode, response.body).toBe(200);
    return {
      ...friend,
      userId: response.json<{ user: { id: string } }>().user.id,
    };
  }
  const reopen = async () => {
    await app.close();
    app = await buildHostedApps({
      rootDirectory: root,
      publicOrigin,
      adminOrigin,
      baseConfig,
      startSchedulers,
      transport,
    });
    openedEntry.app = app;
    return app;
  };
  return { app, root, admin, adminId, register, calls, baseConfig, reopen };
}
afterEach(async () => {
  for (const item of opened.splice(0)) {
    await item.app?.close();
    rmSync(item.root, { recursive: true, force: true });
  }
});

describe("hosted HTTP boundaries and lifecycle", () => {
  it("batches all visible session billing including child calls without leaking other sessions or users", async () => {
    const { app, register } = await fixture();
    const user = await register("session-billing-owner");
    const other = await register("session-billing-other");
    const generated = await user.request(
      "POST",
      "/api/characters/generate",
      characterInput,
    );
    expect(generated.statusCode, generated.body).toBe(201);
    const characterId = generated.json<{ character: { id: string } }>()
      .character.id;
    const { store } = (await app.runtimes.get(user.userId)).composition
      .routeServices;
    const session = store.createSession(
      characterId,
      "账单测试",
      new Date().toISOString(),
    );
    const outside = store.createSession(
      characterId,
      "另一会话",
      new Date().toISOString(),
    );
    for (const [clientMessageId, sessionId] of [
      ["turn-first", session.id],
      ["turn-empty", session.id],
      ["turn-outside", outside.id],
    ]) {
      store.insertMessage({
        id: randomUUID(),
        sessionId: sessionId!,
        agentId: characterId,
        role: "user",
        content: "fixture history",
        messageKind: "user",
        clientMessageId: clientMessageId!,
        metadata: {},
        createdAtUtc: new Date().toISOString(),
      });
    }
    const modelSnapshot = app.control.resolveModel("friendly");
    // A session response must not inherit the old per-request 100-attempt truncation.
    for (let index = 0; index < 101; index++) {
      app.control.reserve({
        id: `session-attempt-${index}`,
        userId: user.userId,
        operationId: "chat:turn-first",
        purpose: "chat_turn",
        maximumCostMicros: 1,
        modelSnapshot,
      });
    }
    app.control.reserve({
      id: "session-child",
      userId: user.userId,
      operationId: "child:session-first",
      parentOperationId: "chat:turn-first",
      purpose: "keepsake",
      maximumCostMicros: 1,
      modelSnapshot,
    });
    for (const [id, userId, operationId] of [
      ["other-session-attempt", user.userId, "chat:turn-outside"],
      ["other-user-attempt", other.userId, "chat:turn-first"],
    ]) {
      app.control.reserve({
        id: id!,
        userId: userId!,
        operationId: operationId!,
        purpose: "chat_turn",
        maximumCostMicros: 1,
        modelSnapshot,
      });
    }
    const path = `/api/hosted/billing/sessions/${session.id}`;
    const response = await user.request("GET", path);
    expect(response.statusCode, response.body).toBe(200);
    const result = response.json<{
      turns: Record<string, Array<{ id: string }>>;
    }>();
    expect(Object.keys(result.turns).sort()).toEqual([
      "turn-empty",
      "turn-first",
    ]);
    expect(result.turns["turn-empty"]).toEqual([]);
    expect(result.turns["turn-first"]).toHaveLength(102);
    expect(result.turns["turn-first"]).toContainEqual(
      expect.objectContaining({ id: "session-child" }),
    );
    expect(response.body).not.toContain("other-user-attempt");
    expect(response.body).not.toContain("other-session-attempt");
    for (const privateField of [
      "wallet",
      "entries",
      "modelSnapshot",
      "modelId",
      "userId",
    ])
      expect(result).not.toHaveProperty(privateField);
    expect(response.body).not.toContain("private-provider");
    expect((await other.request("GET", path)).statusCode).toBe(404);
    expect(
      (await client(app.userApp, publicOrigin).request("GET", path)).statusCode,
    ).toBe(401);
  });

  it("uses each hosted model's current execution revision in UI-style chat submissions after price edits", async () => {
    const { app, adminId, register, calls } = await fixture();
    const user = await register("revision-user");
    const generated = await user.request(
      "POST",
      "/api/characters/generate",
      characterInput,
    );
    expect(generated.statusCode, generated.body).toBe(201);
    const character = generated.json<{
      character: { id: string; version: number };
    }>().character;
    expect(
      (
        await user.request("POST", `/api/characters/${character.id}/publish`, {
          expectedVersion: character.version,
        })
      ).statusCode,
    ).toBe(200);
    const createdSession = await user.request(
      "POST",
      `/api/agents/${character.id}/sessions`,
      {},
    );
    expect(createdSession.statusCode, createdSession.body).toBe(201);
    const sessionId = createdSession.json<{ session: { id: string } }>().session
      .id;
    const modelPath = `/api/sessions/${sessionId}/model`;
    expect(
      (await user.request("GET", modelPath)).json<{
        effective: LlmExecutionSelection;
      }>().effective.revision,
    ).toBe(1);
    const original = app.control.resolveModel("friendly");
    app.control.upsertModel(
      { ...original, inputMicrosPerMillion: 2_000_000 },
      adminId,
    );
    app.control.upsertModel(
      { ...original, routeId: "independent", displayName: "独立版本模型" },
      adminId,
    );

    // The actual client reads this endpoint and sends effective unchanged.
    // The hosted provider container stays revision 1 while this model is v2.
    const effective = (await user.request("GET", modelPath)).json<{
      effective: LlmExecutionSelection;
    }>().effective;
    const input = {
      agentId: character.id,
      text: "今天过得怎么样？",
      clientMessageId: "revision-ui-chat",
      modelSelection: effective,
    };
    const first = await user.request(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      input,
    );
    expect(first.statusCode, first.body).toBe(201);
    expect(effective).toMatchObject({ modelId: "friendly", revision: 2 });
    const newSession = await user.request(
      "POST",
      `/api/agents/${character.id}/sessions`,
      {},
    );
    expect(newSession.statusCode, newSession.body).toBe(201);
    expect(
      newSession.json<{
        session: { model: { effective: LlmExecutionSelection } };
      }>().session.model.effective,
    ).toMatchObject({ modelId: "friendly", revision: 2 });
    const beforeStale = calls.length;
    const stale = await user.request(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      {
        ...input,
        clientMessageId: "stale-revision-chat",
        modelSelection: { ...effective, revision: 1 },
      },
    );
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json<{ error: { code: string } }>().error.code).toBe(
      "model_revision_changed",
    );
    expect(calls).toHaveLength(beforeStale);
    expect(
      app.control.listAttempts({ operationId: "chat:stale-revision-chat" }),
    ).toHaveLength(0);
    expect(
      app.control
        .listAttempts({ operationId: "chat:revision-ui-chat" })
        .find((attempt) => attempt.purpose === "chat_turn")?.modelSnapshot,
    ).toMatchObject({
      routeId: "friendly",
      revision: 2,
      inputMicrosPerMillion: 2_000_000,
    });

    const switched = await user.request("PATCH", modelPath, {
      selection: { providerId: "hosted", modelId: "independent" },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    const other = switched.json<{ effective: LlmExecutionSelection }>()
      .effective;
    expect(other).toMatchObject({ modelId: "independent", revision: 1 });
    const second = await user.request(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      {
        ...input,
        clientMessageId: "independent-revision-chat",
        text: "那我们聊聊明天吧。",
        modelSelection: other,
      },
    );
    expect(second.statusCode, second.body).toBe(201);
    expect(
      app.control
        .listAttempts({ operationId: "chat:independent-revision-chat" })
        .find((attempt) => attempt.purpose === "chat_turn")?.modelSnapshot,
    ).toMatchObject({ routeId: "independent", revision: 1 });
    const sessions = await user.request(
      "GET",
      `/api/agents/${character.id}/sessions`,
    );
    expect(
      sessions
        .json<{
          sessions: Array<{
            id: string;
            model: { effective: LlmExecutionSelection };
          }>;
        }>()
        .sessions.find((session) => session.id === sessionId)?.model.effective,
    ).toMatchObject({ modelId: "independent", revision: 1 });

    app.control.upsertModel(
      { ...original, inputMicrosPerMillion: 3_000_000 },
      adminId,
    );
    const beforeReplay = calls.length;
    const replay = await user.request(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      input,
    );
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.body).toBe(first.body);
    expect(calls).toHaveLength(beforeReplay);
    expect(
      app.control
        .listAttempts({ operationId: "chat:revision-ui-chat" })
        .find((attempt) => attempt.purpose === "chat_turn")?.modelSnapshot
        .revision,
    ).toBe(2);
  }, 30000);

  it("requires administrator identity for encoded management paths and never registers them on the user listener", async () => {
    const { app, admin, register, calls } = await fixture();
    const anonymousAdmin = client(app.adminApp, adminOrigin);
    const ordinary = await register("encoded_regular");
    const ordinaryAdminCookie = ordinary
      .cookies()
      .replace("dearvale_user_session=", "dearvale_admin_session=");
    for (const endpoint of ["users", "research", "models"]) {
      for (const prefix of [
        "/api/hosted/admin/",
        "/api/hosted/%61dmin/",
        "/%61pi/hosted/admin/",
      ]) {
        const path = `${prefix}${endpoint}`;
        const unauthenticated = await anonymousAdmin.request("GET", path);
        expect(unauthenticated.statusCode, path).toBe(401);
        expect(unauthenticated.headers["cache-control"], path).toBe("no-store");
        const forbidden = await app.adminApp.inject({
          method: "GET",
          url: path,
          headers: {
            host: new URL(adminOrigin).host,
            cookie: ordinaryAdminCookie,
          },
        });
        expect(forbidden.statusCode, path).toBe(403);
        expect(forbidden.json<{ error: { code: string } }>().error.code).toBe(
          "admin_required",
        );
        const publicResponse = await ordinary.request("GET", path);
        expect(publicResponse.statusCode, path).toBe(404);
        expect(publicResponse.headers["cache-control"], path).toBe("no-store");
        expect((await admin.request("GET", path)).statusCode, path).toBe(200);
      }
    }
    expect(
      (await ordinary.request("GET", "/%61pi/settings")).headers[
        "cache-control"
      ],
    ).toBe("no-store");
    expect(calls).toHaveLength(0);
  });
  it("applies password reset restrictions and CSRF protection to encoded API paths", async () => {
    const { app, register, adminId, calls } = await fixture();
    const user = await register("encoded_reset");
    await app.auth.resetPassword(
      user.userId,
      "temporary-reset-password",
      adminId,
    );
    expect(
      (
        await user.request("POST", "/api/hosted/auth/login", {
          username: "encoded_reset",
          password: "temporary-reset-password",
        })
      ).statusCode,
    ).toBe(200);
    for (const path of [
      "/api/settings",
      "/%61pi/settings",
      "/api/hosted/%62illing",
    ]) {
      const response = await user.request("GET", path);
      expect(response.statusCode, path).toBe(403);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        "password_change_required",
      );
      expect(response.headers["cache-control"]).toBe("no-store");
    }
    const settings = await user.request("PATCH", "/%61pi/settings", {
      locale: "en-US",
    });
    expect(settings.statusCode).toBe(403);
    const passwordPath = "/%61pi/hosted/auth/%70assword";
    const change = {
      currentPassword: "temporary-reset-password",
      newPassword: "new-friend-private-password",
    };
    const badCsrf = await user.request("POST", passwordPath, change, {
      "x-csrf-token": "invalid",
    });
    expect(badCsrf.statusCode).toBe(403);
    expect(badCsrf.json<{ error: { code: string } }>().error.code).toBe(
      "csrf_invalid",
    );
    const badOrigin = await user.request("POST", passwordPath, change, {
      origin: "https://attacker.invalid",
    });
    expect(badOrigin.statusCode).toBe(403);
    expect(badOrigin.json<{ error: { code: string } }>().error.code).toBe(
      "invalid_origin",
    );
    expect((await user.request("POST", passwordPath, change)).statusCode).toBe(
      200,
    );
    expect((await user.request("GET", "/%61pi/settings")).statusCode).toBe(200);
    expect(calls).toHaveLength(0);
  });
  it("registers without consent fields, requires protected cookies and an exact origin; has no admin API on the public listener", async () => {
    const { app, adminId, register } = await fixture();
    const anonymous = client(app.userApp, publicOrigin);
    await anonymous.request("GET", "/api/hosted/info");
    const { code } = app.control.createInvite({}, adminId);
    const registered = await anonymous.request(
      "POST",
      "/api/hosted/auth/register",
      {
        username: "nosign",
        password: "testing-friend-password",
        inviteCode: code,
      },
    );
    expect(registered.statusCode, registered.body).toBe(200);
    const newUser = registered.json<{
      user: {
        id: string;
        consentVersion: string | null;
        consentAtUtc: string | null;
      };
    }>().user;
    expect(newUser).toMatchObject({ consentVersion: null, consentAtUtc: null });
    expect(app.control.getUser(newUser.id)).toMatchObject({
      consentVersion: null,
      consentAtUtc: null,
    });
    const friend = await register("friend1");
    const login = await friend.request("POST", "/api/hosted/auth/login", {
      username: "friend1",
      password: "testing-friend-password",
    });
    expect(String(login.headers["set-cookie"])).toMatch(
      /HttpOnly; SameSite=Strict; Secure/u,
    );
    expect(
      (
        await friend.request(
          "POST",
          "/api/hosted/auth/logout",
          {},
          { origin: "https://attacker.invalid" },
        )
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await friend.request("GET", "/api/hosted/me", undefined, {
          host: "attacker.invalid",
        })
      ).statusCode,
    ).toBe(421);
    expect(
      (await friend.request("GET", "/api/hosted/admin/users")).statusCode,
    ).toBe(404);
    expect(
      (await friend.request("PATCH", "/api/settings", { apiKey: "arbitrary" }))
        .statusCode,
    ).toBe(400);
    const models = await friend.request("GET", "/api/llm/providers");
    expect(models.body).toContain("朋友模型");
    expect(models.body).not.toMatch(/private-model|private-provider|mock-key/u);
  });
  it.each([
    { acceptedConsent: undefined, recorded: false },
    { acceptedConsent: false, recorded: false },
    { acceptedConsent: true, recorded: true },
  ])(
    "records legacy consent only when explicitly accepted: $acceptedConsent",
    async ({ acceptedConsent, recorded }) => {
      const { app, adminId } = await fixture();
      const anonymous = client(app.userApp, publicOrigin);
      const info = await anonymous.request("GET", "/api/hosted/info");
      const { code } = app.control.createInvite({}, adminId);
      const consentVersion = info.json<{ consentVersion: string }>()
        .consentVersion;
      const response = await anonymous.request(
        "POST",
        "/api/hosted/auth/register",
        {
          username: "legacy-friend",
          password: "testing-friend-password",
          inviteCode: code,
          consentVersion,
          ...(acceptedConsent === undefined ? {} : { acceptedConsent }),
        },
      );
      expect(response.statusCode, response.body).toBe(200);
      const { user } = response.json<{ user: { id: string } }>();
      const stored = app.control.getUser(user.id)!;
      expect(stored.consentVersion).toBe(recorded ? consentVersion : null);
      if (recorded) expect(stored.consentAtUtc).toBeTypeOf("string");
      else expect(stored.consentAtUtc).toBeNull();
    },
  );
  it("isolates characters, sessions, images and events before paid work; syncs another device and revokes banned sessions", async () => {
    const { app, admin, register, calls } = await fixture();
    const a = await register("alice"),
      b = await register("bob");
    const draftResponse = await a.request(
      "POST",
      "/api/characters/generate",
      characterInput,
      { "idempotency-key": "create-alice" },
    );
    expect(draftResponse.statusCode, draftResponse.body).toBe(201);
    const draft = draftResponse.json<{
      character: { id: string; version: number };
    }>().character;
    expect(
      (
        await a.request("POST", `/api/characters/${draft.id}/publish`, {
          expectedVersion: draft.version,
        })
      ).statusCode,
    ).toBe(200);
    const sessionResponse = await a.request(
      "POST",
      `/api/agents/${draft.id}/sessions`,
      {},
    );
    expect(sessionResponse.statusCode, sessionResponse.body).toBe(201);
    const sessionId: string = sessionResponse.json<{
      session: { id: string };
    }>().session.id;
    await a.request("POST", "/api/activity/visit", {});
    const achievementId: string = (
      await a.request("GET", "/api/achievements")
    ).json<{ items: Array<{ id: string }> }>().items[0]!.id;
    const before = calls.length;
    for (const path of [
      `/api/characters/${draft.id}`,
      `/api/agents/${draft.id}/events`,
      `/api/agents/${draft.id}/overview`,
      `/api/sessions/${sessionId}/messages`,
      `/api/sessions/${sessionId}/model`,
      `/api/achievements/${achievementId}/badge`,
    ]) {
      expect((await b.request("GET", path)).statusCode, path).toBe(404);
    }
    expect(
      (
        await b.request("POST", `/api/sessions/${sessionId}/messages`, {
          agentId: draft.id,
          text: "越权请求",
          clientMessageId: randomUUID(),
        })
      ).statusCode,
    ).toBe(404);
    expect(calls).toHaveLength(before);
    const anotherDevice = client(app.userApp, publicOrigin);
    await anotherDevice.request("GET", "/api/hosted/info");
    expect(
      (
        await anotherDevice.request("POST", "/api/hosted/auth/login", {
          username: "alice",
          password: "testing-friend-password",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await anotherDevice.request("GET", `/api/characters/${draft.id}`))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await admin.request("PATCH", `/api/hosted/admin/users/${a.userId}`, {
          status: "banned",
          reason: "测试封禁",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await anotherDevice.request("GET", "/api/hosted/me")).statusCode,
    ).toBe(401);
    expect(
      (await a.request("GET", `/api/characters/${draft.id}`)).statusCode,
    ).toBe(401);
  });
  it("captures multipart text imports before billing and detects changed file contents on repeated IDs", async () => {
    const { app, register, calls, adminId } = await fixture();
    const user = await register("upload");
    const makeBody = (source: string) =>
      Object.entries({
        characterName: "林夏",
        workTitle: "测试作品",
        storyStage: "第一章",
        tier: "lightweight",
        timezone: "Asia/Shanghai",
      })
        .map(
          ([name, value]) =>
            `--dearvale-test\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        )
        .join("") +
      `--dearvale-test\r\nContent-Disposition: form-data; name="file"; filename="source.txt"\r\nContent-Type: text/plain\r\n\r\n${source}\r\n--dearvale-test--\r\n`;
    const headers = {
      "content-type": "multipart/form-data; boundary=dearvale-test",
      "idempotency-key": "file-import-1",
    };
    const source = "林夏是一位认真温暖的研究生，正在完成毕业作品。";
    const first = await user.request(
      "POST",
      "/api/characters/import",
      makeBody(source),
      headers,
    );
    expect(first.statusCode, first.body).toBe(201);
    const count = calls.length;
    expect(
      (
        await user.request(
          "POST",
          "/api/characters/import",
          makeBody(source),
          headers,
        )
      ).body,
    ).toBe(first.body);
    expect(
      (
        await user.request(
          "POST",
          "/api/characters/import",
          makeBody("另一份角色材料"),
          headers,
        )
      ).statusCode,
    ).toBe(409);
    expect(calls).toHaveLength(count);
    const records = app.control.listResearch({
      userId: user.userId,
    });
    expect(
      records.some(
        (record) => record.kind === "input" || record.kind === "output",
      ),
    ).toBe(false);
    expect(
      records
        .filter((record) => record.kind === "request")
        .some((record) =>
          JSON.stringify(
            app.control.readResearch(record.id, adminId).payload,
          ).includes(source),
        ),
    ).toBe(true);
  });
  it("recovers a settled chat after business commit fails without another provider call or debit", async () => {
    const { app, register, calls, reopen } = await fixture();
    const user = await register("recovery");
    const draftResponse = await user.request(
      "POST",
      "/api/characters/generate",
      characterInput,
    );
    expect(draftResponse.statusCode, draftResponse.body).toBe(201);
    const draft = draftResponse.json<{
      character: { id: string; version: number };
    }>().character;
    await user.request("POST", `/api/characters/${draft.id}/publish`, {
      expectedVersion: draft.version,
    });
    const sessionResponse = await user.request(
      "POST",
      `/api/agents/${draft.id}/sessions`,
      {},
    );
    const sessionId: string = sessionResponse.json<{
      session: { id: string };
    }>().session.id;
    const { store, conversations } = (await app.runtimes.get(user.userId))
      .composition.routeServices;
    const errors: unknown[] = [];
    const originalChat = conversations.chat.bind(conversations);
    vi.spyOn(conversations, "chat").mockImplementation(async (...args) => {
      try {
        return await originalChat(...args);
      } catch (error) {
        errors.push(error);
        throw error;
      }
    });
    const insert = vi
      .spyOn(store, "insertMessage")
      .mockImplementationOnce(() => {
        throw new Error("injected business storage outage");
      });
    const input = {
      agentId: draft.id,
      text: "你好，今天想聊聊学习生活。",
      clientMessageId: "recover-chat-1",
    };
    const failed = await user.request(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      input,
    );
    expect(failed.statusCode, failed.body).toBe(500);
    expect(
      insert,
      errors
        .map((error) => (error instanceof Error ? error.stack : String(error)))
        .join("\n"),
    ).toHaveBeenCalled();
    insert.mockRestore();
    const previousCalls = calls.length,
      previousWallet = app.control.wallet(user.userId);
    expect(
      app.control.getOperation(user.userId, "chat:recover-chat-1")?.status,
    ).toBe("running");
    const restarted = await reopen();
    const reconnected = client(restarted.userApp, publicOrigin);
    await reconnected.request("GET", "/api/hosted/info");
    await reconnected.request("POST", "/api/hosted/auth/login", {
      username: "recovery",
      password: "testing-friend-password",
    });
    const recovered = await reconnected.request(
      "POST",
      `/api/sessions/${sessionId}/messages`,
      input,
    );
    expect(
      recovered.statusCode,
      errors
        .map((error) => (error instanceof Error ? error.stack : String(error)))
        .join("\n"),
    ).toBe(201);
    expect(
      recovered.json<{ assistantMessage: { content: string } }>()
        .assistantMessage.content,
    ).toBeTruthy();
    expect(calls).toHaveLength(previousCalls);
    expect(restarted.control.wallet(user.userId)).toEqual(previousWallet);
    const billing = await reconnected.request(
      "GET",
      "/api/hosted/billing?clientMessageId=recover-chat-1",
    );
    expect(
      billing
        .json<{ attempts: Array<{ purpose: string }> }>()
        .attempts.some(
          (attempt: { purpose: string }) => attempt.purpose === "chat_turn",
        ),
    ).toBe(true);
    expect(billing.body).not.toContain("private-model");
  });
  it("keeps thirty account runtimes resident with isolated databases and scheduler restoration", async () => {
    const { app, adminId, calls } = await fixture(true);
    const invite = app.control.createInvite({ maxUses: 30 }, adminId);
    const started = Date.now(),
      before = process.memoryUsage().rss;
    const users = Array.from({ length: 30 }, (_, index) =>
      app.control.registerUser({
        username: `capacity${index}`,
        passwordHash: "unused-hash",
        inviteCode: invite.code,
        consentVersion: "dearvale-friends-research-v1",
      }),
    );
    await app.runtimes.restore();
    const runtimeValues = await Promise.all(
      users.map((user) => app.runtimes.get(user.id)),
    );
    expect(
      new Set(
        runtimeValues.map(
          (runtime) => runtime.composition.routeServices.store.database.name,
        ),
      ).size,
    ).toBe(30);
    expect(app.runtimes.size).toBe(30);
    expect(calls).toHaveLength(0);
    await app.runtimes.quiesce();
    await app.runtimes.resumeAll();
    console.info(
      JSON.stringify({
        capacityAccounts: 30,
        initializationMs: Date.now() - started,
        rssMiB: Math.round(process.memoryUsage().rss / 1048576),
        rssIncreaseMiB: Math.round(
          (process.memoryUsage().rss - before) / 1048576,
        ),
      }),
    );
  }, 120000);
  it("preserves hosted security headers on both SSE routes through backup and disconnects banned accounts", async () => {
    const { app, register, admin } = await fixture();
    const user = await register("events");
    const generated = await user.request(
      "POST",
      "/api/characters/generate",
      characterInput,
    );
    expect(generated.statusCode, generated.body).toBe(201);
    const character = generated.json<{
      character: { id: string; version: number };
    }>().character;
    expect(
      (
        await user.request("POST", `/api/characters/${character.id}/publish`, {
          expectedVersion: character.version,
        })
      ).statusCode,
    ).toBe(200);
    await app.userApp.listen({ host: "127.0.0.1", port: 0 });
    const address = app.userApp.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test HTTP port");
    const streams: Array<{ response: IncomingMessage; ended: Promise<void> }> =
      [];
    try {
      for (const [path, contentType] of [
        ["/%61pi/achievements/events?test=1", "text/event-stream"],
        [
          `/api/agents/${character.id}/events`,
          "text/event-stream; charset=utf-8",
        ],
      ]) {
        // node:http permits the production Host while connecting only to this
        // temporary listener; fetch may overwrite Host with its local URL.
        const response = await new Promise<IncomingMessage>(
          (resolve, reject) => {
            const request = httpRequest(
              {
                host: "127.0.0.1",
                port: address.port,
                path,
                headers: {
                  host: new URL(publicOrigin).host,
                  cookie: user.cookies(),
                },
                signal: AbortSignal.timeout(20000),
              },
              resolve,
            );
            request.on("error", reject);
            request.end();
          },
        );
        const ended = finished(response, { cleanup: true });
        // Assertions or backup can fail before completion is awaited below.
        void ended.catch(() => undefined);
        streams.push({ response, ended });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toBe(contentType);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.headers["strict-transport-security"]).toBe(
          "max-age=31536000",
        );
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        expect(response.headers["referrer-policy"]).toBe("no-referrer");
        expect(response.headers["content-security-policy"]).toContain(
          "frame-ancestors 'none'",
        );
        expect(response.headers["x-accel-buffering"]).toBe("no");
        await new Promise<void>((resolve, reject) => {
          response.once("data", () => resolve());
          response.once("error", reject);
        });
      }
      const backup = await admin.request(
        "POST",
        "/api/hosted/%61dmin/maintenance/backup",
        { passphrase: "testing-backup-password" },
      );
      expect(backup.statusCode, backup.body).toBe(200);
      expect(backup.json<{ keyPath: string }>().keyPath).toMatch(/\.dvkeys$/u);
      expect(
        (
          await admin.request(
            "PATCH",
            `/api/hosted/admin/users/${user.userId}`,
            {
              status: "banned",
              reason: "event revocation",
            },
          )
        ).statusCode,
      ).toBe(200);
      await Promise.all(streams.map(({ ended }) => ended));
    } finally {
      for (const { response } of streams) response.destroy();
      await Promise.allSettled(streams.map(({ ended }) => ended));
    }
  }, 30000);
  it("bills real provider usage, replays identical requests, preserves research after business removal and redacts public receipts", async () => {
    const { app, register, calls, admin } = await fixture();
    const user = await register("metered");
    const key = { "idempotency-key": "durable-create" };
    const first = await user.request(
      "POST",
      "/api/characters/generate",
      characterInput,
      key,
    );
    expect(first.statusCode, first.body).toBe(201);
    const balance = app.control.wallet(user.userId).balanceMicros;
    const count = calls.length;
    expect(count).toBeGreaterThan(0);
    expect(balance).toBe(100_000_000 - count * 104);
    const replay = await user.request(
      "POST",
      "/api/characters/generate",
      characterInput,
      key,
    );
    expect(replay.body).toBe(first.body);
    expect(calls).toHaveLength(count);
    expect(app.control.wallet(user.userId).balanceMicros).toBe(balance);
    expect(
      (
        await user.request(
          "POST",
          "/api/characters/generate",
          { ...characterInput, name: "另一个人" },
          key,
        )
      ).statusCode,
    ).toBe(409);
    const bill = await user.request("GET", "/api/hosted/billing");
    expect(bill.body).not.toMatch(
      /private-model|private-provider|mock-key|rawUsage|system/u,
    );
    expect(bill.json<{ attempts: unknown[] }>().attempts[0]).toMatchObject({
      status: "settled",
      costMicros: 104,
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 40 },
    });
    const researchCount = app.control.listResearch({
      userId: user.userId,
      limit: 1000,
    }).length;
    expect(researchCount).toBe(count * 2);
    expect(
      app.control
        .listResearch({ userId: user.userId, limit: 1000 })
        .every(
          (record) => record.kind === "request" || record.kind === "response",
        ),
    ).toBe(true);
    expect(
      (
        await user.request(
          "DELETE",
          `/api/characters/${first.json<{ character: { id: string } }>().character.id}`,
          {},
        )
      ).statusCode,
    ).toBe(200);
    expect(
      app.control.listResearch({ userId: user.userId, limit: 1000 }).length,
    ).toBe(researchCount);
    // Old HTTP captures must not consume model-list pages or enter exports.
    const legacy = app.control.recordConversation({
      userId: user.userId,
      operationId: "old-time-query",
      kind: "output",
      payload: { serverTimeUtc: "2026-09-12T11:07:46.829Z" },
    });
    const listed = await admin.request(
      "GET",
      `/api/hosted/admin/research?userId=${user.userId}`,
    );
    expect(listed.statusCode).toBe(200);
    const records = listed.json<{
      records: Array<{ id: string; kind: string }>;
    }>().records;
    expect(records).toHaveLength(researchCount);
    expect(records.some((record) => record.id === legacy.id)).toBe(false);
    const exported = await admin.request(
      "POST",
      "/api/hosted/admin/research/export",
      { userId: user.userId },
    );
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain("serverTimeUtc");
    expect(exported.body.trim().split("\n")).toHaveLength(researchCount);
  });
  it("applies an administrator's retention policy without deleting current research", async () => {
    const { app, admin, adminId } = await fixture();
    const expired = app.control.recordConversation({
      userId: adminId,
      operationId: "expired-research",
      kind: "input",
      payload: "old research",
    });
    const current = app.control.recordConversation({
      userId: adminId,
      operationId: "current-research",
      kind: "input",
      payload: "current research",
    });
    app.control.researchDatabase
      .prepare("UPDATE research_records SET created_at=? WHERE id=?")
      .run("2020-01-01T00:00:00.000Z", expired.id);
    const response = await admin.request(
      "PATCH",
      "/api/hosted/admin/maintenance",
      { limits: { researchRetentionDays: 1 } },
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(app.control.listResearch({ id: expired.id })).toHaveLength(0);
    expect(app.control.listResearch({ id: current.id })).toHaveLength(1);
  });
  it("releases initialization locks after invalid public origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "dearvale-invalid-origin-"));
    opened.push({ root });
    await expect(
      buildHostedApps({
        rootDirectory: root,
        publicOrigin: "http://internet.example",
        adminOrigin,
        baseConfig: readConfig({
          profile: "test",
          llm: {
            provider: "fixture",
            baseUrl: "https://mock.invalid",
            model: "fixture",
            maxRetries: 0,
            timeoutMs: 1000,
          },
        }),
        startSchedulers: false,
      }),
    ).rejects.toThrow("HTTPS");
    const reopened = new HostedControlStore(root);
    reopened.close();
  });
});
