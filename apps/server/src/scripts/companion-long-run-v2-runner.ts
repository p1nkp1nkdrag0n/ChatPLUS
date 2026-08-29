import { copyFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

import type { SendMessageResponse } from "@personasim/contracts";

import type { ServerConfig } from "../config.js";
import type { Database } from "../db/connection.js";
import {
  RetrievalRunRepository,
  type RetrievalRun,
} from "../repositories/retrieval-run-repository.js";
import type {
  LongRunPairedProbeSpec,
  LongRunScenarioManifestV2,
  LongRunTurnSpec,
} from "../scenarios/companion-long-run-v2-types.js";
import {
  COMPANION_LONG_RUN_V2_SHA256,
  companionLongRunV2Manifest,
  validateLongRunScenarioManifestV2,
} from "../scenarios/companion-long-run-v2-manifest.js";
import {
  appendLongRunModelIoEvidence,
  appendTurnEvidence,
  assertResumeCompatible,
  assertRunManifestCompatible,
  atomicWriteMutableJson,
  atomicWriteMutableText,
  readGitFingerprint,
  readTurnEvidence,
  rewriteLongRunModelIoEvidence,
  sha256Text,
  snapshotDatabase,
  writeAtomicCheckpoint,
  writeJsonExclusive,
  writeRunManifest,
  writeTextExclusive,
} from "./companion-long-run-v2-artifacts.js";
import { renderLongRunV2Conversation } from "./companion-long-run-v2-conversation.js";
import {
  LONG_RUN_V2_AGENT_ID,
  LONG_RUN_V2_SESSION_ID,
  createCompanionLongRunV2Baseline,
  sha256Canonical,
  sha256File,
  type LongRunBaselineDescriptor,
} from "./companion-long-run-v2-baseline.js";
import { evaluateLongRunV2HardAssertions } from "./companion-long-run-v2-assertions.js";
import type { LongRunV2ProfileConfigSnapshot } from "./companion-long-run-v2-profiles.js";
import {
  evaluateLongRunV2PilotGate,
  renderLongRunV2RunMarkdown,
  summarizeLongRunV2Run,
} from "./companion-long-run-v2-report.js";
import { LongRunV2Runtime } from "./companion-long-run-v2-runtime.js";
import {
  LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS,
  type LongRunEvidenceHistoryCollectionAudit,
  type LongRunEvidenceHistoryDelta,
  type LongRunCheckpoint,
  type LongRunStateSnapshot,
  type LongRunV2EvidenceHistoryCollection,
  type LongRunV2Branch,
  type LongRunV2Mode,
  type LongRunV2Profile,
  type RunManifest,
  type RunSummary,
  type TurnEvidence,
} from "./companion-long-run-v2-run-types.js";

const CHECKPOINT_EVERY = 10;
const PAIRED_BASELINE_SCHEMA_VERSION =
  "companion-long-run-paired-baseline-v4" as const;
export const LONG_RUN_V2_EVIDENCE_TAIL_LIMIT = 12;
const LONG_RUN_V2_FEATURE_FLAGS: RunManifest["featureFlags"] = {
  chatEffectsMode: "gated",
  scheduleNegotiationMode: "enforced",
  selfInitiatedPlanningMode: "enforced",
  liveWorldEffectsMode: "enforced",
  memoryRecallMode: "enforced",
  autobiographyMode: "off",
  scheduler: "disabled",
};

export interface LongRunV2SingleRunInput {
  workspaceRoot: string;
  matrixDirectory: string;
  matrixId: string;
  runId: string;
  mode: LongRunV2Mode;
  profile: LongRunV2Profile | "fixture";
  repetition: 1 | 2 | 3;
  serverConfig: ServerConfig;
  profileConfig: RunManifest["profileConfig"];
  profileConfigSha256: string;
  tracks: readonly ("paired" | "closed_loop")[];
  manifest?: LongRunScenarioManifestV2;
  reusedPilotDirectory?: string;
  resume?: boolean;
  stopAfterCandidate?: number;
}

export interface LongRunV2SingleRunResult {
  runDirectory: string;
  summary: RunSummary;
  pilotGate?: ReturnType<typeof evaluateLongRunV2PilotGate>;
}

interface RunContext {
  input: LongRunV2SingleRunInput;
  scenario: LongRunScenarioManifestV2;
  runDirectory: string;
  databaseDirectory: string;
  checkpointDirectory: string;
  evidencePath: string;
  modelIoPath: string;
  baseline: LongRunBaselineDescriptor;
  manifest: RunManifest;
  evidence: TurnEvidence[];
  databasePaths: string[];
  secretValues: string[];
}

/**
 * Executes one isolated profile/repetition. Matrix orchestration deliberately
 * lives in the CLI so every paid profile can run in its own process.
 */
export async function runCompanionLongRunV2Single(
  input: LongRunV2SingleRunInput,
): Promise<LongRunV2SingleRunResult> {
  const scenario = input.manifest ?? companionLongRunV2Manifest;
  const scenarioIssues = validateLongRunScenarioManifestV2(scenario);
  if (scenarioIssues.length > 0) {
    throw new Error(
      `Invalid companion long-run v2 manifest:\n${scenarioIssues.join("\n")}`,
    );
  }

  const runDirectory = resolve(input.matrixDirectory, "runs", input.runId);
  const evidencePath = resolve(runDirectory, "turn-evidence.jsonl");
  const baseline = await ensureFrozenBaseline(input.matrixDirectory);
  const runManifest = await buildRunManifest(input, baseline, scenario);
  const existing = await pathExists(resolve(runDirectory, "run-manifest.json"));
  let evidence: TurnEvidence[] = [];
  if (existing) {
    if (!input.resume) {
      throw new Error(
        `Run output already exists and will not be overwritten: ${runDirectory}`,
      );
    }
    const persisted = JSON.parse(
      await readFile(resolve(runDirectory, "run-manifest.json"), "utf8"),
    ) as RunManifest;
    assertRunManifestCompatible(runManifest, persisted);
    evidence = await resumeEvidenceAtLatestCheckpoint(runDirectory, persisted);
  } else {
    await mkdir(runDirectory, { recursive: true });
    await writeRunManifest(runDirectory, runManifest);
  }

  const context: RunContext = {
    input,
    scenario,
    runDirectory,
    databaseDirectory: resolve(runDirectory, "databases"),
    checkpointDirectory: resolve(runDirectory, "checkpoints"),
    evidencePath,
    modelIoPath: resolve(runDirectory, "model-io.jsonl"),
    baseline,
    manifest: runManifest,
    evidence,
    databasePaths: [],
    secretValues: input.serverConfig.llm.apiKey
      ? [input.serverConfig.llm.apiKey]
      : [],
  };
  await refreshRunDeliveryArtifacts(context);

  let pilotGate: ReturnType<typeof evaluateLongRunV2PilotGate> | undefined;
  if (input.tracks.includes("paired")) {
    if (
      context.evidence.filter((item) => item.track === "paired").length === 0
    ) {
      if (input.reusedPilotDirectory) await reusePilotEvidence(context);
      else await runPairedTrack(context);
    }
    pilotGate = evaluateLongRunV2PilotGate(context.evidence);
    await atomicWriteMutableJson(
      resolve(runDirectory, "pilot-gate.json"),
      pilotGate,
    );
    if (
      input.mode !== "fixture" &&
      !pilotGate.eligibleForClosedLoop &&
      input.tracks.includes("closed_loop")
    ) {
      return finishRun(context, pilotGate);
    }
  }

  if (input.tracks.includes("closed_loop") && !shouldStop(context)) {
    await runClosedLoopTrack(context);
  }
  return finishRun(context, pilotGate);
}

export function buildLongRunV2ServerConfig(
  base: ServerConfig,
  databasePath: string,
  fixture: boolean,
): ServerConfig {
  return {
    ...base,
    nodeEnv: "test",
    profile: "companion-long-run-v2",
    databasePath,
    clockMode: "fake",
    fakeClockStart: companionLongRunV2Manifest.startAtUtc,
    developerRoutes: true,
    seedDemo: false,
    chatEffectsMode: "gated",
    scheduleNegotiationMode: "enforced",
    selfInitiatedPlanningMode: "enforced",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "off",
    ...(fixture
      ? {
          llm: {
            provider: "fixture" as const,
            baseUrl: "http://fixture.invalid",
            model: "personasim-fixture-v1",
            timeoutMs: 5_000,
            maxRetries: 0,
          },
        }
      : {}),
  };
}

export function fixtureProfileSnapshot(): {
  profileConfig: RunManifest["profileConfig"];
  configSha256: string;
} {
  const profileConfig = {
    provider: "fixture" as const,
    profileName: "fixture",
    baseOrigin: "http://fixture.invalid",
    baseUrl: "http://fixture.invalid",
    requestedModel: "personasim-fixture-v1",
    timeoutMs: 5_000,
    maxRetries: 0,
    apiKeyPresent: false,
  };
  return { profileConfig, configSha256: sha256Canonical(profileConfig) };
}

export function liveProfileSnapshot(
  snapshot: LongRunV2ProfileConfigSnapshot,
): RunManifest["profileConfig"] {
  return {
    provider: "openai-compatible",
    profileName: snapshot.configuredProfileName ?? "legacy",
    baseOrigin: snapshot.baseOrigin,
    baseUrl: snapshot.baseUrl,
    requestedModel: snapshot.requestedModel,
    timeoutMs: snapshot.timeoutMs,
    maxRetries: snapshot.maxRetries,
    ...(snapshot.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: snapshot.reasoningEffort }),
    ...(snapshot.reasoningRequestFormat === undefined
      ? {}
      : { reasoningRequestFormat: snapshot.reasoningRequestFormat }),
    structuredOutputMode: snapshot.capabilities.structuredOutputMode,
    ...(snapshot.capabilities.maxContextTokens === undefined
      ? {}
      : { maxContextTokens: snapshot.capabilities.maxContextTokens }),
    ...(snapshot.capabilities.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: snapshot.capabilities.maxOutputTokens }),
    apiKeyEnvironment: snapshot.apiKeyEnvironment,
    apiKeyPresent: snapshot.apiKeyPresent,
  };
}

