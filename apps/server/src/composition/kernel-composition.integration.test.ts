import { CLOCK_SERVICE_TOKEN } from "@personasim/kernel";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import { SERVER_PLUGIN_IDS } from "./plugins.js";
import {
  CHARACTER_SERVICE_TOKEN,
  SERVER_LLM_SERVICE_TOKEN,
} from "./service-tokens.js";

describe("server microkernel composition", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
  });

  it("routes through topologically activated, registry-owned services and disposes them", async () => {
    const clock = new FakeClock("2026-08-16T02:00:00.000Z");
    const database = openDatabase(":memory:");
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "daily",
        databasePath: ":memory:",
        clockMode: "fake",
        seedDemo: false,
        developerRoutes: true,
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      database,
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });

    const { kernel } = app.personasim;
    expect(kernel.bundle.id).toBe("daily");
    expect(kernel.pluginIds).toEqual([
      "server.bundle.daily",
      SERVER_PLUGIN_IDS.infrastructure,
      SERVER_PLUGIN_IDS.domain,
      SERVER_PLUGIN_IDS.scheduler,
    ]);
    expect(kernel.registry.resolve(CLOCK_SERVICE_TOKEN)).toBe(clock);
    expect(kernel.registry.resolve(SERVER_LLM_SERVICE_TOKEN)).toBe(
      app.personasim.llm,
    );
    const registeredCharacters = kernel.registry.resolve(
      CHARACTER_SERVICE_TOKEN,
    );
    expect(registeredCharacters).toBe(app.personasim.characters);

    const nowSpy = vi.spyOn(clock, "nowUtc");
    const listSpy = vi.spyOn(registeredCharacters, "list");
    const health = await app.inject({ method: "GET", url: "/api/health" });
    const characters = await app.inject({
      method: "GET",
      url: "/api/characters",
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      serverTimeUtc: "2026-08-16T02:00:00.000Z",
      profile: "daily",
      llmProvider: "fixture",
    });
    expect(characters.statusCode).toBe(200);
    expect(nowSpy).toHaveBeenCalled();
    expect(listSpy).toHaveBeenCalledOnce();

    let stoppingReason: string | undefined;
    kernel.events.once("server.stopping", (event) => {
      stoppingReason = event.reason;
    });
    await app.close();
    app = undefined;

    expect(stoppingReason).toBe("fastify_close");
    expect(kernel.runtime.activePluginIds).toEqual([]);
    expect(kernel.registry.has(CLOCK_SERVICE_TOKEN)).toBe(false);
    expect(kernel.registry.has(CHARACTER_SERVICE_TOKEN)).toBe(false);
    expect(database.open).toBe(false);
  });
});
