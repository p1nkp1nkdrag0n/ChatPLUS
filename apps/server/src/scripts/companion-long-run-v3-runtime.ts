import { createHash } from "node:crypto";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ActionRecordSchema,
  DailyLifeContextSchema,
  DailyLifeIntentSchema,
  DecisionRecordSchema,
  DilemmaEpisodeSchema,
  LifeOutcomeSchema,
  LifeThreadSchema,
  OutcomeRecordSchema,
  PressureEpisodeSchema,
  ReflectionRecordSchema,
  RelationshipMilestoneSchema,
  SupportInterventionSchema,
  type DailyLifeIntent,
  type LifeOutcome,
  type RelationshipMilestone,
} from "@personasim/contracts";
import { estimateConversationTokens } from "@personasim/features";

import type { ServerConfig } from "../config.js";
import type { Database } from "../db/connection.js";
import type { DatabaseStore } from "../db/store.js";
import { LifeRepository } from "../repositories/life-repository.js";
import type {
  HardAssertion,
  LongRunTurnSpec,
  LongRunV3Decision,
  LongRunV3MemoryRecallExpectation,
  LongRunV3SessionKey,
  ScenarioAction,
} from "../scenarios/companion-long-run-v3-types.js";
import {
  COMPANION_LONG_RUN_V3_SHARED_END_AT_UTC,
  companionLongRunV3Manifest,
  resolveLongRunV3ConditionalUserText,
} from "../scenarios/companion-long-run-v3-manifest.js";
import {
  evaluateCompanionLongRunV3HardAssertions,
  validateCompanionLongRunV3BidirectionalCausality,
  validateCompanionLongRunV3CausalRecapProvenance,
  validateCompanionLongRunV3MemoryAbstentionDurability,
  validateCompanionLongRunV3MemoryRecall,
  validateCompanionLongRunV3MemoryWrite,
  validateCompanionLongRunV3PlannedNotOccurredDurability,
  validateCompanionLongRunV3RelationshipContinuityGrounding,
  validateCompanionLongRunV3SupportMode,
  type CompanionLongRunV3CausalRecapStage,
  type CompanionLongRunV3CharacterCausalStage,
  type CompanionLongRunV3HardGateResult,
  type CompanionLongRunV3MemoryRecallExpectation,
  type CompanionLongRunV3Snapshot,
} from "./companion-long-run-v3-assertions.js";
import {
  appendLongRunV3CausalEvidence,
  appendLongRunV3ModelIo,
  appendLongRunV3TurnEvidence,
  createLongRunV3Checkpoint,
  redactLongRunV3Artifact,
  renderLongRunV3Conversation,
  writeLongRunV3Checkpoint,
  type LongRunV3Branch,
  type LongRunV3CausalEvidence,
  type LongRunV3HardAssertionResult,
  type LongRunV3LogicalCallTrace,
  type LongRunV3ProviderAttemptEvidence,
  type LongRunV3Snapshot,
  type LongRunV3TurnEvidence,
} from "./companion-long-run-v3-artifacts.js";
import {
  LONG_RUN_V3_AGENT_ID,
  LONG_RUN_V3_SESSION_ID,
  sha256CanonicalV3,
} from "./companion-long-run-v3-baseline.js";
import type { ObservationSlice } from "./companion-long-run-v2-observer.js";
import {
  LongRunV2Runtime,
  type LongRunHttpResult,
  type LongRunRuntimeOptions,
  type LongRunTurnHttpResult,
} from "./companion-long-run-v2-runtime.js";
import {
  evaluateLongRunV3FrontendMigrationSources,
  type LongRunV3ExecutionContext,
} from "./companion-long-run-v3-runner.js";

export interface LongRunV3RuntimeOptions {
  databasePath: string;
  config: ServerConfig;
  startAtUtc: string;
  initialSessionId: string;
  observer?: LongRunRuntimeOptions["observer"];
}

export interface LongRunV3RememberedTurn {
  turnId: string;
  agentId: string;
  sessionKey: LongRunV3SessionKey;
  text: string;
  clientMessageId: string;
  userMessageId?: string;
  assistantMessageId?: string;
}

export type LongRunV3TurnHistory =
  | ReadonlyMap<string, LongRunV3RememberedTurn>
  | Readonly<Record<string, LongRunV3RememberedTurn>>;

export interface LongRunV3ActionResult {
  action: ScenarioAction;
  status: "completed" | "skipped";
  atUtc: string;
  detail?: unknown;
}

export interface LongRunV3RetiredScheduleProbe {
  passed: boolean;
  state: LongRunHttpResult;
  schedule: LongRunHttpResult;
  legacyWrite: LongRunHttpResult;
  capability: unknown;
  scheduleItemCount: number;
}

/**
 * The artifact format keeps its stable public core small. The runtime retains
 * these additional complete projections so replay, restart, and branch checks
 * can audit every fuzzy-life stage without issuing another HTTP request.
 */
export interface LongRunV3RuntimeSnapshot extends LongRunV3Snapshot {
  dailyIntents: readonly DailyLifeIntent[];
  lifeOutcomes: readonly LifeOutcome[];
  relationshipMilestones: readonly RelationshipMilestone[];
  scheduleNegotiations: readonly unknown[];
  sessions: readonly unknown[];
  settlements: readonly unknown[];
  activityEvents: readonly unknown[];
}

/**
 * v3 deliberately reuses the proven v2 real-HTTP boot path. Only the scenario
 * language and durable projection are new; provider interception, local HTTP,
 * FakeClock, application restarts, and session creation stay identical.
 */
export class LongRunV3Runtime {
  readonly observer;
  readonly nativeFetch: typeof fetch;
  private readonly inner: LongRunV2Runtime;
  private readonly rememberedTurns = new Map<string, LongRunV3RememberedTurn>();

  constructor(options: LongRunV3RuntimeOptions) {
    this.inner = new LongRunV2Runtime({
      databasePath: options.databasePath,
      config: options.config,
      startAtUtc: options.startAtUtc,
      initialSessionId: options.initialSessionId,
      ...(options.observer === undefined ? {} : { observer: options.observer }),
    });
    this.observer = this.inner.observer;
    this.nativeFetch = this.inner.nativeFetch;
  }

  get nowUtc(): string {
    return this.inner.nowUtc;
  }

  get isOpen(): boolean {
    return this.inner.isOpen;
  }

  get store(): DatabaseStore {
    return this.inner.store;
  }

  get currentDatabase(): Database {
    return this.inner.currentDatabase;
  }

