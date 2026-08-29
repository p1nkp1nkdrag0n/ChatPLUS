import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readConfig } from "../config.js";
import { COMPANION_LONG_RUN_V2_SHA256 } from "../scenarios/companion-long-run-v2-manifest.js";
import {
  readGitFingerprint,
  readTurnEvidence,
  writeJsonExclusive,
  writeTextExclusive,
} from "./companion-long-run-v2-artifacts.js";
import {
  buildLongRunV2ChildEnvironment,
  evaluatePaidLongRunGuard,
  parseLongRunV2ProfileArgs,
  readLongRunV2ProfileConfig,
  rotateLongRunV2Profiles,
} from "./companion-long-run-v2-profiles.js";
import {
  findPairedPromptHashMismatches,
  renderLongRunV2RunMarkdown,
} from "./companion-long-run-v2-report.js";
import {
  artifactRoot,
  buildLongRunV2ServerConfig,
  computeLongRunV2ConfigSha256,
  fixtureProfileSnapshot,
  liveProfileSnapshot,
  runCompanionLongRunV2Single,
  suggestedMatrixId,
  suggestedRunId,
} from "./companion-long-run-v2-runner.js";
import type {
  LongRunV2Mode,
  LongRunV2Profile,
  RunManifest,
  RunSummary,
} from "./companion-long-run-v2-run-types.js";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const scriptPath = fileURLToPath(import.meta.url);

interface CommonOptions {
  matrixId?: string;
  resume: boolean;
  profiles: LongRunV2Profile[];
  runs: 1 | 2 | 3;
}

interface WorkerOptions {
  mode: "pilot" | "matrix";
  matrixId: string;
  matrixDirectory: string;
  runId: string;
  profile: LongRunV2Profile;
  repetition: 1 | 2 | 3;
  tracks: ("paired" | "closed_loop")[];
  reusedPilotDirectory?: string;
  resume: boolean;
}

export async function companionLongRunV2Main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case "fixture":
      await runFixture(parseCommonOptions(rest, { runs: 1 }));
      return;
    case "pilot":
      await runPaidParent("pilot", parseCommonOptions(rest, { runs: 1 }));
      return;
    case "matrix":
      await runPaidParent("matrix", parseCommonOptions(rest, { runs: 3 }));
      return;
    case "worker":
      await runWorker(parseWorkerOptions(rest));
      return;
    default:
      throw new TypeError(
        "Usage: companion-long-run-v2 <fixture|pilot|matrix> [--profiles all] [--runs 3] [--matrix <id>] [--resume]",
      );
  }
}

async function runFixture(options: CommonOptions): Promise<void> {
  const matrixId = options.matrixId ?? suggestedMatrixId("fixture");
  const matrixDirectory = resolve(artifactRoot(workspaceRoot), matrixId);
  await ensureFreshOrResume(matrixDirectory, options.resume);
  await writeMatrixPlan(matrixDirectory, {
    matrixId,
    mode: "fixture",
    profiles: ["fixture"],
    runs: 1,
    rotations: [{ repetition: 1, profiles: ["fixture"] }],
  });
  const base = readFixtureConfig();
  const profile = fixtureProfileSnapshot();
  const result = await runCompanionLongRunV2Single({
    workspaceRoot,
    matrixDirectory,
    matrixId,
    runId: suggestedRunId("fixture", 1),
    mode: "fixture",
    profile: "fixture",
    repetition: 1,
    serverConfig: buildLongRunV2ServerConfig(
      base,
      resolve(matrixDirectory, "fixture-placeholder.sqlite"),
      true,
    ),
    profileConfig: profile.profileConfig,
    profileConfigSha256: profile.configSha256,
    tracks: ["paired", "closed_loop"],
    resume: options.resume,
  });
  await writeMatrixScorecard(matrixDirectory, [result.summary], new Set(), 1);
  console.log(`Fixture complete: ${result.summary.finalStatus}`);
  console.log(matrixDirectory);
  if (result.summary.finalStatus !== "PASS") process.exitCode = 1;
}

