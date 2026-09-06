import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import {
  providerCacheUsage,
  type ProviderCacheUsage,
} from "./provider-metrics-summary.js";

import type { CompanionLongRunV3Snapshot } from "./companion-long-run-v3-assertions.js";

/**
 * Runtime evidence types deliberately live next to the artifact writer. The v3
 * scenario manifest describes what to execute; these types describe what was
 * actually sent, returned, committed, and retained for audit.
 */
export type LongRunV3Profile = "deepseek" | "bigmodel" | "fixture";
export type LongRunV3Branch = "shared" | "stable" | "independent";
export type LongRunV3ExecutionStatus = "PASS" | "FAIL" | "PARTIAL" | "SKIPPED";
export type LongRunV3FinalStatus =
  | "PASS"
  | "PASS_WITH_WARNINGS"
  | "FAIL_PRODUCT"
  | "FAIL_PROVIDER"
  | "FAIL_SEMANTIC"
  | "PARTIAL"
  | "SKIPPED"
  | "INVALID_RUN";

export interface LongRunV3RunManifest {
  schemaVersion: "companion-long-run-run-manifest-v3";
  runId: string;
  profile: LongRunV3Profile;
  createdAtUtc: string;
  plannedCandidateTurns: 120;
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
    initialStateSha256?: string;
  };
  characterBuild?: {
    mode: "product_character_generation";
    inputSha256: string;
    sourceSha256: string;
    evidenceSha256: string;
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
    repairMaxOutputTokens?: number;
    apiKeyEnvironment?: string;
    apiKeyPresent: boolean;
  };
  featureFlags: {
    lifePlanningMode: "fuzzy";
    liveWorldEffectsMode: "enforced";
    memoryRecallMode: "enforced";
    scheduler: "disabled";
    autobiographyMode?: "off";
  };
  checkpointEveryTurns: 10;
  configSha256: string;
  identityCaveat?: string;
}

export interface LongRunV3HardAssertionResult {
  code: string;
  status: "PASS" | "FAIL" | "SKIPPED";
  summary: string;
  expected?: unknown;
  actual?: unknown;
}

export interface LongRunV3LogicalCallTrace {
  logicalCallId?: string;
  index: number;
  purpose: string;
  phase?: string;
  system: string;
  prompt: string;
  promptSha256: string;
  requestBody?: unknown;
  maxRetries?: number;
  maxOutputTokens?: number;
  startedAtUtc?: string;
  completedAtUtc?: string;
  latencyMs?: number;
  success?: boolean;
  rawOutput?: unknown;
  parsedOutput?: unknown;
  errorCode?: string;
  repairAttempt?: boolean;
}

export interface LongRunV3ProviderAttemptEvidence extends ProviderCacheUsage {
  providerLogicalCallId?: string;
  providerInputTokens?: number;
  attemptId: string;
  logicalCallId?: string;
  logicalCallIndex?: number;
  phase?: string;
  provider: string;
  model: string;
  requestModel?: string;
  purpose: string;
  attempt: number;
  requestUrl?: string;
  requestHeaders?: unknown;
  requestBody?: unknown;
  success: boolean;
  status?: number;
  responseModel?: string;
  finishReason?: string | null;
  errorCode?: string;
  rawResponse?: unknown;
  responseText?: string;
  usageSource?: "provider" | "estimated" | "unavailable";
  inputTokens?: number;
  outputTokens?: number;
  latencyMs: number;
  startedAtUtc: string;
  completedAtUtc: string;
}

export interface LongRunV3CausalEvidence {
  schemaVersion: "companion-long-run-causal-evidence-v3";
  runId: string;
  turnId: string;
  candidateOrdinal: number;
  branch: LongRunV3Branch;
  capturedAtUtc: string;
  stage:
    | "turn"
    | "dilemma"
    | "support"
    | "decision"
    | "action"
    | "outcome"
    | "reflection"
    | "relationship"
    | "memory"
    | "life_context";
  subject: "user" | "character" | "relationship" | "system";
  sourceMessageIds: string[];
  sourceEventIds?: string[];
  predecessorIds?: string[];
  recordIds?: string[];
  summary: string;
  payload?: unknown;
}

export interface LongRunV3Snapshot extends CompanionLongRunV3Snapshot {
  capturedAtUtc: string;
  /** Hash of audit-only rows and global table-count diagnostics. */
  auditSha256: string;
  runtimeState: unknown;
  cursor: unknown;
  lifeContext: unknown;
  lifeThreads: unknown[];
  memories: unknown[];
  memoryEvidence: unknown[];
  messages: unknown[];
  domainEvents: unknown[];
  proactiveCandidates: unknown[];
  rejectedProposals: unknown[];
  retrievalRuns: unknown[];
  llmCalls: unknown[];
  tableCounts: Record<string, number>;
}

export interface LongRunV3TurnEvidence {
  schemaVersion: "companion-long-run-turn-evidence-v3";
  runId: string;
  profile: LongRunV3Profile;
  branch: LongRunV3Branch;
  turnId: string;
  logicalOrdinal: number;
  candidateOrdinal: number;
  scenarioBlock: string;
  rubricTags: string[];
  fakeTimeBeforeUtc: string;
  fakeTimeAfterUtc: string;
  sessionId: string;
  clientMessageId: string;
  userMessage: string;
  assistantMessage: string;
  actions: Array<{
    action: unknown;
    status: "completed" | "skipped";
    atUtc: string;
    detail?: unknown;
  }>;
  http: {
    method: string;
    path: string;
    status: number;
    latencyMs: number;
  };
  logicalCalls: LongRunV3LogicalCallTrace[];
  providerAttempts: LongRunV3ProviderAttemptEvidence[];
  primaryPromptSha256?: string;
  rawCandidateOutput?: unknown;
  parsedCandidateOutput?: unknown;
  applicationResponse?: unknown;
  persistedAssistant?: unknown;
  before: LongRunV3Snapshot;
  after: LongRunV3Snapshot;
  causalEvidence: LongRunV3CausalEvidence[];
  assertions: LongRunV3HardAssertionResult[];
  status: LongRunV3ExecutionStatus;
  repairAttempted: boolean;
  idempotentReplay: boolean;
}