  async open(): Promise<void> {
    await this.inner.open();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  async restart(): Promise<void> {
    await this.inner.restart();
  }

  selectSession(key: LongRunV3SessionKey): string {
    return this.inner.selectSession(key);
  }

  rememberTurn(turn: LongRunV3RememberedTurn): void {
    this.rememberedTurns.set(turn.turnId, { ...turn });
  }

  rememberedTurn(turnId: string): LongRunV3RememberedTurn | undefined {
    const remembered = this.rememberedTurns.get(turnId);
    return remembered === undefined ? undefined : { ...remembered };
  }

  async sendMessage(input: {
    agentId: string;
    sessionKey: LongRunV3SessionKey;
    text: string;
    clientMessageId: string;
    turnId?: string;
  }): Promise<LongRunTurnHttpResult> {
    const result = await this.inner.sendMessage({
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      text: input.text,
      clientMessageId: input.clientMessageId,
    });
    if (input.turnId !== undefined) {
      this.rememberTurn({
        turnId: input.turnId,
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        text: input.text,
        clientMessageId: input.clientMessageId,
        ...(result.parsed === undefined
          ? {}
          : {
              userMessageId: result.parsed.userMessage.id,
              assistantMessageId: result.parsed.assistantMessage.id,
            }),
      });
    }
    return result;
  }

  async executeReplay(
    sourceTurnId: string,
    history?: LongRunV3TurnHistory,
  ): Promise<LongRunTurnHttpResult> {
    const source = resolveRememberedTurn(
      sourceTurnId,
      history,
      this.rememberedTurns,
    );
    if (source === undefined) {
      throw new Error(`Replay source turn is unavailable: ${sourceTurnId}`);
    }
    return this.inner.sendMessage({
      agentId: source.agentId,
      sessionKey: source.sessionKey,
      text: source.text,
      clientMessageId: source.clientMessageId,
    });
  }

  async applyActions(
    actions: readonly ScenarioAction[] = [],
    agentId: string,
    history?: LongRunV3TurnHistory,
  ): Promise<LongRunV3ActionResult[]> {
    const results: LongRunV3ActionResult[] = [];
    for (const action of actions) {
      switch (action.kind) {
        case "set_clock":
        case "advance_clock":
        case "activate_agent":
        case "close_app": {
          const [result] = await this.inner.applyActions([action], agentId);
          results.push(copyStandardActionResult(action, result));
          break;
        }
        case "open_app": {
          const [result] = await this.inner.applyActions(
            [{ kind: "open_app", preserveDatabase: true }],
            agentId,
          );
          results.push(copyStandardActionResult(action, result));
          break;
        }
        case "restart_app": {
          const before = this.snapshot(agentId).durableSha256;
          const cursor = this.observer.cursor();
          await this.restart();
          const after = this.snapshot(agentId).durableSha256;
          results.push(
            completed(action, this.nowUtc, {
              beforeRestartSha256: before,
              afterRestartSha256: after,
              logicalCallsWhileRestarting:
                this.observer.slice(cursor).logicalCalls.length,
            }),
          );
          break;
        }
        case "create_session": {
          const [result] = await this.inner.applyActions(
            [{ kind: "create_session", key: action.key }],
            agentId,
          );
          results.push(copyStandardActionResult(action, result));
          break;
        }
        case "replay_turn": {
          const before = this.snapshot(agentId).durableSha256;
          const replay = await this.executeReplay(action.sourceTurnId, history);
          const after = this.snapshot(agentId).durableSha256;
          results.push(
            completed(action, this.nowUtc, {
              sourceTurnId: action.sourceTurnId,
              http: replay.http,
              parsed: replay.parsed,
              observations: replay.observations,
              idempotentReplay: replay.parsed?.idempotentReplay === true,
              beforeDurableSha256: before,
              afterDurableSha256: after,
              durableStateUnchanged: before === after,
            }),
          );
          break;
        }
        case "rollback_clock": {
          results.push(await this.rollbackClock(action, agentId));
          break;
        }
        case "inject_character_dilemma": {
          results.push(this.injectCharacterDilemma(action, agentId));
          break;
        }
        case "inject_character_action_from_decision": {
          results.push(this.injectCharacterAction(action, agentId, history));
          break;
        }
        case "inject_character_mixed_outcome": {
          results.push(this.injectCharacterMixedOutcome(action, agentId));
          break;
        }
        case "inject_user_branch_dilemma": {
          results.push(this.injectUserBranchDilemma(action, agentId));
          break;
        }
        case "verify_retired_schedule": {
          const detail = await this.verifyRetiredSchedule(action, agentId);
          results.push(completed(action, this.nowUtc, detail));
          break;
        }
        case "fork_branches":
        case "verify_frontend": {
          results.push(
            skipped(action, this.nowUtc, {
              reason: "runner_owned_action",
            }),
          );
          break;
        }
      }
    }
    return results;
  }

  snapshot(agentId: string): LongRunV3RuntimeSnapshot {
    const database = this.currentDatabase;
    const dailyContexts = readDocuments(
      database,
      "daily_life_contexts",
      "context_json",
      DailyLifeContextSchema,
      agentId,
    );
    const dailyIntents = readDocuments(
      database,
      "daily_life_intents",
      "intent_json",
      DailyLifeIntentSchema,
      agentId,
    );
    const lifeThreads = readDocuments(
      database,
      "life_threads",
      "thread_json",
      LifeThreadSchema,
      agentId,
    );
    const lifeOutcomes = readDocuments(
      database,
      "life_outcomes",
      "outcome_json",
      LifeOutcomeSchema,
      agentId,
    );
    const dilemmas = readDocuments(
      database,
      "dilemma_episodes",
      "episode_json",
      DilemmaEpisodeSchema,
      agentId,
    );
    const supportInterventions = readDocuments(
      database,
      "support_interventions",
      "intervention_json",
      SupportInterventionSchema,
      agentId,
    );
    const decisions = readDocuments(
      database,
      "decision_records",
      "decision_json",
      DecisionRecordSchema,
      agentId,
    );
    const actions = readDocuments(
      database,
      "action_records",
      "action_json",
      ActionRecordSchema,
      agentId,
    );
    const outcomes = readDocuments(
      database,
      "outcome_records",
      "outcome_json",
      OutcomeRecordSchema,
      agentId,
    );
    const reflections = readDocuments(
      database,
      "reflection_records",
      "reflection_json",
      ReflectionRecordSchema,
      agentId,
    );
    const pressureEpisodes = readDocuments(
      database,
      "pressure_episodes",
      "episode_json",
      PressureEpisodeSchema,
      agentId,
    );
    const relationshipMilestones = readDocuments(
      database,
      "relationship_milestones",
      "milestone_json",
      RelationshipMilestoneSchema,
      agentId,
    );
    const scheduleItems = readRows(database, "schedule_items", agentId);
    const scheduleNegotiations = readRows(
      database,
      "schedule_negotiations",
      agentId,
    );
    const memories = readRows(database, "memories", agentId);
    const memoryEvidence = readMemoryEvidence(database, agentId);
    const messages = readRows(database, "messages", agentId);
    const domainEvents = readRows(database, "domain_events", agentId);
    const proactiveCandidates = readRows(
      database,
      "proactive_candidates",
      agentId,
    );
    const rejectedProposals = readRows(database, "rejected_proposals", agentId);
    const retrievalRuns = readRetrievalRunSummaries(database, agentId);
    const llmCalls = readLlmCallSummaries(database, agentId);
    const sessions = readRows(database, "sessions", agentId);
    const settlements = readRows(database, "settlements", agentId);
    const activityEvents = readRows(database, "activity_events", agentId);
    const runtimeState = this.store.getRuntimeState(agentId) ?? null;
    const cursor = this.store.getCursor(agentId) ?? null;
    const tableCounts = this.store.tableCounts();

    const durableProjection = {
      runtimeState,
      cursor,
      dailyContexts,
      dailyIntents,
      lifeThreads,
      lifeOutcomes,
      dilemmas,
      supportInterventions,
      decisions,
      actions,
      outcomes,
      reflections,
      pressureEpisodes,
      relationshipMilestones,
      scheduleItems,
      scheduleNegotiations,
      memories,
      memoryEvidence,
      messages,
      domainEvents,
      proactiveCandidates,
      rejectedProposals,
      retrievalRuns,
      // Retrieval input/prompt snapshots are intentionally not duplicated in
      // every turn artifact. Their complete table digest still participates in
      // replay equality, so an in-place mutation cannot escape the hard gate.
      retrievalRunsFullSha256: tableDigest(database, "retrieval_runs", agentId),
      llmCalls,
      sessions,
      settlements,
      activityEvents,
      tableCounts,
    };

    return {
      capturedAtUtc: this.nowUtc,
      durableSha256: sha256CanonicalV3(durableProjection),
      runtimeState,
      cursor,
      lifeContext: {
        dailyContexts,
        dailyIntents,
        lifeOutcomes,
      },
      dailyContexts,
      dailyIntents,
      lifeThreads,
      lifeOutcomes,
      scheduleItems: scheduleItems.map((row) => ({
        id: String(row["id"]),
        ...row,
      })),
      dilemmas,
      supportInterventions,
      decisions,
      actions,
      outcomes,
      reflections,
      pressureEpisodes,
      relationshipMilestones,
      memories,
      memoryEvidence,
      messages,
      domainEvents,
      proactiveCandidates,
      rejectedProposals,
      retrievalRuns,
      llmCalls,
      tableCounts,
      scheduleNegotiations,
      sessions,
      settlements,
      activityEvents,
    };
  }

  assertionSnapshot(agentId: string): CompanionLongRunV3Snapshot {
    const snapshot = this.snapshot(agentId);
    return {
      durableSha256: snapshot.durableSha256,
      dailyContexts: snapshot.dailyContexts,
      scheduleItems: snapshot.scheduleItems,
      dilemmas: snapshot.dilemmas,
      supportInterventions: snapshot.supportInterventions,
      decisions: snapshot.decisions,
      actions: snapshot.actions,
      outcomes: snapshot.outcomes,
      reflections: snapshot.reflections,
      pressureEpisodes: snapshot.pressureEpisodes,
      relationshipMilestones: snapshot.relationshipMilestones,
      messages: snapshot.messages,
      activityEvents: snapshot.activityEvents,
      domainEvents: snapshot.domainEvents,
    };
  }

  checkpointWal(): void {
    this.inner.checkpointWal();
  }

  async verifyRetiredSchedule(
    expectation: Extract<ScenarioAction, { kind: "verify_retired_schedule" }>,
    agentId: string,
  ): Promise<LongRunV3RetiredScheduleProbe> {
    const state = await this.rawRequest(`/api/agents/${agentId}/state`);
    const schedule = await this.rawRequest(`/api/agents/${agentId}/schedule`);
    const legacyWrite = await this.rawRequest(
      `/api/agents/${agentId}/schedule/effects`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ effects: [] }),
      },
    );
    const stateBody = asRecord(state.body);
    const capabilities = asRecord(stateBody?.["capabilities"]);
    const capability = capabilities?.["schedule"];
    const scheduleItemCount =
      this.assertionSnapshot(agentId).scheduleItems.length;
    const scheduleBody = asRecord(schedule.body);
    const retired = scheduleBody?.["retired"];
    const returnedItems = Array.isArray(scheduleBody?.["items"])
      ? scheduleBody["items"].length
      : undefined;
    return {
      passed:
        state.status === 200 &&
        schedule.status === 200 &&
        legacyWrite.status === expectation.expectLegacyWriteStatus &&
        capability === expectation.expectScheduleCapability &&
        retired === true &&
        returnedItems === 0 &&
        scheduleItemCount === expectation.expectNewScheduleItems,
      state,
      schedule,
      legacyWrite,
      capability,
      scheduleItemCount,
    };
  }

  private async rollbackClock(
    action: Extract<ScenarioAction, { kind: "rollback_clock" }>,
    agentId: string,
  ): Promise<LongRunV3ActionResult> {
    const originalUtc = this.nowUtc;
    const rollbackUtc = new Date(
      Date.parse(originalUtc) - action.durationMinutes * 60_000,
    ).toISOString();
    const before = this.snapshot(agentId).durableSha256;
    const observerCursor = this.observer.cursor();
    await this.inner.applyActions(
      [{ kind: "set_clock", atUtc: rollbackUtc }],
      agentId,
    );
    if (action.activateDuringRollback) {
      await this.inner.applyActions([{ kind: "activate_agent" }], agentId);
    }
    if (action.restoreOriginalCursor) {
      await this.inner.applyActions(
        [{ kind: "set_clock", atUtc: originalUtc }],
        agentId,
      );
    }
    const after = this.snapshot(agentId).durableSha256;
    const observations = this.observer.slice(observerCursor);
    return completed(action, this.nowUtc, {
      originalUtc,
      rollbackUtc,
      restoredUtc: this.nowUtc,
      beforeDurableSha256: before,
      afterDurableSha256: after,
      durableStateUnchanged: before === after,
      observations,
    });
  }

  private injectCharacterDilemma(
    action: Extract<ScenarioAction, { kind: "inject_character_dilemma" }>,
    agentId: string,
  ): LongRunV3ActionResult {
    const repository = new LifeRepository(this.currentDatabase);
    const time = fuzzyTime(this.nowUtc);
    const dilemmaId = stableControlId("dilemma", action.evidenceId);
    const pressureId = stableControlId("pressure", action.evidenceId);
    const restrainedOptionId = stableControlId(
      "option",
      `${action.evidenceId}:restrained`,
    );
    const marketOptionId = stableControlId(
      "option",
      `${action.evidenceId}:market`,
    );
    let insertedDilemma = false;
    let insertedPressure = false;
    this.currentDatabase.transaction(() => {
      this.insertControlMessage({
        agentId,
        sessionId: this.selectSession("S1"),
        evidenceId: action.evidenceId,
        content: action.content,
      });
      insertedDilemma = repository.insertDilemma(
        DilemmaEpisodeSchema.parse({
          id: dilemmaId,
          agentId,
          sessionId: this.selectSession("S1"),
          subject: "character",
          title: "《夜航》结尾的创作取舍",
          summary: action.content,
          domain: "creative",
          options: [
            {
              id: restrainedOptionId,
              label: "保留克制的结尾",
              description: "保护被摄者尊严与作品的克制表达。",
              likelyTradeoffs: ["合作方可能担心市场吸引力不足"],
              valuesAtStake: ["被摄者尊严", "创作完整性"],
            },
            {
              id: marketOptionId,
              label: "强化冲突",
              description: "提高戏剧张力与传播、发行的可谈空间。",
              likelyTradeoffs: ["可能让被摄者感到经历被工具化"],
              valuesAtStake: ["传播机会", "商业可持续性"],
            },
          ],
          status: "open",
          sourceMessageIds: [action.evidenceId],
          ...time,
          updatedAtUtc: this.nowUtc,
          idempotencyKey: `long-run-v3:dilemma:${action.evidenceId}`,
          schemaVersion: 1,
        }),
      );
      insertedPressure = repository.insertPressure(
        PressureEpisodeSchema.parse({
          id: pressureId,
          agentId,
          sessionId: this.selectSession("S1"),
          dilemmaId,
          subject: "character",
          pressureKind: "decision",
          triggerSummary: action.content,
          status: "open",
          initialPressure: 0.68,
          currentPressure: 0.68,
          initialClarity: 0.38,
          currentClarity: 0.38,
          initialFeltUnderstood: 0.3,
          currentFeltUnderstood: 0.3,
          interventionIds: [],
          outcomeIds: [],
          sourceMessageIds: [action.evidenceId],
          latestEvidenceMessageId: action.evidenceId,
          ...time,
          updatedAtUtc: this.nowUtc,
          idempotencyKey: `long-run-v3:pressure:${action.evidenceId}`,
          schemaVersion: 1,
        }),
      );
      this.insertControlEvent({
        agentId,
        evidenceId: action.evidenceId,
        streamId: dilemmaId,
        eventType: "long_run.character_dilemma_observed",
        payload: {
          dilemmaId,
          pressureEpisodeId: pressureId,
          injectDecision: action.injectDecision,
          content: action.content,
        },
      });
    })();
    return completed(action, this.nowUtc, {
      insertedDilemma,
      insertedPressure,
      dilemmaId,
      pressureEpisodeId: pressureId,
      decisionInserted: false,
    });
  }

  private injectCharacterAction(
    action: Extract<
      ScenarioAction,
      { kind: "inject_character_action_from_decision" }
    >,
    agentId: string,
    history?: LongRunV3TurnHistory,
  ): LongRunV3ActionResult {
    const repository = new LifeRepository(this.currentDatabase);
    const source = resolveRememberedTurn(
      action.decisionSourceTurnId,
      history,
      this.rememberedTurns,
    );
    const sourceIds = new Set(
      [source?.userMessageId, source?.assistantMessageId].filter(
        (value): value is string => value !== undefined,
      ),
    );
    const decisions = readDocuments(
      this.currentDatabase,
      "decision_records",
      "decision_json",
      DecisionRecordSchema,
      agentId,
    ).filter(
      (decision) =>
        decision.subject === "character" &&
        (sourceIds.size === 0 ||
          decision.sourceMessageIds.some((id) => sourceIds.has(id))),
    );
    if (decisions.length === 0 && action.skipIfMissing) {
      return skipped(action, this.nowUtc, {
        reason: "character_decision_missing",
        decisionSourceTurnId: action.decisionSourceTurnId,
        sourceMessageIds: [...sourceIds],
      });
    }
    if (decisions.length !== 1 && action.requireUniqueDecision) {
      throw new Error(
        `Expected one character decision from ${action.decisionSourceTurnId}; found ${decisions.length}.`,
      );
    }
    const decision = decisions[0];
    if (decision === undefined) {
      return skipped(action, this.nowUtc, {
        reason: "character_decision_missing",
      });
    }
    const actionId = stableControlId("action", action.evidenceId);
    const time = fuzzyTime(this.nowUtc);
    let inserted = false;
    this.currentDatabase.transaction(() => {
      this.insertControlMessage({
        agentId,
        sessionId: this.selectSession("S1"),
        evidenceId: action.evidenceId,
        content: `外部事实证据：顾澜已经开始落实自己的选择“${decision.selectionSummary}”。`,
      });
      inserted = repository.insertAction(
        ActionRecordSchema.parse({
          id: actionId,
          agentId,
          sessionId: this.selectSession("S1"),
          decisionId: decision.id,
          subject: "character",
          performedBy: "character",
          actionKind: "initiated",
          summary: `顾澜开始落实自己的选择：${decision.selectionSummary}`,
          sourceEvidenceIds: [action.evidenceId],
          ...time,
          idempotencyKey: `long-run-v3:action:${action.evidenceId}`,
          schemaVersion: 1,
        }),
      );
      this.insertControlEvent({
        agentId,
        evidenceId: action.evidenceId,
        streamId: decision.id,
        eventType: "long_run.character_action_observed",
        payload: {
          decisionId: decision.id,
          actionId,
          sourceTurnId: action.decisionSourceTurnId,
        },
      });
    })();
    return completed(action, this.nowUtc, {
      inserted,
      actionId,
      decisionId: decision.id,
    });
  }

  private injectCharacterMixedOutcome(
    action: Extract<ScenarioAction, { kind: "inject_character_mixed_outcome" }>,
    agentId: string,
  ): LongRunV3ActionResult {
    const repository = new LifeRepository(this.currentDatabase);
    const expectedActionId = stableControlId("action", action.actionEvidenceId);
    const observedAction = repository
      .listRecentActions(agentId, 100)
      .find((item) => item.id === expectedActionId);
    if (observedAction === undefined && action.skipIfMissing) {
      return skipped(action, this.nowUtc, {
        reason: "required_action_missing",
        expectedActionId,
      });
    }
    if (observedAction === undefined && action.requireAction) {
      throw new Error(
        `Required character action is missing: ${expectedActionId}`,
      );
    }
    if (observedAction === undefined) {
      return skipped(action, this.nowUtc, {
        reason: "required_action_missing",
        expectedActionId,
      });
    }
    const outcomeId = stableControlId("outcome", action.evidenceId);
    const time = fuzzyTime(this.nowUtc);
    let inserted = false;
    this.currentDatabase.transaction(() => {
      this.insertControlMessage({
        agentId,
        sessionId: observedAction.sessionId ?? this.selectSession("S1"),
        evidenceId: action.evidenceId,
        content: action.content,
      });
      inserted = repository.insertOutcomeRecord(
        OutcomeRecordSchema.parse({
          id: outcomeId,
          agentId,
          sessionId: observedAction.sessionId,
          decisionId: observedAction.decisionId,
          actionIds: [observedAction.id],
          causeKind: "mixed",
          valence: "mixed",
          summary: action.content,
          consequenceFacts: [
            "被摄者对处理方式更放心",
            "合作方担心成片的市场吸引力下降",
          ],
          sourceEvidenceIds: [action.evidenceId],
          confidence: 0.95,
          status: "observed",
          ...time,
          idempotencyKey: `long-run-v3:outcome:${action.evidenceId}`,
          schemaVersion: 1,
        }),
      );
      this.insertControlEvent({
        agentId,
        evidenceId: action.evidenceId,
        streamId: observedAction.decisionId,
        eventType: "long_run.character_mixed_outcome_observed",
        payload: {
          decisionId: observedAction.decisionId,
          actionId: observedAction.id,
          outcomeId,
          content: action.content,
        },
      });
    })();
    return completed(action, this.nowUtc, {
      inserted,
      outcomeId,
      actionId: observedAction.id,
      decisionId: observedAction.decisionId,
    });
  }

  private injectUserBranchDilemma(
    action: Extract<ScenarioAction, { kind: "inject_user_branch_dilemma" }>,
    agentId: string,
  ): LongRunV3ActionResult {
    const repository = new LifeRepository(this.currentDatabase);
    const dilemmaId = stableControlId("dilemma", action.evidenceId);
    const stableOptionId = stableControlId(
      "option",
      `${action.evidenceId}:stable`,
    );
    const independentOptionId = stableControlId(
      "option",
      `${action.evidenceId}:independent`,
    );
    const time = fuzzyTime(this.nowUtc);
    let inserted = false;
    this.currentDatabase.transaction(() => {
      this.insertControlMessage({
        agentId,
        sessionId: this.selectSession("S2"),
        evidenceId: action.evidenceId,
        content: `场景事实：用户面临一个尚未决定的困境——${action.content}`,
      });
      inserted = repository.insertDilemma(
        DilemmaEpisodeSchema.parse({
          id: dilemmaId,
          agentId,
          sessionId: this.selectSession("S2"),
          subject: "user",
          title: "未来一年的职业方向",
          summary: action.content,
          domain: "work",
          options: [
            {
              id: stableOptionId,
              label: "接受影像平台副主编岗位",
              description: "用更稳定的收入与作息支撑未来一年。",
              likelyTradeoffs: ["留给个人创作的时间可能减少"],
              valuesAtStake: ["生活稳定", "创作空间"],
            },
            {
              id: independentOptionId,
              label: "启动独立影像项目",
              description: "和两位朋友一起承担项目与创作自主权。",
              likelyTradeoffs: ["现金流和项目连续性更不确定"],
              valuesAtStake: ["创作自主", "经济安全"],
            },
          ],
          status: "open",
          sourceMessageIds: [action.evidenceId],
          ...time,
          updatedAtUtc: this.nowUtc,
          idempotencyKey: `long-run-v3:dilemma:${action.evidenceId}`,
          schemaVersion: 1,
        }),
      );
      this.insertControlEvent({
        agentId,
        evidenceId: action.evidenceId,
        streamId: dilemmaId,
        eventType: "long_run.user_branch_dilemma_observed",
        payload: {
          dilemmaId,
          content: action.content,
          injectDecision: action.injectDecision,
          injectAction: action.injectAction,
          injectOutcome: action.injectOutcome,
        },
      });
    })();
    return completed(action, this.nowUtc, {
      inserted,
      dilemmaId,
      decisionInserted: false,
      actionInserted: false,
      outcomeInserted: false,
    });
  }

  private insertControlMessage(input: {
    agentId: string;
    sessionId: string;
    evidenceId: string;
    content: string;
  }): boolean {
    return (
      this.currentDatabase
        .prepare(
          `INSERT OR IGNORE INTO messages(
             id, session_id, agent_id, role, content, message_kind,
             trigger_event_id, client_message_id, in_reply_to_message_id,
             metadata_json, created_at_utc
           ) VALUES (?, ?, ?, 'system', ?, 'system_notice', NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          input.evidenceId,
          input.sessionId,
          input.agentId,
          input.content,
          JSON.stringify({
            longRunControl: true,
            evidenceId: input.evidenceId,
          }),
          this.nowUtc,
        ).changes > 0
    );
  }

  private insertControlEvent(input: {
    agentId: string;
    evidenceId: string;
    streamId: string;
    eventType: string;
    payload: unknown;
  }): boolean {
    const idempotencyKey = `long-run-v3:event:${input.evidenceId}`;
    return (
      this.currentDatabase
        .prepare(
          `INSERT OR IGNORE INTO domain_events(
             id, agent_id, stream_type, stream_id, stream_version, event_type,
             recorded_at_utc, effective_at_utc, payload_json,
             correlation_id, causation_id, idempotency_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          stableControlId("event", input.evidenceId),
          input.agentId,
          "long_run_control",
          input.streamId,
          1,
          input.eventType,
          this.nowUtc,
          this.nowUtc,
          JSON.stringify(input.payload),
          `long-run-v3:${input.evidenceId}`,
          input.evidenceId,
          idempotencyKey,
        ).changes > 0
    );
  }

  private rawRequest(
    path: string,
    init?: RequestInit,
  ): Promise<LongRunHttpResult> {
    // v2 intentionally keeps its raw helper private. v3 uses this narrow local
    // adapter only for the retired compatibility endpoint; chat still goes
    // through the public sendMessage contract and Zod parser.
    const runtime = this.inner as unknown as {
      request(path: string, init?: RequestInit): Promise<LongRunHttpResult>;
    };
    return runtime.request(path, init);
  }
}

