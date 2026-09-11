import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFixtureImageGenerationProvider } from "@personasim/providers";
import { openDatabase, type Database } from "./db/connection.js";
import { runMigrations } from "./db/migrations.js";
import { FakeClock } from "./runtime/clock.js";
import {
  AchievementService,
  badgeVisualSpec,
} from "./services/achievement-service.js";
import { AchievementWaxAdmin } from "./services/achievement-wax-admin.js";
import { backupInstance, restoreInstance } from "./runtime/instance-backup.js";

const NOW = "2026-09-11T04:00:00.000Z";
const PROFILE = JSON.stringify({
  name: "林间",
  role: "植物学家",
  setting: "森林",
  traits: [{ name: "细致" }],
});
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("wax badge image versions", () => {
  let directory: string;
  let database: Database;
  let clock: FakeClock;
  let service: AchievementService;
  let admin: AchievementWaxAdmin;
  let request: ReturnType<typeof vi.fn<typeof fetch>>;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-wax-versions-"));
    database = openDatabase(join(directory, "test.db"));
    runMigrations(database);
    clock = new FakeClock(NOW);
    request = vi.fn<typeof fetch>();
    service = new AchievementService(database, clock, {
      databasePath: join(directory, "test.db"),
      assetRoot: join(directory, "badges"),
      fetch: request,
      developerMode: true,
    });
    admin = new AchievementWaxAdmin(database);
    database
      .prepare(
        "UPDATE achievement_image_settings SET enabled=1,protocol='openai-compatible',base_url='https://images.example.test/v1',model='test-image'",
      )
      .run();
  });
  afterEach(async () => {
    await service.stop();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  function unlock(version = 2, id = "achievement-wax-test") {
    database
      .prepare(
        "INSERT OR IGNORE INTO achievement_visual_profiles VALUES(?,?,?)",
      )
      .run("agent-wax", PROFILE, NOW);
    database
      .prepare(
        `INSERT INTO achievement_unlocks(id,definition_key,scope_key,agent_id,agent_name,title,description,category,badge_key,
      unlocked_at_utc,recorded_at_utc,evidence_kind,evidence_id)
      SELECT ?,key,?,'agent-wax','林间',title,description,category,badge_key,?,?,'test','test' FROM achievement_definitions WHERE key='relationship.90'`,
      )
      .run(id, id, NOW, NOW);
    if (version !== 2)
      database
        .prepare(
          "UPDATE achievement_badge_jobs SET visual_version=? WHERE achievement_id=?",
        )
        .run(version, id);
    return id;
  }
  async function response(version = 2) {
    const asset = await createFixtureImageGenerationProvider().generate({
      visualSpec: badgeVisualSpec(PROFILE, "独一份纪念", "star", version),
      width: 128,
      height: 128,
      idempotencyKey: `v${version}`,
    });
    return json({
      data: [{ b64_json: Buffer.from(asset.bytes).toString("base64") }],
    });
  }
  function state(id: string) {
    return database
      .prepare(
        "SELECT visual_version,status,attempts,sha256,claim_token FROM achievement_badge_jobs WHERE achievement_id=?",
      )
      .get(id) as {
      visual_version: number;
      status: string;
      attempts: number;
      sha256: string | null;
      claim_token: string | null;
    };
  }

  it("creates new jobs at v2 without changing definitions or enqueueing existing ones", () => {
    const id = unlock();
    expect(state(id)).toMatchObject({
      visual_version: 2,
      status: "pending",
      attempts: 0,
    });
    expect(admin.plan()).toMatchObject([
      { id, action: "already-v2", hasImage: false },
    ]);
    expect(admin.enqueue(NOW)).toEqual({ queued: [], skipped: [id] });
    expect(
      database
        .prepare("SELECT count(*) AS total FROM achievement_definitions")
        .get(),
    ).toEqual({ total: 16 });
    expect(request).not.toHaveBeenCalled();
  });

  it("retains the original through pending, failure and retry, publishes an immutable v2 image, then restores v1", async () => {
    const id = unlock(1);
    request
      .mockResolvedValueOnce(await response(1))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(await response(2));
    await service.processNext();
    const original = state(id).sha256!;
    const originalBytes = await service.readAsset(id, false, original);
    const originalUrl = service.get(id).badge.imageUrl;
    expect(admin.versions(id)).toMatchObject([
      { visual_version: 1, sha256: original },
    ]);
    expect(admin.enqueue(NOW)).toEqual({ queued: [id], skipped: [] });
    expect(service.get(id).badge).toMatchObject({
      status: "pending",
      imageUrl: originalUrl,
    });
    expect(await service.readAsset(id, false)).toEqual(originalBytes);
    await service.processNext();
    expect(service.get(id).badge).toMatchObject({
      status: "failed",
      imageUrl: originalUrl,
    });
    expect(await service.readAsset(id, false, original)).toEqual(originalBytes);
    expect(admin.enqueue(NOW)).toEqual({ queued: [], skipped: [id] });
    service.retryBadge(id);
    await vi.waitFor(() => expect(service.get(id).badge.status).toBe("ready"));
    const current = state(id).sha256!;
    expect(current).not.toBe(original);
    expect(admin.versions(id)).toHaveLength(2);
    expect(service.get(id).badge.imageUrl).toBe(
      `/api/achievements/${id}/badge?v=${current}`,
    );
    expect(await service.readAsset(id, false, original)).toEqual(originalBytes);
    expect(
      createHash("sha256")
        .update(await service.readAsset(id, false, current))
        .digest("hex"),
    ).toBe(current);
    await expect(
      service.readAsset(id, false, "a".repeat(64)),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(
      database
        .prepare("SELECT profile_json FROM achievement_visual_profiles")
        .get(),
    ).toEqual({ profile_json: PROFILE });
    await admin.restore(id, original, service.assets, NOW);
    expect(service.get(id).badge).toMatchObject({
      status: "ready",
      imageUrl: originalUrl,
    });
    expect(admin.enqueue(NOW)).toEqual({ queued: [], skipped: [id] });
    expect(
      (await service.assets.scanOrphans(admin.referencedStorageKeys()))
        .removedStorageKeys,
    ).toEqual([]);
    expect(await service.readAsset(id, false, current)).not.toEqual(
      originalBytes,
    );
    expect(() =>
      database
        .prepare(
          "UPDATE achievement_badge_versions SET visual_version=3 WHERE achievement_id=?",
        )
        .run(id),
    ).toThrow("history is immutable");
  });

  it("refuses a generating legacy selection atomically without enqueueing other selected badges", () => {
    const first = unlock(1, "achievement-first");
    const second = unlock(1, "achievement-second");
    database
      .prepare(
        "UPDATE achievement_badge_jobs SET status='generating',claim_token='active' WHERE achievement_id=?",
      )
      .run(second);
    expect(admin.plan().map((row) => row.action)).toEqual([
      "enqueue",
      "wait-for-generating",
    ]);
    expect(() => admin.enqueue(NOW)).toThrow("正在生成");
    expect(state(first)).toMatchObject({
      visual_version: 1,
      status: "pending",
    });
    expect(state(second)).toMatchObject({
      visual_version: 1,
      status: "generating",
      claim_token: "active",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("discards a stale successful completion when its version changed, preserving both retained files and job state", async () => {
    const id = unlock(1);
    request.mockResolvedValueOnce(await response(1));
    await service.processNext();
    const original = state(id).sha256!;
    const files = admin.versions(id)[0]!;
    admin.enqueue(NOW);
    let resolveRequest!: (response: Response) => void;
    request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const running = service.processNext();
    await vi.waitFor(() => expect(state(id).status).toBe("generating"));
    expect(service.get(id).badge.imageUrl).toContain(original);
    database
      .prepare(
        "UPDATE achievement_badge_jobs SET visual_version=3 WHERE achievement_id=?",
      )
      .run(id);
    resolveRequest(await response(2));
    await running;
    expect(state(id)).toMatchObject({
      status: "generating",
      visual_version: 3,
      sha256: original,
    });
    expect(admin.versions(id)).toHaveLength(1);
    expect(
      await readFile(join(directory, "badges", files.storage_key)),
    ).toEqual(await service.readAsset(id, false, original));
    expect(
      (await service.assets.scanOrphans(admin.referencedStorageKeys()))
        .inspected,
    ).toBe(2);
  });

  it.each([
    {
      outcome: "successful image at expiry",
      status: 200,
      finishedAt: "2026-09-11T04:05:00.000Z",
    },
    {
      outcome: "successful image after expiry",
      status: 200,
      finishedAt: "2026-09-11T04:05:01.000Z",
    },
    {
      outcome: "retryable rejection after expiry",
      status: 503,
      finishedAt: "2026-09-11T04:05:01.000Z",
    },
  ])(
    "does not publish or automatically retry a $outcome without another worker observing the expiry",
    async ({ status, finishedAt }) => {
      const id = unlock(1);
      request.mockResolvedValueOnce(await response(1));
      await service.processNext();
      const original = state(id).sha256!;
      const originalBytes = await service.readAsset(id, false, original);
      const history = admin.versions(id);
      admin.enqueue(NOW);
      let resolveRequest!: (response: Response) => void;
      request.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRequest = resolve;
          }),
      );
      const running = service.processNext();
      await vi.waitFor(() => expect(state(id).status).toBe("generating"));
      clock.setUtc(finishedAt);
      // Do not run any other processNext: the completing worker must detect its
      // own lease expiry even if the background loop could not tick meanwhile.
      resolveRequest(status === 200 ? await response(2) : json({}, status));
      await running;
      expect(state(id)).toMatchObject({
        status: "failed",
        visual_version: 2,
        sha256: original,
        claim_token: null,
      });
      expect(
        database
          .prepare(
            "SELECT error_code,lease_until_utc FROM achievement_badge_jobs WHERE achievement_id=?",
          )
          .get(id),
      ).toEqual({ error_code: "image_outcome_unknown", lease_until_utc: null });
      expect(admin.versions(id)).toEqual(history);
      expect(service.get(id).badge.imageUrl).toContain(original);
      expect(await service.readAsset(id, false)).toEqual(originalBytes);
      const scan = await service.assets.scanOrphans(
        admin.referencedStorageKeys(),
      );
      expect(scan).toEqual({ inspected: 2, removedStorageKeys: [] });
      clock.setUtc("2026-09-12T04:00:00.000Z");
      await service.processNext();
      expect(request).toHaveBeenCalledTimes(2);
      expect(state(id).status).toBe("failed");
    },
  );

  it("recovers a persisted generating row without a lease without automatically submitting another request", async () => {
    const id = unlock();
    database
      .prepare(
        "UPDATE achievement_badge_jobs SET status='generating',lease_until_utc=NULL,claim_token='lost' WHERE achievement_id=?",
      )
      .run(id);
    await service.processNext();
    expect(state(id)).toMatchObject({ status: "failed", claim_token: null });
    expect(
      database
        .prepare(
          "SELECT error_code FROM achievement_badge_jobs WHERE achievement_id=?",
        )
        .get(id),
    ).toEqual({ error_code: "image_outcome_unknown" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects corrupted history and refuses restore during active generation", async () => {
    const id = unlock(1);
    request.mockResolvedValueOnce(await response(1));
    await service.processNext();
    const original = state(id).sha256!;
    admin.enqueue(NOW);
    database
      .prepare(
        "UPDATE achievement_badge_jobs SET status='generating' WHERE achievement_id=?",
      )
      .run(id);
    await expect(
      admin.restore(id, original, service.assets, NOW),
    ).rejects.toMatchObject({ code: "image_drawing_in_progress" });
    database
      .prepare(
        "UPDATE achievement_badge_jobs SET status='failed' WHERE achievement_id=?",
      )
      .run(id);
    await writeFile(
      join(directory, "badges", admin.versions(id)[0]!.storage_key),
      "corrupt",
    );
    await expect(
      admin.restore(id, original, service.assets, NOW),
    ).rejects.toMatchObject({ code: "image_asset_integrity_failed" });
    expect(state(id).status).toBe("failed");
  });

  it("rejects an opaque v2 output before publishing it while retaining the original", async () => {
    const id = unlock(1);
    request
      .mockResolvedValueOnce(await response(1))
      .mockResolvedValueOnce(await response(1));
    await service.processNext();
    const original = state(id).sha256!;
    admin.enqueue(NOW);
    await service.processNext();
    expect(state(id)).toMatchObject({ status: "failed", sha256: original });
    expect(
      database
        .prepare(
          "SELECT error_code FROM achievement_badge_jobs WHERE achievement_id=?",
        )
        .get(id),
    ).toEqual({ error_code: "image_transparency_required" });
    expect(admin.versions(id)).toHaveLength(1);
    expect(service.get(id).badge.imageUrl).toContain(original);
  });

  it("rotates a known-invalid request on manual retry so an idempotent provider can produce a valid new image", async () => {
    const id = unlock();
    const opaqueBody = await (await response(1)).text();
    const waxBody = await (await response(2)).text();
    const cache = new Map<string, string>();
    request.mockImplementation((_url, init) => {
      const key = new Headers(init?.headers).get("idempotency-key")!;
      if (!cache.has(key))
        cache.set(key, cache.size === 0 ? opaqueBody : waxBody);
      return Promise.resolve(
        new Response(cache.get(key), {
          headers: { "content-type": "application/json" },
        }),
      );
    });
    await service.processNext();
    expect(state(id).status).toBe("failed");
    service.retryBadge(id);
    await vi.waitFor(() => expect(state(id).status).toBe("ready"));
    expect(cache.size).toBe(2);
    const keys = [...cache.keys()];
    expect(
      keys.every((key) => key.startsWith(`achievement-badge:${id}:v2:`)),
    ).toBe(true);
    expect(
      database
        .prepare(
          "SELECT request_id FROM achievement_badge_versions WHERE achievement_id=?",
        )
        .get(id),
    ).toEqual({ request_id: keys[1] });
  });

  it("reuses an uncertain outcome key across a manual retry, but changes it when request configuration changes", async () => {
    const id = unlock();
    request
      .mockRejectedValueOnce(new Error("socket interrupted"))
      .mockResolvedValueOnce(await response(2));
    await service.processNext();
    service.retryBadge(id);
    await vi.waitFor(() => expect(state(id).status).toBe("ready"));
    const first = new Headers(request.mock.calls[0]![1]?.headers).get(
      "idempotency-key",
    );
    expect(
      new Headers(request.mock.calls[1]![1]?.headers).get("idempotency-key"),
    ).toBe(first);
    database
      .prepare(
        "UPDATE achievement_badge_jobs SET status='failed',error_code='image_outcome_unknown' WHERE achievement_id=?",
      )
      .run(id);
    database
      .prepare(
        "UPDATE achievement_image_settings SET model='different-image-model'",
      )
      .run();
    request.mockResolvedValueOnce(await response(2));
    service.retryBadge(id);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(state(id).status).toBe("ready"));
    expect(
      new Headers(request.mock.calls[2]![1]?.headers).get("idempotency-key"),
    ).not.toBe(first);
  });

  it("backs up and restores v1 and v2 files with their history and active pointer", async () => {
    const id = unlock(1);
    request
      .mockResolvedValueOnce(await response(1))
      .mockResolvedValueOnce(await response(2));
    await service.processNext();
    const original = state(id).sha256!;
    admin.enqueue(NOW);
    await service.processNext();
    const current = state(id).sha256!;
    const manifest = await backupInstance({
      databasePath: join(directory, "test.db"),
      achievementAssetsPath: join(directory, "badges"),
      outputDirectory: join(directory, "backup"),
      nowUtc: NOW,
    });
    expect(manifest.achievementAssets?.fileCount).toBe(4);
    await restoreInstance({
      backupDirectory: join(directory, "backup"),
      targetDatabasePath: join(directory, "restored.db"),
      targetAssetsPath: join(directory, "restored-assets"),
      targetAchievementAssetsPath: join(directory, "restored-badges"),
    });
    const restored = openDatabase(join(directory, "restored.db"));
    const restarted = new AchievementService(restored, clock, {
      databasePath: join(directory, "restored.db"),
      assetRoot: join(directory, "restored-badges"),
      fetch: request,
    });
    try {
      expect(new AchievementWaxAdmin(restored).versions(id)).toHaveLength(2);
      expect(restarted.get(id).badge.imageUrl).toContain(current);
      expect(await restarted.readAsset(id, false, original)).toEqual(
        await service.readAsset(id, false, original),
      );
      expect(await restarted.readAsset(id, false, current)).toEqual(
        await service.readAsset(id, false, current),
      );
      await restarted.processNext();
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      await restarted.stop();
      restored.close();
    }
  });
});
