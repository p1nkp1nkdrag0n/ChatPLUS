import { describe, expect, it } from "vitest";

import {
  evaluateLongRunV2PilotGate,
  findPairedPromptHashMismatches,
  summarizeLongRunV2Run,
} from "./companion-long-run-v2-report.js";
import type {
  RunManifest,
  TurnEvidence,
} from "./companion-long-run-v2-run-types.js";

describe("companion long-run v2 report", () => {
  it("accepts exactly 30 fully structured probes with repair rate at 20%", () => {
    const evidence = Array.from({ length: 30 }, (_, index) =>
      fakeEvidence(index, index < 6),
    );
    expect(evaluateLongRunV2PilotGate(evidence)).toMatchObject({
      status: "PASS",
      eligibleForClosedLoop: true,
      repairRate: 0.2,
      finalStructureSuccessRate: 1,
    });
  });

  it("fails a pilot above the repair ceiling", () => {
    const evidence = Array.from({ length: 30 }, (_, index) =>
      fakeEvidence(index, index < 7),
    );
    expect(evaluateLongRunV2PilotGate(evidence).status).toBe("FAIL_PROVIDER");
  });

  it("detects paired prompt differences across profiles", () => {
    const first = fakeEvidence(0, false);
    const second = {
      ...fakeEvidence(0, false),
      profile: "claude" as const,
      primaryPromptSha256: "different",
    };
    expect(findPairedPromptHashMismatches([], [first, second])).toEqual([
      "1:probe-01",
    ]);
  });

  it("treats a missing profile hash as a paired prompt mismatch", () => {
    const deepseek = fakeManifest("deepseek");
    const claude = fakeManifest("claude");
    const onlyDeepseek = fakeEvidence(0, false);
    expect(
      findPairedPromptHashMismatches(
        [{ manifest: deepseek }, { manifest: claude }],
        [onlyDeepseek],
      ),
    ).toEqual(["1:probe-01"]);
  });

  it("classifies excessive repair or final schema failure as provider failure", () => {
    const repaired = Array.from({ length: 30 }, (_, index) =>
      fakeEvidence(index, index < 7),
    );
    expect(
      summarizeLongRunV2Run({
        manifest: fakeManifest("deepseek"),
        evidence: repaired,
        evidencePath: "evidence.jsonl",
        databasePaths: [],
      }).finalStatus,
    ).toBe("FAIL_PROVIDER");

    const invalid = fakeEvidence(0, false);
    invalid.assertions = [
      {
        code: "response_contract_valid",
        status: "FAIL",
        summary: "invalid",
      },
    ];
    expect(
      summarizeLongRunV2Run({
        manifest: fakeManifest("deepseek", ["paired"]),
        evidence: [
          invalid,
          ...Array.from({ length: 29 }, (_, index) =>
            fakeEvidence(index + 1, false),
          ),
        ],
        evidencePath: "evidence.jsonl",
        databasePaths: [],
      }).finalStatus,
    ).toBe("FAIL_PROVIDER");
  });
});

function fakeManifest(
  profile: RunManifest["profile"],
  plannedTracks: RunManifest["plannedTracks"] = ["paired"],
): RunManifest {
  return {
    schemaVersion: "companion-long-run-run-manifest-v2",
    matrixId: "matrix",
    runId: `${profile}-r1`,
    mode: "pilot",
    profile,
    repetition: 1,
    plannedTracks,
    createdAtUtc: "2026-09-01T01:00:00.000Z",
    git: { revision: "a".repeat(40), dirty: false },
    scenario: { version: "v2", manifestSha256: "1".repeat(64) },
    baseline: {
      databaseSha256: "2".repeat(64),
      characterSpecSha256: "3".repeat(64),
      initialStateSha256: "4".repeat(64),
      scheduleSha256: "5".repeat(64),
    },
    profileConfig: {
      provider: "openai-compatible",
      profileName: profile,
      baseOrigin: "https://example.test",
      baseUrl: "https://example.test/v1",
      requestedModel: "model",
      timeoutMs: 1_000,
      maxRetries: 0,
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
    configSha256: "6".repeat(64),
  };
}

function fakeEvidence(index: number, repaired: boolean): TurnEvidence {
  return {
    schemaVersion: "companion-long-run-turn-evidence-v2",
    matrixId: "matrix",
    runId: "run",
    profile: "deepseek",
    repetition: 1,
    track: "paired",
    branch: "shared",
    turnId: `probe-${String(index + 1).padStart(2, "0")}`,
    logicalOrdinal: index + 1,
    candidateOrdinal: index + 1,
    scenarioBlock: "paired",
    rubricTags: [],
    fakeTimeBeforeUtc: "2026-09-01T01:00:00.000Z",
    fakeTimeAfterUtc: "2026-09-01T01:00:00.000Z",
    sessionId: "session",
    clientMessageId: `client-${String(index)}`,
    userMessage: "hello",
    actions: [],
    http: { method: "POST", path: "/api", status: 201, latencyMs: 1 },
    logicalCalls: [],
    providerAttempts: [],
    primaryPromptSha256: "same",
    before: emptySnapshot(),
    after: emptySnapshot(),
    assertions: [
      {
        code: "response_contract_valid",
        status: "PASS",
        summary: "ok",
      },
    ],
    status: "PASS",
    repairAttempted: repaired,
    idempotentReplay: false,
  };
}

function emptySnapshot() {
  return {
    capturedAtUtc: "2026-09-01T01:00:00.000Z",
    runtimeState: null,
    cursor: null,
    schedule: [],
    scheduleNegotiations: [],
    settlements: [],
    activityEvents: [],
    memories: [],
    memoryEvidence: [],
    proactiveCandidates: [],
    messages: [],
    domainEvents: [],
    rejectedProposals: [],
    retrievalRuns: [],
    llmCalls: [],
    tableCounts: {},
    durableSha256: "0".repeat(64),
  };
}