export function computeLongRunV2ConfigSha256(
  profileConfigSha256: string,
  conversationRetention: ServerConfig["conversationRetention"],
): string {
  return sha256Canonical({
    profile: profileConfigSha256,
    featureFlags: LONG_RUN_V2_FEATURE_FLAGS,
    conversationRetention,
  });
}

async function ensurePairedProbeBaseline(
  context: RunContext,
  probe: LongRunPairedProbeSpec,
  ordinal: number,
): Promise<{ databasePath: string; sha256: string; atUtc: string }> {
  const directory = resolve(
    context.input.matrixDirectory,
    "paired-baselines-v4",
  );
  const stem = `${String(ordinal).padStart(2, "0")}-${safeFileName(probe.id)}`;
  const databasePath = resolve(directory, `${stem}.sqlite`);
  const descriptorPath = resolve(directory, `${stem}.json`);
  if (await pathExists(descriptorPath)) {
    const descriptor = JSON.parse(await readFile(descriptorPath, "utf8")) as {
      schemaVersion: string;
      probeId: string;
      sourceBaselineSha256: string;
      scenarioSha256: string;
      gitRevision: string;
      dirtyPatchSha256: string | null;
      databaseSha256: string;
      atUtc: string;
    };
    if (
      descriptor.schemaVersion !== PAIRED_BASELINE_SCHEMA_VERSION ||
      descriptor.probeId !== probe.id ||
      descriptor.sourceBaselineSha256 !== context.baseline.databaseSha256 ||
      descriptor.scenarioSha256 !== context.manifest.scenario.manifestSha256 ||
      descriptor.gitRevision !== context.manifest.git.revision ||
      descriptor.dirtyPatchSha256 !==
        (context.manifest.git.dirtyPatchSha256 ?? null) ||
      descriptor.databaseSha256 !== (await sha256File(databasePath))
    ) {
      throw new Error(`Prepared paired baseline is incompatible: ${probe.id}`);
    }
    await assertCachedPairedSetupBaseline(
      context,
      probe,
      databasePath,
      descriptor.atUtc,
    );
    return {
      databasePath,
      sha256: descriptor.databaseSha256,
      atUtc: descriptor.atUtc,
    };
  }

  await copyDatabase(context.baseline.databasePath, databasePath);
  let atUtc = context.scenario.startAtUtc;
  if ((probe.setupMessages?.length ?? 0) > 0) {
    const setupRuntime = new LongRunV2Runtime({
      databasePath,
      config: buildLongRunV2ServerConfig(
        context.input.serverConfig,
        databasePath,
        true,
      ),
      startAtUtc: atUtc,
      initialSessionId: LONG_RUN_V2_SESSION_ID,
    });
    await setupRuntime.open();
    try {
      let previousSetupAtUtc: string | undefined;
      for (const [setupIndex, setup] of (probe.setupMessages ?? []).entries()) {
        await setupRuntime.applyActions(
          setup.actionsBefore,
          LONG_RUN_V2_AGENT_ID,
        );
        if (
          previousSetupAtUtc !== undefined &&
          Date.parse(setupRuntime.nowUtc) <= Date.parse(previousSetupAtUtc)
        ) {
          const durationMinutes =
            Math.floor(
              (Date.parse(previousSetupAtUtc) -
                Date.parse(setupRuntime.nowUtc)) /
                60_000,
            ) + 1;
          await setupRuntime.applyActions(
            [{ kind: "advance_clock", durationMinutes }],
            LONG_RUN_V2_AGENT_ID,
          );
        }
        const setupResult = await setupRuntime.sendMessage({
          agentId: LONG_RUN_V2_AGENT_ID,
          sessionKey: "S1",
          text: setup.userText,
          clientMessageId: deterministicClientMessageId(
            "paired-frozen-v2",
            `${probe.id}-setup-${String(setupIndex + 1)}`,
          ),
        });
        if (
          setupResult.http.status < 200 ||
          setupResult.http.status >= 300 ||
          setupResult.parsed === undefined
        ) {
          throw new Error(
            `Paired setup failed before provider execution: ${probe.id} setup ${String(setupIndex + 1)} returned HTTP ${String(setupResult.http.status)}.`,
          );
        }
        previousSetupAtUtc = setupRuntime.nowUtc;
      }
      assertPairedSetupBaseline(
        probe,
        setupRuntime.snapshot(LONG_RUN_V2_AGENT_ID),
      );
      atUtc = setupRuntime.nowUtc;
      setupRuntime.checkpointWal();
    } finally {
      await setupRuntime.close();
    }
  }
  const sha256 = await sha256File(databasePath);
  await writeJsonExclusive(descriptorPath, {
    schemaVersion: PAIRED_BASELINE_SCHEMA_VERSION,
    probeId: probe.id,
    sourceBaselineSha256: context.baseline.databaseSha256,
    scenarioSha256: context.manifest.scenario.manifestSha256,
    gitRevision: context.manifest.git.revision,
    dirtyPatchSha256: context.manifest.git.dirtyPatchSha256 ?? null,
    databaseSha256: sha256,
    atUtc,
  });
  return { databasePath, sha256, atUtc };
}