async function runPaidParent(
  mode: "pilot" | "matrix",
  options: CommonOptions,
): Promise<void> {
  const guard = evaluatePaidLongRunGuard(process.env);
  if (guard.status === "SKIPPED") {
    console.log(`SKIPPED: ${guard.reason}`);
    return;
  }
  const git = await readGitFingerprint(workspaceRoot);
  if (mode === "matrix" && git.dirty) {
    throw new Error(
      "Formal long-run matrix requires a clean Git worktree. Commit or otherwise clean the intended revision first.",
    );
  }
  const matrixId = options.matrixId ?? suggestedMatrixId(mode);
  const matrixDirectory = resolve(artifactRoot(workspaceRoot), matrixId);
  await ensureFreshOrResume(matrixDirectory, options.resume);
  const rotations =
    mode === "pilot"
      ? [{ repetition: 1 as const, profiles: options.profiles }]
      : rotateLongRunV2Profiles(options.profiles, options.runs);
  await writeMatrixPlan(matrixDirectory, {
    matrixId,
    mode,
    profiles: options.profiles,
    runs: mode === "pilot" ? 1 : options.runs,
    rotations,
  });

  const summaries: RunSummary[] = [];
  const blocked = new Set<LongRunV2Profile>();
  let workerFailed = false;
  for (const rotation of rotations) {
    for (const profile of rotation.profiles) {
      if (blocked.has(profile)) {
        console.log(
          `SKIPPED ${profile} r${String(rotation.repetition)}: Pilot gate failed.`,
        );
        continue;
      }
      const runId = suggestedRunId(profile, rotation.repetition);
      const runDirectory = resolve(matrixDirectory, "runs", runId);
      if (
        options.resume &&
        (await pathExists(resolve(runDirectory, "run-summary.json")))
      ) {
        summaries.push(await readRunSummary(runDirectory));
        continue;
      }
      let reusedPilotDirectory: string | undefined;
      if (mode === "matrix" && rotation.repetition === 1) {
        reusedPilotDirectory = await findReusablePilot(profile, git);
      }
      console.log(
        `${mode.toUpperCase()} ${profile} r${String(rotation.repetition)}${reusedPilotDirectory ? " (reusing paid Pilot 30/30)" : ""}`,
      );
      const child = await spawnWorker({
        mode,
        matrixId,
        matrixDirectory,
        runId,
        profile,
        repetition: rotation.repetition,
        tracks: mode === "pilot" ? ["paired"] : ["paired", "closed_loop"],
        ...(reusedPilotDirectory ? { reusedPilotDirectory } : {}),
        resume: options.resume,
      });
      if (!child.ok) {
        workerFailed = true;
        console.error(
          `Worker failed for ${profile} r${String(rotation.repetition)} (exit ${String(child.exitCode)}).`,
        );
        if (rotation.repetition === 1) blocked.add(profile);
        continue;
      }
      const summary = await readRunSummary(runDirectory);
      summaries.push(summary);
      if (rotation.repetition === 1) {
        const gate = JSON.parse(
          await readFile(resolve(runDirectory, "pilot-gate.json"), "utf8"),
        ) as { eligibleForClosedLoop: boolean };
        if (!gate.eligibleForClosedLoop) blocked.add(profile);
      }
    }
  }
  await writeMatrixScorecard(
    matrixDirectory,
    summaries,
    blocked,
    options.profiles.length * (mode === "pilot" ? 1 : options.runs),
  );
  console.log(`Matrix artifacts: ${matrixDirectory}`);
  if (
    summaries.some((summary) =>
      ["FAIL_PRODUCT", "FAIL_PROVIDER", "PARTIAL"].includes(
        summary.finalStatus,
      ),
    ) ||
    blocked.size > 0 ||
    workerFailed
  ) {
    process.exitCode = 1;
  }
}

