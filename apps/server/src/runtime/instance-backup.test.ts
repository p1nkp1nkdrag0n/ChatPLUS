import { Buffer } from "node:buffer";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { CorrespondenceRepository } from "../repositories/correspondence-repository.js";
import { CorrespondenceCryptoService } from "../services/correspondence-crypto-service.js";
import { TemporalCatchUpService } from "../services/temporal-catch-up-service.js";
import { ActorQueue } from "./actor-queue.js";
import { FakeClock } from "./clock.js";
import {
  backupInstance,
  restoreInstance,
  type InstanceBackupManifest,
} from "./instance-backup.js";
import { TemporalTaskScheduler } from "./temporal-task-scheduler.js";

const T0 = "2026-09-03T12:00:00.000Z";
const DUE = "2026-09-08T12:00:00.000Z";
const OBSERVED = "2026-09-15T02:00:00.000Z";
const AGENT_ID = "agent-backup-test";
const SECRET_A = Buffer.alloc(32, 0x41).toString("base64");
const SECRET_B = Buffer.alloc(32, 0x42).toString("base64");

describe("instance backup and restore", () => {
  const temporaryRoots: string[] = [];

  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("checkpoints SQLite and creates a secret-free schema/assets manifest", async () => {
    const fixture = createFixture(temporaryRoots, SECRET_A);

    const manifest = await backupInstance({
      databasePath: fixture.databasePath,
      assetsPath: fixture.assetsPath,
      outputDirectory: fixture.backupPath,
      instanceSecret: SECRET_A,
      nowUtc: OBSERVED,
    });

    expect(manifest).toMatchObject({
      format: "chatplus-instance-backup",
      formatVersion: 1,
      createdAtUtc: OBSERVED,
      database: {
        file: "database.sqlite",
      },
      correspondenceKey: {
        fingerprintVersion: 1,
        keyVersion: 1,
      },
      assets: {
        included: true,
        directory: "assets",
        fileCount: 1,
      },
    });
    expect(manifest.database.schemaMigrations).toEqual(
      expect.arrayContaining([
        "018_temporal_correspondence.sql",
        "019_correspondence_key_metadata.sql",
        "020_keepsakes.sql",
      ]),
    );
    expect(manifest.database.latestSchemaMigration).toBe(
      manifest.database.schemaMigrations.at(-1),
    );
    const manifestText = readFileSync(
      join(fixture.backupPath, "manifest.json"),
      "utf8",
    );
    expect(manifestText).not.toContain(SECRET_A);
    expect(manifestText).not.toContain("private letter body");
    expect(manifestText).not.toContain("provider-api-key-must-not-leak");
    expect(manifestText).not.toContain("private asset payload");
    expect(
      readFileSync(join(fixture.backupPath, "assets", "asset.bin"), "utf8"),
    ).toBe("private asset payload");

    const restored = restoreTargets(fixture.root);
    await restoreInstance({
      backupDirectory: fixture.backupPath,
      targetDatabasePath: restored.databasePath,
      targetAssetsPath: restored.assetsPath,
      instanceSecret: SECRET_A,
    });
    expect(existsSync(restored.databasePath)).toBe(true);
    expect(readFileSync(join(restored.assetsPath, "asset.bin"), "utf8")).toBe(
      "private asset payload",
    );
    const restoredDatabase = openDatabase(restored.databasePath);
    try {
      expect(
        CorrespondenceCryptoService.initialize(restoredDatabase, {
          mode: "enforced",
          instanceSecret: SECRET_A,
          nowUtc: OBSERVED,
        }),
      ).toBeDefined();
    } finally {
      restoredDatabase.close();
    }
  });

  it("publishes no named or partial backup when a late validation step fails", async () => {
    const fixture = createFixture(temporaryRoots, SECRET_A, "failed-backup");

    await expect(
      backupInstance({
        databasePath: fixture.databasePath,
        assetsPath: fixture.assetsPath,
        outputDirectory: fixture.backupPath,
        instanceSecret: SECRET_A,
        // This fails manifest validation only after SQLite and assets have
        // already been copied into the private staging directory.
        nowUtc: "not-a-date",
      }),
    ).rejects.toThrow();

    expect(existsSync(fixture.backupPath)).toBe(false);
    expect(
      readdirSync(fixture.root).filter((name) =>
        name.startsWith(".chatplus-backup-"),
      ),
    ).toEqual([]);
  });

  it("preflights the instance fingerprint and refuses every existing target", async () => {
    const fixture = createFixture(temporaryRoots, SECRET_A);
    await createBackup(fixture, SECRET_A);
    const wrongTargets = restoreTargets(fixture.root, "wrong-secret");

    await expect(
      restoreInstance({
        backupDirectory: fixture.backupPath,
        targetDatabasePath: wrongTargets.databasePath,
        targetAssetsPath: wrongTargets.assetsPath,
        instanceSecret: SECRET_B,
      }),
    ).rejects.toThrow(/does not match/iu);
    expect(existsSync(wrongTargets.databasePath)).toBe(false);
    expect(existsSync(wrongTargets.assetsPath)).toBe(false);

    const restored = restoreTargets(fixture.root, "no-overwrite");
    await restoreInstance({
      backupDirectory: fixture.backupPath,
      targetDatabasePath: restored.databasePath,
      targetAssetsPath: restored.assetsPath,
      instanceSecret: SECRET_A,
    });
    await expect(
      restoreInstance({
        backupDirectory: fixture.backupPath,
        targetDatabasePath: restored.databasePath,
        targetAssetsPath: restored.assetsPath,
        instanceSecret: SECRET_A,
      }),
    ).rejects.toThrow(/already exists/iu);
  });

  it("keeps independently keyed databases isolated", async () => {
    const fixtureA = createFixture(temporaryRoots, SECRET_A, "instance-a");
    const fixtureB = createFixture(temporaryRoots, SECRET_B, "instance-b");

    await expect(createBackup(fixtureA, SECRET_B)).rejects.toThrow(
      /does not match/iu,
    );
    await expect(createBackup(fixtureB, SECRET_A)).rejects.toThrow(
      /does not match/iu,
    );
    expect(existsSync(join(fixtureA.backupPath, "manifest.json"))).toBe(false);
    expect(existsSync(join(fixtureB.backupPath, "manifest.json"))).toBe(false);
  });

  it("restores pending work and repeated worker ticks commit it only once", async () => {
    const fixture = createFixture(temporaryRoots, SECRET_A, "worker", true);
    await createBackup(fixture, SECRET_A);
    const restored = restoreTargets(fixture.root, "worker-restored");
    await restoreInstance({
      backupDirectory: fixture.backupPath,
      targetDatabasePath: restored.databasePath,
      targetAssetsPath: restored.assetsPath,
      instanceSecret: SECRET_A,
    });

    const database = openDatabase(restored.databasePath);
    try {
      const repository = new CorrespondenceRepository(database);
      const clock = new FakeClock(OBSERVED);
      const lifeAdvance = vi.fn(() => Promise.resolve());
      const catchUp = new TemporalCatchUpService(
        repository,
        { advance: lifeAdvance },
        new ActorQueue(),
        clock,
        { createClaimToken: (task) => `restored-worker:${task.id}` },
      );
      const scheduler = new TemporalTaskScheduler(
        repository,
        catchUp,
        clock,
        { error: vi.fn() },
        {
          execution: "worker",
          taskKinds: ["letter.outbound_arrival", "letter.return_arrival"],
          idlePollMs: 60_000,
        },
      );

      await scheduler.start();
      await Promise.all([scheduler.tick(), scheduler.tick()]);
      await scheduler.dispose();

      expect(repository.getLetter("letter-backup-test")).toMatchObject({
        status: "delivered_unread",
        deliveredEffectiveAtUtc: DUE,
        processedAtUtc: OBSERVED,
      });
      expect(repository.getTask("task-backup-arrival")).toMatchObject({
        status: "completed",
        attempt: 1,
      });
      expect(count(database, "letters")).toBe(1);
      expect(count(database, "temporal_tasks")).toBe(1);
      expect(lifeAdvance).toHaveBeenCalledWith(AGENT_ID, DUE);
    } finally {
      database.close();
    }
  });
});

