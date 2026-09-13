import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import BetterSqlite3 from "better-sqlite3";
import { readFile } from "node:fs/promises";
import type { HostedControlStore } from "./control-store.js";
import {
  decryptBackup,
  encryptBackup,
  protectDirectory,
  readPortableHostedMasterKey,
  encodeHostedMasterKey,
} from "./crypto.js";
import { HostedError } from "./types.js";

const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
interface ArchiveFile {
  path: string;
  sha256: string;
  data: string;
}
interface Archive {
  format: "dearvale-hosted-files-v2";
  backupId: string;
  bundle: "data" | "keys";
  createdAtUtc: string;
  files: ArchiveFile[];
}
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
function pathKey(path: string): string {
  const absolute = resolve(path);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}
function isSecretPath(path: string): boolean {
  const normalized = path.toLowerCase();
  return (
    normalized.startsWith(".secrets/") ||
    normalized.split("/").at(-1) === "instance-secret" ||
    normalized.endsWith(".llm-key")
  );
}
function removeSnapshot(root: string, temporary: string): void {
  if (
    !inside(root, temporary) ||
    !temporary.startsWith(join(root, ".backup-work-"))
  )
    throw new Error("Unsafe snapshot cleanup target");
  rmSync(temporary, { recursive: true, force: true });
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return (
    part !== "" &&
    part !== ".." &&
    !part.startsWith(`..${sep}`) &&
    !isAbsolute(part)
  );
}
function safeArchivePath(root: string, path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    path.includes(":") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path
      .split("/")
      .some(
        (item) =>
          !item ||
          item === "." ||
          item === ".." ||
          /[. ]$/u.test(item) ||
          /[<>"|?*]/u.test(item) ||
          Array.from(item).some(
            (character) => character.codePointAt(0)! < 32,
          ) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(item),
      )
  )
    throw new HostedError(
      400,
      "unsafe_backup_path",
      "Backup contains an unsafe path.",
    );
  const target = resolve(root, ...path.split("/"));
  if (!inside(root, target))
    throw new HostedError(
      400,
      "unsafe_backup_path",
      "Backup path escapes its destination.",
    );
  return target;
}
function collect(
  root: string,
  directory: string,
  excluded: Set<string>,
  result: string[],
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (
      excluded.has(pathKey(path)) ||
      entry.name.startsWith(".backup-work-") ||
      (pathKey(directory) === pathKey(root) &&
        entry.name.startsWith(".stop-request-") &&
        entry.name.endsWith(".tmp")) ||
      /-(wal|shm)$/u.test(entry.name)
    )
      continue;
    if (entry.isSymbolicLink())
      throw new HostedError(
        400,
        "backup_symlink_forbidden",
        "Hosted backup cannot include symbolic links.",
      );
    if (entry.isDirectory()) collect(root, path, excluded, result);
    else if (entry.isFile()) result.push(path);
    else
      throw new HostedError(
        400,
        "backup_special_file",
        "Hosted backup contains a nonregular file.",
      );
  }
}

