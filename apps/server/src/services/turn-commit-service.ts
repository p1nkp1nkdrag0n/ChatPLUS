import {
  MemoryRecallRuntimeDiagnosticSchema,
  type ContextPlan,
  type MemoryRecallRuntimeDiagnostic,
} from "@personasim/contracts";
import { worldEffectEligibilityForTurn } from "@personasim/features";

import type { DatabaseStore, StoredMessage } from "../db/store.js";
import type { SimulationCapabilities } from "../domain/capabilities.js";
import { ApiError, notFound } from "../domain/errors.js";
import type {
  CharacterSpec,
  RuntimeState,
  ScheduleItem,
} from "../domain/schemas.js";
import {
  RetrievalRunRepository,
  type CreateRetrievalRunInput,
} from "../repositories/retrieval-run-repository.js";
import type { SseHub } from "../sse/hub.js";
import type {
  ConversationContextService,
  PreparedConversationContext,
} from "./conversation-context-service.js";
import type { MemoryRecallPreview } from "./memory-recall-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { classifyMemoryEpistemicStatus } from "./memory-epistemic.js";
import { validateMergeAndPersistMemories } from "./memory-service.js";
import type { PersonalIntentService } from "./personal-intent-service.js";
import type { MaterializedPersonaReply } from "./reply-generation-service.js";
import type { ScheduleService } from "./schedule-service.js";
import { SCHEDULE_NEGOTIATION_POLICY_VERSION } from "./schedule-negotiation-service.js";
import {
  deliveryModeForDecision,
  type ResolvedTurn,
} from "./turn-decision-service.js";
import type {
  SplitTurnProposalRejection,
  ValidatedTurnOutcome,
} from "./turn-execution-service.js";
import type { ResolvedTurnObservation } from "./turn-understanding-service.js";
import type {
  PreparedWorldEffectTurn,
  TurnProposalRejection,
} from "./world-effect-service.js";

export interface TurnCommitServiceOptions {
  scheduleNegotiationMode?: "legacy" | "shadow" | "enforced";
  liveWorldEffectsMode?: "off" | "shadow" | "enforced";
}

export interface TurnPipelineShadowComparison {
  legacyDecisionPath: string;
  splitRoute?: string;
  splitObservationConfidence?: number;
  splitObservationRejectedFields?: Array<{
    field: string;
    reasonCode: string;
  }>;
  legacyScheduleAction: string;
  splitScheduleIntent?: string;
  splitScheduleOutcomeKind?: string;
  legacyAcceptedEffectKinds: string[];
  splitAcceptedEffectKinds: string[];
  nextStateFieldDiffs: string[];
  splitUnderstandingOrigin?: string;
  splitFailures: string[];
  legacyObjectiveReplyAligned?: boolean;
  splitObjectiveReplyAligned?: boolean;
  splitReplyStatus?: "generated" | "repaired" | "fallback" | "failed";
  splitReplyRepairAttempted?: boolean;
  splitReplyUsedFallback?: boolean;
  splitReplyIssueCodes?: string[];
  splitProposalRejectionCodes?: string[];
}

export interface SplitReplyCommitAudit {
  repairAttempted: boolean;
  usedFallback: boolean;
  issueCodes: string[];
  promptSegmentTrace: unknown;
}

export interface ChatTurnCommand {
  agentId: string;
  clientMessageId: string;
  text: string;
}

export type ChatTurnResult = {
  idempotentReplay: boolean;
  userMessage: StoredMessage;
  assistantMessage: StoredMessage;
  scheduleChanges: ScheduleItem[];
  state: RuntimeState;
  memoryRecall?: MemoryRecallRuntimeDiagnostic;
  decision: {
    reasonCode: string;
    reasonSummary: string;
    toneTags: string[];
    deliveryMode: "single_block" | "sequential";
    chunks: string[];
  };
};

export interface CommitSplitInput {
  sessionId: string;
  command: ChatTurnCommand;
  spec: CharacterSpec;
  nowUtc: string;
  turnStartedAtMs: number;
  expectedStateRevision: number;
  userMessageId: string;
  retrievalRun?: CreateRetrievalRunInput;
  assistantMessageId: string;
  capabilities: SimulationCapabilities;
  recallDiagnostic?: MemoryRecallRuntimeDiagnostic;
  preparedContext?: PreparedConversationContext;
  observation: ResolvedTurnObservation;
  outcome: ValidatedTurnOutcome;
  reply: MaterializedPersonaReply;
  replyAudit: SplitReplyCommitAudit;
  contextPlanTrace?: ContextPlan;
}

/**
 * Owns the single durable chat transaction plus post-commit continuity and SSE
 * publication. Provider/network work is completed before this boundary.
 */
export class TurnCommitService {
  private readonly retrievalRuns: RetrievalRunRepository;

  constructor(
    private readonly store: DatabaseStore,
    private readonly schedules: ScheduleService,
    private readonly personalIntents: PersonalIntentService,
    private readonly sse: SseHub,
    private readonly contexts?: ConversationContextService,
    private readonly options: TurnCommitServiceOptions = {},
    private readonly memoryLifecycle?: MemoryLifecycleService,
  ) {
    this.retrievalRuns = new RetrievalRunRepository(store.database);
  }

  replay(input: {
    turn: { userMessage: StoredMessage; assistantMessage: StoredMessage };
    command: ChatTurnCommand;
  }): ChatTurnResult {
    assertIdempotentTurnMatches(input.turn.userMessage, input.command.text);
    const state = this.store.getRuntimeState(input.command.agentId);
    if (!state) throw notFound("Character state");
    return replayResult(input.turn, state);
  }

