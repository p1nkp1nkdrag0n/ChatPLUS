import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  constants as fsConstants,
  createReadStream,
  existsSync,
  lstatSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import BetterSqlite3 from "better-sqlite3";
import { canonicalCorrespondenceJson } from "@personasim/features";
import { z } from "zod";

import { deriveCorrespondenceInstanceSecretFingerprint } from "../services/correspondence-instance-secret.js";

const BACKUP_FORMAT = "chatplus-instance-backup";
const BACKUP_FORMAT_VERSION = 1;
const BACKUP_DATABASE_FILE = "database.sqlite";
const BACKUP_ASSETS_DIRECTORY = "assets";
const BACKUP_MANIFEST_FILE = "manifest.json";
const SHA_256_PATTERN = /^[a-f0-9]{64}$/u;
const MIGRATION_NAME_PATTERN = /^\d+[_-].+\.sql$/u;

const CorrespondenceKeyMetadataSchema = z.strictObject({
  fingerprintVersion: z.literal(1),
  keyVersion: z.literal(1),
  fingerprint: z.string().regex(SHA_256_PATTERN),
});

const DatabaseManifestSchema = z.strictObject({
  file: z.literal(BACKUP_DATABASE_FILE),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(SHA_256_PATTERN),
  schemaMigrations: z.array(z.string().regex(MIGRATION_NAME_PATTERN)),
  latestSchemaMigration: z.string().regex(MIGRATION_NAME_PATTERN).nullable(),
});

const IncludedAssetManifestSchema = z.strictObject({
  included: z.literal(true),
  directory: z.literal(BACKUP_ASSETS_DIRECTORY),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  digest: z.string().regex(SHA_256_PATTERN),
});

const ExcludedAssetManifestSchema = z.strictObject({
  included: z.literal(false),
  fileCount: z.literal(0),
  totalBytes: z.literal(0),
  digest: z.null(),
});

export const InstanceBackupManifestSchema = z.strictObject({
  format: z.literal(BACKUP_FORMAT),
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  createdAtUtc: z.iso.datetime(),
  database: DatabaseManifestSchema,
  correspondenceKey: CorrespondenceKeyMetadataSchema.nullable(),
  assets: z.discriminatedUnion("included", [
    IncludedAssetManifestSchema,
    ExcludedAssetManifestSchema,
  ]),
});

export type InstanceBackupManifest = z.infer<
  typeof InstanceBackupManifestSchema
>;

export interface BackupInstanceOptions {
  readonly databasePath: string;
  readonly outputDirectory: string;
  readonly assetsPath?: string;
  readonly instanceSecret?: string;
  readonly nowUtc?: string;
}

export interface RestoreInstanceOptions {
  readonly backupDirectory: string;
  readonly targetDatabasePath: string;
  readonly targetAssetsPath: string;
  readonly instanceSecret?: string;
}

interface DatabaseInspection {
  readonly schemaMigrations: readonly string[];
  readonly correspondenceKey: z.infer<
    typeof CorrespondenceKeyMetadataSchema
  > | null;
}

interface AssetSnapshot {
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly digest: string;
}

