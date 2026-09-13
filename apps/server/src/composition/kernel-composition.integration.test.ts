import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import { AchievementService } from "../services/achievement-service.js";
import { TemporalTaskScheduler } from "../runtime/temporal-task-scheduler.js";
import { SseHub } from "../sse/hub.js";
import { composeServer } from "./compose-server.js";
function config(lifePlanningMode: "fuzzy" | "legacy_exact" = "fuzzy") {
  return readConfig({
    nodeEnv: "test",
    profile: "daily",
    databasePath: ":memory:",
    clockMode: "fake",
    lifePlanningMode,
    developerRoutes: true,
    llm: {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "fixture",
      timeoutMs: 1000,
      maxRetries: 0,
    },
  });
}
describe("static server composition", () => {
  it("serves the injected clock and omits retired writers in the default runtime", async () => {
    const database = openDatabase(":memory:");
    const clock = new FakeClock("2026-08-16T02:00:00.000Z");
    const app = await buildApp({
      config: config(),
      database,
      clock,
      logger: false,
      startScheduler: false,
    });
    try {
      expect(app.personasim.clock).toBe(clock);
      const services = app.personasim.kernel.services;
      for (const key of [
        "schedules",
        "settlements",
        "personalLife",
        "personalIntents",
        "selfPlanning",
      ] as const)
        expect(services[key], key).toBeUndefined();
      expect(services).not.toHaveProperty("proactiveDelivery");
      expect(services).not.toHaveProperty("conversationActivity");
      expect(
        (await app.inject({ method: "GET", url: "/api/health" })).json(),
      ).toMatchObject({ serverTimeUtc: clock.nowUtc() });
      const list = vi.spyOn(services.characters, "list");
      expect(
        (await app.inject({ method: "GET", url: "/api/characters" }))
          .statusCode,
      ).toBe(200);
      expect(list).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
    expect(database.open).toBe(false);
  });
  it("composes the old writer only for explicit legacy_exact regression", async () => {
    const app = await buildApp({
      config: config("legacy_exact"),
      logger: false,
    });
    try {
      expect(app.personasim.schedules).toBeDefined();
      expect(app.personasim.settlements).toBeDefined();
      expect(app.personasim.kernel.services.selfPlanning).toBeDefined();
      expect(app.personasim).not.toHaveProperty("proactiveDelivery");
    } finally {
      await app.close();
    }
  });
  it("cleans remaining resources and closes the DB even if a disposer fails", async () => {
    const database = openDatabase(":memory:");
    const composition = await composeServer({
      config: config(),
      database,
      logger: Fastify({ logger: false }).log,
    });
    const sseClose = vi.spyOn(composition.routeServices.sse, "close");
    const stop = vi.spyOn(composition.routeServices.achievements, "stop");
    vi.spyOn(
      composition.temporalTaskScheduler,
      "dispose",
    ).mockRejectedValueOnce(new Error("cleanup fixture"));
    await expect(composition.dispose("fastify_close")).rejects.toThrow(
      "Server cleanup failed",
    );
    expect(stop).toHaveBeenCalledOnce();
    expect(sseClose).toHaveBeenCalledOnce();
    expect(database.open).toBe(false);
    await expect(composition.dispose("fastify_close")).rejects.toThrow(
      "Server cleanup failed",
    );
    expect(stop).toHaveBeenCalledOnce();
  });
  it("rolls back all resources if a late startup step fails", async () => {
    const database = openDatabase(":memory:");
    vi.spyOn(AchievementService.prototype, "start").mockImplementationOnce(
      () => {
        throw new Error("startup fixture");
      },
    );
    const temporalDispose = vi.spyOn(
      TemporalTaskScheduler.prototype,
      "dispose",
    );
    const sseClose = vi.spyOn(SseHub.prototype, "close");
    await expect(
      composeServer({
        config: config(),
        database,
        logger: Fastify({ logger: false }).log,
      }),
    ).rejects.toThrow("startup fixture");
    expect(temporalDispose).toHaveBeenCalledOnce();
    expect(sseClose).toHaveBeenCalledOnce();
    expect(database.open).toBe(false);
  });
});
