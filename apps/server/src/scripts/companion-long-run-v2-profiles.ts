import { createHash } from "node:crypto";

import type { LlmCapabilityProfile } from "@personasim/contracts";

import { readConfig, type ServerConfig } from "../config.js";
import {
  LONG_RUN_V2_PROFILE_ORDER,
  isLongRunV2Profile,
  type LongRunV2Profile,
} from "./companion-long-run-v2-run-types.js";

export const PAID_LONG_RUN_ENVIRONMENT = "RUN_PAID_LONGRUN";
export const DEFAULT_LONG_RUN_V2_RUNS = 3;

export type LongRunV2RunCount = 1 | 2 | 3;

export interface LongRunV2ProfileSelection {
  profiles: LongRunV2Profile[];
  runs: LongRunV2RunCount;
}

export interface LongRunV2ProfileRotation {
  repetition: LongRunV2RunCount;
  profiles: LongRunV2Profile[];
}

export interface LongRunV2ProfileConfigSnapshot {
  profile: LongRunV2Profile;
  profileSource: "legacy" | "named";
  configuredProfileName: string | null;
  provider: "openai-compatible";
  requestedModel: string;
  baseOrigin: string;
  baseUrl: string;
  reasoningEffort?: string;
  reasoningRequestFormat?: string;
  capabilities: LlmCapabilityProfile;
  timeoutMs: number;
  maxRetries: number;
  apiKeyEnvironment: string;
  apiKeyPresent: boolean;
  configSha256: string;
}

export type PaidLongRunGuard =
  { status: "READY" } | { status: "SKIPPED"; reason: string };

export type PaidLongRunProfilePreparation =
  | {
      status: "SKIPPED";
      reason: string;
      selection: LongRunV2ProfileSelection;
    }
  | {
      status: "READY";
      selection: LongRunV2ProfileSelection;
      rotations: LongRunV2ProfileRotation[];
      profileConfigs: LongRunV2ProfileConfigSnapshot[];
    };

type ConfigReader = () => ServerConfig;

const PROFILE_API_KEY_ENVIRONMENTS: Record<LongRunV2Profile, string> = {
  deepseek: "OPENAI_COMPATIBLE_API_KEY",
  claude: "LLM_PROFILE_CLAUDE_API_KEY",
  grok: "LLM_PROFILE_GROK_API_KEY",
  gemini: "LLM_PROFILE_GEMINI_API_KEY",
  "gpt56-sol": "LLM_PROFILE_GPT56_SOL_API_KEY",
  bigmodel: "LLM_PROFILE_BIGMODEL_API_KEY",
};

const LEGACY_LLM_ALIAS_ENVIRONMENTS = [
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "LLM_TIMEOUT_MS",
  "LLM_MAX_RETRIES",
  "LLM_REASONING_EFFORT",
  "LLM_REASONING_FORMAT",
] as const;

export function apiKeyEnvironmentForProfile(profile: LongRunV2Profile): string {
  return PROFILE_API_KEY_ENVIRONMENTS[profile];
}

export function parseLongRunV2ProfileArgs(
  argv: readonly string[],
): LongRunV2ProfileSelection {
  let rawProfiles: string | undefined;
  let rawRuns: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (argument === "--profiles") {
      if (rawProfiles !== undefined) duplicateArgument("--profiles");
      rawProfiles = requiredArgumentValue(argv, ++index, "--profiles");
      continue;
    }
    if (argument.startsWith("--profiles=")) {
      if (rawProfiles !== undefined) duplicateArgument("--profiles");
      rawProfiles = argument.slice("--profiles=".length);
      continue;
    }
    if (argument === "--runs") {
      if (rawRuns !== undefined) duplicateArgument("--runs");
      rawRuns = requiredArgumentValue(argv, ++index, "--runs");
      continue;
    }
    if (argument.startsWith("--runs=")) {
      if (rawRuns !== undefined) duplicateArgument("--runs");
      rawRuns = argument.slice("--runs=".length);
      continue;
    }
    throw new TypeError(`Unknown companion long-run argument: ${argument}`);
  }

  return {
    profiles: parseProfiles(rawProfiles ?? "all"),
    runs: parseRunCount(rawRuns ?? String(DEFAULT_LONG_RUN_V2_RUNS)),
  };
}

