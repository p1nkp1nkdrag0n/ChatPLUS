import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  createFixtureLlmProvider,
  type GenerateObjectInput,
  type LlmCallMetric,
  type LlmProvider,
} from "@personasim/providers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import {
  runDualModelSimulation,
  type DualModelSimulationOptions,
} from "./dual-model-simulation-runner.js";

const START = "2026-09-05T02:00:00.000Z";
const USER_SECRET = "user-provider-test-secret-12345";
const CHARACTER_SECRET = "character-provider-test-secret-67890";
const directories: string[] = [];

interface CapturedUserCall {
  system: string;
  prompt: string;
}

function userProvider(
  calls: CapturedUserCall[],
  respond: (call: number) => string = (call) =>
    call === 1
      ? "今天我有一点压力，能陪我说会儿话吗？"
      : "谢谢你，我想先慢慢说说今天发生的事。",
  metrics?: LlmCallMetric[],
): LlmProvider {
  const fixture = createFixtureLlmProvider();
  return {
    name: "mock-user-provider",
    model: "mock-user-v1",
    capabilities: fixture.capabilities,
    generate: (input) => fixture.generate(input),
    completeStructured: (input) => fixture.completeStructured(input),
    complete: (input) => fixture.complete(input),
    generateObject<T>(input: GenerateObjectInput<T>): Promise<T> {
      calls.push({ system: input.system, prompt: input.prompt });
      metrics?.push({
        provider: "mock-user-provider",
        model: "mock-user-v1",
        purpose: input.purpose,
        attempt: 1,
        latencyMs: 3,
        success: true,
        usageSource: "provider",
        inputTokens: 19,
        outputTokens: 11,
      });
      return Promise.resolve(
        input.schema.parse({ text: respond(calls.length) }),
      );
    },
  };
}

function config(databasePath: string): ServerConfig {
  return {
    nodeEnv: "test",
    profile: "test",
    port: 0,
    host: "127.0.0.1",
    webOrigin: "http://localhost:5173",
    databasePath,
    clockMode: "fake",
    fakeClockStart: START,
    llm: {
      provider: "fixture",
      baseUrl: "http://127.0.0.1:9",
      model: "project-fixture",
      apiKey: CHARACTER_SECRET,
      timeoutMs: 500,
      maxRetries: 0,
    },
    conversationRetention: {
      fullVerbatimHours: 24,
      softTokenLimit: 8_000,
      hardTokenLimit: 12_000,
      minimumTailTokens: 3_000,
      minimumRecentTurns: 12,
    },
    logLevel: "silent",
    seedDemo: false,
    developerRoutes: false,
    chatEffectsMode: "gated",
    lifePlanningMode: "fuzzy",
    scheduleNegotiationMode: "off",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "enforced",
    correspondenceMode: "enforced",
    keepsakeMode: "enforced",
    correspondenceExecution: "resident",
    instanceSecret:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };
}

