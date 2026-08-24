import { access, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

import type {
  CompanionTurnExpected,
  LongRunProviderMode,
  LongRunSessionKey,
  PipelineExpectation,
  ScenarioAction,
  SoftMetricTag,
} from "../scenarios/companion-long-run-types.js";

export type CompanionLongRunStatus = "PASS" | "FAIL" | "SKIPPED" | "PARTIAL";

export interface LongRunAssertionResult {
  id?: string;
  code: string;
  passed: boolean;
  message: string;
  hard?: boolean;
  scope?: "turn" | "run";
  turnNumber?: number;
  expected?: string | number | boolean | null;
  actual?: string | number | boolean | null;
  evidence?: readonly {
    key: string;
    value: string | number | boolean | null;
  }[];
}

export interface LongRunLlmCallReport {
  purpose: string;
  provider: string;
  model: string;
  attempt: number;
  /** Total physical provider attempts represented by this logical audit row. */
  attemptCount?: number;
  /** Physical attempts that failed transport, parse, or schema validation. */
  failedAttemptCount?: number;
  /** Attempts with provider-reported input-token usage. */
  providerInputUsageAttemptCount?: number;
  /** Attempts with provider-reported output-token usage. */
  providerOutputUsageAttemptCount?: number;
  /** Whether the physical-attempt counters are observed or legacy-inferred. */
  attemptTelemetrySource?: "exact" | "inferred";
  latencyMs: number;
  success: boolean;
  status?: number;
  /** Local deterministic estimate recorded by the server. */
  inputTokens?: number;
  /** Local deterministic estimate recorded by the server. */
  outputTokens?: number;
  /** Provider-reported actual usage, when available. */
  providerInputTokens?: number;
  /** Provider-reported actual usage, when available. */
  providerOutputTokens?: number;
  usageSource?: string;
  errorCode?: string;
}

export interface LongRunHttpExchangeReport {
  label: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  requestId?: string;
  idempotentReplay?: boolean;
}

export interface LongRunObservationReport {
  origin: "model" | "fixture" | "fallback";
  route: string;
  confidence?: number;
  dialogueActs?: readonly string[];
  topicKeys?: readonly string[];
  topicDomains?: readonly string[];
  scheduleIntentKind?: string;
  salientUserQuotes?: readonly string[];
  uncertaintyCodes?: readonly string[];
  rejectedFieldCodes?: readonly string[];
  worldEffectCandidateCounts?: {
    stateDelta: number;
    relationshipDelta: number;
    memories: number;
    personalIntents: number;
    continuityEffects: number;
    careCues: number;
  };
}

export interface LongRunOutcomeReport {
  route: string;
  scheduleOutcomeKind: string;
  decisionPath: string;
  worldEffectsMode: string;
  worldEffectWritesEnabled: boolean;
  scheduleWritesEnabled: boolean;
  scheduleWritesEnabledSource?: "validated_outcome" | "missing";
  stateChanged: boolean;
  dryRun: boolean;
  dryRunSource?: "validated_outcome" | "missing";
  replyMutationAuthorization?: string;
  replyDirectiveMode?: string;
  acceptedEffectCounts: {
    stateDelta: number;
    relationshipDelta: number;
    memories: number;
    personalIntents: number;
    continuityEffects: number;
    careCues: number;
  };
  proposalRejectionCodes: readonly string[];
}

export interface LongRunContextPlanReport {
  activatedTraitIds: readonly string[];
  activatedValueIds: readonly string[];
  activatedContradictionIds: readonly string[];
  activatedGoalIds: readonly string[];
  activatedPreferenceIds: readonly string[];
  suppressedGoalIds: readonly string[];
  includeAutobiography: boolean;
  includeCalendar: boolean;
  includeFutureSchedule: boolean;
  includeRetrievedEvidence: boolean;
  trace: readonly {
    itemType: string;
    itemId: string;
    included: boolean;
    source:
      | "user_message"
      | "selected_evidence"
      | "current_activity"
      | "continuity_cue"
      | "none";
    reasons: readonly string[];
    sourceId?: string;
  }[];
}

export interface LongRunPromptSegmentTraceReport {
  id: string;
  placement: "system" | "prompt";
  priority: number;
  tokenBudget: number;
  estimatedTokens: number;
  required: boolean;
  included: boolean;
  truncated: boolean;
  cacheHit: boolean;
  reason?: string;
}

export interface LongRunAssistantReport {
  text: string;
  chunkCount: number;
  repairAttempted: boolean;
  usedFallback: boolean;
  reasonCode?: string;
  issueCodes?: readonly string[];
}

export interface LongRunAuthoritySnapshotReport {
  runtimeState?: {
    asOfUtc: string;
    revision: number;
    moodValence: number;
    moodArousal: number;
    energy: number;
    stress: number;
    socialBattery: number;
    focus: number;
    sleepDebtMinutes: number;
    currentActivityId?: string;
    locationContext?: string;
    relationship?: {
      userId: string;
      closeness: number;
      trust: number;
      familiarity: number;
      recentInteractionValence: number;
      lastInteractionAtUtc?: string;
    };
  };
  schedule?: readonly {
    id: string;
    title: string;
    category: string;
    startAtUtc: string;
    endAtUtc: string;
    status: string;
    revision: number;
  }[];
  scheduleCommitLineage?: readonly {
    authorizedItemId: string;
    scheduleCommandEventId: string;
    negotiationId: string;
    offerVersion: number;
    negotiationStatus: "committed";
  }[];
  memoryCount?: number;
  careCueCount?: number;
  followUpCount?: number;
  domainEventCount?: number;
}

export interface LongRunChangeReport {
  stateChanged: boolean;
  scheduleItemIdsAdded?: readonly string[];
  scheduleItemIdsUpdated?: readonly string[];
  memoryIdsAdded?: readonly string[];
  memoryIdsUpdated?: readonly string[];
  careCueIdsAdded?: readonly string[];
  careCueIdsUpdated?: readonly string[];
  followUpIdsAdded?: readonly string[];
  followUpIdsUpdated?: readonly string[];
  memoryRejectionCodes?: readonly string[];
  careCueRejectionCodes?: readonly string[];
  followUpRejectionCodes?: readonly string[];
}

export interface LongRunDomainEventReport {
  id: string;
  type: string;
  aggregateType: string;
  aggregateId: string;
  occurredAtUtc: string;
  correlationId?: string;
  causationId?: string;
  entityIds?: readonly string[];
  reasonCodes?: readonly string[];
}

export interface LongRunRetrievalReport {
  runIds: readonly string[];
  selectedEvidenceIds: readonly string[];
  evidenceMappings: readonly {
    evidenceId: string;
    sourceMessageId?: string;
    memoryId?: string;
    currentTurnGrounded: boolean;
  }[];
}

export interface LongRunTurnFailureReport {
  code: string;
  stage: string;
  retryable: boolean;
}

export interface CompanionLongRunTurnReport {
  number: number;
  manifestTurnNumber: number;
  phase: string;
  objective: string;
  sessionKey: LongRunSessionKey;
  sessionId: string;
  clientMessageId: string;
  userText: string;
  actionsBefore: readonly ScenarioAction[];
  expected: CompanionTurnExpected;
  http: readonly LongRunHttpExchangeReport[];
  actualRoute?: string;
  observation?: LongRunObservationReport;
  outcome?: LongRunOutcomeReport;
  contextPlan: LongRunContextPlanReport;
  promptSegmentTrace: readonly LongRunPromptSegmentTraceReport[];
  selectedEvidenceIds: readonly string[];
  assistant: LongRunAssistantReport;
  stateBefore?: LongRunAuthoritySnapshotReport;
  stateAfter?: LongRunAuthoritySnapshotReport;
  changes: LongRunChangeReport;
  domainEvents: readonly LongRunDomainEventReport[];
  retrieval: LongRunRetrievalReport;
  llmCalls: readonly LongRunLlmCallReport[];
  assertions: readonly LongRunAssertionResult[];
  softMetricTags: readonly SoftMetricTag[];
  failure?: LongRunTurnFailureReport;
}

export interface LongRunAssertionSummary {
  total: number;
  passed: number;
  failed: number;
  hardFailed: number;
  results: readonly LongRunAssertionResult[];
}

export type LongRunMetricValue = string | number | boolean;

export interface LongRunMetricResult {
  name: string;
  value: number;
  unit?: string;
  passed?: boolean;
  comparator?: "<" | "<=" | "=" | ">=" | ">";
  threshold?: number;
  numerator?: number;
  denominator?: number;
  /** Sequence numbers in the concrete run/profile that failed this metric. */
  failedTurnNumbers?: readonly number[];
  /** Stable scenario-manifest turn numbers corresponding to failedTurnNumbers. */
  failedManifestTurnNumbers?: readonly number[];
  source?: string;
}

export interface LongRunPhaseReport {
  phase: string;
  firstTurn: number;
  lastTurn: number;
  turnCount: number;
  assertionCount: number;
  assertionFailureCount: number;
  hardAssertionFailureCount: number;
}

export interface LongRunPurposeUsageReport {
  purpose: string;
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  attemptCount: number;
  failedAttemptCount: number;
  providerInputUsageAttemptCount: number;
  providerOutputUsageAttemptCount: number;
  exactAttemptTelemetryCalls: number;
  completeProviderUsageCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  comparableEstimatedInputTokens?: number;
  comparableEstimatedOutputTokens?: number;
  inputTokenError?: number;
  outputTokenError?: number;
  providerUsageCalls?: number;
  latencyMsP50: number;
  latencyMsP95: number;
  latencyMsMax: number;
}

export interface LongRunLlmUsageReport {
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  attemptCount: number;
  failedAttemptCount: number;
  providerInputUsageAttemptCount: number;
  providerOutputUsageAttemptCount: number;
  exactAttemptTelemetryCalls: number;
  completeProviderUsageCalls: number;
  inputTokens: number;
  outputTokens: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  comparableEstimatedInputTokens?: number;
  comparableEstimatedOutputTokens?: number;
  inputTokenError?: number;
  outputTokenError?: number;
  providerUsageCalls?: number;
  byPurpose: readonly LongRunPurposeUsageReport[];
}

export interface CompanionLongRunFailureReport {
  code: string;
  stage: string;
  message: string;
  turnNumber?: number;
  retryable?: boolean;
}

/**
 * Safe, scalar-only identity and usage summary for one child of a release
 * matrix. Artifact values are workspace-relative labels produced only after
 * the child report has been published.
 */
export interface LongRunReleaseMatrixChildReport {
  runId: string;
  runIndex: number;
  databaseLabel: string;
  status: CompanionLongRunStatus;
  completionReason: string;
  requestedTurnCount: number;
  logicalTurnCount: number;
  llmCallCount: number;
  p95LlmLatencyMs: number;
  providerInputTokens: number;
  providerOutputTokens: number;
  repoHead: string;
  worktreeDirty: boolean;
  gitDiffStat: string;
  gitDiffFingerprint: string;
  untrackedFileCount: number;
  scenarioVersion: string;
  provider: string;
  model: string;
  jsonArtifact: string;
  markdownArtifact: string;
  resolvedTurnCount: number;
  strictResolvedTurnCount: number;
  safeFallbackTurnCount: number;
  unsafeUnderstandingFailureCount: number;
  understandingModelCallCount: number;
  successfulUnderstandingModelCallCount: number;
  failedUnderstandingModelCallCount: number;
  providerUsageComplete: boolean;
  modelComparable: boolean;
  completeAndPassing: boolean;
}

export interface LongRunReleaseMatrixReport {
  expectedRuns: number;
  children: readonly LongRunReleaseMatrixChildReport[];
}

export interface CompanionLongRunReport {
  schemaVersion: 1;
  runId: string;
  scenarioVersion: string;
  repoHead: string;
  worktreeDirty: boolean;
  gitDiffStat: string;
  gitDiffFingerprint: string;
  untrackedFileCount: number;
  startedAtUtc: string;
  completedAtUtc: string;
  status: CompanionLongRunStatus;
  completionReason?: string;
  provider: string;
  providerMode?: LongRunProviderMode;
  model: string;
  clockMode: string;
  pipelineExpectation: PipelineExpectation;
  requestedTurnCount: number;
  logicalTurnCount: number;
  httpExchangeCount: number;
  /** Allowlisted setup and other run-scope HTTP evidence. */
  runHttp?: readonly LongRunHttpExchangeReport[];
  sessionCount: number;
  restartCount: number;
  assertions: readonly LongRunAssertionResult[];
  assertionSummary: Omit<LongRunAssertionSummary, "results">;
  metrics: Readonly<Record<string, LongRunMetricValue>>;
  metricDetails: readonly LongRunMetricResult[];
  phases: readonly LongRunPhaseReport[];
  turns: readonly CompanionLongRunTurnReport[];
  /** Setup/run-scope calls only; turn-scoped calls remain on each turn. */
  runLlmCalls?: readonly LongRunLlmCallReport[];
  llmUsage: readonly LongRunPurposeUsageReport[];
  llmUsageSummary: Omit<LongRunLlmUsageReport, "byPurpose">;
  releaseMatrix?: LongRunReleaseMatrixReport;
  artifacts: {
    json: string;
    markdown: string;
    database?: string;
    log?: string;
  };
  checkpoint?: {
    lastCompletedTurn: number;
    partialSequence: number;
  };
  failure?: CompanionLongRunFailureReport;
}

export interface BuildCompanionLongRunReportInput {
  runId: string;
  scenarioVersion: string;
  repoHead: string;
  worktreeDirty?: boolean;
  gitDiffStat?: string;
  gitDiffFingerprint?: string;
  untrackedFileCount?: number;
  startedAtUtc: string;
  completedAtUtc: string;
  status: CompanionLongRunStatus;
  completionReason?: string;
  provider: string;
  providerMode?: LongRunProviderMode;
  model: string;
  clockMode: string;
  pipelineExpectation: PipelineExpectation;
  requestedTurnCount: number;
  httpExchangeCount: number;
  /** Allowlisted setup and other run-scope HTTP evidence. */
  runHttp?: readonly LongRunHttpExchangeReport[];
  turns: readonly CompanionLongRunTurnReport[];
  /** Setup/run-scope calls only. Callers must exclude calls already on turns. */
  runLlmCalls?: readonly LongRunLlmCallReport[];
  runAssertions?: readonly LongRunAssertionResult[];
  metrics?: Readonly<Record<string, LongRunMetricValue>>;
  metricDetails?: readonly LongRunMetricResult[];
  releaseMatrix?: LongRunReleaseMatrixReport;
  artifactLabels?: {
    database?: string;
    log?: string;
  };
  failure?: CompanionLongRunFailureReport;
  partialSequence?: number;
}

export interface CompanionLongRunReportWriteOptions {
  reportDir: string;
  workspaceRoot: string;
  secrets?: readonly string[];
  partialSequence?: number;
}

export interface CompanionLongRunReportWriteResult {
  jsonPath: string;
  markdownPath: string;
}

export interface CompanionLongRunSafetyFinding {
  code: string;
  path?: string;
}

export class CompanionLongRunReportSafetyError extends Error {
  readonly findings: readonly CompanionLongRunSafetyFinding[];

  constructor(findings: readonly CompanionLongRunSafetyFinding[]) {
    super(
      `Companion long-run report safety scan failed (${String(findings.length)} finding(s): ${[
        ...new Set(findings.map((finding) => finding.code)),
      ].join(", ")}).`,
    );
    this.name = "CompanionLongRunReportSafetyError";
    this.findings = findings;
  }
}

const FORBIDDEN_KEYS = new Set([
  "apikey",
  "authorization",
  "cookie",
  "credentials",
  "databas epath".replace(" ", ""),
  "headers",
  "password",
  "prompt",
  "providerrequest",
  "providerresponse",
  "rawoutput",
  "rawpayload",
  "rawproviderpayload",
  "refreshToken".toLowerCase(),
  "reportdir",
  "requestheaders",
  "responseheaders",
  "secret",
  "stack",
  "system",
  "systemprompt",
  "workspaceRoot".toLowerCase(),
]);

const SENSITIVE_KEY_PATTERN =
  /(?:api[-_]?key|authorization|cookie|credential|password|refresh[-_]?token|secret)/iu;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu;
const API_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{10,}/giu;
const FILE_URI_PATTERN = /file:\/{2,3}[^\s"'<>]+/giu;
const WINDOWS_EXTENDED_PATH_PATTERN =
  /\\\\\?\\(?:UNC\\[^\\/\s"'<>|?*]+\\[^\\/\s"'<>|?*]+(?:\\[^\s"'<>|?*]*)?|[A-Za-z]:\\[^\s"'<>|?*]*)/giu;
const WINDOWS_UNC_PATH_PATTERN =
  /\\\\[^\\/\s"'<>|?*]+\\[^\\/\s"'<>|?*]+(?:\\[^\s"'<>|?*]*)?/gu;
const WINDOWS_PATH_PATTERN =
  /\b[A-Za-z]:[\\/](?:[^\s"'<>|?*]+[\\/])*[^\s"'<>|?*]*/gu;
const POSIX_PATH_PATTERN =
  /(?<![A-Za-z0-9._~%/-])\/(?:Users|Volumes|app|data|dev|etc|home|mnt|opt|private|proc|root|run|srv|sys|tmp|usr|var|workspace|workspaces)(?:\/[^\s"'<>|?*\\]*)?/giu;

export function buildCompanionLongRunReport(
  input: BuildCompanionLongRunReportInput,
): CompanionLongRunReport {
  assertNoForbiddenKeys(input);
  const turns = input.turns.map(projectTurn);
  const turnAssertions = turns.flatMap((turn) => turn.assertions);
  const runAssertions = (input.runAssertions ?? []).map(projectAssertion);
  const assertionAggregate = aggregateAssertions([
    ...turnAssertions,
    ...runAssertions,
  ]);
  const runLlmCalls = (input.runLlmCalls ?? []).map(projectLlmCall);
  const llmUsageAggregate = aggregateLlmUsage([
    ...runLlmCalls,
    ...turns.flatMap((turn) => turn.llmCalls),
  ]);
  const partialSequence = input.partialSequence;
  const failure =
    input.failure ?? failureForCompletionReason(input.completionReason);
  const artifactNames = artifactNamesFor(
    input.runId,
    partialSequence,
    turns.length,
  );
  const report: CompanionLongRunReport = {
    schemaVersion: 1,
    runId: input.runId,
    scenarioVersion: input.scenarioVersion,
    repoHead: input.repoHead,
    worktreeDirty: input.worktreeDirty ?? false,
    gitDiffStat: input.gitDiffStat ?? "not_collected",
    gitDiffFingerprint: input.gitDiffFingerprint ?? "not_collected",
    untrackedFileCount: input.untrackedFileCount ?? 0,
    startedAtUtc: input.startedAtUtc,
    completedAtUtc: input.completedAtUtc,
    status: input.status,
    ...(input.completionReason === undefined
      ? {}
      : { completionReason: input.completionReason }),
    provider: input.provider,
    ...(input.providerMode === undefined
      ? {}
      : { providerMode: input.providerMode }),
    model: input.model,
    clockMode: input.clockMode,
    pipelineExpectation: input.pipelineExpectation,
    requestedTurnCount: input.requestedTurnCount,
    logicalTurnCount: turns.length,
    httpExchangeCount: input.httpExchangeCount,
    ...(input.runHttp === undefined
      ? {}
      : { runHttp: input.runHttp.map(projectHttpExchange) }),
    sessionCount: new Set(turns.map((turn) => turn.sessionId)).size,
    restartCount: turns.reduce(
      (count, turn) =>
        count +
        turn.actionsBefore.filter((action) => action.kind === "restart_app")
          .length,
      0,
    ),
    assertions: assertionAggregate.results,
    assertionSummary: {
      total: assertionAggregate.total,
      passed: assertionAggregate.passed,
      failed: assertionAggregate.failed,
      hardFailed: assertionAggregate.hardFailed,
    },
    metrics: projectMetricValues(input.metrics ?? {}),
    metricDetails: (input.metricDetails ?? []).map(projectMetric),
    phases: aggregatePhases(turns),
    turns,
    runLlmCalls,
    llmUsage: llmUsageAggregate.byPurpose,
    llmUsageSummary: {
      calls: llmUsageAggregate.calls,
      successfulCalls: llmUsageAggregate.successfulCalls,
      failedCalls: llmUsageAggregate.failedCalls,
      attemptCount: llmUsageAggregate.attemptCount,
      failedAttemptCount: llmUsageAggregate.failedAttemptCount,
      providerInputUsageAttemptCount:
        llmUsageAggregate.providerInputUsageAttemptCount,
      providerOutputUsageAttemptCount:
        llmUsageAggregate.providerOutputUsageAttemptCount,
      exactAttemptTelemetryCalls: llmUsageAggregate.exactAttemptTelemetryCalls,
      completeProviderUsageCalls: llmUsageAggregate.completeProviderUsageCalls,
      inputTokens: llmUsageAggregate.inputTokens,
      outputTokens: llmUsageAggregate.outputTokens,
      estimatedInputTokens: llmUsageAggregate.estimatedInputTokens ?? 0,
      estimatedOutputTokens: llmUsageAggregate.estimatedOutputTokens ?? 0,
      providerInputTokens: llmUsageAggregate.providerInputTokens ?? 0,
      providerOutputTokens: llmUsageAggregate.providerOutputTokens ?? 0,
      comparableEstimatedInputTokens:
        llmUsageAggregate.comparableEstimatedInputTokens ?? 0,
      comparableEstimatedOutputTokens:
        llmUsageAggregate.comparableEstimatedOutputTokens ?? 0,
      inputTokenError: llmUsageAggregate.inputTokenError ?? 0,
      outputTokenError: llmUsageAggregate.outputTokenError ?? 0,
      providerUsageCalls: llmUsageAggregate.providerUsageCalls ?? 0,
    },
    ...(input.releaseMatrix === undefined
      ? {}
      : { releaseMatrix: projectReleaseMatrix(input.releaseMatrix) }),
    artifacts: {
      ...artifactNames,
      ...(input.artifactLabels?.database === undefined
        ? {}
        : { database: input.artifactLabels.database }),
      ...(input.artifactLabels?.log === undefined
        ? {}
        : { log: input.artifactLabels.log }),
    },
    ...(partialSequence === undefined
      ? {}
      : {
          checkpoint: {
            lastCompletedTurn: turns.length,
            partialSequence,
          },
        }),
    ...(failure === undefined ? {} : { failure: projectFailure(failure) }),
  };
  validateReportInvariants(report);
  return report;
}

export function renderCompanionLongRunReportJson(
  report: CompanionLongRunReport,
  secrets: readonly string[] = [],
): string {
  const safeReport = prepareReportForOutput(report, secrets);
  const rendered = `${JSON.stringify(safeReport, null, 2)}\n`;
  assertCompanionLongRunReportSafe(rendered, secrets);
  return rendered;
}

export function renderCompanionLongRunReportMarkdown(
  report: CompanionLongRunReport,
  secrets: readonly string[] = [],
): string {
  const safeReport = prepareReportForOutput(report, secrets);
  const metricRows = Object.entries(safeReport.metrics).map(([name, value]) => {
    const detail = safeReport.metricDetails.find((item) => item.name === name);
    const sample =
      detail?.numerator === undefined || detail.denominator === undefined
        ? "—"
        : `${String(detail.numerator)} / ${String(detail.denominator)}`;
    const failedTurns = formatMetricFailedTurns(detail);
    return rowCells([
      name,
      `${String(value)}${detail?.unit === undefined ? "" : ` ${detail.unit}`}`,
      sample,
      failedTurns,
      detail?.threshold === undefined
        ? "—"
        : `${detail.comparator ?? ""} ${String(detail.threshold)}`.trim(),
      detail?.passed === undefined ? "—" : detail.passed ? "PASS" : "FAIL",
      detail?.source ?? "—",
    ]);
  });
  const lines: string[] = [
    "# ChatPLUS Companion Long-Run Report",
    "",
    `**Status:** ${escapeInline(safeReport.status)}`,
    "",
    "## Run",
    "",
    "| Field | Value |",
    "| --- | --- |",
    row("Run ID", safeReport.runId),
    row("Scenario", safeReport.scenarioVersion),
    row("Repository head", safeReport.repoHead),
    row("Worktree dirty", safeReport.worktreeDirty),
    row("Git diff stat", safeReport.gitDiffStat),
    row("Git diff fingerprint", safeReport.gitDiffFingerprint),
    row("Untracked files", safeReport.untrackedFileCount),
    row(
      "Provider / model",
      `${safeReport.provider}${safeReport.providerMode === undefined ? "" : ` (${safeReport.providerMode})`} / ${safeReport.model}`,
    ),
    row(
      "Clock / pipeline",
      `${safeReport.clockMode} / ${safeReport.pipelineExpectation}`,
    ),
    row("Started (UTC)", safeReport.startedAtUtc),
    row("Completed (UTC)", safeReport.completedAtUtc),
    row("Completion reason", safeReport.completionReason ?? "not_recorded"),
    row(
      "Logical turns",
      `${String(safeReport.logicalTurnCount)} / ${String(safeReport.requestedTurnCount)}`,
    ),
    row("HTTP exchanges", safeReport.httpExchangeCount),
    row(
      "Sessions / restarts",
      `${String(safeReport.sessionCount)} / ${String(safeReport.restartCount)}`,
    ),
    "",
    ...(safeReport.releaseMatrix === undefined
      ? []
      : renderReleaseMatrixMarkdown(safeReport.releaseMatrix, safeReport)),
    ...(safeReport.runHttp === undefined
      ? []
      : [
          "## Setup / run HTTP exchanges",
          "",
          `Recorded ${String(safeReport.runHttp.length)} allowlisted setup/run-scope exchange(s).`,
          "",
          "| Label | Method | Route | Status | Duration (ms) | Request ID |",
          "| --- | --- | --- | ---: | ---: | --- |",
          ...(safeReport.runHttp.length === 0
            ? ["| — | — | — | — | — | — |"]
            : safeReport.runHttp.map((exchange) =>
                rowCells([
                  exchange.label,
                  exchange.method,
                  exchange.route,
                  exchange.status,
                  exchange.durationMs,
                  exchange.requestId ?? "—",
                ]),
              )),
          "",
        ]),
    "## Assertions",
    "",
    `Passed ${String(safeReport.assertionSummary.passed)} of ${String(safeReport.assertionSummary.total)}; failed ${String(safeReport.assertionSummary.failed)} (${String(safeReport.assertionSummary.hardFailed)} hard).`,
    "",
    "| Scope | Turn | Code | Result | Message |",
    "| --- | ---: | --- | --- | --- |",
    ...safeReport.assertions.map((assertion) =>
      [
        assertion.scope ??
          (assertion.turnNumber === undefined ? "run" : "turn"),
        assertion.turnNumber ?? "—",
        assertion.code,
        assertion.passed ? "PASS" : "FAIL",
        assertion.message,
      ]
        .map(escapeTable)
        .join(" | ")
        .replace(/^/u, "| ")
        .concat(" |"),
    ),
    "",
    "## Metrics",
    "",
    "| Metric | Value | Sample | Failed turns (run / manifest) | Threshold | Result | Source |",
    "| --- | ---: | ---: | --- | --- | --- | --- |",
    ...(metricRows.length === 0
      ? ["| — | — | — | — | — | — | — |"]
      : metricRows),
    "",
    "## Phases",
    "",
    "| Phase | Turns | Range | Assertion failures | Hard failures |",
    "| --- | ---: | --- | ---: | ---: |",
    ...safeReport.phases.map((phase) =>
      rowCells([
        phase.phase,
        phase.turnCount,
        `${String(phase.firstTurn)}–${String(phase.lastTurn)}`,
        phase.assertionFailureCount,
        phase.hardAssertionFailureCount,
      ]),
    ),
    "",
    "## LLM usage",
    "",
    `Calls: ${String(safeReport.llmUsageSummary.calls)} (${String(safeReport.llmUsageSummary.successfulCalls)} successful, ${String(safeReport.llmUsageSummary.failedCalls)} failed); physical attempts: ${String(safeReport.llmUsageSummary.attemptCount)} (${String(safeReport.llmUsageSummary.failedAttemptCount)} failed). Provider usage coverage: ${String(safeReport.llmUsageSummary.providerInputUsageAttemptCount)} / ${String(safeReport.llmUsageSummary.attemptCount)} input attempts and ${String(safeReport.llmUsageSummary.providerOutputUsageAttemptCount)} / ${String(safeReport.llmUsageSummary.attemptCount)} output attempts; complete calls: ${String(safeReport.llmUsageSummary.completeProviderUsageCalls)} / ${String(safeReport.llmUsageSummary.calls)}; exact attempt rows: ${String(safeReport.llmUsageSummary.exactAttemptTelemetryCalls)} / ${String(safeReport.llmUsageSummary.calls)}. Effective tokens: ${String(safeReport.llmUsageSummary.inputTokens)} input / ${String(safeReport.llmUsageSummary.outputTokens)} output. Estimated (all calls): ${String(safeReport.llmUsageSummary.estimatedInputTokens ?? safeReport.llmUsageSummary.inputTokens)} / ${String(safeReport.llmUsageSummary.estimatedOutputTokens ?? safeReport.llmUsageSummary.outputTokens)}; provider actual: ${String(safeReport.llmUsageSummary.providerInputTokens ?? 0)} / ${String(safeReport.llmUsageSummary.providerOutputTokens ?? 0)}; comparable estimate: ${String(safeReport.llmUsageSummary.comparableEstimatedInputTokens ?? 0)} / ${String(safeReport.llmUsageSummary.comparableEstimatedOutputTokens ?? 0)}; actual-minus-estimate error: ${signedNumber(safeReport.llmUsageSummary.inputTokenError ?? 0)} / ${signedNumber(safeReport.llmUsageSummary.outputTokenError ?? 0)}.`,
    "",
    "| Purpose | Calls | Success | Attempts / failed | Usage coverage in/out | Complete / exact calls | Estimated in/out | Provider actual in/out | Comparable estimate in/out | Effective in/out | Actual−estimate error in/out | p50 / p95 / max latency (ms) |",
    "| --- | ---: | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...safeReport.llmUsage.map((usage) =>
      rowCells([
        usage.purpose,
        usage.calls,
        usage.successfulCalls,
        `${String(usage.attemptCount)} / ${String(usage.failedAttemptCount)}`,
        `${String(usage.providerInputUsageAttemptCount)} / ${String(usage.providerOutputUsageAttemptCount)}`,
        `${String(usage.completeProviderUsageCalls)} / ${String(usage.exactAttemptTelemetryCalls)}`,
        `${String(usage.estimatedInputTokens ?? usage.inputTokens)} / ${String(usage.estimatedOutputTokens ?? usage.outputTokens)}`,
        `${String(usage.providerInputTokens ?? 0)} / ${String(usage.providerOutputTokens ?? 0)}`,
        `${String(usage.comparableEstimatedInputTokens ?? 0)} / ${String(usage.comparableEstimatedOutputTokens ?? 0)}`,
        `${String(usage.inputTokens)} / ${String(usage.outputTokens)}`,
        `${signedNumber(usage.inputTokenError ?? 0)} / ${signedNumber(usage.outputTokenError ?? 0)}`,
        `${String(usage.latencyMsP50)} / ${String(usage.latencyMsP95)} / ${String(usage.latencyMsMax)}`,
      ]),
    ),
    "",
    `Setup/run-scope LLM calls recorded: ${String(safeReport.runLlmCalls?.length ?? 0)}.`,
    "",
    "## Turns",
    "",
  ];

  for (const turn of safeReport.turns) {
    const failed = turn.assertions.filter(
      (assertion) => !assertion.passed,
    ).length;
    lines.push(
      `<details><summary>Turn ${String(turn.number)} (manifest ${String(turn.manifestTurnNumber)}) · ${escapeInline(turn.phase)} · ${failed === 0 ? "PASS" : `${String(failed)} failure(s)`}</summary>`,
      "",
      `- Objective: ${escapeInline(turn.objective)}`,
      `- Logical / manifest turn: ${String(turn.number)} / ${String(turn.manifestTurnNumber)}`,
      `- Session: ${escapeInline(turn.sessionKey)} / ${escapeInline(turn.sessionId)}`,
      `- Client message: ${escapeInline(turn.clientMessageId)}`,
      `- Route: expected ${escapeInline(turn.expected.route ?? "—")}; actual ${escapeInline(turn.actualRoute ?? "—")}`,
      `- Context activated goals: ${escapeInline(turn.contextPlan.activatedGoalIds.join(", ") || "—")}`,
      `- Context suppressed goals: ${escapeInline(turn.contextPlan.suppressedGoalIds.join(", ") || "—")}`,
      `- Selected evidence IDs: ${escapeInline(turn.selectedEvidenceIds.join(", ") || "—")}`,
      ...(turn.failure === undefined
        ? []
        : [
            `- Failure: code=${escapeInline(turn.failure.code)}; stage=${escapeInline(turn.failure.stage)}; retryable=${String(turn.failure.retryable)}`,
          ]),
      "",
      "User text:",
      "",
      fencedText(turn.userText),
      "",
      "Assistant text:",
      "",
      fencedText(turn.assistant.text),
      "",
      "Structured turn evidence:",
      "",
      fencedJson({
        actionsBefore: turn.actionsBefore,
        http: turn.http,
        observation: turn.observation,
        outcome: turn.outcome,
        promptSegmentTrace: turn.promptSegmentTrace,
        assistant: {
          chunkCount: turn.assistant.chunkCount,
          repairAttempted: turn.assistant.repairAttempted,
          usedFallback: turn.assistant.usedFallback,
          reasonCode: turn.assistant.reasonCode,
          issueCodes: turn.assistant.issueCodes,
        },
        stateBefore: turn.stateBefore,
        stateAfter: turn.stateAfter,
        changes: turn.changes,
        domainEvents: turn.domainEvents,
        retrieval: turn.retrieval,
        llmCalls: turn.llmCalls,
        assertions: turn.assertions,
        softMetricTags: turn.softMetricTags,
        ...(turn.failure === undefined ? {} : { failure: turn.failure }),
      }),
      "",
      "</details>",
      "",
    );
  }

  if (safeReport.failure !== undefined) {
    lines.push("## Failure", "", fencedJson(safeReport.failure), "");
  }
  lines.push(
    "## Artifacts",
    "",
    `- JSON: ${escapeInline(safeReport.artifacts.json)}`,
    `- Markdown: ${escapeInline(safeReport.artifacts.markdown)}`,
    ...(safeReport.artifacts.database === undefined
      ? []
      : [`- Database: ${escapeInline(safeReport.artifacts.database)}`]),
    ...(safeReport.artifacts.log === undefined
      ? []
      : [`- Safe log: ${escapeInline(safeReport.artifacts.log)}`]),
    "",
    "The report contains allowlisted diagnostics only; full prompts, provider payloads, credentials, headers, and absolute local paths are excluded.",
    "",
  );
  const rendered = `${lines.join("\n").trimEnd()}\n`;
  assertCompanionLongRunReportSafe(rendered, secrets);
  return rendered;
}

export async function writeCompanionLongRunReport(
  report: CompanionLongRunReport,
  options: CompanionLongRunReportWriteOptions,
): Promise<CompanionLongRunReportWriteResult> {
  if (!isAbsolute(options.reportDir) || !isAbsolute(options.workspaceRoot)) {
    throw new TypeError("reportDir and workspaceRoot must be absolute paths.");
  }
  const reportDir = resolve(options.reportDir);
  const workspaceRoot = resolve(options.workspaceRoot);
  const relativeReportDir = relative(workspaceRoot, reportDir);
  if (
    relativeReportDir === "" ||
    relativeReportDir === ".." ||
    relativeReportDir.startsWith(
      `..${process.platform === "win32" ? "\\" : "/"}`,
    ) ||
    isAbsolute(relativeReportDir)
  ) {
    throw new TypeError("reportDir must be a child of workspaceRoot.");
  }
  const partialSequence = options.partialSequence;
  if (partialSequence !== undefined) {
    if (report.status !== "PARTIAL") {
      throw new TypeError("A partial report write requires PARTIAL status.");
    }
    if (!shouldWriteCompanionLongRunCheckpoint(report.logicalTurnCount)) {
      throw new TypeError("Partial reports are written only every 10 turns.");
    }
  }
  const names = artifactNamesFor(
    report.runId,
    partialSequence,
    report.logicalTurnCount,
  );
  const reportWithArtifacts: CompanionLongRunReport = {
    ...report,
    artifacts: { ...report.artifacts, ...names },
    ...(partialSequence === undefined
      ? {}
      : {
          checkpoint: {
            lastCompletedTurn: report.logicalTurnCount,
            partialSequence,
          },
        }),
  };
  validateReportInvariants(reportWithArtifacts);
  const secrets = [workspaceRoot, reportDir, ...(options.secrets ?? [])];
  const json = renderCompanionLongRunReportJson(reportWithArtifacts, secrets);
  const markdown = renderCompanionLongRunReportMarkdown(
    reportWithArtifacts,
    secrets,
  );
  const jsonPath = join(reportDir, names.json);
  const markdownPath = join(reportDir, names.markdown);
  await mkdir(reportDir, { recursive: true });
  await assertTargetsAbsent([jsonPath, markdownPath]);
  const jsonTemporaryPath = `${jsonPath}.tmp-${process.pid}-${randomUUID()}`;
  const markdownTemporaryPath = `${markdownPath}.tmp-${process.pid}-${randomUUID()}`;
  let jsonPublished = false;
  try {
    await writeSyncedFile(jsonTemporaryPath, json);
    await writeSyncedFile(markdownTemporaryPath, markdown);
    await rename(jsonTemporaryPath, jsonPath);
    jsonPublished = true;
    await rename(markdownTemporaryPath, markdownPath);
  } catch (error) {
    await Promise.all([
      unlinkIfPresent(jsonTemporaryPath),
      unlinkIfPresent(markdownTemporaryPath),
      ...(jsonPublished ? [unlinkIfPresent(jsonPath)] : []),
    ]);
    throw error;
  }
  return { jsonPath, markdownPath };
}

export function shouldWriteCompanionLongRunCheckpoint(
  completedTurnCount: number,
): boolean {
  return completedTurnCount > 0 && completedTurnCount % 10 === 0;
}

export function redactCompanionLongRunReportValue(
  value: unknown,
  secrets: readonly string[] = [],
): unknown {
  const secretVariants = buildSecretVariants(secrets);
  return redactValue(value, secretVariants, new WeakSet<object>());
}

export function scanCompanionLongRunReportSafety(
  value: unknown,
  secrets: readonly string[] = [],
): CompanionLongRunSafetyFinding[] {
  const findings: CompanionLongRunSafetyFinding[] = [];
  scanForbiddenKeys(value, "$", findings, new WeakSet<object>());
  const serialized = typeof value === "string" ? value : safeStringify(value);
  const checks: ReadonlyArray<readonly [string, RegExp]> = [
    ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/iu],
    ["provider_api_key", /\bsk-[A-Za-z0-9_-]{10,}/iu],
    ["file_uri", /file:\/{2,3}[^\s"'<>]+/iu],
  ];
  for (const [code, pattern] of checks) {
    if (pattern.test(serialized)) findings.push({ code });
  }
  const textValues = collectTextValues(value);
  const pathChecks: ReadonlyArray<readonly [string, RegExp]> = [
    ["absolute_windows_extended_path", WINDOWS_EXTENDED_PATH_PATTERN],
    ["absolute_windows_unc_path", WINDOWS_UNC_PATH_PATTERN],
    ["absolute_windows_path", WINDOWS_PATH_PATTERN],
    ["absolute_posix_path", POSIX_PATH_PATTERN],
  ];
  for (const [code, pattern] of pathChecks) {
    if (textValues.some((text) => hasPathOutsideWebUrl(text, pattern))) {
      findings.push({ code });
    }
  }
  for (const secret of buildSecretVariants(secrets)) {
    if (secret.length >= 4 && serialized.includes(secret)) {
      findings.push({ code: "known_secret" });
      break;
    }
  }
  return deduplicateFindings(findings);
}

export function assertCompanionLongRunReportSafe(
  value: unknown,
  secrets: readonly string[] = [],
): void {
  const findings = scanCompanionLongRunReportSafety(value, secrets);
  if (findings.length > 0) {
    throw new CompanionLongRunReportSafetyError(findings);
  }
}

export function aggregateAssertions(
  assertions: readonly LongRunAssertionResult[],
): LongRunAssertionSummary {
  const results = assertions.map(projectAssertion);
  return {
    total: results.length,
    passed: results.filter((assertion) => assertion.passed).length,
    failed: results.filter((assertion) => !assertion.passed).length,
    hardFailed: results.filter(
      (assertion) => !assertion.passed && assertion.hard !== false,
    ).length,
    results,
  };
}

export function aggregatePhases(
  turns: readonly CompanionLongRunTurnReport[],
): LongRunPhaseReport[] {
  const phases = new Map<string, CompanionLongRunTurnReport[]>();
  for (const turn of turns) {
    const current = phases.get(turn.phase) ?? [];
    current.push(turn);
    phases.set(turn.phase, current);
  }
  return [...phases.entries()].map(([phase, phaseTurns]) => {
    const assertions = phaseTurns.flatMap((turn) => turn.assertions);
    return {
      phase,
      firstTurn: Math.min(...phaseTurns.map((turn) => turn.number)),
      lastTurn: Math.max(...phaseTurns.map((turn) => turn.number)),
      turnCount: phaseTurns.length,
      assertionCount: assertions.length,
      assertionFailureCount: assertions.filter((assertion) => !assertion.passed)
        .length,
      hardAssertionFailureCount: assertions.filter(
        (assertion) => !assertion.passed && assertion.hard !== false,
      ).length,
    };
  });
}

export function aggregateLlmUsage(
  calls: readonly LongRunLlmCallReport[],
): LongRunLlmUsageReport {
  const byPurpose = new Map<string, LongRunLlmCallReport[]>();
  for (const call of calls) {
    const current = byPurpose.get(call.purpose) ?? [];
    current.push(call);
    byPurpose.set(call.purpose, current);
  }
  const purposeReports = [...byPurpose.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([purpose, purposeCalls]) => {
      const latencies = purposeCalls
        .map((call) => call.latencyMs)
        .sort((left, right) => left - right);
      const usage = aggregateTokenUsage(purposeCalls);
      return {
        purpose,
        calls: purposeCalls.length,
        successfulCalls: purposeCalls.filter((call) => call.success).length,
        failedCalls: purposeCalls.filter((call) => !call.success).length,
        attemptCount: sum(purposeCalls.map(attemptCountForCall)),
        failedAttemptCount: sum(purposeCalls.map(failedAttemptCountForCall)),
        ...usage,
        latencyMsP50: percentile(latencies, 0.5),
        latencyMsP95: percentile(latencies, 0.95),
        latencyMsMax: latencies.at(-1) ?? 0,
      };
    });
  const usage = aggregateTokenUsage(calls);
  return {
    calls: calls.length,
    successfulCalls: calls.filter((call) => call.success).length,
    failedCalls: calls.filter((call) => !call.success).length,
    attemptCount: sum(calls.map(attemptCountForCall)),
    failedAttemptCount: sum(calls.map(failedAttemptCountForCall)),
    ...usage,
    byPurpose: purposeReports,
  };
}

function aggregateTokenUsage(calls: readonly LongRunLlmCallReport[]): {
  inputTokens: number;
  outputTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  providerInputTokens: number;
  providerOutputTokens: number;
  comparableEstimatedInputTokens: number;
  comparableEstimatedOutputTokens: number;
  inputTokenError: number;
  outputTokenError: number;
  providerUsageCalls: number;
  providerInputUsageAttemptCount: number;
  providerOutputUsageAttemptCount: number;
  exactAttemptTelemetryCalls: number;
  completeProviderUsageCalls: number;
} {
  const estimatedInputTokens = sum(calls.map((call) => call.inputTokens ?? 0));
  const estimatedOutputTokens = sum(
    calls.map((call) => call.outputTokens ?? 0),
  );
  const providerInputTokens = sum(
    calls.map((call) => call.providerInputTokens ?? 0),
  );
  const providerOutputTokens = sum(
    calls.map((call) => call.providerOutputTokens ?? 0),
  );
  const comparableEstimatedInputTokens = sum(
    calls.map((call) =>
      call.providerInputTokens === undefined ? 0 : (call.inputTokens ?? 0),
    ),
  );
  const comparableEstimatedOutputTokens = sum(
    calls.map((call) =>
      call.providerOutputTokens === undefined ? 0 : (call.outputTokens ?? 0),
    ),
  );
  return {
    inputTokens: sum(
      calls.map((call) => call.providerInputTokens ?? call.inputTokens ?? 0),
    ),
    outputTokens: sum(
      calls.map((call) => call.providerOutputTokens ?? call.outputTokens ?? 0),
    ),
    estimatedInputTokens,
    estimatedOutputTokens,
    providerInputTokens,
    providerOutputTokens,
    comparableEstimatedInputTokens,
    comparableEstimatedOutputTokens,
    inputTokenError: providerInputTokens - comparableEstimatedInputTokens,
    outputTokenError: providerOutputTokens - comparableEstimatedOutputTokens,
    providerUsageCalls: calls.filter(
      (call) =>
        call.providerInputTokens !== undefined ||
        call.providerOutputTokens !== undefined,
    ).length,
    providerInputUsageAttemptCount: sum(
      calls.map((call) => call.providerInputUsageAttemptCount ?? 0),
    ),
    providerOutputUsageAttemptCount: sum(
      calls.map((call) => call.providerOutputUsageAttemptCount ?? 0),
    ),
    exactAttemptTelemetryCalls: calls.filter(
      (call) => call.attemptTelemetrySource === "exact",
    ).length,
    completeProviderUsageCalls: calls.filter(hasCompleteProviderUsage).length,
  };
}

function hasCompleteProviderUsage(call: LongRunLlmCallReport): boolean {
  const attempts = attemptCountForCall(call);
  return (
    call.attemptTelemetrySource === "exact" &&
    attempts >= 1 &&
    call.providerInputUsageAttemptCount === attempts &&
    call.providerOutputUsageAttemptCount === attempts &&
    call.providerInputTokens !== undefined &&
    call.providerOutputTokens !== undefined
  );
}

function attemptCountForCall(call: LongRunLlmCallReport): number {
  return call.attemptCount ?? call.attempt;
}

function failedAttemptCountForCall(call: LongRunLlmCallReport): number {
  return (
    call.failedAttemptCount ?? (call.success ? 0 : attemptCountForCall(call))
  );
}

function prepareReportForOutput(
  report: CompanionLongRunReport,
  secrets: readonly string[],
): CompanionLongRunReport {
  assertNoForbiddenKeys(report);
  validateReportInvariants(report);
  const projected = projectReport(report);
  const redacted = redactCompanionLongRunReportValue(projected, secrets);
  assertCompanionLongRunReportSafe(redacted, secrets);
  return redacted as CompanionLongRunReport;
}

function renderReleaseMatrixMarkdown(
  matrix: LongRunReleaseMatrixReport,
  report: CompanionLongRunReport,
): string[] {
  const children = [...matrix.children].sort(
    (left, right) => left.runIndex - right.runIndex,
  );
  return [
    "## Release matrix children",
    "",
    `Observed ${String(children.length)} of ${String(matrix.expectedRuns)} runs; ${String(report.logicalTurnCount)} / ${String(report.requestedTurnCount)} logical turns; ${String(report.llmUsageSummary.calls)} LLM calls; provider actual ${String(report.llmUsageSummary.providerInputTokens ?? 0)} input + ${String(report.llmUsageSummary.providerOutputTokens ?? 0)} output tokens.`,
    "",
    "| Index | Run ID | Database | Status | Turns | Calls | LLM P95 | Provider tokens |",
    "| ---: | --- | --- | --- | ---: | ---: | ---: | ---: |",
    ...children.map((child) =>
      rowCells([
        child.runIndex,
        child.runId,
        child.databaseLabel,
        `${child.status} (${child.completionReason})`,
        `${String(child.logicalTurnCount)} / ${String(child.requestedTurnCount)}`,
        child.llmCallCount,
        `${String(child.p95LlmLatencyMs)} ms`,
        `${String(child.providerInputTokens)} in + ${String(child.providerOutputTokens)} out`,
      ]),
    ),
    "",
    "| Index | Repository head | Diff fingerprint | Scenario | Provider / model | JSON artifact | Markdown artifact |",
    "| ---: | --- | --- | --- | --- | --- | --- |",
    ...children.map((child) =>
      rowCells([
        child.runIndex,
        child.repoHead,
        child.gitDiffFingerprint,
        child.scenarioVersion,
        `${child.provider} / ${child.model}`,
        child.jsonArtifact,
        child.markdownArtifact,
      ]),
    ),
    "",
  ];
}

function projectReport(report: CompanionLongRunReport): CompanionLongRunReport {
  return buildCompanionLongRunReport({
    runId: report.runId,
    scenarioVersion: report.scenarioVersion,
    repoHead: report.repoHead,
    worktreeDirty: report.worktreeDirty,
    gitDiffStat: report.gitDiffStat,
    gitDiffFingerprint: report.gitDiffFingerprint,
    untrackedFileCount: report.untrackedFileCount,
    startedAtUtc: report.startedAtUtc,
    completedAtUtc: report.completedAtUtc,
    status: report.status,
    ...(report.completionReason === undefined
      ? {}
      : { completionReason: report.completionReason }),
    provider: report.provider,
    ...(report.providerMode === undefined
      ? {}
      : { providerMode: report.providerMode }),
    model: report.model,
    clockMode: report.clockMode,
    pipelineExpectation: report.pipelineExpectation,
    requestedTurnCount: report.requestedTurnCount,
    httpExchangeCount: report.httpExchangeCount,
    ...(report.runHttp === undefined ? {} : { runHttp: report.runHttp }),
    turns: report.turns,
    ...(report.runLlmCalls === undefined
      ? {}
      : { runLlmCalls: report.runLlmCalls }),
    ...(report.releaseMatrix === undefined
      ? {}
      : { releaseMatrix: report.releaseMatrix }),
    runAssertions: report.assertions.filter(
      (assertion) =>
        assertion.scope === "run" || assertion.turnNumber === undefined,
    ),
    metrics: report.metrics,
    metricDetails: report.metricDetails,
    artifactLabels: {
      ...(report.artifacts.database === undefined
        ? {}
        : { database: report.artifacts.database }),
      ...(report.artifacts.log === undefined
        ? {}
        : { log: report.artifacts.log }),
    },
    ...(report.failure === undefined ? {} : { failure: report.failure }),
    ...(report.checkpoint === undefined
      ? {}
      : { partialSequence: report.checkpoint.partialSequence }),
  });
}

function projectTurn(
  turn: CompanionLongRunTurnReport,
): CompanionLongRunTurnReport {
  return {
    number: turn.number,
    manifestTurnNumber: turn.manifestTurnNumber,
    phase: turn.phase,
    objective: turn.objective,
    sessionKey: turn.sessionKey,
    sessionId: turn.sessionId,
    clientMessageId: turn.clientMessageId,
    userText: turn.userText,
    actionsBefore: turn.actionsBefore.map(projectAction),
    expected: projectExpected(turn.expected),
    http: turn.http.map(projectHttpExchange),
    ...(turn.actualRoute === undefined
      ? {}
      : { actualRoute: turn.actualRoute }),
    ...(turn.observation === undefined
      ? {}
      : { observation: projectObservation(turn.observation) }),
    ...(turn.outcome === undefined
      ? {}
      : { outcome: projectOutcome(turn.outcome) }),
    contextPlan: {
      activatedTraitIds: [...turn.contextPlan.activatedTraitIds],
      activatedValueIds: [...turn.contextPlan.activatedValueIds],
      activatedContradictionIds: [
        ...turn.contextPlan.activatedContradictionIds,
      ],
      activatedGoalIds: [...turn.contextPlan.activatedGoalIds],
      activatedPreferenceIds: [...turn.contextPlan.activatedPreferenceIds],
      suppressedGoalIds: [...turn.contextPlan.suppressedGoalIds],
      includeAutobiography: turn.contextPlan.includeAutobiography,
      includeCalendar: turn.contextPlan.includeCalendar,
      includeFutureSchedule: turn.contextPlan.includeFutureSchedule,
      includeRetrievedEvidence: turn.contextPlan.includeRetrievedEvidence,
      trace: turn.contextPlan.trace.map((item) => ({
        itemType: item.itemType,
        itemId: item.itemId,
        included: item.included,
        source: item.source,
        reasons: [...item.reasons],
        ...(item.sourceId === undefined ? {} : { sourceId: item.sourceId }),
      })),
    },
    promptSegmentTrace: turn.promptSegmentTrace.map(projectPromptTrace),
    selectedEvidenceIds: [...turn.selectedEvidenceIds],
    assistant: projectAssistant(turn.assistant),
    ...(turn.stateBefore === undefined
      ? {}
      : { stateBefore: projectSnapshot(turn.stateBefore) }),
    ...(turn.stateAfter === undefined
      ? {}
      : { stateAfter: projectSnapshot(turn.stateAfter) }),
    changes: projectChanges(turn.changes),
    domainEvents: turn.domainEvents.map(projectDomainEvent),
    retrieval: {
      runIds: [...turn.retrieval.runIds],
      selectedEvidenceIds: [...turn.retrieval.selectedEvidenceIds],
      evidenceMappings: turn.retrieval.evidenceMappings.map((mapping) => ({
        evidenceId: mapping.evidenceId,
        ...(mapping.sourceMessageId === undefined
          ? {}
          : { sourceMessageId: mapping.sourceMessageId }),
        ...(mapping.memoryId === undefined
          ? {}
          : { memoryId: mapping.memoryId }),
        currentTurnGrounded: mapping.currentTurnGrounded,
      })),
    },
    llmCalls: turn.llmCalls.map(projectLlmCall),
    assertions: turn.assertions.map((assertion) =>
      projectAssertion({
        ...assertion,
        turnNumber: assertion.turnNumber ?? turn.number,
      }),
    ),
    softMetricTags: [...turn.softMetricTags],
    ...(turn.failure === undefined
      ? {}
      : {
          failure: {
            code: turn.failure.code,
            stage: turn.failure.stage,
            retryable: turn.failure.retryable,
          },
        }),
  };
}

function projectReleaseMatrix(
  matrix: LongRunReleaseMatrixReport,
): LongRunReleaseMatrixReport {
  return {
    expectedRuns: matrix.expectedRuns,
    children: matrix.children.map((child) => ({
      runId: child.runId,
      runIndex: child.runIndex,
      databaseLabel: child.databaseLabel,
      status: child.status,
      completionReason: child.completionReason,
      requestedTurnCount: child.requestedTurnCount,
      logicalTurnCount: child.logicalTurnCount,
      llmCallCount: child.llmCallCount,
      p95LlmLatencyMs: child.p95LlmLatencyMs,
      providerInputTokens: child.providerInputTokens,
      providerOutputTokens: child.providerOutputTokens,
      repoHead: child.repoHead,
      worktreeDirty: child.worktreeDirty,
      gitDiffStat: child.gitDiffStat,
      gitDiffFingerprint: child.gitDiffFingerprint,
      untrackedFileCount: child.untrackedFileCount,
      scenarioVersion: child.scenarioVersion,
      provider: child.provider,
      model: child.model,
      jsonArtifact: child.jsonArtifact,
      markdownArtifact: child.markdownArtifact,
      resolvedTurnCount: child.resolvedTurnCount,
      strictResolvedTurnCount: child.strictResolvedTurnCount,
      safeFallbackTurnCount: child.safeFallbackTurnCount,
      unsafeUnderstandingFailureCount: child.unsafeUnderstandingFailureCount,
      understandingModelCallCount: child.understandingModelCallCount,
      successfulUnderstandingModelCallCount:
        child.successfulUnderstandingModelCallCount,
      failedUnderstandingModelCallCount:
        child.failedUnderstandingModelCallCount,
      providerUsageComplete: child.providerUsageComplete,
      modelComparable: child.modelComparable,
      completeAndPassing: child.completeAndPassing,
    })),
  };
}

function projectAction(action: ScenarioAction): ScenarioAction {
  switch (action.kind) {
    case "send_message":
      return { kind: "send_message" };
    case "create_session":
      return { kind: "create_session", key: action.key };
    case "restart_app":
      return { kind: "restart_app", preserveDatabase: true };
    case "set_clock_local":
      return { kind: "set_clock_local", localIso: action.localIso };
    case "set_clock_from_schedule_item":
      return {
        kind: "set_clock_from_schedule_item",
        selector: action.selector,
        relation: action.relation,
        offsetMinutes: action.offsetMinutes,
      };
    case "set_clock_in_runtime_window":
      return {
        kind: "set_clock_in_runtime_window",
        window: action.window,
        offsetMinutes: action.offsetMinutes,
      };
    case "advance_clock":
      return { kind: "advance_clock", durationMinutes: action.durationMinutes };
    case "settle_agent":
      return { kind: "settle_agent" };
    case "allocate_free_slot":
      return {
        kind: "allocate_free_slot",
        key: action.key,
        durationMinutes: action.durationMinutes,
      };
    case "repeat_same_client_message_id":
      return { kind: "repeat_same_client_message_id" };
  }
}

function projectExpected(
  expected: CompanionTurnExpected,
): CompanionTurnExpected {
  return {
    ...(expected.route === undefined ? {} : { route: expected.route }),
    mainGoalActivated: expected.mainGoalActivated,
    goalExpectation: expected.goalExpectation,
    scheduleExpectation: expected.scheduleExpectation,
    ...(expected.scheduleRef === undefined
      ? {}
      : { scheduleRef: expected.scheduleRef }),
    ...(expected.requiredAnchors === undefined
      ? {}
      : { requiredAnchors: [...expected.requiredAnchors] }),
    ...(expected.forbiddenAnchors === undefined
      ? {}
      : { forbiddenAnchors: [...expected.forbiddenAnchors] }),
    ...(expected.memoryExpectation === undefined
      ? {}
      : { memoryExpectation: expected.memoryExpectation }),
    ...(expected.careExpectation === undefined
      ? {}
      : { careExpectation: expected.careExpectation }),
    ...(expected.timeExpectation === undefined
      ? {}
      : { timeExpectation: expected.timeExpectation }),
    ...(expected.relationshipExpectation === undefined
      ? {}
      : { relationshipExpectation: expected.relationshipExpectation }),
    ...(expected.crossSessionExpectation === undefined
      ? {}
      : { crossSessionExpectation: expected.crossSessionExpectation }),
    ...(expected.responseConstraints === undefined
      ? {}
      : {
          responseConstraints: {
            ...(expected.responseConstraints.maxAdvicePoints === undefined
              ? {}
              : {
                  maxAdvicePoints: expected.responseConstraints.maxAdvicePoints,
                }),
            ...(expected.responseConstraints.minSentences === undefined
              ? {}
              : { minSentences: expected.responseConstraints.minSentences }),
            ...(expected.responseConstraints.maxSentences === undefined
              ? {}
              : { maxSentences: expected.responseConstraints.maxSentences }),
            ...(expected.responseConstraints.preferShortReply === undefined
              ? {}
              : {
                  preferShortReply:
                    expected.responseConstraints.preferShortReply,
                }),
          },
        }),
    hardAssertionCodes: [...expected.hardAssertionCodes],
    ...(expected.softMetricTags === undefined
      ? {}
      : { softMetricTags: [...expected.softMetricTags] }),
  };
}

function projectObservation(
  observation: LongRunObservationReport,
): LongRunObservationReport {
  return {
    origin: observation.origin,
    route: observation.route,
    ...(observation.confidence === undefined
      ? {}
      : { confidence: observation.confidence }),
    ...(observation.dialogueActs === undefined
      ? {}
      : { dialogueActs: [...observation.dialogueActs] }),
    ...(observation.topicKeys === undefined
      ? {}
      : { topicKeys: [...observation.topicKeys] }),
    ...(observation.topicDomains === undefined
      ? {}
      : { topicDomains: [...observation.topicDomains] }),
    ...(observation.scheduleIntentKind === undefined
      ? {}
      : { scheduleIntentKind: observation.scheduleIntentKind }),
    ...(observation.salientUserQuotes === undefined
      ? {}
      : { salientUserQuotes: [...observation.salientUserQuotes] }),
    ...(observation.uncertaintyCodes === undefined
      ? {}
      : { uncertaintyCodes: [...observation.uncertaintyCodes] }),
    ...(observation.rejectedFieldCodes === undefined
      ? {}
      : { rejectedFieldCodes: [...observation.rejectedFieldCodes] }),
    ...(observation.worldEffectCandidateCounts === undefined
      ? {}
      : {
          worldEffectCandidateCounts: {
            ...observation.worldEffectCandidateCounts,
          },
        }),
  };
}

function projectOutcome(outcome: LongRunOutcomeReport): LongRunOutcomeReport {
  return {
    route: outcome.route,
    scheduleOutcomeKind: outcome.scheduleOutcomeKind,
    decisionPath: outcome.decisionPath,
    worldEffectsMode: outcome.worldEffectsMode,
    worldEffectWritesEnabled: outcome.worldEffectWritesEnabled,
    scheduleWritesEnabled: outcome.scheduleWritesEnabled,
    ...(outcome.scheduleWritesEnabledSource === undefined
      ? {}
      : { scheduleWritesEnabledSource: outcome.scheduleWritesEnabledSource }),
    stateChanged: outcome.stateChanged,
    dryRun: outcome.dryRun,
    ...(outcome.dryRunSource === undefined
      ? {}
      : { dryRunSource: outcome.dryRunSource }),
    ...(outcome.replyMutationAuthorization === undefined
      ? {}
      : { replyMutationAuthorization: outcome.replyMutationAuthorization }),
    ...(outcome.replyDirectiveMode === undefined
      ? {}
      : { replyDirectiveMode: outcome.replyDirectiveMode }),
    acceptedEffectCounts: { ...outcome.acceptedEffectCounts },
    proposalRejectionCodes: [...outcome.proposalRejectionCodes],
  };
}

function projectPromptTrace(
  trace: LongRunPromptSegmentTraceReport,
): LongRunPromptSegmentTraceReport {
  return {
    id: trace.id,
    placement: trace.placement,
    priority: trace.priority,
    tokenBudget: trace.tokenBudget,
    estimatedTokens: trace.estimatedTokens,
    required: trace.required,
    included: trace.included,
    truncated: trace.truncated,
    cacheHit: trace.cacheHit,
    ...(trace.reason === undefined ? {} : { reason: trace.reason }),
  };
}

function projectAssistant(
  assistant: LongRunAssistantReport,
): LongRunAssistantReport {
  return {
    text: assistant.text,
    chunkCount: assistant.chunkCount,
    repairAttempted: assistant.repairAttempted,
    usedFallback: assistant.usedFallback,
    ...(assistant.reasonCode === undefined
      ? {}
      : { reasonCode: assistant.reasonCode }),
    ...(assistant.issueCodes === undefined
      ? {}
      : { issueCodes: [...assistant.issueCodes] }),
  };
}

function projectSnapshot(
  snapshot: LongRunAuthoritySnapshotReport,
): LongRunAuthoritySnapshotReport {
  return {
    ...(snapshot.runtimeState === undefined
      ? {}
      : {
          runtimeState: {
            ...snapshot.runtimeState,
            ...(snapshot.runtimeState.relationship === undefined
              ? {}
              : { relationship: { ...snapshot.runtimeState.relationship } }),
          },
        }),
    ...(snapshot.schedule === undefined
      ? {}
      : { schedule: snapshot.schedule.map((item) => ({ ...item })) }),
    ...(snapshot.scheduleCommitLineage === undefined
      ? {}
      : {
          scheduleCommitLineage: snapshot.scheduleCommitLineage.map(
            (lineage) => ({ ...lineage }),
          ),
        }),
    ...(snapshot.memoryCount === undefined
      ? {}
      : { memoryCount: snapshot.memoryCount }),
    ...(snapshot.careCueCount === undefined
      ? {}
      : { careCueCount: snapshot.careCueCount }),
    ...(snapshot.followUpCount === undefined
      ? {}
      : { followUpCount: snapshot.followUpCount }),
    ...(snapshot.domainEventCount === undefined
      ? {}
      : { domainEventCount: snapshot.domainEventCount }),
  };
}

function projectChanges(changes: LongRunChangeReport): LongRunChangeReport {
  return {
    stateChanged: changes.stateChanged,
    ...(changes.scheduleItemIdsAdded === undefined
      ? {}
      : { scheduleItemIdsAdded: [...changes.scheduleItemIdsAdded] }),
    ...(changes.scheduleItemIdsUpdated === undefined
      ? {}
      : { scheduleItemIdsUpdated: [...changes.scheduleItemIdsUpdated] }),
    ...(changes.memoryIdsAdded === undefined
      ? {}
      : { memoryIdsAdded: [...changes.memoryIdsAdded] }),
    ...(changes.memoryIdsUpdated === undefined
      ? {}
      : { memoryIdsUpdated: [...changes.memoryIdsUpdated] }),
    ...(changes.careCueIdsAdded === undefined
      ? {}
      : { careCueIdsAdded: [...changes.careCueIdsAdded] }),
    ...(changes.careCueIdsUpdated === undefined
      ? {}
      : { careCueIdsUpdated: [...changes.careCueIdsUpdated] }),
    ...(changes.followUpIdsAdded === undefined
      ? {}
      : { followUpIdsAdded: [...changes.followUpIdsAdded] }),
    ...(changes.followUpIdsUpdated === undefined
      ? {}
      : { followUpIdsUpdated: [...changes.followUpIdsUpdated] }),
    ...(changes.memoryRejectionCodes === undefined
      ? {}
      : { memoryRejectionCodes: [...changes.memoryRejectionCodes] }),
    ...(changes.careCueRejectionCodes === undefined
      ? {}
      : { careCueRejectionCodes: [...changes.careCueRejectionCodes] }),
    ...(changes.followUpRejectionCodes === undefined
      ? {}
      : { followUpRejectionCodes: [...changes.followUpRejectionCodes] }),
  };
}

function projectHttpExchange(
  exchange: LongRunHttpExchangeReport,
): LongRunHttpExchangeReport {
  return {
    label: exchange.label,
    method: exchange.method,
    route: exchange.route.split(/[?#]/u, 1)[0] ?? exchange.route,
    status: exchange.status,
    durationMs: exchange.durationMs,
    ...(exchange.requestId === undefined
      ? {}
      : { requestId: exchange.requestId }),
    ...(exchange.idempotentReplay === undefined
      ? {}
      : { idempotentReplay: exchange.idempotentReplay }),
  };
}

function projectDomainEvent(
  event: LongRunDomainEventReport,
): LongRunDomainEventReport {
  return {
    id: event.id,
    type: event.type,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    occurredAtUtc: event.occurredAtUtc,
    ...(event.correlationId === undefined
      ? {}
      : { correlationId: event.correlationId }),
    ...(event.causationId === undefined
      ? {}
      : { causationId: event.causationId }),
    ...(event.entityIds === undefined
      ? {}
      : { entityIds: [...event.entityIds] }),
    ...(event.reasonCodes === undefined
      ? {}
      : { reasonCodes: [...event.reasonCodes] }),
  };
}

function projectLlmCall(call: LongRunLlmCallReport): LongRunLlmCallReport {
  const attemptCount = attemptCountForCall(call);
  const failedAttemptCount = failedAttemptCountForCall(call);
  return {
    purpose: call.purpose,
    provider: call.provider,
    model: call.model,
    attempt: attemptCount,
    attemptCount,
    failedAttemptCount,
    ...(call.providerInputUsageAttemptCount === undefined
      ? {}
      : {
          providerInputUsageAttemptCount: call.providerInputUsageAttemptCount,
        }),
    ...(call.providerOutputUsageAttemptCount === undefined
      ? {}
      : {
          providerOutputUsageAttemptCount: call.providerOutputUsageAttemptCount,
        }),
    ...(call.attemptTelemetrySource === undefined
      ? {}
      : { attemptTelemetrySource: call.attemptTelemetrySource }),
    latencyMs: call.latencyMs,
    success: call.success,
    ...(call.status === undefined ? {} : { status: call.status }),
    ...(call.inputTokens === undefined
      ? {}
      : { inputTokens: call.inputTokens }),
    ...(call.outputTokens === undefined
      ? {}
      : { outputTokens: call.outputTokens }),
    ...(call.providerInputTokens === undefined
      ? {}
      : { providerInputTokens: call.providerInputTokens }),
    ...(call.providerOutputTokens === undefined
      ? {}
      : { providerOutputTokens: call.providerOutputTokens }),
    ...(call.usageSource === undefined
      ? {}
      : { usageSource: call.usageSource }),
    ...(call.errorCode === undefined ? {} : { errorCode: call.errorCode }),
  };
}

function projectAssertion(
  assertion: LongRunAssertionResult,
): LongRunAssertionResult {
  return {
    ...(assertion.id === undefined ? {} : { id: assertion.id }),
    code: assertion.code,
    passed: assertion.passed,
    message: assertion.message,
    hard: assertion.hard ?? true,
    scope:
      assertion.scope ?? (assertion.turnNumber === undefined ? "run" : "turn"),
    ...(assertion.turnNumber === undefined
      ? {}
      : { turnNumber: assertion.turnNumber }),
    ...(assertion.expected === undefined
      ? {}
      : { expected: assertion.expected }),
    ...(assertion.actual === undefined ? {} : { actual: assertion.actual }),
    ...(assertion.evidence === undefined
      ? {}
      : {
          evidence: assertion.evidence.map((item) => ({
            key: item.key,
            value: item.value,
          })),
        }),
  };
}

function projectMetric(metric: LongRunMetricResult): LongRunMetricResult {
  return {
    name: metric.name,
    value: metric.value,
    ...(metric.unit === undefined ? {} : { unit: metric.unit }),
    ...(metric.passed === undefined ? {} : { passed: metric.passed }),
    ...(metric.comparator === undefined
      ? {}
      : { comparator: metric.comparator }),
    ...(metric.threshold === undefined ? {} : { threshold: metric.threshold }),
    ...(metric.numerator === undefined ? {} : { numerator: metric.numerator }),
    ...(metric.denominator === undefined
      ? {}
      : { denominator: metric.denominator }),
    ...(metric.failedTurnNumbers === undefined
      ? {}
      : { failedTurnNumbers: [...metric.failedTurnNumbers] }),
    ...(metric.failedManifestTurnNumbers === undefined
      ? {}
      : {
          failedManifestTurnNumbers: [...metric.failedManifestTurnNumbers],
        }),
    ...(metric.source === undefined ? {} : { source: metric.source }),
  };
}

function formatMetricFailedTurns(
  metric: LongRunMetricResult | undefined,
): string {
  if (
    metric?.failedTurnNumbers === undefined &&
    metric?.failedManifestTurnNumbers === undefined
  ) {
    return "—";
  }
  const runTurns = metric.failedTurnNumbers ?? [];
  const manifestTurns = metric.failedManifestTurnNumbers ?? [];
  if (runTurns.length === 0 && manifestTurns.length === 0) return "none";
  return `run: ${runTurns.join(",") || "—"}; manifest: ${
    manifestTurns.join(",") || "—"
  }`;
}

function projectMetricValues(
  metrics: Readonly<Record<string, LongRunMetricValue>>,
): Record<string, LongRunMetricValue> {
  return Object.fromEntries(
    Object.entries(metrics)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, value]),
  );
}

function projectFailure(
  failure: CompanionLongRunFailureReport,
): CompanionLongRunFailureReport {
  return {
    code: failure.code,
    stage: failure.stage,
    message: failure.message,
    ...(failure.turnNumber === undefined
      ? {}
      : { turnNumber: failure.turnNumber }),
    ...(failure.retryable === undefined
      ? {}
      : { retryable: failure.retryable }),
  };
}

function failureForCompletionReason(
  completionReason: string | undefined,
): CompanionLongRunFailureReport | undefined {
  switch (completionReason) {
    case "budget_limit":
      return {
        code: "budget_limit",
        stage: "budget_limit",
        message: "Run stopped after reaching the configured token budget.",
      };
    case "runner_error":
      return {
        code: "runner_error",
        stage: "runner_error",
        message: "Run stopped because the runner reported an error.",
      };
    case "paid_opt_in_missing":
      return {
        code: "paid_opt_in_missing",
        stage: "paid_opt_in_missing",
        message: "Paid provider opt-in or configuration was unavailable.",
      };
    default:
      return undefined;
  }
}

function validateReportInvariants(report: CompanionLongRunReport): void {
  if (
    !Number.isInteger(report.requestedTurnCount) ||
    report.requestedTurnCount < 0
  ) {
    throw new TypeError("requestedTurnCount must be a non-negative integer.");
  }
  if (report.logicalTurnCount !== report.turns.length) {
    throw new TypeError("logicalTurnCount must equal turns.length.");
  }
  if (
    report.runHttp !== undefined &&
    report.httpExchangeCount !==
      report.runHttp.length +
        report.turns.reduce((count, turn) => count + turn.http.length, 0)
  ) {
    throw new TypeError(
      "httpExchangeCount must equal runHttp plus turn HTTP evidence.",
    );
  }
  for (const [index, turn] of report.turns.entries()) {
    if (turn.number !== index + 1) {
      throw new TypeError("Turn numbers must be unique and sequential from 1.");
    }
    if (
      !Number.isInteger(turn.manifestTurnNumber) ||
      turn.manifestTurnNumber < 1
    ) {
      throw new TypeError("manifestTurnNumber must be a positive integer.");
    }
  }
  if (report.status === "PASS") {
    if (report.logicalTurnCount !== report.requestedTurnCount) {
      throw new TypeError("PASS requires all requested turns to complete.");
    }
    if (
      report.failure !== undefined ||
      report.assertionSummary.hardFailed > 0
    ) {
      throw new TypeError(
        "PASS cannot contain a failure or failed hard assertion.",
      );
    }
  }
  if (report.status === "PARTIAL") {
    if (
      report.checkpoint !== undefined &&
      report.checkpoint.lastCompletedTurn !== report.logicalTurnCount
    ) {
      throw new TypeError("Checkpoint turn must equal logicalTurnCount.");
    }
  }
  for (const metric of report.metricDetails) {
    const hasNumerator = metric.numerator !== undefined;
    const hasDenominator = metric.denominator !== undefined;
    if (hasNumerator !== hasDenominator) {
      throw new TypeError(
        `Metric ${metric.name} must provide numerator and denominator together.`,
      );
    }
    if (
      metric.numerator !== undefined &&
      metric.denominator !== undefined &&
      (!Number.isInteger(metric.numerator) ||
        !Number.isInteger(metric.denominator) ||
        metric.numerator < 0 ||
        metric.denominator < metric.numerator)
    ) {
      throw new TypeError(
        `Metric ${metric.name} has an invalid numerator or denominator.`,
      );
    }
    const hasFailedRunTurns = metric.failedTurnNumbers !== undefined;
    const hasFailedManifestTurns =
      metric.failedManifestTurnNumbers !== undefined;
    if (hasFailedRunTurns !== hasFailedManifestTurns) {
      throw new TypeError(
        `Metric ${metric.name} must provide both failed turn sets.`,
      );
    }
    if (
      metric.failedTurnNumbers !== undefined &&
      metric.failedManifestTurnNumbers !== undefined &&
      (metric.failedTurnNumbers.length !==
        metric.failedManifestTurnNumbers.length ||
        (metric.denominator !== undefined &&
          metric.numerator !== undefined &&
          metric.failedTurnNumbers.length !==
            metric.denominator - metric.numerator))
    ) {
      throw new TypeError(
        `Metric ${metric.name} failed turn sets do not match its sample.`,
      );
    }
  }
  const allNumbers = [
    report.httpExchangeCount,
    report.sessionCount,
    report.restartCount,
    ...(report.runHttp ?? []).flatMap((exchange) => [
      exchange.status,
      exchange.durationMs,
    ]),
    ...report.metricDetails.flatMap((metric) => [
      metric.value,
      ...(metric.threshold === undefined ? [] : [metric.threshold]),
      ...(metric.numerator === undefined ? [] : [metric.numerator]),
      ...(metric.denominator === undefined ? [] : [metric.denominator]),
      ...(metric.failedTurnNumbers ?? []),
      ...(metric.failedManifestTurnNumbers ?? []),
    ]),
    ...report.turns.flatMap((turn) =>
      turn.llmCalls.flatMap((call) => [
        call.attempt,
        ...(call.attemptCount === undefined ? [] : [call.attemptCount]),
        ...(call.failedAttemptCount === undefined
          ? []
          : [call.failedAttemptCount]),
        ...(call.providerInputUsageAttemptCount === undefined
          ? []
          : [call.providerInputUsageAttemptCount]),
        ...(call.providerOutputUsageAttemptCount === undefined
          ? []
          : [call.providerOutputUsageAttemptCount]),
        call.latencyMs,
        ...(call.status === undefined ? [] : [call.status]),
        ...(call.inputTokens === undefined ? [] : [call.inputTokens]),
        ...(call.outputTokens === undefined ? [] : [call.outputTokens]),
        ...(call.providerInputTokens === undefined
          ? []
          : [call.providerInputTokens]),
        ...(call.providerOutputTokens === undefined
          ? []
          : [call.providerOutputTokens]),
      ]),
    ),
    ...(report.runLlmCalls ?? []).flatMap((call) => [
      call.attempt,
      ...(call.attemptCount === undefined ? [] : [call.attemptCount]),
      ...(call.failedAttemptCount === undefined
        ? []
        : [call.failedAttemptCount]),
      ...(call.providerInputUsageAttemptCount === undefined
        ? []
        : [call.providerInputUsageAttemptCount]),
      ...(call.providerOutputUsageAttemptCount === undefined
        ? []
        : [call.providerOutputUsageAttemptCount]),
      call.latencyMs,
      ...(call.status === undefined ? [] : [call.status]),
      ...(call.inputTokens === undefined ? [] : [call.inputTokens]),
      ...(call.outputTokens === undefined ? [] : [call.outputTokens]),
      ...(call.providerInputTokens === undefined
        ? []
        : [call.providerInputTokens]),
      ...(call.providerOutputTokens === undefined
        ? []
        : [call.providerOutputTokens]),
    ]),
  ];
  if (allNumbers.some((value) => !Number.isFinite(value))) {
    throw new TypeError("Report numeric values must be finite.");
  }
  const llmCalls = [
    ...report.turns.flatMap((turn) => turn.llmCalls),
    ...(report.runLlmCalls ?? []),
  ];
  if (
    llmCalls.some((call) => {
      const attemptCount = attemptCountForCall(call);
      const failedAttemptCount = failedAttemptCountForCall(call);
      const providerInputUsageAttemptCount =
        call.providerInputUsageAttemptCount ?? 0;
      const providerOutputUsageAttemptCount =
        call.providerOutputUsageAttemptCount ?? 0;
      const exactOutcomeAligned = call.success
        ? attemptCount >= 1 && failedAttemptCount < attemptCount
        : failedAttemptCount === attemptCount;
      return (
        !Number.isInteger(attemptCount) ||
        attemptCount < 0 ||
        !Number.isInteger(failedAttemptCount) ||
        failedAttemptCount < 0 ||
        failedAttemptCount > attemptCount ||
        !Number.isInteger(providerInputUsageAttemptCount) ||
        providerInputUsageAttemptCount < 0 ||
        providerInputUsageAttemptCount > attemptCount ||
        !Number.isInteger(providerOutputUsageAttemptCount) ||
        providerOutputUsageAttemptCount < 0 ||
        providerOutputUsageAttemptCount > attemptCount ||
        (call.attemptTelemetrySource === "exact" && !exactOutcomeAligned)
      );
    })
  ) {
    throw new TypeError("LLM attempt counts must be bounded integers.");
  }
  if (
    basename(report.artifacts.json) !== report.artifacts.json ||
    basename(report.artifacts.markdown) !== report.artifacts.markdown ||
    Object.values(report.artifacts).some(
      (label) => label === undefined || !isSafeRelativeLabel(label),
    )
  ) {
    throw new TypeError("Report artifact labels must be safe relative paths.");
  }
  if (report.releaseMatrix !== undefined) {
    validateReleaseMatrixInvariants(report, report.releaseMatrix);
  }
}

function validateReleaseMatrixInvariants(
  report: CompanionLongRunReport,
  matrix: LongRunReleaseMatrixReport,
): void {
  if (!Number.isInteger(matrix.expectedRuns) || matrix.expectedRuns < 1) {
    throw new TypeError("Release matrix expectedRuns must be positive.");
  }
  const integerValues = matrix.children.flatMap((child) => [
    child.runIndex,
    child.requestedTurnCount,
    child.logicalTurnCount,
    child.llmCallCount,
    child.p95LlmLatencyMs,
    child.providerInputTokens,
    child.providerOutputTokens,
    child.untrackedFileCount,
    child.resolvedTurnCount,
    child.strictResolvedTurnCount,
    child.safeFallbackTurnCount,
    child.unsafeUnderstandingFailureCount,
    child.understandingModelCallCount,
    child.successfulUnderstandingModelCallCount,
    child.failedUnderstandingModelCallCount,
  ]);
  if (
    integerValues.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    matrix.children.some((child) => child.runIndex < 1)
  ) {
    throw new TypeError(
      "Release matrix child counters must be non-negative safe integers.",
    );
  }
  if (
    matrix.children.some(
      (child) =>
        !isSafeRelativeLabel(child.databaseLabel) ||
        !isSafeRelativeLabel(child.jsonArtifact) ||
        !isSafeRelativeLabel(child.markdownArtifact),
    )
  ) {
    throw new TypeError(
      "Release matrix database and artifact labels must be safe relative paths.",
    );
  }
  if (
    report.requestedTurnCount !==
      sum(matrix.children.map((child) => child.requestedTurnCount)) ||
    report.logicalTurnCount !==
      sum(matrix.children.map((child) => child.logicalTurnCount)) ||
    report.llmUsageSummary.calls !==
      sum(matrix.children.map((child) => child.llmCallCount)) ||
    (report.llmUsageSummary.providerInputTokens ?? 0) !==
      sum(matrix.children.map((child) => child.providerInputTokens)) ||
    (report.llmUsageSummary.providerOutputTokens ?? 0) !==
      sum(matrix.children.map((child) => child.providerOutputTokens))
  ) {
    throw new TypeError(
      "Release matrix child totals must equal the aggregate report totals.",
    );
  }
  if (report.status !== "PASS") return;
  const nonEmptyProvenance = matrix.children.every(
    (child) =>
      child.runId.trim() !== "" &&
      child.repoHead.trim() !== "" &&
      child.gitDiffFingerprint.trim() !== "" &&
      child.scenarioVersion.trim() !== "" &&
      child.provider.trim() !== "" &&
      child.model.trim() !== "",
  );
  const uniqueIdentity =
    uniqueCount(matrix.children.map((child) => child.runId)) ===
      matrix.expectedRuns &&
    uniqueCount(matrix.children.map((child) => String(child.runIndex))) ===
      matrix.expectedRuns &&
    uniqueCount(
      matrix.children.map(
        (child) => normalizeSafeRelativeLabel(child.databaseLabel) ?? "",
      ),
    ) === matrix.expectedRuns &&
    uniqueCount(
      matrix.children.map(
        (child) => normalizeSafeRelativeLabel(child.jsonArtifact) ?? "",
      ),
    ) === matrix.expectedRuns &&
    uniqueCount(
      matrix.children.map(
        (child) => normalizeSafeRelativeLabel(child.markdownArtifact) ?? "",
      ),
    ) === matrix.expectedRuns &&
    uniqueCount(
      matrix.children.flatMap((child) => [
        normalizeSafeRelativeLabel(child.jsonArtifact) ?? "",
        normalizeSafeRelativeLabel(child.markdownArtifact) ?? "",
      ]),
    ) ===
      matrix.expectedRuns * 2;
  const sharedProvenance = [
    matrix.children.map((child) => child.repoHead),
    matrix.children.map((child) => child.gitDiffFingerprint),
    matrix.children.map((child) => child.scenarioVersion),
    matrix.children.map((child) => child.provider),
    matrix.children.map((child) => child.model),
  ].every((values) => uniqueCount(values) === 1);
  if (
    matrix.children.length !== matrix.expectedRuns ||
    !matrix.children.every(
      (child) =>
        child.status === "PASS" &&
        child.completionReason === "completed" &&
        child.logicalTurnCount === child.requestedTurnCount &&
        child.completeAndPassing,
    ) ||
    !nonEmptyProvenance ||
    !uniqueIdentity ||
    !sharedProvenance
  ) {
    throw new TypeError(
      "PASS release matrices require complete independent children with shared provenance.",
    );
  }
}

function uniqueCount(values: readonly string[]): number {
  return new Set(values).size;
}

function isSafeRelativeLabel(label: string): boolean {
  return normalizeSafeRelativeLabel(label) !== undefined;
}

function normalizeSafeRelativeLabel(label: string): string | undefined {
  if (label.length === 0 || isAbsolute(label) || label.includes("\0")) {
    return undefined;
  }
  const segments: string[] = [];
  for (const segment of label.replace(/\\/gu, "/").split("/")) {
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

function artifactNamesFor(
  runId: string,
  partialSequence: number | undefined,
  turnCount: number,
): { json: string; markdown: string } {
  const safeRunId = runId.replace(/[^A-Za-z0-9_-]/gu, "-").replace(/-+/gu, "-");
  if (safeRunId.length === 0)
    throw new TypeError("runId has no safe filename characters.");
  const stem =
    partialSequence === undefined
      ? safeRunId
      : `${safeRunId}.partial-${String(partialSequence).padStart(3, "0")}-t${String(turnCount).padStart(3, "0")}`;
  return { json: `${stem}.json`, markdown: `${stem}.md` };
}

function assertNoForbiddenKeys(value: unknown): void {
  const findings: CompanionLongRunSafetyFinding[] = [];
  scanForbiddenKeys(value, "$", findings, new WeakSet<object>());
  if (findings.length > 0) {
    throw new CompanionLongRunReportSafetyError(deduplicateFindings(findings));
  }
}

function scanForbiddenKeys(
  value: unknown,
  path: string,
  findings: CompanionLongRunSafetyFinding[],
  seen: WeakSet<object>,
): void {
  if (typeof value !== "object" || value === null) return;
  if (seen.has(value)) {
    findings.push({ code: "cyclic_value", path });
    return;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      scanForbiddenKeys(item, `${path}[${String(index)}]`, findings, seen);
    }
    seen.delete(value);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      findings.push({ code: "forbidden_field", path: `${path}.${key}` });
      continue;
    }
    scanForbiddenKeys(item, `${path}.${key}`, findings, seen);
  }
  seen.delete(value);
}

function redactValue(
  value: unknown,
  secrets: readonly string[],
  seen: WeakSet<object>,
): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (value === undefined) return undefined;
  if (typeof value !== "object") return "[REDACTED_UNSUPPORTED_VALUE]";
  if (seen.has(value)) return "[REDACTED_CYCLE]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets, seen));
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = isSensitiveKey(key)
      ? "[REDACTED]"
      : redactValue(item, secrets, seen);
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  return key.toLowerCase() !== "hasapikey" && SENSITIVE_KEY_PATTERN.test(key);
}

function redactText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length >= 4)
      redacted = redacted.split(secret).join("[REDACTED]");
  }
  redacted = redacted
    .replace(BEARER_PATTERN, "Bearer [REDACTED]")
    .replace(API_KEY_PATTERN, "[REDACTED]")
    .replace(FILE_URI_PATTERN, "[REDACTED_PATH]")
    .replace(WINDOWS_EXTENDED_PATH_PATTERN, "[REDACTED_PATH]")
    .replace(WINDOWS_UNC_PATH_PATTERN, "[REDACTED_PATH]")
    .replace(WINDOWS_PATH_PATTERN, "[REDACTED_PATH]");
  return redacted.replace(POSIX_PATH_PATTERN, (match, offset: number) =>
    isInsideWebUrl(redacted, offset) ? match : "[REDACTED_PATH]",
  );
}

function collectTextValues(value: unknown): string[] {
  const values: string[] = [];
  const seen = new WeakSet<object>();
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      values.push(item);
      return;
    }
    if (typeof item !== "object" || item === null || seen.has(item)) return;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
    } else {
      for (const [key, child] of Object.entries(item)) {
        values.push(key);
        visit(child);
      }
    }
  };
  visit(value);
  return values;
}

