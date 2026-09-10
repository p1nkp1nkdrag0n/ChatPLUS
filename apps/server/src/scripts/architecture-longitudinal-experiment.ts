import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import type { LlmCallMetric } from "@personasim/providers";
import type { ServerConfig } from "../config.js";
import type { LlmLogicalCallEvent } from "../services/llm-service.js";

import {
  ARCHITECTURE_BLIND_REVIEW_PROTOCOL,
  ARCHITECTURE_CASE_VERSION,
  ARCHITECTURE_PRIVATE_ORACLE,
  ARCHITECTURE_START_UTC,
  ARCHITECTURE_TRAJECTORIES,
  architectureStepUtc,
  architectureTrajectoryTurnId,
  observeArchitectureSurfaceChecks,
  type ArchitectureMessage,
  type ArchitectureTrajectory,
  type ArchitectureTrajectoryStep,
} from "./architecture-evaluation-cases.js";
import {
  ARCHITECTURE_RECENT_LIMIT,
  ARCHITECTURE_RETENTION,
  architectureConfig,
  createArchitectureRuntime,
  insertArchitectureSession,
  runArchitectureFullTurn,
  runArchitectureSimple,
  type ArchitectureSummaryState,
} from "./architecture-evaluation-runtime.js";
import { redactLongRunArtifact } from "./companion-long-run-v2-artifacts.js";

export const ARCHITECTURE_LONGITUDINAL_ARMS = [
  "full_native",
  "simple_recent",
  "simple_summary",
] as const;
export type ArchitectureLongitudinalArm =
  (typeof ARCHITECTURE_LONGITUDINAL_ARMS)[number];

export const ARCHITECTURE_LONGITUDINAL_PERSONAS = [
  "social-outward",
  "social-private",
] as const;

export interface ArchitectureLongitudinalBranch {
  branchId: string;
  personaId: string;
  arm: ArchitectureLongitudinalArm;
  trajectoryId: string;
  repetition: number;
}

export interface ArchitectureLongitudinalTurnInput {
  turnId: string;
  userText: string;
  nowUtc: string;
  sessionOrdinal: number;
  /** All prior messages generated in THIS branch; current user is separate. */
  history: readonly ArchitectureMessage[];
  /** Prior messages since this branch's most recent explicit new session. */
  sessionHistory: readonly ArchitectureMessage[];
  step: ArchitectureTrajectoryStep;
}

export interface ArchitectureLongitudinalTurnResult {
  text: string;
  events: readonly unknown[];
  metrics: readonly LlmCallMetric[];
  elapsedMs: number;
  error?: string;
  /** Runtime audit and/or rolling-summary evidence, never a private oracle. */
  evidence?: unknown;
}

/**
 * The adapter owns production API, native memory and provider calls. This
 * orchestration layer supplies only authored user turns and branch history.
 */
export interface ArchitectureLongitudinalDriver {
  beginSession(input: {
    sessionOrdinal: number;
    nowUtc: string;
  }): Promise<void>;
  turn(
    input: ArchitectureLongitudinalTurnInput,
  ): Promise<ArchitectureLongitudinalTurnResult>;
  checkpoint?(input: { turnId: string; nowUtc: string }): Promise<unknown>;
  close(): Promise<void>;
}

export interface ArchitectureLongitudinalRecord extends ArchitectureLongitudinalBranch {
  turnId: string;
  turn: number;
  simulatedDay: number;
  nowUtc: string;
  sessionOrdinal: number;
  checkpoint: boolean;
  status: "success" | "failed" | "skipped";
  userText: string;
  text: string;
  historySha256: string;
  sessionHistorySha256: string;
  elapsedMs: number;
  physicalMetricCount: number;
  providerInputTokens: number;
  providerOutputTokens: number;
  error?: string;
  surfaceObservations: ReturnType<typeof observeArchitectureSurfaceChecks>;
}

