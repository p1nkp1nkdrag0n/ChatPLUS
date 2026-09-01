import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readGitFingerprint } from "./companion-long-run-v2-artifacts.js";
import { readLongRunV2ProfileConfig } from "./companion-long-run-v2-profiles.js";
import { runCompanionLongRunV3 } from "./companion-long-run-v3-runner.js";

export type CompanionLongRunV3Command = "fixture" | "run" | "resume";
export type CompanionLongRunV3RealProfile = "deepseek" | "bigmodel";

export interface CompanionLongRunV3CliOptions {
  command: CompanionLongRunV3Command;
  profile: "fixture" | CompanionLongRunV3RealProfile;
  runId: string;
  resume: boolean;
}

const scriptPath = fileURLToPath(import.meta.url);
const workspaceRoot = resolve(dirname(scriptPath), "../../../..");

const USAGE = [
  "Usage:",
  "  companion-long-run-v3 fixture [--run-id <id>] [--profile deepseek|bigmodel] [--runs 1]",
  "  companion-long-run-v3 run [--run-id <id>] [--profile deepseek|bigmodel] [--runs 1]",
  "  companion-long-run-v3 resume --run-id <id> [--profile deepseek|bigmodel] [--runs 1]",
].join("\n");

export function parseCompanionLongRunV3CliArgs(
  argv: readonly string[],
  now: Date = new Date(),
): CompanionLongRunV3CliOptions {
  const [rawCommand, ...rawRest] = argv;
  // pnpm may preserve the conventional argument separator when a script is
  // invoked as `pnpm <script> -- --run-id ...`.
  const rest = rawRest[0] === "--" ? rawRest.slice(1) : rawRest;
  if (
    rawCommand !== "fixture" &&
    rawCommand !== "run" &&
    rawCommand !== "resume"
  ) {
    throw new TypeError(USAGE);
  }

  let runId: string | undefined;
  let declaredProfile: string | undefined;
  let declaredRuns: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--run-id") {
      assertUnset(runId, "--run-id");
      runId = requiredValue(rest, ++index, "--run-id");
      continue;
    }
    if (argument?.startsWith("--run-id=")) {
      assertUnset(runId, "--run-id");
      runId = argument.slice("--run-id=".length);
      continue;
    }
    if (argument === "--profile") {
      assertUnset(declaredProfile, "--profile");
      declaredProfile = requiredValue(rest, ++index, "--profile");
      continue;
    }
    if (argument?.startsWith("--profile=")) {
      assertUnset(declaredProfile, "--profile");
      declaredProfile = argument.slice("--profile=".length);
      continue;
    }
    if (argument === "--runs") {
      assertUnset(declaredRuns, "--runs");
      declaredRuns = requiredValue(rest, ++index, "--runs");
      continue;
    }
    if (argument?.startsWith("--runs=")) {
      assertUnset(declaredRuns, "--runs");
      declaredRuns = argument.slice("--runs=".length);
      continue;
    }
    throw new TypeError(
      `Unknown argument: ${argument ?? "<missing>"}\n${USAGE}`,
    );
  }

  if (
    declaredProfile !== undefined &&
    declaredProfile !== "deepseek" &&
    declaredProfile !== "bigmodel"
  ) {
    throw new TypeError(
      "The v3 long-run real profile must be deepseek or bigmodel.",
    );
  }
  if (declaredRuns !== undefined && declaredRuns !== "1") {
    throw new TypeError(
      "The v3 long-run executes one continuous run; --runs must be 1.",
    );
  }
  if (rawCommand === "resume" && runId === undefined) {
    throw new TypeError(
      "resume requires --run-id so an existing run is selected.",
    );
  }

  const profile =
    rawCommand === "fixture" ? "fixture" : (declaredProfile ?? "deepseek");
  return {
    command: rawCommand,
    profile,
    runId: validateArtifactId(runId ?? suggestedRunId(profile, now)),
    resume: rawCommand === "resume",
  };
}

export async function companionLongRunV3Main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseCompanionLongRunV3CliArgs(argv);
  const artifactDirectory = resolve(
    workspaceRoot,
    "tmp",
    "companion-long-run-v3",
    options.runId,
  );

  if (options.profile !== "fixture") {
    await assertPaidLongRunV3ProfileReady(
      workspaceRoot,
      options.profile,
      process.env,
    );
  }

  console.log(`Long-run artifacts: ${artifactDirectory}`);
  const result = await runCompanionLongRunV3({
    workspaceRoot,
    profile: options.profile,
    runId: options.runId,
    resume: options.resume,
  });
  assertLongRunV3EngineeringGatePassed(result);
  console.log(`Long-run complete: ${artifactDirectory}`);
}

export function assertLongRunV3EngineeringGatePassed(result: {
  engineeringGatePassed: boolean;
  runDirectory: string;
}): void {
  if (!result.engineeringGatePassed) {
    throw new Error(
      `Long-run engineering gate failed; inspect artifacts before continuing: ${result.runDirectory}`,
    );
  }
}

export async function assertPaidLongRunV3ProfileReady(
  root: string,
  requestedProfile: CompanionLongRunV3RealProfile,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<void> {
  if (environment["RUN_PAID_LONGRUN"] !== "1") {
    throw new Error(
      `Paid ${requestedProfile} v3 long-run is disabled. Set RUN_PAID_LONGRUN=1 to authorize real provider calls.`,
    );
  }

  const profile = readLongRunV2ProfileConfig(requestedProfile, environment);
  if (!profile.apiKeyPresent) {
    throw new Error(
      `${requestedProfile} API key is missing (${profile.apiKeyEnvironment}).`,
    );
  }

  const git = await readGitFingerprint(root);
  if (git.dirty && environment["RUN_PAID_LONGRUN_ALLOW_DIRTY"] !== "1") {
    throw new Error(
      "Real v3 long-run requires a clean Git worktree. For an explicitly exploratory local validation of the current patch, set RUN_PAID_LONGRUN_ALLOW_DIRTY=1; the dirty patch hash will be frozen in the run manifest.",
    );
  }
}

export function suggestedRunId(
  profile: "fixture" | CompanionLongRunV3RealProfile,
  now: Date = new Date(),
): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace("T", "-")
    .replace(".", "-")
    .replace("Z", "Z");
  return `${profile}-${timestamp}`;
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

function assertUnset(value: string | undefined, argument: string): void {
  if (value !== undefined) {
    throw new TypeError(`${argument} may be specified only once.`);
  }
}

function validateArtifactId(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u.test(value)) {
    throw new TypeError(
      "Run ID must start with a letter or number and contain only letters, numbers, dots, underscores, or hyphens (maximum 120 characters).",
    );
  }
  return value;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  companionLongRunV3Main().catch((error: unknown) => {
    const failureId = randomUUID();
    console.error(
      `companion-long-run-v3 failed (${failureId}):`,
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}