function hasPathOutsideWebUrl(value: string, pattern: RegExp): boolean {
  const matcher = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  for (const match of value.matchAll(matcher)) {
    if (!isInsideWebUrl(value, match.index)) return true;
  }
  return false;
}

function isInsideWebUrl(value: string, index: number): boolean {
  return /https?:\/\/[^\s"'<>]*$/iu.test(value.slice(0, index));
}

function buildSecretVariants(secrets: readonly string[]): string[] {
  return [
    ...new Set(
      secrets
        .flatMap((secret) => {
          const trimmed = secret.trim();
          if (trimmed.length < 4) return [];
          const forward = trimmed.replace(/\\/gu, "/");
          const backward = trimmed.replace(/\//gu, "\\");
          return [
            trimmed,
            forward,
            backward,
            `file:///${forward.replace(/^\//u, "")}`,
            encodeURIComponent(trimmed),
          ];
        })
        .filter((secret) => secret.length >= 4),
    ),
  ].sort((left, right) => right.length - left.length);
}

function deduplicateFindings(
  findings: readonly CompanionLongRunSafetyFinding[],
): CompanionLongRunSafetyFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.code}\0${finding.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[UNSERIALIZABLE]";
  }
}

function fencedText(value: string): string {
  return `~~~text\n${value.replace(/~~~/gu, "~ ~ ~")}\n~~~`;
}

function fencedJson(value: unknown): string {
  return `~~~json\n${safeStringify(value).replace(/~~~/gu, "~ ~ ~")}\n~~~`;
}

function escapeInline(value: string): string {
  return value.replace(/[<>]/gu, "").replace(/[`|]/gu, "\\$&");
}

function escapeTable(value: string | number | boolean): string {
  return escapeInline(String(value)).replace(/\r?\n/gu, "<br>");
}

function row(label: string, value: string | number | boolean): string {
  return rowCells([label, value]);
}

function rowCells(values: readonly (string | number | boolean)[]): string {
  return `| ${values.map(escapeTable).join(" | ")} |`;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function signedNumber(value: number): string {
  return value > 0 ? `+${String(value)}` : String(value);
}

function percentile(sortedValues: readonly number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.max(0, Math.ceil(sortedValues.length * ratio) - 1);
  return sortedValues[index] ?? 0;
}

async function assertTargetsAbsent(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await access(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(
      `Refusing to overwrite an existing report artifact: ${basename(path)}`,
    );
  }
}

async function writeSyncedFile(path: string, content: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
