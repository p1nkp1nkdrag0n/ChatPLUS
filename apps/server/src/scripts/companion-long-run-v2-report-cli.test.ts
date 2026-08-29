import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type CompanionLongRunV2RubricScores } from "./companion-long-run-v2-evaluation.js";
import {
  executeCompanionLongRunV2JudgePlan,
  planCompanionLongRunV2Judge,
  type CompanionLongRunV2JudgeArtifact,
  type CompanionLongRunV2JudgeCandidate,
  type CompanionLongRunV2JudgeMappingKey,
} from "./companion-long-run-v2-judge.js";
import {
  buildCompanionLongRunV2FinalReport,
  parseCompanionLongRunV2ReportArgs,
  readCompanionLongRunV2RunSummaries,
  renderCompanionLongRunV2FinalReportMarkdown,
  writeCompanionLongRunV2FinalReportExclusive,
  type CompanionLongRunV2HumanReviewFile,
} from "./companion-long-run-v2-report-cli.js";
import type { RunSummary } from "./companion-long-run-v2-run-types.js";

const SCORES: CompanionLongRunV2RubricScores = {
  persona: 3,
  daily_relevance: 3,
  emotion: 3,
  memory_time: 3,
  relationship_romance: 3,
  independent_life_schedule: 3,
  language_naturalness: 3,
};

function candidate(): CompanionLongRunV2JudgeCandidate {
  return {
    itemId: "deepseek-run-1:paired:shared:turn-1",
    profile: "deepseek",
    scenarioId: "matrix-a",
    runId: "deepseek-run-1",
    repetition: 1,
    candidateNumber: 1,
    evidence: {
      scenarioBlock: "opening",
      rubricTags: ["persona_identity"],
      fakeTimeBeforeUtc: "2026-08-16T10:00:00.000Z",
      fakeTimeAfterUtc: "2026-08-16T10:05:00.000Z",
      userMessage: "早上好",
      candidateResponse: "早，今天先去图书馆。",
      assertionSummary: ["http_success:PASS:ok"],
    },
  };
}

