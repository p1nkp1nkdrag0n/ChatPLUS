import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../config.js";
import { buildHostedApps } from "./app.js";
import { HostedError } from "./types.js";

vi.hoisted(() => {
  process.env.PERSONASIM_LOAD_ENV = "false";
});

const opened: Array<{
  root: string;
  hosted?: Awaited<ReturnType<typeof buildHostedApps>>;
}> = [];

async function fixture(trustedProxies?: string) {
  const entry: (typeof opened)[number] = {
    root: mkdtempSync(join(tmpdir(), "dearvale-trusted-proxies-")),
  };
  opened.push(entry);
  entry.hosted = await buildHostedApps({
    rootDirectory: entry.root,
    publicOrigin: "https://friends.example",
    adminOrigin: "http://127.0.0.1:3002",
    ...(trustedProxies === undefined ? {} : { trustedProxies }),
    startSchedulers: false,
    baseConfig: readConfig({
      nodeEnv: "test",
      profile: "test",
      databasePath: ":memory:",
      seedDemo: false,
      developerRoutes: false,
      correspondenceMode: "off",
      keepsakeMode: "off",
      llm: {
        provider: "fixture",
        baseUrl: "https://mock.invalid",
        model: "fixture",
        timeoutMs: 1000,
        maxRetries: 0,
      },
    }),
  });
  return entry.hosted;
}

afterEach(async () => {
  for (const entry of opened.splice(0)) {
    await entry.hosted?.close();
    rmSync(entry.root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

describe("hosted forwarded request security", () => {
  it.each([undefined, "127.0.0.1"])(
    "uses forwarded IPs only when the socket peer is trusted (%s)",
    async (trustedProxies) => {
      const hosted = await fixture(trustedProxies);
      vi.spyOn(hosted.auth, "login").mockRejectedValue(
        new HostedError(401, "invalid_credentials", "用户名或密码错误。"),
      );
      for (const [app, origin] of [
        [hosted.userApp, "https://friends.example"],
        [hosted.adminApp, "http://127.0.0.1:3002"],
      ] as const) {
        const host = new URL(origin).host;
        const info = await app.inject({
          url: "/api/hosted/info",
          headers: { host },
        });
        const headers = {
          host,
          origin,
          cookie: info.cookies
            .map((cookie) => `${cookie.name}=${cookie.value}`)
            .join("; "),
          "x-csrf-token": info.json<{ csrfToken: string }>().csrfToken,
        };
        const login = (forwarded: string, peer = "127.0.0.1") =>
          app.inject({
            method: "POST",
            url: "/api/hosted/auth/login",
            remoteAddress: peer,
            headers: { ...headers, "x-forwarded-for": forwarded },
            payload: { username: "test-user", password: "test-password" },
          });
        for (let attempt = 0; attempt < 10; attempt++)
          expect((await login("203.0.113.7")).statusCode).toBe(401);
        expect((await login("203.0.113.7")).statusCode).toBe(429);
        expect((await login("203.0.113.8")).statusCode).toBe(
          trustedProxies ? 401 : 429,
        );
        // An untrusted socket must not escape its own limit by rotating XFF.
        for (let attempt = 0; attempt < 10; attempt++)
          expect(
            (await login(`198.51.100.${attempt + 1}`, "127.0.0.2")).statusCode,
          ).toBe(401);
        expect((await login("198.51.100.99", "127.0.0.2")).statusCode).toBe(
          429,
        );
      }
    },
  );

  it("retains raw Host and Origin checks and secure cookies behind a trusted proxy", async () => {
    const hosted = await fixture("127.0.0.1");
    for (const [app, origin] of [
      [hosted.userApp, "https://friends.example"],
      [hosted.adminApp, "http://127.0.0.1:3002"],
    ] as const) {
      const host = new URL(origin).host;
      const forwarded = {
        "x-forwarded-for": "203.0.113.7",
        "x-forwarded-host": host,
        "x-forwarded-proto": "https",
      };
      const wrongHost = await app.inject({
        url: "/api/health",
        headers: { host: "untrusted.example", ...forwarded },
      });
      expect(wrongHost.statusCode).toBe(421);
      expect(wrongHost.json()).toMatchObject({
        error: { code: "invalid_host" },
      });
      const wrongOrigin = await app.inject({
        method: "POST",
        url: "/api/hosted/auth/login",
        headers: { host, origin: "https://untrusted.example", ...forwarded },
        payload: {},
      });
      expect(wrongOrigin.statusCode).toBe(403);
      expect(wrongOrigin.json()).toMatchObject({
        error: { code: "invalid_origin" },
      });
      const info = await app.inject({
        url: "/api/hosted/info",
        headers: { host, ...forwarded, "x-forwarded-proto": "http" },
      });
      expect(info.statusCode).toBe(200);
      if (origin.startsWith("https:")) {
        expect(info.headers["strict-transport-security"]).toBe(
          "max-age=31536000",
        );
        expect(info.cookies[0]?.secure).toBe(true);
      }
    }
  });
});
