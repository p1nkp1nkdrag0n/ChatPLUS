import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type {
  LongRunV3RunManifest,
  LongRunV3Snapshot,
  LongRunV3TurnEvidence,
} from "./companion-long-run-v3-artifacts.js";
import {
  LONG_RUN_V3_HARD_GATES,
  LONG_RUN_V3_SEMANTIC_DIMENSIONS,
  calculateLongRunV3WeightedSemanticScore,
  createLongRunV3HardGateSkeleton,
  renderLongRunV3ReportMarkdown,
  summarizeLongRunV3Run,
  writeLongRunV3ReportExclusive,
} from "./companion-long-run-v3-report.js";
import type {
  LongRunV3HardGateResult,
  LongRunV3SemanticEvaluation,
} from "./companion-long-run-v3-report.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("companion long-run v3 report", () => {
  it("creates a 19-gate review skeleton and a self-contained pending report", () => {
    const gates = createLongRunV3HardGateSkeleton();
    expect(gates).toHaveLength(19);
    expect(gates[0]).toMatchObject({ id: "H01", status: "PENDING" });
    expect(gates[18]).toMatchObject({ id: "H19", status: "PENDING" });

    const summary = summarizeLongRunV3Run({
      manifest: fakeManifest(),
      evidence: [],
    });
    const markdown = renderLongRunV3ReportMarkdown(summary);
    expect(summary.finalStatus).toBe("PARTIAL");
    expect(markdown).toContain("候选轮次：0/120");
    expect(markdown).toContain("## 冻结输入");
    expect(markdown).toContain("## 工程硬门");
    expect(markdown).toContain("## 语义评分");
    expect(markdown).toContain("## 证据产物");
    expect(markdown).toContain("第三方网关");
  });

  it("passes only a complete 108+6+6 run with all gates and semantic thresholds", () => {
    const evidence = completeEvidence();
    const summary = summarizeLongRunV3Run({
      manifest: fakeManifest(),
      evidence,
      hardGates: passingHardGates(),
      semantic: passingSemanticEvaluation(),
      completedAtUtc: "2026-10-06T12:00:00.000Z",
    });

    expect(summary.finalStatus).toBe("PASS");
    expect(summary.completedCandidateTurns).toBe(120);
    expect(summary.branchTurns).toEqual({
      shared: 108,
      stable: 6,
      independent: 6,
    });
    expect(summary.hardGates).toMatchObject({
      passed: 19,
      failed: 0,
      pending: 0,
    });
    expect(summary.semantic?.weightedScore).toBeCloseTo(3.2);
  });

  it("uses the warning status for a recovered 10-20% repair rate", () => {
    const evidence = completeEvidence().map((turn, index) =>
      index < 13 ? { ...turn, repairAttempted: true } : turn,
    );
    const summary = summarizeLongRunV3Run({
      manifest: fakeManifest(),
      evidence,
      hardGates: passingHardGates(),
      semantic: passingSemanticEvaluation(),
    });
    expect(summary.finalStatus).toBe("PASS_WITH_WARNINGS");
    expect(summary.provider.repairRate).toBeCloseTo(13 / 120);
    expect(summary.warnings[0]).toContain("警告区间");
  });

  it("keeps provider, product and semantic failures separate", () => {
    const providerEvidence = completeEvidence();
    providerEvidence[0] = {
      ...providerEvidence[0]!,
      http: {
        method: "POST",
        path: "/api/messages",
        status: 503,
        latencyMs: 1,
      },
      providerAttempts: [
        {
          attemptId: "failed-attempt",
          provider: "openai-compatible",
          model: "deepseek-v4-flash",
          purpose: "chat_turn",
          attempt: 1,
          success: false,
          status: 503,
          errorCode: "HTTP_ERROR",
          latencyMs: 1,
          startedAtUtc: "2026-09-01T01:00:00.000Z",
          completedAtUtc: "2026-09-01T01:00:00.001Z",
        },
      ],
    };
    expect(
      summarizeLongRunV3Run({
        manifest: fakeManifest(),
        evidence: providerEvidence,
        hardGates: passingHardGates(),
        semantic: passingSemanticEvaluation(),
      }).finalStatus,
    ).toBe("FAIL_PROVIDER");

    const productGates = passingHardGates();
    productGates[5] = {
      ...productGates[5]!,
      status: "FAIL",
      summary: "发现了新的精确日程",
    };
    expect(
      summarizeLongRunV3Run({
        manifest: fakeManifest(),
        evidence: completeEvidence(),
        hardGates: productGates,
        semantic: passingSemanticEvaluation(),
      }).finalStatus,
    ).toBe("FAIL_PRODUCT");

    const semantic = passingSemanticEvaluation();
    semantic.vetoes = [
      {
        code: "fabricated_outcome",
        failed: true,
        summary: "把未知结果说成已经发生",
        evidenceTurnIds: ["T056"],
      },
    ];
    expect(
      summarizeLongRunV3Run({
        manifest: fakeManifest(),
        evidence: completeEvidence(),
        hardGates: passingHardGates(),
        semantic,
      }).finalStatus,
    ).toBe("FAIL_SEMANTIC");
  });

  it("fails product when any turn or assertion fails even if every aggregate hard gate passed", () => {
    const assertionFailure = completeEvidence();
    assertionFailure[0] = {
      ...assertionFailure[0]!,
      assertions: [
        ...assertionFailure[0]!.assertions,
        {
          code: "prompt_includes_life_context",
          status: "FAIL",
          summary: "LIFE_CONTEXT_JSON was truncated",
        },
      ],
    };
    const assertionSummary = summarizeLongRunV3Run({
      manifest: fakeManifest(),
      evidence: assertionFailure,
      hardGates: passingHardGates(),
      semantic: passingSemanticEvaluation(),
    });
    expect(assertionSummary.finalStatus).toBe("FAIL_PRODUCT");
    expect(assertionSummary.hardGates.turnFailures).toEqual({
      turnIds: [],
      assertions: ["T001:prompt_includes_life_context"],
    });
    expect(renderLongRunV3ReportMarkdown(assertionSummary)).toContain(
      "T001:prompt_includes_life_context",
    );

    const turnFailure = completeEvidence();
    turnFailure[1] = { ...turnFailure[1]!, status: "FAIL" };
    const turnSummary = summarizeLongRunV3Run({
      manifest: fakeManifest(),
      evidence: turnFailure,
      hardGates: passingHardGates(),
      semantic: passingSemanticEvaluation(),
    });
    expect(turnSummary.finalStatus).toBe("FAIL_PRODUCT");
    expect(turnSummary.hardGates.turnFailures.turnIds).toEqual(["T002"]);
  });

  it("validates all eight weighted scores", () => {
    expect(
      calculateLongRunV3WeightedSemanticScore(
        passingSemanticEvaluation().dimensions,
      ),
    ).toBeCloseTo(3.2);
    expect(() => calculateLongRunV3WeightedSemanticScore([])).toThrow(
      "all eight dimensions",
    );
    const invalid = passingSemanticEvaluation().dimensions;
    invalid[0] = { ...invalid[0]!, score: 4.1 };
    expect(() => calculateLongRunV3WeightedSemanticScore(invalid)).toThrow(
      "between 0 and 4",
    );
  });

  it("never overwrites a final report", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatplus-v3-report-"));
    cleanup.push(directory);
    const summary = summarizeLongRunV3Run({
      manifest: fakeManifest(),
      evidence: [],
    });
    const path = await writeLongRunV3ReportExclusive(directory, summary);
    expect(await readFile(path, "utf8")).toContain("长程测试报告");
    await expect(
      writeLongRunV3ReportExclusive(directory, summary),
    ).rejects.toMatchObject({ code: "EEXIST" });
  });
});