export function rotateLongRunV2Profiles(
  profiles: readonly LongRunV2Profile[],
  runs: LongRunV2RunCount,
): LongRunV2ProfileRotation[] {
  const ordered = canonicalProfileOrder(profiles);
  if (ordered.length === 0) {
    throw new TypeError("At least one long-run profile is required.");
  }
  assertRunCount(runs);

  return Array.from({ length: runs }, (_, runIndex) => {
    // floor(i*n/r) spreads the starting positions across the whole list. For
    // six profiles and three repetitions the starts are 0, 2, and 4, so every
    // profile receives one early, one middle, and one late slot.
    const offset = Math.floor((runIndex * ordered.length) / runs);
    return {
      repetition: (runIndex + 1) as LongRunV2RunCount,
      profiles: [...ordered.slice(offset), ...ordered.slice(0, offset)],
    };
  });
}

export function evaluatePaidLongRunGuard(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): PaidLongRunGuard {
  if (environment[PAID_LONG_RUN_ENVIRONMENT] === "1") {
    return { status: "READY" };
  }
  return {
    status: "SKIPPED",
    reason:
      "Paid companion long-run is disabled. Set RUN_PAID_LONGRUN=1; no profile configuration was read and no application was built.",
  };
}

/**
 * Builds the environment passed to a child process. Credentials remain only in
 * the environment inherited by the child; callers must never serialize this
 * object into reports or append any API key to child command arguments.
 */
export function buildLongRunV2ChildEnvironment(
  profile: LongRunV2Profile,
  parentEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(parentEnvironment)) {
    if (value !== undefined) child[key] = value;
  }
  setEnvironmentValue(child, "LLM_PROVIDER", "openai-compatible");
  setEnvironmentValue(
    child,
    "LLM_ACTIVE_PROFILE",
    profile === "deepseek" ? undefined : profile,
  );
  if (profile === "deepseek") {
    for (const alias of LEGACY_LLM_ALIAS_ENVIRONMENTS) {
      setEnvironmentValue(child, alias, undefined);
    }
  }
  return child;
}

export function readLongRunV2ProfileConfig(
  profile: LongRunV2Profile,
  parentEnvironment: Readonly<NodeJS.ProcessEnv> = process.env,
  configReader: ConfigReader = readConfig,
): LongRunV2ProfileConfigSnapshot {
  const childEnvironment = buildLongRunV2ChildEnvironment(
    profile,
    parentEnvironment,
  );
  const config = withLlmEnvironment(childEnvironment, configReader);
  return snapshotProfileConfig(profile, config);
}

export function preparePaidLongRunProfiles(
  argv: readonly string[],
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  configReader: ConfigReader = readConfig,
): PaidLongRunProfilePreparation {
  const selection = parseLongRunV2ProfileArgs(argv);
  const guard = evaluatePaidLongRunGuard(environment);
  if (guard.status === "SKIPPED") {
    return { ...guard, selection };
  }

  // Deliberately synchronous and ordered: configuration resolution must not
  // race through the process environment, and the eventual runner consumes
  // this same run-major sequence without parallel paid calls.
  const profileConfigs = selection.profiles.map((profile) =>
    readLongRunV2ProfileConfig(profile, environment, configReader),
  );
  return {
    status: "READY",
    selection,
    rotations: rotateLongRunV2Profiles(selection.profiles, selection.runs),
    profileConfigs,
  };
}