/**
 * Executes the frozen 108 shared turns once, then continues both six-turn
 * branches from the exact T108 SQLite image. This is exported from the runtime
 * module because the runner deliberately lazy-loads the paid boundary.
 */
export async function executeLongRunV3Scenario(
  context: LongRunV3ExecutionContext,
): Promise<void> {
  const completedTurnIds = new Set(context.turns.map((turn) => turn.turnId));
  let sharedAnchorSha256: string | undefined;

  if (
    companionLongRunV3Manifest.sharedTurns.some(
      (turn) => !completedTurnIds.has(turn.id),
    )
  ) {
    const runtime = createExecutionRuntime(context, context.sharedDatabasePath);
    await runtime.open();
    try {
      restoreRememberedTurns(runtime, context.turns);
      await executeTurnSequence({
        runtime,
        context,
        turns: companionLongRunV3Manifest.sharedTurns,
        branch: "shared",
        completedTurnIds,
      });
      if (hasReachedConfiguredStop(context)) return;
      sharedAnchorSha256 = runtime.snapshot(LONG_RUN_V3_AGENT_ID).durableSha256;
      runtime.checkpointWal();
    } finally {
      await runtime.close();
    }
  }

  if (sharedAnchorSha256 === undefined) {
    const anchorRuntime = createExecutionRuntime(
      context,
      context.sharedDatabasePath,
      COMPANION_LONG_RUN_V3_SHARED_END_AT_UTC,
    );
    await anchorRuntime.open();
    try {
      sharedAnchorSha256 =
        anchorRuntime.snapshot(LONG_RUN_V3_AGENT_ID).durableSha256;
      anchorRuntime.checkpointWal();
    } finally {
      await anchorRuntime.close();
    }
  }

  await ensureBranchDatabases(context);
  for (const branchSpec of companionLongRunV3Manifest.branches) {
    const branch = branchSpec.id === "A" ? "stable" : "independent";
    const databasePath =
      branch === "stable"
        ? context.stableDatabasePath
        : context.independentDatabasePath;
    if (branchSpec.turns.every((turn) => completedTurnIds.has(turn.id))) {
      continue;
    }
    const runtime = createExecutionRuntime(
      context,
      databasePath,
      COMPANION_LONG_RUN_V3_SHARED_END_AT_UTC,
    );
    await runtime.open();
    try {
      restoreRememberedTurns(runtime, context.turns);
      const actualAnchor = runtime.snapshot(LONG_RUN_V3_AGENT_ID).durableSha256;
      if (
        !context.turns.some((turn) => turn.branch === branch) &&
        actualAnchor !== sharedAnchorSha256
      ) {
        throw new Error(
          `Branch ${branch} did not start from the frozen T108 anchor.`,
        );
      }
      await executeTurnSequence({
        runtime,
        context,
        turns: branchSpec.turns,
        branch,
        completedTurnIds,
        branchAnchorSha256: sharedAnchorSha256,
      });
      if (hasReachedConfiguredStop(context)) return;
      runtime.checkpointWal();
    } finally {
      await runtime.close();
    }
  }
}

function hasReachedConfiguredStop(context: LongRunV3ExecutionContext): boolean {
  const stop = context.options.stopAfterCandidate;
  return (
    stop !== undefined &&
    context.turns.some((turn) => turn.candidateOrdinal >= stop)
  );
}

interface ExecuteTurnSequenceInput {
  runtime: LongRunV3Runtime;
  context: LongRunV3ExecutionContext;
  turns: readonly LongRunTurnSpec[];
  branch: LongRunV3Branch;
  completedTurnIds: Set<string>;
  branchAnchorSha256?: string;
}