  async commit(input: {
    sessionId: string;
    command: ChatTurnCommand;
    spec: CharacterSpec;
    nowUtc: string;
    turnStartedAtMs: number;
    userMessageId: string;
    retrievalRun?: CreateRetrievalRunInput;
    assistantMessageId: string;
    capabilities: SimulationCapabilities;
    recallDiagnostic?: MemoryRecallRuntimeDiagnostic;
    promptSegmentTrace: unknown;
    pipelineShadowComparison?: TurnPipelineShadowComparison;
    contextPlanTrace?: ContextPlan;
    preparedContext?: PreparedConversationContext;
    turn: ResolvedTurn;
    world: PreparedWorldEffectTurn;
  }): Promise<ChatTurnResult> {
    const userMessage: StoredMessage = {
      id: input.userMessageId,
      sessionId: input.sessionId,
      agentId: input.command.agentId,
      role: "user",
      content: input.command.text,
      messageKind: "user",
      clientMessageId: input.command.clientMessageId,
      metadata: {
        epistemicStatus: classifyMemoryEpistemicStatus(input.command.text),
      },
      createdAtUtc: input.nowUtc,
    };
    const assistantMessage: StoredMessage = {
      id: input.assistantMessageId,
      sessionId: input.sessionId,
      agentId: input.command.agentId,
      role: "assistant",
      content: input.world.decision.reply.text,
      messageKind: "assistant_reply",
      inReplyToMessageId: userMessage.id,
      metadata: {
        chunks: input.world.decision.reply.chunks,
        deliveryMode: deliveryModeForDecision(input.world.decision),
        toneTags: input.world.decision.reply.toneTags,
        reasonCode: input.world.decision.reasonCode,
        reasonSummary: input.world.decision.reasonSummary,
        repairAttempted: input.world.repairAttempted,
        decisionPath: input.world.decisionPath,
        rejectedProposalCount: input.world.proposalRejections.length,
        scheduleActionAudit: input.world.scheduleActionAudit,
        ...(input.recallDiagnostic === undefined
          ? {}
          : { memoryRecall: input.recallDiagnostic }),
        promptSegmentTrace: input.promptSegmentTrace,
        ...(input.pipelineShadowComparison === undefined
          ? {}
          : { turnPipelineShadow: input.pipelineShadowComparison }),
        ...(input.contextPlanTrace === undefined
          ? {}
          : { contextPlan: safeContextPlanTrace(input.contextPlanTrace) }),
        ...(input.preparedContext === undefined
          ? {}
          : {
              temporalQueryResolution: input.preparedContext.temporalResolution,
              continuityPromptCueIds: input.preparedContext.continuity.cueIds,
            }),
      },
      createdAtUtc: input.nowUtc,
    };

    let effectsToApply = input.world.validation.accepted;
    let scheduleChanges: ScheduleItem[] = [];
    let memoryIds: string[] = [];
    let personalIntentIds: string[] = [];
    let totalChatLatencyMs = 0;
    try {
      this.store.transaction(() => {
        const duplicate = this.store.findTurnByClientMessageId(
          input.sessionId,
          input.command.clientMessageId,
        );
        if (duplicate) throw new DuplicateTurnError(duplicate);
        if (
          this.options.scheduleNegotiationMode === "enforced" &&
          input.world.negotiationPlan?.effect !== undefined
        ) {
          const finalValidation = this.schedules.validateEffectsPartial(
            input.command.agentId,
            [input.world.negotiationPlan.effect],
            input.nowUtc,
          );
          if (finalValidation.accepted.length !== 1) {
            throw new ApiError(
              409,
              "schedule_changed_during_negotiation",
              "The schedule changed before the negotiated command could be committed.",
              finalValidation.rejections,
            );
          }
          effectsToApply = finalValidation.accepted;
        }
        if (
          input.retrievalRun !== undefined &&
          (input.retrievalRun.agentId !== input.command.agentId ||
            input.retrievalRun.inputSnapshot.agentId !== input.command.agentId)
        ) {
          throw new TypeError(
            "Prepared retrieval run agent must match the chat turn agent",
          );
        }
        this.store.insertMessage(userMessage);
        if (input.retrievalRun !== undefined) {
          this.retrievalRuns.create({
            ...input.retrievalRun,
            sessionId: input.sessionId,
            sourceMessageId: userMessage.id,
          });
        }
        this.persistRecallAudit(input, userMessage);
        this.persistPipelineShadowComparison(input, userMessage);
        personalIntentIds = this.persistPersonalIntents(
          input,
          userMessage,
          input.world.proposalRejections,
        );
        this.persistWorldEffectsAudit(input, userMessage);
        this.persistNegotiation(input, userMessage);
        scheduleChanges = this.schedules.applyValidatedEffects(
          input.command.agentId,
          effectsToApply,
          input.nowUtc,
        );
        this.persistScheduleCommand(input, userMessage, scheduleChanges);
        for (const rejection of input.world.proposalRejections) {
          this.store.insertRejectedProposal({
            agentId: input.command.agentId,
            sessionId: input.sessionId,
            purpose: "chat_turn",
            reasonCode: rejection.reasonCode,
            reasonSummary: rejection.reasonSummary,
            raw: rejection.raw,
            correlationId: input.command.clientMessageId,
            createdAtUtc: input.nowUtc,
          });
        }
        if (input.world.stateChanged) {
          this.store.updateRuntimeState(input.world.nextState);
        }
        memoryIds = input.capabilities.longTermMemory
          ? validateMergeAndPersistMemories({
              store: this.store,
              agentId: input.command.agentId,
              candidates: input.world.decision.memoryCandidates,
              nowUtc: input.nowUtc,
              maxCandidates: input.capabilities.memoryCandidatesPerTurn,
              authoritativeMessageId: userMessage.id,
            }).map((memory) => memory.id)
          : [];
        this.reconcileCommittedMemories({
          agentId: input.command.agentId,
          memoryIds,
          correlationId: input.command.clientMessageId,
          causationId: userMessage.id,
        });
        totalChatLatencyMs = elapsedMilliseconds(input.turnStartedAtMs);
        assistantMessage.metadata.totalChatLatencyMs = totalChatLatencyMs;
        this.store.insertMessage(assistantMessage);
        if (
          !this.store.insertDomainEvent({
            agentId: input.command.agentId,
            streamType: "conversation",
            streamId: input.sessionId,
            streamVersion: this.store.nextDomainEventStreamVersion(
              "conversation",
              input.sessionId,
            ),
            eventType: "conversation.turn_committed",
            recordedAtUtc: input.nowUtc,
            payload: {
              userMessageId: userMessage.id,
              assistantMessageId: assistantMessage.id,
              scheduleItemIds: scheduleChanges.map((item) => item.id),
              memoryIds,
              reasonCode: input.world.decision.reasonCode,
              personalIntentIds,
              stateRevision: input.world.nextState.revision,
              totalChatLatencyMs,
            },
            correlationId: input.command.clientMessageId,
            causationId: userMessage.id,
            idempotencyKey: `chat:${input.sessionId}:${input.command.clientMessageId}`,
          })
        ) {
          throw new Error("Conversation turn audit event was not inserted");
        }
      });
    } catch (error) {
      if (error instanceof DuplicateTurnError) {
        const stored = error.turn;
        if (!stored.assistantMessage) throw error;
        assertIdempotentTurnMatches(stored.userMessage, input.command.text);
        return replayResult(
          {
            userMessage: stored.userMessage,
            assistantMessage: stored.assistantMessage,
          },
          this.store.getRuntimeState(input.command.agentId) ??
            input.world.nextState,
        );
      }
      throw error;
    }

    await this.commitContinuity({
      ...input,
      userMessage,
      assistantMessage,
      memoryIds,
    });
    this.publish({
      ...input,
      assistantMessage,
      scheduleChanges,
    });
    return {
      idempotentReplay: false,
      userMessage,
      assistantMessage,
      scheduleChanges,
      state: input.world.nextState,
      ...(input.recallDiagnostic === undefined
        ? {}
        : { memoryRecall: input.recallDiagnostic }),
      decision: {
        reasonCode: input.world.decision.reasonCode,
        reasonSummary: input.world.decision.reasonSummary,
        toneTags: input.world.decision.reply.toneTags,
        deliveryMode: deliveryModeForDecision(input.world.decision),
        chunks: input.world.decision.reply.chunks,
      },
    };
  }

