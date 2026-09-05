import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ServerConfig } from "../config.js";
import {
  LONG_RUN_V2_AGENT_ID,
  LONG_RUN_V2_SESSION_ID,
  LONG_RUN_V2_START_UTC,
  createCompanionLongRunV2Baseline,
} from "./companion-long-run-v2-baseline.js";
import { LongRunV2Runtime } from "./companion-long-run-v2-runtime.js";

const cleanup: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("LongRunV2Runtime", () => {
  it("keeps real local HTTP independent of Fetch port restrictions and Provider tracing", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "chatplus-runtime-v2-port-"),
    );
    cleanup.push(directory);
    const databasePath = join(directory, "run.sqlite");
    await createCompanionLongRunV2Baseline(databasePath);
    // Reproduce Fetch's pre-network failure deterministically without taking
    // a fixed port that may already belong to another process on the host.
    const restrictedFetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(
        new TypeError("fetch failed", { cause: new Error("bad port") }),
      );
    const runtime = new LongRunV2Runtime({
      databasePath,
      config: fixtureConfig(databasePath),
      startAtUtc: LONG_RUN_V2_START_UTC,
      initialSessionId: LONG_RUN_V2_SESSION_ID,
    });
    try {
      await runtime.open();
      const result = await runtime.sendMessage({
        agentId: LONG_RUN_V2_AGENT_ID,
        sessionKey: "S1",
        text: "这是一条经过真实本地 HTTP 的中文消息。",
        clientMessageId: "fetch-restricted-port",
      });
      expect(result.http.status).toBe(201);
      expect(result.parsed?.userMessage.content).toBe(
        "这是一条经过真实本地 HTTP 的中文消息。",
      );
      expect(result.parsed?.assistantMessage.content).toBeTruthy();
      expect(
        result.observations.logicalCalls.map((call) => call.purpose),
      ).toContain("chat_turn");
      expect(result.observations.providerAttempts).toEqual([]);
      expect(runtime.nativeFetch).toBe(restrictedFetch);
      expect(restrictedFetch).not.toHaveBeenCalled();
      await runtime.restart();
      const restarted = await runtime.sendMessage({
        agentId: LONG_RUN_V2_AGENT_ID,
        sessionKey: "S1",
        text: "重启后仍然通过真实 HTTP 发送。",
        clientMessageId: "fetch-restricted-port-restarted",
      });
      expect(restarted.http.status).toBe(201);
      expect(restrictedFetch).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("uses real HTTP, captures the logical prompt and survives restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatplus-runtime-v2-"));
    cleanup.push(directory);
    const databasePath = join(directory, "run.sqlite");
    await createCompanionLongRunV2Baseline(databasePath);
    const runtime = new LongRunV2Runtime({
      databasePath,
      config: fixtureConfig(databasePath),
      startAtUtc: LONG_RUN_V2_START_UTC,
      initialSessionId: LONG_RUN_V2_SESSION_ID,
    });

    try {
      await runtime.open();
      const before = runtime.snapshot(LONG_RUN_V2_AGENT_ID);
      const clientMessageId = runtime.nextClientMessageId("fixture-turn-001");
      const result = await runtime.sendMessage({
        agentId: LONG_RUN_V2_AGENT_ID,
        sessionKey: "S1",
        text: "早上好，今天上海有点阴。",
        clientMessageId,
      });
      expect(result.http.status).toBe(201);
      expect(result.parsed?.assistantMessage.content).toBeTruthy();
      expect(
        result.observations.logicalCalls.map((call) => call.purpose),
      ).toContain("chat_turn");
      expect(result.observations.logicalCalls[0]?.system).not.toBe("");
      expect(result.observations.providerAttempts).toEqual([]);

      const after = runtime.snapshot(LONG_RUN_V2_AGENT_ID);
      expect(after.messages.length).toBe(before.messages.length + 2);
      const stateBeforeRestart = after.runtimeState;
      await runtime.restart();
      expect(runtime.snapshot(LONG_RUN_V2_AGENT_ID).runtimeState).toEqual(
        stateBeforeRestart,
      );
    } finally {
      await runtime.close();
    }
  });
});

function fixtureConfig(databasePath: string): ServerConfig {
  return {
    nodeEnv: "test",
    profile: "test",
    port: 0,
    host: "127.0.0.1",
    webOrigin: "http://127.0.0.1",
    databasePath,
    clockMode: "fake",
    fakeClockStart: LONG_RUN_V2_START_UTC,
    llm: {
      provider: "fixture",
      profileName: "fixture",
      baseUrl: "https://fixture.invalid",
      model: "fixture-model",
      timeoutMs: 1_000,
      maxRetries: 0,
      maxOutputTokens: 8_192,
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
    developerRoutes: true,
    chatEffectsMode: "gated",
    lifePlanningMode: "legacy_exact",
    scheduleNegotiationMode: "enforced",
    selfInitiatedPlanningMode: "enforced",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "off",
  };
}
