import { resolve } from "node:path";

import { createServer } from "vite";

import { buildApp } from "../../apps/server/src/app.js";
import { readConfig } from "../../apps/server/src/config.js";
import { FakeClock } from "../../apps/server/src/runtime/clock.js";

const API_PORT = 3001;
// Keep E2E isolated from Vite's development port. On Windows, 5173 can fall
// inside a Hyper-V/WSL excluded range and fail with EACCES before tests start.
const WEB_PORT = Number(process.env["CHATPLUS_E2E_WEB_PORT"] ?? "43173");

export default async function globalSetup() {
  const clock = new FakeClock("2026-08-16T10:00:00.000Z");
  const serverConfig = readConfig({
    nodeEnv: "test",
    profile: "test",
    port: API_PORT,
    host: "127.0.0.1",
    databasePath: ":memory:",
    clockMode: "fake",
    lifePlanningMode: "fuzzy",
    scheduleNegotiationMode: "legacy",
    seedDemo: false,
    developerRoutes: true,
    llm: {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
  });
  const api = await buildApp({
    config: serverConfig,
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });

  try {
    await api.listen({ port: API_PORT, host: "127.0.0.1" });
    const web = await createServer({
      root: resolve("apps/web"),
      configFile: resolve("apps/web/vite.config.ts"),
      server: { host: "127.0.0.1", port: WEB_PORT, strictPort: true },
    });
    await web.listen();

    return async () => {
      await web.close();
      await api.close();
    };
  } catch (error) {
    await api.close();
    throw error;
  }
}
