import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { ServerConfig } from "../config.js";
import { readConfig } from "../config.js";
import {
  CHAT_TURN_OUTPUT_TOKEN_TARGET,
  REPAIR_CHAT_TURN_OUTPUT_TOKEN_TARGET,
} from "../services/chat-output-budget.js";
import {
  COMPANION_LONG_RUN_V3_SHA256,
  companionLongRunV3Manifest,
  resolveLongRunV3ConditionalUserText,
  validateLongRunScenarioManifestV3,
} from "../scenarios/companion-long-run-v3-manifest.js";
import type {
  LongRunTurnSpec,
  LongRunV3BranchId,
  LongRunV3Decision,
} from "../scenarios/companion-long-run-v3-types.js";
import { readGitFingerprint } from "./companion-long-run-v2-artifacts.js";
import {
  readLongRunV2ProfileConfig,
  type LongRunV2ProfileConfigSnapshot,
} from "./companion-long-run-v2-profiles.js";
import {
  LONG_RUN_V3_AGENT_ID,
  LONG_RUN_V3_SESSION_ID,
  createCompanionLongRunV3Baseline,
  sha256FileV3,
  type LongRunV3BaselineDescriptor,
} from "./companion-long-run-v3-baseline.js";
import {
  appendLongRunV3CausalEvidence,
  appendLongRunV3ModelIo,
  appendLongRunV3TurnEvidence,
  assertLongRunV3ResumeCompatible,
  canonicalLongRunV3Json,
  createLongRunV3Checkpoint,
  inspectLongRunV3ArtifactCoverage,
  readLongRunV3Evidence,
  readLatestLongRunV3Checkpoint,
  redactLongRunV3Artifact,
  renderLongRunV3Conversation,
  resolveLongRunV3ArtifactPaths,
  restoreLongRunV3Checkpoint,
  sha256LongRunV3File,
  sha256LongRunV3Value,
  writeLongRunV3Checkpoint,
  writeLongRunV3JsonExclusive,
  writeLongRunV3RunManifest,
  verifyLongRunV3CheckpointFiles,
  type LongRunV3ArtifactDigest,
  type LongRunV3Branch,
  type LongRunV3ExpectedArtifactTurn,
  type LongRunV3RunManifest,
  type LongRunV3TurnEvidence,
} from "./companion-long-run-v3-artifacts.js";
import {
  createLongRunV3HardGateSkeleton,
  renderLongRunV3ReportMarkdown,
  summarizeLongRunV3Run,
  type LongRunV3HardGateResult,
  type LongRunV3RunSummary,
} from "./companion-long-run-v3-report.js";

const CHECKPOINT_EVERY_TURNS = 10;

export interface RunCompanionLongRunV3Options {
  workspaceRoot: string;
  profile: "fixture" | "deepseek";
  runId?: string;
  resume?: boolean;
  /** Test-only escape hatch. It is never used by the paid CLI. */
  stopAfterCandidate?: number;
}

export interface RunCompanionLongRunV3Result {
  runDirectory: string;
  summary: LongRunV3RunSummary;
  engineeringGatePassed: boolean;
}

interface RunContext {
  options: Required<
    Pick<RunCompanionLongRunV3Options, "workspaceRoot" | "profile" | "resume">
  > &
    Pick<RunCompanionLongRunV3Options, "stopAfterCandidate">;
  runId: string;
  runDirectory: string;
  paths: ReturnType<typeof resolveLongRunV3ArtifactPaths>;
  serverConfig: ServerConfig;
  manifest: LongRunV3RunManifest;
  baseline: LongRunV3BaselineDescriptor;
  baselinePath: string;
  sharedDatabasePath: string;
  stableDatabasePath: string;
  independentDatabasePath: string;
  turns: LongRunV3TurnEvidence[];
  explicitSecrets: string[];
}

/**
 * Executes the reviewed 108 + 6 + 6 scenario. The concrete HTTP/database
 * runtime is loaded lazily so manifest and artifact tests never construct a
 * provider or read a credential.
 */