interface LongRunV3ModelIoIdentity {
  schemaVersion: "companion-long-run-model-io-v3";
  runId: string;
  profile: LongRunV3Profile;
  branch: LongRunV3Branch;
  turnId: string;
  logicalOrdinal: number;
  candidateOrdinal: number;
}

export interface LongRunV3LogicalModelIoRecord extends LongRunV3ModelIoIdentity {
  recordType: "logical_call";
  logicalCallId: string;
  logicalCallIndex: number;
  phase?: string;
  request: {
    purpose: string;
    system: string;
    prompt: string;
    messages: Array<{
      role: "system" | "user";
      content: string;
    }>;
    body?: unknown;
    promptSha256: string;
    provider: LongRunV3RunManifest["profileConfig"]["provider"];
    requestedModel: string;
    parameters: {
      timeoutMs: number;
      maxRetries: number;
      maxOutputTokens?: number;
      maxContextTokens?: number;
      reasoningEffort?: string;
      reasoningRequestFormat?: string;
      structuredOutputMode?: string;
    };
  };
  response: {
    success?: boolean;
    rawOutput?: unknown;
    parsedOutput?: unknown;
    errorCode?: string;
    startedAtUtc?: string;
    completedAtUtc?: string;
    latencyMs?: number;
    repairAttempt: boolean;
  };
  physicalAttemptIds: string[];
}

export interface LongRunV3PhysicalModelIoRecord extends LongRunV3ModelIoIdentity {
  providerLogicalCallId?: string;
  recordType: "physical_attempt";
  attemptId: string;
  attemptNumber: number;
  logicalCallId?: string;
  logicalCallIndex?: number;
  phase?: string;
  request: {
    method: "POST";
    url?: string;
    headers?: unknown;
    purpose: string;
    provider: string;
    configuredModel: string;
    requestModel?: string;
    body?: unknown;
  };
  response: {
    success: boolean;
    status?: number;
    responseModel?: string;
    finishReason?: string | null;
    errorCode?: string;
    raw?: unknown;
    text?: string;
    usage: ProviderCacheUsage & {
      source?: "provider" | "estimated" | "unavailable";
      inputTokens?: number;
      outputTokens?: number;
    };
    latencyMs: number;
    startedAtUtc: string;
    completedAtUtc: string;
  };
}

export type LongRunV3ModelIoRecord =
  LongRunV3LogicalModelIoRecord | LongRunV3PhysicalModelIoRecord;

export interface LongRunV3ArtifactDigest {
  path: string;
  bytes: number;
  sha256: string;
}

export interface LongRunV3Checkpoint {
  schemaVersion: "companion-long-run-checkpoint-v3";
  runId: string;
  completedCandidateTurns: number;
  completedTurnIds: string[];
  createdAtUtc: string;
  compatibility: Pick<
    LongRunV3RunManifest,
    | "configSha256"
    | "git"
    | "scenario"
    | "baseline"
    | "profileConfig"
    | "featureFlags"
  >;
  compatibilitySha256: string;
  artifacts: {
    runManifest: LongRunV3ArtifactDigest;
    baselineDescriptor: LongRunV3ArtifactDigest;
    baselineDatabase: LongRunV3ArtifactDigest;
    conversation: LongRunV3ArtifactDigest;
    modelIo: LongRunV3ArtifactDigest;
    causalEvidence: LongRunV3ArtifactDigest;
    turnEvidence: LongRunV3ArtifactDigest;
  };
  databases: Array<LongRunV3ArtifactDigest & { role: LongRunV3Branch }>;
  checkpointSha256: string;
}

export interface LongRunV3ExpectedArtifactTurn {
  turnId: string;
  candidateOrdinal: number;
  branch: LongRunV3Branch;
}

export interface LongRunV3ArtifactCoverageResult {
  passed: boolean;
  issues: string[];
  counts: {
    expected: number;
    turnEvidence: number;
    primaryModelIo: number;
    causalEnvelopes: number;
    conversationTurns: number;
  };
}

export interface LongRunV3ArtifactPaths {
  runManifest: string;
  conversation: string;
  modelIo: string;
  causalEvidence: string;
  turnEvidence: string;
  hardGates: string;
  semanticScores: string;
  checkpointsDirectory: string;
  report: string;
}

export interface LongRunV3ArtifactBundleInput {
  directory: string;
  manifest: LongRunV3RunManifest;
  turns: readonly LongRunV3TurnEvidence[];
  causalEvidence?: readonly LongRunV3CausalEvidence[];
  explicitSecrets?: readonly string[];
  conversationTitle?: string;
  userName?: string;
  characterName?: string;
}

export interface LongRunV3ArtifactBundleResult {
  paths: Pick<
    LongRunV3ArtifactPaths,
    | "runManifest"
    | "conversation"
    | "modelIo"
    | "causalEvidence"
    | "turnEvidence"
  >;
  digests: {
    runManifest: LongRunV3ArtifactDigest;
    conversation: LongRunV3ArtifactDigest;
    modelIo: LongRunV3ArtifactDigest;
    causalEvidence: LongRunV3ArtifactDigest;
    turnEvidence: LongRunV3ArtifactDigest;
  };
}

// Usage counters are evidence, not authentication material. Authentication
// fields are recognized by their complete key shape so `inputTokens` and
// `maxOutputTokens` remain intact.
const SECRET_FIELD =
  /^(?:api[_-]?key|x[_-]?api[_-]?key|authorization|proxy[_-]?authorization|credential|credentials|password|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|bearer)$/iu;
const SECRET_TEXT =
  /(?:bearer\s+)[A-Za-z0-9._~+/-]{8,}|\bsk-[A-Za-z0-9_-]{8,}\b/giu;
