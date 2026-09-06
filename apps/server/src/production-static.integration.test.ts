import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";

describe("production Vite asset hosting", () => {
  let app: PersonaSimApp | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("serves exact assets and HTML navigation without swallowing API/SSE 404s", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-static-"));
    const dist = join(directory, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(
      join(dist, "index.html"),
      "<!doctype html><html><body>CHATPLUS-SELFHOSTED</body></html>",
      "utf8",
    );
    writeFileSync(join(dist, "assets", "app-hash.js"), "export {};", "utf8");
    app = await buildApp({
      config: readConfig({
        nodeEnv: "production",
        profile: "lightweight",
        databasePath: join(directory, "instance.sqlite"),
        seedDemo: false,
        serveWeb: true,
        webDistPath: dist,
      }),
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });

    const root = await app.inject({
      method: "GET",
      url: "/",
      headers: { accept: "text/html" },
    });
    const navigation = await app.inject({
      method: "GET",
      url: "/letters/thread-1",
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    const asset = await app.inject({
      method: "GET",
      url: "/assets/app-hash.js",
    });
    const health = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { accept: "text/html" },
    });
    const unknownApi = await app.inject({
      method: "GET",
      url: "/api/not-a-route",
      headers: { accept: "text/html" },
    });
    const unknownSse = await app.inject({
      method: "GET",
      url: "/events/not-a-route",
      headers: { accept: "text/html" },
    });
    const mutation = await app.inject({
      method: "POST",
      url: "/letters/thread-1",
      headers: { accept: "text/html" },
    });

    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("CHATPLUS-SELFHOSTED");
    expect(root.headers["cache-control"]).toBe("no-store");
    expect(navigation.statusCode).toBe(200);
    expect(navigation.body).toContain("CHATPLUS-SELFHOSTED");
    expect(navigation.headers["cache-control"]).toBe("no-store");
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ status: "ok" });
    for (const response of [unknownApi, unknownSse, mutation]) {
      expect(response.statusCode).toBe(404);
      expect(response.headers["content-type"]).toMatch(/application\/json/iu);
      expect(response.json()).toMatchObject({
        error: { code: "route_not_found" },
      });
    }
  });

  it("fails startup when SERVE_WEB points at an incomplete build", async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-static-missing-"));
    await expect(
      buildApp({
        config: readConfig({
          nodeEnv: "production",
          profile: "lightweight",
          databasePath: join(directory, "instance.sqlite"),
          seedDemo: false,
          serveWeb: true,
          webDistPath: join(directory, "missing-dist"),
        }),
        seedDemo: false,
        startScheduler: false,
        logger: false,
      }),
    ).rejects.toThrow(/SERVE_WEB requires a built Vite index/u);
  });
});
