import type { DatabaseStore, StoredMessage } from "../db/store.js";
import { ApiError, notFound } from "../domain/errors.js";
import type { ScheduleItem } from "../domain/schemas.js";
import { RetrievalRunRepository } from "../repositories/retrieval-run-repository.js";
import type { SseHub } from "../sse/hub.js";
import type { ConversationContextService } from "./conversation-context-service.js";
import type {
  ConversationLifeImpact,
  FuzzyLifeService,
} from "./fuzzy-life-service.js";
import { validateMergeAndPersistMemories } from "./memory-service.js";
import type { MemoryReconciliationResult } from "./memory-lifecycle-service.js";
import type { PersonalIntentService } from "./personal-intent-service.js";
import type { ScheduleService } from "./schedule-service.js";
import { deliveryModeForDecision } from "./turn-decision-service.js";
import { TurnCommitAuditWriter } from "./turn-commit-audit-writer.js";
import { TurnCommitPublisher } from "./turn-commit-publisher.js";
import {
  assertIdempotentTurnMatches,
  replayTurnResult,
} from "./turn-commit-result.js";
import type {
  ChatTurnCommand,
  ChatTurnResult,
  TurnCommitInput,
  TurnCommitServiceOptions,
} from "./turn-commit-types.js";
import type { TurnProposalRejection } from "./world-effect-service.js";

export { buildMemoryRecallDiagnostic } from "./turn-commit-result.js";
export type {
  ChatTurnCommand,
  ChatTurnResult,
  TurnCommitInput,
  TurnCommitServiceOptions,
} from "./turn-commit-types.js";

/**
 * Owns the single durable chat transaction plus post-commit continuity and SSE
 * publication. Provider/network work is completed before this boundary.
 */
export class TurnCommitService {
  private readonly retrievalRuns: RetrievalRunRepository;
  private readonly audits: TurnCommitAuditWriter;
  private readonly publisher: TurnCommitPublisher;

  constructor(
    private readonly store: DatabaseStore,
    private readonly schedules: ScheduleService,
    private readonly personalIntents: PersonalIntentService,
    sse: SseHub,
    private readonly contexts?: ConversationContextService,
    private readonly options: TurnCommitServiceOptions = {},
    private readonly fuzzyLife?: FuzzyLifeService,
  ) {
    this.retrievalRuns = new RetrievalRunRepository(store.database);
    this.audits = new TurnCommitAuditWriter(store, options);
    this.publisher = new TurnCommitPublisher(sse);
  }

  replay(input: {
    turn: { userMessage: StoredMessage; assistantMessage: StoredMessage };
    command: ChatTurnCommand;
  }): ChatTurnResult {
    assertIdempotentTurnMatches(input.turn.userMessage, input.command.text);
    const state = this.store.getRuntimeState(input.command.agentId);
    if (!state) throw notFound("Character state");
    return replayTurnResult(input.turn, state);
  }