  async commitSplit(input: CommitSplitInput): Promise<ChatTurnResult> {
    assertPreparedSplitRuntimeState(input);
    const proposalRejections =
      input.outcome.proposalRejections.map(safeSplitRejection);
    const userMessage: StoredMessage = {
      id: input.userMessageId,
      sessionId: input.sessionId,
      agentId: input.command.agentId,
      role: "user",
      content: input.command.text,
      messageKind: "user",
      clientMessageId: input.command.clientMessageId,
      metadata: {
        epistemicStatus: classifyMemoryEpistemicStatus(input.command.text),
      },
      createdAtUtc: input.nowUtc,
    };
    const assistantMessage: StoredMessage = {
      id: input.assistantMessageId,
      sessionId: input.sessionId,
      agentId: input.command.agentId,
      role: "assistant",
      content: input.reply.text,
      messageKind: "assistant_reply",
      inReplyToMessageId: userMessage.id,
      metadata: {
        chunks: input.reply.chunks,
        deliveryMode: splitDeliveryMode(input.reply),
        toneTags: input.reply.toneTags,
        reasonCode: input.outcome.audit.decisionPath,
        reasonSummary: splitReasonSummary(input.outcome),
        repairAttempted: input.replyAudit.repairAttempted,
        usedFallback: input.replyAudit.usedFallback,
        replyIssueCodes: uniqueStrings(input.replyAudit.issueCodes),
        decisionPath: input.outcome.audit.decisionPath,
        turnPipelineMode: "enforced",
        turnRoute: input.outcome.route,
        understandingOrigin: input.observation.origin,
        observationConfidence: input.observation.confidence,
        observationRejectedFields: input.observation.rejectedFields.map(
          (rejection) => ({
            field: rejection.field,
            reasonCode: rejection.reasonCode,
          }),
        ),
        scheduleOutcomeKind: input.outcome.scheduleOutcome.kind,
        scheduleOutcome: input.outcome.scheduleOutcome,
        acceptedEffectKinds: acceptedSplitEffectKinds(input.outcome),
        acceptedEffectCount: acceptedSplitEffectKinds(input.outcome).length,
        worldEffectsMode: input.outcome.worldEffectsMode,
        worldEffectsWritesEnabled: input.outcome.worldEffectWritesEnabled,
        worldEffectsApplied:
          input.outcome.worldEffectWritesEnabled &&
          hasAcceptedSplitWorldEffects(input.outcome),
        rejectedProposalCount: proposalRejections.length,
        proposalRejectionCodes: uniqueStrings(
          proposalRejections.map((rejection) => rejection.reasonCode),
        ),
        replyMutationAuthorization: "disabled",
        promptSegmentTrace: input.replyAudit.promptSegmentTrace,
        ...(input.recallDiagnostic === undefined
          ? {}
          : { memoryRecall: input.recallDiagnostic }),
        ...(input.contextPlanTrace === undefined
          ? {}
          : { contextPlan: safeContextPlanTrace(input.contextPlanTrace) }),
        ...(input.preparedContext === undefined
          ? {}
          : {
              temporalQueryResolution: input.preparedContext.temporalResolution,
              continuityPromptCueIds: input.preparedContext.continuity.cueIds,
            }),
        turnTopics: input.observation.topics.map((topic) => ({
          key: topic.key,
          domain: topic.domain,
          confidence: topic.confidence,
        })),
        topicKeys: input.observation.topics.map((topic) => topic.key),
      },
      createdAtUtc: input.nowUtc,
    };

    let effectsToApply = input.outcome.scheduleWritesEnabled
      ? input.outcome.validation.accepted
      : [];
    let scheduleChanges: ScheduleItem[] = [];
    let memoryIds: string[] = [];
    let personalIntentIds: string[] = [];
    let totalChatLatencyMs = 0;
    try {
      this.store.transaction(() => {
        const duplicate = this.store.findTurnByClientMessageId(
          input.sessionId,
          input.command.clientMessageId,
        );
        if (duplicate) throw new DuplicateTurnError(duplicate);

        const plan = input.outcome.negotiationPlan;
        if (input.outcome.scheduleWritesEnabled && plan?.effect !== undefined) {
          const finalValidation = this.schedules.validateEffectsPartial(
            input.command.agentId,
            [plan.effect],
            input.nowUtc,
          );
          if (finalValidation.accepted.length !== 1) {
            throw new ApiError(
              409,
              "schedule_changed_during_negotiation",
              "The schedule changed before the negotiated command could be committed.",
              finalValidation.rejections,
            );
          }
          effectsToApply = finalValidation.accepted;
        }

        assertRetrievalRunMatches(input);
        this.store.insertMessage(userMessage);
        if (input.retrievalRun !== undefined) {
          this.retrievalRuns.create({
            ...input.retrievalRun,
            sessionId: input.sessionId,
            sourceMessageId: userMessage.id,
          });
        }
        this.persistSplitRecallAudit(input, userMessage);
        this.persistSplitUnderstandingAudit(input, userMessage);
        personalIntentIds = this.persistSplitPersonalIntents(
          input,
          userMessage,
          proposalRejections,
        );
        this.persistSplitNegotiation(input, userMessage);
        scheduleChanges = this.schedules.applyValidatedEffects(
          input.command.agentId,
          effectsToApply,
          input.nowUtc,
        );
        this.persistSplitScheduleCommand(input, userMessage, scheduleChanges);
        for (const rejection of proposalRejections) {
          this.store.insertRejectedProposal({
            agentId: input.command.agentId,
            sessionId: input.sessionId,
            purpose: "split_turn",
            reasonCode: rejection.reasonCode,
            reasonSummary: rejection.reasonSummary,
            raw: null,
            correlationId: input.command.clientMessageId,
            createdAtUtc: input.nowUtc,
          });
        }
        if (
          input.outcome.worldEffectWritesEnabled &&
          input.outcome.stateChanged
        ) {
          if (
            !this.store.compareAndSetRuntimeState(
              input.outcome.nextState,
              input.expectedStateRevision,
            )
          ) {
            throw staleRuntimeState();
          }
        } else if (
          !this.store.runtimeStateRevisionMatches(
            input.command.agentId,
            input.expectedStateRevision,
          )
        ) {
          throw staleRuntimeState();
        }
        memoryIds =
          input.outcome.worldEffectWritesEnabled &&
          input.capabilities.longTermMemory
            ? validateMergeAndPersistMemories({
                store: this.store,
                agentId: input.command.agentId,
                candidates: input.outcome.acceptedWorldEffects.memoryCandidates,
                nowUtc: input.nowUtc,
                maxCandidates: input.capabilities.memoryCandidatesPerTurn,
                authoritativeMessageId: userMessage.id,
              }).map((memory) => memory.id)
            : [];
        const expectedPersistedMemoryCount =
          input.outcome.worldEffectWritesEnabled &&
          input.capabilities.longTermMemory
            ? input.outcome.acceptedWorldEffects.memoryCandidates.length
            : 0;
        if (memoryIds.length !== expectedPersistedMemoryCount) {
          throw new Error(
            "A preflight-authorized memory candidate failed authoritative persistence",
          );
        }
        this.reconcileCommittedMemories({
          agentId: input.command.agentId,
          memoryIds,
          correlationId: input.command.clientMessageId,
          causationId: userMessage.id,
        });
        this.persistSplitWorldEffectsAudit(input, userMessage, {
          proposalRejections,
          memoryIds,
          personalIntentIds,
        });

        assistantMessage.metadata.scheduleOutcome = materializeScheduleOutcome(
          input.outcome,
          scheduleChanges,
        );
        assistantMessage.metadata.rejectedProposalCount =
          proposalRejections.length;
        assistantMessage.metadata.proposalRejectionCodes = uniqueStrings(
          proposalRejections.map((rejection) => rejection.reasonCode),
        );
        assistantMessage.metadata.worldEffectsApplied =
          splitWorldEffectsApplied(input.outcome, {
            memoryIds,
            personalIntentIds,
          });
        totalChatLatencyMs = elapsedMilliseconds(input.turnStartedAtMs);
        assistantMessage.metadata.totalChatLatencyMs = totalChatLatencyMs;
        this.store.insertMessage(assistantMessage);
        if (
          !this.store.insertDomainEvent({
            agentId: input.command.agentId,
            streamType: "conversation",
            streamId: input.sessionId,
            streamVersion: this.store.nextDomainEventStreamVersion(
              "conversation",
              input.sessionId,
            ),
            eventType: "conversation.turn_committed",
            recordedAtUtc: input.nowUtc,
            payload: {
              userMessageId: userMessage.id,
              assistantMessageId: assistantMessage.id,
              scheduleItemIds: scheduleChanges.map((item) => item.id),
              memoryIds,
              personalIntentIds,
              reasonCode: input.outcome.audit.decisionPath,
              turnPipelineMode: "enforced",
              route: input.outcome.route,
              stateRevision: input.outcome.nextState.revision,
              totalChatLatencyMs,
              scheduleOutcomeKind: input.outcome.scheduleOutcome.kind,
              acceptedEffectKinds: acceptedSplitEffectKinds(input.outcome),
              worldEffectsMode: input.outcome.worldEffectsMode,
              worldEffectsWritesEnabled: input.outcome.worldEffectWritesEnabled,
              worldEffectsApplied: splitWorldEffectsApplied(input.outcome, {
                memoryIds,
                personalIntentIds,
              }),
              rejectionCodes: uniqueStrings(
                proposalRejections.map((rejection) => rejection.reasonCode),
              ),
            },
            correlationId: input.command.clientMessageId,
            causationId: userMessage.id,
            idempotencyKey: `chat:${input.sessionId}:${input.command.clientMessageId}`,
          })
        ) {
          throw new Error("Conversation turn audit event was not inserted");
        }
      });
    } catch (error) {
      if (error instanceof DuplicateTurnError) {
        const stored = error.turn;
        if (!stored.assistantMessage) throw error;
        assertIdempotentTurnMatches(stored.userMessage, input.command.text);
        return replayResult(
          {
            userMessage: stored.userMessage,
            assistantMessage: stored.assistantMessage,
          },
          this.store.getRuntimeState(input.command.agentId) ??
            input.outcome.nextState,
        );
      }
      throw error;
    }

    await this.commitSplitContinuity({
      input,
      userMessage,
      assistantMessage,
      memoryIds,
    });
    this.publishSplit({ input, assistantMessage, scheduleChanges });
    return {
      idempotentReplay: false,
      userMessage,
      assistantMessage,
      scheduleChanges,
      state: input.outcome.nextState,
      ...(input.recallDiagnostic === undefined
        ? {}
        : { memoryRecall: input.recallDiagnostic }),
      decision: {
        reasonCode: input.outcome.audit.decisionPath,
        reasonSummary: splitReasonSummary(input.outcome),
        toneTags: input.reply.toneTags,
        deliveryMode: splitDeliveryMode(input.reply),
        chunks: input.reply.chunks,
      },
    };
  }

