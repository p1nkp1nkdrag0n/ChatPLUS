import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { CompanionTurnExpected } from "../scenarios/companion-long-run-types.js";
import {
  CompanionLongRunReportSafetyError,
  aggregateAssertions,
  aggregateLlmUsage,
  buildCompanionLongRunReport,
  redactCompanionLongRunReportValue,
  renderCompanionLongRunReportJson,
  renderCompanionLongRunReportMarkdown,
  scanCompanionLongRunReportSafety,
  shouldWriteCompanionLongRunCheckpoint,
  writeCompanionLongRunReport,
  type BuildCompanionLongRunReportInput,
  type CompanionLongRunReport,
  type CompanionLongRunTurnReport,
} from "./companion-long-run-report.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("companion long-run report", () => {
  it("builds assertion, phase, restart, session, and LLM usage aggregates", () => {
    const report = buildCompanionLongRunReport({
      ...baseInput("FAIL", [
        turnFixture(1, {
          phase: "memory",
          llmCalls: [llmCall("turn_understanding", 10, true, 20, 5)],
        }),
        turnFixture(2, {
          phase: "care",
          sessionId: "session-b",
          actionsBefore: [
            { kind: "restart_app", preserveDatabase: true },
            { kind: "send_message" },
          ],
          llmCalls: [llmCall("turn_understanding", 30, false, 40, 6)],
          assertions: [
            {
              code: "C-LISTEN",
              passed: false,
              message: "care cue was not used",
            },
          ],
        }),
      ]),
      runAssertions: [
        { code: "RUN-COMPLETE", passed: true, message: "runner finalized" },
      ],
      metrics: { summary_style_ending_rate: 0.04 },
      metricDetails: [
        {
          name: "summary_style_ending_rate",
          value: 0.04,
          comparator: "<=",
          threshold: 0.05,
          passed: true,
          source: "assistant replies",
        },
      ],
    });

    expect(report).toMatchObject({
      logicalTurnCount: 2,
      httpExchangeCount: 2,
      sessionCount: 2,
      restartCount: 1,
      assertionSummary: { total: 3, passed: 2, failed: 1, hardFailed: 1 },
      llmUsageSummary: {
        calls: 2,
        successfulCalls: 1,
        failedCalls: 1,
        attemptCount: 2,
        failedAttemptCount: 1,
        providerInputUsageAttemptCount: 0,
        providerOutputUsageAttemptCount: 0,
        exactAttemptTelemetryCalls: 0,
        completeProviderUsageCalls: 0,
        inputTokens: 60,
        outputTokens: 11,
        estimatedInputTokens: 60,
        estimatedOutputTokens: 11,
        providerInputTokens: 0,
        providerOutputTokens: 0,
        comparableEstimatedInputTokens: 0,
        comparableEstimatedOutputTokens: 0,
        inputTokenError: 0,
        outputTokenError: 0,
        providerUsageCalls: 0,
      },
    });
    expect(report.phases).toEqual([
      {
        phase: "memory",
        firstTurn: 1,
        lastTurn: 1,
        turnCount: 1,
        assertionCount: 1,
        assertionFailureCount: 0,
        hardAssertionFailureCount: 0,
      },
      {
        phase: "care",
        firstTurn: 2,
        lastTurn: 2,
        turnCount: 1,
        assertionCount: 1,
        assertionFailureCount: 1,
        hardAssertionFailureCount: 1,
      },
    ]);
    expect(report.llmUsage).toEqual([
      {
        purpose: "turn_understanding",
        calls: 2,
        successfulCalls: 1,
        failedCalls: 1,
        attemptCount: 2,
        failedAttemptCount: 1,
        providerInputUsageAttemptCount: 0,
        providerOutputUsageAttemptCount: 0,
        exactAttemptTelemetryCalls: 0,
        completeProviderUsageCalls: 0,
        inputTokens: 60,
        outputTokens: 11,
        estimatedInputTokens: 60,
        estimatedOutputTokens: 11,
        providerInputTokens: 0,
        providerOutputTokens: 0,
        comparableEstimatedInputTokens: 0,
        comparableEstimatedOutputTokens: 0,
        inputTokenError: 0,
        outputTokenError: 0,
        providerUsageCalls: 0,
        latencyMsP50: 10,
        latencyMsP95: 30,
        latencyMsMax: 30,
      },
    ]);
  });

  it("renders canonical JSON and Markdown from the same allowlisted report", () => {
    const report = passingReport();
    const json = renderCompanionLongRunReportJson(report);
    const markdown = renderCompanionLongRunReportMarkdown(report);
    const parsed = JSON.parse(json) as {
      status: string;
      logicalTurnCount: number;
      assertions: Array<{ code: string }>;
    };

    expect(parsed.status).toBe("PASS");
    expect(parsed.logicalTurnCount).toBe(2);
    expect(parsed.assertions.map((item) => item.code)).toEqual(["Q0", "Q0"]);
    expect(markdown).toContain("# ChatPLUS Companion Long-Run Report");
    expect(markdown).toContain("**Status:** PASS");
    expect(markdown).toContain("## Phases");
    expect(markdown).toContain("physical attempts: 2 (0 failed)");
    expect(markdown).toContain("<details><summary>Turn 1");
    expect(markdown).toContain("(manifest 1)");
    expect(markdown).toContain("actual conversation");
    expect(markdown).not.toContain("systemPrompt");
    expect(markdown).not.toContain("rawProviderPayload");
  });

  it("renders recall metric samples and failed run/manifest turn sets", () => {
    const report = buildCompanionLongRunReport({
      ...baseInput("FAIL", [turnFixture(1), turnFixture(2)]),
      metrics: {
        DurableRecallMappingRate: 1,
        DurableRecallAssertionPassRate: 0.5,
      },
      metricDetails: [
        {
          name: "DurableRecallMappingRate",
          value: 1,
          numerator: 2,
          denominator: 2,
          failedTurnNumbers: [],
          failedManifestTurnNumbers: [],
          comparator: "=",
          threshold: 1,
          passed: true,
          source: "runner evidence-mapping integrity",
        },
        {
          name: "DurableRecallAssertionPassRate",
          value: 0.5,
          numerator: 1,
          denominator: 2,
          failedTurnNumbers: [2],
          failedManifestTurnNumbers: [18],
          comparator: "=",
          threshold: 1,
          passed: false,
          source: "runner end-to-end durable recall hard assertions",
        },
      ],
    });
    const json = JSON.parse(renderCompanionLongRunReportJson(report)) as {
      metricDetails: Array<{
        name: string;
        numerator?: number;
        denominator?: number;
        failedTurnNumbers?: number[];
        failedManifestTurnNumbers?: number[];
      }>;
    };
    const markdown = renderCompanionLongRunReportMarkdown(report);

    expect(
      json.metricDetails.find(
        (metric) => metric.name === "DurableRecallAssertionPassRate",
      ),
    ).toMatchObject({
      numerator: 1,
      denominator: 2,
      failedTurnNumbers: [2],
      failedManifestTurnNumbers: [18],
    });
    expect(markdown).toContain(
      "| Metric | Value | Sample | Failed turns (run / manifest) |",
    );
    expect(markdown).toContain(
      "| DurableRecallMappingRate | 1 | 2 / 2 | none |",
    );
    expect(markdown).toContain(
      "| DurableRecallAssertionPassRate | 0.5 | 1 / 2 | run: 2; manifest: 18 |",
    );
  });

  it("preserves release child identity, provenance, artifacts, and real totals", () => {
    const turns = [turnFixture(1), turnFixture(2)];
    const child = (runIndex: number) => ({
      runId: `release-${String(runIndex)}`,
      runIndex,
      databaseLabel: `tmp/release-${String(runIndex)}.sqlite`,
      status: "PASS" as const,
      completionReason: "completed",
      requestedTurnCount: 1,
      logicalTurnCount: 1,
      llmCallCount: 1,
      p95LlmLatencyMs: 20,
      providerInputTokens: 0,
      providerOutputTokens: 0,
      repoHead: "abc1234",
      worktreeDirty: false,
      gitDiffStat: "clean",
      gitDiffFingerprint: "f".repeat(64),
      untrackedFileCount: 0,
      scenarioVersion: "companion-long-run-v1",
      provider: "fixture",
      model: "fixture-long-run-v1",
      jsonArtifact: `reports/release-${String(runIndex)}.json`,
      markdownArtifact: `reports/release-${String(runIndex)}.md`,
      resolvedTurnCount: 1,
      strictResolvedTurnCount: 1,
      safeFallbackTurnCount: 0,
      unsafeUnderstandingFailureCount: 0,
      understandingModelCallCount: 1,
      successfulUnderstandingModelCallCount: 1,
      failedUnderstandingModelCallCount: 0,
      providerUsageComplete: false,
      modelComparable: true,
      completeAndPassing: true,
    });
    const report = buildCompanionLongRunReport({
      ...baseInput("PASS", turns),
      runId: "release-matrix",
      scenarioVersion: "companion-long-run-v1-release-matrix",
      releaseMatrix: {
        expectedRuns: 2,
        children: [child(1), child(2)],
      },
    });

    const json = JSON.parse(renderCompanionLongRunReportJson(report)) as {
      logicalTurnCount: number;
      llmUsageSummary: { calls: number };
      releaseMatrix: { children: Array<Record<string, unknown>> };
    };
    const markdown = renderCompanionLongRunReportMarkdown(report);
    expect(json.logicalTurnCount).toBe(2);
    expect(json.llmUsageSummary.calls).toBe(2);
    expect(json.releaseMatrix.children).toHaveLength(2);
    expect(json.releaseMatrix.children[0]).toMatchObject({
      runId: "release-1",
      databaseLabel: "tmp/release-1.sqlite",
      jsonArtifact: "reports/release-1.json",
      p95LlmLatencyMs: 20,
    });
    expect(markdown).toContain("## Release matrix children");
    expect(markdown).toContain("2 / 2 logical turns");
    expect(markdown).toContain("reports/release-2.md");
  });

  it("allowlists DTO fields instead of serializing extra provider data", () => {
    const turn = Object.assign(turnFixture(1), {
      providerPayload: "RAW_PROVIDER_BODY",
      arbitraryNestedObject: { opaque: "MUST_NOT_APPEAR" },
    });
    const report = buildCompanionLongRunReport(baseInput("PASS", [turn]));
    const json = renderCompanionLongRunReportJson(report);

    expect(json).not.toContain("providerPayload");
    expect(json).not.toContain("RAW_PROVIDER_BODY");
    expect(json).not.toContain("arbitraryNestedObject");
    expect(json).not.toContain("MUST_NOT_APPEAR");
  });

  it("redacts known secrets, credential shapes, and local path variants", () => {
    const secret = "sk-test-super-secret-value";
    const workspace = "E:/private/workspace";
    const report = buildCompanionLongRunReport({
      ...baseInput("PASS", [
        turnFixture(1, {
          userText: `token ${secret}; file E:\\private\\workspace\\note.txt`,
          assistant: {
            text: `Bearer ${secret} from file:///E:/private/workspace/note.txt`,
            chunkCount: 1,
            repairAttempted: false,
            usedFallback: false,
          },
        }),
      ]),
    });
    const json = renderCompanionLongRunReportJson(report, [secret, workspace]);
    const markdown = renderCompanionLongRunReportMarkdown(report, [
      secret,
      workspace,
    ]);

    for (const output of [json, markdown]) {
      expect(output).toContain("[REDACTED]");
      expect(output).not.toContain(secret);
      expect(output).not.toContain("E:\\private\\workspace");
      expect(output).not.toContain("E:/private/workspace");
      expect(output).not.toContain("file:///E:/private/workspace");
    }
    expect(
      redactCompanionLongRunReportValue(
        { apiKey: secret, hasApiKey: true, inputTokens: 9 },
        [secret],
      ),
    ).toEqual({
      apiKey: "[REDACTED]",
      hasApiKey: true,
      inputTokens: 9,
    });
  });

  it("fails closed on UNC, extended Windows, and common POSIX absolute paths", () => {
    const cases = [
      {
        value: String.raw`\\fileserver\share\private\note.txt`,
        code: "absolute_windows_unc_path",
      },
      {
        value: String.raw`\\?\C:\private\workspace\note.txt`,
        code: "absolute_windows_extended_path",
      },
      {
        value: String.raw`\\?\UNC\fileserver\share\private\note.txt`,
        code: "absolute_windows_extended_path",
      },
      { value: "/etc/passwd", code: "absolute_posix_path" },
      { value: "/var/lib/chatplus/report.json", code: "absolute_posix_path" },
      { value: "/opt/chatplus/run.log", code: "absolute_posix_path" },
    ] as const;

    for (const { value, code } of cases) {
      expect(redactCompanionLongRunReportValue(value)).toBe("[REDACTED_PATH]");
      expect(
        scanCompanionLongRunReportSafety({ nested: { value } }).map(
          (finding) => finding.code,
        ),
      ).toContain(code);
    }
  });

  it("does not mistake HTTP URLs containing path-like segments for local paths", () => {
    const urls = [
      "https://example.com/etc/passwd",
      "https://example.com/download?path=/var/lib/chatplus/report.json",
      "http://localhost/Users/demo/note.txt",
    ];

    for (const url of urls) {
      expect(redactCompanionLongRunReportValue(url)).toBe(url);
      expect(scanCompanionLongRunReportSafety(url)).toEqual([]);
    }
  });

  it("fails closed on forbidden raw fields without including their values in diagnostics", () => {
    const report = Object.assign(passingReport(), {
      systemPrompt: "DO_NOT_LOG_THIS_SYSTEM_PROMPT",
    });

    expect(() => renderCompanionLongRunReportJson(report)).toThrow(
      CompanionLongRunReportSafetyError,
    );
    try {
      renderCompanionLongRunReportJson(report);
    } catch (error) {
      expect(error).toBeInstanceOf(CompanionLongRunReportSafetyError);
      expect(String(error)).not.toContain("DO_NOT_LOG_THIS_SYSTEM_PROMPT");
    }
  });

  it("neutralizes Markdown fence injection in user and assistant text", () => {
    const report = buildCompanionLongRunReport({
      ...baseInput("PASS", [
        turnFixture(1, {
          userText: "hello ~~~json injected",
          assistant: {
            text: "reply ~~~html injected",
            chunkCount: 1,
            repairAttempted: false,
            usedFallback: false,
          },
        }),
      ]),
    });
    const markdown = renderCompanionLongRunReportMarkdown(report);

    expect(markdown).toContain("hello ~ ~ ~json injected");
    expect(markdown).toContain("reply ~ ~ ~html injected");
    expect(markdown).not.toContain("hello ~~~json injected");
  });

  it("writes unique atomic checkpoint and final JSON/Markdown pairs", async () => {
    const workspaceRoot = await makeTemporaryDirectory();
    const reportDir = join(workspaceRoot, "reports", "companion-long-run");
    const partial = buildCompanionLongRunReport({
      ...baseInput(
        "PARTIAL",
        Array.from({ length: 10 }, (_, index) => turnFixture(index + 1)),
      ),
      partialSequence: 1,
    });
    const partialPaths = await writeCompanionLongRunReport(partial, {
      reportDir,
      workspaceRoot,
      secrets: ["sk-never-write-this"],
      partialSequence: 1,
    });

    expect(partialPaths.jsonPath).toBe(
      join(reportDir, "run-001.partial-001-t010.json"),
    );
    expect(partialPaths.markdownPath).toBe(
      join(reportDir, "run-001.partial-001-t010.md"),
    );
    const partialJson = JSON.parse(
      await readFile(partialPaths.jsonPath, "utf8"),
    ) as CompanionLongRunReport;
    expect(partialJson).toMatchObject({
      status: "PARTIAL",
      logicalTurnCount: 10,
      artifacts: {
        json: "run-001.partial-001-t010.json",
        markdown: "run-001.partial-001-t010.md",
      },
      checkpoint: { lastCompletedTurn: 10, partialSequence: 1 },
    });
    expect(await readFile(partialPaths.markdownPath, "utf8")).toContain(
      "**Status:** PARTIAL",
    );

    const finalPaths = await writeCompanionLongRunReport(passingReport(), {
      reportDir,
      workspaceRoot,
    });
    expect(finalPaths.jsonPath).toBe(join(reportDir, "run-001.json"));
    expect(finalPaths.markdownPath).toBe(join(reportDir, "run-001.md"));
    expect((await readdir(reportDir)).sort()).toEqual([
      "run-001.json",
      "run-001.md",
      "run-001.partial-001-t010.json",
      "run-001.partial-001-t010.md",
    ]);
  });

  it("refuses overwrite and leaves no target artifacts after a safety failure", async () => {
    const workspaceRoot = await makeTemporaryDirectory();
    const reportDir = join(workspaceRoot, "reports");
    const report = passingReport();
    await writeCompanionLongRunReport(report, { reportDir, workspaceRoot });
    await expect(
      writeCompanionLongRunReport(report, { reportDir, workspaceRoot }),
    ).rejects.toThrow(/overwrite/iu);

    const unsafeDir = join(workspaceRoot, "unsafe-reports");
    const unsafe = Object.assign(passingReport(), {
      rawProviderPayload: "RAW_PROVIDER_BODY",
    });
    await expect(
      writeCompanionLongRunReport(unsafe, {
        reportDir: unsafeDir,
        workspaceRoot,
      }),
    ).rejects.toBeInstanceOf(CompanionLongRunReportSafetyError);
    await expect(readdir(unsafeDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("enforces PASS and checkpoint invariants", () => {
    const failingTurn = turnFixture(1, {
      assertions: [
        { code: "Q0", passed: false, message: "hard assertion failed" },
      ],
    });
    expect(() =>
      buildCompanionLongRunReport(baseInput("PASS", [failingTurn])),
    ).toThrow(/PASS cannot/iu);
    expect(() =>
      buildCompanionLongRunReport({
        ...baseInput("PARTIAL", [turnFixture(1)]),
        partialSequence: 1,
      }),
    ).not.toThrow();
    expect(
      buildCompanionLongRunReport({
        ...baseInput("PARTIAL", [turnFixture(1)]),
        completionReason: "budget_limit",
      }),
    ).toMatchObject({
      completionReason: "budget_limit",
      failure: { code: "budget_limit", stage: "budget_limit" },
    });
  });

  it("exposes deterministic aggregation and safety helpers", () => {
    expect(shouldWriteCompanionLongRunCheckpoint(0)).toBe(false);
    expect(shouldWriteCompanionLongRunCheckpoint(9)).toBe(false);
    expect(shouldWriteCompanionLongRunCheckpoint(10)).toBe(true);
    expect(shouldWriteCompanionLongRunCheckpoint(100)).toBe(true);
    expect(
      aggregateAssertions([
        { code: "a", passed: true, message: "ok" },
        { code: "b", passed: false, hard: false, message: "soft" },
      ]),
    ).toMatchObject({ total: 2, passed: 1, failed: 1, hardFailed: 0 });
    expect(aggregateLlmUsage([])).toEqual({
      calls: 0,
      successfulCalls: 0,
      failedCalls: 0,
      attemptCount: 0,
      failedAttemptCount: 0,
      providerInputUsageAttemptCount: 0,
      providerOutputUsageAttemptCount: 0,
      exactAttemptTelemetryCalls: 0,
      completeProviderUsageCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      providerInputTokens: 0,
      providerOutputTokens: 0,
      comparableEstimatedInputTokens: 0,
      comparableEstimatedOutputTokens: 0,
      inputTokenError: 0,
      outputTokenError: 0,
      providerUsageCalls: 0,
      byPurpose: [],
    });
    expect(
      aggregateLlmUsage([
        {
          purpose: "reply_generation",
          provider: "deepseek",
          model: "deepseek-chat",
          attempt: 1,
          latencyMs: 50,
          success: true,
          inputTokens: 120,
          outputTokens: 60,
          providerInputTokens: 100,
          providerOutputTokens: 55,
          usageSource: "provider",
        },
      ]),
    ).toMatchObject({
      inputTokens: 100,
      outputTokens: 55,
      estimatedInputTokens: 120,
      estimatedOutputTokens: 60,
      providerInputTokens: 100,
      providerOutputTokens: 55,
      comparableEstimatedInputTokens: 120,
      comparableEstimatedOutputTokens: 60,
      inputTokenError: -20,
      outputTokenError: -5,
      providerUsageCalls: 1,
    });
    const findings = scanCompanionLongRunReportSafety({
      rawOutput: "SECRET_BODY_SHOULD_NOT_BE_IN_ERROR",
    });
    expect(findings).toEqual([
      { code: "forbidden_field", path: "$.rawOutput" },
    ]);
    expect(JSON.stringify(findings)).not.toContain(
      "SECRET_BODY_SHOULD_NOT_BE_IN_ERROR",
    );
  });
});

function passingReport(): CompanionLongRunReport {
  return buildCompanionLongRunReport(
    baseInput("PASS", [turnFixture(1), turnFixture(2)]),
  );
}

function baseInput(
  status: BuildCompanionLongRunReportInput["status"],
  turns: readonly CompanionLongRunTurnReport[],
): BuildCompanionLongRunReportInput {
  return {
    runId: "run-001",
    scenarioVersion: "companion-long-run-v1",
    repoHead: "abc1234",
    startedAtUtc: "2026-08-23T00:00:00.000Z",
    completedAtUtc: "2026-08-23T01:00:00.000Z",
    status,
    provider: "fixture",
    model: "fixture-long-run-v1",
    clockMode: "fake",
    pipelineExpectation: "target",
    requestedTurnCount: turns.length,
    httpExchangeCount: turns.length,
    turns,
  };
}

function turnFixture(
  number: number,
  overrides: Partial<CompanionLongRunTurnReport> = {},
): CompanionLongRunTurnReport {
  const expected: CompanionTurnExpected = {
    route: "conversation",
    mainGoalActivated: false,
    goalExpectation: "suppressed",
    scheduleExpectation: "none",
    hardAssertionCodes: ["Q0"],
    softMetricTags: ["objective_reply_alignment"],
  };
  return {
    number,
    manifestTurnNumber: number,
    phase: "memory",
    objective: `objective ${String(number)}`,
    sessionKey: "A",
    sessionId: "session-a",
    clientMessageId: `client-${String(number)}`,
    userText: `user text ${String(number)}`,
    actionsBefore: [{ kind: "send_message" }],
    expected,
    http: [
      {
        label: "send-message",
        method: "POST",
        route: "/api/sessions/session-a/messages",
        status: 200,
        durationMs: 12,
        requestId: `request-${String(number)}`,
      },
    ],
    actualRoute: "conversation",
    observation: {
      origin: "fixture",
      route: "conversation",
      confidence: 0.95,
      dialogueActs: ["inform"],
      topicKeys: ["daily-life"],
      topicDomains: ["life"],
      scheduleIntentKind: "none",
      salientUserQuotes: [`user text ${String(number)}`],
      worldEffectCandidateCounts: {
        stateDelta: 0,
        relationshipDelta: 0,
        memories: 0,
        personalIntents: 0,
        continuityEffects: 0,
        careCues: 0,
      },
    },
    outcome: {
      route: "conversation",
      scheduleOutcomeKind: "none",
      decisionPath: "reply_only",
      worldEffectsMode: "enforced",
      worldEffectWritesEnabled: true,
      scheduleWritesEnabled: true,
      stateChanged: false,
      dryRun: false,
      replyDirectiveMode: "casual",
      acceptedEffectCounts: {
        stateDelta: 0,
        relationshipDelta: 0,
        memories: 0,
        personalIntents: 0,
        continuityEffects: 0,
        careCues: 0,
      },
      proposalRejectionCodes: [],
    },
    contextPlan: {
      activatedTraitIds: ["trait-1"],
      activatedValueIds: [],
      activatedContradictionIds: [],
      activatedGoalIds: [],
      activatedPreferenceIds: [],
      suppressedGoalIds: ["goal-main"],
      includeAutobiography: false,
      includeCalendar: false,
      includeFutureSchedule: false,
      includeRetrievedEvidence: false,
      trace: [],
    },
    promptSegmentTrace: [
      {
        id: "runtime-state",
        placement: "system",
        priority: 100,
        tokenBudget: 100,
        estimatedTokens: 20,
        required: true,
        included: true,
        truncated: false,
        cacheHit: false,
      },
    ],
    selectedEvidenceIds: [],
    assistant: {
      text: `assistant reply ${String(number)}`,
      chunkCount: 1,
      repairAttempted: false,
      usedFallback: false,
    },
    stateBefore: {
      memoryCount: number - 1,
      careCueCount: 0,
      followUpCount: 0,
      domainEventCount: number - 1,
    },
    stateAfter: {
      memoryCount: number,
      careCueCount: 0,
      followUpCount: 0,
      domainEventCount: number,
    },
    changes: { stateChanged: false },
    domainEvents: [],
    retrieval: {
      runIds: [],
      selectedEvidenceIds: [],
      evidenceMappings: [],
    },
    llmCalls: [llmCall("reply_generation", 20, true, 30, 8)],
    assertions: [{ code: "Q0", passed: true, message: "reply is non-empty" }],
    softMetricTags: ["objective_reply_alignment"],
    ...overrides,
  };
}

function llmCall(
  purpose: string,
  latencyMs: number,
  success: boolean,
  inputTokens: number,
  outputTokens: number,
) {
  return {
    purpose,
    provider: "fixture",
    model: "fixture-long-run-v1",
    attempt: 1,
    latencyMs,
    success,
    inputTokens,
    outputTokens,
  };
}

async function makeTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "chatplus-report-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