function snapshotProfileConfig(
  profile: LongRunV2Profile,
  config: ServerConfig,
): LongRunV2ProfileConfigSnapshot {
  if (config.llm.provider !== "openai-compatible") {
    throw new TypeError(
      `Profile ${profile} resolved provider ${config.llm.provider}; expected openai-compatible.`,
    );
  }
  const capabilities = config.llm.capabilities;
  if (capabilities === undefined) {
    throw new TypeError(`Profile ${profile} has no LLM capability profile.`);
  }
  const configuredProfileName = config.llm.profileName ?? null;
  if (profile === "deepseek") {
    if (configuredProfileName !== null) {
      throw new TypeError(
        "DeepSeek must resolve through legacy configuration.",
      );
    }
  } else if (configuredProfileName !== profile) {
    throw new TypeError(
      `Profile ${profile} resolved unexpected LLM_ACTIVE_PROFILE ${configuredProfileName ?? "<none>"}.`,
    );
  }

  const hashable = {
    profile,
    profileSource:
      profile === "deepseek" ? ("legacy" as const) : ("named" as const),
    configuredProfileName,
    provider: config.llm.provider,
    requestedModel: config.llm.model,
    baseOrigin: new URL(config.llm.baseUrl).origin,
    baseUrl: config.llm.baseUrl,
    ...(capabilities.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: capabilities.reasoningEffort }),
    ...(capabilities.reasoningRequestFormat === undefined
      ? {}
      : { reasoningRequestFormat: capabilities.reasoningRequestFormat }),
    capabilities: { ...capabilities },
    timeoutMs: config.llm.timeoutMs,
    maxRetries: config.llm.maxRetries,
    apiKeyEnvironment: apiKeyEnvironmentForProfile(profile),
    apiKeyPresent: config.llm.apiKey !== undefined,
  };
  return {
    ...hashable,
    configSha256: sha256Canonical(hashable),
  };
}

function parseProfiles(value: string): LongRunV2Profile[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return [...LONG_RUN_V2_PROFILE_ORDER];
  const values = normalized.split(",").map((item) => item.trim());
  if (values.length === 0 || values.some((item) => item === "")) {
    throw new TypeError("--profiles requires all or a non-empty CSV list.");
  }
  if (values.includes("all")) {
    throw new TypeError("--profiles all cannot be combined with other names.");
  }
  for (const profile of values) {
    if (!isLongRunV2Profile(profile)) {
      throw new TypeError(
        `Unknown long-run profile ${profile}. Expected: ${LONG_RUN_V2_PROFILE_ORDER.join(", ")}, or all.`,
      );
    }
  }
  return canonicalProfileOrder(values);
}

function canonicalProfileOrder(
  profiles: readonly string[],
): LongRunV2Profile[] {
  const selected = new Set(profiles);
  for (const profile of selected) {
    if (!isLongRunV2Profile(profile)) {
      throw new TypeError(`Unknown long-run profile: ${profile}`);
    }
  }
  return LONG_RUN_V2_PROFILE_ORDER.filter((profile) => selected.has(profile));
}

function parseRunCount(value: string): LongRunV2RunCount {
  if (!/^[1-3]$/u.test(value.trim())) {
    throw new TypeError("--runs must be an integer from 1 through 3.");
  }
  return Number(value) as LongRunV2RunCount;
}

function assertRunCount(value: number): asserts value is LongRunV2RunCount {
  if (!Number.isInteger(value) || value < 1 || value > 3) {
    throw new TypeError("runs must be an integer from 1 through 3.");
  }
}

function requiredArgumentValue(
  argv: readonly string[],
  index: number,
  argument: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${argument} requires a value.`);
  }
  return value;
}

function duplicateArgument(argument: string): never {
  throw new TypeError(`${argument} may be supplied only once.`);
}

function setEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  canonicalKey: string,
  value: string | undefined,
): void {
  for (const key of Object.keys(environment)) {
    if (key.toUpperCase() === canonicalKey) delete environment[key];
  }
  if (value !== undefined) environment[canonicalKey] = value;
}

function withLlmEnvironment<T>(
  environment: Readonly<NodeJS.ProcessEnv>,
  operation: () => T,
): T {
  const previous = relevantEnvironmentEntries(process.env);
  clearRelevantEnvironment(process.env);
  for (const [key, value] of relevantEnvironmentEntries(environment)) {
    process.env[key] = value;
  }
  try {
    return operation();
  } finally {
    clearRelevantEnvironment(process.env);
    for (const [key, value] of previous) process.env[key] = value;
  }
}

function relevantEnvironmentEntries(
  environment: Readonly<NodeJS.ProcessEnv>,
): Array<[string, string]> {
  return Object.entries(environment).flatMap(([key, value]) =>
    value !== undefined && isLlmEnvironmentKey(key) ? [[key, value]] : [],
  );
}

function clearRelevantEnvironment(environment: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(environment)) {
    if (isLlmEnvironmentKey(key)) delete environment[key];
  }
}

function isLlmEnvironmentKey(key: string): boolean {
  const normalized = key.toUpperCase();
  return (
    normalized.startsWith("LLM_") || normalized.startsWith("OPENAI_COMPATIBLE_")
  );
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJsonValue(nested)]),
  );
}