async function assertCachedPairedSetupBaseline(
  context: RunContext,
  probe: LongRunPairedProbeSpec,
  databasePath: string,
  atUtc: string,
): Promise<void> {
  if ((probe.setupMessages?.length ?? 0) === 0) return;
  const runtime = new LongRunV2Runtime({
    databasePath,
    config: buildLongRunV2ServerConfig(
      context.input.serverConfig,
      databasePath,
      true,
    ),
    startAtUtc: atUtc,
    initialSessionId: LONG_RUN_V2_SESSION_ID,
  });
  await runtime.open();
  try {
    assertPairedSetupBaseline(probe, runtime.snapshot(LONG_RUN_V2_AGENT_ID));
  } finally {
    await runtime.close();
  }
}

function assertPairedSetupBaseline(
  probe: LongRunPairedProbeSpec,
  snapshot: LongRunStateSnapshot,
): void {
  const setup = probe.setupMessages ?? [];
  if (setup.length === 0) return;
  const setupTexts = new Set(setup.map((message) => message.userText));
  const setupMessages = snapshot.messages
    .map(asRecord)
    .filter(
      (message) =>
        message["role"] === "user" &&
        setupTexts.has(recordString(message, "content")),
    );
  if (setupMessages.length !== setup.length) {
    throw pairedBaselineError(
      probe,
      `expected ${String(setup.length)} persisted setup messages, found ${String(setupMessages.length)}`,
    );
  }
  for (let index = 1; index < setupMessages.length; index += 1) {
    const previous = Date.parse(
      recordString(setupMessages[index - 1] ?? {}, "created_at_utc"),
    );
    const current = Date.parse(
      recordString(setupMessages[index] ?? {}, "created_at_utc"),
    );
    if (
      !Number.isFinite(previous) ||
      !Number.isFinite(current) ||
      current <= previous
    ) {
      throw pairedBaselineError(
        probe,
        "setup message timestamps must be valid and strictly increasing",
      );
    }
  }
  if (probe.category !== "memory_time") return;

  const setupMessageIds = new Set(
    setupMessages.map((message) => recordString(message, "id")),
  );
  const evidence = snapshot.memoryEvidence.map(asRecord);
  const groundedSetupMessageIds = new Set(
    evidence
      .filter(
        (row) =>
          row["source_type"] === "message" &&
          setupMessageIds.has(recordString(row, "source_id")),
      )
      .map((row) => recordString(row, "source_id")),
  );
  if (groundedSetupMessageIds.size !== setupMessageIds.size) {
    throw pairedBaselineError(
      probe,
      `every memory setup message must ground durable evidence (${String(groundedSetupMessageIds.size)}/${String(setupMessageIds.size)})`,
    );
  }

  const memories = snapshot.memories.map(asRecord);
  const setupEvidence = evidence.filter(
    (row) =>
      row["source_type"] === "message" &&
      setupMessageIds.has(recordString(row, "source_id")),
  );
  const groundedMemoryIds = new Set(
    setupEvidence.map((row) => recordString(row, "memory_id")),
  );
  const setupMemories = memories.filter((memory) =>
    groundedMemoryIds.has(recordString(memory, "id")),
  );
  if (
    setupMemories.length < setup.length ||
    setupMemories.some(
      (memory) =>
        memory["namespace"] !== "user_model" ||
        memory["certainty"] !== "explicit" ||
        memory["attribution"] !== "user_explicit" ||
        recordString(memory, "claim_subject_key") === "",
    )
  ) {
    throw pairedBaselineError(
      probe,
      "memory setup must produce grounded, explicit user-model claims",
    );
  }

  const requiresSupersession =
    probe.hardAssertions.includes("memory_correction_supersedes") ||
    (probe.pairId === "memory-03" && probe.arm === "comparison");
  if (!requiresSupersession) return;
  const byId = new Map(
    setupMemories.map((memory) => [recordString(memory, "id"), memory]),
  );
  const expected = pairedSupersessionExpectation(probe);
  const superseded = setupMemories.find((memory) => {
    if (memory["status"] !== "superseded") return false;
    if (
      expected !== undefined &&
      (memory["claim_subject_key"] !== expected.subjectKey ||
        memory["claim_disposition"] !== expected.oldDisposition ||
        (expected.oldTemporalStatus !== undefined &&
          memory["temporal_status"] !== expected.oldTemporalStatus))
    ) {
      return false;
    }
    return true;
  });
  const replacement =
    superseded === undefined
      ? undefined
      : byId.get(recordString(superseded, "superseded_by_id"));
  const oldEvidenceSourceIds = new Set(
    setupEvidence
      .filter(
        (row) =>
          recordString(row, "memory_id") ===
          recordString(superseded ?? {}, "id"),
      )
      .map((row) => recordString(row, "source_id")),
  );
  const replacementEvidenceSourceIds = new Set(
    setupEvidence
      .filter(
        (row) =>
          recordString(row, "memory_id") ===
          recordString(replacement ?? {}, "id"),
      )
      .map((row) => recordString(row, "source_id")),
  );
  const validSupersession =
    superseded !== undefined &&
    replacement?.["status"] === "active" &&
    recordString(superseded, "claim_subject_key") !== "" &&
    superseded["claim_subject_key"] === replacement["claim_subject_key"] &&
    (expected === undefined ||
      (replacement["claim_subject_key"] === expected.subjectKey &&
        replacement["claim_disposition"] === expected.newDisposition &&
        (expected.newTemporalStatus === undefined ||
          replacement["temporal_status"] === expected.newTemporalStatus))) &&
    oldEvidenceSourceIds.has(recordString(setupMessages[0] ?? {}, "id")) &&
    replacementEvidenceSourceIds.has(
      recordString(setupMessages.at(-1) ?? {}, "id"),
    );
  const hasSupersedeEvent = snapshot.domainEvents
    .map(asRecord)
    .some((event) => {
      if (event["eventType"] !== "memory.claim.supersede") return false;
      const payload = asRecord(event["payload"]);
      return (
        recordString(payload, "existingMemoryId") ===
          recordString(superseded ?? {}, "id") &&
        recordString(payload, "incomingMemoryId") ===
          recordString(replacement ?? {}, "id")
      );
    });
  if (!validSupersession || !hasSupersedeEvent) {
    throw pairedBaselineError(
      probe,
      "explicit correction must form a grounded supersession chain before a paid candidate call",
    );
  }
}