export interface ArchitectureLongitudinalOptions {
  directory: string;
  createDriver: (
    input: ArchitectureLongitudinalBranch & { directory: string },
  ) => Promise<ArchitectureLongitudinalDriver>;
  personas?: readonly string[];
  arms?: readonly ArchitectureLongitudinalArm[];
  trajectories?: readonly ArchitectureTrajectory[];
  repetitions?: number;
  randomizationSeed?: string;
  runIdentity?: unknown;
  authorInputs?: Readonly<Record<string, unknown>>;
  onBeforeTurn?: (
    input: ArchitectureLongitudinalBranch & { turnId: string },
  ) => void | Promise<void>;
  onAfterTurn?: (
    record: ArchitectureLongitudinalRecord,
  ) => void | Promise<void>;
}

function sha(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(
    path,
    `${JSON.stringify(redactLongRunArtifact(value), null, 2)}\n`,
  );
}

function distinctNonempty(values: readonly string[], label: string): void {
  if (
    !values.length ||
    new Set(values).size !== values.length ||
    values.some((value) => !/^[a-zA-Z0-9_-]+$/.test(value))
  ) {
    throw new Error(`Invalid or duplicate ${label}`);
  }
}

export function architectureLongitudinalBranches(
  input: {
    personas?: readonly string[];
    arms?: readonly ArchitectureLongitudinalArm[];
    trajectories?: readonly ArchitectureTrajectory[];
    repetitions?: number;
    randomizationSeed?: string;
  } = {},
): ArchitectureLongitudinalBranch[] {
  const personas = input.personas ?? ARCHITECTURE_LONGITUDINAL_PERSONAS;
  const arms = input.arms ?? ARCHITECTURE_LONGITUDINAL_ARMS;
  const trajectories = input.trajectories ?? ARCHITECTURE_TRAJECTORIES;
  const repetitions = input.repetitions ?? 1;
  distinctNonempty(personas, "personas");
  distinctNonempty(arms, "arms");
  distinctNonempty(
    trajectories.map((trajectory) => trajectory.id),
    "trajectories",
  );
  if (
    arms.some((arm) => !ARCHITECTURE_LONGITUDINAL_ARMS.includes(arm)) ||
    !Number.isInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > 10
  ) {
    throw new Error("Invalid longitudinal matrix");
  }
  const branches: ArchitectureLongitudinalBranch[] = [];
  for (const personaId of personas) {
    for (const trajectory of trajectories) {
      for (const arm of arms) {
        for (let repetition = 1; repetition <= repetitions; repetition += 1) {
          branches.push({
            branchId: `${personaId}_${trajectory.id}_${arm}_r${repetition}`,
            personaId,
            trajectoryId: trajectory.id,
            arm,
            repetition,
          });
        }
      }
    }
  }
  const seed = input.randomizationSeed ?? "architecture-longitudinal-order-v1";
  return branches.sort((left, right) =>
    sha([seed, left.branchId]).localeCompare(sha([seed, right.branchId])),
  );
}

/**
 * A longitudinal comparison has equal AUTHOR inputs, not equal generated
 * histories. Report it separately from fixed-prefix causal contrasts.
 * There is no judge invocation, production mutation or network access here.
 */
