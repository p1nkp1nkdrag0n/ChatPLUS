import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readConfig, type ServerConfig } from "../config.js";
import {
  buildCompanionLongRunReport,
  type BuildCompanionLongRunReportInput,
  type CompanionLongRunReport,
  type CompanionLongRunReportWriteOptions,
  writeCompanionLongRunReport,
} from "./companion-long-run-report.js";
import type { CompanionLongRunExecution } from "./companion-long-run-runner.js";
import { toCompanionLongRunReportInput } from "./companion-long-run-report-adapter.js";
import {
  DEEPSEEK_30_TURN_RELEASE_BASELINE,
  DeepSeekLongRunCliUsageError,
  evaluatePaidDeepSeekGate,
  evaluateDeepSeek30TurnReleaseAggregate,
  parseDeepSeekLongRunArgs,
  runDeepSeekLongRunAcceptanceCli,
} from "./deepseek-long-run-acceptance.js";

const FIXED_NOW = new Date("2026-08-23T10:00:00.000Z");
const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("deepseek long-run CLI arguments", () => {
  it("parses all supported options and normalizes scenario v1", () => {
    expect(
      parseDeepSeekLongRunArgs([
        "--provider=fixture",
        "--turns",
        "50",
        "--runs=3",
        "--pipeline",
        "baseline",
        "--scenario-version",
        "v1",
        "--report-dir",
        "tmp/custom-reports",
      ]),
    ).toEqual({
      provider: "fixture",
      turns: 50,
      runs: 3,
      pipeline: "baseline",
      scenarioVersion: "companion-long-run-v1",
      reportDir: "tmp/custom-reports",
      help: false,
    });
  });

  it("uses provider-specific safe defaults", () => {
    expect(parseDeepSeekLongRunArgs([])).toMatchObject({
      provider: "deepseek",
      turns: 30,
      runs: 1,
      pipeline: "target",
      reportDir: "docs/reports/companion-long-run",
    });
    expect(parseDeepSeekLongRunArgs(["--provider", "fixture"])).toMatchObject({
      provider: "fixture",
      turns: 100,
      pipeline: "target",
      reportDir: "tmp/companion-long-run/reports",
    });
  });

  it("accepts the standalone option separator forwarded by pnpm", () => {
    expect(
      parseDeepSeekLongRunArgs([
        "--",
        "--turns",
        "30",
        "--provider",
        "deepseek",
        "--runs",
        "2",
      ]),
    ).toMatchObject({
      provider: "deepseek",
      turns: 30,
      runs: 2,
    });
  });

  it.each([
    ["unknown provider", ["--provider", "other"]],
    ["invalid turn count", ["--turns", "31"]],
    ["zero runs", ["--runs", "0"]],
    ["fractional runs", ["--runs", "1.5"]],
    ["unknown pipeline", ["--pipeline", "shadow"]],
    ["invalid scenario", ["--scenario-version", "v0"]],
    ["missing value", ["--report-dir"]],
    ["unknown option", ["--unknown", "value"]],
    ["duplicate option", ["--runs", "1", "--runs", "2"]],
    ["duplicate option separator", ["--", "--"]],
  ])("rejects %s", (_label, argv) => {
    expect(() => parseDeepSeekLongRunArgs(argv)).toThrow(
      DeepSeekLongRunCliUsageError,
    );
  });
});

