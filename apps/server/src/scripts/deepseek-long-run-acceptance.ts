import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { readConfig, type ServerConfig } from "../config.js";
import type {
  LongRunProviderMode,
  PipelineExpectation,
} from "../scenarios/companion-long-run-types.js";
import {
  buildCompanionLongRunReport,
  writeCompanionLongRunReport,
  type BuildCompanionLongRunReportInput,
  type CompanionLongRunReport,
  type CompanionLongRunReportWriteOptions,
  type CompanionLongRunReportWriteResult,
  type LongRunAssertionResult,
  type LongRunReleaseMatrixChildReport,
  type LongRunMetricResult,
  type LongRunMetricValue,
} from "./companion-long-run-report.js";
import {
  runCompanionLongRuns,
  type CompanionLongRunExecution,
  type CompanionLongRunOptions,
} from "./companion-long-run-runner.js";
import { toCompanionLongRunReportInput } from "./companion-long-run-report-adapter.js";
import { assertDeepSeekAcceptanceConfig } from "./deepseek-acceptance-flow.js";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const DEFAULT_FIXTURE_REPORT_DIR = "tmp/companion-long-run/reports";
const DEFAULT_DEEPSEEK_REPORT_DIR = "docs/reports/companion-long-run";

/**
 * Provider-actual baseline from the remediation plan's frozen 30-turn run.
 * Failed calls without provider usage account for the difference between the
 * provider-actual input total here and the report's 176,545 effective total.
 */
export const DEEPSEEK_30_TURN_RELEASE_BASELINE = {
  runId: "companion-long-run-deepseek-30t-r1-2026-08-23T10-45-41Z-cb26f864",
  model: "deepseek-v4-flash",
  p95LlmLatencyMs: 4_590,
  providerInputTokens: 175_493,
  providerOutputTokens: 18_779,
} as const;

/**
 * Operational definition of the plan's "significant" regression language.
 * Matrix medians absorb one network outlier; provider input is checked at the
 * per-run maximum because duplicated prompt segments should be deterministic.
 */
export const DEEPSEEK_30_TURN_RELEASE_THRESHOLDS = {
  p95LatencyRegressionRatio: 1.25,
  providerTokenRegressionRatio: 1.1,
} as const;

export const DEEPSEEK_LONG_RUN_USAGE = [
  "Usage: tsx deepseek-long-run-acceptance.ts [options]",
  "",
  "Options:",
  "  --provider fixture|deepseek",
  "  --turns 20|30|50|100",
  "  --runs <positive integer>",
  "  --pipeline baseline|target",
  "  --scenario-version v1",
  "  --report-dir <workspace child path>",
  "  --help",
  "",
].join("\n");

export type CompanionLongRunTurnCount = 20 | 30 | 50 | 100;

export interface DeepSeekLongRunCliOptions {
  provider: LongRunProviderMode;
  turns: CompanionLongRunTurnCount;
  runs: number;
  pipeline: PipelineExpectation;
  scenarioVersion: string;
  reportDir: string;
  help: boolean;
}

export class DeepSeekLongRunCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeepSeekLongRunCliUsageError";
  }
}

export interface PaidDeepSeekGateResult {
  ready: boolean;
  code?:
    | "paid_opt_in_missing"
    | "provider_not_openai_compatible"
    | "api_key_missing";
  message?: string;
}

export type DeepSeek30TurnReleaseRunSummary = LongRunReleaseMatrixChildReport;

export interface DeepSeekReleaseChildArtifact {
  runId: string;
  jsonArtifact: string;
  markdownArtifact: string;
}

export interface DeepSeek30TurnReleaseAggregate {
  passed: boolean;
  expectedRuns: number;
  strictUnderstandingRuns: number;
  safeFallbackRuns: number;
  runSummaries: DeepSeek30TurnReleaseRunSummary[];
  assertions: LongRunAssertionResult[];
  metrics: Readonly<Record<string, LongRunMetricValue>>;
  metricDetails: LongRunMetricResult[];
}

export interface DeepSeek30TurnReleaseBaseline {
  runId: string;
  model: string;
  p95LlmLatencyMs: number;
  providerInputTokens: number;
  providerOutputTokens: number;
}

export interface DeepSeek30TurnReleaseThresholds {
  p95LatencyRegressionRatio: number;
  providerTokenRegressionRatio: number;
}

export interface EvaluateDeepSeek30TurnReleaseAggregateOptions {
  expectedRuns?: number;
  baseline?: DeepSeek30TurnReleaseBaseline;
  thresholds?: DeepSeek30TurnReleaseThresholds;
  childArtifacts?: readonly DeepSeekReleaseChildArtifact[];
}

interface DeepSeekLongRunCliDependencies {
  readConfig: () => ServerConfig;
  assertDeepSeekConfig: (config: ServerConfig) => void;
  runLongRuns: (
    options: CompanionLongRunOptions,
  ) => Promise<CompanionLongRunExecution[]>;
  toReportInput: (
    execution: CompanionLongRunExecution,
    partialSequence?: number,
  ) => BuildCompanionLongRunReportInput;
  buildReport: (
    input: BuildCompanionLongRunReportInput,
  ) => CompanionLongRunReport;
  writeReport: (
    report: CompanionLongRunReport,
    options: CompanionLongRunReportWriteOptions,
  ) => Promise<CompanionLongRunReportWriteResult>;
}

export interface RunDeepSeekLongRunCliInput {
  argv?: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  workspaceRoot?: string;
  now?: () => Date;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  dependencies?: Partial<DeepSeekLongRunCliDependencies>;
}

const defaultDependencies: DeepSeekLongRunCliDependencies = {
  readConfig,
  assertDeepSeekConfig: assertDeepSeekAcceptanceConfig,
  runLongRuns: runCompanionLongRuns,
  toReportInput: toCompanionLongRunReportInput,
  buildReport: buildCompanionLongRunReport,
  writeReport: writeCompanionLongRunReport,
};