function summary(finalStatus: RunSummary["finalStatus"] = "PASS"): RunSummary {
  return {
    schemaVersion: "companion-long-run-run-summary-v2",
    manifest: {
      schemaVersion: "companion-long-run-run-manifest-v2",
      matrixId: "matrix-a",
      runId: "deepseek-run-1",
      mode: "matrix",
      profile: "deepseek",
      repetition: 1,
      plannedTracks: ["paired", "closed_loop"],
      createdAtUtc: "2026-08-29T00:00:00.000Z",
      git: { revision: "abc123", dirty: false },
      scenario: { version: "v2", manifestSha256: "scenario-sha" },
      baseline: {
        databaseSha256: "db-sha",
        characterSpecSha256: "character-sha",
        initialStateSha256: "state-sha",
        scheduleSha256: "schedule-sha",
      },
      profileConfig: {
        provider: "openai-compatible",
        profileName: "deepseek",
        baseOrigin: "https://api.deepseek.com",
        baseUrl: "https://api.deepseek.com/v1",
        requestedModel: "deepseek-v4-flash",
        timeoutMs: 120_000,
        maxRetries: 1,
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
      configSha256: "config-sha",
    },
    status:
      finalStatus === "PASS" || finalStatus === "PASS_WITH_WARNINGS"
        ? "PASS"
        : finalStatus === "PARTIAL" || finalStatus === "SKIPPED"
          ? finalStatus
          : "FAIL",
    finalStatus,
    completed: { paired: 30, closedLoop: 120, total: 150 },
    hardAssertions: {
      passed: finalStatus === "FAIL_PRODUCT" ? 149 : 150,
      failed: finalStatus === "FAIL_PRODUCT" ? 1 : 0,
      skipped: 0,
    },
    provider: {
      physicalAttempts: 150,
      failedAttempts: finalStatus === "FAIL_PROVIDER" ? 1 : 0,
      repairedTurns: finalStatus === "PASS_WITH_WARNINGS" ? 1 : 0,
      repairRate: finalStatus === "PASS_WITH_WARNINGS" ? 0.01 : 0,
    },
    promptHashMismatches: [],
    warnings:
      finalStatus === "PASS_WITH_WARNINGS" ? ["One repair was used."] : [],
    evidencePath: "runs/deepseek-run-1/turn-evidence.jsonl",
    databasePaths: ["runs/deepseek-run-1/run.sqlite"],
    completedAtUtc: "2026-08-29T01:00:00.000Z",
  };
}

async function judged(): Promise<{
  artifact: CompanionLongRunV2JudgeArtifact;
  mappingKey: CompanionLongRunV2JudgeMappingKey;
}> {
  const plan = planCompanionLongRunV2Judge([candidate()], "report-seed");
  const artifact = await executeCompanionLongRunV2JudgePlan({
    plan,
    createdAtUtc: "2026-08-29T02:00:00.000Z",
    executeProfile: (_profile, requests) =>
      Promise.resolve(
        requests.map((request) => ({
          reviews: request.candidates.map(({ blindId }) => ({
            blindId,
            scores: SCORES,
            conclusion: "PASS" as const,
            rationale: "Evidence is consistent.",
          })),
        })),
      ),
  });
  return { artifact, mappingKey: plan.mappingKey };
}

function humanReview(
  mappingKey: CompanionLongRunV2JudgeMappingKey,
): CompanionLongRunV2HumanReviewFile {
  return {
    schemaVersion: "companion-long-run-v2-human-review-v1",
    reviews: [
      {
        blindId: mappingKey.candidates[0]!.blindId,
        scores: SCORES,
        conclusion: "PASS",
      },
    ],
  };
}

describe("companion long-run v2 final report", () => {
  it("combines summaries, anonymous judge results and human calibration", async () => {
    const { artifact, mappingKey } = await judged();
    const report = buildCompanionLongRunV2FinalReport({
      runSummaries: [summary()],
      judgeArtifact: artifact,
      mappingKey,
      humanReview: humanReview(mappingKey),
      createdAtUtc: "2026-08-29T03:00:00.000Z",
    });
    expect(report.classification).toBe("PASS");
    expect(report.provisional).toBe(false);
    expect(report.calibration.meanAbsoluteError).toBe(0);
    expect(report.calibration.conclusionAgreementRate).toBe(1);
    expect(report.evaluation.profileScores.deepseek).toBe(3);
    expect(report.evaluation.runScores["deepseek-run-1"]).toBe(3);
    expect(
      renderCompanionLongRunV2FinalReportMarkdown({
        report,
        runSummaries: [summary()],
      }),
    ).toContain("Classification: **PASS**");
  });

  it("is provisional without human review and preserves run-level product failure", async () => {
    const { artifact, mappingKey } = await judged();
    const provisional = buildCompanionLongRunV2FinalReport({
      runSummaries: [summary()],
      judgeArtifact: artifact,
      mappingKey,
    });
    expect(provisional.classification).toBe("PASS_WITH_WARNINGS");
    expect(provisional.provisional).toBe(true);

    const failed = buildCompanionLongRunV2FinalReport({
      runSummaries: [summary("FAIL_PRODUCT")],
      judgeArtifact: artifact,
      mappingKey,
      humanReview: humanReview(mappingKey),
    });
    expect(failed.classification).toBe("FAIL_PRODUCT");
  });

  it("reports partial when a candidate lacks dual judge reviews", async () => {
    const { artifact, mappingKey } = await judged();
    const partialArtifact = {
      ...artifact,
      reviews: artifact.reviews.slice(0, 1),
    };
    const report = buildCompanionLongRunV2FinalReport({
      runSummaries: [summary()],
      judgeArtifact: partialArtifact,
      mappingKey,
    });
    expect(report.classification).toBe("PARTIAL");
  });

  it("rejects a tampered model mapping key", async () => {
    const { artifact, mappingKey } = await judged();
    const tampered: CompanionLongRunV2JudgeMappingKey = {
      ...mappingKey,
      candidates: mappingKey.candidates.map((entry) => ({
        ...entry,
        profile: "claude" as const,
      })),
    };
    expect(() =>
      buildCompanionLongRunV2FinalReport({
        runSummaries: [summary()],
        judgeArtifact: artifact,
        mappingKey: tampered,
      }),
    ).toThrow(/SHA-256/u);
  });

  it("writes final JSON/Markdown exclusively and reads summary directories", async () => {
    const directory = await mkdtemp(join(tmpdir(), "chatplus-v2-report-test-"));
    try {
      const { artifact, mappingKey } = await judged();
      const runSummary = summary();
      const summaryDirectory = join(directory, "summaries");
      await writeFile(
        join(directory, "run-summary.json"),
        JSON.stringify(runSummary),
        "utf8",
      );
      const loaded = await readCompanionLongRunV2RunSummaries(directory);
      expect(loaded).toHaveLength(1);
      expect(summaryDirectory).toContain("summaries");
      const report = buildCompanionLongRunV2FinalReport({
        runSummaries: loaded,
        judgeArtifact: artifact,
        mappingKey,
        humanReview: humanReview(mappingKey),
      });
      const paths = await writeCompanionLongRunV2FinalReportExclusive({
        outputDirectory: join(directory, "output"),
        report,
        runSummaries: loaded,
      });
      expect(await readFile(paths.jsonPath, "utf8")).toContain(
        '"classification": "PASS"',
      );
      expect(await readFile(paths.markdownPath, "utf8")).toContain(
        "companion long-run v2 final report",
      );
      await expect(
        writeCompanionLongRunV2FinalReportExclusive({
          outputDirectory: join(directory, "output"),
          report,
          runSummaries: loaded,
        }),
      ).rejects.toMatchObject({ code: "EEXIST" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("parses the offline report CLI contract", () => {
    expect(
      parseCompanionLongRunV2ReportArgs([
        "--summaries=runs",
        "--judge",
        "judge.json",
        "--mapping-key=key.json",
        "--human-review",
        "human.json",
        "--output-dir",
        "report",
      ]),
    ).toEqual({
      summariesPath: "runs",
      judgePath: "judge.json",
      mappingKeyPath: "key.json",
      humanReviewPath: "human.json",
      outputDirectory: "report",
    });
  });
});