describe("DeepSeek paid gate", () => {
  it("never gates fixture mode", () => {
    expect(evaluatePaidDeepSeekGate("fixture", {})).toEqual({ ready: true });
  });

  it("requires opt-in, OpenAI-compatible config, and a non-empty key", () => {
    expect(evaluatePaidDeepSeekGate("deepseek", {})).toMatchObject({
      ready: false,
      code: "paid_opt_in_missing",
    });
    expect(
      evaluatePaidDeepSeekGate(
        "deepseek",
        { RUN_PAID_DEEPSEEK_TESTS: "true" },
        testConfig("fixture", "fixture-key"),
      ),
    ).toMatchObject({
      ready: false,
      code: "provider_not_openai_compatible",
    });
    expect(
      evaluatePaidDeepSeekGate(
        "deepseek",
        { RUN_PAID_DEEPSEEK_TESTS: "true" },
        testConfig("openai-compatible"),
      ),
    ).toMatchObject({ ready: false, code: "api_key_missing" });
    expect(
      evaluatePaidDeepSeekGate(
        "deepseek",
        { RUN_PAID_DEEPSEEK_TESTS: "true" },
        testConfig("openai-compatible", "configured-key"),
      ),
    ).toEqual({ ready: true });
  });

  it("writes real SKIPPED JSON and Markdown before config, runner, or network", async () => {
    const root = await temporaryRoot();
    const readConfigSpy = vi.fn<() => ServerConfig>();
    const runLongRuns = vi.fn();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const secret = "sk-paid-gate-secret-123456";

    const exitCode = await runDeepSeekLongRunAcceptanceCli({
      argv: [
        "--provider",
        "deepseek",
        "--turns",
        "30",
        "--runs",
        "2",
        "--pipeline",
        "target",
        "--scenario-version",
        "v1",
        "--report-dir",
        "reports",
      ],
      env: { OPENAI_COMPATIBLE_API_KEY: secret },
      workspaceRoot: root,
      now: () => FIXED_NOW,
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
      dependencies: {
        readConfig: readConfigSpy,
        runLongRuns,
      },
    });

    expect(exitCode).toBe(0);
    expect(readConfigSpy).not.toHaveBeenCalled();
    expect(runLongRuns).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stderr).toEqual([]);
    const reportDir = join(root, "reports");
    const files = await readdir(reportDir);
    expect(files.filter((name) => name.endsWith(".json"))).toHaveLength(2);
    expect(files.filter((name) => name.endsWith(".md"))).toHaveLength(2);
    for (const name of files.filter((item) => item.endsWith(".json"))) {
      const text = await readFile(join(reportDir, name), "utf8");
      const report = JSON.parse(text) as CompanionLongRunReport;
      expect(report).toMatchObject({
        status: "SKIPPED",
        providerMode: "deepseek",
        requestedTurnCount: 30,
        logicalTurnCount: 0,
        httpExchangeCount: 0,
        failure: { code: "paid_opt_in_missing", stage: "preflight" },
      });
      expect(text).not.toContain(secret);
      expect(text).not.toContain(root);
    }
    expect(stdout.join("\n")).not.toContain(secret);
    expect(stdout.join("\n")).not.toContain(root);
  });

  it.each([
    {
      label: "provider mismatch",
      config: testConfig("fixture", "fixture-key"),
      code: "provider_not_openai_compatible",
    },
    {
      label: "missing API key",
      config: testConfig("openai-compatible"),
      code: "api_key_missing",
    },
  ])("skips $label before invoking the runner", async ({ config, code }) => {
    const root = await temporaryRoot();
    const runLongRuns = vi.fn();
    const exitCode = await runDeepSeekLongRunAcceptanceCli({
      argv: ["--provider", "deepseek", "--report-dir", "reports"],
      env: { RUN_PAID_DEEPSEEK_TESTS: "true" },
      workspaceRoot: root,
      now: () => FIXED_NOW,
      stdout: () => undefined,
      stderr: () => undefined,
      dependencies: {
        readConfig: () => config,
        runLongRuns,
      },
    });

    expect(exitCode).toBe(0);
    expect(runLongRuns).not.toHaveBeenCalled();
    const jsonName = (await readdir(join(root, "reports"))).find((name) =>
      name.endsWith(".json"),
    );
    expect(jsonName).toBeDefined();
    const report = JSON.parse(
      await readFile(join(root, "reports", jsonName!), "utf8"),
    ) as CompanionLongRunReport;
    expect(report.status).toBe("SKIPPED");
    expect(report.failure?.code).toBe(code);
  });
});

