import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { LlmServiceError } from "../services/llm-service.js";
import type { HostedAuthService } from "./auth.js";
import { installHostedSecurity } from "./security.js";

describe("hosted public model errors", () => {
  it("reports an actionable revision conflict without exposing exception details", async () => {
    const app = Fastify();
    installHostedSecurity(app, {
      surface: "user",
      origin: "https://friends.example",
      auth: { authenticate: vi.fn() } as unknown as HostedAuthService,
    });
    app.get("/api/stale-model", () => {
      throw new LlmServiceError(
        "private-provider-model and secret-api-key",
        "model_revision_changed",
        { provider: "private-upstream", key: "secret-api-key" },
      );
    });
    app.get("/api/provider-failure", () => {
      throw new LlmServiceError("secret-api-key", "unrecognized_failure");
    });
    try {
      const conflict = await app.inject({
        url: "/api/stale-model",
        headers: { host: "friends.example" },
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({
        error: {
          code: "model_revision_changed",
          message: "模型配置已更新，请刷新页面后重试。",
        },
      });
      expect(conflict.body).not.toMatch(/private-|secret-api-key/u);
      expect(conflict.headers["cache-control"]).toBe("no-store");

      const unexpected = await app.inject({
        url: "/api/provider-failure",
        headers: { host: "friends.example" },
      });
      expect(unexpected.statusCode).toBe(500);
      expect(unexpected.json()).toMatchObject({
        error: {
          code: "internal_error",
          message: "请求未能完成，请稍后重试。",
        },
      });
      expect(unexpected.body).not.toContain("secret-api-key");
    } finally {
      await app.close();
    }
  });
});
