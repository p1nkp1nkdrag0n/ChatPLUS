import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createServer } from "vite";

import { buildApp } from "../../apps/server/src/app.js";
import { readConfig } from "../../apps/server/src/config.js";
import { FakeClock } from "../../apps/server/src/runtime/clock.js";

const API_PORT = Number(process.env["CHATPLUS_E2E_API_PORT"] ?? "3001");
// Keep E2E isolated from Vite's development port. On Windows, 5173 can fall
// inside a Hyper-V/WSL excluded range and fail with EACCES before tests start.
const WEB_PORT = Number(process.env["CHATPLUS_E2E_WEB_PORT"] ?? "43173");
const E2E_INSTANCE_SECRET = Buffer.alloc(32, 0x65).toString("base64");

export default async function globalSetup() {
  const disposableRoot = mkdtempSync(join(tmpdir(), "chatplus-e2e-"));
  const clock = new FakeClock("2026-09-03T04:00:00.000Z");
  let api: Awaited<ReturnType<typeof buildApp>> | undefined;
  let web: Awaited<ReturnType<typeof createServer>> | undefined;
  let disposed = false;

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      if (web !== undefined) await web.close();
    } finally {
      try {
        if (api !== undefined) await api.close();
      } finally {
        rmSync(disposableRoot, { recursive: true, force: true });
      }
    }
  };

  try {
    const serverConfig = readConfig({
      nodeEnv: "test",
      profile: "test",
      port: API_PORT,
      host: "127.0.0.1",
      databasePath: join(disposableRoot, "e2e.db"),
      assetStoragePath: join(disposableRoot, "assets"),
      clockMode: "fake",
      lifePlanningMode: "fuzzy",
      scheduleNegotiationMode: "legacy",
      seedDemo: false,
      developerRoutes: true,
      correspondenceMode: "enforced",
      correspondenceExecution: "lazy",
      correspondenceTransitPolicy: "fixed_5d_v1",
      correspondenceGenerationLeaseMs: 60_000,
      correspondenceMaxOpenThreads: 1,
      keepsakeMode: "enforced",
      instanceSecret: E2E_INSTANCE_SECRET,
      llm: {
        provider: "fixture",
        baseUrl: "https://example.invalid",
        model: "personasim-fixture-v1",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
    });
    api = await buildApp({
      config: serverConfig,
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
    await api.listen({ port: API_PORT, host: "127.0.0.1" });
    web = await createServer({
      root: resolve("apps/web"),
      configFile: resolve("apps/web/vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: WEB_PORT,
        strictPort: true,
        proxy: {
          "/api": {
            target: `http://127.0.0.1:${API_PORT}`,
            changeOrigin: false,
          },
        },
      },
    });
    await web.listen();

    return dispose;
  } catch (error) {
    await dispose();
    throw error;
  }
}