describe("long-run orchestration", () => {
  it("passes parsed options and writes every checkpoint plus the final report", async () => {
    const root = await temporaryRoot();
    const config = testConfig("openai-compatible", "paid-test-key");
    const partial = execution("run-one", "PARTIAL", 10);
    const complete = execution("run-one", "PASS", 30);
    const toReportInput = vi.fn(
      (
        value: CompanionLongRunExecution,
        partialSequence?: number,
      ): BuildCompanionLongRunReportInput =>
        reportInput(value, partialSequence),
    );
    const buildReport = vi.fn(() => reportStub());
    const writeReport = vi.fn(
      (
        _report: CompanionLongRunReport,
        options: { partialSequence?: number },
      ) =>
        Promise.resolve({
          jsonPath: join(root, "reports", "run-one.json"),
          markdownPath: join(root, "reports", "run-one.md"),
          ...(options.partialSequence === undefined
            ? {}
            : { partialSequence: options.partialSequence }),
        }),
    );
    const runLongRuns = vi.fn(
      async (options: {
        onCheckpoint?: (value: CompanionLongRunExecution) => Promise<void>;
      }) => {
        await options.onCheckpoint?.(partial);
        return [complete];
      },
    );

    const exitCode = await runDeepSeekLongRunAcceptanceCli({
      argv: [
        "--provider",
        "deepseek",
        "--turns",
        "30",
        "--runs",
        "1",
        "--pipeline",
        "target",
        "--scenario-version",
        "v1",
        "--report-dir",
        "reports",
      ],
      env: { RUN_PAID_DEEPSEEK_TESTS: "true" },
      workspaceRoot: root,
      now: () => FIXED_NOW,
      stdout: () => undefined,
      stderr: () => undefined,
      dependencies: {
        readConfig: () => config,
        runLongRuns,
        toReportInput,
        buildReport,
        writeReport,
      },
    });

    expect(exitCode).toBe(0);
    expect(runLongRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deepseek",
        turns: 30,
        runs: 1,
        pipeline: "target",
        scenarioVersion: "companion-long-run-v1",
        reportDir: join(root, "reports"),
        config,
      }),
    );
    expect(toReportInput).toHaveBeenNthCalledWith(1, partial, 1);
    expect(toReportInput).toHaveBeenNthCalledWith(2, complete, undefined);
    expect(writeReport).toHaveBeenCalledTimes(2);
    expect(writeReport.mock.calls[0]?.[1]).toMatchObject({
      partialSequence: 1,
    });
    expect(writeReport.mock.calls[1]?.[1]).not.toHaveProperty(
      "partialSequence",
    );
  });

  it("returns exit code 1 when a completed execution fails", async () => {
    const root = await temporaryRoot();
    const failed = execution("run-failed", "FAIL", 30);
    const exitCode = await runDeepSeekLongRunAcceptanceCli({
      argv: ["--provider", "fixture", "--report-dir", "reports"],
      env: {},
      workspaceRoot: root,
      now: () => FIXED_NOW,
      stdout: () => undefined,
      stderr: () => undefined,
      dependencies: {
        readConfig: () => testConfig("fixture"),
        runLongRuns: () => Promise.resolve([failed]),
        toReportInput: (value, sequence) => reportInput(value, sequence),
        buildReport: () => reportStub(),
        writeReport: () =>
          Promise.resolve({
            jsonPath: join(root, "reports", "failed.json"),
            markdownPath: join(root, "reports", "failed.md"),
          }),
      },
    });

    expect(exitCode).toBe(1);
  });

  it("writes a release aggregate report after a passing DeepSeek 30x3 matrix", async () => {
    const root = await temporaryRoot();
    const config = testConfig("openai-compatible", "paid-test-key");
    config.llm.model = DEEPSEEK_30_TURN_RELEASE_BASELINE.model;
    const executions = [
      releaseExecution("release-1", 1, "strict"),
      releaseExecution("release-2", 2, "strict"),
      releaseExecution("release-3", 3, "safe_fallback"),
    ];
    const reportInputs: BuildCompanionLongRunReportInput[] = [];
    const buildReport = vi.fn((value: BuildCompanionLongRunReportInput) => {
      reportInputs.push(value);
      return value.scenarioVersion.endsWith("-release-matrix")
        ? buildCompanionLongRunReport(value)
        : { ...reportStub(), runId: value.runId };
    });
    const writeReport = vi.fn(
      (
        report: CompanionLongRunReport,
        options: CompanionLongRunReportWriteOptions,
      ) =>
        report.runId.includes("release-matrix")
          ? writeCompanionLongRunReport(report, options)
          : Promise.resolve({
              jsonPath: join(root, "reports", `${report.runId}.json`),
              markdownPath: join(root, "reports", `${report.runId}.md`),
            }),
    );

    const exitCode = await runDeepSeekLongRunAcceptanceCli({
      argv: [
        "--provider",
        "deepseek",
        "--turns",
        "30",
        "--runs",
        "3",
        "--pipeline",
        "target",
        "--report-dir",
        "reports",
      ],
      env: { RUN_PAID_DEEPSEEK_TESTS: "true" },
      workspaceRoot: root,
      now: () => FIXED_NOW,
      stdout: () => undefined,
      stderr: () => undefined,
      dependencies: {
        readConfig: () => config,
        runLongRuns: () => Promise.resolve(executions),
        toReportInput: (value, sequence) => reportInput(value, sequence),
        buildReport,
        writeReport,
      },
    });

    expect(exitCode).toBe(0);
    expect(writeReport).toHaveBeenCalledTimes(4);
    expect(reportInputs.at(-1)).toMatchObject({
      status: "PASS",
      requestedTurnCount: 90,
    });
    expect(reportInputs.at(-1)?.turns).toHaveLength(90);
    expect(reportInputs.at(-1)?.releaseMatrix?.children).toHaveLength(3);
    expect(reportInputs.at(-1)?.metrics).toMatchObject({
      releaseExpectedRuns: 3,
      releaseStrictUnderstandingRuns: 2,
      releaseSafeFallbackRuns: 1,
    });
    expect(reportInputs.at(-1)?.runAssertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RELEASE-TURN-UNDERSTANDING-2OF3",
          passed: true,
        }),
        expect.objectContaining({
          code: "RELEASE-P95-LATENCY",
          passed: true,
        }),
        expect.objectContaining({
          code: "RELEASE-PROVIDER-TOKENS",
          passed: true,
        }),
        expect.objectContaining({
          code: "RELEASE-RUN-INDEPENDENCE",
          passed: true,
        }),
        expect.objectContaining({
          code: "RELEASE-PROVENANCE",
          passed: true,
        }),
        expect.objectContaining({
          code: "RELEASE-CALL-PROVENANCE",
          passed: true,
        }),
        expect.objectContaining({
          code: "RELEASE-CHILD-ARTIFACTS",
          passed: true,
        }),
      ]),
    );
    const aggregateJsonName = (await readdir(join(root, "reports"))).find(
      (name) => name.includes("release-matrix") && name.endsWith(".json"),
    );
    expect(aggregateJsonName).toBeDefined();
    const aggregateJsonText = await readFile(
      join(root, "reports", aggregateJsonName!),
      "utf8",
    );
    const aggregateReport = JSON.parse(
      aggregateJsonText,
    ) as CompanionLongRunReport;
    expect(aggregateReport).toMatchObject({
      status: "PASS",
      requestedTurnCount: 90,
      logicalTurnCount: 90,
      llmUsageSummary: {
        calls: 61,
        successfulCalls: 60,
        failedCalls: 1,
        providerInputTokens: 305_000,
        providerOutputTokens: 30_500,
      },
      releaseMatrix: {
        expectedRuns: 3,
      },
    });
    expect(aggregateReport.releaseMatrix?.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "release-1",
          runIndex: 1,
          databaseLabel: "tmp/release-1.sqlite",
          logicalTurnCount: 30,
          llmCallCount: 20,
          p95LlmLatencyMs: 4_000,
          jsonArtifact: "reports/release-1.json",
          markdownArtifact: "reports/release-1.md",
        }),
        expect.objectContaining({
          runId: "release-3",
          llmCallCount: 21,
          providerInputTokens: 105_000,
          providerOutputTokens: 10_500,
        }),
      ]),
    );
    expect(aggregateReport.turns).toHaveLength(90);
    const aggregateMarkdownName = aggregateJsonName!.replace(/\.json$/u, ".md");
    const aggregateMarkdown = await readFile(
      join(root, "reports", aggregateMarkdownName),
      "utf8",
    );
    expect(aggregateMarkdown).toContain("## Release matrix children");
    expect(aggregateMarkdown).toContain("90 / 90 logical turns");
    expect(aggregateMarkdown).toContain("61 LLM calls");
    expect(aggregateMarkdown).toContain("reports/release-1.json");
  });
});

