import type { LlmCallMetric } from "@personasim/providers";

export const LONG_RUN_V2_PROFILE_ORDER = [
  "deepseek",
  "claude",
  "grok",
  "gemini",
  "gpt56-sol",
  "bigmodel",
] as const;

export type LongRunV2Profile = (typeof LONG_RUN_V2_PROFILE_ORDER)[number];
export type LongRunV2Mode = "fixture" | "pilot" | "matrix";
export type LongRunV2Track = "paired" | "closed_loop";
export type LongRunV2Branch = "shared" | "date" | "friends";
export type LongRunV2ExecutionStatus = "PASS" | "FAIL" | "PARTIAL" | "SKIPPED";
export type LongRunV2FinalStatus =
  | "PASS"
  | "PASS_WITH_WARNINGS"
  | "FAIL_PRODUCT"
  | "FAIL_PROVIDER"
  | "FAIL_SEMANTIC"
  | "PARTIAL"
  | "SKIPPED";

export interface RunManifest {
  schemaVersion: "companion-long-run-run-manifest-v2";
  matrixId: string;
  runId: string;
  mode: LongRunV2Mode;
  profile: LongRunV2Profile | "fixture";
  repetition: 1 | 2 | 3;
  plannedTracks: LongRunV2Track[];
  createdAtUtc: string;
  git: {
    revision: string;
    dirty: boolean;
    dirtyPatchSha256?: string;
  };
  scenario: {
    version: string;
    manifestSha256: string;
  };
  baseline: {
    databaseSha256: string;
    characterSpecSha256: string;
    initialStateSha256: string;
    scheduleSha256: string;
  };
  profileConfig: {
    provider: "fixture" | "openai-compatible";
    profileName: string;
    baseOrigin: string;
    baseUrl: string;
    requestedModel: string;
    timeoutMs: number;
    maxRetries: number;
    reasoningEffort?: string;
    reasoningRequestFormat?: string;
    structuredOutputMode?: string;
    maxContextTokens?: number;
    maxOutputTokens?: number;
    apiKeyEnvironment?: string;
    apiKeyPresent: boolean;
  };
  featureFlags: {
    chatEffectsMode: "gated";
    scheduleNegotiationMode: "enforced";
    selfInitiatedPlanningMode: "enforced";
    liveWorldEffectsMode: "enforced";
    memoryRecallMode: "enforced";
    autobiographyMode: "off";
    scheduler: "disabled";
  };
  checkpointEveryTurns: 10;
  configSha256: string;
  identityCaveat?: string;
}

export interface ProviderAttemptEvidence extends LlmCallMetric {
  attemptId: string;
  logicalCallIndex?: number;
  requestModel?: string;
  requestBody?: unknown;
  rawResponse?: unknown;
  responseText?: string;
  startedAtUtc: string;
  completedAtUtc: string;
}

export interface LogicalCallTrace {
  index: number;
  purpose: string;
  system: string;
  prompt: string;
  promptSha256: string;
  parsedOutput?: unknown;
  errorCode?: string;
}

export interface HardAssertionResult {
  code: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  summary: string;
  expected?: unknown;
  actual?: unknown;
}

/**
 * Append-only collections are projected to a bounded tail in JSONL evidence.
 * The complete source rows remain in the run SQLite database.
 */
export const LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS = [
  "settlements",
  "activityEvents",
  "memoryEvidence",
  "messages",
  "domainEvents",
  "rejectedProposals",
  "retrievalRuns",
  "llmCalls",
] as const;

export type LongRunV2EvidenceHistoryCollection =
  (typeof LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS)[number];

export interface LongRunEvidenceHistoryDelta {
  /** SHA-256 of the complete collection in the matching `before` snapshot. */
  baseSha256: string;
  /** Every row first observed in this turn, even when it exceeds the tail. */
  addedRows: unknown[];
  /** Defensive capture for a collection that unexpectedly stops being immutable. */
  updatedRows: Array<{ rowKey: string; row: unknown }>;
  /** Defensive capture for deletions or rows evicted from a bounded runtime query. */
  removedRowKeys: string[];
}

export interface LongRunEvidenceHistoryCollectionAudit {
  /** Number of rows in the complete runtime snapshot before JSONL projection. */
  total: number;
  /** SHA-256 of the complete, ordered runtime snapshot collection. */
  sha256: string;
  /** Number of rows retained in the collection's top-level snapshot field. */
  retainedTailCount: number;
  /** Present on `after`; describes the transition from the paired `before`. */
  deltaFromBefore?: LongRunEvidenceHistoryDelta;
}

