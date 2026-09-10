import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { DatabaseStore } from "./db/store.js";
import { FakeClock } from "./runtime/clock.js";

describe("reply goal review settings", () => {
  let app: PersonaSimApp;

  beforeEach(async () => {
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "test",
        databasePath: ":memory:",
        seedDemo: false,
        clockMode: "fake",
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      database: openDatabase(":memory:"),
      clock: new FakeClock("2026-09-10T04:00:00.000Z"),
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
  });

  afterEach(async () => {
    await app?.close();
  });

  it("defaults off, persists both toggle values, and preserves other preferences", async () => {
    const initial = await app.inject({ method: "GET", url: "/api/settings" });
    expect(
      initial.json<{ settings: Record<string, unknown> }>().settings
        .replyGoalReviewEnabled,
    ).toBe(false);
    const enabled = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: { replyGoalReviewEnabled: true, locale: "zh-CN" },
    });
    expect(enabled.statusCode).toBe(200);
    expect(
      enabled.json<{ settings: Record<string, unknown> }>().settings
        .replyGoalReviewEnabled,
    ).toBe(true);
    const independentStore = new DatabaseStore(app.personasim.store.database);
    expect(independentStore.getSettings()).toMatchObject({
      replyGoalReviewEnabled: true,
      locale: "zh-CN",
    });
    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { replyGoalReviewEnabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    const reloaded = await app.inject({ method: "GET", url: "/api/settings" });
    expect(
      reloaded.json<{ settings: Record<string, unknown> }>().settings,
    ).toMatchObject({
      replyGoalReviewEnabled: false,
      locale: "zh-CN",
    });
    expect(independentStore.getSettings().replyGoalReviewEnabled).toBe(false);
  });

  it.each(["true", "false", 1, null, {}])(
    "rejects non-boolean review preferences without changing saved state (%s)",
    async (value) => {
      await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { replyGoalReviewEnabled: true },
      });
      const response = await app.inject({
        method: "PUT",
        url: "/api/settings",
        payload: { replyGoalReviewEnabled: value, locale: "en-US" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json<{ error: { code: string } }>().error.code).toBe(
        "validation_error",
      );
      expect(app.personasim.store.getSettings().replyGoalReviewEnabled).toBe(
        true,
      );
      expect(app.personasim.store.getSettings().locale).toBeUndefined();
    },
  );
});