  private persistRecallAudit(
    input: Parameters<TurnCommitService["commit"]>[0],
    userMessage: StoredMessage,
  ): void {
    if (input.recallDiagnostic === undefined) return;
    if (
      !this.store.insertDomainEvent({
        agentId: input.command.agentId,
        streamType: "memory_recall",
        streamId: input.sessionId,
        streamVersion: this.store.nextDomainEventStreamVersion(
          "memory_recall",
          input.sessionId,
        ),
        eventType: "memory.recall_evaluated",
        recordedAtUtc: input.nowUtc,
        payload: input.recallDiagnostic,
        correlationId: input.command.clientMessageId,
        causationId: userMessage.id,
        idempotencyKey: `memory-recall:${input.sessionId}:${input.command.clientMessageId}`,
      })
    ) {
      throw new Error("Memory recall audit event was not inserted");
    }
  }

  private persistPipelineShadowComparison(
    input: Parameters<TurnCommitService["commit"]>[0],
    userMessage: StoredMessage,
  ): void {
    const comparison = input.pipelineShadowComparison;
    if (comparison === undefined) return;
    if (
      !this.store.insertDomainEvent({
        agentId: input.command.agentId,
        streamType: "conversation",
        streamId: input.sessionId,
        streamVersion: this.store.nextDomainEventStreamVersion(
          "conversation",
          input.sessionId,
        ),
        eventType: "conversation.turn_pipeline_shadow_compared",
        recordedAtUtc: input.nowUtc,
        payload: comparison,
        correlationId: input.command.clientMessageId,
        causationId: userMessage.id,
        idempotencyKey: `turn-pipeline-shadow:${input.sessionId}:${input.command.clientMessageId}`,
      })
    ) {
      throw new Error("Turn pipeline shadow comparison event was not inserted");
    }
  }

  private persistSplitRecallAudit(
    input: CommitSplitInput,
    userMessage: StoredMessage,
  ): void {
    if (input.recallDiagnostic === undefined) return;
    if (
      !this.store.insertDomainEvent({
        agentId: input.command.agentId,
        streamType: "memory_recall",
        streamId: input.sessionId,
        streamVersion: this.store.nextDomainEventStreamVersion(
          "memory_recall",
          input.sessionId,
        ),
        eventType: "memory.recall_evaluated",
        recordedAtUtc: input.nowUtc,
        payload: input.recallDiagnostic,
        correlationId: input.command.clientMessageId,
        causationId: userMessage.id,
        idempotencyKey: `memory-recall:${input.sessionId}:${input.command.clientMessageId}`,
      })
    ) {
      throw new Error("Memory recall audit event was not inserted");
    }
  }

  private persistSplitUnderstandingAudit(
    input: CommitSplitInput,
    userMessage: StoredMessage,
  ): void {
    if (
      !this.store.insertDomainEvent({
        agentId: input.command.agentId,
        streamType: "turn_understanding",
        streamId: input.sessionId,
        streamVersion: this.store.nextDomainEventStreamVersion(
          "turn_understanding",
          input.sessionId,
        ),
        eventType: "conversation.turn_understanding_resolved",
        recordedAtUtc: input.nowUtc,
        payload: {
          schemaVersion: 1,
          origin: input.observation.origin,
          route: input.observation.route,
          scheduleIntentKind: input.observation.scheduleIntent.kind,
          confidence: input.observation.confidence,
          evidenceCount: input.observation.validatedEvidence.length,
          topicKeys: input.observation.topics.map((topic) => topic.key),
          routerReasonCodes: input.observation.routerReasonCodes,
          rejectedFields: input.observation.rejectedFields.map((rejection) => ({
            field: rejection.field,
            reasonCode: rejection.reasonCode,
          })),
        },
        correlationId: input.command.clientMessageId,
        causationId: userMessage.id,
        idempotencyKey: `turn-understanding:${input.sessionId}:${input.command.clientMessageId}`,
      })
    ) {
      throw new Error("Turn understanding audit event was not inserted");
    }
  }

  private persistSplitPersonalIntents(
    input: CommitSplitInput,
    userMessage: StoredMessage,
    proposalRejections: SplitTurnProposalRejection[],
  ): string[] {
    if (!input.outcome.worldEffectWritesEnabled) return [];
    const ids: string[] = [];
    for (const [
      index,
      candidate,
    ] of input.outcome.acceptedWorldEffects.personalIntentCandidates.entries()) {
      try {
        ids.push(
          this.personalIntents.upsertOrMerge({
            agentId: input.command.agentId,
            sessionId: input.sessionId,
            proposal: {
              basisKind: "chat",
              candidate,
              evidenceMessageId: userMessage.id,
            },
            correlationId: input.command.clientMessageId,
            causationId: userMessage.id,
            idempotencyKey: `personal-intent:${input.sessionId}:${input.command.clientMessageId}:${String(index)}`,
          }).intent.id,
        );
      } catch (error) {
        if (!isRecoverableChatIntentRejection(error)) throw error;
        proposalRejections.push({
          reasonCode: error.code,
          reasonSummary: error.message,
          field: "personal_intent_candidate",
        });
      }
    }
    return [...new Set(ids)];
  }