async function runWorker(options: WorkerOptions): Promise<void> {
  if (evaluatePaidLongRunGuard(process.env).status !== "READY") {
    throw new Error("Paid worker started without RUN_PAID_LONGRUN=1.");
  }
  const profileSnapshot = readLongRunV2ProfileConfig(options.profile);
  if (!profileSnapshot.apiKeyPresent) {
    throw new Error(
      `API key is missing for ${options.profile} (${profileSnapshot.apiKeyEnvironment}).`,
    );
  }
  const base = readConfig();
  await runCompanionLongRunV2Single({
    workspaceRoot,
    matrixDirectory: options.matrixDirectory,
    matrixId: options.matrixId,
    runId: options.runId,
    mode: options.mode,
    profile: options.profile,
    repetition: options.repetition,
    serverConfig: buildLongRunV2ServerConfig(
      base,
      resolve(options.matrixDirectory, "worker-placeholder.sqlite"),
      false,
    ),
    profileConfig: liveProfileSnapshot(profileSnapshot),
    profileConfigSha256: profileSnapshot.configSha256,
    tracks: options.tracks,
    ...(options.reusedPilotDirectory
      ? { reusedPilotDirectory: options.reusedPilotDirectory }
      : {}),
    resume: options.resume,
  });
}

async function spawnWorker(options: WorkerOptions): Promise<{
  ok: boolean;
  exitCode: number | null;
}> {
  const args = [
    "worker",
    "--mode",
    options.mode,
    "--matrix",
    options.matrixId,
    "--matrix-directory",
    options.matrixDirectory,
    "--run-id",
    options.runId,
    "--profile",
    options.profile,
    "--repetition",
    String(options.repetition),
    "--tracks",
    options.tracks.join(","),
    ...(options.reusedPilotDirectory
      ? ["--reuse-pilot", options.reusedPilotDirectory]
      : []),
    ...(options.resume ? ["--resume"] : []),
  ];
  const environment = buildLongRunV2ChildEnvironment(
    profileFromWorker(options),
  );
  const child = fork(scriptPath, args, {
    cwd: workspaceRoot,
    env: environment,
    execArgv: process.execArgv,
    stdio: "inherit",
  });
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (exitCode) =>
      resolvePromise({ ok: exitCode === 0, exitCode }),
    );
  });
}

function profileFromWorker(options: WorkerOptions): LongRunV2Profile {
  return options.profile;
}

async function findReusablePilot(
  profile: LongRunV2Profile,
  git: Awaited<ReturnType<typeof readGitFingerprint>>,
): Promise<string | undefined> {
  const root = artifactRoot(workspaceRoot);
  const matrixNames = await readdir(root).catch(() => []);
  const candidates: Array<{ directory: string; createdAtUtc: string }> = [];
  const currentProfile = readLongRunV2ProfileConfig(profile);
  const currentProfileConfig = liveProfileSnapshot(currentProfile);
  const currentConfigSha256 = computeLongRunV2ConfigSha256(
    currentProfile.configSha256,
    readFixtureConfig().conversationRetention,
  );
  for (const matrixName of matrixNames) {
    const runDirectory = resolve(
      root,
      matrixName,
      "runs",
      suggestedRunId(profile, 1),
    );
    const manifestPath = resolve(runDirectory, "run-manifest.json");
    const gatePath = resolve(runDirectory, "pilot-gate.json");
    if (!(await pathExists(manifestPath)) || !(await pathExists(gatePath)))
      continue;
    const manifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as RunManifest;
    const gate = JSON.parse(await readFile(gatePath, "utf8")) as {
      eligibleForClosedLoop?: boolean;
    };
    if (
      manifest.mode === "pilot" &&
      manifest.profile === profile &&
      gate.eligibleForClosedLoop === true &&
      manifest.git.revision === git.revision &&
      manifest.git.dirty === git.dirty &&
      manifest.git.dirtyPatchSha256 === git.dirtyPatchSha256 &&
      manifest.scenario.manifestSha256 === COMPANION_LONG_RUN_V2_SHA256 &&
      manifest.configSha256 === currentConfigSha256 &&
      JSON.stringify(manifest.profileConfig) ===
        JSON.stringify(currentProfileConfig)
    ) {
      candidates.push({
        directory: runDirectory,
        createdAtUtc: manifest.createdAtUtc,
      });
    }
  }
  return candidates
    .sort((left, right) => right.createdAtUtc.localeCompare(left.createdAtUtc))
    .at(0)?.directory;
}

