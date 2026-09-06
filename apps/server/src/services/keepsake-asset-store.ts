import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import { EntityIdSchema } from "@personasim/contracts";
import sharp from "sharp";

export interface StoreKeepsakeAssetInput {
  readonly agentId: string;
  readonly bytes: Uint8Array;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly thumbnailWidth?: number;
}

export interface StoredKeepsakeAssetFiles {
  readonly storageKey: string;
  readonly thumbnailStorageKey: string;
  readonly sha256: string;
  readonly thumbnailSha256: string;
  readonly width: number;
  readonly height: number;
  readonly mimeType: "image/webp";
  readonly createdStorageFile: boolean;
  readonly createdThumbnailFile: boolean;
}

export class KeepsakeAssetStore {
  readonly #root: string;

  constructor(rootPath: string) {
    if (rootPath.trim().length === 0) {
      throw new TypeError("Keepsake asset storage path cannot be empty");
    }
    this.#root = resolve(rootPath);
  }

  get rootPath(): string {
    return this.#root;
  }

  async persist(
    input: StoreKeepsakeAssetInput,
  ): Promise<StoredKeepsakeAssetFiles> {
    const agentId = EntityIdSchema.parse(input.agentId);
    if (input.bytes.byteLength === 0) {
      throw new TypeError("Generated keepsake asset cannot be empty");
    }
    const maxWidth = boundedDimension(input.maxWidth ?? 1600, "maxWidth");
    const maxHeight = boundedDimension(input.maxHeight ?? 1600, "maxHeight");
    const thumbnailWidth = boundedDimension(
      input.thumbnailWidth ?? 420,
      "thumbnailWidth",
    );

    const source = Buffer.from(input.bytes);
    const primary = await sharp(source, {
      failOn: "error",
      limitInputPixels: 32_000_000,
    })
      .rotate()
      .resize({
        width: maxWidth,
        height: maxHeight,
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 86, effort: 4 })
      .toBuffer({ resolveWithObject: true });
    const width = primary.info.width;
    const height = primary.info.height;
    if (width <= 0 || height <= 0 || width > maxWidth || height > maxHeight) {
      throw new TypeError("Normalized keepsake asset dimensions are invalid");
    }

    const thumbnail = await sharp(primary.data, { failOn: "error" })
      .resize({ width: thumbnailWidth, withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();
    const sha256 = digest(primary.data);
    const thumbnailSha256 = digest(thumbnail);
    const agentSegment = encodeURIComponent(agentId);
    const storageKey = `${agentSegment}/${sha256}.webp`;
    const thumbnailStorageKey = `${agentSegment}/${thumbnailSha256}.thumb.webp`;
    const storageResult = await this.#atomicWrite(storageKey, primary.data);
    let thumbnailResult: boolean;
    try {
      thumbnailResult = await this.#atomicWrite(thumbnailStorageKey, thumbnail);
    } catch (error) {
      if (storageResult) await this.remove(storageKey).catch(() => undefined);
      throw error;
    }

    // Read-after-rename validation guards partial/corrupt writes on unusual
    // filesystems before any SQLite metadata is committed.
    try {
      await this.#assertStoredDigest(storageKey, sha256);
      await this.#assertStoredDigest(thumbnailStorageKey, thumbnailSha256);
    } catch (error) {
      // `persist` has not returned yet, so its caller cannot know which files
      // were created. Clean up here while preserving any pre-existing
      // content-addressed files won by another writer.
      if (storageResult) await this.remove(storageKey).catch(() => undefined);
      if (thumbnailResult) {
        await this.remove(thumbnailStorageKey).catch(() => undefined);
      }
      throw error;
    }
    return {
      storageKey,
      thumbnailStorageKey,
      sha256,
      thumbnailSha256,
      width,
      height,
      mimeType: "image/webp",
      createdStorageFile: storageResult,
      createdThumbnailFile: thumbnailResult,
    };
  }

  async read(storageKey: string): Promise<Buffer> {
    return readFile(this.#resolveStorageKey(storageKey));
  }

  async remove(storageKey: string): Promise<void> {
    await unlink(this.#resolveStorageKey(storageKey)).catch(
      (error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      },
    );
  }

  async removeIfCreated(
    result: StoredKeepsakeAssetFiles,
    isReferenced: (storageKey: string) => boolean,
  ): Promise<void> {
    if (result.createdStorageFile && !isReferenced(result.storageKey)) {
      await this.remove(result.storageKey);
    }
    if (
      result.createdThumbnailFile &&
      !isReferenced(result.thumbnailStorageKey)
    ) {
      await this.remove(result.thumbnailStorageKey);
    }
  }

  async scanOrphans(referencedStorageKeys: ReadonlySet<string>): Promise<{
    readonly inspected: number;
    readonly removedStorageKeys: readonly string[];
  }> {
    await mkdir(this.#root, { recursive: true });
    const removed: string[] = [];
    let inspected = 0;
    for (const directory of await readdir(this.#root, {
      withFileTypes: true,
    })) {
      if (!directory.isDirectory()) continue;
      const directoryPath = resolve(this.#root, directory.name);
      for (const entry of await readdir(directoryPath, {
        withFileTypes: true,
      })) {
        if (!entry.isFile()) continue;
        const storageKey = `${directory.name}/${entry.name}`;
        inspected += 1;
        const isTemporary = entry.name.includes(".tmp-");
        const isManaged = entry.name.endsWith(".webp");
        if (
          (isTemporary || isManaged) &&
          !referencedStorageKeys.has(storageKey)
        ) {
          await this.remove(storageKey);
          removed.push(storageKey);
        }
      }
    }
    removed.sort(codeUnitCompare);
    return { inspected, removedStorageKeys: removed };
  }

  async #atomicWrite(storageKey: string, bytes: Uint8Array): Promise<boolean> {
    const destination = this.#resolveStorageKey(storageKey);
    await mkdir(dirname(destination), { recursive: true });
    try {
      await stat(destination);
      return false;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
    const temporary = `${destination}.tmp-${randomUUID()}`;
    try {
      await writeFile(temporary, bytes, { flag: "wx" });
      try {
        await rename(temporary, destination);
        return true;
      } catch (error) {
        if (!isNodeError(error, "EEXIST") && !isNodeError(error, "EPERM")) {
          throw error;
        }
        // A concurrent writer may have won. It is safe only if the final
        // content is identical; the read-after-write digest check enforces it.
        await stat(destination);
        return false;
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!isNodeError(error, "ENOENT")) throw error;
      });
    }
  }

  async #assertStoredDigest(
    storageKey: string,
    expected: string,
  ): Promise<void> {
    const actual = digest(await this.read(storageKey));
    if (actual !== expected) {
      throw new Error("Stored keepsake asset failed integrity validation");
    }
  }

  #resolveStorageKey(storageKey: string): string {
    if (
      storageKey.length === 0 ||
      storageKey.includes("\\") ||
      storageKey.startsWith("/") ||
      storageKey
        .split("/")
        .some((segment) => segment === ".." || segment === "")
    ) {
      throw new TypeError("Invalid keepsake storage key");
    }
    const absolute = resolve(this.#root, ...storageKey.split("/"));
    const pathFromRoot = relative(this.#root, absolute);
    if (
      pathFromRoot === "" ||
      pathFromRoot === ".." ||
      pathFromRoot.startsWith(`..${sep}`)
    ) {
      throw new TypeError("Keepsake storage key escaped its configured root");
    }
    return absolute;
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedDimension(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 64 || value > 4096) {
    throw new RangeError(`${name} must be an integer from 64 to 4096`);
  }
  return value;
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