function passingHardGates(): LongRunV3HardGateResult[] {
  return LONG_RUN_V3_HARD_GATES.map(([id, name]) => ({
    id,
    name,
    status: "PASS",
    evidence: [`evidence-for-${id}`],
    summary: "通过",
  }));
}

function passingSemanticEvaluation(): LongRunV3SemanticEvaluation {
  return {
    dimensions: LONG_RUN_V3_SEMANTIC_DIMENSIONS.map((dimension) => ({
      id: dimension.id,
      score: 3.2,
      rationale: "满足冻结 rubric",
      evidenceTurnIds: ["T001"],
    })),
    stageScores: [
      {
        stage: "共享主线",
        score: 3.1,
        minimum: 2.6,
        evidenceTurnIds: ["T001", "T108"],
      },
    ],
    vetoes: [
      {
        code: "fabricated_outcome",
        failed: false,
        summary: "未发现虚构结果",
        evidenceTurnIds: [],
      },
    ],
    judgedAtUtc: "2026-10-06T12:00:00.000Z",
    judge: "Codex frozen rubric v3",
  };
}

function completeEvidence(): LongRunV3TurnEvidence[] {
  return Array.from({ length: 120 }, (_, index) => {
    const ordinal = index + 1;
    const branch =
      ordinal <= 108 ? "shared" : ordinal <= 114 ? "stable" : "independent";
    return fakeTurn(ordinal, branch);
  });
}