export async function runArchitectureLongitudinalExperiment(
  options: ArchitectureLongitudinalOptions,
): Promise<{
  directory: string;
  records: ArchitectureLongitudinalRecord[];
  plannedCandidates: number;
  completedCandidates: number;
  failedCandidates: number;
  skippedCandidates: number;
}> {
  const directory = resolve(options.directory);
  if (existsSync(directory))
    throw new Error("Longitudinal output directory must be new");
  const branches = architectureLongitudinalBranches(options);
  const trajectories = options.trajectories ?? ARCHITECTURE_TRAJECTORIES;
  const trajectoryMap = new Map(
    trajectories.map((trajectory) => [trajectory.id, trajectory]),
  );
  const plannedCandidates = branches.reduce(
    (total, branch) =>
      total + trajectoryMap.get(branch.trajectoryId)!.steps.length,
    0,
  );
  mkdirSync(directory, { recursive: true });
  writeJson(join(directory, "manifest.json"), {
    kind: "architecture-longitudinal-comparison-v1",
    scenarioVersion: ARCHITECTURE_CASE_VERSION,
    simulatedStart: ARCHITECTURE_START_UTC,
    plannedCandidates,
    branches,
    authoredTrajectories: trajectories,
    scenarioSha256: sha(trajectories),
    runIdentity: options.runIdentity,
    randomizationSeed:
      options.randomizationSeed ?? "architecture-longitudinal-order-v1",
    comparison: {
      design: "authored-user-closed-loop-with-isolated-generated-replies",
      equality:
        "Same author input, user trajectory, model configuration and fake times. Each arm retains only its own generated replies.",
      sessionPolicy:
        "Full uses native persisted records across new sessions. Both simple arms retain their own user-scoped global history tail of eight messages across session boundaries; simple_summary also retains a source-derived rolling summary. This favors a stronger recent-only baseline instead of emptying its context on session changes.",
      retention:
        "New sessions and the registered full-stack retention policy intentionally stress retrieval and consolidation. They are synthetic stress conditions, not deployment default truncation frequency. Immediate transcript shape is not identical between architectures.",
      fullStackRetention: ARCHITECTURE_RETENTION,
      simpleRecentMessageLimit: ARCHITECTURE_RECENT_LIMIT,
      failurePolicy:
        "Stop the affected branch after a failed generation or lifecycle action; record remaining turns as skipped. Never seed fabricated assistant output to continue.",
      quality:
        "Surface observations are not semantic scores. Blinded review remains a separate activity.",
    },
  });
  writeJson(
    join(directory, "private-oracle.json"),
    ARCHITECTURE_PRIVATE_ORACLE,
  );
  writeJson(
    join(directory, "review-protocol.json"),
    ARCHITECTURE_BLIND_REVIEW_PROTOCOL,
  );
  const records: ArchitectureLongitudinalRecord[] = [];
  const blindKey: Record<string, unknown> = {};
  const blindPackets: unknown[] = [];

  for (const branch of branches) {
    const branchDirectory = join(directory, branch.branchId);
    mkdirSync(branchDirectory);
    const trajectory = trajectoryMap.get(branch.trajectoryId)!;
    const history: ArchitectureMessage[] = [];
    let sessionHistory: ArchitectureMessage[] = [];
    let sessionOrdinal = 0;
    let stopReason: string | undefined;
    let driver: ArchitectureLongitudinalDriver | undefined;
    try {
      driver = await options.createDriver({
        ...branch,
        directory: branchDirectory,
      });
    } catch (error) {
      stopReason = error instanceof Error ? error.message : String(error);
    }
    try {
      for (const step of trajectory.steps) {
        const turnId = architectureTrajectoryTurnId(trajectory.id, step.turn);
        const nowUtc = architectureStepUtc(step);
        if (step.beginNewSession) {
          sessionOrdinal += 1;
          sessionHistory = [];
        }
        const base = {
          ...branch,
          turnId,
          turn: step.turn,
          simulatedDay: step.simulatedDay,
          nowUtc,
          sessionOrdinal,
          checkpoint: step.checkpoint,
          userText: step.userText,
          historySha256: sha(history),
          sessionHistorySha256: sha(sessionHistory),
        };
        if (stopReason !== undefined) {
          const skipped: ArchitectureLongitudinalRecord = {
            ...base,
            status: "skipped",
            text: "",
            elapsedMs: 0,
            physicalMetricCount: 0,
            providerInputTokens: 0,
            providerOutputTokens: 0,
            error: `branch_stopped: ${stopReason}`,
            surfaceObservations: [],
          };
          records.push(skipped);
          await options.onAfterTurn?.(skipped);
          continue;
        }
        await options.onBeforeTurn?.({ ...branch, turnId });
        let result: ArchitectureLongitudinalTurnResult | undefined;
        let checkpointEvidence: unknown;
        try {
          if (step.beginNewSession) {
            await driver!.beginSession({ sessionOrdinal, nowUtc });
          }
          result = await driver!.turn({
            turnId,
            userText: step.userText,
            nowUtc,
            sessionOrdinal,
            history: history.map((message) => ({ ...message })),
            sessionHistory: sessionHistory.map((message) => ({ ...message })),
            step: { ...step },
          });
          if (!result.error && !result.text.trim())
            result.error = "empty_assistant_response";
          if (!result.error && step.checkpoint) {
            checkpointEvidence = await driver!.checkpoint?.({ turnId, nowUtc });
          }
        } catch (error) {
          result = {
            ...(result ?? { text: "", events: [], metrics: [], elapsedMs: 0 }),
            error: error instanceof Error ? error.message : String(error),
          };
        }
        const privateExpectation = ARCHITECTURE_PRIVATE_ORACLE[turnId];
        const surfaceObservations =
          result.error || !privateExpectation
            ? []
            : observeArchitectureSurfaceChecks(result.text, privateExpectation);
        const record: ArchitectureLongitudinalRecord = {
          ...base,
          status: result.error ? "failed" : "success",
          text: result.text,
          elapsedMs: result.elapsedMs,
          physicalMetricCount: result.metrics.length,
          providerInputTokens: result.metrics.reduce(
            (sum, metric) =>
              sum +
              (metric.usageSource === "provider"
                ? (metric.inputTokens ?? 0)
                : 0),
            0,
          ),
          providerOutputTokens: result.metrics.reduce(
            (sum, metric) =>
              sum +
              (metric.usageSource === "provider"
                ? (metric.outputTokens ?? 0)
                : 0),
            0,
          ),
          ...(result.error ? { error: result.error } : {}),
          surfaceObservations,
        };
        records.push(record);
        writeJson(join(branchDirectory, `${turnId}.json`), {
          record,
          input: { history, sessionHistory, userText: step.userText },
          provider: result,
          checkpointEvidence,
        });
        if (step.checkpoint && !result.error) {
          const label = `C-${sha(["architecture-longitudinal-blind-v1", branch.branchId, turnId]).slice(0, 12)}`;
          blindKey[label] = { ...branch, turnId };
          blindPackets.push({
            label,
            authorInput: options.authorInputs?.[branch.personaId],
            authoredUserHistory: trajectory.steps
              .filter((item) => item.turn < step.turn)
              .map(({ userText, simulatedDay }) => ({
                userText,
                simulatedDay,
              })),
            ownPriorMessages: history.map((message) => ({ ...message })),
            currentUserText: step.userText,
            currentSimulatedDay: step.simulatedDay,
            response: result.text,
            reviewCriteria: privateExpectation,
            scores: null,
          });
        }
        if (result.error) {
          stopReason = result.error;
        } else {
          const newMessages: ArchitectureMessage[] = [
            { role: "user", content: step.userText },
            { role: "assistant", content: result.text },
          ];
          history.push(...newMessages);
          sessionHistory.push(...newMessages);
        }
        writeJson(join(directory, "progress.json"), {
          plannedCandidates,
          records,
        });
        await options.onAfterTurn?.(record);
      }
    } finally {
      await driver?.close();
      writeJson(join(branchDirectory, "conversation.json"), history);
    }
  }
  writeJson(join(directory, "results.json"), records);
  writeJson(
    join(directory, "blind-review.json"),
    blindPackets.sort((left, right) => sha(left).localeCompare(sha(right))),
  );
  writeJson(join(directory, "blind-key.json"), blindKey);
  const summary = {
    directory,
    records,
    plannedCandidates,
    completedCandidates: records.filter((record) => record.status === "success")
      .length,
    failedCandidates: records.filter((record) => record.status === "failed")
      .length,
    skippedCandidates: records.filter((record) => record.status === "skipped")
      .length,
  };
  writeJson(join(directory, "summary.json"), summary);
  return summary;
}