/** The caller pauses admissions and drains tenant jobs before this snapshot. */
export async function createHostedBackup(input: {
  store: HostedControlStore;
  destination: string;
  passphrase: string;
  quiesce?: () => Promise<(() => Promise<void>) | void>;
}): Promise<{
  path: string;
  keyPath: string;
  backupId: string;
  fileCount: number;
  createdAtUtc: string;
}> {
  const root = input.store.rootDirectory;
  const destination = resolve(input.destination);
  const keyPath = /\.dvbackup$/iu.test(destination)
    ? destination.replace(/\.dvbackup$/iu, ".dvkeys")
    : `${destination}.dvkeys`;
  if (existsSync(destination) || existsSync(keyPath))
    throw new HostedError(
      409,
      "backup_destination_exists",
      "The backup destination already exists.",
    );
  const resume = await input.quiesce?.();
  let temporary: string | undefined;
  try {
    temporary = mkdtempSync(join(root, ".backup-work-"));
    protectDirectory(temporary);
    const paths: string[] = [];
    collect(
      root,
      root,
      new Set(
        [
          temporary,
          destination,
          keyPath,
          join(root, "backups"),
          join(root, "runtime.lock"),
          join(root, "runtime-control.json"),
          join(root, "stop-request.json"),
        ].map(pathKey),
      ),
      paths,
    );
    const files: ArchiveFile[] = [];
    let bytesTotal = 0;
    for (const path of paths) {
      const archivePath = relative(root, path).split(sep).join("/");
      let bytes: Buffer;
      if (/\.(sqlite|db)$/iu.test(path)) {
        const snapshot = join(temporary, `${files.length}.sqlite`);
        const db =
          path === join(root, "control.sqlite")
            ? input.store.database
            : path === join(root, "research.sqlite")
              ? input.store.researchDatabase
              : new BetterSqlite3(path, { readonly: true });
        try {
          await db.backup(snapshot);
        } finally {
          if (
            db !== input.store.database &&
            db !== input.store.researchDatabase
          )
            db.close();
        }
        bytes = readFileSync(snapshot);
      } else
        bytes =
          archivePath === ".secrets/master.key"
            ? readPortableHostedMasterKey(path)
            : readFileSync(path);
      bytesTotal += bytes.length;
      if (bytesTotal > MAX_ARCHIVE_BYTES)
        throw new HostedError(
          413,
          "backup_too_large",
          "This backup exceeds the 512 MiB snapshot limit.",
        );
      files.push({
        path: archivePath,
        sha256: sha(bytes),
        data: bytes.toString("base64"),
      });
      if (archivePath === ".secrets/master.key") bytes.fill(0);
    }
    const createdAtUtc = new Date().toISOString();
    const backupId = randomUUID();
    const dataArchive: Archive = {
      format: "dearvale-hosted-files-v2",
      backupId,
      bundle: "data",
      createdAtUtc,
      files: files.filter((file) => !isSecretPath(file.path)),
    };
    const keysArchive: Archive = {
      ...dataArchive,
      bundle: "keys",
      files: files.filter((file) => isSecretPath(file.path)),
    };
    const encrypted = encryptBackup(
      gzipSync(Buffer.from(JSON.stringify(dataArchive))),
      input.passphrase,
    );
    const encryptedKeys = encryptBackup(
      gzipSync(Buffer.from(JSON.stringify(keysArchive))),
      input.passphrase,
    );
    mkdirSync(dirname(destination), { recursive: true });
    // Exclusive creation never overwrites a previous backup. A failed pair is removed.
    let keyCreated = false;
    let dataCreated = false;
    try {
      const keyFile = openSync(keyPath, "wx", 0o600);
      keyCreated = true;
      try {
        writeFileSync(keyFile, encryptedKeys);
      } finally {
        closeSync(keyFile);
      }
      const dataFile = openSync(destination, "wx", 0o600);
      dataCreated = true;
      try {
        writeFileSync(dataFile, encrypted);
      } finally {
        closeSync(dataFile);
      }
    } catch (error) {
      if (dataCreated) rmSync(destination);
      if (keyCreated) rmSync(keyPath);
      throw error;
    }
    input.store.audit("system", "backup.create", null, {
      fileCount: files.length,
    });
    return {
      path: destination,
      keyPath,
      backupId,
      fileCount: files.length,
      createdAtUtc,
    };
  } finally {
    try {
      if (temporary) {
        removeSnapshot(root, temporary);
      }
    } finally {
      await resume?.();
    }
  }
}