  private persistSplitWorldEffectsAudit(
    input: CommitSplitInput,
    userMessage: StoredMessage,
    applied: {
      proposalRejections: readonly SplitTurnProposalRejection[];
      memoryIds: readonly string[];
      personalIntentIds: readonly string[];
    },
  ): void {
    if (input.outcome.worldEffectsMode === "off") return;
    const effects = input.outcome.acceptedWorldEffects;
    if (
      !this.store.insertDomainEvent({
        agentId: input.command.agentId,
        streamType: "world_effects",
        streamId: input.sessionId,
        streamVersion: this.store.nextDomainEventStreamVersion(
          "world_effects",
          input.sessionId,
        ),
        eventType:
          input.outcome.worldEffectsMode === "enforced"
            ? "conversation.world_effects_committed"
            : "conversation.world_effects_shadow_evaluated",
        recordedAtUtc: input.nowUtc,
        payload: {
          mode: input.outcome.worldEffectsMode,
          writesEnabled: input.outcome.worldEffectWritesEnabled,
          applied: splitWorldEffectsApplied(input.outcome, applied),
          accepted: {
            stateDelta: effects.stateDelta !== undefined,
            relationshipDelta: effects.relationshipDelta !== undefined,
            memoryCandidateCount: effects.memoryCandidates.length,
            personalIntentCandidateCount:
              effects.personalIntentCandidates.length,
          },
          persisted: {
            memoryCount: applied.memoryIds.length,
            personalIntentCount: applied.personalIntentIds.length,
          },
          rejectionCodes: uniqueStrings(
            applied.proposalRejections.map((rejection) => rejection.reasonCode),
          ),
          limitsApplied: input.observation.worldEffectsValidation.limitsApplied,
        },
        correlationId: input.command.clientMessageId,
        causationId: userMessage.id,
        idempotencyKey: `world-effects:${input.sessionId}:${input.command.clientMessageId}`,
      })
    ) {
      throw new Error("World-effects audit event was not inserted");
    }
  }

  private persistSplitNegotiation(
    input: CommitSplitInput,
    userMessage: StoredMessage,
  ): void {
    const plan = input.outcome.negotiationPlan;
    if (!input.outcome.scheduleWritesEnabled || plan === undefined) return;
    for (const update of plan.updates) {
      if (
        plan.expectedActive?.id === update.id &&
        !this.store.compareAndSetScheduleNegotiation(update, {
          status: plan.expectedActive.status,
          offerVersion: plan.expectedActive.offerVersion,
        })
      ) {
        throw new ApiError(
          409,
          "stale_schedule_negotiation",
          "The schedule offer changed before it could be committed.",
        );
      }
      if (plan.expectedActive?.id !== update.id) {
        this.store.upsertScheduleNegotiation(update);
      }
    }
    if (plan.transition === undefined) return;
    const latest = plan.updates.at(-1);
    if (
      !this.store.insertDomainEvent({
        agentId: input.command.agentId,
        streamType: "schedule_negotiation",
        streamId: latest?.id ?? input.sessionId,
        streamVersion: latest?.offerVersion ?? 0,
        eventType: `schedule.negotiation_${plan.transition.reason}`,
        recordedAtUtc: input.nowUtc,
        payload: {
          actionKind: plan.actionKind,
          transition: plan.transition,
          negotiationId: latest?.id,
          offerVersion: latest?.offerVersion,
          turnPipelineMode: "enforced",
        },
        correlationId: input.command.clientMessageId,
        causationId: userMessage.id,
        idempotencyKey: `schedule-negotiation:${input.sessionId}:${input.command.clientMessageId}`,
      })
    ) {
      throw new Error("Schedule negotiation audit event was not inserted");
    }
  }

  private persistSplitScheduleCommand(
    input: CommitSplitInput,
    userMessage: StoredMessage,
    scheduleChanges: ScheduleItem[],
  ): void {
    const plan = input.outcome.negotiationPlan;
    if (
      !input.outcome.scheduleWritesEnabled ||
      scheduleChanges.length === 0 ||
      plan?.effect === undefined
    ) {
      return;
    }
    const negotiation = plan.updates.at(-1);
    if (
      !this.store.insertDomainEvent({
        agentId: input.command.agentId,
        streamType: "schedule",
        streamId: input.command.agentId,
        streamVersion: this.store.nextDomainEventStreamVersion(
          "schedule",
          input.command.agentId,
        ),
        eventType: "schedule.command_committed",
        recordedAtUtc: input.nowUtc,
        effectiveAtUtc: scheduleChanges[0]!.startAtUtc,
        payload: {
          negotiationId: negotiation?.id,
          offerVersion: negotiation?.offerVersion,
          operation: "create",
          changedItemIds: scheduleChanges.map((item) => item.id),
          policyVersion:
            typeof negotiation?.record["policyVersion"] === "number"
              ? negotiation.record["policyVersion"]
              : SCHEDULE_NEGOTIATION_POLICY_VERSION,
          turnPipelineMode: "enforced",
        },
        correlationId: input.command.clientMessageId,
        causationId: userMessage.id,
        idempotencyKey: `schedule-command:${negotiation?.id}:${String(negotiation?.offerVersion)}`,
      })
    ) {
      throw new Error("Schedule command audit event was not inserted");
    }
  }

  private persistPersonalIntents(
    input: Parameters<TurnCommitService["commit"]>[0],
    userMessage: StoredMessage,
    proposalRejections: TurnProposalRejection[],
  ): string[] {
    const ids: string[] = [];
    for (const [index, candidate] of (
      input.world.decision.personalIntentCandidates ?? []
    ).entries()) {
      try {
        ids.push(
          this.personalIntents.upsertOrMerge({
            agentId: input.command.agentId,
            sessionId: input.sessionId,
            proposal: {
              basisKind: "chat",
              candidate,
              evidenceMessageId: userMessage.id,
            },
            correlationId: input.command.clientMessageId,
            causationId: userMessage.id,
            idempotencyKey: `personal-intent:${input.sessionId}:${input.command.clientMessageId}:${index}`,
          }).intent.id,
        );
      } catch (error) {
        if (!isRecoverableChatIntentRejection(error)) throw error;
        proposalRejections.push({
          raw: candidate,
          reasonCode: error.code,
          reasonSummary: error.message,
        });
      }
    }
    return [...new Set(ids)];
  }

  private persistWorldEffectsAudit(
    input: Parameters<TurnCommitService["commit"]>[0],
    userMessage: StoredMessage,
  ): void {
    if (input.turn.worldEffectsAudit === undefined) return;
    const accepted = input.turn.worldEffectsAudit.validation.effects;
    if (
      !this.store.insertDomainEvent({
        agentId: input.command.agentId,
        streamType: "world_effects",
        streamId: input.sessionId,
        streamVersion: this.store.nextDomainEventStreamVersion(
          "world_effects",
          input.sessionId,
        ),
        eventType:
          input.turn.worldEffectsAudit.mode === "enforced"
            ? "conversation.world_effects_committed"
            : "conversation.world_effects_shadow_evaluated",
        recordedAtUtc: input.nowUtc,
        payload: {
          mode: input.turn.worldEffectsAudit.mode,
          accepted: {
            stateDelta: accepted.stateDelta !== undefined,
            relationshipDelta: accepted.relationshipDelta !== undefined,
            memoryCandidateCount: accepted.memoryCandidates.length,
            personalIntentCandidateCount:
              input.world.decision.personalIntentCandidates?.length ?? 0,
          },
          rejectionCodes:
            input.turn.worldEffectsAudit.validation.rejections.map(
              (rejection) => rejection.reasonCode,
            ),
          limitsApplied: input.turn.worldEffectsAudit.validation.limitsApplied,
        },
        correlationId: input.command.clientMessageId,
        causationId: userMessage.id,
        idempotencyKey: `world-effects:${input.sessionId}:${input.command.clientMessageId}`,
      })
    ) {
      throw new Error("World-effects audit event was not inserted");
    }
  }

