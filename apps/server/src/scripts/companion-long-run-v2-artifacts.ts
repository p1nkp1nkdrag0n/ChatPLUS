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
import { providerCacheUsage } from "./provider-metrics-summary.js";

import { canonicalJson, sha256File } from "./companion-long-run-v2-baseline.js";
import type {
  LongRunModelIoRecord,
  LongRunCheckpoint,
  ProviderAttemptEvidence,
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

export function projectLongRunModelIoRecords(
  evidence: TurnEvidence,
  manifest: RunManifest,
): LongRunModelIoRecord[] {
  const identity = {
    schemaVersion: "companion-long-run-model-io-v1" as const,
    matrixId: evidence.matrixId,
    runId: evidence.runId,
    ...(evidence.reusedFromRunId === undefined
      ? {}
      : { reusedFromRunId: evidence.reusedFromRunId }),
    profile: evidence.profile,
    repetition: evidence.repetition,
    track: evidence.track,
    branch: evidence.branch,
    turnId: evidence.turnId,
    logicalOrdinal: evidence.logicalOrdinal,
    candidateOrdinal: evidence.candidateOrdinal,
  };
  const records: LongRunModelIoRecord[] = [];
  const emittedAttemptIds = new Set<string>();
  for (const call of evidence.logicalCalls) {
    const logicalCallId =
      call.logicalCallId ??
      `${evidence.runId}:${evidence.turnId}:logical:${String(call.index)}`;
    const attempts = evidence.providerAttempts.filter(
      (attempt) =>
        attempt.logicalCallId === logicalCallId ||
        (attempt.logicalCallId === undefined &&
          attempt.logicalCallIndex === call.index),
    );
    records.push({
      ...identity,
      recordType: "logical_call",
      logicalCallId,
      logicalCallIndex: call.index,
      ...(call.phase === undefined ? {} : { phase: call.phase }),
      request: {
        purpose: call.purpose,
        system: call.system,
        prompt: call.prompt,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.prompt },
        ],
        promptSha256: call.promptSha256,
        provider: manifest.profileConfig.provider,
        requestedModel: manifest.profileConfig.requestedModel,
        parameters: {
          timeoutMs: manifest.profileConfig.timeoutMs,
          maxRetries: call.maxRetries ?? manifest.profileConfig.maxRetries,
          ...((call.maxOutputTokens ??
            manifest.profileConfig.maxOutputTokens) === undefined
            ? {}
            : {
                maxOutputTokens:
                  call.maxOutputTokens ??
                  manifest.profileConfig.maxOutputTokens,
              }),
          ...(manifest.profileConfig.maxContextTokens === undefined
            ? {}
            : { maxContextTokens: manifest.profileConfig.maxContextTokens }),
          ...(manifest.profileConfig.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: manifest.profileConfig.reasoningEffort }),
          ...(manifest.profileConfig.reasoningRequestFormat === undefined
            ? {}
            : {
                reasoningRequestFormat:
                  manifest.profileConfig.reasoningRequestFormat,
              }),
          ...(manifest.profileConfig.structuredOutputMode === undefined
            ? {}
            : {
                structuredOutputMode:
                  manifest.profileConfig.structuredOutputMode,
              }),
        },
      },
      response: {
        ...(call.success === undefined ? {} : { success: call.success }),
        ...(call.parsedOutput === undefined
          ? {}
          : { parsedOutput: call.parsedOutput }),
        ...(call.errorCode === undefined ? {} : { errorCode: call.errorCode }),
        ...(call.startedAtUtc === undefined
          ? {}
          : { startedAtUtc: call.startedAtUtc }),
        ...(call.completedAtUtc === undefined
          ? {}
          : { completedAtUtc: call.completedAtUtc }),
        ...(call.latencyMs === undefined ? {} : { latencyMs: call.latencyMs }),
      },
      physicalAttemptIds: attempts.map((attempt) => attempt.attemptId),
    });
    for (const attempt of attempts) {
      emittedAttemptIds.add(attempt.attemptId);
      records.push(projectPhysicalModelIoRecord(identity, attempt));
    }
  }
  for (const attempt of evidence.providerAttempts) {
    if (!emittedAttemptIds.has(attempt.attemptId)) {
      records.push(projectPhysicalModelIoRecord(identity, attempt));
    }
  }
  return records;
}

export async function appendLongRunModelIoEvidence(
  path: string,
  evidence: TurnEvidence,
  manifest: RunManifest,
  secrets: readonly string[] = [],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const records = projectLongRunModelIoRecords(evidence, manifest).map(
    (record) => redactLongRunArtifact(record, secrets),
  );
  if (records.length === 0) return;
  await appendFile(
    path,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    { encoding: "utf8" },
  );
}

export async function rewriteLongRunModelIoEvidence(
  path: string,
  evidence: readonly TurnEvidence[],
  manifest: RunManifest,
  secrets: readonly string[] = [],
): Promise<void> {
  const records = evidence.flatMap((turn) =>
    projectLongRunModelIoRecords(turn, manifest),
  );
  const safe = records.map((record) => redactLongRunArtifact(record, secrets));
  await atomicWriteMutableText(
    path,
    safe.map((record) => JSON.stringify(record)).join("\n") +
      (safe.length === 0 ? "" : "\n"),
  );
}