async function options(
  calls: CapturedUserCall[] = [],
): Promise<DualModelSimulationOptions> {
  const directory = await mkdtemp(
    join(tmpdir(), "personasim-dual-model-test-"),
  );
  directories.push(directory);
  return {
    serverConfig: config(join(directory, "original.sqlite")),
    userProvider: userProvider(calls),
    runDirectory: join(directory, "run"),
    turns: 2,
    userPersona: "你是赵禾，一名准备毕业的学生，最近想慢慢说说自己的压力。",
    scenario:
      "和认识了一段时间的朋友自然聊天，先表达近况，再根据对方实际回应继续。",
    explicitSecrets: [USER_SECRET, CHARACTER_SECRET],
  };
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function readTurns(
  directory: string,
): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(directory, "turns.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("dual-model simulation through real application routes", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("offline-test-network-blocked")),
    );
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const directory of directories.splice(0)) {
      const parent = resolve(tmpdir());
      const contained = relative(parent, resolve(directory));
      if (
        contained.startsWith("..") ||
        !contained.startsWith("personasim-dual-model-test-")
      ) {
        throw new Error("Unexpected test cleanup path");
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("feeds the actual previous reply to the user model and persists an isolated high-fidelity conversation", async () => {
    const calls: CapturedUserCall[] = [];
    const input = await options(calls);
    const originalConfig = structuredClone(input.serverConfig);
    const originalDb = openDatabase(input.serverConfig.databasePath);
    originalDb.exec(
      "CREATE TABLE untouched (value TEXT); INSERT INTO untouched VALUES ('original remains intact')",
    );
    originalDb.close();
    const originalBytes = await readFile(input.serverConfig.databasePath);
    const metrics: LlmCallMetric[] = [];
    input.userProvider = userProvider(calls, undefined, metrics);
    input.userCallMetrics = metrics;
    const progress = vi.fn();
    input.onProgress = progress;

    const result = await runDualModelSimulation(input);

    expect(result).toMatchObject({
      status: "completed",
      completedTurns: 2,
      requestedTurns: 2,
    });
    expect(input.serverConfig).toEqual(originalConfig);
    expect(await readFile(input.serverConfig.databasePath)).toEqual(
      originalBytes,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledTimes(2);
    const turns = await readTurns(input.runDirectory);
    expect(turns).toHaveLength(2);
    expect(turns[1]?.["atUtc"]).toBe("2026-09-05T02:30:00.000Z");
    const firstPrompt = JSON.parse(calls[0]!.prompt) as Record<string, unknown>;
    const secondPrompt = JSON.parse(calls[1]!.prompt) as Record<
      string,
      unknown
    >;
    expect(firstPrompt["publicHistory"]).toEqual([]);
    expect(secondPrompt["publicHistory"]).toEqual([
      { role: "user", content: turns[0]?.["userText"] },
      { role: "assistant", content: turns[0]?.["assistantText"] },
    ]);
    expect(secondPrompt).not.toHaveProperty("runtimeState");
    expect(secondPrompt).not.toHaveProperty("memories");
    expect(secondPrompt).not.toHaveProperty("qualityReview");
    expect(calls[1]!.prompt).not.toContain(result.characterId);
    expect(turns[0]).toHaveProperty("before.runtimeState");
    expect(turns[0]).toHaveProperty("after.memories");
    expect(turns[0]).toHaveProperty("after.lifeContexts.0");
    const character = await readJson(
      join(input.runDirectory, "character.json"),
    );
    expect(character["tier"]).toBe("high_fidelity");
    const manifest = await readJson(join(input.runDirectory, "manifest.json"));
    expect(manifest).toMatchObject({
      qualityReview: "pending_manual_review",
      features: {
        backgroundScheduler: false,
        correspondenceMode: "off",
        keepsakeMode: "off",
        memoryRecallMode: "enforced",
      },
      accounting: {
        user: {
          logicalCalls: 2,
          physicalAttempts: 2,
          inputTokens: 38,
          outputTokens: 22,
        },
        character: {
          physicalAttempts: 0,
          accountingSource: "fixture_no_network",
        },
      },
    });
    expect(
      await readFile(join(input.runDirectory, "review.md"), "utf8"),
    ).toContain("待人工审阅");
    const stored = openDatabase(result.databasePath);
    try {
      expect(
        stored.prepare("SELECT count(*) AS count FROM messages").get(),
      ).toMatchObject({ count: 4 });
      expect(stored.prepare("SELECT tier FROM characters").get()).toMatchObject(
        { tier: "high_fidelity" },
      );
      expect(
        stored
          .prepare("SELECT content FROM messages WHERE id = ?")
          .get(turns[0]?.["assistantMessageId"]),
      ).toEqual({ content: turns[0]?.["assistantText"] });
    } finally {
      stored.close();
    }
  });

  it("retains completed turns and a failed turn when the user provider fails, without exporting credentials", async () => {
    const input = await options();
    input.turns = 3;
    input.userProvider = userProvider([], (call) => {
      if (call === 2)
        throw new Error(`provider failed: ${USER_SECRET}; ${CHARACTER_SECRET}`);
      return "今天想轻松聊一会儿。";
    });
    const result = await runDualModelSimulation(input);
    expect(result).toMatchObject({ status: "failed", completedTurns: 1 });
    expect(result.error).toContain("[REDACTED]");
    const turns = await readTurns(input.runDirectory);
    expect(turns.map((turn) => turn["status"])).toEqual([
      "completed",
      "failed",
    ]);
    expect(turns[1]).not.toHaveProperty("assistantText");
    const exports = (await readdir(input.runDirectory)).filter((name) =>
      /\.(?:json|jsonl|md)$/u.test(name),
    );
    for (const name of exports) {
      const text = await readFile(join(input.runDirectory, name), "utf8");
      expect(text).not.toContain(USER_SECRET);
      expect(text).not.toContain(CHARACTER_SECRET);
    }
    expect(
      await readJson(join(input.runDirectory, "manifest.json")),
    ).toMatchObject({
      status: "failed",
      qualityReview: "pending_manual_review",
    });
    const stored = openDatabase(result.databasePath);
    try {
      expect(
        stored.prepare("SELECT count(*) AS count FROM messages").get(),
      ).toMatchObject({ count: 2 });
    } finally {
      stored.close();
    }
  });

  it("records the generated user message when the project model fails on its real route", async () => {
    const input = await options();
    input.turns = 1;
    input.serverConfig.llm = {
      ...input.serverConfig.llm,
      provider: "openai-compatible",
      capabilities: {
        structuredOutputMode: "json_object",
        supportsThinkingControl: false,
        supportsStreaming: false,
      },
    };
    const result = await runDualModelSimulation(input);
    expect(result).toMatchObject({ status: "failed", completedTurns: 0 });
    expect(globalThis.fetch).toHaveBeenCalled();
    const turns = await readTurns(input.runDirectory);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      status: "failed",
      userText: "今天我有一点压力，能陪我说会儿话吗？",
      mechanicalFlags: ["deterministic_fallback", "turn_execution_failed"],
    });
    expect(turns[0]?.["characterProviderAttempts"]).not.toEqual([]);
    expect(
      await readFile(join(input.runDirectory, "conversation.md"), "utf8"),
    ).toContain("执行失败；本轮不完整");
  });

  it("rejects invalid turn limits and existing output directories before generating or touching source data", async () => {
    const calls: CapturedUserCall[] = [];
    const input = await options(calls);
    for (const turns of [0, 21, 1.5, Number.NaN]) {
      await expect(runDualModelSimulation({ ...input, turns })).rejects.toThrow(
        "turns must",
      );
    }
    await expect(stat(input.runDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      runDualModelSimulation({ ...input, runDirectory: "relative-output" }),
    ).rejects.toThrow("absolute");
    await writeFile(input.runDirectory, "existing content");
    await expect(runDualModelSimulation(input)).rejects.toThrow();
    expect(await readFile(input.runDirectory, "utf8")).toBe("existing content");
    expect(calls).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