describe("DeepSeek 30x3 release aggregate", () => {
  it("counts deterministic resolutions, model-call success, and one safe typed fallback separately", () => {
    const aggregate = evaluateReleaseAggregate([
      releaseExecution("release-1", 1, "strict"),
      releaseExecution("release-2", 2, "strict"),
      releaseExecution("release-3", 3, "safe_fallback"),
    ]);

    expect(aggregate.passed).toBe(true);
    expect(aggregate.strictUnderstandingRuns).toBe(2);
    expect(aggregate.safeFallbackRuns).toBe(1);
    expect(aggregate.runSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "release-1",
          resolvedTurnCount: 30,
          strictResolvedTurnCount: 30,
          understandingModelCallCount: 20,
          successfulUnderstandingModelCallCount: 20,
          failedUnderstandingModelCallCount: 0,
        }),
        expect.objectContaining({
          runId: "release-3",
          resolvedTurnCount: 30,
          strictResolvedTurnCount: 29,
          safeFallbackTurnCount: 1,
          failedUnderstandingModelCallCount: 1,
        }),
      ]),
    );
  });

  it("fails closed when fewer than two runs fully resolve without fallback", () => {
    const aggregate = evaluateReleaseAggregate([
      releaseExecution("release-1", 1, "strict"),
      releaseExecution("release-2", 2, "safe_fallback"),
      releaseExecution("release-3", 3, "unsafe_fallback"),
    ]);

    expect(aggregate.passed).toBe(false);
    expect(aggregate.strictUnderstandingRuns).toBe(1);
    expect(aggregate.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RELEASE-TURN-UNDERSTANDING-2OF3",
          passed: false,
        }),
        expect.objectContaining({
          code: "RELEASE-TYPED-FALLBACK-SAFETY",
          passed: false,
        }),
      ]),
    );
  });

  it("fails latency, provider-usage, and token regression gates independently", () => {
    const slow = releaseExecution("release-slow", 1, "strict", {
      latencyMs: 8_000,
    });
    const expensive = releaseExecution("release-expensive", 2, "strict", {
      providerInputTokens: 12_000,
    });
    const noUsage = releaseExecution("release-no-usage", 3, "strict", {
      omitProviderUsage: true,
      latencyMs: 8_000,
      providerInputTokens: 12_000,
    });
    const aggregate = evaluateReleaseAggregate([slow, expensive, noUsage]);

    expect(aggregate.passed).toBe(false);
    expect(aggregate.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RELEASE-PROVIDER-USAGE",
          passed: false,
        }),
        expect.objectContaining({
          code: "RELEASE-P95-LATENCY",
          passed: false,
        }),
        expect.objectContaining({
          code: "RELEASE-PROVIDER-TOKENS",
          passed: false,
        }),
      ]),
    );
  });

  it("fails provider-usage completeness for a partially covered retry", () => {
    const partial = releaseExecution("release-partial", 1, "strict");
    const call = partial.llmCalls[0]!;
    call.attemptCount = 2;
    call.failedAttemptCount = 1;
    call.providerInputUsageAttemptCount = 1;
    call.providerOutputUsageAttemptCount = 1;
    const aggregate = evaluateReleaseAggregate([
      partial,
      releaseExecution("release-complete-2", 2, "strict"),
      releaseExecution("release-complete-3", 3, "strict"),
    ]);

    expect(aggregate.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RELEASE-PROVIDER-USAGE",
          passed: false,
        }),
      ]),
    );
  });

  it("fails closed for duplicate child execution identities", () => {
    const first = releaseExecution("release-1", 1, "strict");
    const duplicate = {
      ...releaseExecution("release-3", 3, "strict"),
      runId: first.runId,
      runIndex: first.runIndex,
      databaseLabel: first.databaseLabel,
    };
    const executions = [
      first,
      releaseExecution("release-2", 2, "strict"),
      duplicate,
    ];
    const aggregate = evaluateDeepSeek30TurnReleaseAggregate(executions, {
      childArtifacts: releaseArtifacts(executions),
    });

    expect(aggregate.passed).toBe(false);
    expect(aggregate.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RELEASE-RUN-INDEPENDENCE",
          passed: false,
        }),
      ]),
    );
  });

  it("fails closed for mixed child provenance", () => {
    const executions = [
      releaseExecution("release-1", 1, "strict"),
      releaseExecution("release-2", 2, "strict"),
      {
        ...releaseExecution("release-3", 3, "strict"),
        gitDiffFingerprint: "b".repeat(64),
      },
    ];
    const aggregate = evaluateReleaseAggregate(executions);

    expect(aggregate.passed).toBe(false);
    expect(aggregate.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RELEASE-PROVENANCE",
          passed: false,
        }),
      ]),
    );
  });

  it("fails closed when recorded calls disagree with run provenance", () => {
    const mismatched = releaseExecution("release-3", 3, "strict");
    mismatched.llmCalls = mismatched.llmCalls.map((call, index) =>
      index === 0 ? { ...call, model: "different-model" } : call,
    );
    const executions = [
      releaseExecution("release-1", 1, "strict"),
      releaseExecution("release-2", 2, "strict"),
      mismatched,
    ];
    const aggregate = evaluateReleaseAggregate(executions);

    expect(aggregate.passed).toBe(false);
    expect(aggregate.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RELEASE-CALL-PROVENANCE",
          passed: false,
        }),
        expect.objectContaining({
          code: "RELEASE-BASELINE-COMPARABILITY",
          passed: false,
        }),
      ]),
    );
  });

  it("fails closed for missing or reused child artifacts", () => {
    const executions = [
      releaseExecution("release-1", 1, "strict"),
      releaseExecution("release-2", 2, "strict"),
      releaseExecution("release-3", 3, "strict"),
    ];
    const artifacts = releaseArtifacts(executions);
    artifacts[1] = {
      ...artifacts[1]!,
      jsonArtifact: artifacts[0]!.jsonArtifact,
    };
    artifacts[2] = {
      ...artifacts[2]!,
      markdownArtifact: "../outside.md",
    };
    const aggregate = evaluateDeepSeek30TurnReleaseAggregate(executions, {
      childArtifacts: artifacts,
    });

    expect(aggregate.passed).toBe(false);
    expect(aggregate.assertions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "RELEASE-CHILD-ARTIFACTS",
          passed: false,
        }),
      ]),
    );
  });
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "chatplus-long-run-cli-"));
  temporaryRoots.push(path);
  return path;
}