  async commit(input: TurnCommitInput): Promise<ChatTurnResult> {
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
        ...(input.turn.explicitFactReplyGuardAudit === undefined
          ? {}
          : {
              explicitFactReplyGuard: input.turn.explicitFactReplyGuardAudit,
            }),
        ...(input.turn.consentModalityGuardAudit === undefined
          ? {}
          : {
              consentModalityGuard: input.turn.consentModalityGuardAudit,
            }),
        ...(input.recallDiagnostic === undefined
          ? {}
          : { memoryRecall: input.recallDiagnostic }),
        promptSegmentTrace: input.promptSegmentTrace,
        ...(input.companionContextDiagnostic === undefined
          ? {}
          : { companionContext: input.companionContextDiagnostic }),
        ...(input.preparedContext === undefined
          ? {}
          : {
              temporalQueryResolution: input.preparedContext.temporalResolution,
              continuityPromptCueIds: input.preparedContext.continuity.cueIds,
            }),
      },
      createdAtUtc: input.nowUtc,
    };

    const fuzzyLifeEnabled = this.options.lifePlanningMode === "fuzzy";
    const contentDerivedSemanticsAllowed =
      input.turn.explicitFactReplyGuardAudit === undefined &&
      input.turn.consentModalityGuardAudit?.contentDerivedSemanticsSkipped !==
        true;
    let effectsToApply = fuzzyLifeEnabled
      ? []
      : input.world.validation.accepted;
    let scheduleChanges: ScheduleItem[] = [];
    let memoryIds: string[] = [];
    let memoryReconciliations: MemoryReconciliationResult[] = [];
    let personalIntentIds: string[] = [];
    let lifeImpact: ConversationLifeImpact | undefined;
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
        this.audits.persistRecallAudit(input, userMessage);
        personalIntentIds = fuzzyLifeEnabled
          ? []
          : this.persistPersonalIntents(
              input,
              userMessage,
              input.world.proposalRejections,
            );
        this.audits.persistWorldEffectsAudit(input, userMessage);
        if (!fuzzyLifeEnabled) {
          this.audits.persistNegotiation(input, userMessage);
          scheduleChanges = this.schedules.applyValidatedEffects(
            input.command.agentId,
            effectsToApply,
            input.nowUtc,
          );
          this.audits.persistScheduleCommand(
            input,
            userMessage,
            scheduleChanges,
          );
        }
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
        memoryReconciliations =
          this.contexts?.reconcileMemories(input.command.agentId, memoryIds) ??
          [];
        this.store.insertMessage(assistantMessage);
        if (fuzzyLifeEnabled && contentDerivedSemanticsAllowed) {
          if (this.fuzzyLife === undefined) {
            throw new Error(
              "Fuzzy life mode requires a composed FuzzyLifeService.",
            );
          }
          const semanticMessages = contentDerivedMessages(
            input,
            userMessage,
            assistantMessage,
          );
          lifeImpact = this.fuzzyLife.recordConversationTurn({
            agentId: input.command.agentId,
            sessionId: input.sessionId,
            userMessageId: userMessage.id,
            assistantMessageId: assistantMessage.id,
            userText: semanticMessages.userMessage.content,
            assistantText: semanticMessages.assistantMessage.content,
            recordedAtUtc: input.nowUtc,
            correlationId: input.command.clientMessageId,
          });
        }
        this.audits.persistConversationTurn({
          turn: input,
          userMessage,
          assistantMessage,
          scheduleChanges,
          memoryIds,
          personalIntentIds,
          ...(lifeImpact === undefined ? {} : { lifeImpact }),
        });
      });
    } catch (error) {
      if (error instanceof DuplicateTurnError) {
        const stored = error.turn;
        if (!stored.assistantMessage) throw error;
        assertIdempotentTurnMatches(stored.userMessage, input.command.text);
        return replayTurnResult(
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
      memoryReconciliations,
    });
    this.publisher.publish({
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

  private persistPersonalIntents(
    input: TurnCommitInput,
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

  private async commitContinuity(
    input: TurnCommitInput & {
      userMessage: StoredMessage;
      assistantMessage: StoredMessage;
      memoryIds: string[];
      memoryReconciliations: MemoryReconciliationResult[];
    },
  ): Promise<void> {
    if (
      this.contexts === undefined ||
      input.turn.explicitFactReplyGuardAudit !== undefined ||
      input.turn.consentModalityGuardAudit?.contentDerivedSemanticsSkipped ===
        true
    ) {
      return;
    }
    try {
      const semanticMessages = contentDerivedMessages(
        input,
        input.userMessage,
        input.assistantMessage,
      );
      const continuity = await this.contexts.commitTurn({
        agentId: input.command.agentId,
        sessionId: input.sessionId,
        timezone: input.spec.identity.timezone,
        ...semanticMessages,
        memoryIds: input.memoryIds,
        preReconciled: input.memoryReconciliations,
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
}

/** Persist original messages; only derived semantics use the audited slice.
 * Both life records and continuity must see the same facts and message IDs. */
function contentDerivedMessages(
  input: TurnCommitInput,
  userMessage: StoredMessage,
  assistantMessage: StoredMessage,
): { userMessage: StoredMessage; assistantMessage: StoredMessage } {
  const audit = input.turn.consentModalityGuardAudit;
  if (audit === undefined) return { userMessage, assistantMessage };
  return {
    userMessage: { ...userMessage, content: audit.independentText.trim() },
    assistantMessage: {
      ...assistantMessage,
      content: audit.independentReplyText.trim(),
    },
  };
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