export async function aggregateLongRunProfileModelIo(input: {
  matrixDirectory: string;
  profile: string;
  runDirectories: readonly string[];
}): Promise<string> {
  const records: unknown[] = [];
  for (const runDirectory of input.runDirectories) {
    const path = resolve(runDirectory, "model-io.jsonl");
    const text = await readFile(path, "utf8").catch((error: unknown) => {
      if (isNodeError(error) && error.code === "ENOENT") return "";
      throw error;
    });
    for (const [index, line] of text.split(/\r?\n/u).entries()) {
      if (line.trim() === "") continue;
      let record: unknown;
      try {
        record = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(
          `Invalid model I/O JSONL at ${path}:${String(index + 1)}.`,
          { cause: error },
        );
      }
      if (
        !isRecord(record) ||
        record["profile"] !== input.profile ||
        typeof record["runId"] !== "string" ||
        typeof record["repetition"] !== "number"
      ) {
        throw new Error(
          `Model I/O record does not belong to profile ${input.profile}: ${path}:${String(index + 1)}.`,
        );
      }
      records.push(redactLongRunArtifact(record));
    }
  }
  const destination = resolve(
    input.matrixDirectory,
    "profiles",
    input.profile,
    "model-io.jsonl",
  );
  await atomicWriteMutableText(
    destination,
    records.map((record) => JSON.stringify(record)).join("\n") +
      (records.length === 0 ? "" : "\n"),
  );
  return destination;
}

function projectPhysicalModelIoRecord(
  identity: Pick<
    Extract<LongRunModelIoRecord, { recordType: "physical_attempt" }>,
    | "schemaVersion"
    | "matrixId"
    | "runId"
    | "reusedFromRunId"
    | "profile"
    | "repetition"
    | "track"
    | "branch"
    | "turnId"
    | "logicalOrdinal"
    | "candidateOrdinal"
  >,
  attempt: ProviderAttemptEvidence,
): LongRunModelIoRecord {
  return {
    ...identity,
    recordType: "physical_attempt",
    ...(attempt.providerLogicalCallId === undefined
      ? {}
      : { providerLogicalCallId: attempt.providerLogicalCallId }),
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attempt,
    ...(attempt.logicalCallId === undefined
      ? {}
      : { logicalCallId: attempt.logicalCallId }),
    ...(attempt.logicalCallIndex === undefined
      ? {}
      : { logicalCallIndex: attempt.logicalCallIndex }),
    ...(attempt.phase === undefined ? {} : { phase: attempt.phase }),
    request: {
      method: "POST",
      ...(attempt.requestUrl === undefined ? {} : { url: attempt.requestUrl }),
      purpose: attempt.purpose,
      provider: attempt.provider,
      configuredModel: attempt.model,
      ...(attempt.requestModel === undefined
        ? {}
        : { requestModel: attempt.requestModel }),
      ...(attempt.requestBody === undefined
        ? {}
        : { body: attempt.requestBody }),
    },
    response: {
      success: attempt.success,
      ...(attempt.status === undefined ? {} : { status: attempt.status }),
      ...(attempt.responseModel === undefined
        ? {}
        : { responseModel: attempt.responseModel }),
      ...(attempt.finishReason === undefined
        ? {}
        : { finishReason: attempt.finishReason }),
      ...(attempt.errorCode === undefined
        ? {}
        : { errorCode: attempt.errorCode }),
      ...(attempt.rawResponse === undefined
        ? {}
        : { raw: attempt.rawResponse }),
      ...(attempt.responseText === undefined
        ? {}
        : { text: attempt.responseText }),
      usage: {
        ...providerCacheUsage(attempt),
        ...(attempt.usageSource === undefined
          ? {}
          : { source: attempt.usageSource }),
        ...(attempt.inputTokens === undefined
          ? {}
          : { inputTokens: attempt.inputTokens }),
        ...(attempt.outputTokens === undefined
          ? {}
          : { outputTokens: attempt.outputTokens }),
      },
      latencyMs: attempt.latencyMs,
      startedAtUtc: attempt.startedAtUtc,
      completedAtUtc: attempt.completedAtUtc,
    },
  };
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

export async function atomicWriteMutableText(
  path: string,
  value: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, value, "utf8");
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

/**
 * Applies the same immutable-input guard to an already completed run that the
 * runner applies before resuming an incomplete run. Creation time is metadata;
 * every other manifest field must still match exactly.
 */
export function assertRunManifestCompatible(
  current: RunManifest,
  persisted: RunManifest,
): void {
  const comparable = (manifest: RunManifest) => ({
    ...manifest,
    createdAtUtc: "<ignored-on-resume>",
  });
  if (
    canonicalJson(comparable(current)) !== canonicalJson(comparable(persisted))
  ) {
    throw new Error(
      "Existing run manifest is incompatible with this resume request.",
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
