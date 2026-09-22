import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { HostedAuthService } from "./auth.js";
import { installHostedSecurity } from "./security.js";

describe("hosted browser security boundaries", () => {
  it.each([
    { path: "/api/private", host: "friends.example", status: 200 },
    { path: "/missing", host: "friends.example", status: 404 },
    { path: "/api/private", host: "unexpected.example", status: 421 },
  ])("protects $status responses", async ({ path, host, status }) => {
    const app = Fastify();
    installHostedSecurity(app, {
      surface: "user",
      origin: "https://friends.example",
      auth: { authenticate: vi.fn() } as unknown as HostedAuthService,
    });
    app.get("/api/private", (_request, reply) =>
      reply.header("cache-control", "public, max-age=3600").send({ ok: true }),
    );
    try {
      const response = await app.inject({ url: path, headers: { host } });
      expect(response.statusCode).toBe(status);
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["cross-origin-resource-policy"]).toBe(
        "same-origin",
      );
      expect(response.headers["permissions-policy"]).toBe(
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      );
      expect(response.headers["content-security-policy"]).toContain(
        "form-action 'self'",
      );
      expect(response.headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers["strict-transport-security"]).toBe(
        "max-age=31536000",
      );
      if (path.startsWith("/api/"))
        expect(response.headers["cache-control"]).toBe("no-store");
    } finally {
      await app.close();
    }
  });

  it("keeps the local HTTP management console usable without setting HSTS", async () => {
    const app = Fastify();
    installHostedSecurity(app, {
      surface: "admin",
      origin: "http://127.0.0.1:3002",
      auth: { authenticate: vi.fn() } as unknown as HostedAuthService,
    });
    app.get("/admin", () => "local console");
    try {
      const response = await app.inject({
        url: "/admin",
        headers: { host: "127.0.0.1:3002" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["strict-transport-security"]).toBeUndefined();
      expect(response.headers["content-security-policy"]).toContain(
        "form-action 'self'",
      );
    } finally {
      await app.close();
    }
  });
});