export async function runCompanionLongRunV3(
  options: RunCompanionLongRunV3Options,
): Promise<RunCompanionLongRunV3Result> {
  const runId = options.runId ?? suggestedRunId(options.profile);
  const runDirectory = resolve(
    options.workspaceRoot,
    "tmp",
    "companion-long-run-v3",
    runId,
  );
  const context = await prepareRunContext({
    ...options,
    runId,
    runDirectory,
  });

  // Importing here keeps the paid boundary explicit. The runtime owns all
  // local HTTP calls and the two-layer Provider observer.
  const runtimeModule = await import("./companion-long-run-v3-runtime.js");
  await runtimeModule.executeLongRunV3Scenario(context);
  context.turns = await readLongRunV3Evidence(context.paths.turnEvidence);

  const hardGates = await evaluateRunHardGates(context);
  await writeJsonReplacing(context.paths.hardGates, hardGates);
  await ensureSemanticTemplate(context);
  const artifactIndex = await buildArtifactIndex(context);
  const summary = summarizeLongRunV3Run({
    manifest: context.manifest,
    evidence: context.turns,
    hardGates,
    artifacts: artifactIndex,
  });
  await writeFile(
    context.paths.report,
    renderLongRunV3ReportMarkdown(summary),
    "utf8",
  );
  await writeJsonReplacing(
    resolve(context.runDirectory, "run-summary.json"),
    summary,
  );

  const engineeringGatePassed =
    context.turns.length === companionLongRunV3Manifest.candidateCount &&
    context.turns.every(
      (turn) =>
        turn.status === "PASS" &&
        turn.assertions.every((assertion) => assertion.status === "PASS"),
    ) &&
    hardGates.every((gate) => gate.status === "PASS");
  await writeJsonReplacing(
    resolve(context.runDirectory, "engineering-gate.json"),
    {
      schemaVersion: "companion-long-run-v3-engineering-gate-v1",
      passed: engineeringGatePassed,
      completedCandidateTurns: context.turns.length,
      expectedCandidateTurns: companionLongRunV3Manifest.candidateCount,
      failed: hardGates
        .filter((gate) => gate.status === "FAIL")
        .map((gate) => gate.id),
      evaluatedAtUtc: new Date().toISOString(),
    },
  );
  return { runDirectory, summary, engineeringGatePassed };
}

