import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { DEFAULT_CONVERSATION_RETENTION_POLICY } from "@personasim/contracts";
import { readConfig, type ServerConfig } from "../config.js";
import { CONTINUITY_WORKSPACE_ROOT } from "./continuity-run-identity.js";
import { resolveSteeringProfile } from "./reply-steering-runner.js";

/** Apply the same fresh, ignored workspace boundary as the other eval CLIs. */
export function admitArchitectureOutput(output: string): string {
  const directory = resolve(output);
  const inside = relative(CONTINUITY_WORKSPACE_ROOT, directory);
  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new Error("Use a fresh ignored directory inside the workspace");
  if (existsSync(directory))
    throw new Error("Never overwrite an existing architecture run directory");
  try {
    execFileSync(
      "git",
      ["check-ignore", "--quiet", "--", join(directory, "manifest.json")],
      { cwd: CONTINUITY_WORKSPACE_ROOT, windowsHide: true, stdio: "pipe" },
    );
  } catch {
    throw new Error("Architecture run output must be ignored by Git");
  }
  return directory;
}

/** Offline runs must not resolve or inherit private deployment credentials. */
export function architectureRunConfig(
  directory: string,
  offline: boolean,
): {
  base: ServerConfig;
  profile: ServerConfig["llm"];
} {
  if (!offline)
    return { base: readConfig(), profile: resolveSteeringProfile("bigmodel") };
  const profile: ServerConfig["llm"] = {
    provider: "openai-compatible",
    profileName: "offline-architecture",
    model: "offline-architecture",
    baseUrl: "https://example.invalid",
    apiKey: "offline-fixture-key",
    timeoutMs: 1000,
    maxRetries: 0,
    maxOutputTokens: 32_768,
    capabilities: {
      structuredOutputMode: "json_object",
      supportsThinkingControl: false,
      supportsStreaming: false,
      maxContextTokens: 128_000,
      maxOutputTokens: 32_768,
    },
  };
  const base: ServerConfig = {
    nodeEnv: "test",
    profile: "offline-architecture",
    port: 0,
    host: "127.0.0.1",
    webOrigin: "http://127.0.0.1:5173",
    databasePath: join(directory, "turn.sqlite"),
    clockMode: "fake",
    fakeClockStart: "2026-10-05T09:00:00.000Z",
    llm: profile,
    conversationRetention: { ...DEFAULT_CONVERSATION_RETENTION_POLICY },
    logLevel: "silent",
    seedDemo: false,
    developerRoutes: true,
    chatEffectsMode: "gated",
    lifePlanningMode: "fuzzy",
    scheduleNegotiationMode: "off",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "enforced",
    companionContextMode: "enforced",
    personaRuntimeMode: "enforced",
    correspondenceMode: "off",
    keepsakeMode: "off",
    assetStoragePath: join(directory, "assets"),
  };
  return { base, profile };
}
