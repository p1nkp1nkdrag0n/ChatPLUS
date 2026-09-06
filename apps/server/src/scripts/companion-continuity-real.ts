import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { readConfig, readLlmProfileConfig } from "../config.js";
import { runCompanionContinuity } from "./companion-continuity-runner.js";
import { CONTINUITY_WORKSPACE_ROOT } from "./continuity-run-identity.js";

const inputDirectory = join(
  CONTINUITY_WORKSPACE_ROOT,
  "docs/plans/ChatPLUS_Continuity_Review_and_Real_API_Test_Plan/ChatPLUS_Continuity_Review",
);

export async function companionContinuityMain(
  args = process.argv.slice(2),
): Promise<void> {
  const [command, runId, ...flags] = args;
  if (
    !["fixture", "run", "resume"].includes(command ?? "") ||
    !runId ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(runId)
  )
    throw new Error(
      "Usage: companion-continuity-real.ts fixture|run|resume RUN_ID [--profile NAME] [--turns 16|120] [--group A0|A1|A2] [--requests 50] [--token-units 2000000] [--baseline DIRECTORY] [--public FILE] [--oracle FILE]",
    );
  const parsed: Record<string, string> = {};
  let worker = false;
  for (let i = 0; i < flags.length; i += 1) {
    const flag = flags[i]!;
    if (flag === "--worker") {
      worker = true;
      continue;
    }
    if (
      ![
        "--profile",
        "--turns",
        "--group",
        "--requests",
        "--token-units",
        "--baseline",
        "--public",
        "--oracle",
      ].includes(flag) ||
      flags[i + 1] === undefined ||
      Object.hasOwn(parsed, flag)
    )
      throw new Error(`Invalid continuity option: ${flag}`);
    parsed[flag] = flags[++i]!;
  }
  const profile =
    parsed["--profile"] ?? (command === "fixture" ? "fixture" : "bigmodel");
  if (command === "fixture" && profile !== "fixture")
    throw new Error("fixture_command_requires_fixture_provider");
  // Checked in the supervisor AND every restarted worker, before profile lookup.
  if (profile !== "fixture" && process.env.RUN_PAID_CONTINUITY !== "1")
    throw new Error(
      "Real API execution requires explicit user authorization and RUN_PAID_CONTINUITY=1",
    );
  const maxTurns = z.coerce
    .number()
    .int()
    .min(1)
    .max(120)
    .parse(parsed["--turns"] ?? 16);
  const budget = {
    maxPhysicalRequests: z.coerce
      .number()
      .int()
      .positive()
      .max(2000)
      .parse(parsed["--requests"] ?? 50),
    maxReservedTokenUnits: z.coerce
      .number()
      .int()
      .positive()
      .max(100000000)
      .parse(parsed["--token-units"] ?? 2000000),
  };
  const group = z.enum(["A0", "A1", "A2"]).parse(parsed["--group"] ?? "A2");
  if (!worker) {
    let nextCommand = command!;
    for (let processIndex = 0; processIndex < 2; processIndex += 1) {
      const code = await new Promise<number>((resolveExit, reject) => {
        const child = spawn(
          process.execPath,
          [
            ...process.execArgv,
            fileURLToPath(import.meta.url),
            nextCommand,
            runId,
            ...flags,
            ...(parsed["--profile"] ? [] : ["--profile", profile]),
            "--worker",
          ],
          {
            cwd: CONTINUITY_WORKSPACE_ROOT,
            stdio: "inherit",
            windowsHide: true,
            env: process.env,
          },
        );
        child.once("error", reject);
        child.once("exit", (status) => resolveExit(status ?? 1));
      });
      if (code !== 75) {
        process.exitCode = code;
        return;
      }
      nextCommand = "resume";
    }
    throw new Error("continuity_unexpected_repeated_restart_boundary");
  }
  const base = readConfig();
  const llm =
    profile === "fixture"
      ? {
          provider: "fixture" as const,
          model: "personasim-fixture-v1",
          baseUrl: "https://fixture.invalid",
          timeoutMs: 5000,
          maxRetries: 0,
        }
      : readLlmProfileConfig(profile);
  if (profile !== "fixture" && !llm.apiKey)
    throw new Error(`Missing credential for profile ${profile}`);
  const directory = join(
    CONTINUITY_WORKSPACE_ROOT,
    "tmp/companion-continuity-real",
    runId,
  );
  console.log(`Artifacts: ${directory}`);
  const result = await runCompanionContinuity({
    runId,
    runDirectory: directory,
    config: { ...base, llm },
    group,
    maxTurns,
    budget,
    publicPath: resolve(
      parsed["--public"] ?? join(inputDirectory, "03_scenario.public.json"),
    ),
    oraclePath: resolve(
      parsed["--oracle"] ?? join(inputDirectory, "04_oracle.private.json"),
    ),
    ...(parsed["--baseline"]
      ? { baselineDirectory: resolve(parsed["--baseline"]) }
      : {}),
    resume: command === "resume",
    onProgress: console.log,
  });
  console.log(
    `${result.status}: ${result.completedTurns}/${maxTurns}; semantic acceptance remains PARTIAL.${result.error ? ` ${result.error}` : ""}`,
  );
  process.exitCode =
    result.status === "restart_required"
      ? 75
      : result.status === "completed"
        ? 0
        : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await companionContinuityMain();