async function prepareRunContext(
  input: RunCompanionLongRunV3Options & {
    runId: string;
    runDirectory: string;
  },
): Promise<RunContext> {
  const issues = validateLongRunScenarioManifestV3(companionLongRunV3Manifest);
  if (issues.length > 0) {
    throw new Error(`Invalid v3 manifest: ${issues.join("; ")}`);
  }
  const resume = input.resume ?? false;
  const paths = resolveLongRunV3ArtifactPaths(input.runDirectory);
  const baselinePath = resolve(input.runDirectory, "baseline.sqlite");
  const sharedDatabasePath = resolve(input.runDirectory, "run.sqlite");
  const stableDatabasePath = resolve(
    input.runDirectory,
    "branches",
    "stable.sqlite",
  );
  const independentDatabasePath = resolve(
    input.runDirectory,
    "branches",
    "independent.sqlite",
  );

  if (!resume && (await pathExists(input.runDirectory))) {
    throw new Error(`Artifact directory already exists: ${input.runDirectory}`);
  }
  await mkdir(resolve(input.runDirectory, "branches"), { recursive: true });
  await mkdir(paths.checkpointsDirectory, { recursive: true });

  let baseline: LongRunV3BaselineDescriptor;
  if (resume) {
    baseline = JSON.parse(
      await readFile(resolve(input.runDirectory, "baseline.json"), "utf8"),
    ) as LongRunV3BaselineDescriptor;
    if ((await sha256FileV3(baselinePath)) !== baseline.databaseSha256) {
      throw new Error("Baseline hash mismatch while resuming v3 long-run.");
    }
  } else {
    baseline = await createCompanionLongRunV3Baseline(baselinePath);
    await writeLongRunV3JsonExclusive(
      resolve(input.runDirectory, "baseline.json"),
      baseline,
    );
    await copyFile(baselinePath, sharedDatabasePath);
  }

  const profileResolution = resolveProfile(input.profile);
  if (input.profile === "deepseek") {
    assertLongRunV3DeepSeekProfileExpectation(
      profileResolution.serverConfig,
      profileResolution.profileConfig,
    );
  }
  const git = await readGitFingerprint(input.workspaceRoot);
  const manifest: LongRunV3RunManifest = {
    schemaVersion: "companion-long-run-run-manifest-v3",
    runId: input.runId,
    profile: input.profile,
    createdAtUtc: new Date().toISOString(),
    plannedCandidateTurns: 120,
    git,
    scenario: {
      version: companionLongRunV3Manifest.scenarioVersion,
      manifestSha256: COMPANION_LONG_RUN_V3_SHA256,
    },
    baseline: {
      databaseSha256: baseline.databaseSha256,
      characterSpecSha256: baseline.characterSpecSha256,
      initialStateSha256: baseline.initialStateSha256,
    },
    profileConfig: profileResolution.profileConfig,
    featureFlags: {
      lifePlanningMode: "fuzzy",
      liveWorldEffectsMode: "enforced",
      memoryRecallMode: "enforced",
      scheduler: "disabled",
      autobiographyMode: "off",
    },
    checkpointEveryTurns: CHECKPOINT_EVERY_TURNS,
    configSha256: sha256LongRunV3Value({
      profile: profileResolution.profileConfig,
      featureFlags: companionLongRunV3Manifest.featureFlags,
      conversationRetention:
        profileResolution.serverConfig.conversationRetention,
    }),
    ...(input.profile === "deepseek"
      ? {
          identityCaveat:
            "成功调用配置的模型 ID 不能单独证明第三方网关实际上游身份。",
        }
      : {}),
  };

  let turns: LongRunV3TurnEvidence[] = [];
  if (resume) {
    const persisted = JSON.parse(
      await readFile(paths.runManifest, "utf8"),
    ) as LongRunV3RunManifest;
    assertManifestCompatible(manifest, persisted);
    manifest.createdAtUtc = persisted.createdAtUtc;
    const checkpoint = await readLatestLongRunV3Checkpoint(input.runDirectory);
    if (checkpoint.runId !== input.runId) {
      throw new Error("Checkpoint run ID does not match the selected run.");
    }
    await restoreLongRunV3Checkpoint({
      runDirectory: input.runDirectory,
      manifest,
      checkpoint,
      activeDatabases: {
        shared: sharedDatabasePath,
        stable: stableDatabasePath,
        independent: independentDatabasePath,
      },
    });
    turns = await readLongRunV3Evidence(paths.turnEvidence);
    const restoredTurnIds = turns.map((turn) => turn.turnId);
    if (
      canonicalLongRunV3Json(restoredTurnIds) !==
      canonicalLongRunV3Json(checkpoint.completedTurnIds)
    ) {
      throw new Error(
        "Restored turn evidence does not match committed checkpoint progress.",
      );
    }
    const expected = expectedArtifactTurns().slice(
      0,
      checkpoint.completedCandidateTurns,
    );
    if (
      canonicalLongRunV3Json(expected.map((turn) => turn.turnId)) !==
      canonicalLongRunV3Json(checkpoint.completedTurnIds)
    ) {
      throw new Error(
        "Checkpoint progress is not a canonical prefix of the v3 scenario.",
      );
    }
    const coverage = await inspectLongRunV3ArtifactCoverage({
      paths,
      expectedTurns: expected,
      manifest,
    });
    if (!coverage.passed) {
      throw new Error(
        `Checkpoint artifact coverage is invalid: ${coverage.issues.join("; ")}`,
      );
    }
  } else {
    await writeLongRunV3RunManifest(
      input.runDirectory,
      manifest,
      profileResolution.explicitSecrets,
    );
    // Create streaming files before the first candidate so a crash still has
    // an unambiguous, resumable evidence location.
    await Promise.all([
      writeFile(paths.conversation, renderLongRunV3Conversation([]), {
        flag: "wx",
      }),
      writeFile(paths.modelIo, "", { flag: "wx" }),
      writeFile(paths.causalEvidence, "", { flag: "wx" }),
      writeFile(paths.turnEvidence, "", { flag: "wx" }),
    ]);
    const checkpoint = await createLongRunV3Checkpoint({
      runDirectory: input.runDirectory,
      manifest,
      completedCandidateTurns: 0,
      completedTurnIds: [],
      databases: [{ role: "shared", path: sharedDatabasePath }],
      createdAtUtc: companionLongRunV3Manifest.startAtUtc,
    });
    await writeLongRunV3Checkpoint(input.runDirectory, checkpoint);
  }

  return {
    options: {
      workspaceRoot: input.workspaceRoot,
      profile: input.profile,
      resume,
      ...(input.stopAfterCandidate === undefined
        ? {}
        : { stopAfterCandidate: input.stopAfterCandidate }),
    },
    runId: input.runId,
    runDirectory: input.runDirectory,
    paths,
    serverConfig: profileResolution.serverConfig,
    manifest,
    baseline,
    baselinePath,
    sharedDatabasePath,
    stableDatabasePath,
    independentDatabasePath,
    turns,
    explicitSecrets: profileResolution.explicitSecrets,
  };
}