function fakeTurn(
  ordinal: number,
  branch: LongRunV3TurnEvidence["branch"],
): LongRunV3TurnEvidence {
  const snapshot = emptySnapshot();
  return {
    schemaVersion: "companion-long-run-turn-evidence-v3",
    runId: "deepseek-v3-run",
    profile: "deepseek",
    branch,
    turnId: `T${String(ordinal).padStart(3, "0")}`,
    logicalOrdinal: ordinal,
    candidateOrdinal: ordinal,
    scenarioBlock: "test",
    rubricTags: [],
    fakeTimeBeforeUtc: "2026-09-01T01:00:00.000Z",
    fakeTimeAfterUtc: "2026-09-01T01:00:01.000Z",
    sessionId: "session",
    clientMessageId: `message-${String(ordinal)}`,
    userMessage: "用户消息",
    assistantMessage: "角色回复",
    actions: [],
    http: { method: "POST", path: "/api/messages", status: 201, latencyMs: 1 },
    logicalCalls: [],
    providerAttempts: [],
    before: snapshot,
    after: snapshot,
    causalEvidence: [],
    assertions: [
      {
        code: "response_contract_valid",
        status: "PASS",
        summary: "valid",
      },
    ],
    status: "PASS",
    repairAttempted: false,
    idempotentReplay: false,
  };
}

function emptySnapshot(): LongRunV3Snapshot {
  return {
    capturedAtUtc: "2026-09-01T01:00:00.000Z",
    runtimeState: null,
    cursor: null,
    lifeContext: null,
    lifeThreads: [],
    dailyContexts: [],
    dilemmas: [],
    supportInterventions: [],
    decisions: [],
    actions: [],
    outcomes: [],
    reflections: [],
    pressureEpisodes: [],
    relationshipMilestones: [],
    memories: [],
    memoryEvidence: [],
    messages: [],
    activityEvents: [],
    domainEvents: [],
    proactiveCandidates: [],
    rejectedProposals: [],
    retrievalRuns: [],
    llmCalls: [],
    scheduleItems: [],
    tableCounts: {},
    durableSha256: "f".repeat(64),
    auditSha256: "a".repeat(64),
  };
}

function fakeManifest(): LongRunV3RunManifest {
  return {
    schemaVersion: "companion-long-run-run-manifest-v3",
    runId: "deepseek-v3-run",
    profile: "deepseek",
    createdAtUtc: "2026-09-01T01:00:00.000Z",
    plannedCandidateTurns: 120,
    git: { revision: "a".repeat(40), dirty: false },
    scenario: {
      version: "companion-long-run-v3",
      manifestSha256: "b".repeat(64),
    },
    baseline: {
      databaseSha256: "c".repeat(64),
      characterSpecSha256: "d".repeat(64),
    },
    profileConfig: {
      provider: "openai-compatible",
      profileName: "deepseek",
      baseOrigin: "https://api.deepseek.com",
      baseUrl: "https://api.deepseek.com/v1",
      requestedModel: "deepseek-v4-flash",
      timeoutMs: 300_000,
      maxRetries: 2,
      reasoningEffort: "max",
      maxContextTokens: 128_000,
      maxOutputTokens: 32_768,
      apiKeyPresent: true,
    },
    featureFlags: {
      lifePlanningMode: "fuzzy",
      liveWorldEffectsMode: "enforced",
      memoryRecallMode: "enforced",
      scheduler: "disabled",
      autobiographyMode: "off",
    },
    checkpointEveryTurns: 10,
    configSha256: "e".repeat(64),
  };
}
