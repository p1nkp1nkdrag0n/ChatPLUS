import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ServerConfig } from "../config.js";
import { buildGuLanV3CharacterInput } from "./companion-long-run-v3-baseline.js";
import { createLongRunV3CharacterBaseline } from "./companion-long-run-v3-character-bootstrap.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("companion long-run v3 character bootstrap", () => {
  it("uses the public generate, publish and session flow before freezing a fixture baseline", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "personasim-v3-character-build-"),
    );
    cleanup.push(directory);
    const databasePath = join(directory, "baseline.sqlite");
    const result = await createLongRunV3CharacterBaseline({
      databasePath,
      config: fixtureConfig(databasePath),
      startAtUtc: "2026-09-01T01:00:00.000Z",
      characterInput: buildGuLanV3CharacterInput(),
    });

    expect(result.success).toBe(true);
    expect(result.http.map((request) => request.step)).toEqual([
      "generate",
      "publish",
      "create_session",
    ]);
    expect(result.http.map((request) => request.status)).toEqual([
      201, 200, 201,
    ]);
    expect(result.observations.logicalCalls).toHaveLength(1);
    expect(result.observations.logicalCalls[0]?.purpose).toBe(
      "compile_character",
    );
    expect(result.published?.status).toBe("published");
    expect(result.baseline?.constructionMode).toBe(
      "product_character_generation",
    );
    expect(result.baseline?.characterId).toBe(result.published?.id);
    expect(result.baseline?.sessionId).toBe(result.sessionId);
    expect(result.baseline?.scheduleItemCount).toBe(0);
    expect(result.baseline?.dailyContextCount).toBe(1);
    expect(result.validations.every((validation) => validation.passed)).toBe(
      true,
    );
    expect(result.sources?.[0]?.["contentExcerpt"]).toBe(
      buildGuLanV3CharacterInput().characterBrief,
    );
  });
});

function fixtureConfig(databasePath: string): ServerConfig {
  return {
    nodeEnv: "test",
    profile: "test",
    port: 3001,
    host: "127.0.0.1",
    webOrigin: "http://localhost:5173",
    databasePath,
    clockMode: "fake",
    fakeClockStart: "2026-09-01T01:00:00.000Z",
    llm: {
      provider: "fixture",
      baseUrl: "http://fixture.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 5_000,
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
    developerRoutes: true,
    chatEffectsMode: "gated",
    lifePlanningMode: "fuzzy",
    scheduleNegotiationMode: "legacy",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "off",
  };
}