function pairedSupersessionExpectation(probe: LongRunPairedProbeSpec):
  | {
      subjectKey: string;
      oldDisposition: string;
      newDisposition: string;
      oldTemporalStatus?: string;
      newTemporalStatus?: string;
    }
  | undefined {
  if (probe.pairId === "memory-02") {
    return {
      subjectKey: "user_fact:relationship:小林",
      oldDisposition: "affirmed",
      newDisposition: "affirmed",
    };
  }
  if (probe.pairId === "memory-03") {
    return {
      subjectKey: "user_task:report",
      oldDisposition: "affirmed",
      newDisposition: "completed",
      oldTemporalStatus: "planned",
      newTemporalStatus: "occurred",
    };
  }
  return undefined;
}

function pairedBaselineError(
  probe: LongRunPairedProbeSpec,
  detail: string,
): Error {
  return new Error(
    `Invalid paired baseline (FAIL_HARNESS): ${probe.id}: ${detail}.`,
  );
}

function recordString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

async function runPairedTrack(context: RunContext): Promise<void> {
  const completed = new Set(context.evidence.map((item) => item.turnId));
  for (const [index, probe] of context.scenario.pairedProbes.entries()) {
    if (completed.has(probe.id)) continue;
    const pairedBaseline = await ensurePairedProbeBaseline(
      context,
      probe,
      index + 1,
    );
    const databasePath = resolve(
      context.databaseDirectory,
      "paired",
      `${String(index + 1).padStart(2, "0")}-${safeFileName(probe.id)}.sqlite`,
    );
    await copyDatabase(pairedBaseline.databasePath, databasePath);

    const runtime = new LongRunV2Runtime({
      databasePath,
      config: buildLongRunV2ServerConfig(
        context.input.serverConfig,
        databasePath,
        context.input.profile === "fixture",
      ),
      startAtUtc: pairedBaseline.atUtc,
      initialSessionId: LONG_RUN_V2_SESSION_ID,
    });
    await runtime.open();
    try {
      const turn = pairedProbeAsTurn(probe, index + 1);
      const evidence = await executeCandidate({
        context,
        runtime,
        turn,
        track: "paired",
        branch: "shared",
        candidateOrdinal: index + 1,
        pairedProbe: probe,
        pairedBaselineSha256: pairedBaseline.sha256,
      });
      await commitEvidence(context, evidence, databasePath, runtime);
    } finally {
      await runtime.close();
    }
    context.databasePaths.push(databasePath);
    if (shouldStop(context)) return;
  }
}

async function runClosedLoopTrack(context: RunContext): Promise<void> {
  const completed = new Set(context.evidence.map((item) => item.turnId));
  const sharedPath = resolve(context.databaseDirectory, "closed-shared.sqlite");
  const datePath = resolve(context.databaseDirectory, "closed-date.sqlite");
  const friendsPath = resolve(
    context.databaseDirectory,
    "closed-friends.sqlite",
  );
  const priorShared = context.evidence.filter(
    (item) => item.track === "closed_loop" && item.branch === "shared",
  );
  if (priorShared.length === 0) {
    await copyDatabase(context.baseline.databasePath, sharedPath);
  }
  let anchorSha256: string | undefined;

  if (priorShared.length < context.scenario.sharedTurns.length) {
    const runtime = runtimeFor(
      context,
      sharedPath,
      latestFakeTime(priorShared),
    );
    await runtime.open();
    try {
      for (const turn of context.scenario.sharedTurns) {
        if (completed.has(turn.id)) continue;
        const evidence = await executeCandidate({
          context,
          runtime,
          turn,
          track: "closed_loop",
          branch: "shared",
          candidateOrdinal: 30 + turn.candidateNumber,
        });
        await commitEvidence(context, evidence, sharedPath, runtime);
        if (shouldStop(context)) return;
      }
      runtime.checkpointWal();
      anchorSha256 = runtime.snapshot(LONG_RUN_V2_AGENT_ID).durableSha256;
    } finally {
      await runtime.close();
    }
  }

  const priorDate = context.evidence.filter(
    (item) => item.track === "closed_loop" && item.branch === "date",
  );
  const priorFriends = context.evidence.filter(
    (item) => item.track === "closed_loop" && item.branch === "friends",
  );
  if (priorDate.length === 0) {
    await copyDatabase(sharedPath, datePath);
  } else if (!(await pathExists(datePath))) {
    throw new Error("Resumed date-branch database is missing.");
  }
  if (priorFriends.length === 0) {
    await copyDatabase(sharedPath, friendsPath);
  } else if (!(await pathExists(friendsPath))) {
    throw new Error("Resumed friends-branch database is missing.");
  }
  if (anchorSha256 === undefined) {
    const anchorRuntime = runtimeFor(
      context,
      sharedPath,
      context.scenario.sharedTurns
        .at(-1)
        ?.actionsBefore?.find((action) => action.kind === "set_clock")?.atUtc ??
        latestFakeTime(priorShared),
    );
    await anchorRuntime.open();
    try {
      anchorSha256 = anchorRuntime.snapshot(LONG_RUN_V2_AGENT_ID).durableSha256;
    } finally {
      await anchorRuntime.close();
    }
  }
  await checkpointAnchor(context, sharedPath, datePath, friendsPath);

  for (const branchSpec of context.scenario.branches) {
    const branch: LongRunV2Branch = branchSpec.id === "A" ? "date" : "friends";
    const databasePath = branch === "date" ? datePath : friendsPath;
    const priorBranch = context.evidence.filter(
      (item) => item.track === "closed_loop" && item.branch === branch,
    );
    const runtime = runtimeFor(
      context,
      databasePath,
      latestFakeTime(
        priorBranch,
        context.scenario.sharedTurns
          .at(-1)
          ?.actionsBefore?.find((action) => action.kind === "set_clock")?.atUtc,
      ),
    );
    await runtime.open();
    try {
      const actualAnchorSha256 =
        priorBranch.length === 0
          ? runtime.snapshot(LONG_RUN_V2_AGENT_ID).durableSha256
          : anchorSha256;
      for (const turn of branchSpec.turns) {
        if (completed.has(turn.id)) continue;
        const evidence = await executeCandidate({
          context,
          runtime,
          turn,
          track: "closed_loop",
          branch,
          candidateOrdinal: 30 + turn.candidateNumber,
          expectedBranchAnchorSha256: anchorSha256,
          actualBranchAnchorSha256: actualAnchorSha256,
        });
        await commitEvidence(context, evidence, databasePath, runtime);
        if (shouldStop(context)) return;
      }
    } finally {
      await runtime.close();
    }
  }
  context.databasePaths.push(sharedPath, datePath, friendsPath);
}

function runtimeFor(
  context: RunContext,
  databasePath: string,
  startAtUtc?: string,
): LongRunV2Runtime {
  return new LongRunV2Runtime({
    databasePath,
    config: buildLongRunV2ServerConfig(
      context.input.serverConfig,
      databasePath,
      context.input.profile === "fixture",
    ),
    startAtUtc: startAtUtc ?? context.scenario.startAtUtc,
    initialSessionId: LONG_RUN_V2_SESSION_ID,
  });
}