  private persistNegotiation(
    input: Parameters<TurnCommitService["commit"]>[0],
    userMessage: StoredMessage,
  ): void {
    const plan = input.world.negotiationPlan;
    if (
      this.options.scheduleNegotiationMode === "enforced" &&
      plan !== undefined
    ) {
      for (const update of plan.updates) {
        if (
          plan.expectedActive?.id === update.id &&
          !this.store.compareAndSetScheduleNegotiation(update, {
            status: plan.expectedActive.status,
            offerVersion: plan.expectedActive.offerVersion,
          })
        ) {
          throw new ApiError(
            409,
            "stale_schedule_negotiation",
            "The schedule offer changed before it could be committed.",
          );
        }
        if (plan.expectedActive?.id !== update.id) {
          this.store.upsertScheduleNegotiation(update);
        }
      }
      if (plan.transition === undefined) return;
      const latest = plan.updates.at(-1);
      if (
        !this.store.insertDomainEvent({
          agentId: input.command.agentId,
          streamType: "schedule_negotiation",
          streamId: latest?.id ?? input.sessionId,
          streamVersion: latest?.offerVersion ?? 0,
          eventType: `schedule.negotiation_${plan.transition.reason}`,
          recordedAtUtc: input.nowUtc,
          payload: {
            actionKind: plan.actionKind,
            transition: plan.transition,
            negotiationId: latest?.id,
            offerVersion: latest?.offerVersion,
          },
          correlationId: input.command.clientMessageId,
          causationId: userMessage.id,
          idempotencyKey: `schedule-negotiation:${input.sessionId}:${input.command.clientMessageId}`,
        })
      ) {
        throw new Error("Schedule negotiation audit event was not inserted");
      }
      return;
    }
    if (
      this.options.scheduleNegotiationMode !== "shadow" ||
      plan === undefined
    ) {
      return;
    }
    if (
      !this.store.insertDomainEvent({
        agentId: input.command.agentId,
        streamType: "schedule_negotiation_shadow",
        streamId: input.sessionId,
        streamVersion: this.store.nextDomainEventStreamVersion(
          "schedule_negotiation_shadow",
          input.sessionId,
        ),
        eventType: "schedule.negotiation_shadow_evaluated",
        recordedAtUtc: input.nowUtc,
        payload: {
          actionKind: plan.actionKind,
          wouldCommit: plan.effect !== undefined,
          rejectionCodes: plan.rejections.map(
            (rejection) => rejection.reasonCode,
          ),
        },
        correlationId: input.command.clientMessageId,
        causationId: userMessage.id,
        idempotencyKey: `schedule-negotiation-shadow:${input.sessionId}:${input.command.clientMessageId}`,
      })
    ) {
      throw new Error("Schedule negotiation shadow event was not inserted");
    }
  }

  private persistScheduleCommand(
    input: Parameters<TurnCommitService["commit"]>[0],
    userMessage: StoredMessage,
    scheduleChanges: ScheduleItem[],
  ): void {
    const plan = input.world.negotiationPlan;
    if (
      this.options.scheduleNegotiationMode !== "enforced" ||
      scheduleChanges.length === 0 ||
      plan?.effect === undefined
    ) {
      return;
    }
    const negotiation = plan.updates.at(-1);
    if (
      !this.store.insertDomainEvent({
        agentId: input.command.agentId,
        streamType: "schedule",
        streamId: input.command.agentId,
        streamVersion: this.store.nextDomainEventStreamVersion(
          "schedule",
          input.command.agentId,
        ),
        eventType: "schedule.command_committed",
        recordedAtUtc: input.nowUtc,
        effectiveAtUtc: scheduleChanges[0]!.startAtUtc,
        payload: {
          negotiationId: negotiation?.id,
          offerVersion: negotiation?.offerVersion,
          operation: "create",
          changedItemIds: scheduleChanges.map((item) => item.id),
          policyVersion:
            typeof negotiation?.record["policyVersion"] === "number"
              ? negotiation.record["policyVersion"]
              : SCHEDULE_NEGOTIATION_POLICY_VERSION,
        },
        correlationId: input.command.clientMessageId,
        causationId: userMessage.id,
        idempotencyKey: `schedule-command:${negotiation?.id}:${negotiation?.offerVersion}`,
      })
    ) {
      throw new Error("Schedule command audit event was not inserted");
    }
  }

  private async commitContinuity(
    input: Parameters<TurnCommitService["commit"]>[0] & {
      userMessage: StoredMessage;
      assistantMessage: StoredMessage;
      memoryIds: string[];
    },
  ): Promise<void> {
    if (this.contexts === undefined) return;
    const rawEffects = input.turn.continuityEffects;
    const continuityEligible = worldEffectEligibilityForTurn({
      userMessage: input.userMessage.content,
    }).continuity;
    try {
      if (rawEffects !== undefined && !continuityEligible) {
        this.store.insertRejectedProposal({
          agentId: input.command.agentId,
          sessionId: input.sessionId,
          purpose: "continuity_turn",
          reasonCode: "continuity_effect_not_eligible_for_turn",
          reasonSummary:
            "The current user message contains no explicit follow-up or care-continuity signal.",
          raw: rawEffects,
          correlationId: input.command.clientMessageId,
          createdAtUtc: input.nowUtc,
        });
      }
      const continuity = await this.contexts.commitTurn({
        agentId: input.command.agentId,
        sessionId: input.sessionId,
        timezone: input.spec.identity.timezone,
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage,
        memoryIds: input.memoryIds,
        promptCueIds: input.preparedContext?.continuity.cueIds ?? [],
        ...(rawEffects === undefined || !continuityEligible
          ? {}
          : { rawEffects }),
      });
      if (continuity.rejections.length === 0) return;
      this.store.transaction(() => {
        for (const rejection of continuity.rejections) {
          this.store.insertRejectedProposal({
            agentId: input.command.agentId,
            sessionId: input.sessionId,
            purpose: "continuity_turn",
            reasonCode: rejection.reasonCode,
            reasonSummary: `${rejection.effect}: ${rejection.reasonSummary}`,
            raw: rejection.raw,
            correlationId: input.command.clientMessageId,
            createdAtUtc: input.nowUtc,
          });
        }
      });
    } catch (error) {
      this.store.insertRejectedProposal({
        agentId: input.command.agentId,
        sessionId: input.sessionId,
        purpose: "continuity_turn",
        reasonCode: "continuity_commit_failed",
        reasonSummary: error instanceof Error ? error.message : String(error),
        raw: input.turn.continuityEffects ?? null,
        correlationId: input.command.clientMessageId,
        createdAtUtc: input.nowUtc,
      });
    }
  }