export function parseDeepSeekLongRunArgs(
  argv: readonly string[],
): DeepSeekLongRunCliOptions {
  const values = new Map<string, string>();
  let help = false;
  let packageManagerSeparatorSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") {
      if (packageManagerSeparatorSeen) {
        throw new DeepSeekLongRunCliUsageError(
          "The package-manager option separator may only be supplied once.",
        );
      }
      packageManagerSeparatorSeen = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (!argument.startsWith("--")) {
      throw new DeepSeekLongRunCliUsageError("Unexpected positional argument.");
    }
    const equalsIndex = argument.indexOf("=");
    const name =
      equalsIndex < 0 ? argument.slice(2) : argument.slice(2, equalsIndex);
    const inlineValue =
      equalsIndex < 0 ? undefined : argument.slice(equalsIndex + 1);
    if (!CLI_OPTION_NAMES.has(name)) {
      throw new DeepSeekLongRunCliUsageError("Unknown option.");
    }
    if (values.has(name)) {
      throw new DeepSeekLongRunCliUsageError(
        `Option --${name} may only be supplied once.`,
      );
    }
    const nextValue = inlineValue ?? argv[index + 1];
    if (
      nextValue === undefined ||
      nextValue.trim() === "" ||
      (inlineValue === undefined && nextValue.startsWith("--"))
    ) {
      throw new DeepSeekLongRunCliUsageError(
        `Option --${name} requires a value.`,
      );
    }
    values.set(name, nextValue);
    if (inlineValue === undefined) index += 1;
  }

  const provider = enumValue("provider", values.get("provider") ?? "deepseek", [
    "fixture",
    "deepseek",
  ] as const);
  const defaultTurns = provider === "fixture" ? 100 : 30;
  const turns = integerValue(
    "turns",
    values.get("turns") ?? String(defaultTurns),
  );
  if (turns !== 20 && turns !== 30 && turns !== 50 && turns !== 100) {
    throw new DeepSeekLongRunCliUsageError(
      "Option --turns must be 20, 30, 50, or 100.",
    );
  }
  const runs = integerValue("runs", values.get("runs") ?? "1");
  if (runs < 1) {
    throw new DeepSeekLongRunCliUsageError(
      "Option --runs must be a positive integer.",
    );
  }
  const pipeline = enumValue("pipeline", values.get("pipeline") ?? "target", [
    "baseline",
    "target",
  ] as const);
  const scenarioVersion = normalizeScenarioVersion(
    values.get("scenario-version") ?? "v1",
  );
  const reportDir =
    values.get("report-dir") ??
    (provider === "fixture"
      ? DEFAULT_FIXTURE_REPORT_DIR
      : DEFAULT_DEEPSEEK_REPORT_DIR);
  return {
    provider,
    turns,
    runs,
    pipeline,
    scenarioVersion,
    reportDir,
    help,
  };
}

export function evaluatePaidDeepSeekGate(
  provider: LongRunProviderMode,
  env: Readonly<Record<string, string | undefined>>,
  config?: ServerConfig,
): PaidDeepSeekGateResult {
  if (provider !== "deepseek") return { ready: true };
  if (env["RUN_PAID_DEEPSEEK_TESTS"]?.trim() !== "true") {
    return {
      ready: false,
      code: "paid_opt_in_missing",
      message: "Paid DeepSeek long-run opt-in is missing.",
    };
  }
  if (config?.llm.provider !== "openai-compatible") {
    return {
      ready: false,
      code: "provider_not_openai_compatible",
      message: "The configured provider is not OpenAI-compatible.",
    };
  }
  if (config.llm.apiKey === undefined || config.llm.apiKey.trim() === "") {
    return {
      ready: false,
      code: "api_key_missing",
      message: "The DeepSeek API credential is missing.",
    };
  }
  return { ready: true };
}