async function executeCandidate(input: {
  context: RunContext;
  runtime: LongRunV2Runtime;
  turn: LongRunTurnSpec;
  track: "paired" | "closed_loop";
  branch: LongRunV2Branch;
  candidateOrdinal: number;
  pairedProbe?: LongRunPairedProbeSpec;
  pairedBaselineSha256?: string;
  expectedBranchAnchorSha256?: string;
  actualBranchAnchorSha256?: string;
}): Promise<TurnEvidence> {
  const fakeTimeBeforeUtc = input.runtime.nowUtc;
  const before = input.runtime.snapshot(LONG_RUN_V2_AGENT_ID);
  const actionObservationCursor = input.runtime.observer.cursor();
  const actions = await input.runtime.applyActions(
    input.turn.actionsBefore,
    LONG_RUN_V2_AGENT_ID,
  );
  const actionObservations = input.runtime.observer.slice(
    actionObservationCursor,
  );
  if (!input.runtime.isOpen) {
    await input.runtime.open();
  }
  const fallbackClientMessageId = deterministicClientMessageId(
    input.track === "paired" ? "paired-frozen-v2" : input.context.input.runId,
    input.turn.id,
  );
  const clientMessageId = input.runtime.nextClientMessageId(
    fallbackClientMessageId,
  );
  const sessionId = input.runtime.selectSession(input.turn.sessionKey);
  const sent = await input.runtime.sendMessage({
    agentId: LONG_RUN_V2_AGENT_ID,
    sessionKey: input.turn.sessionKey,
    text: input.turn.userText,
    clientMessageId,
  });
  const turnLogicalCalls = [
    ...actionObservations.logicalCalls.map((call) => ({
      ...call,
      phase: "pre_message_action" as const,
    })),
    ...sent.observations.logicalCalls.map((call) => ({
      ...call,
      phase: "message" as const,
    })),
  ];
  const turnProviderAttempts = [
    ...actionObservations.providerAttempts.map((attempt) => ({
      ...attempt,
      phase: "pre_message_action" as const,
    })),
    ...sent.observations.providerAttempts.map((attempt) => ({
      ...attempt,
      phase: "message" as const,
    })),
  ];
  const after = input.runtime.snapshot(LONG_RUN_V2_AGENT_ID);
  const persistedAssistant = findPersistedAssistant(after, sent.parsed);
  const retrievalRuns =
    sent.parsed === undefined
      ? []
      : retrievalRunsForSource(
          input.runtime.currentDatabase,
          LONG_RUN_V2_AGENT_ID,
          sent.parsed.userMessage.id,
        );
  const assertions = evaluateLongRunV2HardAssertions({
    turn: input.turn,
    httpStatus: sent.http.status,
    ...(sent.parsed === undefined ? {} : { response: sent.parsed }),
    ...(persistedAssistant === undefined ? {} : { persistedAssistant }),
    before,
    after,
    logicalCalls: sent.observations.logicalCalls,
    actions,
    retrievalRuns,
    promptHardTokenLimit:
      input.context.input.serverConfig.conversationRetention.hardTokenLimit,
    ...(input.expectedBranchAnchorSha256 === undefined
      ? {}
      : { expectedBranchAnchorSha256: input.expectedBranchAnchorSha256 }),
    ...(input.actualBranchAnchorSha256 === undefined
      ? {}
      : { actualBranchAnchorSha256: input.actualBranchAnchorSha256 }),
  });
  const primary =
    sent.observations.logicalCalls.find(
      (call) => call.purpose === "chat_turn",
    ) ?? sent.observations.logicalCalls[0];
  const rawCandidate = sent.observations.providerAttempts.at(-1)?.rawResponse;
  const parsedCandidate = sent.observations.logicalCalls.findLast(
    (call) => call.parsedOutput !== undefined,
  )?.parsedOutput;
  const { before: compactBefore, after: compactAfter } =
    compactLongRunV2EvidenceSnapshots(before, after);
  return {
    schemaVersion: "companion-long-run-turn-evidence-v2",
    matrixId: input.context.input.matrixId,
    runId: input.context.input.runId,
    profile: input.context.input.profile,
    repetition: input.context.input.repetition,
    track: input.track,
    branch: input.branch,
    turnId: input.turn.id,
    logicalOrdinal: input.turn.executionOrdinal,
    candidateOrdinal: input.candidateOrdinal,
    scenarioBlock: input.turn.blockId,
    rubricTags: [...input.turn.semanticRubricTags],
    ...(input.pairedProbe === undefined
      ? {}
      : {
          pairedProbe: {
            pairId: input.pairedProbe.pairId,
            arm: input.pairedProbe.arm,
            category: input.pairedProbe.category,
            baselineSha256: input.pairedBaselineSha256!,
          },
        }),
    fakeTimeBeforeUtc,
    fakeTimeAfterUtc: input.runtime.nowUtc,
    sessionId,
    clientMessageId,
    userMessage: input.turn.userText,
    actions: actions.map((item) => ({ ...item })),
    http: {
      method: "POST",
      path: `/api/sessions/${sessionId}/messages`,
      status: sent.http.status,
      latencyMs: sent.http.latencyMs,
    },
    logicalCalls: turnLogicalCalls,
    providerAttempts: turnProviderAttempts,
    ...(primary === undefined
      ? {}
      : { primaryPromptSha256: primary.promptSha256 }),
    ...(rawCandidate === undefined ? {} : { rawCandidateOutput: rawCandidate }),
    ...(parsedCandidate === undefined
      ? {}
      : { parsedCandidateOutput: parsedCandidate }),
    applicationResponse: sent.http.body,
    ...(persistedAssistant === undefined ? {} : { persistedAssistant }),
    before: compactBefore,
    after: compactAfter,
    assertions,
    status: assertions.some((assertion) => assertion.status === "FAIL")
      ? "FAIL"
      : "PASS",
    repairAttempted: sent.observations.providerAttempts.some(
      (attempt) => attempt.errorCode === "INVALID_STRUCTURED_OUTPUT",
    ),
    idempotentReplay: sent.parsed?.idempotentReplay === true,
  };
}

function retrievalRunsForSource(
  database: Database,
  agentId: string,
  sourceMessageId: string,
): RetrievalRun[] {
  const repository = new RetrievalRunRepository(database);
  const rows = database
    .prepare(
      `SELECT id FROM retrieval_runs
       WHERE agent_id = ? AND source_message_id = ?
       ORDER BY rowid DESC`,
    )
    .all(agentId, sourceMessageId) as Array<{ id: string }>;
  return rows.flatMap((row) => {
    const run = repository.findById(row.id);
    return run === undefined ? [] : [run];
  });
}

async function commitEvidence(
  context: RunContext,
  evidence: TurnEvidence,
  activeDatabasePath: string,
  runtime: LongRunV2Runtime,
): Promise<void> {
  await appendTurnEvidence(
    context.evidencePath,
    evidence,
    context.secretValues,
  );
  await appendLongRunModelIoEvidence(
    context.modelIoPath,
    evidence,
    context.manifest,
    context.secretValues,
  );
  context.evidence.push(evidence);
  await refreshRunConversation(context);
  if (
    context.evidence.length % CHECKPOINT_EVERY === 0 ||
    context.evidence.length === 30 ||
    evidence.turnId === context.scenario.sharedTurns.at(-1)?.id ||
    evidence.turnId === context.scenario.branches[0].turns.at(-1)?.id ||
    evidence.turnId === context.scenario.branches[1].turns.at(-1)?.id
  ) {
    runtime.checkpointWal();
    await checkpoint(context, activeDatabasePath, evidence.branch);
  }
}