  private async commitSplitContinuity(input: {
    input: CommitSplitInput;
    userMessage: StoredMessage;
    assistantMessage: StoredMessage;
    memoryIds: string[];
  }): Promise<void> {
    if (this.contexts === undefined) return;
    const turn = input.input;
    const rawEffects =
      turn.observation.proposal?.worldEffects.continuityEffects;
    const continuityEligible = worldEffectEligibilityForTurn({
      userMessage: input.userMessage.content,
    }).continuity;
    try {
      if (rawEffects !== undefined && !continuityEligible) {
        this.store.insertRejectedProposal({
          agentId: turn.command.agentId,
          sessionId: turn.sessionId,
          purpose: "continuity_turn",
          reasonCode: "continuity_effect_not_eligible_for_turn",
          reasonSummary:
            "The current user message contains no explicit follow-up or care-continuity signal.",
          raw: rawEffects,
          correlationId: turn.command.clientMessageId,
          createdAtUtc: turn.nowUtc,
        });
      }
      const continuity = await this.contexts.commitTurn({
        agentId: turn.command.agentId,
        sessionId: turn.sessionId,
        timezone: turn.spec.identity.timezone,
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage,
        memoryIds: input.memoryIds,
        promptCueIds: turn.preparedContext?.continuity.cueIds ?? [],
        ...(this.options.liveWorldEffectsMode !== "enforced" ||
        rawEffects === undefined ||
        !continuityEligible
          ? {}
          : { rawEffects }),
      });
      if (continuity.rejections.length === 0) return;
      this.store.transaction(() => {
        for (const rejection of continuity.rejections) {
          this.store.insertRejectedProposal({
            agentId: turn.command.agentId,
            sessionId: turn.sessionId,
            purpose: "continuity_turn",
            reasonCode: rejection.reasonCode,
            reasonSummary: `${rejection.effect}: ${rejection.reasonSummary}`,
            raw: null,
            correlationId: turn.command.clientMessageId,
            createdAtUtc: turn.nowUtc,
          });
        }
      });
    } catch (error) {
      this.store.insertRejectedProposal({
        agentId: turn.command.agentId,
        sessionId: turn.sessionId,
        purpose: "continuity_turn",
        reasonCode: "continuity_commit_failed",
        reasonSummary: error instanceof Error ? error.message : String(error),
        raw: null,
        correlationId: turn.command.clientMessageId,
        createdAtUtc: turn.nowUtc,
      });
    }
  }

  private publishSplit(input: {
    input: CommitSplitInput;
    assistantMessage: StoredMessage;
    scheduleChanges: ScheduleItem[];
  }): void {
    const turn = input.input;
    this.sse.publish({
      type: "message.created",
      agentId: turn.command.agentId,
      occurredAtUtc: turn.nowUtc,
      data: input.assistantMessage,
    });
    if (input.scheduleChanges.length > 0) {
      this.sse.publish({
        type: "schedule.updated",
        agentId: turn.command.agentId,
        occurredAtUtc: turn.nowUtc,
        data: input.scheduleChanges,
      });
    }
    if (turn.outcome.stateChanged) {
      this.sse.publish({
        type: "state.updated",
        agentId: turn.command.agentId,
        occurredAtUtc: turn.nowUtc,
        data: turn.outcome.nextState,
      });
    }
  }

  private reconcileCommittedMemories(input: {
    agentId: string;
    memoryIds: readonly string[];
    correlationId: string;
    causationId: string;
  }): void {
    if (input.memoryIds.length === 0) return;
    if (this.memoryLifecycle === undefined) {
      throw new Error(
        "Memory lifecycle reconciliation is required for committed memories",
      );
    }
    this.memoryLifecycle.reconcileNewMemories(input.agentId, input.memoryIds, {
      correlationId: input.correlationId,
      causationId: input.causationId,
    });
  }

  private publish(input: {
    command: ChatTurnCommand;
    nowUtc: string;
    assistantMessage: StoredMessage;
    scheduleChanges: ScheduleItem[];
    world: PreparedWorldEffectTurn;
  }): void {
    this.sse.publish({
      type: "message.created",
      agentId: input.command.agentId,
      occurredAtUtc: input.nowUtc,
      data: input.assistantMessage,
    });
    if (input.scheduleChanges.length > 0) {
      this.sse.publish({
        type: "schedule.updated",
        agentId: input.command.agentId,
        occurredAtUtc: input.nowUtc,
        data: input.scheduleChanges,
      });
    }
    if (input.world.stateChanged) {
      this.sse.publish({
        type: "state.updated",
        agentId: input.command.agentId,
        occurredAtUtc: input.nowUtc,
        data: input.world.nextState,
      });
    }
  }
}

function safeSplitRejection(
  rejection: SplitTurnProposalRejection,
): SplitTurnProposalRejection {
  return {
    reasonCode: rejection.reasonCode.slice(0, 160),
    reasonSummary: rejection.reasonSummary.slice(0, 1_000),
    ...(rejection.field === undefined
      ? {}
      : { field: rejection.field.slice(0, 160) }),
  };
}

function splitDeliveryMode(
  reply: MaterializedPersonaReply,
): "single_block" | "sequential" {
  return reply.chunks.length > 1 ? "sequential" : "single_block";
}

function acceptedSplitEffectKinds(outcome: ValidatedTurnOutcome): string[] {
  const kinds: string[] = [];
  if (outcome.acceptedWorldEffects.stateDelta !== undefined) {
    kinds.push("state_delta");
  }
  if (outcome.acceptedWorldEffects.relationshipDelta !== undefined) {
    kinds.push("relationship_delta");
  }
  if (outcome.acceptedWorldEffects.memoryCandidates.length > 0) {
    kinds.push("memory_candidate");
  }
  if (outcome.acceptedWorldEffects.personalIntentCandidates.length > 0) {
    kinds.push("personal_intent_candidate");
  }
  if (
    outcome.scheduleOutcome.kind === "needs_clarification" ||
    outcome.scheduleOutcome.kind === "pending_confirmation" ||
    outcome.scheduleOutcome.kind === "committed" ||
    outcome.scheduleOutcome.kind === "declined"
  ) {
    kinds.push("schedule_negotiation");
  }
  return kinds;
}

function hasAcceptedSplitWorldEffects(outcome: ValidatedTurnOutcome): boolean {
  const effects = outcome.acceptedWorldEffects;
  return (
    effects.stateDelta !== undefined ||
    effects.relationshipDelta !== undefined ||
    effects.memoryCandidates.length > 0 ||
    effects.personalIntentCandidates.length > 0
  );
}

function splitWorldEffectsApplied(
  outcome: ValidatedTurnOutcome,
  applied: {
    memoryIds: readonly string[];
    personalIntentIds: readonly string[];
  },
): boolean {
  return (
    outcome.worldEffectWritesEnabled &&
    (outcome.stateChanged ||
      applied.memoryIds.length > 0 ||
      applied.personalIntentIds.length > 0)
  );
}

function elapsedMilliseconds(startedAtMs: number): number {
  if (!Number.isFinite(startedAtMs)) return 0;
  return Math.max(0, Math.round(performance.now() - startedAtMs));
}

