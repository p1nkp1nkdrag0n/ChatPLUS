import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { COMPANION_LONG_RUN_V2_SHA256 } from "../scenarios/companion-long-run-v2-manifest.js";
import { assertRunManifestCompatible } from "./companion-long-run-v2-artifacts.js";
import {
  approvedRunDirectoriesForProfile,
  assertLongRunV2MatrixPlanCompatible,
  completedPilotGateBlocksProfile,
  isCompatibleLongRunV2ArtifactRun,
  type LongRunV2MatrixPlanInput,
} from "./companion-long-run-v2.js";
import type { RunManifest } from "./companion-long-run-v2-run-types.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("companion long-run v2 resume safety", () => {
  it("accepts only an exactly matching matrix plan apart from creation time", () => {
    const input = matrixPlanInput();
    const persisted = {
      schemaVersion: "companion-long-run-matrix-plan-v2",
      ...input,
      scenarioSha256: COMPANION_LONG_RUN_V2_SHA256,
      createdAtUtc: "2026-09-01T00:00:00.000Z",
    };

    expect(() =>
      assertLongRunV2MatrixPlanCompatible(input, {
        ...persisted,
        createdAtUtc: "2026-09-02T00:00:00.000Z",
      }),
    ).not.toThrow();
    for (const incompatible of [
      { ...persisted, matrixId: "another-matrix" },
      { ...persisted, runs: 2 },
      { ...persisted, profiles: ["deepseek"] },
      {
        ...persisted,
        rotations: [{ repetition: 1, profiles: ["deepseek"] }],
      },
      { ...persisted, scenarioSha256: "0".repeat(64) },
      { ...persisted, unexpected: true },
    ]) {
      expect(() =>
        assertLongRunV2MatrixPlanCompatible(input, incompatible),
      ).toThrow(/matrix plan is incompatible/u);
    }
  });

  it("rejects completed run manifests from a different revision or config", () => {
    const current = runManifest();
    expect(() =>
      assertRunManifestCompatible(current, {
        ...current,
        createdAtUtc: "2026-09-02T00:00:00.000Z",
      }),
    ).not.toThrow();
    expect(() =>
      assertRunManifestCompatible(current, {
        ...current,
        git: { revision: "b".repeat(40), dirty: false },
      }),
    ).toThrow(/incompatible/u);
    expect(() =>
      assertRunManifestCompatible(current, {
        ...current,
        configSha256: "9".repeat(64),
      }),
    ).toThrow(/incompatible/u);
    expect(() =>
      assertRunManifestCompatible(current, {
        ...current,
        profileConfig: {
          ...current.profileConfig,
          requestedModel: "different-model",
        },
      }),
    ).toThrow(/incompatible/u);
  });

  it("restores a failed repetition-one Pilot gate as a profile block", () => {
    expect(
      completedPilotGateBlocksProfile(1, { eligibleForClosedLoop: false }),
    ).toBe(true);
    expect(
      completedPilotGateBlocksProfile(1, { eligibleForClosedLoop: true }),
    ).toBe(false);
    expect(
      completedPilotGateBlocksProfile(2, { eligibleForClosedLoop: false }),
    ).toBe(false);
  });

  it("admits only manifest-compatible run directories to profile artifacts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatplus-run-admission-"));
    cleanup.push(directory);
    const manifestPath = join(directory, "run-manifest.json");
    await mkdir(directory, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(runManifest())}\n`, "utf8");

    expect(
      await isCompatibleLongRunV2ArtifactRun(directory, runManifest()),
    ).toBe(true);

    await writeFile(
      manifestPath,
      `${JSON.stringify({
        ...runManifest(),
        configSha256: "9".repeat(64),
      })}\n`,
      "utf8",
    );
    expect(
      await isCompatibleLongRunV2ArtifactRun(directory, runManifest()),
    ).toBe(false);
    expect(
      await isCompatibleLongRunV2ArtifactRun(
        join(directory, "missing"),
        runManifest(),
      ),
    ).toBe(false);
  });

  it("passes only approved run directories to profile model I/O aggregation", () => {
    expect(
      approvedRunDirectoriesForProfile(
        [
          {
            profile: "deepseek",
            repetition: 3,
            runDirectory: "approved-r3",
          },
          {
            profile: "grok",
            repetition: 1,
            runDirectory: "other-profile-r1",
          },
          {
            profile: "deepseek",
            repetition: 1,
            runDirectory: "approved-r1",
          },
        ],
        "deepseek",
      ),
    ).toEqual(["approved-r1", "approved-r3"]);
  });
});

function matrixPlanInput(): LongRunV2MatrixPlanInput {
  return {
    matrixId: "formal-matrix",
    mode: "matrix",
    profiles: ["deepseek", "claude"],
    runs: 3,
    rotations: [
      { repetition: 1, profiles: ["deepseek", "claude"] },
      { repetition: 2, profiles: ["claude", "deepseek"] },
      { repetition: 3, profiles: ["deepseek", "claude"] },
    ],
  };
}

function runManifest(): RunManifest {
  return {
    schemaVersion: "companion-long-run-run-manifest-v2",
    matrixId: "formal-matrix",
    runId: "deepseek-r1",
    mode: "matrix",
    profile: "deepseek",
    repetition: 1,
    plannedTracks: ["paired", "closed_loop"],
    createdAtUtc: "2026-09-01T00:00:00.000Z",
    git: { revision: "a".repeat(40), dirty: false },
    scenario: {
      version: "companion-long-run-v2",
      manifestSha256: COMPANION_LONG_RUN_V2_SHA256,
    },
    baseline: {
      databaseSha256: "1".repeat(64),
      characterSpecSha256: "2".repeat(64),
      initialStateSha256: "3".repeat(64),
      scheduleSha256: "4".repeat(64),
    },
    profileConfig: {
      provider: "openai-compatible",
      profileName: "legacy",
      baseOrigin: "https://api.deepseek.test",
      baseUrl: "https://api.deepseek.test",
      requestedModel: "deepseek-v4-flash",
      timeoutMs: 300_000,
      maxRetries: 2,
      apiKeyEnvironment: "OPENAI_COMPATIBLE_API_KEY",
      apiKeyPresent: true,
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
    configSha256: "5".repeat(64),
  };
}
