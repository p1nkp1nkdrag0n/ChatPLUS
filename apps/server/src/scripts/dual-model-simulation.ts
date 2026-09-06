import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FixtureLlmProvider,
  createOpenAiCompatibleLlmProvider,
  type GenerateObjectInput,
  type LlmCallMetric,
} from "@personasim/providers";

import {
  readConfig,
  readLlmProfileConfig,
  type ServerConfig,
} from "../config.js";
import { runDualModelSimulation } from "./dual-model-simulation-runner.js";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
export const PAID_DUAL_MODEL_ENVIRONMENT = "RUN_PAID_DUAL_MODEL";
export const DEFAULT_USER_PERSONA =
  "你叫陈默，28岁，是一名普通上班族。你和对方是熟悉的朋友。你重视稳定，也想保留创作时间；最近加班让你疲惫。你会主动分享、追问，也会关心朋友自己的近况。说话自然具体，不扮演客服或评委。";
export const DEFAULT_SCENARIO =
  "从最近工作忙、下班后没精力创作聊起，先寻求倾听，再根据朋友的实际回复自然接话。适时关心对方的生活；后面可以回顾本次对话已提到的事实。不要预先编造双方过去发生的共同经历，不要求固定结局。";

export interface DualModelCliOptions {
  command: "fixture" | "run";
  userProfile: string;
  characterProfile: string;
  turns: number;
  stepMinutes: number;
  runId: string;
  userPersonaFile?: string;
  scenarioFile?: string;
}

const USAGE =
  "Usage: dual-model-simulation fixture|run [--user-profile qwen] [--character-profile bigmodel] [--turns 6] [--step-minutes 30] [--run-id ID] [--user-persona-file PATH] [--scenario-file PATH]";