function resolveProfile(profile: "fixture" | "deepseek"): {
  serverConfig: ServerConfig;
  profileConfig: LongRunV3RunManifest["profileConfig"];
  explicitSecrets: string[];
} {
  if (profile === "fixture") {
    const base = readFixtureConfig();
    return {
      serverConfig: base,
      profileConfig: {
        provider: "fixture",
        profileName: "fixture",
        baseOrigin: "http://fixture.invalid",
        baseUrl: "http://fixture.invalid",
        requestedModel: "personasim-fixture-v1",
        timeoutMs: 5_000,
        maxRetries: 0,
        apiKeyPresent: false,
      },
      explicitSecrets: [],
    };
  }
  const snapshot = readLongRunV2ProfileConfig("deepseek");
  if (!snapshot.apiKeyPresent) {
    throw new Error(
      `DeepSeek API key is missing (${snapshot.apiKeyEnvironment}).`,
    );
  }
  const serverConfig = readConfig();
  const apiKey = serverConfig.llm.apiKey;
  return {
    serverConfig,
    profileConfig: liveProfile(snapshot),
    explicitSecrets: apiKey === undefined ? [] : [apiKey],
  };
}

export function buildLongRunV3ServerConfig(
  base: ServerConfig,
  databasePath: string,
  fixture: boolean,
): ServerConfig {
  return {
    ...base,
    nodeEnv: "test",
    profile: "companion-long-run-v3",
    databasePath,
    clockMode: "fake",
    fakeClockStart: companionLongRunV3Manifest.startAtUtc,
    developerRoutes: true,
    seedDemo: false,
    chatEffectsMode: "gated",
    lifePlanningMode: "fuzzy",
    scheduleNegotiationMode: "legacy",
    selfInitiatedPlanningMode: "off",
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

export function liveProfile(
  snapshot: LongRunV2ProfileConfigSnapshot,
): LongRunV3RunManifest["profileConfig"] {
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
    repairMaxOutputTokens: 16_384,
    apiKeyEnvironment: snapshot.apiKeyEnvironment,
    apiKeyPresent: snapshot.apiKeyPresent,
  };
}

export function assertLongRunV3DeepSeekProfileExpectation(
  serverConfig: ServerConfig,
  profileConfig: LongRunV3RunManifest["profileConfig"],
): void {
  const expected = companionLongRunV3Manifest.profileExpectation;
  const capabilities = serverConfig.llm.capabilities;
  const checks: Array<{
    field: string;
    actual: unknown;
    expected: unknown;
  }> = [
    {
      field: "provider",
      actual: serverConfig.llm.provider,
      expected: expected.provider,
    },
    {
      field: "baseUrl",
      actual: normalizeLongRunV3ProviderBaseUrl(serverConfig.llm.baseUrl),
      expected: normalizeLongRunV3ProviderBaseUrl(expected.baseUrl),
    },
    {
      field: "requestModel",
      actual: serverConfig.llm.model,
      expected: expected.requestModel,
    },
    {
      field: "reasoningEffort",
      actual: capabilities?.reasoningEffort,
      expected: expected.reasoningEffort,
    },
    {
      field: "reasoningRequestFormat",
      actual: capabilities?.reasoningRequestFormat,
      expected: expected.reasoningRequestFormat,
    },
    {
      field: "attemptTimeoutMs",
      actual: serverConfig.llm.timeoutMs,
      expected: expected.attemptTimeoutMs,
    },
    {
      field: "maxTransportRetries",
      actual: serverConfig.llm.maxRetries,
      expected: expected.maxTransportRetries,
    },
    {
      field: "providerMaxOutputTokens",
      actual: serverConfig.llm.maxOutputTokens,
      expected: expected.providerMaxOutputTokens,
    },
    {
      field: "maxContextTokens",
      actual: capabilities?.maxContextTokens,
      expected: expected.maxContextTokens,
    },
    {
      field: "capabilityMaxOutputTokens",
      actual: capabilities?.maxOutputTokens,
      expected: expected.providerMaxOutputTokens,
    },
    {
      field: "chatTargetOutputTokens",
      actual: CHAT_TURN_OUTPUT_TOKEN_TARGET,
      expected: expected.chatTargetOutputTokens,
    },
    {
      field: "repairTargetOutputTokens",
      actual: REPAIR_CHAT_TURN_OUTPUT_TOKEN_TARGET,
      expected: expected.repairTargetOutputTokens,
    },
    {
      field: "manifestProfile.provider",
      actual: profileConfig.provider,
      expected: expected.provider,
    },
    {
      field: "manifestProfile.baseOrigin",
      actual: profileConfig.baseOrigin,
      expected: new URL(expected.baseUrl).origin,
    },
    {
      field: "manifestProfile.baseUrl",
      actual: profileConfig.baseUrl,
      expected: serverConfig.llm.baseUrl,
    },
    {
      field: "manifestProfile.requestedModel",
      actual: profileConfig.requestedModel,
      expected: expected.requestModel,
    },
    {
      field: "manifestProfile.reasoningEffort",
      actual: profileConfig.reasoningEffort,
      expected: expected.reasoningEffort,
    },
    {
      field: "manifestProfile.reasoningRequestFormat",
      actual: profileConfig.reasoningRequestFormat,
      expected: expected.reasoningRequestFormat,
    },
    {
      field: "manifestProfile.timeoutMs",
      actual: profileConfig.timeoutMs,
      expected: expected.attemptTimeoutMs,
    },
    {
      field: "manifestProfile.maxRetries",
      actual: profileConfig.maxRetries,
      expected: expected.maxTransportRetries,
    },
    {
      field: "manifestProfile.maxOutputTokens",
      actual: profileConfig.maxOutputTokens,
      expected: expected.providerMaxOutputTokens,
    },
    {
      field: "manifestProfile.maxContextTokens",
      actual: profileConfig.maxContextTokens,
      expected: expected.maxContextTokens,
    },
    {
      field: "manifestProfile.repairMaxOutputTokens",
      actual: profileConfig.repairMaxOutputTokens,
      expected: expected.repairTargetOutputTokens,
    },
  ];
  const mismatches = checks.filter(
    (check) => !Object.is(check.actual, check.expected),
  );
  if (mismatches.length > 0) {
    throw new Error(
      `DeepSeek v3 profile does not match the reviewed manifest: ${mismatches
        .map(
          (mismatch) =>
            `${mismatch.field}=actual(${String(mismatch.actual)})/expected(${String(mismatch.expected)})`,
        )
        .join("; ")}`,
    );
  }
}

function normalizeLongRunV3ProviderBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return value;
  }
  const pathname = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${pathname}`;
}

async function evaluateRunHardGates(
  context: RunContext,
): Promise<LongRunV3HardGateResult[]> {
  const gates = createLongRunV3HardGateSkeleton();
  const assertionFailures = context.turns.flatMap((turn) =>
    turn.assertions
      .filter((assertion) => assertion.status === "FAIL")
      .map((assertion) => `${turn.turnId}:${assertion.code}`),
  );
  const hasAllTurns = context.turns.length === 120;
  const allScheduleEmpty = context.turns.every(
    (turn) => turn.after.scheduleItems.length === 0,
  );
  const prompts = context.turns
    .flatMap((turn) => turn.logicalCalls)
    .filter((call) => call.purpose === "chat_turn");
  const promptShapeValid = longRunV3PromptShapeValid(prompts);
  const branchCounts = {
    stable: context.turns.filter((turn) => turn.branch === "stable").length,
    independent: context.turns.filter((turn) => turn.branch === "independent")
      .length,
  };

  for (const gate of gates) {
    switch (gate.id) {
      case "H01":
        setGate(gate, true, [
          `git:${context.manifest.git.revision}`,
          `scenario:${context.manifest.scenario.manifestSha256}`,
          `baseline:${context.manifest.baseline.databaseSha256}`,
        ]);
        break;
      case "H02":
        setGate(gate, hasAllTurns, [`${String(context.turns.length)}/120`]);
        break;
      case "H03":
      case "H04":
      case "H07":
      case "H09":
      case "H10":
      case "H11":
      case "H12":
      case "H13":
      case "H14":
      case "H15":
      case "H17": {
        const outcome = assertionBackedHardGateOutcome(
          gate.id,
          assertionFailures,
          hasAllTurns,
        );
        setGate(gate, outcome.passed, outcome.evidence);
        break;
      }
      case "H05": {
        const invalid = context.turns.filter((turn) =>
          turn.assertions.some(
            (assertion) =>
              assertion.code === "fuzzy_life_context_unique_per_local_day" &&
              assertion.status === "FAIL",
          ),
        );
        setGate(
          gate,
          invalid.length === 0 && hasAllTurns,
          invalid.map((turn) => turn.turnId),
        );
        break;
      }
      case "H06":
        setGate(gate, allScheduleEmpty && promptShapeValid && hasAllTurns, [
          `schedule-empty:${String(allScheduleEmpty)}`,
          `prompt-shape:${String(promptShapeValid)}`,
        ]);
        break;
      case "H08": {
        const modes = new Set(
          context.turns.flatMap((turn) =>
            turn.after.supportInterventions.flatMap((episode) => {
              const record = asRecord(episode);
              return typeof record["mode"] === "string" ? [record["mode"]] : [];
            }),
          ),
        );
        const expected = [
          "listen_only",
          "deliberate",
          "recommend",
          "delegated_decision",
        ];
        const turnMismatches = assertionFailures.filter((failure) =>
          failure.includes("support_mode_matches_request"),
        );
        setGate(
          gate,
          expected.every((mode) => modes.has(mode)) &&
            turnMismatches.length === 0 &&
            hasAllTurns,
          [`modes:${[...modes].sort().join(",")}`, ...turnMismatches],
        );
        break;
      }
      case "H16":
        setGate(
          gate,
          branchCounts.stable === 6 && branchCounts.independent === 6,
          [
            `stable:${String(branchCounts.stable)}`,
            `independent:${String(branchCounts.independent)}`,
          ],
        );
        break;
      case "H18": {
        const frontend = await inspectFrontendMigration(
          context.options.workspaceRoot,
        );
        setGate(gate, frontend.passed, frontend.evidence);
        break;
      }
      case "H19": {
        const required = [
          context.paths.runManifest,
          resolve(context.runDirectory, "baseline.json"),
          context.paths.conversation,
          context.paths.modelIo,
          context.paths.causalEvidence,
          context.paths.turnEvidence,
          context.baselinePath,
          context.sharedDatabasePath,
          context.stableDatabasePath,
          context.independentDatabasePath,
        ];
        const existing = await Promise.all(required.map(pathExists));
        const evidence = required.map(
          (path, index) =>
            `${path}:${existing[index] === true ? "present" : "missing"}`,
        );
        let passed = existing.every(Boolean);
        if (passed) {
          try {
            const coverage = await inspectLongRunV3ArtifactCoverage({
              paths: context.paths,
              expectedTurns: expectedArtifactTurns(),
              manifest: context.manifest,
            });
            evidence.push(
              `coverage:${canonicalLongRunV3Json(coverage.counts)}`,
              ...coverage.issues,
            );
            passed = coverage.passed;

            const checkpoint = await readLatestLongRunV3Checkpoint(
              context.runDirectory,
            );
            assertLongRunV3ResumeCompatible(context.manifest, checkpoint);
            await verifyLongRunV3CheckpointFiles(
              context.runDirectory,
              checkpoint,
            );
            evidence.push(
              `checkpoint:${String(checkpoint.completedCandidateTurns)}`,
            );
            passed = passed && checkpoint.completedCandidateTurns === 120;
          } catch (error) {
            passed = false;
            evidence.push(
              `artifact_validation_error:${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        setGate(gate, passed, evidence);
        break;
      }
    }
  }
  return gates;
}