export function evaluateDeepSeek30TurnReleaseAggregate(
  executions: readonly CompanionLongRunExecution[],
  options: EvaluateDeepSeek30TurnReleaseAggregateOptions = {},
): DeepSeek30TurnReleaseAggregate {
  const expectedRuns = options.expectedRuns ?? 3;
  const baseline = options.baseline ?? DEEPSEEK_30_TURN_RELEASE_BASELINE;
  const thresholds = options.thresholds ?? DEEPSEEK_30_TURN_RELEASE_THRESHOLDS;
  const childArtifacts = options.childArtifacts ?? [];
  const artifactByRunId = new Map(
    childArtifacts.map((artifact) => [artifact.runId, artifact]),
  );
  const requiredStrictRuns = Math.ceil((expectedRuns * 2) / 3);
  const runSummaries = [...executions]
    .sort((left, right) => left.runIndex - right.runIndex)
    .map((execution) =>
      summarizeReleaseRun(
        execution,
        baseline.model,
        artifactByRunId.get(execution.runId),
      ),
    );
  const runIdentityGatePassed =
    executions.length === expectedRuns &&
    uniqueNonEmptyCount(executions.map((execution) => execution.runId)) ===
      expectedRuns &&
    new Set(executions.map((execution) => execution.runIndex)).size ===
      expectedRuns &&
    uniqueNonEmptyCount(
      executions.map(
        (execution) =>
          canonicalReleaseArtifactLabel(execution.databaseLabel) ?? "",
      ),
    ) === expectedRuns;
  const canonicalChildArtifactLabels = childArtifacts.flatMap((artifact) => [
    canonicalReleaseArtifactLabel(artifact.jsonArtifact) ?? "",
    canonicalReleaseArtifactLabel(artifact.markdownArtifact) ?? "",
  ]);
  const childArtifactGatePassed =
    childArtifacts.length === expectedRuns &&
    uniqueNonEmptyCount(childArtifacts.map((artifact) => artifact.runId)) ===
      expectedRuns &&
    uniqueNonEmptyCount(
      childArtifacts.map(
        (artifact) =>
          canonicalReleaseArtifactLabel(artifact.jsonArtifact) ?? "",
      ),
    ) === expectedRuns &&
    uniqueNonEmptyCount(
      childArtifacts.map(
        (artifact) =>
          canonicalReleaseArtifactLabel(artifact.markdownArtifact) ?? "",
      ),
    ) === expectedRuns &&
    uniqueNonEmptyCount(canonicalChildArtifactLabels) === expectedRuns * 2 &&
    childArtifacts.every(
      (artifact) =>
        isSafeReleaseArtifactLabel(artifact.jsonArtifact) &&
        isSafeReleaseArtifactLabel(artifact.markdownArtifact) &&
        executions.filter((execution) => execution.runId === artifact.runId)
          .length === 1,
    ) &&
    executions.every(
      (execution) =>
        childArtifacts.filter((artifact) => artifact.runId === execution.runId)
          .length === 1,
    );
  const provenanceGatePassed = [
    executions.map((execution) => execution.repoHead),
    executions.map((execution) => execution.gitDiffFingerprint ?? ""),
    executions.map((execution) => execution.scenarioVersion),
    executions.map((execution) => execution.provider),
    executions.map((execution) => execution.model),
  ].every(
    (values) =>
      values.length === expectedRuns && uniqueNonEmptyCount(values) === 1,
  );
  const callProvenanceGatePassed =
    executions.length === expectedRuns &&
    executions.every(
      (execution) =>
        execution.llmCalls.length > 0 &&
        execution.llmCalls.every(
          (call) =>
            call.provider === execution.provider &&
            call.model === execution.model,
        ),
    );
  const strictUnderstandingRuns = runSummaries.filter(
    (run) => run.strictResolvedTurnCount === 30 && run.completeAndPassing,
  ).length;
  const safeFallbackRuns = runSummaries.filter(
    (run) =>
      run.safeFallbackTurnCount > 0 &&
      run.resolvedTurnCount === 30 &&
      run.unsafeUnderstandingFailureCount === 0 &&
      run.completeAndPassing,
  ).length;
  const allRunsCompleteAndPassing =
    runSummaries.length === expectedRuns &&
    runSummaries.every((run) => run.completeAndPassing);
  const allUnderstandingFailuresSafelyHandled = runSummaries.every(
    (run) =>
      run.resolvedTurnCount === 30 && run.unsafeUnderstandingFailureCount === 0,
  );
  const allModelsComparable = runSummaries.every((run) => run.modelComparable);
  const providerUsageComplete =
    runSummaries.length === expectedRuns &&
    runSummaries.every((run) => run.providerUsageComplete);
  const p95Values = runSummaries.map((run) => run.p95LlmLatencyMs);
  const providerInputValues = runSummaries.map(
    (run) => run.providerInputTokens,
  );
  const providerTotalValues = runSummaries.map(
    (run) => run.providerInputTokens + run.providerOutputTokens,
  );
  const medianP95LlmLatencyMs = median(p95Values);
  const maximumP95LlmLatencyMs = maximum(p95Values);
  const maximumProviderInputTokens = maximum(providerInputValues);
  const medianProviderInputTokens = median(providerInputValues);
  const medianProviderTotalTokens = median(providerTotalValues);
  const maximumProviderTotalTokens = maximum(providerTotalValues);
  const baselineProviderTotalTokens =
    baseline.providerInputTokens + baseline.providerOutputTokens;
  const maximumAllowedMedianP95LlmLatencyMs = Math.ceil(
    baseline.p95LlmLatencyMs * thresholds.p95LatencyRegressionRatio,
  );
  const maximumAllowedProviderInputTokens = Math.ceil(
    baseline.providerInputTokens * thresholds.providerTokenRegressionRatio,
  );
  const maximumAllowedMedianProviderTotalTokens = Math.ceil(
    baselineProviderTotalTokens * thresholds.providerTokenRegressionRatio,
  );
  const latencyGatePassed =
    allModelsComparable &&
    p95Values.length === expectedRuns &&
    p95Values.every((value) => Number.isFinite(value) && value > 0) &&
    medianP95LlmLatencyMs <= maximumAllowedMedianP95LlmLatencyMs;
  const tokenGatePassed =
    allModelsComparable &&
    providerUsageComplete &&
    maximumProviderInputTokens <= maximumAllowedProviderInputTokens &&
    medianProviderTotalTokens <= maximumAllowedMedianProviderTotalTokens;
  const assertions: LongRunAssertionResult[] = [
    releaseAssertion(
      "RELEASE-RUN-COUNT",
      executions.length === expectedRuns,
      "Release matrix returned every requested independent run.",
      expectedRuns,
      executions.length,
    ),
    releaseAssertion(
      "RELEASE-RUN-INDEPENDENCE",
      runIdentityGatePassed,
      "Every release child has a unique run ID, run index, and database label.",
      true,
      runIdentityGatePassed,
    ),
    releaseAssertion(
      "RELEASE-CHILD-ARTIFACTS",
      childArtifactGatePassed,
      "Every release child has one unique, safe JSON and Markdown report artifact.",
      true,
      childArtifactGatePassed,
    ),
    releaseAssertion(
      "RELEASE-PROVENANCE",
      provenanceGatePassed,
      "Every release child shares repository head, diff fingerprint, scenario, provider, and model provenance.",
      true,
      provenanceGatePassed,
    ),
    releaseAssertion(
      "RELEASE-CALL-PROVENANCE",
      callProvenanceGatePassed,
      "Every recorded LLM call matches its child run provider and model provenance.",
      true,
      callProvenanceGatePassed,
    ),
    releaseAssertion(
      "RELEASE-RUN-STATUS",
      allRunsCompleteAndPassing,
      "Every release run completed 30 turns and passed its per-run gates.",
      expectedRuns,
      runSummaries.filter((run) => run.completeAndPassing).length,
    ),
    releaseAssertion(
      "RELEASE-TURN-UNDERSTANDING-2OF3",
      strictUnderstandingRuns >= requiredStrictRuns,
      "At least two thirds of runs resolved all 30 turns without a provider understanding failure.",
      requiredStrictRuns,
      strictUnderstandingRuns,
    ),
    releaseAssertion(
      "RELEASE-TYPED-FALLBACK-SAFETY",
      allUnderstandingFailuresSafelyHandled,
      "Every failed understanding call used typed fallback/fallback and still passed the turn's hard assertions.",
      0,
      runSummaries.reduce(
        (count, run) => count + run.unsafeUnderstandingFailureCount,
        0,
      ),
    ),
    releaseAssertion(
      "RELEASE-BASELINE-COMPARABILITY",
      allModelsComparable,
      "Every release run used the model captured by the remediation baseline.",
      baseline.model,
      [...new Set(executions.map((execution) => execution.model))].join(","),
    ),
    releaseAssertion(
      "RELEASE-PROVIDER-USAGE",
      providerUsageComplete,
      "Every successful provider call exposed provider-actual token usage.",
      expectedRuns,
      runSummaries.filter((run) => run.providerUsageComplete).length,
    ),
    releaseAssertion(
      "RELEASE-P95-LATENCY",
      latencyGatePassed,
      "The matrix median of per-run LLM P95 latency stayed within 25% of baseline.",
      maximumAllowedMedianP95LlmLatencyMs,
      medianP95LlmLatencyMs,
    ),
    releaseAssertion(
      "RELEASE-PROVIDER-TOKENS",
      tokenGatePassed,
      "Provider input maximum and provider total median stayed within 10% of baseline.",
      maximumAllowedMedianProviderTotalTokens,
      medianProviderTotalTokens,
    ),
    ...runSummaries.map((run, index) =>
      releaseRunUnderstandingAssertion(run, index + 1),
    ),
  ];
  const metrics: Readonly<Record<string, LongRunMetricValue>> = {
    releaseBaselineRunId: baseline.runId,
    releaseExpectedRuns: expectedRuns,
    releaseObservedRuns: runSummaries.length,
    releaseRunIdentityGatePassed: runIdentityGatePassed,
    releaseChildArtifactGatePassed: childArtifactGatePassed,
    releaseProvenanceGatePassed: provenanceGatePassed,
    releaseCallProvenanceGatePassed: callProvenanceGatePassed,
    releaseRequestedTurns: runSummaries.reduce(
      (count, run) => count + run.requestedTurnCount,
      0,
    ),
    releaseLogicalTurns: runSummaries.reduce(
      (count, run) => count + run.logicalTurnCount,
      0,
    ),
    releaseLlmCalls: runSummaries.reduce(
      (count, run) => count + run.llmCallCount,
      0,
    ),
    releaseProviderInputTokens: runSummaries.reduce(
      (count, run) => count + run.providerInputTokens,
      0,
    ),
    releaseProviderOutputTokens: runSummaries.reduce(
      (count, run) => count + run.providerOutputTokens,
      0,
    ),
    releaseRequiredStrictUnderstandingRuns: requiredStrictRuns,
    releaseStrictUnderstandingRuns: strictUnderstandingRuns,
    releaseSafeFallbackRuns: safeFallbackRuns,
    releaseUnderstandingModelCalls: runSummaries.reduce(
      (count, run) => count + run.understandingModelCallCount,
      0,
    ),
    releaseSuccessfulUnderstandingModelCalls: runSummaries.reduce(
      (count, run) => count + run.successfulUnderstandingModelCallCount,
      0,
    ),
    releaseFailedUnderstandingModelCalls: runSummaries.reduce(
      (count, run) => count + run.failedUnderstandingModelCallCount,
      0,
    ),
    releaseBaselineP95LlmLatencyMs: baseline.p95LlmLatencyMs,
    releaseMedianP95LlmLatencyMs: medianP95LlmLatencyMs,
    releaseMaximumP95LlmLatencyMs: maximumP95LlmLatencyMs,
    releaseMaximumAllowedMedianP95LlmLatencyMs:
      maximumAllowedMedianP95LlmLatencyMs,
    releaseP95LatencyDeltaRatio: ratioAgainstBaseline(
      medianP95LlmLatencyMs,
      baseline.p95LlmLatencyMs,
    ),
    releaseBaselineProviderInputTokens: baseline.providerInputTokens,
    releaseMedianProviderInputTokens: medianProviderInputTokens,
    releaseMaximumProviderInputTokens: maximumProviderInputTokens,
    releaseMaximumAllowedProviderInputTokens: maximumAllowedProviderInputTokens,
    releaseProviderInputTokenDeltaRatio: ratioAgainstBaseline(
      maximumProviderInputTokens,
      baseline.providerInputTokens,
    ),
    releaseBaselineProviderOutputTokens: baseline.providerOutputTokens,
    releaseBaselineProviderTotalTokens: baselineProviderTotalTokens,
    releaseMedianProviderTotalTokens: medianProviderTotalTokens,
    releaseMaximumProviderTotalTokens: maximumProviderTotalTokens,
    releaseMaximumAllowedMedianProviderTotalTokens:
      maximumAllowedMedianProviderTotalTokens,
    releaseProviderTotalTokenDeltaRatio: ratioAgainstBaseline(
      medianProviderTotalTokens,
      baselineProviderTotalTokens,
    ),
  };
  const metricDetails: LongRunMetricResult[] = [
    {
      name: "releaseStrictUnderstandingRuns",
      value: strictUnderstandingRuns,
      passed: strictUnderstandingRuns >= requiredStrictRuns,
      comparator: ">=",
      threshold: requiredStrictRuns,
      numerator: strictUnderstandingRuns,
      denominator: expectedRuns,
      source: "release_matrix",
    },
    {
      name: "releaseMedianP95LlmLatencyMs",
      value: medianP95LlmLatencyMs,
      unit: "ms",
      passed: latencyGatePassed,
      comparator: "<=",
      threshold: maximumAllowedMedianP95LlmLatencyMs,
      source: baseline.runId,
    },
    {
      name: "releaseMaximumProviderInputTokens",
      value: maximumProviderInputTokens,
      unit: "tokens",
      passed: tokenGatePassed,
      comparator: "<=",
      threshold: maximumAllowedProviderInputTokens,
      source: baseline.runId,
    },
    {
      name: "releaseMedianProviderTotalTokens",
      value: medianProviderTotalTokens,
      unit: "tokens",
      passed: tokenGatePassed,
      comparator: "<=",
      threshold: maximumAllowedMedianProviderTotalTokens,
      source: baseline.runId,
    },
  ];
  return {
    passed: assertions.every((assertion) => assertion.passed),
    expectedRuns,
    strictUnderstandingRuns,
    safeFallbackRuns,
    runSummaries,
    assertions,
    metrics,
    metricDetails,
  };
}