async function writeMatrixPlan(
  matrixDirectory: string,
  input: {
    matrixId: string;
    mode: LongRunV2Mode;
    profiles: readonly (LongRunV2Profile | "fixture")[];
    runs: number;
    rotations: readonly {
      repetition: number;
      profiles: readonly (LongRunV2Profile | "fixture")[];
    }[];
  },
): Promise<void> {
  const path = resolve(matrixDirectory, "matrix-plan.json");
  if (await pathExists(path)) return;
  await writeJsonExclusive(path, {
    schemaVersion: "companion-long-run-matrix-plan-v2",
    ...input,
    scenarioSha256: COMPANION_LONG_RUN_V2_SHA256,
    createdAtUtc: new Date().toISOString(),
  });
}

async function writeMatrixScorecard(
  matrixDirectory: string,
  summaries: readonly RunSummary[],
  blocked: ReadonlySet<LongRunV2Profile> = new Set(),
  expectedRunCount = summaries.length,
): Promise<void> {
  const allEvidence = (
    await Promise.all(
      summaries.map((summary) => readTurnEvidence(summary.evidencePath)),
    )
  ).flat();
  const mismatches = findPairedPromptHashMismatches(summaries, allEvidence);
  const failed =
    summaries.some((summary) =>
      [
        "FAIL_PRODUCT",
        "FAIL_PROVIDER",
        "FAIL_SEMANTIC",
        "PARTIAL",
        "SKIPPED",
      ].includes(summary.finalStatus),
    ) ||
    summaries.length !== expectedRunCount ||
    blocked.size > 0 ||
    mismatches.length > 0;
  const warned = summaries.some(
    (summary) => summary.finalStatus === "PASS_WITH_WARNINGS",
  );
  const scorecard = {
    schemaVersion: "companion-long-run-engineering-scorecard-v2",
    final: failed ? "FAIL" : warned ? "PASS_WITH_WARNINGS" : "PASS",
    expectedRunCount,
    runCount: summaries.length,
    blockedProfiles: [...blocked],
    pairedPromptHashMismatches: mismatches,
    runs: summaries.map((summary) => ({
      runId: summary.manifest.runId,
      profile: summary.manifest.profile,
      repetition: summary.manifest.repetition,
      status: summary.finalStatus,
      completed: summary.completed,
      repairRate: summary.provider.repairRate,
    })),
    createdAtUtc: new Date().toISOString(),
  };
  await writeJsonExclusive(
    resolve(matrixDirectory, "engineering-scorecard.json"),
    scorecard,
  );
  const markdown = [
    "# ChatPLUS companion long-run v2 engineering scorecard",
    "",
    `- Status: **${scorecard.final}**`,
    `- Runs: ${String(scorecard.runCount)}`,
    `- Blocked profiles: ${scorecard.blockedProfiles.join(", ") || "none"}`,
    `- Paired prompt mismatches: ${scorecard.pairedPromptHashMismatches.join(", ") || "none"}`,
    "",
    ...summaries.flatMap((summary) => [
      `## ${summary.manifest.profile} r${String(summary.manifest.repetition)}`,
      "",
      renderLongRunV2RunMarkdown(summary),
      "",
    ]),
  ].join("\n");
  await writeTextExclusive(
    resolve(matrixDirectory, "engineering-scorecard.md"),
    markdown,
  );
}