interface Fixture {
  readonly root: string;
  readonly databasePath: string;
  readonly assetsPath: string;
  readonly backupPath: string;
}

function createFixture(
  temporaryRoots: string[],
  instanceSecret: string,
  label = "instance",
  withPendingLetter = false,
): Fixture {
  const root = mkdtempSync(join(tmpdir(), `chatplus-${label}-`));
  temporaryRoots.push(root);
  const databasePath = join(root, "data", "instance.sqlite");
  const assetsPath = join(root, "assets");
  const backupPath = join(root, "backup");
  const database = openDatabase(databasePath);
  try {
    runMigrations(database);
    seedAgent(database);
    CorrespondenceCryptoService.initialize(database, {
      mode: "enforced",
      instanceSecret,
      nowUtc: T0,
    });
    if (withPendingLetter) seedPendingLetter(database);
  } finally {
    database.close();
  }
  writeFileSync(join(root, "provider-api-key.txt"), "not-backed-up", "utf8");
  // Runtime-created fixture data; the source file intentionally contains
  // private bytes so the test can prove they never enter the manifest.
  mkdirSync(assetsPath, { recursive: true });
  writeFileSync(join(assetsPath, "asset.bin"), "private asset payload", "utf8");
  return { root, databasePath, assetsPath, backupPath };
}

function seedPendingLetter(database: Database): void {
  const repository = new CorrespondenceRepository(database);
  const thread = repository.createThread(AGENT_ID, {
    id: "thread-backup-test",
    nowUtc: T0,
  });
  const draft = repository.createDraftLetter({
    id: "letter-backup-test",
    threadId: thread.id,
    agentId: AGENT_ID,
    subject: "Private subject",
    body: "private letter body",
    nowUtc: T0,
  });
  repository.sealLetter({
    letterId: draft.id,
    contentHash: "a".repeat(64),
    transitPolicyVersion: "fixed_5d_v1",
    transitTimezone: "Asia/Shanghai",
    dispatchedAtUtc: T0,
    arrivalDueAtUtc: DUE,
    effectiveAuthorTimeUtc: T0,
    taskId: "task-backup-arrival",
    clientRequestId: "request-backup-seal",
  });
}

function seedAgent(database: Database): void {
  database
    .prepare(
      `INSERT INTO characters(
         id, current_version, status, tier, name, source_type,
         created_at_utc, updated_at_utc
       ) VALUES (?, 1, 'published', 'high_fidelity', 'Backup Character',
         'original', ?, ?)`,
    )
    .run(AGENT_ID, T0, T0);
}

function restoreTargets(root: string, label = "restored") {
  return {
    databasePath: join(root, label, "data", "instance.sqlite"),
    assetsPath: join(root, label, "assets"),
  };
}

function createBackup(
  fixture: Fixture,
  instanceSecret: string,
): Promise<InstanceBackupManifest> {
  return backupInstance({
    databasePath: fixture.databasePath,
    assetsPath: fixture.assetsPath,
    outputDirectory: fixture.backupPath,
    instanceSecret,
    nowUtc: OBSERVED,
  });
}

function count(database: Database, table: string): number {
  return Number(
    (
      database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number | bigint;
      }
    ).count,
  );
}
