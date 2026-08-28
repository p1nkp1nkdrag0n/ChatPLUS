import {
  MemoryRecallRuntimeDiagnosticSchema,
  type MemoryRecallRuntimeDiagnostic,
} from "@personasim/contracts";

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
import { validateMergeAndPersistMemories } from "./memory-service.js";
import type { PersonalIntentService } from "./personal-intent-service.js";
import type { ScheduleService } from "./schedule-service.js";
import { SCHEDULE_NEGOTIATION_POLICY_VERSION } from "./schedule-negotiation-service.js";
import {
  deliveryModeForDecision,
  type ResolvedTurn,
} from "./turn-decision-service.js";
import type {
  PreparedWorldEffectTurn,
  TurnProposalRejection,
} from "./world-effect-service.js";

export interface TurnCommitServiceOptions {
  scheduleNegotiationMode?: "legacy" | "shadow" | "enforced";
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
    userMessageId: string;
    retrievalRun?: CreateRetrievalRunInput;
    assistantMessageId: string;
    capabilities: SimulationCapabilities;
    recallDiagnostic?: MemoryRecallRuntimeDiagnostic;
    promptSegmentTrace: unknown;
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
      metadata: {},
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
    try {
      this.store.transaction(() => {
        const duplicate = this.store.findTurnByClientMessageId(
          input.sessionId,
          input.command.clientMessageId,
        );
        if (duplicate) throw new DuplicateTurnError(duplicate);
        const currentState = this.store.getRuntimeState(input.command.agentId);
        if (
          currentState === undefined ||
          currentState.revision !==
            input.world.effectTrace.expectedStateRevision
        ) {
          throw new ApiError(
            409,
            "stale_runtime_state",
            "Runtime state changed before this turn could be committed.",
          );
        }
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
          if (
            !this.store.compareAndSetRuntimeState(
              input.world.nextState,
              input.world.effectTrace.expectedStateRevision,
            )
          ) {
            throw new ApiError(
              409,
              "stale_runtime_state",
              "Runtime state changed before this turn could be committed.",
            );
          }
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
        this.store.insertMessage(assistantMessage);
        if (
          !this.store.insertDomainEvent({
            agentId: input.command.agentId,
            streamType: "conversation",
            streamId: input.sessionId,
            streamVersion: input.world.nextState.revision,
            eventType: "conversation.turn_committed",
            recordedAtUtc: input.nowUtc,
            payload: {
              userMessageId: userMessage.id,
              assistantMessageId: assistantMessage.id,
              scheduleItemIds: scheduleChanges.map((item) => item.id),
              memoryIds,
              reasonCode: input.world.decision.reasonCode,
              personalIntentIds,
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
        streamVersion: input.world.nextState.revision,
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
    const accepted = input.world.effectTrace.accepted;
    const acceptedModelEffects =
      input.turn.worldEffectsAudit?.validation.effects;
    if (
      !this.store.insertDomainEvent({
        agentId: input.command.agentId,
        streamType: "world_effects",
        streamId: input.sessionId,
        streamVersion: input.world.nextState.revision,
        eventType:
          input.world.effectTrace.mode === "shadow"
            ? "conversation.world_effects_shadow_evaluated"
            : "conversation.world_effects_committed",
        recordedAtUtc: input.nowUtc,
        effectiveAtUtc:
          input.world.effectTrace.actual.after.relationship
            .lastInteractionAtUtc ??
          input.world.effectTrace.actual.after.asOfUtc,
        payload: {
          schemaVersion: input.world.effectTrace.schemaVersion,
          mode: input.world.effectTrace.mode,
          interactionStatus: "committed",
          llmProposalStatus:
            input.world.effectTrace.mode === "enforced"
              ? "committed"
              : input.world.effectTrace.mode,
          source: input.world.effectTrace.sources,
          expectedStateRevision: input.world.effectTrace.expectedStateRevision,
          proposed: input.world.effectTrace.proposed,
          acceptedDelta: {
            ...(accepted.stateDelta === undefined
              ? {}
              : { stateDelta: accepted.stateDelta }),
            ...(accepted.relationshipDelta === undefined
              ? {}
              : { relationshipDelta: accepted.relationshipDelta }),
          },
          // Preserve the compact rollout-era summary for existing timeline
          // consumers while retaining the numeric accepted deltas above.
          accepted: {
            stateDelta: accepted.stateDelta !== undefined,
            relationshipDelta: accepted.relationshipDelta !== undefined,
            memoryCandidateCount:
              acceptedModelEffects?.memoryCandidates.length ?? 0,
            personalIntentCandidateCount:
              input.world.decision.personalIntentCandidates?.length ?? 0,
          },
          applied: input.world.effectTrace.actual.applied,
          before: input.world.effectTrace.actual.before,
          after: input.world.effectTrace.actual.after,
          relationship: {
            baselineDelta:
              input.world.effectTrace.actual.relationship.baselineDelta,
            proposedDelta:
              input.world.effectTrace.actual.relationship.proposedDelta,
            acceptedProposalDelta:
              input.world.effectTrace.actual.relationship.acceptedProposalDelta,
            appliedProposalDelta:
              input.world.effectTrace.actual.relationship.appliedProposalDelta,
            dailyUsageApplied: input.world.effectTrace.actual.dailyUsageApplied,
            dailyUsageBefore: input.world.effectTrace.actual.dailyUsageBefore,
            dailyUsageAfter: input.world.effectTrace.actual.dailyUsageAfter,
            capabilityScale: input.capabilities.relationshipDeltaScale,
            limitsApplied:
              input.world.effectTrace.actual.relationship.limitsApplied,
            valence: input.world.effectTrace.actual.relationship.valence,
          },
          ...(input.world.effectTrace.wouldApply === undefined
            ? {}
            : { wouldApply: input.world.effectTrace.wouldApply }),
          rejections:
            input.turn.worldEffectsAudit?.validation.rejections.map(
              (rejection) => ({
                effect: rejection.effect,
                ...(rejection.index === undefined
                  ? {}
                  : { index: rejection.index }),
                ...(rejection.field === undefined
                  ? {}
                  : { field: rejection.field }),
                reasonCode: rejection.reasonCode,
                reasonSummary: rejection.reasonSummary,
                raw: rejection.raw,
              }),
            ) ?? [],
          rejectionCodes: input.world.effectTrace.rejectionCodes,
          limitsApplied: input.world.effectTrace.validationLimitsApplied,
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
        streamVersion: input.world.nextState.revision,
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
        streamVersion: Math.max(
          ...scheduleChanges.map((item) => item.revision),
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
    try {
      const continuity = await this.contexts.commitTurn({
        agentId: input.command.agentId,
        sessionId: input.sessionId,
        timezone: input.spec.identity.timezone,
        userMessage: input.userMessage,
        assistantMessage: input.assistantMessage,
        memoryIds: input.memoryIds,
        promptCueIds: input.preparedContext?.continuity.cueIds ?? [],
        ...(input.turn.continuityEffects === undefined
          ? {}
          : { rawEffects: input.turn.continuityEffects }),
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
