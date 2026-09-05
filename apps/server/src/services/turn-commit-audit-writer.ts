import type { DatabaseStore, StoredMessage } from "../db/store.js";
import { ApiError } from "../domain/errors.js";
import type { ScheduleItem } from "../domain/schemas.js";
import type { ConversationLifeImpact } from "./fuzzy-life-service.js";
import { SCHEDULE_NEGOTIATION_POLICY_VERSION } from "./schedule-negotiation-service.js";
import type {
  TurnCommitInput,
  TurnCommitServiceOptions,
} from "./turn-commit-types.js";

/**
 * Writes the durable audit records owned by a chat turn. Callers keep control
 * of the surrounding DatabaseStore transaction, so all records remain atomic
 * with messages, state changes, memories, and schedule effects.
 */
export class TurnCommitAuditWriter {
  constructor(
    private readonly store: DatabaseStore,
    private readonly options: TurnCommitServiceOptions,
  ) {}

  persistRecallAudit(input: TurnCommitInput, userMessage: StoredMessage): void {
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

  persistWorldEffectsAudit(
    input: TurnCommitInput,
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
            input.turn.explicitFactReplyGuardAudit !== undefined ||
            input.turn.consentModalityGuardAudit?.modelSideEffectsBlocked ===
              true ||
            input.turn.consentModalityGuardAudit
              ?.contentDerivedSemanticsSkipped === true
              ? "blocked"
              : input.world.effectTrace.mode === "enforced"
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

  persistNegotiation(input: TurnCommitInput, userMessage: StoredMessage): void {
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

  persistScheduleCommand(
    input: TurnCommitInput,
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

  persistConversationTurn(input: {
    turn: TurnCommitInput;
    userMessage: StoredMessage;
    assistantMessage: StoredMessage;
    scheduleChanges: ScheduleItem[];
    memoryIds: string[];
    personalIntentIds: string[];
    lifeImpact?: ConversationLifeImpact;
  }): void {
    if (
      !this.store.insertDomainEvent({
        agentId: input.turn.command.agentId,
        streamType: "conversation",
        streamId: input.turn.sessionId,
        streamVersion: input.turn.world.nextState.revision,
        eventType: "conversation.turn_committed",
        recordedAtUtc: input.turn.nowUtc,
        payload: {
          userMessageId: input.userMessage.id,
          assistantMessageId: input.assistantMessage.id,
          scheduleItemIds: input.scheduleChanges.map((item) => item.id),
          memoryIds: input.memoryIds,
          reasonCode: input.turn.world.decision.reasonCode,
          personalIntentIds: input.personalIntentIds,
          ...(input.turn.turn.explicitFactReplyGuardAudit === undefined
            ? {}
            : {
                explicitFactReplyGuard:
                  input.turn.turn.explicitFactReplyGuardAudit,
              }),
          ...(input.turn.turn.consentModalityGuardAudit === undefined
            ? {}
            : {
                consentModalityGuard: input.turn.turn.consentModalityGuardAudit,
              }),
          ...(input.lifeImpact === undefined
            ? {}
            : { lifeImpact: input.lifeImpact }),
        },
        correlationId: input.turn.command.clientMessageId,
        causationId: input.userMessage.id,
        idempotencyKey: `chat:${input.turn.sessionId}:${input.turn.command.clientMessageId}`,
      })
    ) {
      throw new Error("Conversation turn audit event was not inserted");
    }
  }
}
