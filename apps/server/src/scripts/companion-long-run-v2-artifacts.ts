import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { canonicalJson, sha256File } from "./companion-long-run-v2-baseline.js";
import type {
  LongRunCheckpoint,
  RunManifest,
  TurnEvidence,
} from "./companion-long-run-v2-run-types.js";

const execFileAsync = promisify(execFile);
// Usage counters and token budgets are evidence, not credentials. Only redact
// fields whose names denote actual authentication material.
const SECRET_KEY =
  /(?:api.?key|authorization|credential|password|secret|(?:access|refresh|auth|id)[_-]?token|bearer)/iu;
const SECRET_TEXT =
  /(?:bearer\s+)[A-Za-z0-9._~+/-]{8,}|\bsk-[A-Za-z0-9_-]{8,}\b/giu;

export interface GitFingerprint {
  revision: string;
  dirty: boolean;
  dirtyPatchSha256?: string;
}

export async function readGitFingerprint(
  workspaceRoot: string,
): Promise<GitFingerprint> {
  const revision = (
    await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspaceRoot,
      encoding: "utf8",
    })
  ).stdout.trim();
  const status = (
    await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      },
    )
  ).stdout;
  if (status.trim() === "") return { revision, dirty: false };

  const trackedDiff = (
    await execFileAsync("git", ["diff", "--binary", "HEAD", "--"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
    })
  ).stdout;
  const untracked = (
    await execFileAsync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        cwd: workspaceRoot,
        encoding: "utf8",
        maxBuffer: 20 * 1024 * 1024,
      },
    )
  ).stdout
    .split("\0")
    .filter((path) => path !== "")
    .sort();
  const dirtyHash = createHash("sha256");
  dirtyHash.update(trackedDiff).update("\0").update(status).update("\0");
  // Dirty Pilots are allowed, so untracked implementation contents—not only
  // their names—must participate in compatibility checks. The digest is
  // retained; file contents are never copied into the manifest.
  for (const path of untracked) {
    dirtyHash.update(path).update("\0");
    dirtyHash.update(await readFile(resolve(workspaceRoot, path)));
    dirtyHash.update("\0");
  }
  return {
    revision,
    dirty: true,
    dirtyPatchSha256: dirtyHash.digest("hex"),
  };
}

export function redactLongRunArtifact(
  value: unknown,
  explicitSecrets: readonly string[] = [],
): unknown {
  const secrets = explicitSecrets.filter((secret) => secret.trim() !== "");
  const visit = (input: unknown, key?: string): unknown => {
    if (key !== undefined && SECRET_KEY.test(key)) {
      SECRET_KEY.lastIndex = 0;
      return key.toLowerCase().includes("present")
        ? Boolean(input)
        : "[REDACTED]";
    }
    SECRET_KEY.lastIndex = 0;
    if (typeof input === "string") {
      let safe = input.replace(SECRET_TEXT, (match) =>
        /^bearer\s+/iu.test(match) ? "Bearer [REDACTED]" : "[REDACTED]",
      );
      for (const secret of secrets)
        safe = safe.split(secret).join("[REDACTED]");
      return safe;
    }
    if (Array.isArray(input)) return input.map((item) => visit(item));
    if (typeof input !== "object" || input === null) return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(
        ([nestedKey, nested]) => [nestedKey, visit(nested, nestedKey)],
      ),
    );
  };
  return visit(value);
}

export async function writeRunManifest(
  directory: string,
  manifest: RunManifest,
): Promise<string> {
  const path = resolve(directory, "run-manifest.json");
  await writeJsonExclusive(path, manifest);
  return path;
}

export async function appendTurnEvidence(
  path: string,
  evidence: TurnEvidence,
  secrets: readonly string[] = [],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const safe = redactLongRunArtifact(evidence, secrets);
  await appendFile(path, `${JSON.stringify(safe)}\n`, { encoding: "utf8" });
}

export async function readTurnEvidence(path: string): Promise<TurnEvidence[]> {
  const text = await readFile(path, "utf8").catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  });
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as TurnEvidence);
}

export async function writeAtomicCheckpoint(
  directory: string,
  checkpoint: LongRunCheckpoint,
): Promise<string> {
  const suffix = String(checkpoint.completedCandidateTurns).padStart(3, "0");
  const path = resolve(directory, `checkpoint-${suffix}.json`);
  await writeJsonExclusive(path, checkpoint);
  return path;
}

export async function snapshotDatabase(
  source: string,
  destination: string,
): Promise<string> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  await copyFile(source, temporary);
  await rename(temporary, destination);
  return sha256File(destination);
}

export async function writeJsonExclusive(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  } finally {
    await handle.close();
  }
}

export async function writeTextExclusive(
  path: string,
  value: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(value, "utf8");
  } finally {
    await handle.close();
  }
}

export async function atomicWriteMutableJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

export function assertResumeCompatible(
  manifest: RunManifest,
  checkpoint: LongRunCheckpoint,
): void {
  const expected = canonicalJson({
    configSha256: manifest.configSha256,
    git: manifest.git,
    scenario: manifest.scenario,
    baseline: manifest.baseline,
    profileConfig: manifest.profileConfig,
  });
  const actual = canonicalJson(checkpoint.compatibility);
  if (actual !== expected) {
    throw new Error(
      "Checkpoint is incompatible with the current Git, scenario, baseline, or profile configuration.",
    );
  }
}

export function workspaceRelativePath(
  workspaceRoot: string,
  target: string,
): string {
  const output = relative(resolve(workspaceRoot), resolve(target));
  if (output.startsWith("..")) {
    throw new Error(`Artifact escaped the workspace: ${target}`);
  }
  return output.replaceAll("\\", "/");
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