/** Restore while the hosted server is stopped, into an empty destination. */
export async function restoreHostedBackup(input: {
  source: string;
  keysSource: string;
  destination: string;
  passphrase: string;
}): Promise<{ path: string; backupId: string; fileCount: number }> {
  if (!input.keysSource)
    throw new HostedError(
      400,
      "backup_keys_required",
      "Restore requires the matching separate encryption-key backup.",
    );
  const destination = resolve(input.destination);
  const parent = dirname(destination);
  if (destination === parent)
    throw new HostedError(
      400,
      "invalid_restore_destination",
      "A filesystem root cannot be a restore destination.",
    );
  if (
    existsSync(destination) &&
    (!lstatSync(destination).isDirectory() ||
      lstatSync(destination).isSymbolicLink() ||
      readdirSync(destination).length > 0)
  )
    throw new HostedError(
      409,
      "restore_destination_not_empty",
      "Restore requires an empty, regular directory.",
    );
  const readArchive = async (source: string): Promise<Archive> => {
    if (!existsSync(source))
      throw new HostedError(
        400,
        "backup_file_missing",
        "A required backup file is missing.",
      );
    const sourceStat = lstatSync(source);
    if (
      !sourceStat.isFile() ||
      sourceStat.isSymbolicLink() ||
      sourceStat.size > MAX_ARCHIVE_BYTES * 2
    )
      throw new HostedError(400, "invalid_backup", "Invalid backup file.");
    let archive: Archive;
    try {
      archive = JSON.parse(
        gunzipSync(decryptBackup(await readFile(source), input.passphrase), {
          maxOutputLength: MAX_ARCHIVE_BYTES * 2,
        }).toString("utf8"),
      ) as Archive;
    } catch (error) {
      if (error instanceof HostedError) throw error;
      throw new HostedError(
        400,
        "invalid_backup",
        "The backup archive is invalid.",
      );
    }
    if (
      !archive ||
      typeof archive !== "object" ||
      archive.format !== "dearvale-hosted-files-v2" ||
      typeof archive.backupId !== "string" ||
      !archive.backupId ||
      !Array.isArray(archive.files) ||
      archive.files.length > 100000
    )
      throw new HostedError(
        400,
        "invalid_backup",
        "The backup archive format is invalid.",
      );
    return archive;
  };
  const dataArchive = await readArchive(input.source);
  const keysArchive = await readArchive(input.keysSource);
  if (
    dataArchive.bundle !== "data" ||
    keysArchive.bundle !== "keys" ||
    dataArchive.backupId !== keysArchive.backupId
  )
    throw new HostedError(
      400,
      "backup_pair_mismatch",
      "The data and key backups must be a matching pair.",
    );
  if (
    dataArchive.files.some(
      (file) => typeof file?.path !== "string" || isSecretPath(file.path),
    ) ||
    keysArchive.files.some(
      (file) => typeof file?.path !== "string" || !isSecretPath(file.path),
    )
  )
    throw new HostedError(
      400,
      "invalid_backup_partition",
      "The data and key backup contents are not correctly separated.",
    );
  const files = [...dataArchive.files, ...keysArchive.files];
  const required = new Set([
    "control.sqlite",
    "research.sqlite",
    ".secrets/master.key",
  ]);
  const seen = new Set<string>();
  let size = 0;
  for (const file of files) {
    if (
      typeof file?.path !== "string" ||
      typeof file.data !== "string" ||
      typeof file.sha256 !== "string"
    )
      throw new HostedError(
        400,
        "invalid_backup",
        "The backup contains invalid file metadata.",
      );
    safeArchivePath(destination, file.path);
    const collisionKey =
      process.platform === "win32"
        ? file.path.toLocaleLowerCase("en-US")
        : file.path;
    if (seen.has(collisionKey))
      throw new HostedError(
        400,
        "invalid_backup",
        "The backup contains duplicate paths.",
      );
    seen.add(collisionKey);
    const bytes = Buffer.from(file.data, "base64");
    size += bytes.length;
    if (size > MAX_ARCHIVE_BYTES || sha(bytes) !== file.sha256)
      throw new HostedError(
        400,
        "invalid_backup",
        "The backup file checksum is invalid.",
      );
    required.delete(file.path);
  }
  if (required.size)
    throw new HostedError(
      400,
      "incomplete_backup",
      "The backup is missing control data or encryption keys.",
    );
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, ".dearvale-restore-"));
  protectDirectory(temporary);
  try {
    for (const file of files) {
      const path = safeArchivePath(temporary, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const portableBytes = Buffer.from(file.data, "base64");
      const bytes =
        file.path === ".secrets/master.key"
          ? encodeHostedMasterKey(portableBytes)
          : portableBytes;
      writeFileSync(path, bytes, {
        flag: "wx",
        mode: 0o600,
      });
      if (file.path === ".secrets/master.key") portableBytes.fill(0);
    }
    for (const file of files.filter((item) =>
      /\.(sqlite|db)$/iu.test(item.path),
    )) {
      const db = new BetterSqlite3(safeArchivePath(temporary, file.path), {
        readonly: true,
      });
      try {
        if (db.pragma("integrity_check", { simple: true }) !== "ok")
          throw new HostedError(
            400,
            "backup_database_corrupt",
            "A restored database failed its integrity check.",
          );
      } finally {
        db.close();
      }
    }
    if (existsSync(destination)) rmdirSync(destination);
    renameSync(temporary, destination);
    protectDirectory(destination);
    return {
      path: destination,
      backupId: dataArchive.backupId,
      fileCount: files.length,
    };
  } catch (error) {
    if (
      !inside(parent, temporary) ||
      !temporary.startsWith(join(parent, ".dearvale-restore-"))
    )
      throw new Error("Unsafe restore cleanup target");
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}