const SECRET_QUERY =
  /([?&](?:api[_-]?key|key|access[_-]?token|auth[_-]?token|token)=)[^&#\s]+/giu;

export function resolveLongRunV3ArtifactPaths(
  directory: string,
): LongRunV3ArtifactPaths {
  return {
    runManifest: resolve(directory, "run-manifest.json"),
    conversation: resolve(directory, "conversation.md"),
    modelIo: resolve(directory, "model-io.jsonl"),
    causalEvidence: resolve(directory, "causal-evidence.jsonl"),
    turnEvidence: resolve(directory, "turn-evidence.jsonl"),
    hardGates: resolve(directory, "hard-gates.json"),
    semanticScores: resolve(directory, "semantic-scores.json"),
    checkpointsDirectory: resolve(directory, "checkpoints"),
    report: resolve(directory, "report.md"),
  };
}

export function redactLongRunV3Artifact(
  value: unknown,
  explicitSecrets: readonly string[] = [],
): unknown {
  const secrets = explicitSecrets.filter((secret) => secret.trim() !== "");
  const visit = (input: unknown, key?: string): unknown => {
    if (key !== undefined && SECRET_FIELD.test(key)) {
      return key.toLowerCase().includes("present")
        ? Boolean(input)
        : "[REDACTED]";
    }
    if (typeof input === "string") {
      let safe = input
        .replace(SECRET_TEXT, (match) =>
          /^bearer\s+/iu.test(match) ? "Bearer [REDACTED]" : "[REDACTED]",
        )
        .replace(SECRET_QUERY, "$1[REDACTED]");
      for (const secret of secrets) {
        safe = safe.split(secret).join("[REDACTED]");
      }
      return safe;
    }
    if (Array.isArray(input)) return input.map((item) => visit(item));
    if (typeof input !== "object" || input === null) return input;
    return Object.fromEntries(
      Object.entries(input as Record<string, unknown>).map(
        ([nestedKey, nested]) => [nestedKey, visit(nested, nestedKey)],
      ),
    );
  };
  return visit(value);
}

export function canonicalLongRunV3Json(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalLongRunV3Json(item)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([key, nested]) =>
        `${JSON.stringify(key)}:${canonicalLongRunV3Json(nested)}`,
    )
    .join(",")}}`;
}

export function sha256LongRunV3Value(value: unknown): string {
  return createHash("sha256")
    .update(canonicalLongRunV3Json(value))
    .digest("hex");
}

export function sha256LongRunV3Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256LongRunV3File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

export async function writeLongRunV3JsonExclusive(
  path: string,
  value: unknown,
  explicitSecrets: readonly string[] = [],
): Promise<void> {
  const safe = redactLongRunV3Artifact(value, explicitSecrets);
  await writeLongRunV3TextExclusive(path, `${JSON.stringify(safe, null, 2)}\n`);
}

export async function writeLongRunV3RunManifest(
  directory: string,
  manifest: LongRunV3RunManifest,
  explicitSecrets: readonly string[] = [],
): Promise<string> {
  const path = resolveLongRunV3ArtifactPaths(directory).runManifest;
  await writeLongRunV3JsonExclusive(path, manifest, explicitSecrets);
  return path;
}

export async function writeLongRunV3TextExclusive(
  path: string,
  value: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(value, "utf8");
  } finally {
    await handle.close();
  }
}

export async function writeLongRunV3JsonLinesExclusive(
  path: string,
  records: readonly unknown[],
  explicitSecrets: readonly string[] = [],
): Promise<void> {
  const safe = records.map((record) =>
    redactLongRunV3Artifact(record, explicitSecrets),
  );
  await writeLongRunV3TextExclusive(
    path,
    safe.map((record) => JSON.stringify(record)).join("\n") +
      (safe.length === 0 ? "" : "\n"),
  );
}

export async function readLongRunV3JsonLines<T>(path: string): Promise<T[]> {
  const content = await readFile(path, "utf8");
  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(`Invalid JSONL at ${path}:${String(index + 1)}.`, {
          cause: error,
        });
      }
    });
}

export async function readLongRunV3Evidence(
  path: string,
): Promise<LongRunV3TurnEvidence[]> {
  return readLongRunV3JsonLines<LongRunV3TurnEvidence>(path);
}

export async function inspectLongRunV3ArtifactCoverage(input: {
  paths: Pick<
    LongRunV3ArtifactPaths,
    "conversation" | "modelIo" | "causalEvidence" | "turnEvidence"
  >;
  expectedTurns: readonly LongRunV3ExpectedArtifactTurn[];
  manifest: LongRunV3RunManifest;
}): Promise<LongRunV3ArtifactCoverageResult> {
  const [conversation, modelIo, causalEvidence, turnEvidence] =
    await Promise.all([
      readFile(input.paths.conversation, "utf8"),
      readLongRunV3JsonLines<LongRunV3ModelIoRecord>(input.paths.modelIo),
      readLongRunV3JsonLines<LongRunV3CausalEvidence>(
        input.paths.causalEvidence,
      ),
      readLongRunV3Evidence(input.paths.turnEvidence),
    ]);
  return validateLongRunV3ArtifactCoverage({
    expectedTurns: input.expectedTurns,
    manifest: input.manifest,
    conversation,
    modelIo,
    causalEvidence,
    turnEvidence,
  });
}

export function validateLongRunV3ArtifactCoverage(input: {
  expectedTurns: readonly LongRunV3ExpectedArtifactTurn[];
  manifest: LongRunV3RunManifest;
  conversation: string;
  modelIo: readonly LongRunV3ModelIoRecord[];
  causalEvidence: readonly LongRunV3CausalEvidence[];
  turnEvidence: readonly LongRunV3TurnEvidence[];
}): LongRunV3ArtifactCoverageResult {
  const issues: string[] = [];
  const expected = new Map<string, LongRunV3ExpectedArtifactTurn>();
  const expectedOrdinals = new Set<number>();
  for (const turn of input.expectedTurns) {
    if (expected.has(turn.turnId))
      issues.push(`expected_duplicate:${turn.turnId}`);
    if (expectedOrdinals.has(turn.candidateOrdinal)) {
      issues.push(
        `expected_ordinal_duplicate:${String(turn.candidateOrdinal)}`,
      );
    }
    expected.set(turn.turnId, turn);
    expectedOrdinals.add(turn.candidateOrdinal);
  }

  validateIdentityRecords(
    "turn_evidence",
    input.turnEvidence,
    expected,
    issues,
  );

  const primaryModelIo = input.modelIo.filter((record) => {
    if (record.recordType !== "logical_call") return false;
    return record.request.purpose === "chat_turn";
  });
  validateIdentityRecords("model_io_primary", primaryModelIo, expected, issues);
  validateKnownIdentities("model_io", input.modelIo, expected, issues);

  const causalEnvelopes = input.causalEvidence.filter(
    (record) => record.stage === "turn",
  );
  validateIdentityRecords("causal_envelope", causalEnvelopes, expected, issues);
  validateKnownIdentities(
    "causal_evidence",
    input.causalEvidence,
    expected,
    issues,
  );

  const conversationTurns = [
    ...input.conversation.matchAll(
      /<!-- companion-long-run-v3-turn:([^\s]+) -->/gu,
    ),
  ].map((match) => match[1] ?? "");
  validateTurnIdCoverage("conversation", conversationTurns, expected, issues);

  const expectedConversation = renderLongRunV3Conversation(input.turnEvidence);
  if (input.conversation !== expectedConversation) {
    issues.push("conversation_projection_mismatch");
  }
  const expectedModelIo = input.turnEvidence.flatMap((turn) =>
    projectLongRunV3ModelIoRecords(turn, input.manifest),
  );
  if (
    canonicalLongRunV3Json(input.modelIo) !==
    canonicalLongRunV3Json(expectedModelIo)
  ) {
    issues.push("model_io_projection_mismatch");
  }
  const expectedCausalEvidence = input.turnEvidence.flatMap(
    (turn) => turn.causalEvidence,
  );
  if (
    canonicalLongRunV3Json(input.causalEvidence) !==
    canonicalLongRunV3Json(expectedCausalEvidence)
  ) {
    issues.push("causal_evidence_projection_mismatch");
  }

  return {
    passed: issues.length === 0,
    issues,
    counts: {
      expected: expected.size,
      turnEvidence: input.turnEvidence.length,
      primaryModelIo: primaryModelIo.length,
      causalEnvelopes: causalEnvelopes.length,
      conversationTurns: conversationTurns.length,
    },
  };
}

export async function appendLongRunV3TurnEvidence(
  path: string,
  evidence: LongRunV3TurnEvidence,
  explicitSecrets: readonly string[] = [],
): Promise<void> {
  await appendLongRunV3JsonLines(path, [evidence], explicitSecrets);
}

export async function appendLongRunV3CausalEvidence(
  path: string,
  evidence: readonly LongRunV3CausalEvidence[],
  explicitSecrets: readonly string[] = [],
): Promise<void> {
  await appendLongRunV3JsonLines(path, evidence, explicitSecrets);
}

export function renderLongRunV3Conversation(
  turns: readonly Pick<
    LongRunV3TurnEvidence,
    "turnId" | "branch" | "userMessage" | "assistantMessage"
  >[],
  options: {
    title?: string;
    userName?: string;
    characterName?: string;
  } = {},
): string {
  const title = options.title ?? "ChatPLUS 长程测试对话记录";
  const userName = options.userName ?? "林舟";
  const characterName = options.characterName ?? "顾澜";
  const lines = [`# ${title}`, ""];
  let previousBranch: LongRunV3Branch | undefined;
  for (const turn of turns) {
    if (turn.branch !== previousBranch) {
      lines.push(`## ${branchTitle(turn.branch)}`, "");
      previousBranch = turn.branch;
    }
    lines.push(
      `<!-- companion-long-run-v3-turn:${turn.turnId} -->`,
      `### ${turn.turnId}`,
      "",
      `**${userName}**`,
      "",
      turn.userMessage,
      "",
      `**${characterName}**`,
      "",
      turn.assistantMessage,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function projectLongRunV3ModelIoRecords(
  evidence: LongRunV3TurnEvidence,
  manifest: LongRunV3RunManifest,
): LongRunV3ModelIoRecord[] {
  const identity: LongRunV3ModelIoIdentity = {
    schemaVersion: "companion-long-run-model-io-v3",
    runId: evidence.runId,
    profile: evidence.profile,
    branch: evidence.branch,
    turnId: evidence.turnId,
    logicalOrdinal: evidence.logicalOrdinal,
    candidateOrdinal: evidence.candidateOrdinal,
  };
  const records: LongRunV3ModelIoRecord[] = [];
  const emittedAttemptIds = new Set<string>();
  for (const call of evidence.logicalCalls) {
    const logicalCallId =
      call.logicalCallId ??
      `${evidence.runId}:${evidence.turnId}:logical:${String(call.index)}`;
    const attempts = evidence.providerAttempts.filter(
      (attempt) =>
        attempt.logicalCallId === logicalCallId ||
        (attempt.logicalCallId === undefined &&
          attempt.logicalCallIndex === call.index),
    );
    records.push({
      ...identity,
      recordType: "logical_call",
      logicalCallId,
      logicalCallIndex: call.index,
      ...(call.phase === undefined ? {} : { phase: call.phase }),
      request: {
        purpose: call.purpose,
        system: call.system,
        prompt: call.prompt,
        messages: [
          { role: "system", content: call.system },
          { role: "user", content: call.prompt },
        ],
        ...(call.requestBody === undefined ? {} : { body: call.requestBody }),
        promptSha256: call.promptSha256,
        provider: manifest.profileConfig.provider,
        requestedModel: manifest.profileConfig.requestedModel,
        parameters: {
          timeoutMs: manifest.profileConfig.timeoutMs,
          maxRetries: call.maxRetries ?? manifest.profileConfig.maxRetries,
          ...((call.maxOutputTokens ??
            manifest.profileConfig.maxOutputTokens) === undefined
            ? {}
            : {
                maxOutputTokens:
                  call.maxOutputTokens ??
                  manifest.profileConfig.maxOutputTokens,
              }),
          ...(manifest.profileConfig.maxContextTokens === undefined
            ? {}
            : { maxContextTokens: manifest.profileConfig.maxContextTokens }),
          ...(manifest.profileConfig.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: manifest.profileConfig.reasoningEffort }),
          ...(manifest.profileConfig.reasoningRequestFormat === undefined
            ? {}
            : {
                reasoningRequestFormat:
                  manifest.profileConfig.reasoningRequestFormat,
              }),
          ...(manifest.profileConfig.structuredOutputMode === undefined
            ? {}
            : {
                structuredOutputMode:
                  manifest.profileConfig.structuredOutputMode,
              }),
        },
      },
      response: {
        ...(call.success === undefined ? {} : { success: call.success }),
        ...(call.rawOutput === undefined ? {} : { rawOutput: call.rawOutput }),
        ...(call.parsedOutput === undefined
          ? {}
          : { parsedOutput: call.parsedOutput }),
        ...(call.errorCode === undefined ? {} : { errorCode: call.errorCode }),
        ...(call.startedAtUtc === undefined
          ? {}
          : { startedAtUtc: call.startedAtUtc }),
        ...(call.completedAtUtc === undefined
          ? {}
          : { completedAtUtc: call.completedAtUtc }),
        ...(call.latencyMs === undefined ? {} : { latencyMs: call.latencyMs }),
        repairAttempt: call.repairAttempt ?? false,
      },
      physicalAttemptIds: attempts.map((attempt) => attempt.attemptId),
    });
    for (const attempt of attempts) {
      emittedAttemptIds.add(attempt.attemptId);
      records.push(projectPhysicalModelIoRecord(identity, attempt));
    }
  }
  for (const attempt of evidence.providerAttempts) {
    if (!emittedAttemptIds.has(attempt.attemptId)) {
      records.push(projectPhysicalModelIoRecord(identity, attempt));
    }
  }
  return records;
}

export async function appendLongRunV3ModelIo(
  path: string,
  evidence: LongRunV3TurnEvidence,
  manifest: LongRunV3RunManifest,
  explicitSecrets: readonly string[] = [],
): Promise<void> {
  await appendLongRunV3JsonLines(
    path,
    projectLongRunV3ModelIoRecords(evidence, manifest),
    explicitSecrets,
  );
}

export async function writeLongRunV3ArtifactBundle(
  input: LongRunV3ArtifactBundleInput,
): Promise<LongRunV3ArtifactBundleResult> {
  const paths = resolveLongRunV3ArtifactPaths(input.directory);
  const secrets = input.explicitSecrets ?? [];
  const causalEvidence =
    input.causalEvidence ?? input.turns.flatMap((turn) => turn.causalEvidence);
  const modelIo = input.turns.flatMap((turn) =>
    projectLongRunV3ModelIoRecords(turn, input.manifest),
  );
  const conversation = renderLongRunV3Conversation(input.turns, {
    ...(input.conversationTitle === undefined
      ? {}
      : { title: input.conversationTitle }),
    ...(input.userName === undefined ? {} : { userName: input.userName }),
    ...(input.characterName === undefined
      ? {}
      : { characterName: input.characterName }),
  });

  await assertFinalArtifactsAbsent([
    paths.runManifest,
    paths.conversation,
    paths.modelIo,
    paths.causalEvidence,
    paths.turnEvidence,
  ]);

  // Each final artifact is opened with `wx`. A resumed run must write to a new
  // run directory or verify and reuse its existing immutable artifacts; it can
  // never silently replace evidence from an earlier execution.
  await writeLongRunV3JsonExclusive(paths.runManifest, input.manifest, secrets);
  await writeLongRunV3TextExclusive(
    paths.conversation,
    redactLongRunV3Artifact(conversation, secrets) as string,
  );
  await writeLongRunV3JsonLinesExclusive(paths.modelIo, modelIo, secrets);
  await writeLongRunV3JsonLinesExclusive(
    paths.causalEvidence,
    causalEvidence,
    secrets,
  );
  await writeLongRunV3JsonLinesExclusive(
    paths.turnEvidence,
    input.turns,
    secrets,
  );

  return {
    paths: {
      runManifest: paths.runManifest,
      conversation: paths.conversation,
      modelIo: paths.modelIo,
      causalEvidence: paths.causalEvidence,
      turnEvidence: paths.turnEvidence,
    },
    digests: {
      runManifest: await describeArtifact(input.directory, paths.runManifest),
      conversation: await describeArtifact(input.directory, paths.conversation),
      modelIo: await describeArtifact(input.directory, paths.modelIo),
      causalEvidence: await describeArtifact(
        input.directory,
        paths.causalEvidence,
      ),
      turnEvidence: await describeArtifact(input.directory, paths.turnEvidence),
    },
  };
}

export async function createLongRunV3Checkpoint(input: {
  runDirectory: string;
  manifest: LongRunV3RunManifest;
  completedCandidateTurns: number;
  completedTurnIds: readonly string[];
  databases: ReadonlyArray<{ role: LongRunV3Branch; path: string }>;
  createdAtUtc?: string;
}): Promise<LongRunV3Checkpoint> {
  const paths = resolveLongRunV3ArtifactPaths(input.runDirectory);
  assertCheckpointProgress(
    input.completedCandidateTurns,
    input.completedTurnIds,
  );
  const label = String(input.completedCandidateTurns).padStart(3, "0");
  const snapshotDirectory = resolve(
    paths.checkpointsDirectory,
    `checkpoint-${label}`,
  );
  const snapshotArtifacts = {
    conversation: resolve(snapshotDirectory, basename(paths.conversation)),
    modelIo: resolve(snapshotDirectory, basename(paths.modelIo)),
    causalEvidence: resolve(snapshotDirectory, basename(paths.causalEvidence)),
    turnEvidence: resolve(snapshotDirectory, basename(paths.turnEvidence)),
  };
  const snapshotDatabases = input.databases.map((database) => ({
    role: database.role,
    sourcePath: database.path,
    snapshotPath: resolve(
      snapshotDirectory,
      "databases",
      `${database.role}.sqlite`,
    ),
  }));
  await mkdir(resolve(snapshotDirectory, "databases"), { recursive: true });
  await Promise.all([
    copyFileAtomically(paths.conversation, snapshotArtifacts.conversation),
    copyFileAtomically(paths.modelIo, snapshotArtifacts.modelIo),
    copyFileAtomically(paths.causalEvidence, snapshotArtifacts.causalEvidence),
    copyFileAtomically(paths.turnEvidence, snapshotArtifacts.turnEvidence),
    ...snapshotDatabases.map((database) =>
      copyFileAtomically(database.sourcePath, database.snapshotPath),
    ),
  ]);
  const compatibility: LongRunV3Checkpoint["compatibility"] = {
    configSha256: input.manifest.configSha256,
    git: input.manifest.git,
    scenario: input.manifest.scenario,
    baseline: input.manifest.baseline,
    profileConfig: input.manifest.profileConfig,
    featureFlags: input.manifest.featureFlags,
  };
  const withoutSelfHash = {
    schemaVersion: "companion-long-run-checkpoint-v3" as const,
    runId: input.manifest.runId,
    completedCandidateTurns: input.completedCandidateTurns,
    completedTurnIds: [...input.completedTurnIds],
    createdAtUtc: input.createdAtUtc ?? new Date().toISOString(),
    compatibility,
    compatibilitySha256: sha256LongRunV3Value(compatibility),
    artifacts: {
      runManifest: await describeArtifact(
        input.runDirectory,
        paths.runManifest,
      ),
      baselineDescriptor: await describeArtifact(
        input.runDirectory,
        resolve(input.runDirectory, "baseline.json"),
      ),
      baselineDatabase: await describeArtifact(
        input.runDirectory,
        resolve(input.runDirectory, "baseline.sqlite"),
      ),
      conversation: await describeArtifact(
        input.runDirectory,
        snapshotArtifacts.conversation,
      ),
      modelIo: await describeArtifact(
        input.runDirectory,
        snapshotArtifacts.modelIo,
      ),
      causalEvidence: await describeArtifact(
        input.runDirectory,
        snapshotArtifacts.causalEvidence,
      ),
      turnEvidence: await describeArtifact(
        input.runDirectory,
        snapshotArtifacts.turnEvidence,
      ),
    },
    databases: await Promise.all(
      snapshotDatabases.map(async (database) => ({
        role: database.role,
        ...(await describeArtifact(input.runDirectory, database.snapshotPath)),
      })),
    ),
  };
  return {
    ...withoutSelfHash,
    checkpointSha256: sha256LongRunV3Value(withoutSelfHash),
  };
}

export async function writeLongRunV3Checkpoint(
  runDirectory: string,
  checkpoint: LongRunV3Checkpoint,
): Promise<string> {
  assertLongRunV3CheckpointSelfHash(checkpoint);
  const path = resolve(
    resolveLongRunV3ArtifactPaths(runDirectory).checkpointsDirectory,
    `checkpoint-${String(checkpoint.completedCandidateTurns).padStart(3, "0")}.json`,
  );
  await verifyLongRunV3CheckpointFiles(runDirectory, checkpoint);
  await writeLongRunV3JsonAtomicExclusive(path, checkpoint);
  return path;
}

export async function readLatestLongRunV3Checkpoint(
  runDirectory: string,
): Promise<LongRunV3Checkpoint> {
  const directory =
    resolveLongRunV3ArtifactPaths(runDirectory).checkpointsDirectory;
  const entries = await readdir(directory, { withFileTypes: true });
  const committed = entries
    .filter((entry) => entry.isFile())
    .flatMap((entry) => {
      const match = /^checkpoint-(\d{3})\.json$/u.exec(entry.name);
      return match?.[1] === undefined
        ? []
        : [{ path: resolve(directory, entry.name), ordinal: Number(match[1]) }];
    })
    .sort((left, right) => right.ordinal - left.ordinal);
  const latest = committed[0];
  if (latest === undefined) {
    throw new Error("No committed v3 checkpoint is available for resume.");
  }
  let checkpoint: LongRunV3Checkpoint;
  try {
    checkpoint = JSON.parse(
      await readFile(latest.path, "utf8"),
    ) as LongRunV3Checkpoint;
  } catch (error) {
    throw new Error(`Invalid committed v3 checkpoint: ${latest.path}`, {
      cause: error,
    });
  }
  if (
    checkpoint.schemaVersion !== "companion-long-run-checkpoint-v3" ||
    checkpoint.completedCandidateTurns !== latest.ordinal
  ) {
    throw new Error("Checkpoint filename and payload progress do not match.");
  }
  assertCheckpointProgress(
    checkpoint.completedCandidateTurns,
    checkpoint.completedTurnIds,
  );
  assertLongRunV3CheckpointSelfHash(checkpoint);
  return checkpoint;
}

export async function restoreLongRunV3Checkpoint(input: {
  runDirectory: string;
  manifest: LongRunV3RunManifest;
  checkpoint: LongRunV3Checkpoint;
  activeDatabases: Record<LongRunV3Branch, string>;
}): Promise<void> {
  assertLongRunV3ResumeCompatible(input.manifest, input.checkpoint);
  await verifyLongRunV3CheckpointFiles(input.runDirectory, input.checkpoint);
  const paths = resolveLongRunV3ArtifactPaths(input.runDirectory);
  const activeArtifacts = {
    conversation: paths.conversation,
    modelIo: paths.modelIo,
    causalEvidence: paths.causalEvidence,
    turnEvidence: paths.turnEvidence,
  };
  for (const [key, destination] of Object.entries(activeArtifacts) as Array<
    [keyof typeof activeArtifacts, string]
  >) {
    const source = resolveCheckedArtifactPath(
      input.runDirectory,
      input.checkpoint.artifacts[key].path,
    );
    await copyFileAtomically(source, destination);
    await assertDigestMatchesPath(
      input.runDirectory,
      destination,
      input.checkpoint.artifacts[key],
    );
  }

  const checkpointRoles = new Set(
    input.checkpoint.databases.map((database) => database.role),
  );
  if (checkpointRoles.size !== input.checkpoint.databases.length) {
    throw new Error("Checkpoint contains duplicate database roles.");
  }
  for (const [role, destination] of Object.entries(
    input.activeDatabases,
  ) as Array<[LongRunV3Branch, string]>) {
    await removeSqliteSidecars(destination);
    const database = input.checkpoint.databases.find(
      (candidate) => candidate.role === role,
    );
    if (database === undefined) {
      await rm(destination, { force: true });
      continue;
    }
    const source = resolveCheckedArtifactPath(
      input.runDirectory,
      database.path,
    );
    await copyFileAtomically(source, destination);
    await assertDigestMatchesPath(input.runDirectory, destination, database);
  }
}

export function assertLongRunV3ResumeCompatible(
  manifest: LongRunV3RunManifest,
  checkpoint: LongRunV3Checkpoint,
): void {
  assertLongRunV3CheckpointSelfHash(checkpoint);
  const compatibility: LongRunV3Checkpoint["compatibility"] = {
    configSha256: manifest.configSha256,
    git: manifest.git,
    scenario: manifest.scenario,
    baseline: manifest.baseline,
    profileConfig: manifest.profileConfig,
    featureFlags: manifest.featureFlags,
  };
  if (
    sha256LongRunV3Value(compatibility) !== checkpoint.compatibilitySha256 ||
    canonicalLongRunV3Json(compatibility) !==
      canonicalLongRunV3Json(checkpoint.compatibility)
  ) {
    throw new Error(
      "Checkpoint is incompatible with the current Git, scenario, baseline, profile configuration, or feature flags.",
    );
  }
}

export async function verifyLongRunV3CheckpointFiles(
  runDirectory: string,
  checkpoint: LongRunV3Checkpoint,
): Promise<void> {
  assertLongRunV3CheckpointSelfHash(checkpoint);
  const artifacts = [
    ...Object.values(checkpoint.artifacts),
    ...checkpoint.databases,
  ];
  for (const artifact of artifacts) {
    const path = resolveCheckedArtifactPath(runDirectory, artifact.path);
    const current = await describeArtifact(runDirectory, path);
    if (
      current.sha256 !== artifact.sha256 ||
      current.bytes !== artifact.bytes
    ) {
      throw new Error(`Checkpoint artifact hash mismatch: ${artifact.path}`);
    }
  }
}

function projectPhysicalModelIoRecord(
  identity: LongRunV3ModelIoIdentity,
  attempt: LongRunV3ProviderAttemptEvidence,
): LongRunV3PhysicalModelIoRecord {
  return {
    ...identity,
    recordType: "physical_attempt",
    ...(attempt.providerLogicalCallId === undefined
      ? {}
      : { providerLogicalCallId: attempt.providerLogicalCallId }),
    attemptId: attempt.attemptId,
    attemptNumber: attempt.attempt,
    ...(attempt.logicalCallId === undefined
      ? {}
      : { logicalCallId: attempt.logicalCallId }),
    ...(attempt.logicalCallIndex === undefined
      ? {}
      : { logicalCallIndex: attempt.logicalCallIndex }),
    ...(attempt.phase === undefined ? {} : { phase: attempt.phase }),
    request: {
      method: "POST",
      ...(attempt.requestUrl === undefined ? {} : { url: attempt.requestUrl }),
      ...(attempt.requestHeaders === undefined
        ? {}
        : { headers: attempt.requestHeaders }),
      purpose: attempt.purpose,
      provider: attempt.provider,
      configuredModel: attempt.model,
      ...(attempt.requestModel === undefined
        ? {}
        : { requestModel: attempt.requestModel }),
      ...(attempt.requestBody === undefined
        ? {}
        : { body: attempt.requestBody }),
    },
    response: {
      success: attempt.success,
      ...(attempt.status === undefined ? {} : { status: attempt.status }),
      ...(attempt.responseModel === undefined
        ? {}
        : { responseModel: attempt.responseModel }),
      ...(attempt.finishReason === undefined
        ? {}
        : { finishReason: attempt.finishReason }),
      ...(attempt.errorCode === undefined
        ? {}
        : { errorCode: attempt.errorCode }),
      ...(attempt.rawResponse === undefined
        ? {}
        : { raw: attempt.rawResponse }),
      ...(attempt.responseText === undefined
        ? {}
        : { text: attempt.responseText }),
      usage: {
        ...providerCacheUsage(attempt),
        ...(attempt.usageSource === undefined
          ? {}
          : { source: attempt.usageSource }),
        ...(attempt.inputTokens === undefined
          ? {}
          : { inputTokens: attempt.inputTokens }),
        ...(attempt.outputTokens === undefined
          ? {}
          : { outputTokens: attempt.outputTokens }),
      },
      latencyMs: attempt.latencyMs,
      startedAtUtc: attempt.startedAtUtc,
      completedAtUtc: attempt.completedAtUtc,
    },
  };
}

async function appendLongRunV3JsonLines(
  path: string,
  records: readonly unknown[],
  explicitSecrets: readonly string[],
): Promise<void> {
  if (records.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  const safe = records.map((record) =>
    redactLongRunV3Artifact(record, explicitSecrets),
  );
  const handle = await open(path, "a");
  try {
    await handle.writeFile(
      `${safe.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
  } finally {
    await handle.close();
  }
}

function validateIdentityRecords(
  label: string,
  records: ReadonlyArray<{
    turnId: string;
    candidateOrdinal: number;
    branch: LongRunV3Branch;
  }>,
  expected: ReadonlyMap<string, LongRunV3ExpectedArtifactTurn>,
  issues: string[],
): void {
  validateKnownIdentities(label, records, expected, issues);
  validateTurnIdCoverage(
    label,
    records.map((record) => record.turnId),
    expected,
    issues,
  );
}

function validateKnownIdentities(
  label: string,
  records: ReadonlyArray<{
    turnId: string;
    candidateOrdinal: number;
    branch: LongRunV3Branch;
  }>,
  expected: ReadonlyMap<string, LongRunV3ExpectedArtifactTurn>,
  issues: string[],
): void {
  for (const record of records) {
    const expectedTurn = expected.get(record.turnId);
    if (expectedTurn === undefined) {
      issues.push(`${label}_unexpected:${record.turnId}`);
      continue;
    }
    if (expectedTurn.candidateOrdinal !== record.candidateOrdinal) {
      issues.push(
        `${label}_ordinal_mismatch:${record.turnId}:expected_${String(expectedTurn.candidateOrdinal)}:actual_${String(record.candidateOrdinal)}`,
      );
    }
    if (expectedTurn.branch !== record.branch) {
      issues.push(
        `${label}_branch_mismatch:${record.turnId}:expected_${expectedTurn.branch}:actual_${record.branch}`,
      );
    }
  }
}

function validateTurnIdCoverage(
  label: string,
  actualTurnIds: readonly string[],
  expected: ReadonlyMap<string, LongRunV3ExpectedArtifactTurn>,
  issues: string[],
): void {
  const counts = new Map<string, number>();
  for (const turnId of actualTurnIds) {
    counts.set(turnId, (counts.get(turnId) ?? 0) + 1);
  }
  for (const turnId of expected.keys()) {
    const count = counts.get(turnId) ?? 0;
    if (count === 0) issues.push(`${label}_missing:${turnId}`);
    else if (count > 1) {
      issues.push(`${label}_duplicate:${turnId}:${String(count)}`);
    }
  }
}

function branchTitle(branch: LongRunV3Branch): string {
  if (branch === "stable") return "分支 A：稳定方向";
  if (branch === "independent") return "分支 B：独立方向";
  return "共享主线";
}

async function assertFinalArtifactsAbsent(
  paths: readonly string[],
): Promise<void> {
  for (const path of paths) {
    try {
      await stat(path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") continue;
      throw error;
    }
    const error = new Error(
      `Final artifact already exists: ${path}`,
    ) as Error & {
      code: string;
    };
    error.code = "EEXIST";
    throw error;
  }
}

async function describeArtifact(
  runDirectory: string,
  path: string,
): Promise<LongRunV3ArtifactDigest> {
  const resolvedPath = resolve(path);
  const info = await stat(resolvedPath);
  return {
    path: workspaceRelativePath(runDirectory, resolvedPath),
    bytes: info.size,
    sha256: await sha256LongRunV3File(resolvedPath),
  };
}

async function writeLongRunV3JsonAtomicExclusive(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await stat(path);
    const error = new Error(
      `Final artifact already exists: ${path}`,
    ) as Error & {
      code: string;
    };
    error.code = "EEXIST";
    throw error;
  } catch (error) {
    if (!(isNodeError(error) && error.code === "ENOENT")) throw error;
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function copyFileAtomically(
  source: string,
  destination: string,
): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${randomUUID()}`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function assertDigestMatchesPath(
  runDirectory: string,
  path: string,
  expected: LongRunV3ArtifactDigest,
): Promise<void> {
  const actual = await describeArtifact(runDirectory, path);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    throw new Error(
      `Restored checkpoint artifact hash mismatch: ${expected.path}`,
    );
  }
}

async function removeSqliteSidecars(databasePath: string): Promise<void> {
  await Promise.all([
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
  ]);
}

function assertCheckpointProgress(
  completedCandidateTurns: number,
  completedTurnIds: readonly string[],
): void {
  if (
    !Number.isInteger(completedCandidateTurns) ||
    completedCandidateTurns < 0 ||
    completedCandidateTurns > 120 ||
    completedTurnIds.length !== completedCandidateTurns ||
    new Set(completedTurnIds).size !== completedTurnIds.length
  ) {
    throw new Error("Checkpoint progress is internally inconsistent.");
  }
}

function assertLongRunV3CheckpointSelfHash(
  checkpoint: LongRunV3Checkpoint,
): void {
  const { checkpointSha256, ...withoutSelfHash } = checkpoint;
  if (sha256LongRunV3Value(withoutSelfHash) !== checkpointSha256) {
    throw new Error("Checkpoint self hash mismatch.");
  }
}

function resolveCheckedArtifactPath(
  runDirectory: string,
  artifactPath: string,
): string {
  const root = resolve(runDirectory);
  const target = resolve(root, artifactPath);
  const relativePath = relative(root, target);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  ) {
    throw new Error(
      `Checkpoint artifact escaped the run directory: ${artifactPath}`,
    );
  }
  return target;
}

function workspaceRelativePath(workspaceRoot: string, target: string): string {
  const output = relative(resolve(workspaceRoot), resolve(target));
  if (
    output === ".." ||
    output.startsWith("../") ||
    output.startsWith("..\\")
  ) {
    throw new Error(`Artifact escaped the run directory: ${target}`);
  }
  return output.replaceAll("\\", "/");
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