function parseCommonOptions(
  argv: readonly string[],
  defaults: { runs: 1 | 2 | 3 },
): CommonOptions {
  let matrixId: string | undefined;
  let resume = false;
  const profileArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--matrix") {
      matrixId = requiredValue(argv, ++index, value);
    } else if (value?.startsWith("--matrix=")) {
      matrixId = value.slice("--matrix=".length);
    } else if (value === "--resume") {
      resume = true;
    } else if (value === "--profiles" || value === "--runs") {
      profileArgs.push(value, requiredValue(argv, ++index, value));
    } else if (
      value?.startsWith("--profiles=") ||
      value?.startsWith("--runs=")
    ) {
      profileArgs.push(value);
    } else {
      throw new TypeError(`Unknown argument: ${value ?? "<missing>"}`);
    }
  }
  if (!profileArgs.some((item) => item.startsWith("--runs"))) {
    profileArgs.push("--runs", String(defaults.runs));
  }
  const selection = parseLongRunV2ProfileArgs(profileArgs);
  return {
    ...(matrixId === undefined
      ? {}
      : { matrixId: validateArtifactId(matrixId) }),
    resume,
    profiles: selection.profiles,
    runs: selection.runs,
  };
}

function parseWorkerOptions(argv: readonly string[]): WorkerOptions {
  const values = parseNamedValues(argv);
  const mode = values.get("mode");
  const profile = values.get("profile");
  const repetition = Number(values.get("repetition"));
  const tracks = values.get("tracks")?.split(",");
  if (mode !== "pilot" && mode !== "matrix")
    throw new TypeError("Invalid worker mode.");
  const parsedProfile = parseLongRunV2ProfileArgs([
    "--profiles",
    profile ?? "",
    "--runs",
    "1",
  ]).profiles[0];
  if (!parsedProfile || ![1, 2, 3].includes(repetition)) {
    throw new TypeError("Invalid worker profile or repetition.");
  }
  if (
    !tracks ||
    tracks.some((track) => track !== "paired" && track !== "closed_loop")
  ) {
    throw new TypeError("Invalid worker tracks.");
  }
  return {
    mode,
    matrixId: validateArtifactId(requiredMap(values, "matrix")),
    matrixDirectory: resolve(requiredMap(values, "matrix-directory")),
    runId: validateArtifactId(requiredMap(values, "run-id")),
    profile: parsedProfile,
    repetition: repetition as 1 | 2 | 3,
    tracks: tracks as ("paired" | "closed_loop")[],
    ...(values.get("reuse-pilot")
      ? { reusedPilotDirectory: resolve(values.get("reuse-pilot")!) }
      : {}),
    resume: values.has("resume"),
  };
}

function parseNamedValues(argv: readonly string[]): Map<string, string> {
  const output = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--"))
      throw new TypeError(`Invalid worker argument: ${arg}`);
    const key = arg.slice(2);
    if (key === "resume") {
      output.set(key, "1");
      continue;
    }
    output.set(key, requiredValue(argv, ++index, arg));
  }
  return output;
}

function requiredMap(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new TypeError(`--${key} is required.`);
  return value;
}

function requiredValue(
  argv: readonly string[],
  index: number,
  argument: string,
): string {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new TypeError(`${argument} requires a value.`);
  }
  return value;
}

function validateArtifactId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u.test(value)) {
    throw new TypeError("Artifact ID contains unsupported characters.");
  }
  return value;
}

function readFixtureConfig() {
  const previousProvider = process.env["LLM_PROVIDER"];
  const previousProfile = process.env["LLM_ACTIVE_PROFILE"];
  process.env["LLM_PROVIDER"] = "fixture";
  delete process.env["LLM_ACTIVE_PROFILE"];
  try {
    return readConfig();
  } finally {
    setOrDeleteEnvironment("LLM_PROVIDER", previousProvider);
    setOrDeleteEnvironment("LLM_ACTIVE_PROFILE", previousProfile);
  }
}

function setOrDeleteEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function ensureFreshOrResume(
  directory: string,
  resume: boolean,
): Promise<void> {
  if (await pathExists(directory)) {
    if (!resume)
      throw new Error(`Artifact directory already exists: ${directory}`);
    return;
  }
  await mkdir(directory, { recursive: true });
}

async function readRunSummary(runDirectory: string): Promise<RunSummary> {
  return JSON.parse(
    await readFile(resolve(runDirectory, "run-summary.json"), "utf8"),
  ) as RunSummary;
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  companionLongRunV2Main().catch((error: unknown) => {
    const failureId = randomUUID();
    console.error(
      `companion-long-run-v2 failed (${failureId}):`,
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