export function hardGateFailureMatches(
  gateId: LongRunV3HardGateResult["id"],
  failure: string,
): boolean {
  const codes: Partial<Record<LongRunV3HardGateResult["id"], string[]>> = {
    H03: [
      "http_success",
      "response_contract_valid",
      "persisted",
      "trace_lineage",
      "causal",
    ],
    H04: [
      "no_unvalidated",
      "delegated",
      "planned_not_occurred",
      "user_boundary_respected",
    ],
    H07: [
      "causal_stage",
      "causal_recap_grounded",
      "causal_provenance_grounded",
      "relationship_continuity_grounded",
    ],
    H09: ["delegated_decision"],
    H10: ["user_decision_not_delegated"],
    H11: ["bidirectional"],
    H12: ["pressure_change"],
    H13: ["memory_", "relationship_continuity_grounded"],
    H14: ["restart", "replay", "rollback"],
    H15: ["background", "proactive"],
    H16: ["branch_", "cross_session_continuity"],
    H17: ["prompt_budget", "prompt_excludes", "prompt_includes_life_context"],
  };
  return (codes[gateId] ?? []).some((code) => failure.includes(code));
}

export function assertionBackedHardGateOutcome(
  gateId: LongRunV3HardGateResult["id"],
  assertionFailures: readonly string[],
  hasAllTurns: boolean,
): { passed: boolean; evidence: string[] } {
  const evidence = assertionFailures.filter((failure) =>
    hardGateFailureMatches(gateId, failure),
  );
  return { passed: evidence.length === 0 && hasAllTurns, evidence };
}