export interface LongRunEvidenceHistoryAudit {
  format: "bounded-tail-with-turn-delta-v1";
  tailLimit: number;
  collections: Record<
    LongRunV2EvidenceHistoryCollection,
    LongRunEvidenceHistoryCollectionAudit
  >;
}

export interface TurnEvidence {
  schemaVersion: "companion-long-run-turn-evidence-v2";
  matrixId: string;
  runId: string;
  /** Present when repetition one reuses the already-paid Pilot candidate. */
  reusedFromRunId?: string;
  profile: LongRunV2Profile | "fixture";
  repetition: 1 | 2 | 3;
  track: LongRunV2Track;
  branch: LongRunV2Branch;
  turnId: string;
  logicalOrdinal: number;
  candidateOrdinal: number;
  scenarioBlock: string;
  rubricTags: string[];
  pairedProbe?: {
    pairId: string;
    arm: "control" | "comparison";
    category: string;
    baselineSha256: string;
  };
  fakeTimeBeforeUtc: string;
  fakeTimeAfterUtc: string;
  sessionId: string;
  clientMessageId: string;
  userMessage: string;
  actions: Array<{
    action: unknown;
    status: "completed" | "skipped";
    atUtc: string;
    detail?: unknown;
  }>;
  http: {
    method: "POST";
    path: string;
    status: number;
    latencyMs: number;
  };
  logicalCalls: LogicalCallTrace[];
  providerAttempts: ProviderAttemptEvidence[];
  primaryPromptSha256?: string;
  rawCandidateOutput?: unknown;
  parsedCandidateOutput?: unknown;
  applicationResponse?: unknown;
  persistedAssistant?: unknown;
  before: LongRunStateSnapshot;
  after: LongRunStateSnapshot;
  assertions: HardAssertionResult[];
  status: LongRunV2ExecutionStatus;
  repairAttempted: boolean;
  idempotentReplay: boolean;
}

export interface LongRunStateSnapshot {
  capturedAtUtc: string;
  runtimeState: unknown;
  cursor: unknown;
  schedule: unknown[];
  scheduleNegotiations: unknown[];
  settlements: unknown[];
  activityEvents: unknown[];
  memories: unknown[];
  memoryEvidence: unknown[];
  proactiveCandidates: unknown[];
  messages: unknown[];
  domainEvents: unknown[];
  rejectedProposals: unknown[];
  retrievalRuns: unknown[];
  llmCalls: unknown[];
  tableCounts: Record<string, number>;
  durableSha256: string;
  /**
   * Disk-evidence metadata. Undefined on the full in-memory snapshot used by
   * assertions; present when historical arrays above are bounded JSONL tails.
   */
  evidenceHistory?: LongRunEvidenceHistoryAudit;
}

export interface LongRunCheckpoint {
  schemaVersion: "companion-long-run-checkpoint-v2";
  runId: string;
  completedCandidateTurns: number;
  completedTurnIds: string[];
  createdAtUtc: string;
  compatibility: Pick<
    RunManifest,
    "configSha256" | "git" | "scenario" | "baseline" | "profileConfig"
  >;
  databases: Array<{
    role: "paired" | LongRunV2Branch;
    livePath: string;
    snapshotPath: string;
    sha256: string;
  }>;
  evidenceJsonlSha256: string;
}

export interface RunSummary {
  schemaVersion: "companion-long-run-run-summary-v2";
  manifest: RunManifest;
  status: LongRunV2ExecutionStatus;
  finalStatus: LongRunV2FinalStatus;
  completed: {
    paired: number;
    closedLoop: number;
    total: number;
  };
  hardAssertions: {
    passed: number;
    failed: number;
    skipped: number;
  };
  provider: {
    physicalAttempts: number;
    failedAttempts: number;
    repairedTurns: number;
    repairRate: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  promptHashMismatches: string[];
  warnings: string[];
  evidencePath: string;
  databasePaths: string[];
  completedAtUtc: string;
}

export function isLongRunV2Profile(value: string): value is LongRunV2Profile {
  return LONG_RUN_V2_PROFILE_ORDER.some((profile) => profile === value);
}