function testConfig(
  provider: "fixture" | "openai-compatible",
  apiKey?: string,
): ServerConfig {
  return readConfig({
    nodeEnv: "test",
    profile: "long-run-cli-test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    turnPipelineMode: "enforced",
    personaContextMode: "enforced",
    scheduleNegotiationMode: "enforced",
    selfInitiatedPlanningMode: "enforced",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "enforced",
    llm: {
      provider,
      baseUrl:
        provider === "openai-compatible"
          ? "https://api.deepseek.com"
          : "https://fixture.invalid",
      apiKey: apiKey ?? "",
      model: provider === "openai-compatible" ? "deepseek-chat" : "fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
  });
}

function execution(
  runId: string,
  status: CompanionLongRunExecution["status"],
  logicalTurnCount: number,
): CompanionLongRunExecution {
  return {
    schemaVersion: 1,
    runId,
    runIndex: 1,
    scenarioVersion: "companion-long-run-v1",
    repoHead: "abc123",
    worktreeDirty: true,
    gitDiffStat: "1 file changed, 1 insertion(+)",
    gitDiffFingerprint: "a".repeat(64),
    untrackedFileCount: 1,
    startedAtUtc: FIXED_NOW.toISOString(),
    completedAtUtc: FIXED_NOW.toISOString(),
    status,
    completionReason:
      status === "PARTIAL" ? "interval_checkpoint" : "completed",
    providerMode: "deepseek",
    provider: "openai-compatible",
    model: "deepseek-chat",
    realNetwork: true,
    clockMode: "fake",
    pipelineExpectation: "target",
    requestedTurnCount: 30,
    logicalTurnCount,
    httpExchangeCount: 0,
    sessionCount: 0,
    restartCount: 0,
    databaseLabel: "tmp/run.sqlite",
    reportDirectoryLabel: "reports",
    turns: [],
    assertions: [],
    llmCalls: [],
    metrics: {},
    logPath: "tmp/run.log",
  };
}

type ReleaseExecutionMode = "strict" | "safe_fallback" | "unsafe_fallback";

interface ReleaseExecutionOverrides {
  latencyMs?: number;
  providerInputTokens?: number;
  omitProviderUsage?: boolean;
}

function releaseExecution(
  runId: string,
  runIndex: number,
  mode: ReleaseExecutionMode,
  overrides: ReleaseExecutionOverrides = {},
): CompanionLongRunExecution {
  const turns: CompanionLongRunExecution["turns"] = Array.from(
    { length: 30 },
    (_unused, index) => {
      const number = index + 1;
      const fallback = number === 30 && mode !== "strict";
      const deterministic = number > 20 && !fallback;
      const understandingCall = deterministic
        ? []
        : [releaseLlmCall(runId, number, !fallback, overrides)];
      return {
        sequence: number,
        number,
        phase: "release",
        objective: "release aggregate fixture",
        sessionKey: "A" as const,
        sessionId: `${runId}-session`,
        clientMessageId: `${runId}-message-${String(number)}`,
        userText: `turn ${String(number)}`,
        actionsBefore: [],
        preActionResults: [],
        expected: {
          mainGoalActivated: false,
          goalExpectation: "suppressed" as const,
          scheduleExpectation: "none" as const,
          hardAssertionCodes: ["Q0" as const],
        },
        http: [],
        actualRoute: fallback ? "conversation" : "schedule_query",
        understandingOrigin: fallback
          ? mode === "safe_fallback"
            ? "typed_fallback"
            : "model_valid"
          : deterministic
            ? "deterministic"
            : "model_valid",
        turnObservation: { route: "conversation" },
        validatedOutcome: { route: "conversation" },
        contextPlan: null,
        promptSegmentTrace: [],
        selectedEvidenceIds: [],
        retrievalRuns: [],
        assistantText: "ok",
        chunks: ["ok"],
        replyAudit: {},
        before: releaseSnapshot(),
        after: releaseSnapshot(),
        changes: {},
        domainEvents: [],
        rejectedProposals: [],
        llmCalls: understandingCall,
        assertions: [
          {
            id: `${runId}-assertion-${String(number)}`,
            code: "Q0" as const,
            scope: "turn" as const,
            turnNumber: number,
            hard: true as const,
            passed: mode !== "unsafe_fallback" || !fallback,
            description: "release fixture assertion",
            evidence: {},
          },
        ],
        soft: {
          domain: "conversation",
          domainConfidence: 1,
          mainGoalActivated: false,
          mainGoalMentioned: false,
          summaryStyleEnding: false,
          objectiveAligned: true,
        },
      };
    },
  );
  return {
    ...execution(runId, "PASS", 30),
    runIndex,
    model: DEEPSEEK_30_TURN_RELEASE_BASELINE.model,
    databaseLabel: `tmp/${runId}.sqlite`,
    logPath: `tmp/${runId}.log`,
    turns,
    llmCalls: turns.flatMap((turn) => turn.llmCalls),
    metrics: {},
  };
}

function releaseLlmCall(
  runId: string,
  turnNumber: number,
  success: boolean,
  overrides: ReleaseExecutionOverrides,
): CompanionLongRunExecution["llmCalls"][number] {
  const providerInputTokens = overrides.providerInputTokens ?? 5_000;
  return {
    id: `${runId}-understanding-${String(turnNumber)}`,
    purpose: "turn_understanding",
    provider: "openai-compatible",
    model: DEEPSEEK_30_TURN_RELEASE_BASELINE.model,
    inputTokens: providerInputTokens,
    outputTokens: 500,
    attemptCount: 1,
    failedAttemptCount: success ? 0 : 1,
    attemptTelemetrySource: "exact",
    ...(overrides.omitProviderUsage
      ? {}
      : {
          providerInputTokens,
          providerOutputTokens: 500,
          providerInputUsageAttemptCount: 1,
          providerOutputUsageAttemptCount: 1,
          usageSource: "provider",
        }),
    latencyMs: overrides.latencyMs ?? 4_000,
    success,
    ...(success ? {} : { errorCode: "INVALID_STRUCTURED_OUTPUT" }),
    createdAtUtc: FIXED_NOW.toISOString(),
  };
}

function releaseSnapshot(): CompanionLongRunExecution["turns"][number]["before"] {
  return {
    capturedAtUtc: FIXED_NOW.toISOString(),
    state: null,
    cursor: null,
    schedule: [],
    scheduleDigest: "schedule",
    scheduleCommitLineage: [],
    negotiations: [],
    memories: [],
    memoryEvidence: [],
    careCues: [],
    followUps: [],
    activityEvents: [],
    counts: {},
    durableDigest: "durable",
  };
}

function reportInput(
  value: CompanionLongRunExecution,
  partialSequence?: number,
): BuildCompanionLongRunReportInput {
  return toCompanionLongRunReportInput(value, partialSequence);
}

function releaseArtifacts(
  executions: readonly CompanionLongRunExecution[],
): Array<{
  runId: string;
  jsonArtifact: string;
  markdownArtifact: string;
}> {
  return executions.map((value) => ({
    runId: value.runId,
    jsonArtifact: `reports/${value.runId}.json`,
    markdownArtifact: `reports/${value.runId}.md`,
  }));
}

function evaluateReleaseAggregate(
  executions: readonly CompanionLongRunExecution[],
) {
  return evaluateDeepSeek30TurnReleaseAggregate(executions, {
    childArtifacts: releaseArtifacts(executions),
  });
}

function reportStub(): CompanionLongRunReport {
  return {
    schemaVersion: 1,
    runId: "stub",
    scenarioVersion: "companion-long-run-v1",
    repoHead: "abc123",
    worktreeDirty: true,
    gitDiffStat: "1 file changed, 1 insertion(+)",
    gitDiffFingerprint: "a".repeat(64),
    untrackedFileCount: 1,
    startedAtUtc: FIXED_NOW.toISOString(),
    completedAtUtc: FIXED_NOW.toISOString(),
    status: "PASS",
    provider: "fixture",
    providerMode: "fixture",
    model: "fixture-v1",
    clockMode: "fake",
    pipelineExpectation: "target",
    requestedTurnCount: 0,
    logicalTurnCount: 0,
    httpExchangeCount: 0,
    sessionCount: 0,
    restartCount: 0,
    assertions: [],
    assertionSummary: { total: 0, passed: 0, failed: 0, hardFailed: 0 },
    metrics: {},
    metricDetails: [],
    phases: [],
    turns: [],
    runLlmCalls: [],
    llmUsage: [],
    llmUsageSummary: {
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
    },
    artifacts: { json: "stub.json", markdown: "stub.md" },
  };
}