async function checkpoint(
  context: RunContext,
  livePath: string,
  branch: LongRunV2Branch,
): Promise<void> {
  const completed = context.evidence.length;
  const snapshotPath = resolve(
    context.checkpointDirectory,
    `database-${String(completed).padStart(3, "0")}-${branch}.sqlite`,
  );
  const databaseSha256 = await snapshotDatabase(livePath, snapshotPath);
  const checkpointValue: LongRunCheckpoint = {
    schemaVersion: "companion-long-run-checkpoint-v2",
    runId: context.input.runId,
    completedCandidateTurns: completed,
    completedTurnIds: context.evidence.map((item) => item.turnId),
    createdAtUtc: new Date().toISOString(),
    compatibility: compatibilityFromManifest(context.manifest),
    databases: [
      {
        role: context.evidence.at(-1)?.track === "paired" ? "paired" : branch,
        livePath,
        snapshotPath,
        sha256: databaseSha256,
      },
    ],
    evidenceJsonlSha256: await sha256File(context.evidencePath),
  };
  await writeAtomicCheckpoint(context.checkpointDirectory, checkpointValue);
}

async function checkpointAnchor(
  context: RunContext,
  sharedPath: string,
  datePath: string,
  friendsPath: string,
): Promise<void> {
  const completed = context.evidence.length;
  if (completed < 138) return;
  const path = resolve(
    context.checkpointDirectory,
    `branch-anchor-${String(completed).padStart(3, "0")}.json`,
  );
  if (await pathExists(path)) return;
  const databases: LongRunCheckpoint["databases"] = [];
  for (const [role, livePath] of [
    ["shared", sharedPath],
    ["date", datePath],
    ["friends", friendsPath],
  ] as const) {
    const snapshotPath = resolve(
      context.checkpointDirectory,
      `branch-anchor-${role}.sqlite`,
    );
    databases.push({
      role,
      livePath,
      snapshotPath,
      sha256: await snapshotDatabase(livePath, snapshotPath),
    });
  }
  await writeJsonExclusive(path, {
    schemaVersion: "companion-long-run-checkpoint-v2",
    runId: context.input.runId,
    completedCandidateTurns: completed,
    completedTurnIds: context.evidence.map((item) => item.turnId),
    createdAtUtc: new Date().toISOString(),
    compatibility: compatibilityFromManifest(context.manifest),
    databases,
    evidenceJsonlSha256: await sha256File(context.evidencePath),
  } satisfies LongRunCheckpoint);
}

async function reusePilotEvidence(context: RunContext): Promise<void> {
  const directory = resolve(context.input.reusedPilotDirectory!);
  const pilotManifest = JSON.parse(
    await readFile(resolve(directory, "run-manifest.json"), "utf8"),
  ) as RunManifest;
  const pilotEvidence = await readTurnEvidence(
    resolve(directory, "turn-evidence.jsonl"),
  );
  const gate = evaluateLongRunV2PilotGate(pilotEvidence);
  if (!gate.eligibleForClosedLoop) {
    throw new Error(`Pilot ${pilotManifest.runId} did not pass its paid gate.`);
  }
  assertReusablePilot(context.manifest, pilotManifest);
  const sourceDatabases = await listLongRunV2DatabaseArtifacts(
    resolve(directory, "databases", "paired"),
  );
  if (sourceDatabases.length !== 30) {
    throw new Error(
      `Pilot ${pilotManifest.runId} has ${String(sourceDatabases.length)}/30 paired SQLite artifacts.`,
    );
  }
  const copiedDatabases: Array<{ path: string; sha256: string }> = [];
  for (const source of sourceDatabases) {
    const destination = resolve(
      context.databaseDirectory,
      "paired",
      basename(source),
    );
    await copyDatabase(source, destination);
    copiedDatabases.push({
      path: destination,
      sha256: await sha256File(destination),
    });
    context.databasePaths.push(destination);
  }
  for (const item of pilotEvidence.filter(
    (candidate) => candidate.track === "paired",
  )) {
    const reused: TurnEvidence = {
      ...item,
      matrixId: context.input.matrixId,
      runId: context.input.runId,
      reusedFromRunId: pilotManifest.runId,
    };
    await appendTurnEvidence(
      context.evidencePath,
      reused,
      context.secretValues,
    );
    await appendLongRunModelIoEvidence(
      context.modelIoPath,
      reused,
      context.manifest,
      context.secretValues,
    );
    context.evidence.push(reused);
    await refreshRunConversation(context);
  }
  await writeJsonExclusive(resolve(context.runDirectory, "pilot-reuse.json"), {
    sourceDirectory: directory,
    sourceRunId: pilotManifest.runId,
    candidateCount: 30,
    copiedDatabases,
    sourceEvidenceSha256: await sha256File(
      resolve(directory, "turn-evidence.jsonl"),
    ),
  });
}

function assertReusablePilot(current: RunManifest, pilot: RunManifest): void {
  const mismatch =
    pilot.mode !== "pilot" ||
    pilot.profile !== current.profile ||
    pilot.repetition !== 1 ||
    pilot.git.revision !== current.git.revision ||
    pilot.git.dirty !== current.git.dirty ||
    pilot.git.dirtyPatchSha256 !== current.git.dirtyPatchSha256 ||
    pilot.scenario.manifestSha256 !== current.scenario.manifestSha256 ||
    pilot.baseline.databaseSha256 !== current.baseline.databaseSha256 ||
    pilot.configSha256 !== current.configSha256 ||
    sha256Canonical(pilot.profileConfig) !==
      sha256Canonical(current.profileConfig);
  if (mismatch) {
    throw new Error(
      "Pilot cannot be reused: Git/worktree, scenario, baseline, or profile configuration differs.",
    );
  }
}

async function finishRun(
  context: RunContext,
  pilotGate?: ReturnType<typeof evaluateLongRunV2PilotGate>,
): Promise<LongRunV2SingleRunResult> {
  const discoveredDatabasePaths = await listLongRunV2DatabaseArtifacts(
    context.databaseDirectory,
  );
  let summary = summarizeLongRunV2Run({
    manifest: context.manifest,
    evidence: context.evidence,
    evidencePath: context.evidencePath,
    databasePaths: [
      ...new Set([...context.databasePaths, ...discoveredDatabasePaths]),
    ].sort(),
  });
  if (
    pilotGate &&
    !pilotGate.eligibleForClosedLoop &&
    pilotGate.status !== "PARTIAL"
  ) {
    summary = {
      ...summary,
      status: "FAIL",
      finalStatus: pilotGate.status,
      warnings: [...summary.warnings, ...pilotGate.reasons],
    };
  }
  await refreshRunDeliveryArtifacts(context);
  if (shouldStop(context)) {
    await atomicWriteMutableJson(
      resolve(context.runDirectory, "progress-summary.json"),
      summary,
    );
    return {
      runDirectory: context.runDirectory,
      summary,
      ...(pilotGate ? { pilotGate } : {}),
    };
  }
  await writeJsonExclusive(
    resolve(context.runDirectory, "run-summary.json"),
    summary,
  );
  await writeTextExclusive(
    resolve(context.runDirectory, "run-report.md"),
    renderLongRunV2RunMarkdown(summary),
  );
  return {
    runDirectory: context.runDirectory,
    summary,
    ...(pilotGate ? { pilotGate } : {}),
  };
}