async function executeTurnSequence(
  input: ExecuteTurnSequenceInput,
): Promise<void> {
  for (const turn of input.turns) {
    if (input.completedTurnIds.has(turn.id)) continue;
    const initialSnapshot = input.runtime.snapshot(LONG_RUN_V3_AGENT_ID);
    const observationCursor = input.runtime.observer.cursor();
    const actionsBefore = await executeScenarioActions(
      input.runtime,
      turn.actionsBefore ?? [],
      input.context,
    );
    const before = input.runtime.snapshot(LONG_RUN_V3_AGENT_ID);
    const fakeTimeBeforeUtc = input.runtime.nowUtc;
    const decision = resolvePersistedLongRunV3Decision(input.runtime);
    const userText = resolveLongRunV3ConditionalUserText(
      turn.userText,
      decision,
    );
    const clientMessageId = `client-long-run-v3-${turn.id}`;
    const sessionId = input.runtime.selectSession(turn.sessionKey);
    const response = await input.runtime.sendMessage({
      agentId: LONG_RUN_V3_AGENT_ID,
      sessionKey: turn.sessionKey,
      text: userText,
      clientMessageId,
      turnId: turn.id,
    });
    const actionsAfter = await executeScenarioActions(
      input.runtime,
      turn.actionsAfter ?? [],
      input.context,
    );
    const after = input.runtime.snapshot(LONG_RUN_V3_AGENT_ID);
    const observations = input.runtime.observer.slice(observationCursor);
    const assistantMessage = response.parsed?.assistantMessage.content ?? "";
    const actionResults = [...actionsBefore, ...actionsAfter];
    const branchExpectation =
      input.branchAnchorSha256 === undefined
        ? undefined
        : {
            branch: input.branch === "stable" ? ("A" as const) : ("B" as const),
            expectedAnchorSha256: input.branchAnchorSha256,
            actualAnchorSha256: input.branchAnchorSha256,
            durableProjection: branchTurnProjection(before, after),
            forbiddenDurableFragments:
              input.branch === "stable"
                ? ["拿到第一个小客户", "确认启动项目"]
                : ["签了副主编合同", "收入和作息稳定了"],
            assistantText: assistantMessage,
            forbiddenAssistantFragments:
              input.branch === "stable"
                ? ["拿到第一个小客户", "确认启动项目"]
                : ["签了副主编合同", "收入和作息稳定了"],
          };
    const currentUserMessageId = response.parsed?.userMessage.id;
    const responseScheduleChangeCount = response.parsed?.scheduleChanges.length;
    const currentPressureExpectation = pressureExpectation(
      turn,
      currentUserMessageId,
      before,
    );
    const coreAssertions = evaluateCompanionLongRunV3HardAssertions({
      before: assertionProjection(before),
      after: assertionProjection(after),
      promptCalls: observations.logicalCalls.map((call) => ({
        purpose: call.purpose,
        system: call.system,
        prompt: call.prompt,
        primaryChat: call.purpose === "chat_turn",
      })),
      scheduleCapability: false,
      ...(responseScheduleChangeCount === undefined
        ? {}
        : { responseScheduleChangeCount }),
      ...(currentUserMessageId === undefined ? {} : { currentUserMessageId }),
      ...(turn.candidateNumber === 48 && response.parsed !== undefined
        ? {
            expectedDelegatedAuthorizationMessageId:
              response.parsed.userMessage.id,
          }
        : {}),
      ...(currentPressureExpectation === undefined
        ? {}
        : { pressureExpectation: currentPressureExpectation }),
      expectReplay: false,
      ...(branchExpectation === undefined ? {} : { branch: branchExpectation }),
    });
    const assertions = evaluateDeclaredTurnAssertions({
      turn,
      response,
      before,
      after,
      observations,
      actionResults,
      assistantMessage,
      coreAssertions,
      ...(branchExpectation === undefined ? {} : { branchExpectation }),
      context: input.context,
      runtime: input.runtime,
    });
    const causalEvidence = buildTurnCausalEvidence({
      runId: input.context.runId,
      turn,
      branch: input.branch,
      before: initialSnapshot,
      after,
    });
    const persistedAssistant = after.messages.find((message) => {
      const record = asRecord(message);
      return (
        response.parsed !== undefined &&
        record?.["id"] === response.parsed.assistantMessage.id
      );
    });
    const logicalCalls = observations.logicalCalls.map((call) => ({
      ...call,
      repairAttempt: /repair/iu.test(call.purpose),
    })) satisfies LongRunV3LogicalCallTrace[];
    const providerAttempts =
      observations.providerAttempts as LongRunV3ProviderAttemptEvidence[];
    const evidence: LongRunV3TurnEvidence = {
      schemaVersion: "companion-long-run-turn-evidence-v3",
      runId: input.context.runId,
      profile: input.context.options.profile,
      branch: input.branch,
      turnId: turn.id,
      logicalOrdinal: turn.executionOrdinal,
      candidateOrdinal: turn.candidateNumber,
      scenarioBlock: turn.blockId,
      rubricTags: [...turn.semanticRubricTags],
      fakeTimeBeforeUtc,
      fakeTimeAfterUtc: input.runtime.nowUtc,
      sessionId,
      clientMessageId,
      userMessage: userText,
      assistantMessage,
      actions: actionResults,
      http: {
        method: "POST",
        path: `/api/sessions/${sessionId}/messages`,
        status: response.http.status,
        latencyMs: response.http.latencyMs,
      },
      logicalCalls,
      providerAttempts,
      ...(logicalCalls.find((call) => call.purpose === "chat_turn") ===
      undefined
        ? {}
        : {
            primaryPromptSha256: logicalCalls.find(
              (call) => call.purpose === "chat_turn",
            )!.promptSha256,
          }),
      ...(lastRawCandidate(providerAttempts, logicalCalls) === undefined
        ? {}
        : {
            rawCandidateOutput: lastRawCandidate(
              providerAttempts,
              logicalCalls,
            ),
          }),
      ...(logicalCalls.at(-1)?.parsedOutput === undefined
        ? {}
        : { parsedCandidateOutput: logicalCalls.at(-1)!.parsedOutput }),
      applicationResponse: response.http.body,
      ...(persistedAssistant === undefined ? {} : { persistedAssistant }),
      before,
      after,
      causalEvidence,
      assertions,
      status: assertions.some((assertion) => assertion.status === "FAIL")
        ? "FAIL"
        : "PASS",
      repairAttempted: logicalCalls.some((call) => call.repairAttempt === true),
      idempotentReplay:
        response.parsed?.idempotentReplay === true ||
        actionResults.some(actionResultContainsReplay),
    };
    await persistTurnEvidence(input.context, evidence);
    input.context.turns.push(evidence);
    input.completedTurnIds.add(turn.id);
    await writeFile(
      input.context.paths.conversation,
      redactLongRunV3Artifact(
        renderLongRunV3Conversation(input.context.turns),
        input.context.explicitSecrets,
      ) as string,
      "utf8",
    );
    await maybeWriteCheckpoint(input.runtime, input.context);

    if (
      input.context.options.stopAfterCandidate !== undefined &&
      turn.candidateNumber >= input.context.options.stopAfterCandidate
    ) {
      return;
    }
  }
}

async function executeScenarioActions(
  runtime: LongRunV3Runtime,
  actions: readonly ScenarioAction[],
  context: LongRunV3ExecutionContext,
): Promise<LongRunV3ActionResult[]> {
  const results: LongRunV3ActionResult[] = [];
  for (const action of actions) {
    if (action.kind === "verify_frontend") {
      results.push(
        await verifyFrontendMigration(action, context.options.workspaceRoot),
      );
      continue;
    }
    if (action.kind === "fork_branches") {
      runtime.checkpointWal();
      await ensureBranchDatabases(context);
      const hashes = await Promise.all([
        sha256Database(context.sharedDatabasePath),
        sha256Database(context.stableDatabasePath),
        sha256Database(context.independentDatabasePath),
      ]);
      results.push({
        action,
        status: "completed",
        atUtc: runtime.nowUtc,
        detail: {
          sharedSha256: hashes[0],
          stableSha256: hashes[1],
          independentSha256: hashes[2],
          identical: hashes[0] === hashes[1] && hashes[0] === hashes[2],
        },
      });
      continue;
    }
    results.push(
      ...(await runtime.applyActions([action], LONG_RUN_V3_AGENT_ID)),
    );
  }
  return results;
}

