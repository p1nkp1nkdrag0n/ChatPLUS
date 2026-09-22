import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, expect, it, vi } from "vitest";
import { readConfig } from "../config.js";
import { buildHostedApps } from "./app.js";

vi.hoisted(() => {
  process.env.PERSONASIM_LOAD_ENV = "false";
});

const publicOrigin = "https://friends.example";
const adminOrigin = "http://127.0.0.1:3002";
const password = "testing-long-account-password";
const opened: {
  root: string;
  app: Awaited<ReturnType<typeof buildHostedApps>>;
}[] = [];

afterEach(async () => {
  for (const { root, app } of opened.splice(0)) {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

async function client(app: FastifyInstance, origin: string) {
  const info = await app.inject({
    method: "GET",
    url: "/api/hosted/info",
    headers: { host: new URL(origin).host },
  });
  expect(info.statusCode).toBe(200);
  const cookie = info.cookies
    .map((item) => `${item.name}=${item.value}`)
    .join("; ");
  const csrfToken = info.json<{ csrfToken: string }>().csrfToken;
  return (username: string, inputPassword = password) =>
    app.inject({
      method: "POST",
      url: "/api/hosted/auth/login",
      headers: {
        host: new URL(origin).host,
        origin,
        cookie,
        "x-csrf-token": csrfToken,
      },
      payload: { username, password: inputPassword },
    });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dearvale-auth-surface-"));
  const app = await buildHostedApps({
    rootDirectory: root,
    publicOrigin,
    adminOrigin,
    startSchedulers: false,
    baseConfig: readConfig({
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
        timeoutMs: 1000,
        maxRetries: 0,
      },
    }),
    transport: () =>
      Promise.reject(
        new Error("Provider access is forbidden in authentication tests."),
      ),
  });
  opened.push({ root, app });
  const admin = await app.auth.bootstrap("operator", password);
  app.control.setLimits({ registrationEnabled: true }, admin.user.id);
  const { code } = app.control.createInvite({}, admin.user.id);
  const user = await app.auth.register({
    username: "friend",
    password,
    inviteCode: code,
    confirmedAdult: true,
  });
  return {
    app,
    admin,
    user,
    publicLogin: await client(app.userApp, publicOrigin),
    adminLogin: await client(app.adminApp, adminOrigin),
  };
}

it("rejects public administrator credentials without locking local administration", async () => {
  const { admin, publicLogin, adminLogin } = await fixture();
  const rejected = await publicLogin(admin.user.accountName);
  expect(rejected.statusCode).toBe(401);
  expect(rejected.json<{ error: { code: string } }>().error.code).toBe(
    "invalid_credentials",
  );
  expect(
    rejected.cookies.some((cookie) => cookie.name.endsWith("_session")),
  ).toBe(false);

  for (let attempt = 0; attempt < 5; attempt++) {
    const failed = await publicLogin("operator", "wrong-password");
    expect(failed.statusCode).toBe(401);
    expect(failed.json<{ error: { code: string } }>().error.code).toBe(
      "invalid_credentials",
    );
  }

  const accepted = await adminLogin("operator");
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json<{ user: { id: string } }>().user.id).toBe(admin.user.id);
});

it("rejects ordinary credentials on the admin listener without locking public sign-in", async () => {
  const { user, publicLogin, adminLogin } = await fixture();
  for (let attempt = 0; attempt < 5; attempt++) {
    const rejected = await adminLogin(user.user.accountName);
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json<{ error: { code: string } }>().error.code).toBe(
      "invalid_credentials",
    );
    expect(
      rejected.cookies.some((cookie) => cookie.name.endsWith("_session")),
    ).toBe(false);
  }
  const accepted = await publicLogin(user.user.accountName);
  expect(accepted.statusCode).toBe(200);
  expect(accepted.json<{ user: { id: string } }>().user.id).toBe(user.user.id);
});

it("rejects existing sessions from the other role even when the cookie is renamed", async () => {
  const { app, admin, user } = await fixture();
  for (const [surface, origin, name, own, other] of [
    [app.userApp, publicOrigin, "user", user, admin],
    [app.adminApp, adminOrigin, "admin", admin, user],
  ] as const) {
    const accepted = await surface.inject({
      method: "GET",
      url: "/api/hosted/me",
      headers: {
        host: new URL(origin).host,
        cookie: `dearvale_${name}_session=${own.token}`,
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json<{ user: { id: string } }>().user.id).toBe(own.user.id);

    const rejected = await surface.inject({
      method: "GET",
      url: "/api/hosted/me",
      headers: {
        host: new URL(origin).host,
        cookie: `dearvale_${name}_session=${other.token}`,
      },
    });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.json<{ error: { code: string } }>().error.code).toBe(
      "login_required",
    );
    expect(
      rejected.cookies.find(
        (cookie) => cookie.name === `dearvale_${name}_session`,
      ),
    ).toMatchObject({ value: "", maxAge: 0 });
  }
});

it("keeps the administrator alias and account name in one local failure limit", async () => {
  const { admin, adminLogin } = await fixture();
  for (const username of [
    "operator",
    admin.user.accountName,
    " OPERATOR ",
    "ｏｐｅｒａｔｏｒ",
    admin.user.accountName,
  ]) {
    const rejected = await adminLogin(username, "wrong-password");
    expect(rejected.statusCode).toBe(401);
  }
  const throttled = await adminLogin("operator");
  expect(throttled.statusCode).toBe(429);
  expect(throttled.json<{ error: { code: string } }>().error.code).toBe(
    "login_throttled",
  );
  expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
});