function splitReasonSummary(outcome: ValidatedTurnOutcome): string {
  switch (outcome.scheduleOutcome.kind) {
    case "read_only":
      return "Answered from the server-owned schedule snapshot.";
    case "needs_clarification":
      return "The server requires more schedule details before any write.";
    case "pending_confirmation":
      return "The server prepared a versioned offer awaiting confirmation.";
    case "committed":
      return "The server validated a confirmed schedule command before reply generation.";
    case "declined":
      return "The server declined the active schedule offer before reply generation.";
    case "rejected":
      return "The server rejected an unauthorized or invalid schedule mutation.";
    case "none":
      return outcome.observation.origin === "fallback"
        ? "Structured understanding was unavailable, so the server committed a safe no-op outcome with a natural reply."
        : "The server validated a reply-only turn before reply generation.";
  }
}

function materializeScheduleOutcome(
  outcome: ValidatedTurnOutcome,
  scheduleChanges: readonly ScheduleItem[],
): ValidatedTurnOutcome["scheduleOutcome"] {
  return outcome.scheduleOutcome.kind === "committed"
    ? {
        ...outcome.scheduleOutcome,
        scheduleItemIds: scheduleChanges.map((item) => item.id),
      }
    : outcome.scheduleOutcome;
}

function assertRetrievalRunMatches(input: CommitSplitInput): void {
  if (
    input.retrievalRun !== undefined &&
    (input.retrievalRun.agentId !== input.command.agentId ||
      input.retrievalRun.inputSnapshot.agentId !== input.command.agentId)
  ) {
    throw new TypeError(
      "Prepared retrieval run agent must match the chat turn agent",
    );
  }
}

function assertPreparedSplitRuntimeState(input: CommitSplitInput): void {
  if (input.outcome.nextState.agentId !== input.command.agentId) {
    throw new TypeError(
      "Prepared runtime state agent must match the chat turn agent",
    );
  }
  const expectedNextRevision =
    input.expectedStateRevision +
    (input.outcome.worldEffectWritesEnabled && input.outcome.stateChanged
      ? 1
      : 0);
  if (input.outcome.nextState.revision !== expectedNextRevision) {
    throw new TypeError(
      "Prepared runtime state revision must match the split turn CAS expectation",
    );
  }
}

function staleRuntimeState(): ApiError {
  return new ApiError(
    409,
    "runtime_state_revision_conflict",
    "Runtime state changed before the turn could be committed.",
  );
}

function safeContextPlanTrace(plan: ContextPlan): Record<string, unknown> {
  return {
    schemaVersion: plan.schemaVersion,
    activatedTraitIds: plan.activatedTraitIds,
    activatedValueIds: plan.activatedValueIds,
    activatedContradictionIds: plan.activatedContradictionIds,
    activatedGoalIds: plan.activatedGoalIds,
    activatedPreferenceIds: plan.activatedPreferenceIds,
    suppressedGoalIds: plan.suppressedGoalIds,
    includeAutobiography: plan.includeAutobiography,
    includeCalendar: plan.includeCalendar,
    includeFutureSchedule: plan.includeFutureSchedule,
    includeRetrievedEvidence: plan.includeRetrievedEvidence,
    topicFatigue: plan.topicFatigue,
    trace: plan.trace,
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim() !== ""))];
}

class DuplicateTurnError extends Error {
  constructor(
    readonly turn: {
      userMessage: StoredMessage;
      assistantMessage?: StoredMessage;
    },
  ) {
    super("Duplicate chat turn");
  }
}

const RECOVERABLE_CHAT_INTENT_REJECTION_CODES = new Set([
  "missing_user_message",
  "invalid_message_ref",
  "missing_evidence_quote",
  "meaningless_evidence_quote",
  "ungrounded_evidence_quote",
]);

function isRecoverableChatIntentRejection(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.statusCode === 422 &&
    RECOVERABLE_CHAT_INTENT_REJECTION_CODES.has(error.code)
  );
}

function assertIdempotentTurnMatches(
  storedUserMessage: StoredMessage,
  requestedText: string,
): void {
  if (storedUserMessage.content === requestedText) return;
  throw new ApiError(
    409,
    "idempotency_key_reused",
    "The client message id was already used with different content.",
  );
}

function replayResult(
  turn: { userMessage: StoredMessage; assistantMessage: StoredMessage },
  state: RuntimeState,
): ChatTurnResult {
  const memoryRecall = readMemoryRecallDiagnostic(
    turn.assistantMessage.metadata,
  );
  return {
    idempotentReplay: true,
    userMessage: turn.userMessage,
    assistantMessage: turn.assistantMessage,
    scheduleChanges: [],
    state,
    ...(memoryRecall === undefined ? {} : { memoryRecall }),
    decision: {
      reasonCode: metadataText(
        turn.assistantMessage.metadata,
        "reasonCode",
        "idempotent_replay",
      ),
      reasonSummary: metadataText(
        turn.assistantMessage.metadata,
        "reasonSummary",
        "Replayed stored turn.",
      ),
      toneTags: Array.isArray(turn.assistantMessage.metadata.toneTags)
        ? (turn.assistantMessage.metadata.toneTags as string[])
        : [],
      deliveryMode: metadataDeliveryMode(turn.assistantMessage.metadata),
      chunks: metadataChunks(
        turn.assistantMessage.metadata,
        turn.assistantMessage.content,
      ),
    },
  };
}

export function buildMemoryRecallDiagnostic(
  mode: "legacy" | "shadow" | "enforced",
  legacyMemories: readonly { id: string }[],
  promptMemories: readonly { id: string }[],
  preview: MemoryRecallPreview,
): MemoryRecallRuntimeDiagnostic {
  const result = preview.result;
  return MemoryRecallRuntimeDiagnosticSchema.parse({
    rolloutMode: mode,
    promptStrategy: mode === "enforced" ? "evidence_selected" : "legacy_active",
    legacyPromptMemoryIds: legacyMemories
      .slice(0, 12)
      .map((memory) => memory.id),
    promptMemoryIds: promptMemories.slice(0, 12).map((memory) => memory.id),
    selectedMemoryIds: result.selectedMemoryIds,
    selectedEvidenceIds: result.selectedEvidenceIds,
    rejectedMemoryIds: preview.candidates
      .filter((candidate) => !candidate.selected)
      .map((candidate) => candidate.memoryId),
    recallMode: result.mode,
    score: result.score,
    abstained: result.abstained,
    ...(result.abstained ? { abstentionReason: result.abstentionReason } : {}),
    durationMs: preview.timing.durationMs,
  });
}

function readMemoryRecallDiagnostic(
  metadata: Record<string, unknown>,
): MemoryRecallRuntimeDiagnostic | undefined {
  const parsed = MemoryRecallRuntimeDiagnosticSchema.safeParse(
    metadata.memoryRecall,
  );
  return parsed.success ? parsed.data : undefined;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return undefined;
}

function metadataText(
  metadata: Record<string, unknown>,
  key: string,
  fallback: string,
): string {
  return optionalText(metadata[key]) ?? fallback;
}

function metadataChunks(
  metadata: Record<string, unknown>,
  fallbackText?: string,
): string[] {
  const value = metadata.chunks;
  const chunks = Array.isArray(value)
    ? value.filter(
        (chunk): chunk is string =>
          typeof chunk === "string" && chunk.trim().length > 0,
      )
    : [];
  if (chunks.length > 0) return chunks;
  return fallbackText === undefined || fallbackText.trim() === ""
    ? []
    : [fallbackText];
}

function metadataDeliveryMode(
  metadata: Record<string, unknown>,
): "single_block" | "sequential" {
  if (
    metadata.deliveryMode === "single_block" ||
    metadata.deliveryMode === "sequential"
  ) {
    return metadata.deliveryMode;
  }
  return metadataChunks(metadata).length > 1 ? "sequential" : "single_block";
}