async function refreshRunConversation(context: RunContext): Promise<void> {
  await atomicWriteMutableText(
    resolve(context.runDirectory, "conversation.md"),
    renderLongRunV2Conversation(context.evidence),
  );
}

async function refreshRunDeliveryArtifacts(context: RunContext): Promise<void> {
  await refreshRunConversation(context);
  await rewriteLongRunModelIoEvidence(
    context.modelIoPath,
    context.evidence,
    context.manifest,
    context.secretValues,
  );
}

export async function buildRunManifest(
  input: LongRunV2SingleRunInput,
  baseline: LongRunBaselineDescriptor,
  scenario: LongRunScenarioManifestV2,
): Promise<RunManifest> {
  const git = await readGitFingerprint(input.workspaceRoot);
  const featureFlags = LONG_RUN_V2_FEATURE_FLAGS;
  return {
    schemaVersion: "companion-long-run-run-manifest-v2",
    matrixId: input.matrixId,
    runId: input.runId,
    mode: input.mode,
    profile: input.profile,
    repetition: input.repetition,
    plannedTracks: [...input.tracks],
    createdAtUtc: new Date().toISOString(),
    git,
    scenario: {
      version: scenario.scenarioVersion,
      manifestSha256:
        scenario === companionLongRunV2Manifest
          ? COMPANION_LONG_RUN_V2_SHA256
          : sha256Canonical(scenario),
    },
    baseline: {
      databaseSha256: baseline.databaseSha256,
      characterSpecSha256: baseline.characterSpecSha256,
      initialStateSha256: baseline.initialStateSha256,
      scheduleSha256: baseline.scheduleSha256,
    },
    profileConfig: input.profileConfig,
    featureFlags,
    checkpointEveryTurns: CHECKPOINT_EVERY,
    configSha256: computeLongRunV2ConfigSha256(
      input.profileConfigSha256,
      input.serverConfig.conversationRetention,
    ),
    ...(input.profileConfig.baseOrigin.includes("wanzhao.top")
      ? {
          identityCaveat:
            "晚照云返回成功只能证明所配置模型 ID 可调用，不能单独证明实际上游模型身份。",
        }
      : {}),
  };
}

export async function ensureFrozenBaseline(
  matrixDirectory: string,
): Promise<LongRunBaselineDescriptor> {
  const directory = resolve(matrixDirectory, "baseline");
  const databasePath = resolve(directory, "gulan-v2.sqlite");
  const descriptorPath = resolve(directory, "descriptor.json");
  if (await pathExists(descriptorPath)) {
    const descriptor = JSON.parse(
      await readFile(descriptorPath, "utf8"),
    ) as LongRunBaselineDescriptor;
    const actual = await sha256File(databasePath);
    if (descriptor.databaseSha256 !== actual) {
      throw new Error(
        "Frozen baseline SQLite hash no longer matches its descriptor.",
      );
    }
    return { ...descriptor, databasePath };
  }
  await mkdir(directory, { recursive: true });
  const descriptor = await createCompanionLongRunV2Baseline(databasePath);
  await writeJsonExclusive(descriptorPath, {
    ...descriptor,
    databasePath: "gulan-v2.sqlite",
  });
  return descriptor;
}

async function resumeEvidenceAtLatestCheckpoint(
  runDirectory: string,
  manifest: RunManifest,
): Promise<TurnEvidence[]> {
  const checkpointDirectory = resolve(runDirectory, "checkpoints");
  const names = (await readdir(checkpointDirectory).catch(() => []))
    .filter((name) => /^checkpoint-\d+\.json$/u.test(name))
    .sort();
  const latest = names.at(-1);
  if (!latest) {
    const evidencePath = resolve(runDirectory, "turn-evidence.jsonl");
    const existing = await readFile(evidencePath, "utf8").catch(() => "");
    if (existing !== "") {
      await writeTextExclusive(
        resolve(
          runDirectory,
          `orphaned-before-first-checkpoint-${Date.now().toString()}.jsonl`,
        ),
        existing,
      );
      await atomicWriteText(evidencePath, "");
      await atomicWriteMutableJson(resolve(runDirectory, "resume-audit.json"), {
        checkpoint: null,
        discardedEvidenceRecords: existing
          .split(/\r?\n/u)
          .filter((line) => line !== "").length,
        resumedAtUtc: new Date().toISOString(),
      });
    }
    return [];
  }
  const checkpointValue = JSON.parse(
    await readFile(resolve(checkpointDirectory, latest), "utf8"),
  ) as LongRunCheckpoint;
  assertResumeCompatible(manifest, checkpointValue);
  for (const database of checkpointValue.databases) {
    if ((await sha256File(database.snapshotPath)) !== database.sha256) {
      throw new Error(
        `Checkpoint database hash mismatch: ${database.snapshotPath}`,
      );
    }
    await copyDatabase(database.snapshotPath, database.livePath);
  }
  const evidencePath = resolve(runDirectory, "turn-evidence.jsonl");
  const evidence = (await readTurnEvidence(evidencePath)).slice(
    0,
    checkpointValue.completedCandidateTurns,
  );
  if (
    evidence.map((item) => item.turnId).join("\n") !==
    checkpointValue.completedTurnIds.join("\n")
  ) {
    throw new Error("Checkpoint turn IDs do not match the evidence prefix.");
  }
  const existing = await readFile(evidencePath, "utf8");
  const kept =
    evidence.map((item) => JSON.stringify(item)).join("\n") +
    (evidence.length ? "\n" : "");
  if (sha256Text(kept) !== checkpointValue.evidenceJsonlSha256) {
    throw new Error(
      "Checkpoint evidence hash does not match its JSONL prefix.",
    );
  }
  if (existing !== kept) {
    await writeTextExclusive(
      resolve(
        runDirectory,
        `orphaned-after-checkpoint-${Date.now().toString()}.jsonl`,
      ),
      existing,
    );
    await atomicWriteMutableJson(resolve(runDirectory, "resume-audit.json"), {
      checkpoint: latest,
      discardedEvidenceRecords:
        (await readTurnEvidence(evidencePath)).length - evidence.length,
      resumedAtUtc: new Date().toISOString(),
    });
    await atomicWriteText(evidencePath, kept);
  }
  return evidence;
}

async function atomicWriteText(path: string, value: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  const { writeFile, rename } = await import("node:fs/promises");
  await writeFile(temporary, value, "utf8");
  await rename(temporary, path);
}

function compatibilityFromManifest(
  manifest: RunManifest,
): LongRunCheckpoint["compatibility"] {
  return {
    configSha256: manifest.configSha256,
    git: manifest.git,
    scenario: manifest.scenario,
    baseline: manifest.baseline,
    profileConfig: manifest.profileConfig,
  };
}

function pairedProbeAsTurn(
  probe: LongRunPairedProbeSpec,
  ordinal: number,
): LongRunTurnSpec {
  return {
    id: probe.id,
    candidateNumber: ordinal,
    executionOrdinal: ordinal,
    scope: "shared",
    blockId: `paired-${probe.category}`,
    phase: probe.category,
    objective: probe.objective,
    sessionKey: "S1",
    userText: probe.userText,
    ...(probe.actionsBefore === undefined
      ? {}
      : { actionsBefore: probe.actionsBefore }),
    hardAssertions: probe.hardAssertions,
    semanticRubricTags: probe.semanticRubricTags,
  };
}

