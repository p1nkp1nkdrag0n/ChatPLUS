import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import BetterSqlite3 from "better-sqlite3";
import { HostedControlStore } from "./control-store.js";
import { createHostedBackup, restoreHostedBackup } from "./backup.js";
import {
  decryptBackup,
  encryptBackup,
  readPortableHostedMasterKey,
} from "./crypto.js";
it("restores encrypted control, research, keys, tenant databases and assets", async () => {
  const parent = mkdtempSync(join(tmpdir(), "dearvale-backup-"));
  const root = join(parent, "source");
  const store = new HostedControlStore(root);
  let restored: HostedControlStore | undefined;
  try {
    const admin = store.createAdministrator("admin", "password-hash");
    store.adjustBalance(admin.id, 1234, admin.id, "fixture");
    const entry = store.recordConversation({
      userId: admin.id,
      operationId: "op",
      kind: "input",
      payload: "private-research-value",
    });
    const tenant = join(root, "tenants", admin.id);
    const backupsDirectory = join(
      root,
      process.platform === "win32" ? "Backups" : "backups",
    );
    mkdirSync(backupsDirectory);
    writeFileSync(
      join(backupsDirectory, "previous.dvbackup"),
      "excluded-previous-backup",
    );
    mkdirSync(join(tenant, "assets"), { recursive: true });
    writeFileSync(join(tenant, "assets", "example.txt"), "tenant-asset");
    writeFileSync(join(tenant, "instance-secret"), "tenant-secret");
    writeFileSync(join(tenant, "business.sqlite.llm-key"), "tenant-llm-secret");
    for (const name of [
      "runtime.lock",
      "runtime-control.json",
      "stop-request.json",
      ".stop-request-fixture.tmp",
    ])
      writeFileSync(join(root, name), "transient-runtime-signal");
    const db = new BetterSqlite3(join(tenant, "business.sqlite"));
    db.exec(
      "CREATE TABLE data(value TEXT); INSERT INTO data VALUES('tenant-record')",
    );
    db.close();
    const backup = join(parent, "backup.dvbackup");
    const result = await createHostedBackup({
      store,
      destination: backup,
      passphrase: "private-backup-passphrase",
    });
    expect(result.keyPath).toBe(join(parent, "backup.dvkeys"));
    const decoded = (path: string) =>
      JSON.parse(
        gunzipSync(
          decryptBackup(readFileSync(path), "private-backup-passphrase"),
        ).toString("utf8"),
      ) as { backupId: string; files: { path: string; data: string }[] };
    const dataArchive = decoded(result.path);
    const keysArchive = decoded(result.keyPath);
    const portableKey = Buffer.from(
      keysArchive.files.find((file) => file.path === ".secrets/master.key")!
        .data,
      "base64",
    );
    expect(portableKey.length).toBe(32);
    expect(
      portableKey.equals(
        readPortableHostedMasterKey(join(root, ".secrets", "master.key")),
      ),
    ).toBe(true);
    if (process.platform === "win32") {
      expect(
        readFileSync(join(root, ".secrets", "master.key")).length,
      ).toBeGreaterThan(32);
    }
    expect(dataArchive.backupId).toBe(keysArchive.backupId);
    expect(
      [...dataArchive.files, ...keysArchive.files].some((file) =>
        [
          "runtime.lock",
          "runtime-control.json",
          "stop-request.json",
          ".stop-request-fixture.tmp",
        ].includes(file.path),
      ),
    ).toBe(false);
    expect(dataArchive.files.map((file) => file.path)).not.toContain(
      ".secrets/master.key",
    );
    expect(keysArchive.files.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        ".secrets/master.key",
        `tenants/${admin.id}/instance-secret`,
        `tenants/${admin.id}/business.sqlite.llm-key`,
      ]),
    );
    expect(
      dataArchive.files.some(
        (file) =>
          file.path.endsWith("instance-secret") ||
          file.path.endsWith(".llm-key"),
      ),
    ).toBe(false);
    expect(
      dataArchive.files.some((file) =>
        file.path.toLowerCase().startsWith("backups/"),
      ),
    ).toBe(false);
    expect(
      readFileSync(backup).includes(Buffer.from("private-research-value")),
    ).toBe(false);
    const destination = join(parent, "restored");
    const mismatchedKeys = join(parent, "mismatched.dvkeys");
    writeFileSync(
      mismatchedKeys,
      encryptBackup(
        gzipSync(
          Buffer.from(
            JSON.stringify({ ...keysArchive, backupId: "another-backup" }),
          ),
        ),
        "private-backup-passphrase",
      ),
    );
    await expect(
      restoreHostedBackup({
        source: backup,
        keysSource: mismatchedKeys,
        destination,
        passphrase: "private-backup-passphrase",
      }),
    ).rejects.toMatchObject({ code: "backup_pair_mismatch" });
    await expect(
      restoreHostedBackup({
        source: backup,
        keysSource: "",
        destination,
        passphrase: "private-backup-passphrase",
      }),
    ).rejects.toMatchObject({ code: "backup_keys_required" });
    expect(existsSync(destination)).toBe(false);
    await expect(
      restoreHostedBackup({
        source: backup,
        keysSource: result.keyPath,
        destination,
        passphrase: "wrong-passphrase",
      }),
    ).rejects.toThrow("incorrect");
    await restoreHostedBackup({
      source: backup,
      keysSource: result.keyPath,
      destination,
      passphrase: "private-backup-passphrase",
    });
    if (process.platform === "win32") {
      const protectedRestore = readFileSync(
        join(destination, ".secrets", "master.key"),
      );
      expect(protectedRestore.length).toBeGreaterThan(32);
      expect(protectedRestore.includes(portableKey)).toBe(false);
      expect(protectedRestore.toString()).not.toContain(
        portableKey.toString("base64"),
      );
    }
    portableKey.fill(0);
    restored = new HostedControlStore(destination);
    expect(restored.wallet(admin.id).balanceMicros).toBe(1234);
    expect(restored.readResearch(entry.id, admin.id).payload).toBe(
      "private-research-value",
    );
    expect(
      readFileSync(
        join(destination, "tenants", admin.id, "assets", "example.txt"),
        "utf8",
      ),
    ).toBe("tenant-asset");
    const restoredDb = new BetterSqlite3(
      join(destination, "tenants", admin.id, "business.sqlite"),
    );
    expect(restoredDb.prepare("SELECT value FROM data").get()).toEqual({
      value: "tenant-record",
    });
    restoredDb.close();
    await expect(
      restoreHostedBackup({
        source: backup,
        keysSource: result.keyPath,
        destination,
        passphrase: "private-backup-passphrase",
      }),
    ).rejects.toThrow("empty");
  } finally {
    restored?.close();
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
it("rejects path traversal before writing files and resumes after backup failure", async () => {
  const parent = mkdtempSync(join(tmpdir(), "dearvale-backup-invalid-"));
  const store = new HostedControlStore(join(parent, "source"));
  try {
    const bytes = Buffer.from("malicious-content");
    const source = join(parent, "hostile.backup");
    const keysSource = join(parent, "hostile.dvkeys");
    writeFileSync(
      keysSource,
      encryptBackup(
        gzipSync(
          Buffer.from(
            JSON.stringify({
              format: "dearvale-hosted-files-v2",
              backupId: "hostile",
              bundle: "keys",
              createdAtUtc: new Date().toISOString(),
              files: [],
            }),
          ),
        ),
        "test-backup-passphrase",
      ),
    );
    writeFileSync(
      source,
      encryptBackup(
        gzipSync(
          Buffer.from(
            JSON.stringify({
              format: "dearvale-hosted-files-v2",
              backupId: "hostile",
              bundle: "data",
              createdAtUtc: new Date().toISOString(),
              files: [
                {
                  path: "../escaped.txt",
                  sha256: createHash("sha256").update(bytes).digest("hex"),
                  data: bytes.toString("base64"),
                },
              ],
            }),
          ),
        ),
        "test-backup-passphrase",
      ),
    );
    await expect(
      restoreHostedBackup({
        source,
        keysSource,
        destination: join(parent, "restored"),
        passphrase: "test-backup-passphrase",
      }),
    ).rejects.toMatchObject({ code: "unsafe_backup_path" });
    expect(existsSync(join(parent, "escaped.txt"))).toBe(false);
    let resumed = false;
    await expect(
      createHostedBackup({
        store,
        destination: join(parent, "bad.backup"),
        passphrase: "short",
        quiesce: () =>
          Promise.resolve(() => {
            resumed = true;
            return Promise.resolve();
          }),
      }),
    ).rejects.toMatchObject({ code: "weak_backup_passphrase" });
    expect(resumed).toBe(true);
  } finally {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