export function parseDualModelCliArgs(
  argv: readonly string[],
): DualModelCliOptions {
  const [command, ...rawRest] = argv;
  if (command !== "fixture" && command !== "run") throw new TypeError(USAGE);
  const rest = rawRest[0] === "--" ? rawRest.slice(1) : rawRest;
  const allowed = new Set([
    "user-profile",
    "character-profile",
    "turns",
    "step-minutes",
    "run-id",
    "user-persona-file",
    "scenario-file",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const match = /^--([a-z-]+)(?:=(.*))?$/u.exec(rest[index] ?? "");
    const name = match?.[1];
    if (!name || !allowed.has(name)) throw new TypeError(USAGE);
    if (values.has(name))
      throw new TypeError(`--${name} may be specified only once.`);
    const value = match[2] ?? rest[++index];
    if (!value?.trim() || value.startsWith("--"))
      throw new TypeError(`--${name} requires a value.`);
    values.set(name, value);
  }
  const runId =
    values.get("run-id") ??
    `${command}-${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/u.test(runId)) {
    throw new TypeError(
      "Run ID must use 1–120 letters, numbers, dots, underscores or hyphens, starting with a letter or number.",
    );
  }
  const userPersonaFile = values.get("user-persona-file");
  const scenarioFile = values.get("scenario-file");
  return {
    command,
    userProfile: normalizedProfile(values.get("user-profile") ?? "qwen"),
    characterProfile: normalizedProfile(
      values.get("character-profile") ?? "bigmodel",
    ),
    turns: boundedInteger(values.get("turns") ?? "6", "--turns", 1, 20),
    stepMinutes: boundedInteger(
      values.get("step-minutes") ?? "30",
      "--step-minutes",
      1,
      1_440,
    ),
    runId,
    ...(userPersonaFile === undefined ? {} : { userPersonaFile }),
    ...(scenarioFile === undefined ? {} : { scenarioFile }),
  };
}

export function assertPaidDualModelEnabled(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): void {
  if (environment[PAID_DUAL_MODEL_ENVIRONMENT] !== "1") {
    throw new Error(
      "Real dual-model simulation is disabled. Set RUN_PAID_DUAL_MODEL=1 to run the selected models.",
    );
  }
}

function requireCredential(config: ServerConfig["llm"]): string {
  if (!config.apiKey) {
    const prefix = (config.profileName ?? "")
      .replaceAll("-", "_")
      .toUpperCase();
    throw new Error(`LLM_PROFILE_${prefix}_API_KEY is not configured.`);
  }
  return config.apiKey;
}

/** An offline plumbing demo; these lines are intentionally not model output. */
export class FixtureSimulationUser extends FixtureLlmProvider {
  private turn = 0;

  constructor() {
    super({ model: "synthetic-user-fixture" });
  }

  override generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
    const lines = [
      "最近连续加班，回家后连画画的力气都没有了。今天先让我说说就好。",
      "嗯，我主要是担心生活一直这样。你最近怎么样？",
      "我想先试着每周留一个晚上画画，你觉得怎么开始比较容易？",
      "刚才提到的那个小目标我记下了。我也想听听你最近在忙什么。",
      "我今晚准备先留半小时给自己。想到不用一次解决所有问题，轻松了一点。",
      "谢谢你听我说。下次我们再聊聊各自的进展吧。",
    ];
    const text = lines[this.turn % lines.length];
    this.turn += 1;
    return Promise.resolve(input.schema.parse({ text }));
  }
}

export async function dualModelSimulationMain(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseDualModelCliArgs(argv);
  // Do not resolve live credentials or construct providers before this gate.
  if (options.command === "run") assertPaidDualModelEnabled();
  const userPersona = await readOptionalText(
    options.userPersonaFile,
    DEFAULT_USER_PERSONA,
  );
  const scenario = await readOptionalText(
    options.scenarioFile,
    DEFAULT_SCENARIO,
  );
  const runDirectory = resolve(
    workspaceRoot,
    "tmp",
    "dual-model-simulation",
    options.runId,
  );
  const userCallMetrics: LlmCallMetric[] = [];
  const explicitSecrets: string[] = [];
  let serverConfig: ServerConfig;
  let userProvider;
  if (options.command === "fixture") {
    const fixture = new FixtureSimulationUser();
    userProvider = fixture;
    const base = readConfig();
    serverConfig = {
      ...base,
      llm: {
        provider: "fixture",
        baseUrl: "https://fixture.invalid",
        model: "personasim-fixture-v1",
        timeoutMs: 5_000,
        maxRetries: 0,
      },
    };
  } else {
    const userConfig = readLlmProfileConfig(options.userProfile);
    const characterConfig = readLlmProfileConfig(options.characterProfile);
    const userKey = requireCredential(userConfig);
    explicitSecrets.push(userKey, requireCredential(characterConfig));
    userProvider = createOpenAiCompatibleLlmProvider({
      ...userConfig,
      apiKey: userKey,
      onMetric: (metric) => userCallMetrics.push(metric),
      promptDiagnostics: true,
    });
    serverConfig = { ...readConfig(), llm: characterConfig };
  }
  console.log(`Dual-model artifacts: ${runDirectory}`);
  const result = await runDualModelSimulation({
    serverConfig,
    userProvider,
    userProfileName:
      options.command === "fixture" ? "fixture" : options.userProfile,
    runDirectory,
    turns: options.turns,
    stepMinutes: options.stepMinutes,
    userPersona,
    scenario,
    userCallMetrics,
    explicitSecrets,
    onProgress: (progress) => {
      console.log(
        `Turn ${progress.turn}/${progress.requestedTurns}: ${progress.status}`,
      );
    },
  });
  console.log(
    `Simulation ${result.status}: ${result.completedTurns}/${result.requestedTurns} turns. Quality review is pending in review.md.`,
  );
  if (result.status === "failed") process.exitCode = 1;
}

function normalizedProfile(value: string): string {
  const result = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(result))
    throw new TypeError("Invalid named LLM profile.");
  return result;
}

function boundedInteger(
  value: string,
  name: string,
  minimum: number,
  maximum: number,
): number {
  const result = Number(value);
  if (
    !/^\d+$/u.test(value) ||
    !Number.isSafeInteger(result) ||
    result < minimum ||
    result > maximum
  ) {
    throw new TypeError(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return result;
}

async function readOptionalText(
  path: string | undefined,
  fallback: string,
): Promise<string> {
  const text =
    path === undefined
      ? fallback
      : (await readFile(resolve(workspaceRoot, path), "utf8")).trim();
  if (!text || text.length > 8_000)
    throw new TypeError(
      "Persona and scenario must each contain 1–8000 characters.",
    );
  return text;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  dualModelSimulationMain().catch(() => {
    // Unvalidated configuration errors may contain credential-bearing values.
    console.error(
      "Dual-model simulation could not start. Check the command arguments, RUN_PAID_DUAL_MODEL=1 for a real run, both named profile configurations/API keys, input files and a fresh run ID. " +
        USAGE,
    );
    process.exitCode = 1;
  });
}