interface AssetEntry {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Creates an online SQLite backup after a WAL checkpoint and captures assets
 * in the same named backup batch. INSTANCE_SECRET is verified but never copied
 * or serialized; operators must store their environment file separately.
 */
export async function backupInstance(
  options: BackupInstanceOptions,
): Promise<InstanceBackupManifest> {
  const databasePath = resolveExistingFile(
    options.databasePath,
    "databasePath",
  );
  const outputDirectory = resolveSafePath(
    options.outputDirectory,
    "outputDirectory",
  );
  const assetsPath =
    options.assetsPath === undefined
      ? undefined
      : resolveOptionalDirectory(options.assetsPath, "assetsPath");

  assertDifferentPath(databasePath, outputDirectory, "backup output");
  if (
    assetsPath !== undefined &&
    (samePath(outputDirectory, assetsPath) ||
      isPathWithin(outputDirectory, assetsPath))
  ) {
    throw new TypeError(
      "outputDirectory must not be the asset directory or one of its descendants",
    );
  }
  assertPathDoesNotExist(outputDirectory, "outputDirectory");
  await mkdir(dirname(outputDirectory), { recursive: true });
  const temporaryOutputDirectory = join(
    dirname(outputDirectory),
    `.chatplus-backup-${randomUUID()}.partial`,
  );
  await mkdir(temporaryOutputDirectory);
  try {
    const database = new BetterSqlite3(databasePath, {
      fileMustExist: true,
    });
    let inspection: DatabaseInspection;
    try {
      database.pragma("busy_timeout = 5000");
      assertCheckpointCompleted(database);
      inspection = inspectDatabase(database);
      verifyConfiguredSecret(
        inspection.correspondenceKey,
        options.instanceSecret,
      );

      await database.backup(
        join(temporaryOutputDirectory, BACKUP_DATABASE_FILE),
      );
    } finally {
      database.close();
    }

    const backedUpDatabasePath = join(
      temporaryOutputDirectory,
      BACKUP_DATABASE_FILE,
    );
    const databaseHash = await sha256File(backedUpDatabasePath);
    const backedUpInspection = inspectDatabaseFile(backedUpDatabasePath);
    assertSameDatabaseInspection(inspection, backedUpInspection);

    const assetsManifest =
      assetsPath === undefined
        ? ExcludedAssetManifestSchema.parse({
            included: false,
            fileCount: 0,
            totalBytes: 0,
            digest: null,
          })
        : await backupAssets(assetsPath, temporaryOutputDirectory);

    const manifest = InstanceBackupManifestSchema.parse({
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAtUtc: options.nowUtc ?? new Date().toISOString(),
      database: {
        file: BACKUP_DATABASE_FILE,
        bytes: statSync(backedUpDatabasePath).size,
        sha256: databaseHash,
        schemaMigrations: [...inspection.schemaMigrations],
        latestSchemaMigration: inspection.schemaMigrations.at(-1) ?? null,
      },
      correspondenceKey: inspection.correspondenceKey,
      assets: assetsManifest,
    });
    await writeFile(
      join(temporaryOutputDirectory, BACKUP_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    // The named backup appears only after the complete batch is verifiable.
    assertPathDoesNotExist(outputDirectory, "outputDirectory");
    await rename(temporaryOutputDirectory, outputDirectory);
    return manifest;
  } finally {
    await rm(temporaryOutputDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

/**
 * Restores only into absent targets. Every manifest, schema, database, asset
 * and key-fingerprint check completes before a target becomes visible.
 */
export async function restoreInstance(
  options: RestoreInstanceOptions,
): Promise<InstanceBackupManifest> {
  const backupDirectory = resolveExistingDirectory(
    options.backupDirectory,
    "backupDirectory",
  );
  const targetDatabasePath = resolveSafePath(
    options.targetDatabasePath,
    "targetDatabasePath",
  );
  const targetAssetsPath = resolveSafePath(
    options.targetAssetsPath,
    "targetAssetsPath",
  );
  assertPathDoesNotExist(targetDatabasePath, "targetDatabasePath");
  assertPathDoesNotExist(targetAssetsPath, "targetAssetsPath");
  if (
    isPathWithin(targetDatabasePath, backupDirectory) ||
    isPathWithin(targetAssetsPath, backupDirectory)
  ) {
    throw new TypeError("restore targets must be outside backupDirectory");
  }

  const manifestPath = join(backupDirectory, BACKUP_MANIFEST_FILE);
  const manifest = InstanceBackupManifestSchema.parse(
    JSON.parse(await readUtf8File(manifestPath)) as unknown,
  );
  const backupDatabasePath = join(backupDirectory, manifest.database.file);
  assertRegularFileNoSymlink(backupDatabasePath, "backup database");
  const databaseStat = statSync(backupDatabasePath);
  if (
    databaseStat.size !== manifest.database.bytes ||
    !safeDigestEqual(
      await sha256File(backupDatabasePath),
      manifest.database.sha256,
    )
  ) {
    throw new TypeError("backup database checksum does not match manifest");
  }

  const inspection = inspectDatabaseFile(backupDatabasePath);
  assertManifestMatchesInspection(manifest, inspection);
  assertSupportedSchema(inspection.schemaMigrations);
  verifyConfiguredSecret(manifest.correspondenceKey, options.instanceSecret);

  const backupAssetsPath = join(backupDirectory, BACKUP_ASSETS_DIRECTORY);
  if (manifest.assets.included) {
    const assetSnapshot = await inspectAssetDirectory(backupAssetsPath);
    if (
      assetSnapshot.fileCount !== manifest.assets.fileCount ||
      assetSnapshot.totalBytes !== manifest.assets.totalBytes ||
      !safeDigestEqual(assetSnapshot.digest, manifest.assets.digest)
    ) {
      throw new TypeError("backup asset snapshot does not match manifest");
    }
  } else if (existsSync(backupAssetsPath)) {
    throw new TypeError("manifest excludes assets but backup contains assets");
  }

  // Recheck immediately before creating parents to narrow the race window.
  assertPathDoesNotExist(targetDatabasePath, "targetDatabasePath");
  assertPathDoesNotExist(targetAssetsPath, "targetAssetsPath");
  await mkdir(dirname(targetDatabasePath), { recursive: true });
  await mkdir(dirname(targetAssetsPath), { recursive: true });
  const restoreId = randomUUID();
  const temporaryDatabasePath = join(
    dirname(targetDatabasePath),
    `.chatplus-restore-${restoreId}.sqlite.partial`,
  );
  const temporaryAssetsPath = join(
    dirname(targetAssetsPath),
    `.chatplus-restore-${restoreId}.assets.partial`,
  );

  try {
    await copyFile(
      backupDatabasePath,
      temporaryDatabasePath,
      fsConstants.COPYFILE_EXCL,
    );
    if (
      !safeDigestEqual(
        await sha256File(temporaryDatabasePath),
        manifest.database.sha256,
      )
    ) {
      throw new TypeError("restored database checksum verification failed");
    }

    if (manifest.assets.included) {
      await copyAssetDirectory(backupAssetsPath, temporaryAssetsPath);
      const copiedAssets = await inspectAssetDirectory(temporaryAssetsPath);
      if (!safeDigestEqual(copiedAssets.digest, manifest.assets.digest)) {
        throw new TypeError("restored asset checksum verification failed");
      }
    } else {
      await mkdir(temporaryAssetsPath);
    }

    // Publish assets first and the database last. A process watching the final
    // database path can therefore never start against a half-restored batch.
    await rename(temporaryAssetsPath, targetAssetsPath);
    await rename(temporaryDatabasePath, targetDatabasePath);
  } finally {
    await rm(temporaryDatabasePath, { force: true }).catch(() => undefined);
    await rm(temporaryAssetsPath, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
  return manifest;
}

function inspectDatabaseFile(databasePath: string): DatabaseInspection {
  const database = new BetterSqlite3(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return inspectDatabase(database);
  } finally {
    database.close();
  }
}

function assertCheckpointCompleted(database: BetterSqlite3.Database): void {
  const row = (
    database.pragma("wal_checkpoint(TRUNCATE)") as Array<{
      busy?: unknown;
      log?: unknown;
      checkpointed?: unknown;
    }>
  )[0];
  if (
    row === undefined ||
    row.busy !== 0 ||
    typeof row.log !== "number" ||
    typeof row.checkpointed !== "number"
  ) {
    throw new TypeError("SQLite WAL checkpoint could not complete safely");
  }
}

function inspectDatabase(database: BetterSqlite3.Database): DatabaseInspection {
  if (!hasTable(database, "schema_migrations")) {
    throw new TypeError("database is missing schema_migrations");
  }
  const schemaMigrations = database
    .prepare("SELECT name FROM schema_migrations ORDER BY name")
    .all()
    .map((row) => (row as { name: unknown }).name);
  if (
    !schemaMigrations.every(
      (name): name is string =>
        typeof name === "string" && MIGRATION_NAME_PATTERN.test(name),
    )
  ) {
    throw new TypeError("database contains an invalid schema migration name");
  }

  let correspondenceKey: z.infer<
    typeof CorrespondenceKeyMetadataSchema
  > | null = null;
  if (hasTable(database, "correspondence_key_metadata")) {
    const row = database
      .prepare(
        `SELECT fingerprint_version, fingerprint, key_version
         FROM correspondence_key_metadata WHERE id = 1`,
      )
      .get() as
      | {
          fingerprint_version: unknown;
          fingerprint: unknown;
          key_version: unknown;
        }
      | undefined;
    if (row !== undefined) {
      correspondenceKey = CorrespondenceKeyMetadataSchema.parse({
        fingerprintVersion: row.fingerprint_version,
        fingerprint: row.fingerprint,
        keyVersion: row.key_version,
      });
    }
  }
  if (
    correspondenceKey === null &&
    hasTable(database, "letters") &&
    Number(
      (
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM letters
             WHERE encrypted_ciphertext IS NOT NULL`,
          )
          .get() as { count: number | bigint }
      ).count,
    ) > 0
  ) {
    throw new TypeError(
      "database contains encrypted correspondence without key metadata",
    );
  }
  return {
    schemaMigrations: Object.freeze([...schemaMigrations]),
    correspondenceKey,
  };
}

function assertManifestMatchesInspection(
  manifest: InstanceBackupManifest,
  inspection: DatabaseInspection,
): void {
  if (
    canonicalCorrespondenceJson(manifest.database.schemaMigrations) !==
      canonicalCorrespondenceJson(inspection.schemaMigrations) ||
    canonicalCorrespondenceJson(manifest.correspondenceKey) !==
      canonicalCorrespondenceJson(inspection.correspondenceKey)
  ) {
    throw new TypeError("backup database metadata does not match manifest");
  }
}

function assertSameDatabaseInspection(
  source: DatabaseInspection,
  backup: DatabaseInspection,
): void {
  if (
    canonicalCorrespondenceJson(source) !== canonicalCorrespondenceJson(backup)
  ) {
    throw new TypeError("online SQLite backup metadata verification failed");
  }
}

function assertSupportedSchema(schemaMigrations: readonly string[]): void {
  const migrationDirectory = fileURLToPath(
    new URL("../db/migrations/", import.meta.url),
  );
  const supported = readdirSync(migrationDirectory)
    .filter((name) => MIGRATION_NAME_PATTERN.test(name))
    .sort(compareCodeUnits);
  for (let index = 0; index < schemaMigrations.length; index += 1) {
    if (schemaMigrations[index] !== supported[index]) {
      throw new TypeError(
        "backup schema is newer than or incompatible with this application",
      );
    }
  }
}

function verifyConfiguredSecret(
  metadata: z.infer<typeof CorrespondenceKeyMetadataSchema> | null,
  instanceSecret: string | undefined,
): void {
  if (metadata === null) return;
  if (instanceSecret === undefined) {
    throw new TypeError(
      "INSTANCE_SECRET is required to verify this correspondence backup",
    );
  }
  let actualFingerprint: string;
  try {
    actualFingerprint =
      deriveCorrespondenceInstanceSecretFingerprint(instanceSecret);
  } catch {
    throw new TypeError(
      "INSTANCE_SECRET is invalid for correspondence backup verification",
    );
  }
  if (!safeDigestEqual(actualFingerprint, metadata.fingerprint)) {
    throw new TypeError(
      "INSTANCE_SECRET does not match the correspondence backup",
    );
  }
}

async function backupAssets(
  assetsPath: string,
  outputDirectory: string,
): Promise<z.infer<typeof IncludedAssetManifestSchema>> {
  const destination = join(outputDirectory, BACKUP_ASSETS_DIRECTORY);
  await copyAssetDirectory(assetsPath, destination);
  const snapshot = await inspectAssetDirectory(destination);
  return IncludedAssetManifestSchema.parse({
    included: true,
    directory: BACKUP_ASSETS_DIRECTORY,
    fileCount: snapshot.fileCount,
    totalBytes: snapshot.totalBytes,
    digest: snapshot.digest,
  });
}

async function copyAssetDirectory(source: string, destination: string) {
  assertDirectoryNoSymlink(source, "asset directory");
  await mkdir(destination, { recursive: false });
  const entries = await readdir(source, { withFileTypes: true });
  entries.sort((left, right) => compareCodeUnits(left.name, right.name));
  for (const entry of entries) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isSymbolicLink()) {
      throw new TypeError("asset snapshots cannot contain symbolic links");
    }
    if (entry.isDirectory()) {
      await copyAssetDirectory(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      assertRegularFileNoSymlink(sourcePath, "asset file");
      await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL);
    } else {
      throw new TypeError("asset snapshots may contain only files/directories");
    }
  }
}

async function inspectAssetDirectory(root: string): Promise<AssetSnapshot> {
  assertDirectoryNoSymlink(root, "asset directory");
  const entries: AssetEntry[] = [];
  await collectAssetEntries(root, root, entries);
  entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  return {
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    digest: sha256Text(canonicalCorrespondenceJson(entries)),
  };
}

async function collectAssetEntries(
  root: string,
  directory: string,
  output: AssetEntry[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => compareCodeUnits(left.name, right.name));
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new TypeError("asset snapshots cannot contain symbolic links");
    }
    if (entry.isDirectory()) {
      await collectAssetEntries(root, absolutePath, output);
    } else if (entry.isFile()) {
      const normalizedRelativePath = relative(root, absolutePath)
        .split(sep)
        .join("/");
      const stats = statSync(absolutePath);
      output.push({
        path: normalizedRelativePath,
        bytes: stats.size,
        sha256: await sha256File(absolutePath),
      });
    } else {
      throw new TypeError("asset snapshots may contain only files/directories");
    }
  }
}

async function sha256File(filePath: string): Promise<string> {
  assertRegularFileNoSymlink(filePath, "file");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    digest.update(chunk as Buffer);
  }
  return digest.digest("hex");
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hasTable(database: BetterSqlite3.Database, table: string): boolean {
  return (
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function resolveExistingFile(value: string, label: string): string {
  const path = resolveSafePath(value, label);
  assertRegularFileNoSymlink(path, label);
  return path;
}

function resolveExistingDirectory(value: string, label: string): string {
  const path = resolveSafePath(value, label);
  assertDirectoryNoSymlink(path, label);
  return path;
}

function resolveOptionalDirectory(value: string, label: string): string {
  const path = resolveSafePath(value, label);
  assertDirectoryNoSymlink(path, label);
  return path;
}

function resolveSafePath(value: string, label: string): string {
  if (value.trim().length === 0) throw new TypeError(`${label} is required`);
  const path = resolve(value);
  if (samePath(path, parse(path).root)) {
    throw new TypeError(`${label} cannot be a filesystem root`);
  }
  return path;
}

function assertRegularFileNoSymlink(path: string, label: string): void {
  if (!existsSync(path)) throw new TypeError(`${label} does not exist`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new TypeError(`${label} must be a regular file, not a symbolic link`);
  }
}

function assertDirectoryNoSymlink(path: string, label: string): void {
  if (!existsSync(path)) throw new TypeError(`${label} does not exist`);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new TypeError(`${label} must be a directory, not a symbolic link`);
  }
}

function assertPathDoesNotExist(path: string, label: string): void {
  if (existsSync(path)) {
    throw new TypeError(`${label} already exists; restore never overwrites`);
  }
}

function assertDifferentPath(left: string, right: string, label: string): void {
  if (samePath(left, right)) {
    throw new TypeError(`${label} must differ from the source database`);
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).replace(/[\\/]+$/u, "");
  const normalizedRight = resolve(right).replace(/[\\/]+$/u, "");
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function isPathWithin(candidate: string, parent: string): boolean {
  const value = relative(resolve(parent), resolve(candidate));
  return (
    value !== "" &&
    value !== ".." &&
    !value.startsWith(`..${sep}`) &&
    !value.startsWith(sep)
  );
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!SHA_256_PATTERN.test(left) || !SHA_256_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function readUtf8File(path: string): Promise<string> {
  assertRegularFileNoSymlink(path, "backup manifest");
  const chunks: Buffer[] = [];
  for await (const chunk of createReadStream(path)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