const LONGITUDINAL_SNAPSHOT_TABLES = [
  "messages",
  "memories",
  "memory_evidence",
  "domain_events",
  "conversation_checkpoints",
  "autobiography_snapshots",
  "autobiography_entries",
  "persona_adaptations",
  "memory_derived_validity",
  "memory_conflicts",
  "persona_observations",
  "event_cards",
  "retrieval_runs",
  "runtime_states",
] as const;

function snapshotArchitectureRuntime(
  runtime: Awaited<ReturnType<typeof createArchitectureRuntime>>,
) {
  const tables = new Set(
    (
      runtime.store.database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as { name: string }[]
    ).map((row) => row.name),
  );
  const rows: Record<string, unknown[]> = {};
  for (const table of LONGITUDINAL_SNAPSHOT_TABLES) {
    if (tables.has(table)) {
      // All names are compile-time literals, never a caller-provided SQL string.
      rows[table] = runtime.store.database
        .prepare(`SELECT * FROM "${table}"`)
        .all();
    }
  }
  return { nowUtc: runtime.clock.nowUtc(), rows, rowsSha256: sha(rows) };
}

export interface ArchitectureLongitudinalRuntimeOptions extends Omit<
  ArchitectureLongitudinalOptions,
  "createDriver"
> {
  config: ServerConfig;
  transport: typeof fetch;
  onLogicalCall?: (event: LlmLogicalCallEvent) => void;
}