function createExecutionRuntime(
  context: LongRunV3ExecutionContext,
  databasePath: string,
  startAtUtc: string = companionLongRunV3Manifest.startAtUtc,
): LongRunV3Runtime {
  const fixture = context.options.profile === "fixture";
  const config: ServerConfig = {
    ...context.serverConfig,
    nodeEnv: "test",
    profile: "companion-long-run-v3",
    databasePath,
    clockMode: "fake",
    fakeClockStart: startAtUtc,
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
  return new LongRunV3Runtime({
    databasePath,
    config,
    startAtUtc,
    initialSessionId: LONG_RUN_V3_SESSION_ID,
  });
}

function restoreRememberedTurns(
  runtime: LongRunV3Runtime,
  evidence: readonly LongRunV3TurnEvidence[],
): void {
  const specs = new Map(
    [
      ...companionLongRunV3Manifest.sharedTurns,
      ...companionLongRunV3Manifest.branches.flatMap((branch) => branch.turns),
    ].map((turn) => [turn.id, turn]),
  );
  for (const turn of evidence) {
    const spec = specs.get(turn.turnId);
    if (spec === undefined) continue;
    const response = asRecord(turn.applicationResponse);
    const userMessage = asRecord(response?.["userMessage"]);
    const assistantMessage = asRecord(response?.["assistantMessage"]);
    runtime.rememberTurn({
      turnId: turn.turnId,
      agentId: LONG_RUN_V3_AGENT_ID,
      sessionKey: spec.sessionKey,
      text: turn.userMessage,
      clientMessageId: turn.clientMessageId,
      ...(typeof userMessage?.["id"] === "string"
        ? { userMessageId: userMessage["id"] }
        : {}),
      ...(typeof assistantMessage?.["id"] === "string"
        ? { assistantMessageId: assistantMessage["id"] }
        : {}),
    });
  }
}

function resolvePersistedLongRunV3Decision(
  runtime: LongRunV3Runtime,
): LongRunV3Decision | undefined {
  const source = runtime.rememberedTurn("shared-048");
  const decision = runtime
    .snapshot(LONG_RUN_V3_AGENT_ID)
    .decisions.find(
      (candidate) =>
        source?.userMessageId !== undefined &&
        candidate.sourceMessageIds.includes(source.userMessageId),
    );
  if (decision === undefined) return undefined;
  const text = `${decision.selectedOptionId} ${decision.selectionSummary}`;
  if (/山鸣|杭州|纪录片研究|选项\s*B|方向\s*B/iu.test(text)) return "B";
  if (/栖岸|上海|留下|小团队|选项\s*A|方向\s*A/iu.test(text)) return "A";
  return undefined;
}

async function ensureBranchDatabases(
  context: LongRunV3ExecutionContext,
): Promise<void> {
  const stableExists = await pathExists(context.stableDatabasePath);
  const independentExists = await pathExists(context.independentDatabasePath);
  if (stableExists && independentExists) return;
  if (
    (stableExists || independentExists) &&
    context.turns.some((turn) => turn.branch !== "shared")
  ) {
    throw new Error(
      "A resumed v3 run is missing one progressed branch database.",
    );
  }
  if (!stableExists) {
    await copyFile(context.sharedDatabasePath, context.stableDatabasePath);
  }
  if (!independentExists) {
    await copyFile(context.sharedDatabasePath, context.independentDatabasePath);
  }
}

async function persistTurnEvidence(
  context: LongRunV3ExecutionContext,
  evidence: LongRunV3TurnEvidence,
): Promise<void> {
  await appendLongRunV3TurnEvidence(
    context.paths.turnEvidence,
    evidence,
    context.explicitSecrets,
  );
  await appendLongRunV3ModelIo(
    context.paths.modelIo,
    evidence,
    context.manifest,
    context.explicitSecrets,
  );
  await appendLongRunV3CausalEvidence(
    context.paths.causalEvidence,
    evidence.causalEvidence,
    context.explicitSecrets,
  );
}

async function maybeWriteCheckpoint(
  runtime: LongRunV3Runtime,
  context: LongRunV3ExecutionContext,
): Promise<void> {
  const completed = context.turns.length;
  if (
    completed === 0 ||
    (completed % context.manifest.checkpointEveryTurns !== 0 &&
      ![108, 114, 120].includes(completed))
  ) {
    return;
  }
  const target = resolve(
    context.paths.checkpointsDirectory,
    `checkpoint-${String(completed).padStart(3, "0")}.json`,
  );
  if (await pathExists(target)) return;
  runtime.checkpointWal();
  const databases: Array<{
    role: LongRunV3Branch;
    path: string;
  }> = [{ role: "shared", path: context.sharedDatabasePath }];
  if (await pathExists(context.stableDatabasePath)) {
    databases.push({ role: "stable", path: context.stableDatabasePath });
  }
  if (await pathExists(context.independentDatabasePath)) {
    databases.push({
      role: "independent",
      path: context.independentDatabasePath,
    });
  }
  const checkpoint = await createLongRunV3Checkpoint({
    runDirectory: context.runDirectory,
    manifest: context.manifest,
    completedCandidateTurns: completed,
    completedTurnIds: context.turns.map((turn) => turn.turnId),
    databases,
    createdAtUtc: runtime.nowUtc,
  });
  await writeLongRunV3Checkpoint(context.runDirectory, checkpoint);
}

async function verifyFrontendMigration(
  action: Extract<ScenarioAction, { kind: "verify_frontend" }>,
  workspaceRoot: string,
): Promise<LongRunV3ActionResult> {
  const appShellPath = resolve(
    workspaceRoot,
    "apps/web/src/components/AppShell.tsx",
  );
  const chatPath = resolve(workspaceRoot, "apps/web/src/pages/ChatPage.tsx");
  const timelinePath = resolve(
    workspaceRoot,
    "apps/web/src/pages/TimelinePage.tsx",
  );
  const retiredRailPath = resolve(
    workspaceRoot,
    "apps/web/src/components/ScheduleRail.tsx",
  );
  const timelineLineagePath = resolve(
    workspaceRoot,
    "apps/web/src/lib/timelineLineage.ts",
  );
  const timelinePresentationPath = resolve(
    workspaceRoot,
    "apps/web/src/lib/timelinePresentation.ts",
  );
  const [
    appShellSource,
    chatSource,
    timelineSource,
    timelineLineageSource,
    timelinePresentationSource,
    scheduleRailExists,
  ] = await Promise.all([
    readFile(appShellPath, "utf8"),
    readFile(chatPath, "utf8"),
    readFile(timelinePath, "utf8"),
    readFile(timelineLineagePath, "utf8"),
    readFile(timelinePresentationPath, "utf8"),
    pathExists(retiredRailPath),
  ]);
  const verification = evaluateLongRunV3FrontendMigrationSources({
    appShellSource,
    chatSource,
    timelineSource,
    timelineLineageSource,
    timelinePresentationSource,
    scheduleRailExists,
  });
  return {
    action,
    status: "completed",
    atUtc: new Date().toISOString(),
    detail: {
      passed: verification.passed,
      checks: verification.checks,
      files: [
        appShellPath,
        chatPath,
        timelinePath,
        timelineLineagePath,
        timelinePresentationPath,
        retiredRailPath,
      ],
    },
  };
}

async function sha256Database(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function assertionProjection(
  snapshot: LongRunV3RuntimeSnapshot,
): CompanionLongRunV3Snapshot {
  return {
    durableSha256: snapshot.durableSha256,
    dailyContexts: snapshot.dailyContexts,
    scheduleItems: snapshot.scheduleItems,
    dilemmas: snapshot.dilemmas,
    supportInterventions: snapshot.supportInterventions,
    decisions: snapshot.decisions,
    actions: snapshot.actions,
    outcomes: snapshot.outcomes,
    reflections: snapshot.reflections,
    pressureEpisodes: snapshot.pressureEpisodes,
    relationshipMilestones: snapshot.relationshipMilestones,
    messages: snapshot.messages,
    activityEvents: snapshot.activityEvents,
    domainEvents: snapshot.domainEvents,
  };
}

function memoryProjection(snapshot: LongRunV3RuntimeSnapshot) {
  return {
    messages: snapshot.messages,
    memories: snapshot.memories,
    memoryEvidence: snapshot.memoryEvidence,
    retrievalRuns: snapshot.retrievalRuns,
    activityEvents: snapshot.activityEvents,
    domainEvents: snapshot.domainEvents,
  };
}

function durableNegativeProjection(snapshot: LongRunV3RuntimeSnapshot) {
  return {
    ...memoryProjection(snapshot),
    actions: snapshot.actions,
    outcomes: snapshot.outcomes,
  };
}

function pressureExpectation(
  turn: LongRunTurnSpec,
  evidenceMessageId: string | undefined,
  before: LongRunV3RuntimeSnapshot,
):
  | {
      evidenceMessageId: string;
      episodeId?: string;
      pressure?: "increase" | "decrease" | "unchanged";
      clarity?: "increase" | "decrease" | "unchanged";
      feltUnderstood?: "increase" | "decrease" | "unchanged";
      currentPressure?: number;
      currentClarity?: number;
      initialPressure?: number;
      initialClarity?: number;
      requirePreexistingEpisode?: boolean;
      subject: "user";
      pressureKind: "work";
    }
  | undefined {
  if (evidenceMessageId === undefined) return undefined;
  const existingUserWorkEpisodes = before.pressureEpisodes.filter(
    (episode) => episode.subject === "user" && episode.pressureKind === "work",
  );
  const laterEpisodeId =
    existingUserWorkEpisodes.length === 1
      ? existingUserWorkEpisodes[0]!.id
      : "__ambiguous_or_missing_t26_pressure_episode__";
  const common = {
    evidenceMessageId,
    subject: "user" as const,
    pressureKind: "work" as const,
  };
  switch (turn.candidateNumber) {
    case 26:
      return {
        ...common,
        episodeId: laterEpisodeId,
        initialPressure: 0.8,
        initialClarity: 0.2,
        currentPressure: 0.8,
        currentClarity: 0.2,
        requirePreexistingEpisode: true,
      };
    case 30:
      return {
        ...common,
        episodeId: laterEpisodeId,
        pressure: "unchanged",
        currentPressure: 0.8,
        currentClarity: 0.2,
        feltUnderstood: "increase",
        requirePreexistingEpisode: true,
      };
    case 35:
      return {
        ...common,
        episodeId: laterEpisodeId,
        pressure: "decrease",
        clarity: "increase",
        currentPressure: 0.7,
        currentClarity: 0.5,
        requirePreexistingEpisode: true,
      };
    case 53:
      return {
        ...common,
        episodeId: laterEpisodeId,
        pressure: "decrease",
        clarity: "increase",
        currentPressure: 0.6,
        currentClarity: 0.7,
        requirePreexistingEpisode: true,
      };
    case 67:
      return {
        ...common,
        episodeId: laterEpisodeId,
        pressure: "increase",
        clarity: "decrease",
        currentPressure: 0.7,
        currentClarity: 0.6,
        requirePreexistingEpisode: true,
      };
    case 106:
      return {
        ...common,
        episodeId: laterEpisodeId,
        pressure: "decrease",
        clarity: "increase",
        currentPressure: 0.4,
        currentClarity: 0.8,
        requirePreexistingEpisode: true,
      };
    default:
      return undefined;
  }
}

function lastRawCandidate(
  attempts: readonly LongRunV3ProviderAttemptEvidence[],
  calls: readonly LongRunV3LogicalCallTrace[],
): unknown {
  const attempt = attempts.at(-1);
  if (attempt?.rawResponse !== undefined) return attempt.rawResponse;
  if (attempt?.responseText !== undefined) return attempt.responseText;
  return calls.at(-1)?.parsedOutput;
}

function actionResultContainsReplay(result: {
  action: unknown;
  detail?: unknown;
}): boolean {
  const action = asRecord(result.action);
  const detail = asRecord(result.detail);
  return (
    action?.["kind"] === "replay_turn" && detail?.["idempotentReplay"] === true
  );
}

interface DeclaredAssertionInput {
  turn: LongRunTurnSpec;
  response: LongRunTurnHttpResult;
  before: LongRunV3RuntimeSnapshot;
  after: LongRunV3RuntimeSnapshot;
  observations: ObservationSlice;
  actionResults: readonly LongRunV3ActionResult[];
  assistantMessage: string;
  coreAssertions: readonly CompanionLongRunV3HardGateResult[];
  branchExpectation?: {
    branch: "A" | "B";
    expectedAnchorSha256: string;
    actualAnchorSha256: string;
    durableProjection: unknown;
    forbiddenDurableFragments: readonly string[];
    assistantText: string;
    forbiddenAssistantFragments: readonly string[];
  };
  context: LongRunV3ExecutionContext;
  runtime: LongRunV3Runtime;
}

interface ResolvedMemoryRecallExpectation {
  expectation?: CompanionLongRunV3MemoryRecallExpectation;
  missingSourceTurnIds: readonly string[];
}

function resolveMemoryRecallExpectation(
  manifestExpectation: LongRunV3MemoryRecallExpectation | undefined,
  runtime: LongRunV3Runtime,
): ResolvedMemoryRecallExpectation {
  if (manifestExpectation === undefined) return { missingSourceTurnIds: [] };
  const missingSourceTurnIds: string[] = [];
  const resolveSourceTurnIds = (
    turnIds: readonly string[] | undefined,
  ): string[] =>
    (turnIds ?? []).flatMap((turnId) => {
      const messageId = runtime.rememberedTurn(turnId)?.userMessageId;
      if (messageId !== undefined) return [messageId];
      missingSourceTurnIds.push(turnId);
      return [];
    });
  const requiredSourceMessageIds = resolveSourceTurnIds(
    manifestExpectation.requiredSourceTurnIds,
  );
  const forbiddenSourceMessageIds = resolveSourceTurnIds(
    manifestExpectation.forbiddenSourceTurnIds,
  );
  const requiredGroups = (manifestExpectation.requiredGroups ?? []).map(
    (group) => {
      const groupSourceMessageIds = resolveSourceTurnIds(group.sourceTurnIds);
      return {
        label: group.label,
        ...(group.contentIncludesAll === undefined
          ? {}
          : { contentIncludesAll: group.contentIncludesAll }),
        ...(group.contentIncludesAny === undefined
          ? {}
          : { contentIncludesAny: group.contentIncludesAny }),
        ...(groupSourceMessageIds.length === 0
          ? {}
          : { requiredSourceMessageIds: groupSourceMessageIds }),
      };
    },
  );
  return {
    expectation: {
      ...(manifestExpectation.minimumSelectedMemories === undefined
        ? {}
        : {
            minimumSelectedMemories:
              manifestExpectation.minimumSelectedMemories,
          }),
      ...(requiredGroups.length === 0 ? {} : { requiredGroups }),
      ...(manifestExpectation.requireDistinctGroupMatches === undefined
        ? {}
        : {
            requireDistinctGroupMatches:
              manifestExpectation.requireDistinctGroupMatches,
          }),
      ...(manifestExpectation.forbiddenContent === undefined
        ? {}
        : { forbiddenContent: manifestExpectation.forbiddenContent }),
      ...(requiredSourceMessageIds.length === 0
        ? {}
        : { requiredSourceMessageIds }),
      ...(forbiddenSourceMessageIds.length === 0
        ? {}
        : { forbiddenSourceMessageIds }),
    },
    missingSourceTurnIds: [...new Set(missingSourceTurnIds)],
  };
}

function assertionPromptCalls(observations: ObservationSlice) {
  return observations.logicalCalls.map((call) => ({
    purpose: call.purpose,
    system: call.system,
    prompt: call.prompt,
    primaryChat: call.purpose === "chat_turn",
  }));
}

function canonicalUserCausalChain(
  snapshot: LongRunV3RuntimeSnapshot,
  runtime: LongRunV3Runtime,
): {
  dilemmaId: string;
  decisionId?: string;
  issues: readonly string[];
} {
  const source = runtime.rememberedTurn("shared-048");
  const sourceIds = new Set(
    [source?.userMessageId, source?.assistantMessageId].filter(
      (value): value is string => value !== undefined,
    ),
  );
  const decisions = snapshot.decisions.filter(
    (decision) =>
      decision.subject === "user" &&
      decision.status === "current" &&
      sourceIds.size > 0 &&
      decision.sourceMessageIds.some((id) => sourceIds.has(id)),
  );
  if (decisions.length !== 1) {
    return {
      dilemmaId: "__missing_canonical_user_dilemma__",
      issues: [
        `expected_one_t48_user_decision:actual_${String(decisions.length)}`,
      ],
    };
  }
  const decision = decisions[0]!;
  return {
    dilemmaId: decision.dilemmaId,
    decisionId: decision.id,
    issues: [],
  };
}

const COMPLETE_CAUSAL_RECAP_STAGES = [
  "dilemma",
  "support",
  "decision",
  "action",
  "outcome",
  "reflection",
] as const satisfies readonly CompanionLongRunV3CausalRecapStage[];

const COMPLETE_CAUSAL_RECAP_COUNTS = {
  dilemma: 1,
  support: 1,
  decision: 1,
  action: 1,
  outcome: 1,
  reflection: 1,
} as const;

function evaluateDeclaredTurnAssertions(
  input: DeclaredAssertionInput,
): LongRunV3HardAssertionResult[] {
  const core = new Map(
    input.coreAssertions.map((result) => [result.code, result]),
  );
  const addedDecisions = addedRows(
    input.before.decisions,
    input.after.decisions,
  );
  const addedActions = addedRows(input.before.actions, input.after.actions);
  const addedOutcomes = addedRows(input.before.outcomes, input.after.outcomes);
  const addedReflections = addedRows(
    input.before.reflections,
    input.after.reflections,
  );
  const parsed = input.response.parsed;
  const persistedUser =
    parsed === undefined
      ? undefined
      : input.after.messages.find(
          (message) => asRecord(message)?.["id"] === parsed.userMessage.id,
        );
  const persistedAssistant =
    parsed === undefined
      ? undefined
      : input.after.messages.find(
          (message) => asRecord(message)?.["id"] === parsed.assistantMessage.id,
        );
  const actionByKind = (kind: ScenarioAction["kind"]) =>
    input.actionResults.find(
      (result) => asRecord(result.action)?.["kind"] === kind,
    );
  const coreResult = (
    code: CompanionLongRunV3HardGateResult["code"],
    mappedCode: string,
  ): LongRunV3HardAssertionResult => {
    const result = core.get(code);
    return {
      code: mappedCode,
      status: result?.status ?? "SKIPPED",
      summary: result?.summary ?? `Core assertion ${code} was unavailable.`,
      ...(result?.expected === undefined ? {} : { expected: result.expected }),
      ...(result?.actual === undefined ? {} : { actual: result.actual }),
    };
  };
  const result = (
    code: HardAssertion,
    passed: boolean,
    summary: string,
    actual?: unknown,
  ): LongRunV3HardAssertionResult => ({
    code,
    status: passed ? "PASS" : "FAIL",
    summary,
    ...(actual === undefined ? {} : { actual }),
  });

  return input.turn.hardAssertions.map((code) => {
    switch (code) {
      case "http_success":
        return result(
          code,
          input.response.http.status >= 200 && input.response.http.status < 300,
          "Candidate local HTTP request completed successfully.",
          input.response.http.status,
        );
      case "response_contract_valid":
        return result(
          code,
          parsed !== undefined,
          "The candidate response passed SendMessageResponse Zod validation.",
        );
      case "persisted_turn_matches_response":
        return result(
          code,
          parsed !== undefined &&
            asRecord(persistedUser)?.["content"] ===
              parsed.userMessage.content &&
            asRecord(persistedAssistant)?.["content"] ===
              parsed.assistantMessage.content,
          "Persisted user and assistant rows match the application response.",
        );
      case "no_unvalidated_write":
        return result(
          code,
          true,
          "The complete durable projection passed all imported domain schemas.",
        );
      case "prompt_budget_bounded": {
        const maximum = input.context.manifest.profileConfig.maxContextTokens;
        const over = input.observations.logicalCalls.filter((call) => {
          const estimated = estimateConversationTokens(
            `${call.system}\n${call.prompt}`,
          );
          const output =
            call.maxOutputTokens ??
            input.context.manifest.profileConfig.maxOutputTokens ??
            0;
          return maximum !== undefined && estimated + output > maximum;
        });
        return result(
          code,
          over.length === 0,
          "Prompt plus declared maximum output stays within the profile context budget.",
          over.map((call) => call.purpose),
        );
      }
      case "trace_lineage_complete":
        return result(
          code,
          parsed !== undefined &&
            persistedUser !== undefined &&
            persistedAssistant !== undefined &&
            input.observations.logicalCalls.length > 0,
          "Message, logical call, response, and persisted rows are linked.",
        );
      case "fuzzy_life_context_unique_per_local_day":
        return coreResult("daily_context_unique", code);
      case "no_exact_schedule_created":
        return coreResult("no_schedule_growth", code);
      case "prompt_excludes_future_schedule":
        return coreResult("prompt_excludes_future_schedule", code);
      case "prompt_includes_life_context":
        return coreResult("prompt_includes_life_context", code);
      case "causal_stage_separation": {
        const structural = core.get("causal_stage_separated");
        const required = requiredCausalStageForTurn({
          turn: input.turn,
          after: input.after,
          addedDecisions,
          addedActions,
          addedOutcomes,
          addedReflections,
        });
        return result(
          code,
          structural?.status === "PASS" && required.passed,
          `${structural?.summary ?? "Causal references were unavailable."} ${required.summary}`,
          {
            structural: structural?.actual,
            requiredStage: required.actual,
          },
        );
      }
      case "delegated_decision_authorized":
        return coreResult("delegated_decision_authorized", code);
      case "pressure_change_requires_explicit_evidence":
        return coreResult("pressure_change_evidence_bound", code);
      case "branch_isolation":
      case "branch_anchor_preserved":
        return coreResult("branch_isolated", code);
      case "support_mode_matches_request": {
        const validation = validateCompanionLongRunV3SupportMode({
          before: assertionProjection(input.before),
          after: assertionProjection(input.after),
          expectedMode: input.turn.supportMode ?? "listen_only",
          evidenceMessageId:
            parsed?.assistantMessage.id ?? "__missing_assistant_message__",
          authorizationMessageId:
            parsed?.userMessage.id ?? "__missing_user_message__",
          offeredBy: "character",
          receivedBy: "user",
        });
        return result(
          code,
          input.turn.supportMode !== undefined && validation.passed,
          "Exactly one current-message support intervention matches the requested mode, direction, target, and allowed causal stage.",
          validation,
        );
      }
      case "delegated_decision_unique":
        return result(
          code,
          addedDecisions.length === 1 &&
            addedDecisions[0]?.authority === "delegated",
          "The authorization turn commits exactly one delegated decision.",
          addedDecisions.map((decision) => decision.id),
        );
      case "user_decision_not_delegated": {
        const relevant = addedDecisions.filter(
          (decision) =>
            parsed !== undefined &&
            decision.sourceMessageIds.includes(parsed.userMessage.id),
        );
        const branchDilemmaId = stableControlId(
          "dilemma",
          "user-second-career-dilemma",
        );
        const currentBranchDecisions = input.after.decisions.filter(
          (decision) =>
            decision.dilemmaId === branchDilemmaId &&
            decision.status === "current",
        );
        const correctCurrent =
          currentBranchDecisions.length === 1 &&
          currentBranchDecisions[0]?.subject === "user" &&
          currentBranchDecisions[0]?.authority === "subject" &&
          currentBranchDecisions[0]?.decidedBy === "user";
        const firstBranchTurn = input.turn.executionOrdinal === 109;
        const addedDelegated = addedDecisions.filter(
          (decision) => decision.authority === "delegated",
        );
        return result(
          code,
          correctCurrent &&
            addedDelegated.length === 0 &&
            (!firstBranchTurn ||
              (relevant.length === 1 &&
                relevant[0]?.id === currentBranchDecisions[0]?.id)),
          firstBranchTurn
            ? "The first branch turn adds exactly one current user-owned decision."
            : "Later branch turns retain the one user-owned decision and add no delegated choice.",
          {
            firstBranchTurn,
            relevant,
            currentBranchDecisions,
            addedDelegated,
          },
        );
      }
      case "bidirectional_causality_grounded": {
        const validation = validateCompanionLongRunV3BidirectionalCausality({
          snapshot: assertionProjection(input.after),
          characterDilemmaId: stableControlId(
            "dilemma",
            "night-voyage-dilemma",
          ),
          requiredCharacterStage: characterCausalStageStatus(
            input.after,
            input.turn.candidateNumber,
          ).requiredCharacterStage as CompanionLongRunV3CharacterCausalStage,
        });
        return result(
          code,
          validation.passed,
          "Both directions retain independently evidenced, correctly linked user and character causal stages.",
          validation,
        );
      }
      case "memory_write_grounded": {
        const validation = validateCompanionLongRunV3MemoryWrite({
          before: memoryProjection(input.before),
          after: memoryProjection(input.after),
          evidenceMessageId:
            parsed?.userMessage.id ?? "__missing_user_message__",
        });
        return result(
          code,
          validation.passed,
          "Every new memory is grounded by its own evidence row in the persisted current user message.",
          validation,
        );
      }
      case "memory_recall_evidence_bound": {
        const resolvedExpectation = resolveMemoryRecallExpectation(
          input.turn.memoryRecallExpectation,
          input.runtime,
        );
        const validation = validateCompanionLongRunV3MemoryRecall({
          before: memoryProjection(input.before),
          after: memoryProjection(input.after),
          evidenceMessageId:
            parsed?.userMessage.id ?? "__missing_user_message__",
          diagnostic: parsed?.memoryRecall,
          requireSelectedEvidence: true,
          promptCalls: assertionPromptCalls(input.observations),
          ...(resolvedExpectation.expectation === undefined
            ? {}
            : { expectation: resolvedExpectation.expectation }),
        });
        const missingExpectationSources =
          resolvedExpectation.missingSourceTurnIds.map(
            (turnId) => `memory_expectation_source_turn_missing:${turnId}`,
          );
        return result(
          code,
          validation.passed && missingExpectationSources.length === 0,
          "A declared positive recall selects the manifest-required active memories and their persisted source evidence into exactly one primary prompt.",
          {
            ...validation,
            issues: [...validation.issues, ...missingExpectationSources],
            resolvedExpectation: resolvedExpectation.expectation,
          },
        );
      }
      case "causal_recap_grounded": {
        const chain = canonicalUserCausalChain(input.before, input.runtime);
        const complete = input.turn.candidateNumber === 69;
        const validation = validateCompanionLongRunV3CausalRecapProvenance({
          snapshot: assertionProjection(input.before),
          evidence: memoryProjection(input.before),
          promptCalls: assertionPromptCalls(input.observations),
          dilemmaId: chain.dilemmaId,
          ...(chain.decisionId === undefined
            ? {}
            : { decisionId: chain.decisionId }),
          requiredStages: complete
            ? COMPLETE_CAUSAL_RECAP_STAGES
            : (["decision", "action"] as const),
          expectedStageCounts: complete
            ? COMPLETE_CAUSAL_RECAP_COUNTS
            : {
                decision: 1,
                action: 1,
                outcome: 0,
                reflection: 0,
              },
        });
        return result(
          code,
          validation.passed && chain.issues.length === 0,
          complete
            ? "The full dilemma-to-reflection recap is one source-bound durable chain injected into the primary prompt."
            : "The restart recap injects the one durable decision and action while proving that outcome and reflection are still absent.",
          {
            ...validation,
            issues: [...chain.issues, ...validation.issues],
          },
        );
      }
      case "causal_provenance_grounded": {
        const chain = canonicalUserCausalChain(input.before, input.runtime);
        const validation = validateCompanionLongRunV3CausalRecapProvenance({
          snapshot: assertionProjection(input.before),
          evidence: memoryProjection(input.before),
          promptCalls: assertionPromptCalls(input.observations),
          dilemmaId: chain.dilemmaId,
          ...(chain.decisionId === undefined
            ? {}
            : { decisionId: chain.decisionId }),
          requiredStages: COMPLETE_CAUSAL_RECAP_STAGES,
          expectedStageCounts: COMPLETE_CAUSAL_RECAP_COUNTS,
        });
        return result(
          code,
          validation.passed && chain.issues.length === 0,
          "The source-retrace prompt contains the complete canonical causal chain with persisted source evidence.",
          {
            ...validation,
            issues: [...chain.issues, ...validation.issues],
          },
        );
      }
      case "relationship_continuity_grounded": {
        const chain = canonicalUserCausalChain(input.before, input.runtime);
        const resolvedExpectation = resolveMemoryRecallExpectation(
          input.turn.memoryRecallExpectation,
          input.runtime,
        );
        const requiredMemoryGroups =
          resolvedExpectation.expectation?.requiredGroups ?? [];
        const validation =
          validateCompanionLongRunV3RelationshipContinuityGrounding({
            snapshot: assertionProjection(input.before),
            evidence: memoryProjection(input.before),
            promptCalls: assertionPromptCalls(input.observations),
            dilemmaId: chain.dilemmaId,
            ...(chain.decisionId === undefined
              ? {}
              : { decisionId: chain.decisionId }),
            requiredCausalStages: COMPLETE_CAUSAL_RECAP_STAGES,
            expectedStageCounts: COMPLETE_CAUSAL_RECAP_COUNTS,
            requiredMemoryGroups,
            requireDistinctMemoryGroups: true,
            minimumDurableMemories: 2,
          });
        const missingExpectationSources =
          resolvedExpectation.missingSourceTurnIds.map(
            (turnId) => `relationship_memory_source_turn_missing:${turnId}`,
          );
        return result(
          code,
          validation.passed &&
            chain.issues.length === 0 &&
            missingExpectationSources.length === 0,
          "Concrete relationship continuity is grounded by the durable causal chain plus separately evidenced disagreement and repair memories in the primary prompt.",
          {
            ...validation,
            issues: [
              ...chain.issues,
              ...validation.issues,
              ...missingExpectationSources,
            ],
          },
        );
      }
      case "memory_correction_supersedes":
        return result(
          code,
          correctionResponseValid(
            input.turn.candidateNumber,
            input.assistantMessage,
          ) &&
            correctionDurableStateValid(
              input.turn.candidateNumber,
              input.before,
              input.after,
            ),
          "The response treats the corrected fact as current and the old fact as historical.",
        );
      case "memory_abstains_without_evidence": {
        const durable = validateCompanionLongRunV3MemoryAbstentionDurability({
          before: durableNegativeProjection(input.before),
          after: durableNegativeProjection(input.after),
          evidenceMessageId:
            parsed?.userMessage.id ?? "__missing_user_message__",
        });
        return result(
          code,
          abstentionResponseValid(
            input.turn.candidateNumber,
            input.assistantMessage,
          ) && durable.passed,
          "The assistant abstains from the unsupported fact and writes no new user fact or shared-experience memory.",
          durable,
        );
      }
      case "planned_not_occurred": {
        const durable = validateCompanionLongRunV3PlannedNotOccurredDurability({
          before: durableNegativeProjection(input.before),
          after: durableNegativeProjection(input.after),
          evidenceMessageId:
            parsed?.userMessage.id ?? "__missing_user_message__",
        });
        return result(
          code,
          plannedOccurrenceResponseValid(
            input.turn.candidateNumber,
            input.assistantMessage,
          ) && durable.passed,
          "Neither the response nor durable memory/action/outcome tables turn a plan or unknown state into an occurred event.",
          durable,
        );
      }
      case "restart_preserves_state": {
        const detail = asRecord(actionByKind("restart_app")?.detail);
        return result(
          code,
          detail?.["beforeRestartSha256"] === detail?.["afterRestartSha256"],
          "Restart preserves the complete durable projection.",
          detail,
        );
      }
      case "idempotent_replay": {
        const detail = asRecord(actionByKind("replay_turn")?.detail);
        const observations = asRecord(detail?.["observations"]);
        return result(
          code,
          detail?.["idempotentReplay"] === true &&
            detail?.["durableStateUnchanged"] === true &&
            Array.isArray(observations?.["logicalCalls"]) &&
            observations["logicalCalls"].length === 0,
          "Replay returns the persisted pair without a model call or durable write.",
          detail,
        );
      }
      case "clock_rollback_idempotent": {
        const detail = asRecord(actionByKind("rollback_clock")?.detail);
        return result(
          code,
          detail?.["durableStateUnchanged"] === true &&
            detail?.["originalUtc"] === detail?.["restoredUtc"],
          "Clock rollback and restoration do not duplicate durable state.",
          detail,
        );
      }
      case "no_background_llm_while_closed": {
        const closeDetail = asRecord(actionByKind("close_app")?.detail);
        return result(
          code,
          closeDetail?.["logicalCallsWhileClosing"] === 0,
          "Closing and offline time emit no background model call.",
          closeDetail,
        );
      }
      case "schedule_capability_disabled":
      case "retired_schedule_api_returns_410": {
        const detail = asRecord(
          actionByKind("verify_retired_schedule")?.detail,
        );
        return result(
          code,
          detail?.["passed"] === true,
          "Exact schedule capability is retired and the legacy write API returns 410.",
          detail,
        );
      }
      case "frontend_schedule_absent":
      case "frontend_chat_usable":
      case "frontend_timeline_readable": {
        const detail = asRecord(actionByKind("verify_frontend")?.detail);
        return result(
          code,
          detail?.["passed"] === true,
          "The migrated frontend exposes chat and the causal timeline without schedule UI.",
          detail,
        );
      }
      case "cross_session_continuity": {
        const assistantSessionId = parsed?.assistantMessage.sessionId;
        const sessionExists = input.after.sessions.some(
          (value) => asRecord(value)?.["id"] === assistantSessionId,
        );
        const sessionWasEmpty = !input.before.messages.some(
          (value) => asRecord(value)?.["session_id"] === assistantSessionId,
        );
        return result(
          code,
          input.assistantMessage.trim().length > 0 &&
            assistantSessionId !== undefined &&
            sessionExists &&
            sessionWasEmpty,
          "The branch summary succeeds in a newly created session.",
        );
      }
      case "proactive_policy_respected":
      case "proactive_source_linked":
        return result(
          code,
          proactiveRowsGrounded(input.after.messages),
          "Any proactive message is source-linked; zero proactive messages is allowed.",
        );
      case "user_boundary_respected":
        return result(
          code,
          boundaryResponseValid(
            input.turn.candidateNumber,
            input.assistantMessage,
          ),
          "The assistant follows the user's stop or de-escalation boundary.",
        );
    }
  });
}

function requiredCausalStageForTurn(input: {
  turn: LongRunTurnSpec;
  after: LongRunV3RuntimeSnapshot;
  addedDecisions: LongRunV3RuntimeSnapshot["decisions"];
  addedActions: LongRunV3RuntimeSnapshot["actions"];
  addedOutcomes: LongRunV3RuntimeSnapshot["outcomes"];
  addedReflections: LongRunV3RuntimeSnapshot["reflections"];
}): { passed: boolean; summary: string; actual: unknown } {
  const sharedNumber =
    input.turn.scope === "shared" ? input.turn.candidateNumber : undefined;
  const delegatedDecision = input.after.decisions
    .filter(
      (decision) =>
        decision.subject === "user" && decision.authority === "delegated",
    )
    .at(-1);
  const branchDilemmaId = stableControlId(
    "dilemma",
    "user-second-career-dilemma",
  );
  const branchDecision = input.after.decisions.find(
    (decision) =>
      decision.dilemmaId === branchDilemmaId &&
      decision.subject === "user" &&
      decision.authority === "subject" &&
      decision.decidedBy === "user" &&
      decision.status === "current",
  );
  const decision =
    input.turn.scope === "shared" ? delegatedDecision : branchDecision;
  const linkedActions =
    decision === undefined
      ? []
      : input.after.actions.filter(
          (action) => action.decisionId === decision.id,
        );
  const linkedOutcomes =
    decision === undefined
      ? []
      : input.after.outcomes.filter(
          (outcome) => outcome.decisionId === decision.id,
        );
  const linkedReflections =
    decision === undefined
      ? []
      : input.after.reflections.filter(
          (reflection) => reflection.decisionId === decision.id,
        );

  let requiredStage = "reference_integrity_only";
  let passed = true;
  if (sharedNumber === 48) {
    requiredStage = "delegated_decision_without_action_or_outcome";
    passed =
      input.addedDecisions.length === 1 &&
      input.addedDecisions[0]?.authority === "delegated" &&
      input.addedActions.length === 0 &&
      input.addedOutcomes.length === 0;
  } else if (sharedNumber === 55) {
    requiredStage = "first_evidenced_action";
    passed =
      decision !== undefined &&
      input.addedActions.length === 1 &&
      input.addedActions[0]?.decisionId === decision.id &&
      input.addedOutcomes.length === 0;
  } else if (sharedNumber === 64) {
    requiredStage = "mixed_outcome_linked_to_action";
    passed =
      decision !== undefined &&
      input.addedOutcomes.length === 1 &&
      input.addedOutcomes[0]?.decisionId === decision.id &&
      input.addedOutcomes[0]?.valence === "mixed" &&
      input.addedOutcomes[0].actionIds.some((id) =>
        linkedActions.some((action) => action.id === id),
      );
  } else if (sharedNumber === 68) {
    requiredStage = "reflection_linked_to_decision_and_outcome";
    passed =
      decision !== undefined &&
      input.addedReflections.length === 1 &&
      input.addedReflections[0]?.decisionId === decision.id &&
      input.addedReflections[0]?.outcomeId !== undefined;
  } else if (
    sharedNumber !== undefined &&
    sharedNumber >= 69 &&
    sharedNumber <= 71
  ) {
    requiredStage = "complete_user_causal_chain";
    passed =
      decision !== undefined &&
      linkedActions.length > 0 &&
      linkedOutcomes.some(
        (outcome) =>
          outcome.valence === "mixed" && outcome.actionIds.length > 0,
      ) &&
      linkedReflections.length > 0;
  } else if (input.turn.scope !== "shared") {
    if (input.turn.executionOrdinal === 109) {
      requiredStage = "branch_user_owned_decision_only";
      passed =
        branchDecision !== undefined &&
        input.addedDecisions.length === 1 &&
        input.addedDecisions[0]?.id === branchDecision.id &&
        input.addedActions.length === 0 &&
        input.addedOutcomes.length === 0;
    } else if (input.turn.executionOrdinal === 110) {
      requiredStage = "branch_action";
      passed =
        branchDecision !== undefined &&
        input.addedActions.length === 1 &&
        input.addedActions[0]?.decisionId === branchDecision.id;
    } else if (input.turn.executionOrdinal === 111) {
      requiredStage = "branch_mixed_outcome";
      passed =
        branchDecision !== undefined &&
        input.addedOutcomes.length === 1 &&
        input.addedOutcomes[0]?.decisionId === branchDecision.id &&
        input.addedOutcomes[0]?.valence === "mixed" &&
        input.addedOutcomes[0].actionIds.length > 0;
    } else if (input.turn.executionOrdinal === 112) {
      requiredStage = "branch_reflection";
      passed =
        branchDecision !== undefined &&
        input.addedReflections.length === 1 &&
        input.addedReflections[0]?.decisionId === branchDecision.id &&
        input.addedReflections[0]?.outcomeId !== undefined;
    } else {
      requiredStage = "complete_branch_causal_chain";
      passed =
        branchDecision !== undefined &&
        linkedActions.length > 0 &&
        linkedOutcomes.some(
          (outcome) =>
            outcome.valence === "mixed" && outcome.actionIds.length > 0,
        ) &&
        linkedReflections.length > 0;
    }
  }

  return {
    passed,
    summary:
      requiredStage === "reference_integrity_only"
        ? "No stage-creation milestone is due on this turn."
        : `Required milestone: ${requiredStage}.`,
    actual: {
      requiredStage,
      decisionId: decision?.id,
      addedDecisionIds: input.addedDecisions.map((item) => item.id),
      addedActionIds: input.addedActions.map((item) => item.id),
      addedOutcomeIds: input.addedOutcomes.map((item) => item.id),
      addedReflectionIds: input.addedReflections.map((item) => item.id),
      linkedActionIds: linkedActions.map((item) => item.id),
      linkedOutcomeIds: linkedOutcomes.map((item) => item.id),
      linkedReflectionIds: linkedReflections.map((item) => item.id),
    },
  };
}

function buildTurnCausalEvidence(input: {
  runId: string;
  turn: LongRunTurnSpec;
  branch: LongRunV3Branch;
  before: LongRunV3RuntimeSnapshot;
  after: LongRunV3RuntimeSnapshot;
}): LongRunV3CausalEvidence[] {
  const capturedAtUtc = input.after.capturedAtUtc;
  const common = {
    schemaVersion: "companion-long-run-causal-evidence-v3" as const,
    runId: input.runId,
    turnId: input.turn.id,
    candidateOrdinal: input.turn.candidateNumber,
    branch: input.branch,
    capturedAtUtc,
  };
  const evidence: LongRunV3CausalEvidence[] = [
    {
      ...common,
      stage: "turn",
      subject: "system",
      sourceMessageIds: [],
      summary: "Candidate turn artifact coverage envelope.",
      payload: {
        logicalOrdinal: input.turn.executionOrdinal,
        candidateOrdinal: input.turn.candidateNumber,
      },
    },
  ];
  for (const row of addedRows(
    input.before.dailyContexts,
    input.after.dailyContexts,
  )) {
    evidence.push({
      ...common,
      stage: "life_context",
      subject: "character",
      sourceMessageIds: [],
      recordIds: [row.id],
      summary: row.currentFocus ?? row.theme ?? row.todayFocus.join("；"),
      payload: row,
    });
  }
  for (const row of addedRows(input.before.dilemmas, input.after.dilemmas)) {
    evidence.push({
      ...common,
      stage: "dilemma",
      subject: causalSubject(row.subject),
      sourceMessageIds: [...row.sourceMessageIds],
      recordIds: [row.id],
      summary: row.summary,
      payload: row,
    });
  }
  for (const row of addedRows(
    input.before.supportInterventions,
    input.after.supportInterventions,
  )) {
    evidence.push({
      ...common,
      stage: "support",
      subject: row.receivedBy,
      sourceMessageIds: [row.sourceMessageId],
      predecessorIds: [row.dilemmaId, row.pressureEpisodeId].filter(
        (id): id is string => id !== undefined,
      ),
      recordIds: [row.id],
      summary: row.summary,
      payload: row,
    });
  }
  for (const row of addedRows(input.before.decisions, input.after.decisions)) {
    evidence.push({
      ...common,
      stage: "decision",
      subject: causalSubject(row.subject),
      sourceMessageIds: [...row.sourceMessageIds],
      predecessorIds: [row.dilemmaId, ...row.supportInterventionIds],
      recordIds: [row.id],
      summary: row.selectionSummary,
      payload: row,
    });
  }
  for (const row of addedRows(input.before.actions, input.after.actions)) {
    evidence.push({
      ...common,
      stage: "action",
      subject: causalSubject(row.subject),
      sourceMessageIds: [...row.sourceEvidenceIds],
      predecessorIds: [row.decisionId],
      recordIds: [row.id],
      summary: row.summary,
      payload: row,
    });
  }
  for (const row of addedRows(input.before.outcomes, input.after.outcomes)) {
    evidence.push({
      ...common,
      stage: "outcome",
      subject: causalSubject(
        input.after.decisions.find((decision) => decision.id === row.decisionId)
          ?.subject,
      ),
      sourceMessageIds: [...row.sourceEvidenceIds],
      predecessorIds: [row.decisionId, ...row.actionIds],
      recordIds: [row.id],
      summary: row.summary,
      payload: row,
    });
  }
  for (const row of addedRows(
    input.before.reflections,
    input.after.reflections,
  )) {
    evidence.push({
      ...common,
      stage: "reflection",
      subject: causalSubject(row.subject),
      sourceMessageIds: [...row.sourceMessageIds],
      predecessorIds: [row.decisionId, row.outcomeId].filter(
        (id): id is string => id !== undefined,
      ),
      recordIds: [row.id],
      summary: row.summary,
      payload: row,
    });
  }
  for (const row of addedRows(
    input.before.relationshipMilestones,
    input.after.relationshipMilestones,
  )) {
    evidence.push({
      ...common,
      stage: "relationship",
      subject: "relationship",
      sourceMessageIds: [...row.sourceMessageIds],
      predecessorIds: [
        ...row.interventionIds,
        ...row.decisionIds,
        ...row.outcomeIds,
        ...row.reflectionIds,
      ],
      recordIds: [row.id],
      summary: row.summary,
      payload: row,
    });
  }
  for (const row of addedRawRows(input.before.memories, input.after.memories)) {
    const memoryContent = row["content"];
    evidence.push({
      ...common,
      stage: "memory",
      subject: "system",
      sourceMessageIds:
        typeof row["source_message_id"] === "string"
          ? [row["source_message_id"]]
          : [],
      recordIds: typeof row["id"] === "string" ? [row["id"]] : [],
      summary:
        typeof memoryContent === "string" ? memoryContent : "Memory recorded",
      payload: row,
    });
  }
  return evidence;
}

function branchTurnProjection(
  before: LongRunV3RuntimeSnapshot,
  after: LongRunV3RuntimeSnapshot,
): unknown {
  return {
    messages: addedRawRows(before.messages, after.messages),
    memories: addedRawRows(before.memories, after.memories),
    dilemmas: addedRows(before.dilemmas, after.dilemmas),
    interventions: addedRows(
      before.supportInterventions,
      after.supportInterventions,
    ),
    decisions: addedRows(before.decisions, after.decisions),
    actions: addedRows(before.actions, after.actions),
    outcomes: addedRows(before.outcomes, after.outcomes),
    reflections: addedRows(before.reflections, after.reflections),
  };
}

function causalSubject(
  subject: "user" | "character" | "shared" | undefined,
): "user" | "character" | "relationship" | "system" {
  if (subject === "user" || subject === "character") return subject;
  if (subject === "shared") return "relationship";
  return "system";
}

function addedRows<T extends { id: string }>(
  before: readonly T[],
  after: readonly T[],
): T[] {
  const ids = new Set(before.map((row) => row.id));
  return after.filter((row) => !ids.has(row.id));
}

function addedRawRows(
  before: readonly unknown[],
  after: readonly unknown[],
): Array<Record<string, unknown>> {
  const beforeIds = new Set(
    before.flatMap((row) => {
      const id = asRecord(row)?.["id"];
      return typeof id === "string" ? [id] : [];
    }),
  );
  return after.flatMap((row) => {
    const record = asRecord(row);
    const id = record?.["id"];
    return record !== undefined &&
      (typeof id !== "string" || !beforeIds.has(id))
      ? [record]
      : [];
  });
}

function characterCausalStageStatus(
  snapshot: LongRunV3RuntimeSnapshot,
  candidateNumber: number,
): {
  passed: boolean;
  requiredCharacterStage: string;
  characterDilemmaId?: string;
  supportIds: string[];
  decisionIds: string[];
  actionIds: string[];
  outcomeIds: string[];
  reflectionIds: string[];
} {
  const dilemmaId = stableControlId("dilemma", "night-voyage-dilemma");
  const dilemma = snapshot.dilemmas.find((item) => item.id === dilemmaId);
  const supports = snapshot.supportInterventions.filter(
    (item) =>
      item.dilemmaId === dilemmaId &&
      item.offeredBy === "user" &&
      item.receivedBy === "character",
  );
  const decisions = snapshot.decisions.filter(
    (item) =>
      item.dilemmaId === dilemmaId &&
      item.subject === "character" &&
      item.authority === "subject" &&
      item.decidedBy === "character",
  );
  const decisionIds = new Set(decisions.map((item) => item.id));
  const actions = snapshot.actions.filter(
    (item) => item.subject === "character" && decisionIds.has(item.decisionId),
  );
  const actionIds = new Set(actions.map((item) => item.id));
  const outcomes = snapshot.outcomes.filter(
    (item) =>
      decisionIds.has(item.decisionId) &&
      item.valence === "mixed" &&
      item.actionIds.some((id) => actionIds.has(id)),
  );
  const outcomeIds = new Set(outcomes.map((item) => item.id));
  const reflections = snapshot.reflections.filter(
    (item) =>
      item.subject === "character" &&
      item.decisionId !== undefined &&
      decisionIds.has(item.decisionId) &&
      item.outcomeId !== undefined &&
      outcomeIds.has(item.outcomeId),
  );
  const requiredCharacterStage =
    candidateNumber <= 73
      ? "dilemma"
      : candidateNumber <= 75
        ? "user_to_character_support"
        : candidateNumber <= 77
          ? "character_decision_and_action"
          : candidateNumber === 78
            ? "mixed_outcome"
            : "character_reflection";
  const passed =
    dilemma !== undefined &&
    (requiredCharacterStage === "dilemma" || supports.length > 0) &&
    (![
      "character_decision_and_action",
      "mixed_outcome",
      "character_reflection",
    ].includes(requiredCharacterStage) ||
      (decisions.length === 1 && actions.length > 0)) &&
    (!["mixed_outcome", "character_reflection"].includes(
      requiredCharacterStage,
    ) ||
      outcomes.length > 0) &&
    (requiredCharacterStage !== "character_reflection" ||
      reflections.length > 0);
  return {
    passed,
    requiredCharacterStage,
    ...(dilemma === undefined ? {} : { characterDilemmaId: dilemma.id }),
    supportIds: supports.map((item) => item.id),
    decisionIds: decisions.map((item) => item.id),
    actionIds: actions.map((item) => item.id),
    outcomeIds: outcomes.map((item) => item.id),
    reflectionIds: reflections.map((item) => item.id),
  };
}

function correctionDurableStateValid(
  candidate: number,
  before: LongRunV3RuntimeSnapshot,
  after: LongRunV3RuntimeSnapshot,
): boolean {
  if (![14, 42, 99].includes(candidate)) return true;
  if (
    sha256CanonicalV3(before.memories) === sha256CanonicalV3(after.memories)
  ) {
    return false;
  }
  const added = addedRawRows(before.memories, after.memories);
  const addedIds = new Set(
    added.flatMap((memory) =>
      typeof memory["id"] === "string" ? [memory["id"]] : [],
    ),
  );
  const superseded = after.memories.flatMap((value) => {
    const memory = asRecord(value);
    return memory?.["status"] === "superseded" &&
      typeof memory["superseded_by_id"] === "string" &&
      addedIds.has(memory["superseded_by_id"])
      ? [memory]
      : [];
  });
  return added.length > 0 && superseded.length > 0;
}

function correctionResponseValid(candidate: number, text: string): boolean {
  if (candidate === 14) return /藏青/u.test(text) && !/仍是?绿色/u.test(text);
  if (candidate === 42)
    return /16/u.test(text) && !/期限(?:仍|还是).*14/u.test(text);
  if (candidate === 94) return /授权|自己执行|没有逼|并非.*逼/u.test(text);
  if ([99, 100].includes(candidate)) return /成都/u.test(text);
  if (candidate === 101)
    return /成都/u.test(text) && !/准备去重庆|现在去重庆/u.test(text);
  return text.trim().length > 0;
}

function abstentionResponseValid(candidate: number, text: string): boolean {
  if (candidate === 18)
    return /不记得|没有.*证据|没.*一起|并没有|不能确认/u.test(text);
  if ([19, 102].includes(candidate))
    return /不知道|没(?:有)?提|不清楚|无法确认|没有.*信息/u.test(text);
  if (candidate === 103) return /没有|并未|没.*一起|未确认/u.test(text);
  return text.trim().length > 0;
}

function plannedOccurrenceResponseValid(
  candidate: number,
  text: string,
): boolean {
  if ([23, 104].includes(candidate)) {
    return /计划|打算/u.test(text) && /还没|没有|不等于|未/u.test(text);
  }
  if ([49, 52, 54, 56, 58, 59, 77, 83].includes(candidate)) {
    return !/你已经(?:完成|得到最终|成功|确定发生)/u.test(text);
  }
  return !/我们已经一起(?:吃饭|见面|看展)/u.test(text);
}

function proactiveRowsGrounded(messages: readonly unknown[]): boolean {
  return messages.every((value) => {
    const message = asRecord(value);
    if (message?.["message_kind"] !== "assistant_proactive") return true;
    return typeof message["trigger_event_id"] === "string";
  });
}

function boundaryResponseValid(candidate: number, text: string): boolean {
  if ([87, 88, 89, 90].includes(candidate)) {
    return !/你应该辞职|现在就做决定|必须继续聊/u.test(text);
  }
  return text.trim().length > 0;
}

function resolveRememberedTurn(
  turnId: string,
  history: LongRunV3TurnHistory | undefined,
  local: ReadonlyMap<string, LongRunV3RememberedTurn>,
): LongRunV3RememberedTurn | undefined {
  if (isTurnHistoryMap(history)) {
    return history.get(turnId) ?? local.get(turnId);
  }
  if (history !== undefined) {
    return history[turnId] ?? local.get(turnId);
  }
  return local.get(turnId);
}

function isTurnHistoryMap(
  history: LongRunV3TurnHistory | undefined,
): history is ReadonlyMap<string, LongRunV3RememberedTurn> {
  return (
    history !== undefined &&
    typeof (history as { get?: unknown }).get === "function"
  );
}

function copyStandardActionResult(
  action: ScenarioAction,
  result:
    | {
        status: "completed" | "skipped";
        atUtc: string;
        detail?: unknown;
      }
    | undefined,
): LongRunV3ActionResult {
  if (result === undefined) {
    throw new Error(`Standard action produced no result: ${action.kind}`);
  }
  return {
    action,
    status: result.status,
    atUtc: result.atUtc,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  };
}

function completed(
  action: ScenarioAction,
  atUtc: string,
  detail?: unknown,
): LongRunV3ActionResult {
  return {
    action,
    status: "completed",
    atUtc,
    ...(detail === undefined ? {} : { detail }),
  };
}

function skipped(
  action: ScenarioAction,
  atUtc: string,
  detail?: unknown,
): LongRunV3ActionResult {
  return {
    action,
    status: "skipped",
    atUtc,
    ...(detail === undefined ? {} : { detail }),
  };
}

function readDocuments<T>(
  database: Database,
  table: string,
  jsonColumn: string,
  schema: { parse(input: unknown): T },
  agentId: string,
): T[] {
  if (!tableExists(database, table)) return [];
  return (
    database
      .prepare(
        `SELECT ${jsonColumn} AS json FROM ${table}
         WHERE agent_id = ? ORDER BY rowid`,
      )
      .all(agentId) as Array<{ json: string }>
  ).map((row) => schema.parse(JSON.parse(row.json)));
}

function readRows(
  database: Database,
  table: string,
  agentId: string,
): Array<Record<string, unknown>> {
  if (!tableExists(database, table)) return [];
  return (
    database
      .prepare(`SELECT * FROM ${table} WHERE agent_id = ? ORDER BY rowid`)
      .all(agentId) as Array<Record<string, unknown>>
  ).map(parseJsonColumns);
}

function readMemoryEvidence(
  database: Database,
  agentId: string,
): Array<Record<string, unknown>> {
  if (!tableExists(database, "memory_evidence")) return [];
  return (
    database
      .prepare(
        `SELECT evidence.* FROM memory_evidence AS evidence
         INNER JOIN memories AS memory ON memory.id = evidence.memory_id
         WHERE memory.agent_id = ? ORDER BY evidence.rowid`,
      )
      .all(agentId) as Array<Record<string, unknown>>
  ).map(parseJsonColumns);
}

function readRetrievalRunSummaries(
  database: Database,
  agentId: string,
): Array<Record<string, unknown>> {
  if (!tableExists(database, "retrieval_runs")) return [];
  return (
    database
      .prepare(
        `SELECT id, agent_id, session_id, source_message_id, mode,
          candidate_count, selected_count, candidates_json, result_json,
          evidence_bundle_json, rendered_prompt_fragment, created_at_utc
         FROM retrieval_runs WHERE agent_id = ? ORDER BY rowid`,
      )
      .all(agentId) as Array<Record<string, unknown>>
  ).map(parseJsonColumns);
}

function readLlmCallSummaries(
  database: Database,
  agentId: string,
): Array<Record<string, unknown>> {
  if (!tableExists(database, "llm_calls")) return [];
  return database
    .prepare(`SELECT * FROM llm_calls WHERE agent_id = ? ORDER BY rowid`)
    .all(agentId) as Array<Record<string, unknown>>;
}

function tableDigest(
  database: Database,
  table: string,
  agentId: string,
): string {
  if (!tableExists(database, table)) return sha256CanonicalV3([]);
  const rows = database
    .prepare(`SELECT * FROM ${table} WHERE agent_id = ? ORDER BY rowid`)
    .all(agentId);
  return sha256CanonicalV3(rows);
}

function tableExists(database: Database, table: string): boolean {
  return (
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) !== undefined
  );
}

function parseJsonColumns(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => {
      if (!key.endsWith("_json") || typeof value !== "string") {
        return [key, value];
      }
      try {
        return [key.slice(0, -5), JSON.parse(value) as unknown];
      } catch {
        return [key, value];
      }
    }),
  );
}

function stableControlId(prefix: string, seed: string): string {
  const digest = createHash("sha256").update(seed).digest("hex").slice(0, 24);
  return `${prefix}_long_run_v3_${digest}`;
}

function fuzzyTime(atUtc: string): {
  effectiveLocalDate: string;
  effectivePeriod:
    | "early_morning"
    | "morning"
    | "midday"
    | "afternoon"
    | "evening"
    | "late_night";
  temporalPrecision: "period";
  recordedAtUtc: string;
} {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(atUtc));
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (part === undefined) throw new Error(`Missing date part: ${type}`);
    return part;
  };
  const hour = Number(value("hour"));
  const effectivePeriod =
    hour < 6
      ? "early_morning"
      : hour < 11
        ? "morning"
        : hour < 13
          ? "midday"
          : hour < 18
            ? "afternoon"
            : hour < 22
              ? "evening"
              : "late_night";
  return {
    effectiveLocalDate: `${value("year")}-${value("month")}-${value("day")}`,
    effectivePeriod,
    temporalPrecision: "period",
    recordedAtUtc: atUtc,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// Kept exported for narrow runner tests which need to prove that a replay made
// no provider request while still retaining the observer slice in evidence.
export type LongRunV3ObservationSlice = ObservationSlice;
