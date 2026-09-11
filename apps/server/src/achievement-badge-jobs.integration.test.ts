import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureImageGenerationProvider } from "@personasim/providers";
import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { openDatabase, type Database } from "./db/connection.js";
import { FakeClock } from "./runtime/clock.js";
import { AchievementService } from "./services/achievement-service.js";

const NOW = "2026-09-03T04:00:00.000Z";
const configInput = {
  protocol: "openai-compatible" as const,
  baseUrl: "https://images.example.test/v1",
  model: "test-image",
  enabled: false,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("achievement image job lifecycle", () => {
  let app: PersonaSimApp;
  let directory: string;
  let clock: FakeClock;
  const services: AchievementService[] = [];
  const connections: Database[] = [];
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-badge-jobs-"));
    clock = new FakeClock(NOW);
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        databasePath: join(directory, "test.db"),
        assetStoragePath: join(directory, "assets"),
        developerRoutes: true,
        clockMode: "fake",
        seedDemo: false,
        keepsakeMode: "off",
        instanceSecret: Buffer.alloc(32, 0x42).toString("base64"),
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "fixture",
          timeoutMs: 1000,
          maxRetries: 0,
        },
      }),
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
    // Tests drive dedicated workers and real persisted leases deterministically.
    await app.personasim.achievements.stop();
  });
  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.stop()));
    for (const database of connections.splice(0)) database.close();
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function worker(request: typeof fetch, separateConnection = false) {
    const database = separateConnection
      ? openDatabase(join(directory, "test.db"))
      : app.personasim.store.database;
    if (separateConnection) connections.push(database);
    const service = new AchievementService(database, clock, {
      databasePath: join(directory, "test.db"),
      assetRoot: join(directory, "badges"),
      fetch: request,
      developerMode: true,
    });
    services.push(service);
    return service;
  }
  async function unlock(closeness = 0.9) {
    const draft = await app.personasim.characters.generate({
      name: "林间",
      worldSetting: "当代城市",
      workOrRole: "植物学家",
      coreTraits: ["温和"],
      dialogueStyle: "自然",
      tier: "daily",
      timezone: "Asia/Shanghai",
    });
    const character = app.personasim.characters.publish(draft.id);
    const state = app.personasim.store.getRuntimeState(character.id)!;
    state.relationship.closeness = closeness;
    state.revision += 1;
    app.personasim.store.updateRuntimeState(state);
    return app.personasim.achievements
      .list({})
      .items.filter((item) => item.badge.status === "pending");
  }
  function enable(service: AchievementService) {
    // Seed persisted settings without waking a second, unobserved background
    // pass; each test explicitly starts the worker action under inspection.
    service.database
      .prepare(
        "UPDATE achievement_image_settings SET enabled=1,protocol=?,base_url=?,model=?",
      )
      .run(configInput.protocol, configInput.baseUrl, configInput.model);
  }
  function jobs() {
    return app.personasim.store.database
      .prepare(
        "SELECT achievement_id,status,attempts,error_code FROM achievement_badge_jobs ORDER BY achievement_id",
      )
      .all() as {
      achievement_id: string;
      status: string;
      attempts: number;
      error_code: string | null;
    }[];
  }
  async function imageResponse() {
    const asset = await createFixtureImageGenerationProvider().generate({
      visualSpec: {
        version: "achievement_badge_v2",
        subject: "a leaf",
        setting: "a garden",
        motifs: ["leaf"],
        palette: ["#EDF3E9", "#426450"],
        theme: "memento",
        finish: "gold",
      },
      width: 64,
      height: 64,
      idempotencyKey: "image-job-fixture",
    });
    return {
      data: [{ b64_json: Buffer.from(asset.bytes).toString("base64") }],
    };
  }

  it.each([429, 503])(
    "retries a known HTTP %s rejection at most twice, respecting backoff",
    async (status) => {
      const request = vi
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(json({}, status)));
      const service = worker(request);
      const [achievement] = await unlock();
      enable(service);
      await service.processNext();
      expect(jobs()[0]).toMatchObject({
        status: "pending",
        attempts: 1,
        error_code: "image_temporarily_unavailable",
      });
      await service.processNext();
      expect(request).toHaveBeenCalledTimes(1);
      clock.setUtc("2026-09-03T04:01:00.000Z");
      await service.processNext();
      expect(jobs()[0]).toMatchObject({ status: "pending", attempts: 2 });
      clock.setUtc("2026-09-03T04:02:59.000Z");
      await service.processNext();
      expect(request).toHaveBeenCalledTimes(2);
      clock.setUtc("2026-09-03T04:03:00.000Z");
      await service.processNext();
      expect(jobs()[0]).toMatchObject({ status: "failed", attempts: 3 });
      clock.setUtc("2026-09-04T04:03:00.000Z");
      await service.processNext();
      expect(request).toHaveBeenCalledTimes(3);
      expect(
        new Set(
          request.mock.calls.map(([, init]) =>
            new Headers(init?.headers).get("idempotency-key"),
          ),
        ).size,
      ).toBe(1);
      expect(service.get(achievement!.id).badge).toEqual({
        key: "star",
        status: "failed",
      });
    },
  );

  it.each([
    { status: 200, body: { data: [] }, code: "image_missing_output" },
    { status: 401, body: {}, code: "image_credentials_rejected" },
  ])(
    "keeps $code visible as a failed drawing without retrying or revoking the achievement",
    async ({ status, body, code }) => {
      const request = vi
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(json(body, status)));
      const service = worker(request);
      const [achievement] = await unlock();
      enable(service);
      await service.processNext();
      clock.setUtc("2026-09-04T04:00:00.000Z");
      await service.processNext();
      expect(request).toHaveBeenCalledOnce();
      expect(jobs()[0]).toMatchObject({
        status: "failed",
        attempts: 1,
        error_code: code,
      });
      expect(service.get(achievement!.id)).toMatchObject({
        title: achievement!.title,
        unlockedAtUtc: achievement!.unlockedAtUtc,
      });
    },
  );

  it("preserves an uncertain interrupted request for manual retry across worker restart", async () => {
    const request = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("interrupted", "AbortError")),
            { once: true },
          );
        }),
    );
    const service = worker(request);
    await unlock();
    enable(service);
    service.wake();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await service.stop();
    expect(jobs()[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      error_code: "image_outcome_unknown",
    });
    clock.setUtc("2026-09-04T04:00:00.000Z");
    await worker(request, true).processNext();
    expect(request).toHaveBeenCalledOnce();
  });

  it("serializes work across two service instances and two database connections", async () => {
    const content = await imageResponse();
    let resolveFirst: ((response: Response) => void) | undefined;
    const request = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementation(() => Promise.resolve(json(content)));
    const first = worker(request);
    const second = worker(request, true);
    await unlock(1);
    enable(first);
    const firstRun = first.processNext();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    await Promise.all([first.processNext(), second.processNext()]);
    expect(request).toHaveBeenCalledOnce();
    expect(jobs().filter((job) => job.status === "generating")).toHaveLength(1);
    expect(jobs().filter((job) => job.status === "pending")).toHaveLength(1);
    resolveFirst!(json(content));
    await firstRun;
    await second.processNext();
    expect(request).toHaveBeenCalledTimes(2);
    expect(
      jobs().every((job) => job.status === "ready" && job.attempts === 1),
    ).toBe(true);
    await Promise.all([first.processNext(), second.processNext()]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("keeps unconfigured badges pending, then resumes persisted work after enabling a restarted worker", async () => {
    const content = await imageResponse();
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(json(content)));
    const first = worker(request);
    const [achievement] = await unlock();
    await first.processNext();
    expect(request).not.toHaveBeenCalled();
    expect(jobs()[0]).toMatchObject({ status: "pending", attempts: 0 });
    expect(first.get(achievement!.id).badge).toEqual({
      key: "star",
      status: "pending",
    });
    await first.stop();
    const restarted = worker(request, true);
    enable(restarted);
    restarted.start();
    await vi.waitFor(() =>
      expect(restarted.get(achievement!.id).badge.status).toBe("ready"),
    );
    expect(request).toHaveBeenCalledOnce();
    expect(
      (await restarted.readAsset(achievement!.id, false)).byteLength,
    ).toBeGreaterThan(0);
  });

  it("restores unread notifications independently of active characters and persists acknowledgement across connections", async () => {
    const request = vi.fn<typeof fetch>();
    const original = worker(request);
    const [achievement] = await unlock();
    const before = original.list({});
    expect(
      before.notifications.some((item) => item.id === achievement!.id),
    ).toBe(true);
    const reopened = worker(request, true);
    expect(reopened.list({}).notifications.map((item) => item.id)).toEqual(
      before.notifications.map((item) => item.id),
    );
    reopened.acknowledge(before.notifications.map((item) => item.id));
    expect(original.list({}).notifications).toEqual([]);
    expect(worker(request, true).get(achievement!.id).notificationRead).toBe(
      true,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
