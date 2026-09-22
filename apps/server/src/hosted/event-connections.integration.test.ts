import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../config.js";
import { buildHostedApps } from "./app.js";

vi.hoisted(() => {
  process.env.PERSONASIM_LOAD_ENV = "false";
});

const publicOrigin = "https://event-limits.example";
const adminOrigin = "http://127.0.0.1:3002";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dearvale-event-limits-"));
  const streams: IncomingMessage[] = [];
  const state: { app?: Awaited<ReturnType<typeof buildHostedApps>> } = {};
  cleanups.push(async () => {
    for (const stream of streams) stream.destroy();
    await state.app?.close();
    rmSync(root, { recursive: true, force: true });
  });
  const noNetwork: typeof fetch = () =>
    Promise.reject(
      new Error("Event connection tests must not call a model provider"),
    );
  const hosted = await buildHostedApps({
    rootDirectory: root,
    publicOrigin,
    adminOrigin,
    startSchedulers: false,
    transport: noNetwork,
    userTransport: noNetwork,
    baseConfig: readConfig({
      nodeEnv: "test",
      profile: "test",
      databasePath: ":memory:",
      seedDemo: false,
      developerRoutes: false,
      keepsakeMode: "off",
      correspondenceMode: "off",
      llm: {
        provider: "fixture",
        baseUrl: "https://fixture.invalid",
        model: "fixture",
        maxRetries: 0,
        timeoutMs: 1000,
      },
    }),
  });
  state.app = hosted;
  // Authentication is fixture data; the HTTP requests still traverse the real
  // session, CSRF, account-state and business-route hooks.
  const admin = hosted.control.createAdministrator("event-admin", "fixture");
  const adminToken = hosted.control.createSession(admin.id).token;
  hosted.control.setLimits({ registrationEnabled: true }, admin.id);
  const invite = hosted.control.createInvite({ maxUses: 2 }, admin.id);
  const register = async (name: string) => {
    const user = hosted.control.registerUser({
      username: name,
      passwordHash: "fixture",
      inviteCode: invite.code,
    });
    const runtime = await hosted.runtimes.get(user.id);
    const character =
      runtime.composition.routeServices.characters.createDemoCharacter();
    return {
      user,
      runtime,
      token: hosted.control.createSession(user.id).token,
      paths: [`/api/agents/${character.id}/events`, "/api/achievements/events"],
    };
  };
  await hosted.userApp.listen({ host: "127.0.0.1", port: 0 });
  const address = hosted.userApp.server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const open = async (token: string, path: string) => {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: address.port,
          path,
          agent: false,
          headers: {
            host: new URL(publicOrigin).host,
            cookie: `dearvale_user_session=${token}`,
          },
          signal: AbortSignal.timeout(20000),
        },
        resolve,
      );
      request.on("error", reject);
      request.end();
    });
    streams.push(response);
    let body = "";
    response.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    const ended = finished(response, { cleanup: true });
    void ended.catch(() => undefined);
    return { response, ended, body: () => body };
  };
  const mutate = async (
    target: FastifyInstance,
    surface: "user" | "admin",
    token: string,
    method: "POST" | "PATCH",
    path: string,
    payload?: object,
  ) => {
    const origin = surface === "admin" ? adminOrigin : publicOrigin;
    const sessionCookie = `dearvale_${surface}_session=${token}`;
    const info = await target.inject({
      method: "GET",
      url: "/api/hosted/info",
      headers: { host: new URL(origin).host, cookie: sessionCookie },
    });
    const csrfCookie = info.cookies.find(
      (cookie) => cookie.name === `dearvale_${surface}_csrf`,
    )!;
    return target.inject({
      method,
      url: path,
      ...(payload ? { payload } : {}),
      headers: {
        host: new URL(origin).host,
        origin,
        cookie: `${sessionCookie}; ${csrfCookie.name}=${csrfCookie.value}`,
        "x-csrf-token": info.json<{ csrfToken: string }>().csrfToken,
      },
    });
  };
  return { app: hosted, register, open, mutate, adminToken };
}

describe("hosted event connection budgets", () => {
  it("shares eight slots across event feeds and sessions, isolates accounts, and reuses disconnected slots", async () => {
    const f = await fixture();
    const a = await f.register("event-user-a");
    const b = await f.register("event-user-b");
    const secondDevice = f.app.control.createSession(a.user.id).token;
    const active = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        f.open(index < 4 ? a.token : secondDevice, a.paths[index % 2]!),
      ),
    );
    expect(active.map(({ response }) => response.statusCode)).toEqual(
      Array(8).fill(200),
    );
    const limited = await f.open(secondDevice, "/%61pi/achievements/events");
    expect(limited.response.statusCode).toBe(429);
    expect(limited.response.headers["retry-after"]).toBe("5");
    expect(limited.response.headers["content-type"]).toContain(
      "application/json",
    );
    await limited.ended;
    expect(JSON.parse(limited.body())).toMatchObject({
      error: { code: "event_connection_limit" },
    });
    expect((await f.open(b.token, b.paths[1]!)).response.statusCode).toBe(200);
    active[0]!.response.destroy();
    await vi.waitFor(() => {
      expect(a.runtime.composition.routeServices.sse.connectionCount()).toBe(3);
    });
    expect((await f.open(secondDevice, a.paths[1]!)).response.statusCode).toBe(
      200,
    );
  });

  it.each(["logout", "ban"] as const)(
    "closes all event feeds on %s and restores all slots when access resumes",
    async (action) => {
      const f = await fixture();
      const a = await f.register(`event-${action}`);
      const active = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          f.open(a.token, a.paths[index % 2]!),
        ),
      );
      expect(active.every(({ response }) => response.statusCode === 200)).toBe(
        true,
      );
      const result =
        action === "logout"
          ? await f.mutate(
              f.app.userApp,
              "user",
              a.token,
              "POST",
              "/api/hosted/auth/logout",
            )
          : await f.mutate(
              f.app.adminApp,
              "admin",
              f.adminToken,
              "PATCH",
              `/api/hosted/admin/users/${a.user.id}`,
              {
                status: "banned",
                reason: "event limit lifecycle test",
              },
            );
      expect(result.statusCode, result.body).toBe(200);
      await Promise.all(active.map(({ ended }) => ended));
      if (action === "ban") {
        const restored = await f.mutate(
          f.app.adminApp,
          "admin",
          f.adminToken,
          "PATCH",
          `/api/hosted/admin/users/${a.user.id}`,
          {
            status: "active",
            reason: "event limit lifecycle test complete",
          },
        );
        expect(restored.statusCode, restored.body).toBe(200);
      }
      const token = f.app.control.createSession(a.user.id).token;
      const replacement = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          f.open(token, a.paths[index % 2]!),
        ),
      );
      expect(replacement.map(({ response }) => response.statusCode)).toEqual(
        Array(8).fill(200),
      );
    },
  );
});