function findPersistedAssistant(
  snapshot: LongRunStateSnapshot,
  response?: SendMessageResponse,
): unknown {
  if (!response) return undefined;
  return snapshot.messages.find((message) => {
    const record = asRecord(message);
    return record["id"] === response.assistantMessage.id;
  });
}

function deterministicClientMessageId(runId: string, turnId: string): string {
  return `lr2_${sha256Text(`${runId}:${turnId}`).slice(0, 28)}`;
}

async function copyDatabase(
  source: string,
  destination: string,
): Promise<void> {
  await mkdir(resolve(destination, ".."), { recursive: true });
  await copyFile(source, destination);
}

export async function listLongRunV2DatabaseArtifacts(
  directory: string,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return [];
      }
      throw error;
    },
  );
  const paths = (
    await Promise.all(
      entries.map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return listLongRunV2DatabaseArtifacts(path);
        return entry.isFile() && entry.name.endsWith(".sqlite") ? [path] : [];
      }),
    )
  ).flat();
  return paths.sort();
}

function shouldStop(context: RunContext): boolean {
  return (
    context.input.stopAfterCandidate !== undefined &&
    context.evidence.length >= context.input.stopAfterCandidate
  );
}

function latestFakeTime(
  evidence: readonly TurnEvidence[],
  fallback?: string,
): string {
  return (
    evidence.at(-1)?.fakeTimeAfterUtc ??
    fallback ??
    companionLongRunV2Manifest.startAtUtc
  );
}

function safeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/gu, "-");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type LongRunEvidenceHistoricalRows = Pick<
  LongRunStateSnapshot,
  LongRunV2EvidenceHistoryCollection
>;

interface LongRunEvidenceHistoryProjection {
  retainedRows: LongRunEvidenceHistoricalRows;
  audits: Record<
    LongRunV2EvidenceHistoryCollection,
    LongRunEvidenceHistoryCollectionAudit
  >;
}

/**
 * Projects the two full assertion snapshots into the JSONL evidence shape.
 * Mutable authoritative state stays complete. Append-only history becomes a
 * bounded tail plus collection-wide hashes and an exhaustive per-turn delta.
 */
export function compactLongRunV2EvidenceSnapshots(
  before: LongRunStateSnapshot,
  after: LongRunStateSnapshot,
  tailLimit = LONG_RUN_V2_EVIDENCE_TAIL_LIMIT,
): { before: LongRunStateSnapshot; after: LongRunStateSnapshot } {
  if (!Number.isSafeInteger(tailLimit) || tailLimit < 1) {
    throw new RangeError(
      "Evidence history tail limit must be a positive integer.",
    );
  }
  const beforeProjection = projectEvidenceHistory(before, tailLimit);
  const afterProjection = projectEvidenceHistory(after, tailLimit);
  const afterAudits = Object.fromEntries(
    LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS.map((collection) => [
      collection,
      {
        ...afterProjection.audits[collection],
        deltaFromBefore: diffEvidenceHistory(
          before[collection],
          after[collection],
          beforeProjection.audits[collection].sha256,
        ),
      },
    ]),
  ) as Record<
    LongRunV2EvidenceHistoryCollection,
    LongRunEvidenceHistoryCollectionAudit
  >;
  return {
    before: attachEvidenceHistory(
      before,
      beforeProjection.retainedRows,
      beforeProjection.audits,
      tailLimit,
    ),
    after: attachEvidenceHistory(
      after,
      afterProjection.retainedRows,
      afterAudits,
      tailLimit,
    ),
  };
}

function projectEvidenceHistory(
  snapshot: LongRunStateSnapshot,
  tailLimit: number,
): LongRunEvidenceHistoryProjection {
  const retainedRows = Object.fromEntries(
    LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS.map((collection) => [
      collection,
      snapshot[collection].slice(-tailLimit),
    ]),
  ) as LongRunEvidenceHistoricalRows;
  const audits = Object.fromEntries(
    LONG_RUN_V2_EVIDENCE_HISTORY_COLLECTIONS.map((collection) => [
      collection,
      {
        total: snapshot[collection].length,
        sha256: sha256Canonical(snapshot[collection]),
        retainedTailCount: retainedRows[collection].length,
      },
    ]),
  ) as Record<
    LongRunV2EvidenceHistoryCollection,
    LongRunEvidenceHistoryCollectionAudit
  >;
  return { retainedRows, audits };
}

function attachEvidenceHistory(
  snapshot: LongRunStateSnapshot,
  retainedRows: LongRunEvidenceHistoricalRows,
  collections: Record<
    LongRunV2EvidenceHistoryCollection,
    LongRunEvidenceHistoryCollectionAudit
  >,
  tailLimit: number,
): LongRunStateSnapshot {
  return {
    ...snapshot,
    ...retainedRows,
    evidenceHistory: {
      format: "bounded-tail-with-turn-delta-v1",
      tailLimit,
      collections,
    },
  };
}

function diffEvidenceHistory(
  before: readonly unknown[],
  after: readonly unknown[],
  baseSha256: string,
): LongRunEvidenceHistoryDelta {
  const prior = indexEvidenceRows(before);
  const current = indexEvidenceRows(after);
  const priorByKey = new Map(prior.map((item) => [item.rowKey, item]));
  const currentKeys = new Set(current.map((item) => item.rowKey));
  return {
    baseSha256,
    addedRows: current
      .filter((item) => !priorByKey.has(item.rowKey))
      .map((item) => item.row),
    updatedRows: current.flatMap((item) => {
      const previous = priorByKey.get(item.rowKey);
      return previous !== undefined && previous.sha256 !== item.sha256
        ? [{ rowKey: item.rowKey, row: item.row }]
        : [];
    }),
    removedRowKeys: prior
      .filter((item) => !currentKeys.has(item.rowKey))
      .map((item) => item.rowKey),
  };
}

function indexEvidenceRows(rows: readonly unknown[]): Array<{
  rowKey: string;
  row: unknown;
  sha256: string;
}> {
  const occurrences = new Map<string, number>();
  return rows.map((row) => {
    const record = asRecord(row);
    const id =
      typeof record["id"] === "string" && record["id"] !== ""
        ? record["id"]
        : undefined;
    const sha256 = sha256Canonical(row);
    const baseKey = id === undefined ? `sha256:${sha256}` : `id:${id}`;
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    return {
      rowKey: `${baseKey}#${String(occurrence)}`,
      row,
      sha256,
    };
  });
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

export function suggestedRunId(
  profile: LongRunV2Profile | "fixture",
  repetition: 1 | 2 | 3,
): string {
  return `${safeFileName(profile)}-r${String(repetition)}`;
}

export function suggestedMatrixId(
  mode: LongRunV2Mode,
  now = new Date(),
): string {
  return `${mode}-${now.toISOString().replace(/[-:.]/gu, "").replace("Z", "Z")}`;
}

export function artifactRoot(workspaceRoot: string): string {
  return resolve(workspaceRoot, "tmp", "companion-long-run-v2");
}

export function runDirectoryName(path: string): string {
  return basename(resolve(path));
}