export async function runDeepSeekLongRunAcceptanceCli(
  input: RunDeepSeekLongRunCliInput = {},
): Promise<number> {
  const stdout = input.stdout ?? ((value) => process.stdout.write(value));
  const stderr = input.stderr ?? ((value) => process.stderr.write(value));
  const env = input.env ?? process.env;
  const now = input.now ?? (() => new Date());
  const root = resolve(input.workspaceRoot ?? workspaceRoot);
  const dependencies = {
    ...defaultDependencies,
    ...input.dependencies,
  };
  let options: DeepSeekLongRunCliOptions;
  try {
    options = parseDeepSeekLongRunArgs(input.argv ?? process.argv.slice(2));
    if (options.help) {
      stdout(DEEPSEEK_LONG_RUN_USAGE);
      return 0;
    }
  } catch (error) {
    stderr(
      `Invalid companion long-run arguments: ${safeErrorName(error)}.\n${DEEPSEEK_LONG_RUN_USAGE}`,
    );
    return 1;
  }

  let reportDir: string;
  try {
    reportDir = workspaceChildPath(root, options.reportDir, "--report-dir");
  } catch (error) {
    stderr(
      `Invalid companion long-run report directory: ${safeErrorName(error)}.\n`,
    );
    return 1;
  }

  if (
    options.provider === "deepseek" &&
    env["RUN_PAID_DEEPSEEK_TESTS"]?.trim() !== "true"
  ) {
    const preliminaryGate = evaluatePaidDeepSeekGate(options.provider, env);
    return writeSkippedRuns({
      options,
      reportDir,
      workspaceRoot: root,
      now,
      stdout,
      stderr,
      dependencies,
      gate: preliminaryGate,
      secrets: [env["OPENAI_COMPATIBLE_API_KEY"] ?? env["LLM_API_KEY"] ?? ""],
    });
  }

  let config: ServerConfig;
  try {
    config = dependencies.readConfig();
  } catch {
    stderr("Companion long-run configuration could not be read.\n");
    return 1;
  }
  const configuredGate = evaluatePaidDeepSeekGate(
    options.provider,
    env,
    config,
  );
  if (!configuredGate.ready) {
    return writeSkippedRuns({
      options,
      reportDir,
      workspaceRoot: root,
      now,
      stdout,
      stderr,
      dependencies,
      gate: configuredGate,
      config,
      secrets: [config.llm.apiKey ?? ""],
    });
  }
  if (options.provider === "deepseek") {
    try {
      dependencies.assertDeepSeekConfig(config);
    } catch {
      return writeSyntheticRuns({
        options,
        reportDir,
        workspaceRoot: root,
        now,
        stdout,
        stderr,
        dependencies,
        status: "FAIL",
        code: "invalid_deepseek_configuration",
        message: "DeepSeek long-run provider configuration is invalid.",
        config,
        secrets: [config.llm.apiKey ?? ""],
      });
    }
  }

  const partialSequences = new Map<string, number>();
  const secrets = [config.llm.apiKey ?? ""];
  try {
    const executions = await dependencies.runLongRuns({
      provider: options.provider,
      turns: options.turns,
      runs: options.runs,
      pipeline: options.pipeline,
      scenarioVersion: options.scenarioVersion,
      reportDir,
      config,
      now: now(),
      onCheckpoint: async (execution) => {
        const partialSequence =
          (partialSequences.get(execution.runId) ?? 0) + 1;
        partialSequences.set(execution.runId, partialSequence);
        await writeExecutionReport({
          execution,
          partialSequence,
          reportDir,
          workspaceRoot: root,
          secrets,
          dependencies,
        });
      },
    });
    let failed = false;
    const childArtifacts: DeepSeekReleaseChildArtifact[] = [];
    for (const execution of executions) {
      const written = await writeExecutionReport({
        execution,
        reportDir,
        workspaceRoot: root,
        secrets,
        dependencies,
      });
      childArtifacts.push({
        runId: execution.runId,
        jsonArtifact: safeArtifactLabel(root, written.jsonPath),
        markdownArtifact: safeArtifactLabel(root, written.markdownPath),
      });
      stdout(
        `${execution.runId}: ${execution.status}; report ${safeArtifactLabel(root, written.jsonPath)}.\n`,
      );
      if (execution.status === "FAIL" || execution.status === "PARTIAL") {
        failed = true;
      }
    }
    if (isDeepSeek30TurnReleaseMatrix(options)) {
      const aggregate = evaluateDeepSeek30TurnReleaseAggregate(executions, {
        expectedRuns: options.runs,
        childArtifacts,
      });
      const written = await writeReleaseAggregateReport({
        executions,
        aggregate,
        reportDir,
        workspaceRoot: root,
        secrets,
        dependencies,
      });
      stdout(
        `${written.runId}: ${aggregate.passed ? "PASS" : "FAIL"}; release matrix report ${safeArtifactLabel(root, written.report.jsonPath)}.\n`,
      );
      if (!aggregate.passed) failed = true;
    }
    return failed ? 1 : 0;
  } catch {
    return writeSyntheticRuns({
      options,
      reportDir,
      workspaceRoot: root,
      now,
      stdout,
      stderr,
      dependencies,
      status: "FAIL",
      code: "long_run_failed_before_report",
      message:
        "Companion long-run execution failed before final reports were available.",
      config,
      secrets,
    });
  }
}