export function longRunV3PromptShapeValid(
  calls: ReadonlyArray<{ system: string; prompt: string }>,
): boolean {
  return calls.every((call) => {
    const primaryPrompt = `${call.system}\n${call.prompt}`;
    return (
      !primaryPrompt.includes("FUTURE_SCHEDULE_JSON") &&
      !primaryPrompt.includes("CURRENT_ACTIVITY_JSON") &&
      primaryPrompt.includes("LIFE_CONTEXT_JSON")
    );
  });
}

function setGate(
  gate: LongRunV3HardGateResult,
  passed: boolean,
  evidence: string[],
): void {
  gate.status = passed ? "PASS" : "FAIL";
  gate.evidence =
    evidence.length === 0 ? [passed ? "verified" : "missing"] : evidence;
  gate.summary = passed ? "证据满足硬门。" : "证据未满足硬门。";
}

async function ensureSemanticTemplate(context: RunContext): Promise<void> {
  if (await pathExists(context.paths.semanticScores)) return;
  await writeLongRunV3JsonExclusive(context.paths.semanticScores, {
    schemaVersion: "companion-long-run-v3-semantic-review-v1",
    status: "PENDING_HUMAN_OR_CODEX_REVIEW",
    rubric: [
      ["emotional_understanding", 0.2],
      ["stress_and_clarity", 0.15],
      ["choice_analysis", 0.2],
      ["recommendation_and_delegation", 0.1],
      ["long_term_causality", 0.15],
      ["mutual_influence", 0.1],
      ["relationship_accumulation", 0.05],
      ["language_naturalness", 0.05],
    ],
    scores: [],
  });
}