/** Concrete adapter: only this layer invokes the existing product/provider APIs. */
export function runArchitectureLongitudinal(
  options: ArchitectureLongitudinalRuntimeOptions,
) {
  return runArchitectureLongitudinalExperiment({
    ...options,
    createDriver: async (branch) => {
      const config = architectureConfig(
        options.config,
        options.config.llm,
        branch.directory,
      );
      if (branch.arm === "full_native") {
        const runtime = await createArchitectureRuntime({
          directory: branch.directory,
          caseId: branch.personaId,
          config,
          transport: options.transport,
          ...(options.onLogicalCall
            ? { onLogicalCall: options.onLogicalCall }
            : {}),
        });
        let sessionId = "";
        return {
          beginSession: ({ sessionOrdinal, nowUtc }) => {
            runtime.clock.setUtc(nowUtc);
            sessionId = `architecture-long-session-${sessionOrdinal}`;
            insertArchitectureSession(
              runtime.store,
              runtime.spec.id,
              sessionId,
              nowUtc,
            );
            return Promise.resolve();
          },
          turn: async (input) => {
            runtime.clock.setUtc(input.nowUtc);
            const lifecycle =
              runtime.app.personasim.memoryLifecycle.maintainAgent(
                runtime.spec.id,
              );
            const result = await runArchitectureFullTurn(
              runtime,
              input.userText,
              `${branch.branchId}_${input.turnId}`,
              sessionId,
            );
            return {
              text: result.text,
              events: result.events,
              metrics: result.metrics,
              elapsedMs: result.elapsedMs,
              ...(result.error ? { error: result.error } : {}),
              evidence: {
                lifecycle,
                statusCode: result.statusCode,
                body: result.body,
                metadata: result.metadata,
              },
            };
          },
          checkpoint: () =>
            Promise.resolve(snapshotArchitectureRuntime(runtime)),
          close: runtime.close,
        } satisfies ArchitectureLongitudinalDriver;
      }
      let summaryState: ArchitectureSummaryState = {
        text: "",
        throughIndex: 0,
      };
      return {
        beginSession: async () => {
          /* Global history tail and summary intentionally survive session changes. */
        },
        turn: async (input) => {
          const result = await runArchitectureSimple({
            directory: join(branch.directory, input.turnId),
            caseId: branch.personaId,
            config,
            transport: options.transport,
            history: input.history,
            userText: input.userText,
            summaryMode: branch.arm === "simple_summary" ? "rolling" : "recent",
            summaryState,
            nowUtc: input.nowUtc,
            recentLimit: ARCHITECTURE_RECENT_LIMIT,
            ...(options.onLogicalCall
              ? { onLogicalCall: options.onLogicalCall }
              : {}),
          });
          summaryState = result.summaryState;
          return {
            text: result.text,
            events: result.events,
            metrics: result.metrics,
            elapsedMs: result.elapsedMs,
            ...(result.error ? { error: result.error } : {}),
            evidence: {
              summaryState,
              rawReply: result.rawReply,
              repaired: result.repaired,
              summaryError: result.summaryError,
            },
          };
        },
        checkpoint: () =>
          Promise.resolve({
            summaryState: { ...summaryState },
            recentMessageLimit: ARCHITECTURE_RECENT_LIMIT,
          }),
        close: async () => {
          /* runArchitectureSimple closes each turn database. */
        },
      } satisfies ArchitectureLongitudinalDriver;
    },
  });
}
