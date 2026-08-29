import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertResumeCompatible,
  redactLongRunArtifact,
  writeJsonExclusive,
} from "./companion-long-run-v2-artifacts.js";
import type {
  LongRunCheckpoint,
  RunManifest,
} from "./companion-long-run-v2-run-types.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("companion long-run v2 artifacts", () => {
  it("redacts key-shaped fields, bearer values and explicit secrets", () => {
    const value = redactLongRunArtifact(
      {
        apiKey: "top-secret",
        apiKeyPresent: true,
        nested: { authorization: "Bearer abcdefghijklmnop" },
        prompt: "never echo top-secret or sk-abcdefghijklmnop",
      },
      ["top-secret"],
    );
    expect(JSON.stringify(value)).not.toContain("top-secret");
    expect(JSON.stringify(value)).not.toContain("abcdefghijklmnop");
    expect(value).toMatchObject({ apiKeyPresent: true });
  });

  it("preserves usage and token-budget counters", () => {
    expect(
      redactLongRunArtifact({
        inputTokens: 123,
        outputTokens: 45,
        maxContextTokens: 200_000,
        accessToken: "credential-value",
      }),
    ).toEqual({
      inputTokens: 123,
      outputTokens: 45,
      maxContextTokens: 200_000,
      accessToken: "[REDACTED]",
    });
  });

  it("never overwrites a final artifact", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatplus-artifacts-"));
    cleanup.push(directory);
    const path = join(directory, "final.json");
    await writeJsonExclusive(path, { status: "PASS" });
    await expect(
      writeJsonExclusive(path, { status: "FAIL" }),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(path, "utf8")).toContain("PASS");
  });

  it("rejects a checkpoint when any frozen compatibility field changes", () => {
    const manifest = fakeManifest();
    const checkpoint: LongRunCheckpoint = {
      schemaVersion: "companion-long-run-checkpoint-v2",
      runId: manifest.runId,
      completedCandidateTurns: 10,
      completedTurnIds: [],
      createdAtUtc: manifest.createdAtUtc,
      compatibility: {
        configSha256: manifest.configSha256,
        git: manifest.git,
        scenario: manifest.scenario,
        baseline: manifest.baseline,
        profileConfig: manifest.profileConfig,
      },
      databases: [],
      evidenceJsonlSha256: "0".repeat(64),
    };
    expect(() => assertResumeCompatible(manifest, checkpoint)).not.toThrow();
    checkpoint.compatibility.scenario = {
      ...checkpoint.compatibility.scenario,
      manifestSha256: "changed",
    };
    expect(() => assertResumeCompatible(manifest, checkpoint)).toThrow(
      "Checkpoint is incompatible",
    );
  });
});

function fakeManifest(): RunManifest {
  return {
    schemaVersion: "companion-long-run-run-manifest-v2",
    matrixId: "matrix-test",
    runId: "run-test",
    mode: "fixture",
    profile: "fixture",
    repetition: 1,
    plannedTracks: ["paired", "closed_loop"],
    createdAtUtc: "2026-09-01T01:00:00.000Z",
    git: { revision: "abc", dirty: false },
    scenario: { version: "v2", manifestSha256: "scenario" },
    baseline: {
      databaseSha256: "database",
      characterSpecSha256: "character",
      initialStateSha256: "state",
      scheduleSha256: "schedule",
    },
    profileConfig: {
      provider: "fixture",
      profileName: "fixture",
      baseOrigin: "fixture://local",
      baseUrl: "fixture://local",
      requestedModel: "fixture-model",
      timeoutMs: 5_000,
      maxRetries: 0,
      apiKeyPresent: false,
    },
    featureFlags: {
      chatEffectsMode: "gated",
      scheduleNegotiationMode: "enforced",
      selfInitiatedPlanningMode: "enforced",
      liveWorldEffectsMode: "enforced",
      memoryRecallMode: "enforced",
      autobiographyMode: "off",
      scheduler: "disabled",
    },
    checkpointEveryTurns: 10,
    configSha256: "config",
  };
}
