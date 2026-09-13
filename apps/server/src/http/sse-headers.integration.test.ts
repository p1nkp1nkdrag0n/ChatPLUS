import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";

vi.hoisted(() => {
  process.env.PERSONASIM_LOAD_ENV = "false";
});

it("preserves standalone SSE content types, cache policy, and initial events on both routes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dearvale-sse-headers-"));
  let app: PersonaSimApp | undefined;
  try {
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "test",
        databasePath: join(directory, "test.db"),
        assetStoragePath: join(directory, "assets"),
        developerRoutes: false,
        seedDemo: false,
        keepsakeMode: "off",
        correspondenceMode: "off",
        llm: {
          provider: "fixture",
          baseUrl: "https://fixture.invalid",
          model: "fixture",
          timeoutMs: 1000,
          maxRetries: 0,
        },
      }),
      startScheduler: false,
      logger: false,
    });
    const character = await app.personasim.characters.generate({
      name: "SSE 测试角色",
      worldSetting: "当代城市生活",
      workOrRole: "插画师",
      coreTraits: ["温和", "认真"],
      dialogueStyle: "自然",
      tier: "lightweight",
      timezone: "Asia/Shanghai",
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test HTTP port");
    for (const [path, contentType, event] of [
      ["/api/achievements/events", "text/event-stream", "achievements.changed"],
      [
        `/api/agents/${character.id}/events`,
        "text/event-stream; charset=utf-8",
        "ready",
      ],
    ]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, {
        signal: AbortSignal.timeout(10000),
      });
      const reader = response.body!.getReader();
      try {
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe(contentType);
        expect(response.headers.get("cache-control")).toBe(
          "no-cache, no-transform",
        );
        expect(response.headers.get("strict-transport-security")).toBeNull();
        expect(response.headers.get("x-accel-buffering")).toBe("no");
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(new TextDecoder().decode(first.value)).toContain(
          `event: ${event}`,
        );
      } finally {
        await reader.cancel();
      }
    }
  } finally {
    await app?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