async function buildArtifactIndex(context: RunContext) {
  return {
    runManifest: await artifactDigest(
      context.runDirectory,
      context.paths.runManifest,
    ),
    baselineDatabase: await artifactDigest(
      context.runDirectory,
      context.baselinePath,
    ),
    runDatabase: await artifactDigest(
      context.runDirectory,
      context.sharedDatabasePath,
    ),
    conversation: await artifactDigest(
      context.runDirectory,
      context.paths.conversation,
    ),
    modelIo: await artifactDigest(context.runDirectory, context.paths.modelIo),
    causalEvidence: await artifactDigest(
      context.runDirectory,
      context.paths.causalEvidence,
    ),
    turnEvidence: await artifactDigest(
      context.runDirectory,
      context.paths.turnEvidence,
    ),
    hardGates: await artifactDigest(
      context.runDirectory,
      context.paths.hardGates,
    ),
    semanticScores: await artifactDigest(
      context.runDirectory,
      context.paths.semanticScores,
    ),
  };
}

async function artifactDigest(
  runDirectory: string,
  path: string,
): Promise<LongRunV3ArtifactDigest> {
  const info = await stat(path);
  return {
    path: path.slice(resolve(runDirectory).length + 1).replaceAll("\\", "/"),
    bytes: info.size,
    sha256: await sha256LongRunV3File(path),
  };
}

async function inspectFrontendMigration(workspaceRoot: string): Promise<{
  passed: boolean;
  evidence: string[];
}> {
  const scheduleRail = resolve(
    workspaceRoot,
    "apps",
    "web",
    "src",
    "components",
    "ScheduleRail.tsx",
  );
  const chatPage = resolve(
    workspaceRoot,
    "apps",
    "web",
    "src",
    "pages",
    "ChatPage.tsx",
  );
  const timelinePage = resolve(
    workspaceRoot,
    "apps",
    "web",
    "src",
    "pages",
    "TimelinePage.tsx",
  );
  const appShell = resolve(
    workspaceRoot,
    "apps",
    "web",
    "src",
    "components",
    "AppShell.tsx",
  );
  const timelineLineage = resolve(
    workspaceRoot,
    "apps",
    "web",
    "src",
    "lib",
    "timelineLineage.ts",
  );
  const timelinePresentation = resolve(
    workspaceRoot,
    "apps",
    "web",
    "src",
    "lib",
    "timelinePresentation.ts",
  );
  const [
    railExists,
    appShellSource,
    chatSource,
    timelineSource,
    timelineLineageSource,
    timelinePresentationSource,
  ] = await Promise.all([
    pathExists(scheduleRail),
    readFile(appShell, "utf8"),
    readFile(chatPage, "utf8"),
    readFile(timelinePage, "utf8"),
    readFile(timelineLineage, "utf8"),
    readFile(timelinePresentation, "utf8"),
  ]);
  const result = evaluateLongRunV3FrontendMigrationSources({
    appShellSource,
    chatSource,
    timelineSource,
    timelineLineageSource,
    timelinePresentationSource,
    scheduleRailExists: railExists,
  });
  return {
    passed: result.passed,
    evidence: Object.entries(result.checks).map(
      ([check, passed]) => `${check}:${String(passed)}`,
    ),
  };
}

export interface LongRunV3FrontendMigrationSources {
  appShellSource: string;
  chatSource: string;
  timelineSource: string;
  timelineLineageSource: string;
  timelinePresentationSource: string;
  scheduleRailExists: boolean;
}