function summarizeReleaseRun(
  execution: CompanionLongRunExecution,
  baselineModel: string,
  artifact: DeepSeekReleaseChildArtifact | undefined,
): DeepSeek30TurnReleaseRunSummary {
  let resolvedTurnCount = 0;
  let strictResolvedTurnCount = 0;
  let safeFallbackTurnCount = 0;
  let unsafeUnderstandingFailureCount = 0;
  let understandingModelCallCount = 0;
  let successfulUnderstandingModelCallCount = 0;
  let failedUnderstandingModelCallCount = 0;
  for (const turn of execution.turns) {
    const calls = turn.llmCalls.filter(
      (call) => call.purpose === "turn_understanding",
    );
    const successfulCalls = calls.filter((call) => call.success);
    const failedCalls = calls.filter((call) => !call.success);
    understandingModelCallCount += calls.length;
    successfulUnderstandingModelCallCount += successfulCalls.length;
    failedUnderstandingModelCallCount += failedCalls.length;
    const hasValidatedOutcome =
      typeof turn.validatedOutcome["route"] === "string" &&
      turn.validatedOutcome["route"].trim() !== "";
    const hardAssertions = turn.assertions.filter(
      (assertion) => assertion.hard,
    );
    const hardAssertionsPassed =
      hardAssertions.length > 0 &&
      hardAssertions.every((assertion) => assertion.passed);
    const strictOrigin =
      turn.understandingOrigin === "model_valid" ||
      turn.understandingOrigin === "model_partial" ||
      turn.understandingOrigin === "deterministic";
    const modelOriginResolved =
      (turn.understandingOrigin === "model_valid" ||
        turn.understandingOrigin === "model_partial") &&
      successfulCalls.length > 0;
    const deterministicOriginResolved =
      turn.understandingOrigin === "deterministic";
    const strictResolved =
      turn.error === undefined &&
      hasValidatedOutcome &&
      strictOrigin &&
      failedCalls.length === 0 &&
      (modelOriginResolved || deterministicOriginResolved);
    const fallbackOrigin =
      turn.understandingOrigin === "typed_fallback" ||
      turn.understandingOrigin === "fallback";
    const safeFallbackResolved =
      turn.error === undefined &&
      hasValidatedOutcome &&
      fallbackOrigin &&
      failedCalls.length > 0 &&
      hardAssertionsPassed;
    if (strictResolved) strictResolvedTurnCount += 1;
    if (safeFallbackResolved) safeFallbackTurnCount += 1;
    if (strictResolved || safeFallbackResolved) resolvedTurnCount += 1;
    if (failedCalls.length > 0 && !safeFallbackResolved) {
      unsafeUnderstandingFailureCount += failedCalls.length;
    }
    if (fallbackOrigin && !safeFallbackResolved) {
      unsafeUnderstandingFailureCount += 1;
    }
  }
  const executionFailedUnderstandingCalls = execution.llmCalls.filter(
    (call) => call.purpose === "turn_understanding" && !call.success,
  ).length;
  unsafeUnderstandingFailureCount += Math.max(
    0,
    executionFailedUnderstandingCalls - failedUnderstandingModelCallCount,
  );
  const providerUsageComplete =
    execution.llmCalls.length > 0 && execution.llmCalls.every(hasProviderUsage);
  const providerInputTokens = execution.llmCalls.reduce(
    (total, call) => total + (call.providerInputTokens ?? 0),
    0,
  );
  const providerOutputTokens = execution.llmCalls.reduce(
    (total, call) => total + (call.providerOutputTokens ?? 0),
    0,
  );
  const latencies = execution.llmCalls.map((call) => call.latencyMs);
  const hardAssertions = [
    ...execution.assertions,
    ...execution.turns.flatMap((turn) => turn.assertions),
  ].filter((assertion) => assertion.hard);
  const allHardAssertionsPassed =
    hardAssertions.length > 0 &&
    hardAssertions.every((assertion) => assertion.passed) &&
    execution.turns.every((turn) =>
      turn.assertions.some((assertion) => assertion.hard),
    );
  const modelComparable =
    execution.model === baselineModel &&
    execution.llmCalls.every((call) => call.model === baselineModel);
  return {
    runId: execution.runId,
    runIndex: execution.runIndex,
    databaseLabel: releaseArtifactLabel(execution.databaseLabel),
    status: execution.status,
    completionReason: execution.completionReason,
    requestedTurnCount: execution.requestedTurnCount,
    logicalTurnCount: execution.logicalTurnCount,
    llmCallCount: execution.llmCalls.length,
    resolvedTurnCount,
    strictResolvedTurnCount,
    safeFallbackTurnCount,
    unsafeUnderstandingFailureCount,
    understandingModelCallCount,
    successfulUnderstandingModelCallCount,
    failedUnderstandingModelCallCount,
    p95LlmLatencyMs: percentile(latencies, 0.95),
    providerInputTokens,
    providerOutputTokens,
    repoHead: execution.repoHead,
    worktreeDirty: execution.worktreeDirty ?? false,
    gitDiffStat: execution.gitDiffStat ?? "not_collected",
    gitDiffFingerprint: execution.gitDiffFingerprint ?? "not_collected",
    untrackedFileCount: execution.untrackedFileCount ?? 0,
    scenarioVersion: execution.scenarioVersion,
    provider: execution.provider,
    model: execution.model,
    jsonArtifact: releaseArtifactLabel(artifact?.jsonArtifact),
    markdownArtifact: releaseArtifactLabel(artifact?.markdownArtifact),
    providerUsageComplete,
    modelComparable,
    completeAndPassing:
      execution.status === "PASS" &&
      execution.failure === undefined &&
      execution.completionReason === "completed" &&
      execution.pipelineExpectation === "target" &&
      execution.providerMode === "deepseek" &&
      execution.realNetwork &&
      execution.requestedTurnCount === 30 &&
      execution.logicalTurnCount === 30 &&
      execution.turns.length === 30 &&
      allHardAssertionsPassed,
  };
}

