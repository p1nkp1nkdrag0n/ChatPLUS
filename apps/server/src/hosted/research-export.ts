import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { createInterface } from "node:readline";
import { protectDirectory } from "./crypto.js";
import { HostedError } from "./types.js";

interface ImageRecord {
  researchId: string;
  participantId: string;
  operationId: string;
  sessionId: string | null;
  attemptId: string | null;
  purpose: string;
  displayName: string;
  modelId: string;
  fileName: string;
  sha256: string;
  mimeType: string;
  width: number;
  height: number;
  byteLength: number;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HostedError(
      400,
      "invalid_research_export",
      "The research export contains invalid records.",
    );
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string")
    throw new HostedError(
      400,
      "invalid_research_export",
      "The research export metadata is invalid.",
    );
  return value;
}
function optionalString(value: unknown): string | null {
  return value === null || value === undefined ? null : string(value);
}
function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new HostedError(
      400,
      "invalid_research_image",
      "The research image dimensions or length are invalid.",
    );
  return value;
}
function imageRecord(value: Record<string, unknown>): {
  record: ImageRecord;
  bytes: Buffer;
} {
  const payload = object(value.payload);
  const checksum = string(payload.sha256);
  const mimeType = string(payload.mimeType);
  const extension = (
    { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as Record<
      string,
      string
    >
  )[mimeType];
  const fileName = string(payload.fileName);
  // Exports use a content-addressed path. Accept that exact shape, never arbitrary paths.
  if (
    !/^[a-f0-9]{64}$/u.test(checksum) ||
    !extension ||
    fileName !== `images/${checksum}.${extension}`
  )
    throw new HostedError(
      400,
      "unsafe_research_path",
      "The research export contains an unsafe image filename.",
    );
  const encoded = string(payload.data);
  if (payload.encoding !== "base64" || encoded.length > 45 * 1024 * 1024)
    throw new HostedError(
      400,
      "invalid_research_image",
      "The research image encoding is invalid or too large.",
    );
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.toString("base64") !== encoded ||
    bytes.length > 32 * 1024 * 1024 ||
    bytes.length !== positiveInteger(payload.byteLength) ||
    createHash("sha256").update(bytes).digest("hex") !== checksum
  )
    throw new HostedError(
      400,
      "research_checksum_mismatch",
      "The research image does not match its recorded checksum or length.",
    );
  return {
    bytes,
    record: {
      researchId: string(value.id),
      participantId: string(value.userId),
      operationId: string(value.operationId),
      sessionId: optionalString(value.sessionId),
      attemptId: optionalString(value.attemptId),
      purpose: string(value.purpose),
      displayName: string(value.displayName),
      modelId: string(value.modelId),
      fileName,
      sha256: checksum,
      mimeType,
      width: positiveInteger(payload.width),
      height: positiveInteger(payload.height),
      byteLength: bytes.length,
    },
  };
}

/** Extract only separately collected image records, retaining their research associations. */
export async function extractHostedResearchImages(input: {
  source: string;
  destination: string;
}): Promise<{
  path: string;
  manifestPath: string;
  fileCount: number;
  recordCount: number;
}> {
  const source = resolve(input.source);
  const sourceStat = lstatSync(source);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
    throw new HostedError(
      400,
      "invalid_research_export",
      "Research input must be a regular JSONL file.",
    );
  const destination = resolve(input.destination);
  const parent = dirname(destination);
  if (
    destination === parent ||
    (existsSync(destination) &&
      (!lstatSync(destination).isDirectory() ||
        lstatSync(destination).isSymbolicLink() ||
        readdirSync(destination).length))
  )
    throw new HostedError(
      409,
      "research_destination_not_empty",
      "Image extraction requires a new or empty regular directory.",
    );
  mkdirSync(parent, { recursive: true });
  const temporary = mkdtempSync(join(parent, ".dearvale-research-"));
  const records: ImageRecord[] = [];
  const written = new Set<string>();
  const stream = createReadStream(source, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let streamFailure: Error | undefined;
  stream.on("error", (error) => {
    streamFailure = error;
    lines.close();
  });
  try {
    protectDirectory(temporary);
    mkdirSync(join(temporary, "images"), { mode: 0o700 });
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > 64 * 1024 * 1024)
        throw new HostedError(
          413,
          "research_record_too_large",
          "A research record exceeds the 64 MiB extraction limit.",
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        throw new HostedError(
          400,
          "invalid_research_export",
          "The research export contains invalid JSON.",
        );
      }
      const value = object(parsed);
      if (value.kind !== "image") continue;
      const { record, bytes } = imageRecord(value);
      if (!written.has(record.fileName)) {
        writeFileSync(join(temporary, ...record.fileName.split("/")), bytes, {
          flag: "wx",
          mode: 0o600,
        });
        written.add(record.fileName);
      }
      records.push(record);
    }
    if (streamFailure)
      throw new HostedError(
        400,
        "research_read_failed",
        "The research export could not be read completely.",
      );
    writeFileSync(
      join(temporary, "manifest.json"),
      JSON.stringify(
        {
          format: "dearvale-research-images-v1",
          source: basename(source),
          extractedAtUtc: new Date().toISOString(),
          fileCount: written.size,
          recordCount: records.length,
          records,
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    if (existsSync(destination)) rmdirSync(destination);
    renameSync(temporary, destination);
    return {
      path: destination,
      manifestPath: join(destination, "manifest.json"),
      fileCount: written.size,
      recordCount: records.length,
    };
  } catch (error) {
    const part = relative(parent, temporary);
    if (
      !part ||
      part === ".." ||
      part.startsWith(`..${sep}`) ||
      isAbsolute(part) ||
      !temporary.startsWith(join(parent, ".dearvale-research-"))
    )
      throw new Error("Unsafe research extraction cleanup target");
    rmSync(temporary, { recursive: true, force: true });
    throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
}