export function evaluateLongRunV3FrontendMigrationSources(
  sources: LongRunV3FrontendMigrationSources,
): { passed: boolean; checks: Record<string, boolean> } {
  const checks = {
    scheduleEntryAbsent:
      !/to\s*:\s*["']\/schedule["']/u.test(sources.appShellSource) &&
      !/label\s*:\s*["']日程["']/u.test(sources.appShellSource),
    currentActivityAbsent:
      !/ScheduleRail/u.test(sources.chatSource) &&
      !/当前活动/u.test(sources.chatSource),
    futureScheduleAbsent: !/未来安排/u.test(sources.chatSource),
    chatUsable: /send|发送|message/iu.test(sources.chatSource),
    timelineReadable: /共同经历/u.test(sources.timelineSource),
    retiredRailDeleted: !sources.scheduleRailExists,
    timelinePageScheduleSourceAbsent:
      !/\bscheduleItemId\b|\bScheduleItem\b/u.test(sources.timelineSource),
    timelineLineageScheduleNodeAbsent:
      !/\bscheduleItemId\b|\bScheduleItem\b/u.test(
        sources.timelineLineageSource,
      ),
    timelinePresentationImported:
      /from\s+["']\.\.\/lib\/timelinePresentation["']/u.test(
        sources.timelineSource,
      ),
    timelinePresentationUsed: /\btimelineEventTitle\s*\(\s*event\s*\)/u.test(
      sources.timelineSource,
    ),
    timelinePresentationHelperDefined:
      /export\s+function\s+timelineEventTitle\s*\(/u.test(
        sources.timelinePresentationSource,
      ),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function readFixtureConfig(): ServerConfig {
  const provider = process.env["LLM_PROVIDER"];
  const active = process.env["LLM_ACTIVE_PROFILE"];
  process.env["LLM_PROVIDER"] = "fixture";
  delete process.env["LLM_ACTIVE_PROFILE"];
  try {
    return readConfig();
  } finally {
    setOrDeleteEnvironment("LLM_PROVIDER", provider);
    setOrDeleteEnvironment("LLM_ACTIVE_PROFILE", active);
  }
}

function assertManifestCompatible(
  expected: LongRunV3RunManifest,
  actual: LongRunV3RunManifest,
): void {
  const normalize = (value: LongRunV3RunManifest) => ({
    ...value,
    createdAtUtc: "<ignored>",
  });
  if (
    canonicalLongRunV3Json(normalize(expected)) !==
    canonicalLongRunV3Json(normalize(actual))
  ) {
    throw new Error(
      "Existing v3 run is incompatible with current Git, scenario, baseline, or profile configuration.",
    );
  }
}

function setOrDeleteEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function suggestedRunId(profile: "fixture" | "deepseek"): string {
  return `${profile}-${new Date().toISOString().replace(/[^0-9TZ]/gu, "")}`;
}

async function writeJsonReplacing(path: string, value: unknown): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify(redactLongRunV3Artifact(value), null, 2)}\n`,
    "utf8",
  );
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// The runtime module imports this structural type without importing private
// preparation helpers. Keeping it exported also makes execution tests cheap.
export type LongRunV3ExecutionContext = RunContext;

// Re-export the evidence writers used by the runtime so it has a single,
// audited path for every externally inspectable file.
export const longRunV3EvidenceWriters = {
  appendTurn: appendLongRunV3TurnEvidence,
  appendModelIo: appendLongRunV3ModelIo,
  appendCausal: appendLongRunV3CausalEvidence,
  renderConversation: renderLongRunV3Conversation,
};

export const longRunV3ExecutionConstants = {
  agentId: LONG_RUN_V3_AGENT_ID,
  initialSessionId: LONG_RUN_V3_SESSION_ID,
  checkpointEveryTurns: CHECKPOINT_EVERY_TURNS,
};

export function expectedArtifactTurns(): LongRunV3ExpectedArtifactTurn[] {
  return [
    ...companionLongRunV3Manifest.sharedTurns,
    ...companionLongRunV3Manifest.branches.flatMap((branch) => branch.turns),
  ].map((turn) => ({
    turnId: turn.id,
    candidateOrdinal: turn.candidateNumber,
    branch: artifactBranchForScope(turn.scope),
  }));
}

export function resolveLongRunV3UserTextForDecision(
  turn: LongRunTurnSpec,
  decision: LongRunV3Decision | undefined,
): string {
  return resolveLongRunV3ConditionalUserText(turn.userText, decision);
}

export function artifactBranchForScope(
  scope: LongRunTurnSpec["scope"],
): LongRunV3Branch {
  if (scope === "branch_a") return "stable";
  if (scope === "branch_b") return "independent";
  return "shared";
}

export function branchIdForScope(
  scope: LongRunTurnSpec["scope"],
): LongRunV3BranchId | undefined {
  if (scope === "branch_a") return "A";
  if (scope === "branch_b") return "B";
  return undefined;
}