function hasProviderUsage(
  call: CompanionLongRunExecution["llmCalls"][number],
): boolean {
  return (
    call.usageSource === "provider" &&
    call.attemptTelemetrySource === "exact" &&
    call.attemptCount !== undefined &&
    call.attemptCount >= 1 &&
    call.providerInputUsageAttemptCount === call.attemptCount &&
    call.providerOutputUsageAttemptCount === call.attemptCount &&
    call.providerInputTokens !== undefined &&
    call.providerOutputTokens !== undefined
  );
}

function releaseAssertion(
  code: string,
  passed: boolean,
  message: string,
  expected: string | number | boolean,
  actual: string | number | boolean,
): LongRunAssertionResult {
  return {
    id: `release-${code.toLocaleLowerCase()}`,
    code,
    passed,
    message,
    hard: true,
    scope: "run",
    expected,
    actual,
  };
}

function releaseRunUnderstandingAssertion(
  run: DeepSeek30TurnReleaseRunSummary,
  ordinal: number,
): LongRunAssertionResult {
  const passed =
    run.completeAndPassing &&
    run.resolvedTurnCount === 30 &&
    run.unsafeUnderstandingFailureCount === 0;
  return {
    id: `release-run-${String(ordinal)}-understanding`,
    code: `RELEASE-RUN-${String(ordinal)}-UNDERSTANDING`,
    passed,
    message:
      "Run-level understanding audit separates resolved turns, provider calls, and safe typed fallbacks.",
    hard: true,
    scope: "run",
    expected: 30,
    actual: run.resolvedTurnCount,
    evidence: [
      { key: "runId", value: run.runId },
      { key: "strictResolvedTurns", value: run.strictResolvedTurnCount },
      { key: "modelCalls", value: run.understandingModelCallCount },
      {
        key: "successfulModelCalls",
        value: run.successfulUnderstandingModelCallCount,
      },
      {
        key: "failedModelCalls",
        value: run.failedUnderstandingModelCallCount,
      },
      { key: "safeFallbackTurns", value: run.safeFallbackTurnCount },
    ],
  };
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] ?? 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function maximum(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

function ratioAgainstBaseline(value: number, baseline: number): number {
  return baseline <= 0 ? 0 : Number((value / baseline).toFixed(4));
}

function isDeepSeek30TurnReleaseMatrix(
  options: DeepSeekLongRunCliOptions,
): boolean {
  return (
    options.provider === "deepseek" &&
    options.turns === 30 &&
    options.runs === 3 &&
    options.pipeline === "target"
  );
}

const CLI_OPTION_NAMES = new Set([
  "provider",
  "turns",
  "runs",
  "pipeline",
  "scenario-version",
  "report-dir",
]);

function enumValue<const T extends readonly string[]>(
  name: string,
  value: string,
  allowed: T,
): T[number] {
  if (!allowed.includes(value)) {
    throw new DeepSeekLongRunCliUsageError(
      `Option --${name} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

function integerValue(name: string, value: string): number {
  if (!/^[0-9]+$/u.test(value)) {
    throw new DeepSeekLongRunCliUsageError(
      `Option --${name} must be an integer.`,
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DeepSeekLongRunCliUsageError(
      `Option --${name} exceeds the safe integer range.`,
    );
  }
  return parsed;
}

function normalizeScenarioVersion(value: string): string {
  if (/^v[1-9][0-9]*$/u.test(value)) return `companion-long-run-${value}`;
  if (/^companion-long-run-v[1-9][0-9]*$/u.test(value)) return value;
  throw new DeepSeekLongRunCliUsageError(
    "Option --scenario-version must be a version such as v1.",
  );
}

function workspaceChildPath(
  root: string,
  requestedPath: string,
  optionName: string,
): string {
  const target = resolve(
    isAbsolute(requestedPath) ? requestedPath : resolve(root, requestedPath),
  );
  const child = relative(root, target);
  if (
    child === "" ||
    child === ".." ||
    child.startsWith(`..${sep}`) ||
    isAbsolute(child)
  ) {
    throw new DeepSeekLongRunCliUsageError(
      `${optionName} must resolve to a child of the workspace root.`,
    );
  }
  return target;
}

async function writeExecutionReport(input: {
  execution: CompanionLongRunExecution;
  partialSequence?: number;
  reportDir: string;
  workspaceRoot: string;
  secrets: readonly string[];
  dependencies: DeepSeekLongRunCliDependencies;
}): Promise<CompanionLongRunReportWriteResult> {
  const reportInput = input.dependencies.toReportInput(
    input.execution,
    input.partialSequence,
  );
  const report = input.dependencies.buildReport(reportInput);
  return input.dependencies.writeReport(report, {
    reportDir: input.reportDir,
    workspaceRoot: input.workspaceRoot,
    secrets: input.secrets,
    ...(input.partialSequence === undefined
      ? {}
      : { partialSequence: input.partialSequence }),
  });
}

async function writeReleaseAggregateReport(input: {
  executions: readonly CompanionLongRunExecution[];
  aggregate: DeepSeek30TurnReleaseAggregate;
  reportDir: string;
  workspaceRoot: string;
  secrets: readonly string[];
  dependencies: DeepSeekLongRunCliDependencies;
}): Promise<{
  runId: string;
  report: CompanionLongRunReportWriteResult;
}> {
  const sortedExecutions = [...input.executions].sort(
    (left, right) => left.runIndex - right.runIndex,
  );
  const first = sortedExecutions[0];
  const childInputs = sortedExecutions.map((execution) =>
    input.dependencies.toReportInput(execution),
  );
  let aggregateTurnNumber = 0;
  const turns = childInputs.flatMap((child) =>
    child.turns.map((turn) => {
      aggregateTurnNumber += 1;
      return {
        ...turn,
        number: aggregateTurnNumber,
        assertions: turn.assertions.map((assertion) => ({
          ...assertion,
          turnNumber: aggregateTurnNumber,
        })),
      };
    }),
  );
  const runLlmCalls = childInputs.flatMap((child) => child.runLlmCalls ?? []);
  const startedAtUtc = earliestIso(
    sortedExecutions.map((execution) => execution.startedAtUtc),
  );
  const completedAtUtc = latestIso(
    sortedExecutions.map((execution) => execution.completedAtUtc),
  );
  const runId = releaseAggregateRunId(startedAtUtc);
  const report = input.dependencies.buildReport({
    runId,
    scenarioVersion: `${sharedValue(
      sortedExecutions.map((execution) => execution.scenarioVersion),
    )}-release-matrix`,
    repoHead: sharedValue(
      sortedExecutions.map((execution) => execution.repoHead),
    ),
    worktreeDirty: sortedExecutions.some(
      (execution) => execution.worktreeDirty === true,
    ),
    gitDiffStat: sharedValue(
      sortedExecutions.map(
        (execution) => execution.gitDiffStat ?? "not_collected",
      ),
    ),
    gitDiffFingerprint: sharedValue(
      sortedExecutions.map(
        (execution) => execution.gitDiffFingerprint ?? "not_collected",
      ),
    ),
    untrackedFileCount: maximum(
      sortedExecutions.map((execution) => execution.untrackedFileCount ?? 0),
    ),
    startedAtUtc,
    completedAtUtc,
    status: input.aggregate.passed ? "PASS" : "FAIL",
    completionReason: "release_matrix_aggregated",
    provider: sharedValue(
      sortedExecutions.map((execution) => execution.provider),
    ),
    providerMode: "deepseek",
    model: sharedValue(sortedExecutions.map((execution) => execution.model)),
    clockMode: first?.clockMode ?? "fake",
    pipelineExpectation: "target",
    requestedTurnCount: childInputs.reduce(
      (count, child) => count + child.requestedTurnCount,
      0,
    ),
    httpExchangeCount: childInputs.reduce(
      (count, child) => count + child.httpExchangeCount,
      0,
    ),
    turns,
    runLlmCalls,
    runAssertions: [
      ...childInputs.flatMap((child) => child.runAssertions ?? []),
      ...input.aggregate.assertions,
    ],
    metrics: input.aggregate.metrics,
    metricDetails: input.aggregate.metricDetails,
    releaseMatrix: {
      expectedRuns: input.aggregate.expectedRuns,
      children: input.aggregate.runSummaries,
    },
    ...(input.aggregate.passed
      ? {}
      : {
          failure: {
            code: "release_matrix_gate_failed",
            stage: "release_aggregate",
            message:
              "The DeepSeek 30-turn release matrix failed one or more aggregate gates.",
            retryable: false,
          },
        }),
  });
  return {
    runId,
    report: await input.dependencies.writeReport(report, {
      reportDir: input.reportDir,
      workspaceRoot: input.workspaceRoot,
      secrets: input.secrets,
    }),
  };
}

function releaseAggregateRunId(startedAtUtc: string): string {
  const timestamp = startedAtUtc.replace(/[^0-9A-Za-z]/gu, "");
  return [
    "companion-long-run-deepseek-30t-release-matrix",
    timestamp,
    randomUUID().slice(0, 8),
  ].join("-");
}

function earliestIso(values: readonly string[]): string {
  return [...values].sort()[0] ?? new Date(0).toISOString();
}

function latestIso(values: readonly string[]): string {
  return [...values].sort().at(-1) ?? new Date(0).toISOString();
}

function sharedValue(values: readonly string[]): string {
  const unique = [...new Set(values)];
  return unique.length === 1 ? (unique[0] ?? "not_collected") : "mixed";
}

function uniqueNonEmptyCount(values: readonly string[]): number {
  return new Set(values.filter((value) => value.trim() !== "")).size;
}

function isSafeReleaseArtifactLabel(value: string): boolean {
  return canonicalReleaseArtifactLabel(value) !== undefined;
}

function canonicalReleaseArtifactLabel(value: string): string | undefined {
  if (value.trim() === "" || isAbsolute(value) || value.includes("\0")) {
    return undefined;
  }
  const segments: string[] = [];
  for (const segment of value.replace(/\\/gu, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : segments.join("/");
}

function releaseArtifactLabel(value: string | undefined): string {
  return value === undefined
    ? "not_recorded"
    : (canonicalReleaseArtifactLabel(value) ?? "not_recorded");
}

async function writeSkippedRuns(
  input: Omit<SyntheticRunsInput, "status" | "code" | "message"> & {
    gate: PaidDeepSeekGateResult;
  },
): Promise<number> {
  return writeSyntheticRuns({
    ...input,
    status: "SKIPPED",
    code: input.gate.code ?? "paid_preflight_skipped",
    message:
      input.gate.message ?? "Paid DeepSeek long-run preflight was skipped.",
  });
}

interface SyntheticRunsInput {
  options: DeepSeekLongRunCliOptions;
  reportDir: string;
  workspaceRoot: string;
  now: () => Date;
  stdout: (value: string) => void;
  stderr: (value: string) => void;
  dependencies: DeepSeekLongRunCliDependencies;
  status: "FAIL" | "SKIPPED";
  code: string;
  message: string;
  config?: ServerConfig;
  secrets: readonly string[];
}

async function writeSyntheticRuns(input: SyntheticRunsInput): Promise<number> {
  try {
    for (let runIndex = 1; runIndex <= input.options.runs; runIndex += 1) {
      const timestamp = input.now();
      const runId = syntheticRunId(
        input.options.provider,
        input.status,
        timestamp,
        runIndex,
      );
      const report = input.dependencies.buildReport({
        runId,
        scenarioVersion: input.options.scenarioVersion,
        repoHead: "not-collected",
        startedAtUtc: timestamp.toISOString(),
        completedAtUtc: timestamp.toISOString(),
        status: input.status,
        provider:
          input.config?.llm.provider ??
          (input.options.provider === "deepseek"
            ? "openai-compatible"
            : "fixture"),
        providerMode: input.options.provider,
        model: input.config?.llm.model ?? "not-configured",
        clockMode: "fake",
        pipelineExpectation: input.options.pipeline,
        requestedTurnCount: input.options.turns,
        httpExchangeCount: 0,
        turns: [],
        metrics: {
          requestedRuns: input.options.runs,
          runIndex,
        },
        failure: {
          code: input.code,
          stage: "preflight",
          message: input.message,
          retryable: false,
        },
      });
      const written = await input.dependencies.writeReport(report, {
        reportDir: input.reportDir,
        workspaceRoot: input.workspaceRoot,
        secrets: input.secrets,
      });
      input.stdout(
        `${runId}: ${input.status}; report ${safeArtifactLabel(input.workspaceRoot, written.jsonPath)}.\n`,
      );
    }
    return input.status === "SKIPPED" ? 0 : 1;
  } catch {
    input.stderr("Companion long-run report generation failed.\n");
    return 1;
  }
}

function syntheticRunId(
  provider: LongRunProviderMode,
  status: "FAIL" | "SKIPPED",
  now: Date,
  runIndex: number,
): string {
  const timestamp = now.toISOString().replace(/[^0-9A-Za-z]/gu, "");
  return [
    provider,
    "companion-long-run",
    status.toLocaleLowerCase(),
    timestamp,
    String(runIndex),
    randomUUID().slice(0, 8),
  ].join("-");
}

function safeArtifactLabel(root: string, path: string): string {
  const label = relative(root, resolve(path)).replaceAll("\\", "/");
  return label !== "" && !label.startsWith("../") && !isAbsolute(label)
    ? label
    : "[local report]";
}

function safeErrorName(error: unknown): string {
  return error instanceof DeepSeekLongRunCliUsageError
    ? error.message
    : error instanceof Error && error.name.trim() !== ""
      ? error.name
      : "Error";
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)
  );
}

if (isDirectExecution()) {
  process.exitCode = await runDeepSeekLongRunAcceptanceCli();
}
