import { DateTime } from "luxon";
import {
  MemoryCandidateSchema,
  PersonaChatDecisionSchema,
  PersonaChatResponseSchema,
  ScheduleEffectProposalSchema,
  type MemoryCandidate,
  type PersonaChatDecision,
  type PersonaChatResponse,
  type ScheduleNegotiationAction,
} from "@personasim/contracts";
import {
  applyRelationshipDelta,
  assembleChatPrompt,
  createSafeFallbackReply,
  guardPersonaReply,
  hasScheduleIntent,
  normalizeModelEffects,
  type ModelEffectRejection,
  type ReplyStrategy,
} from "@personasim/features";

import type {
  DatabaseStore,
  StoredMessage,
  StoredSession,
} from "../db/store.js";
import {
  capabilitiesForTier,
  type SimulationCapabilities,
} from "../domain/capabilities.js";
import { ApiError, notFound } from "../domain/errors.js";
import { createEntityId } from "../domain/id.js";
import {
  agentTurnDecisionSchema,
  chatMessageInputSchema,
  type AgentTurnDecision,
  type CharacterSpec,
  type RuntimeState,
  type ScheduleEffectProposal,
  type ScheduleItem,
  type StateDelta,
} from "../domain/schemas.js";
import type { Clock } from "../runtime/clock.js";
import type { SseHub } from "../sse/hub.js";
import {
  toFeatureScheduleEffects,
  toFeatureScheduleItems,
  toFeatureState,
} from "../domain/feature-adapters.js";
import type { LlmService } from "./llm-service.js";
import {
  readActiveMemories,
  validateMergeAndPersistMemories,
} from "./memory-service.js";
import type {
  PartialProposalValidation,
  ScheduleService,
} from "./schedule-service.js";
import type { SettlementService } from "./settlement-service.js";
import {
  buildScheduleNegotiationContract,
  ScheduleNegotiationService,
  type ActiveScheduleNegotiation,
  type PreparedScheduleNegotiation,
} from "./schedule-negotiation-service.js";

export type ChatTurnDecisionPath =
  "full" | "partial" | "effects_rejected" | "reply_only" | "fallback";

export interface ConversationServiceOptions {
  /**
   * "gated" (default) allows the live model to propose schedule effects only
   * for high-fidelity characters when the turn shows schedule intent.
   * "off" restores the pure reply-only live path everywhere.
   */
  chatEffectsMode?: "off" | "gated";
  /**
   * Keeps rollout reversible. Legacy effects and server-owned negotiation
   * commands are never allowed to write in the same turn.
   */
  scheduleNegotiationMode?: "legacy" | "shadow" | "enforced";
}

export type ChatTurnResult = {
  idempotentReplay: boolean;
  userMessage: StoredMessage;
  assistantMessage: StoredMessage;
  scheduleChanges: ScheduleItem[];
  state: RuntimeState;
  decision: {
    reasonCode: string;
    reasonSummary: string;
    toneTags: string[];
    deliveryMode: "single_block" | "sequential";
    chunks: string[];
  };
};

export class ConversationService {
  private readonly scheduleNegotiations: ScheduleNegotiationService;

  constructor(
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly llm: LlmService,
    private readonly schedules: ScheduleService,
    private readonly settlements: SettlementService,
    private readonly sse: SseHub,
    private readonly options: ConversationServiceOptions = {},
  ) {
    this.scheduleNegotiations = new ScheduleNegotiationService(
      store,
      schedules,
    );
  }

  listSessions(agentId: string): StoredSession[] {
    if (!this.store.getCharacterSummary(agentId)) throw notFound("Character");
    return this.store.listSessions(agentId);
  }

  createSession(agentId: string, title?: string): StoredSession {
    const spec = this.store.getCharacterSpec(agentId);
    if (!spec) throw notFound("Character");
    return this.store.createSession(
      agentId,
      title?.trim() || `与${spec.identity.name}的对话`,
      this.clock.nowUtc(),
    );
  }

  listMessages(sessionId: string, limit = 100): StoredMessage[] {
    if (!this.store.getSession(sessionId)) throw notFound("Session");
    return this.store.listMessages(
      sessionId,
      Math.max(1, Math.min(limit, 500)),
    );
  }

  async chat(sessionId: string, rawInput: unknown): Promise<ChatTurnResult> {
    const input = chatMessageInputSchema.parse(rawInput);
    const session = this.store.getSession(sessionId);
    if (!session) throw notFound("Session");
    if (session.agentId !== input.agentId) {
      throw new ApiError(
        409,
        "session_agent_mismatch",
        "The session does not belong to this character.",
      );
    }
    const existing = this.store.findTurnByClientMessageId(
      sessionId,
      input.clientMessageId,
    );
    if (existing?.assistantMessage) {
      assertIdempotentTurnMatches(existing.userMessage, input.text);
      const state = this.store.getRuntimeState(input.agentId);
      if (!state) throw notFound("Character state");
      return {
        idempotentReplay: true,
        userMessage: existing.userMessage,
        assistantMessage: existing.assistantMessage,
        scheduleChanges: [],
        state,
        decision: {
          reasonCode: metadataText(
            existing.assistantMessage.metadata,
            "reasonCode",
            "idempotent_replay",
          ),
          reasonSummary: metadataText(
            existing.assistantMessage.metadata,
            "reasonSummary",
            "Replayed stored turn.",
          ),
          toneTags: Array.isArray(existing.assistantMessage.metadata.toneTags)
            ? (existing.assistantMessage.metadata.toneTags as string[])
            : [],
          deliveryMode: metadataDeliveryMode(
            existing.assistantMessage.metadata,
          ),
          chunks: metadataChunks(
            existing.assistantMessage.metadata,
            existing.assistantMessage.content,
          ),
        },
      };
    }

    await this.settlements.settleAndExtend(input.agentId);
    const spec = this.store.getCharacterSpec(input.agentId);
    const state = this.store.getRuntimeState(input.agentId);
    if (!spec || !state) throw notFound("Character");
    if (spec.status !== "published") {
      throw new ApiError(
        409,
        "character_not_published",
        "Publish the character before chatting.",
      );
    }
    const nowUtc = this.clock.nowUtc();
    const userMessageId = createEntityId("message");
    const assistantMessageId = createEntityId("message");
    const capabilities = capabilitiesForTier(spec.tier);
    const schedule = capabilities.schedule
      ? this.store.listSchedule(input.agentId, {
          fromUtc: nowUtc,
          toUtc: DateTime.fromISO(nowUtc).plus({ hours: 72 }).toUTC().toISO()!,
        })
      : [];
    const memories = capabilities.longTermMemory
      ? readActiveMemories(this.store, input.agentId, nowUtc)
      : [];
    const recentMessages = this.store.listMessages(sessionId, 30);
    const scheduleNegotiationEligible =
      this.options.scheduleNegotiationMode !== undefined &&
      this.options.scheduleNegotiationMode !== "legacy" &&
      this.options.chatEffectsMode !== "off" &&
      capabilities.schedule &&
      spec.tier === "high_fidelity" &&
      spec.schedulePolicy.enabled &&
      this.llm.providerName !== "fixture";
    const negotiationEnforced =
      this.options.scheduleNegotiationMode === "enforced" &&
      this.options.chatEffectsMode !== "off" &&
      capabilities.schedule &&
      spec.tier === "high_fidelity" &&
      spec.schedulePolicy.enabled;
    const activeNegotiation = scheduleNegotiationEligible
      ? this.scheduleNegotiations.getActive(sessionId, nowUtc)
      : undefined;
    const effectsEligible =
      !negotiationEnforced &&
      this.options.chatEffectsMode !== "off" &&
      capabilities.schedule &&
      spec.tier === "high_fidelity" &&
      spec.schedulePolicy.enabled &&
      hasScheduleIntent(input.text);
    const rawFixture = fixtureDecision(spec, schedule, input.text, nowUtc);
    const fixture =
      (this.options.chatEffectsMode === "off" || negotiationEnforced) &&
      rawFixture.scheduleEffects.length > 0
        ? safeDecision(spec)
        : rawFixture;
    const assembledPrompt = assembleChatPrompt({
      character: spec,
      state: toFeatureState(state),
      schedule: toFeatureScheduleItems(schedule),
      memories,
      recentMessages: recentMessages.map((message) => ({
        role: message.role === "system" ? "assistant" : message.role,
        content: message.content,
        createdAtUtc: message.createdAtUtc,
      })),
      nowUtc,
      userMessage: input.text,
      decisionMode: scheduleNegotiationEligible
        ? this.options.scheduleNegotiationMode === "shadow"
          ? "schedule_negotiation_shadow"
          : "schedule_negotiation"
        : effectsEligible
          ? "legacy_effects"
          : "reply_only",
    });

    const turn =
      this.llm.providerName === "fixture"
        ? await this.decideFixtureTurn({
            spec,
            userText: input.text,
            agentId: input.agentId,
            nowUtc,
            capabilities,
            system: assembledPrompt.system,
            prompt: assembledPrompt.prompt,
            fixture,
          })
        : await this.decidePersonaReply({
            spec,
            userText: input.text,
            agentId: input.agentId,
            nowUtc,
            capabilities,
            system: assembledPrompt.system,
            prompt: assembledPrompt.prompt,
            replyStrategy: assembledPrompt.replyStrategy,
            effects: {
              eligible: effectsEligible,
              schedule,
              userText: input.text,
              negotiation: {
                enabled: scheduleNegotiationEligible,
                enforced: negotiationEnforced,
                ...(activeNegotiation === undefined
                  ? {}
                  : { active: activeNegotiation }),
              },
            },
          });
    let { decision, inspection, repairAttempted } = turn;
    let usedFallback = turn.usedFallback;
    let negotiationPlan: PreparedScheduleNegotiation | undefined;
    if (scheduleNegotiationEligible) {
      const provisionalUserMessage: StoredMessage = {
        id: userMessageId,
        sessionId,
        agentId: input.agentId,
        role: "user",
        content: input.text,
        messageKind: "user",
        clientMessageId: input.clientMessageId,
        metadata: {},
        createdAtUtc: nowUtc,
      };
      negotiationPlan = this.scheduleNegotiations.prepare({
        agentId: input.agentId,
        sessionId,
        timezone: spec.identity.timezone,
        nowUtc,
        userMessage: provisionalUserMessage,
        assistantMessageId,
        recentMessages,
        action: turn.scheduleAction,
      });
      if (this.options.scheduleNegotiationMode === "enforced") {
        if (
          negotiationPlan.effect === undefined &&
          negotiationPlan.actionKind !== "none"
        ) {
          decision = {
            ...decision,
            memoryCandidates: decision.memoryCandidates.filter(
              (candidate) => candidate.kind !== "commitment",
            ),
          };
        }
        decision = {
          ...decision,
          scheduleEffects:
            negotiationPlan.effect === undefined
              ? []
              : [negotiationPlan.effect],
          reasonCode:
            negotiationPlan.effect === undefined
              ? "schedule_negotiation_pending"
              : "schedule_negotiation_committed",
          reasonSummary:
            negotiationPlan.effect === undefined
              ? "结构化日程协商尚未形成可提交命令。"
              : "结构化约定已通过服务端校验并形成日程命令。",
        };
        inspection = inspectDecision(
          this.schedules,
          input.agentId,
          spec,
          decision,
          nowUtc,
          capabilities,
        );
        appendNegotiationReplyIssues(
          inspection,
          decision.reply.text,
          negotiationPlan.effect !== undefined,
        );
        if (
          negotiationPlan.effect === undefined &&
          (negotiationPlan.actionKind === "accept_user_offer" ||
            negotiationPlan.actionKind === "accept_pending_offer") &&
          negotiationPlan.rejections.length > 0
        ) {
          inspection.issues.push({
            code: "rejected_schedule_acceptance",
            message:
              "The structured acceptance was rejected and cannot be presented as accepted.",
          });
        }
        if (inspection.issues.length > 0) {
          repairAttempted = true;
          const repaired = await this.tryRepairPersonaReply(
            spec,
            input.text,
            {
              text: decision.reply.text,
              toneTags: decision.reply.toneTags,
            },
            inspection.issues,
            assembledPrompt.replyStrategy,
          );
          const repairedBase = repaired
            ? materializePersonaReply(
                repaired,
                spec,
                assembledPrompt.replyStrategy,
              )
            : safeNegotiatedDecision(
                spec,
                negotiationPlan.effect !== undefined,
              );
          if (repaired === undefined) usedFallback = true;
          decision = {
            ...repairedBase,
            scheduleEffects:
              negotiationPlan.effect === undefined
                ? []
                : [negotiationPlan.effect],
            reasonCode:
              negotiationPlan.effect === undefined
                ? repairedBase.reasonCode
                : "schedule_negotiation_committed",
            reasonSummary:
              negotiationPlan.effect === undefined
                ? repairedBase.reasonSummary
                : "结构化约定已通过服务端校验并形成日程命令。",
          };
          inspection = inspectDecision(
            this.schedules,
            input.agentId,
            spec,
            decision,
            nowUtc,
            capabilities,
          );
          appendNegotiationReplyIssues(
            inspection,
            decision.reply.text,
            negotiationPlan.effect !== undefined,
          );
          if (inspection.issues.length > 0) {
            usedFallback = true;
            const fallback = safeNegotiatedDecision(
              spec,
              negotiationPlan.effect !== undefined,
            );
            decision = {
              ...fallback,
              scheduleEffects:
                negotiationPlan.effect === undefined
                  ? []
                  : [negotiationPlan.effect],
              reasonCode:
                negotiationPlan.effect === undefined
                  ? fallback.reasonCode
                  : "schedule_negotiation_committed",
              reasonSummary:
                negotiationPlan.effect === undefined
                  ? fallback.reasonSummary
                  : "结构化约定已通过服务端校验并形成日程命令。",
            };
            inspection = inspectDecision(
              this.schedules,
              input.agentId,
              spec,
              decision,
              nowUtc,
              capabilities,
            );
          }
        }
        if (negotiationPlan.presentationText !== undefined) {
          decision = appendNegotiationPresentation(
            decision,
            negotiationPlan.presentationText,
          );
        }
      }
    }
    const validation = inspection.validation;

    const proposalRejections: Array<{
      reasonCode: string;
      reasonSummary: string;
      raw: unknown;
    }> = [
      ...turn.modelRejections.map((rejection) => ({
        reasonCode: rejection.reasonCode,
        reasonSummary: rejection.reasonSummary,
        raw: rejection.raw,
      })),
      ...validation.rejections.map((rejection) => ({
        reasonCode: rejection.code,
        reasonSummary: rejection.message,
        raw: rejection.proposal,
      })),
      ...(this.options.scheduleNegotiationMode === "enforced"
        ? (negotiationPlan?.rejections ?? [])
        : []),
    ];
    const proposedCount = decision.scheduleEffects.length;
    const acceptedCount = validation.accepted.length;
    const decisionPath: ChatTurnDecisionPath = usedFallback
      ? "fallback"
      : proposedCount === 0 && proposalRejections.length === 0
        ? "reply_only"
        : acceptedCount === proposedCount && proposalRejections.length === 0
          ? "full"
          : acceptedCount > 0
            ? "partial"
            : "effects_rejected";

    const userMessage: StoredMessage = {
      id: userMessageId,
      sessionId,
      agentId: input.agentId,
      role: "user",
      content: input.text,
      messageKind: "user",
      clientMessageId: input.clientMessageId,
      metadata: {},
      createdAtUtc: nowUtc,
    };
    const assistantMessage: StoredMessage = {
      id: assistantMessageId,
      sessionId,
      agentId: input.agentId,
      role: "assistant",
      content: decision.reply.text,
      messageKind: "assistant_reply",
      inReplyToMessageId: userMessage.id,
      metadata: {
        chunks: decision.reply.chunks,
        deliveryMode: deliveryModeForDecision(decision),
        toneTags: decision.reply.toneTags,
        reasonCode: decision.reasonCode,
        reasonSummary: decision.reasonSummary,
        repairAttempted,
        decisionPath,
        rejectedProposalCount: proposalRejections.length,
      },
      createdAtUtc: nowUtc,
    };
    const nextState = applyTurnState(
      state,
      decision.stateDelta,
      decision.relationshipDelta,
      nowUtc,
      capabilities,
    );
    const stateChanged = nextState.revision !== state.revision;
    let effectsToApply = validation.accepted;
    let scheduleChanges: ScheduleItem[] = [];
    let memoryIds: string[] = [];
    try {
      this.store.transaction(() => {
        const duplicate = this.store.findTurnByClientMessageId(
          sessionId,
          input.clientMessageId,
        );
        if (duplicate) throw new DuplicateTurnError(duplicate);
        if (
          this.options.scheduleNegotiationMode === "enforced" &&
          negotiationPlan?.effect !== undefined
        ) {
          const finalValidation = this.schedules.validateEffectsPartial(
            input.agentId,
            [negotiationPlan.effect],
            nowUtc,
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
        this.store.insertMessage(userMessage);
        if (
          this.options.scheduleNegotiationMode === "enforced" &&
          negotiationPlan !== undefined
        ) {
          for (const update of negotiationPlan.updates) {
            if (
              negotiationPlan.expectedActive?.id === update.id &&
              !this.store.compareAndSetScheduleNegotiation(update, {
                status: negotiationPlan.expectedActive.status,
                offerVersion: negotiationPlan.expectedActive.offerVersion,
              })
            ) {
              throw new ApiError(
                409,
                "stale_schedule_negotiation",
                "The schedule offer changed before it could be committed.",
              );
            }
            if (negotiationPlan.expectedActive?.id !== update.id) {
              this.store.upsertScheduleNegotiation(update);
            }
          }
          if (negotiationPlan.transition !== undefined) {
            const latest = negotiationPlan.updates.at(-1);
            if (
              !this.store.insertDomainEvent({
                agentId: input.agentId,
                streamType: "schedule_negotiation",
                streamId: latest?.id ?? sessionId,
                streamVersion: latest?.offerVersion ?? 0,
                eventType: `schedule.negotiation_${negotiationPlan.transition.reason}`,
                recordedAtUtc: nowUtc,
                payload: {
                  actionKind: negotiationPlan.actionKind,
                  transition: negotiationPlan.transition,
                  negotiationId: latest?.id,
                  offerVersion: latest?.offerVersion,
                },
                correlationId: input.clientMessageId,
                causationId: userMessage.id,
                idempotencyKey: `schedule-negotiation:${sessionId}:${input.clientMessageId}`,
              })
            ) {
              throw new Error(
                "Schedule negotiation audit event was not inserted",
              );
            }
          }
        } else if (
          this.options.scheduleNegotiationMode === "shadow" &&
          negotiationPlan !== undefined
        ) {
          if (
            !this.store.insertDomainEvent({
              agentId: input.agentId,
              streamType: "schedule_negotiation_shadow",
              streamId: sessionId,
              streamVersion: nextState.revision,
              eventType: "schedule.negotiation_shadow_evaluated",
              recordedAtUtc: nowUtc,
              payload: {
                actionKind: negotiationPlan.actionKind,
                wouldCommit: negotiationPlan.effect !== undefined,
                rejectionCodes: negotiationPlan.rejections.map(
                  (rejection) => rejection.reasonCode,
                ),
              },
              correlationId: input.clientMessageId,
              causationId: userMessage.id,
              idempotencyKey: `schedule-negotiation-shadow:${sessionId}:${input.clientMessageId}`,
            })
          ) {
            throw new Error(
              "Schedule negotiation shadow event was not inserted",
            );
          }
        }
        scheduleChanges = this.schedules.applyValidatedEffects(
          input.agentId,
          effectsToApply,
          nowUtc,
        );
        if (
          this.options.scheduleNegotiationMode === "enforced" &&
          scheduleChanges.length > 0 &&
          negotiationPlan?.effect !== undefined
        ) {
          const negotiation = negotiationPlan.updates.at(-1);
          if (
            !this.store.insertDomainEvent({
              agentId: input.agentId,
              streamType: "schedule",
              streamId: input.agentId,
              streamVersion: Math.max(
                ...scheduleChanges.map((item) => item.revision),
              ),
              eventType: "schedule.command_committed",
              recordedAtUtc: nowUtc,
              effectiveAtUtc: scheduleChanges[0]!.startAtUtc,
              payload: {
                negotiationId: negotiation?.id,
                offerVersion: negotiation?.offerVersion,
                operation: "create",
                changedItemIds: scheduleChanges.map((item) => item.id),
                policyVersion: 1,
              },
              correlationId: input.clientMessageId,
              causationId: userMessage.id,
              idempotencyKey: `schedule-command:${negotiation?.id}:${negotiation?.offerVersion}`,
            })
          ) {
            throw new Error("Schedule command audit event was not inserted");
          }
        }
        for (const rejection of proposalRejections) {
          this.store.insertRejectedProposal({
            agentId: input.agentId,
            sessionId,
            purpose: "chat_turn",
            reasonCode: rejection.reasonCode,
            reasonSummary: rejection.reasonSummary,
            raw: rejection.raw,
            correlationId: input.clientMessageId,
            createdAtUtc: nowUtc,
          });
        }
        if (stateChanged) this.store.updateRuntimeState(nextState);
        memoryIds = capabilities.longTermMemory
          ? validateMergeAndPersistMemories({
              store: this.store,
              agentId: input.agentId,
              candidates: decision.memoryCandidates,
              nowUtc,
              maxCandidates: capabilities.memoryCandidatesPerTurn,
              authoritativeMessageId: userMessage.id,
            }).map((memory) => memory.id)
          : [];
        this.store.insertMessage(assistantMessage);
        if (
          !this.store.insertDomainEvent({
            agentId: input.agentId,
            streamType: "conversation",
            streamId: sessionId,
            streamVersion: nextState.revision,
            eventType: "conversation.turn_committed",
            recordedAtUtc: nowUtc,
            payload: {
              userMessageId: userMessage.id,
              assistantMessageId: assistantMessage.id,
              scheduleItemIds: scheduleChanges.map((item) => item.id),
              memoryIds,
              reasonCode: decision.reasonCode,
            },
            correlationId: input.clientMessageId,
            causationId: userMessage.id,
            idempotencyKey: `chat:${sessionId}:${input.clientMessageId}`,
          })
        ) {
          throw new Error("Conversation turn audit event was not inserted");
        }
      });
    } catch (error) {
      if (error instanceof DuplicateTurnError) {
        const stored = error.turn;
        if (!stored.assistantMessage) throw error;
        assertIdempotentTurnMatches(stored.userMessage, input.text);
        return {
          idempotentReplay: true,
          userMessage: stored.userMessage,
          assistantMessage: stored.assistantMessage,
          scheduleChanges: [],
          state: this.store.getRuntimeState(input.agentId) ?? nextState,
          decision: {
            reasonCode: metadataText(
              stored.assistantMessage.metadata,
              "reasonCode",
              "idempotent_replay",
            ),
            reasonSummary: metadataText(
              stored.assistantMessage.metadata,
              "reasonSummary",
              "Replayed stored turn.",
            ),
            toneTags:
              (stored.assistantMessage.metadata.toneTags as
                string[] | undefined) ?? [],
            deliveryMode: metadataDeliveryMode(
              stored.assistantMessage.metadata,
            ),
            chunks: metadataChunks(
              stored.assistantMessage.metadata,
              stored.assistantMessage.content,
            ),
          },
        };
      }
      throw error;
    }

    this.sse.publish({
      type: "message.created",
      agentId: input.agentId,
      occurredAtUtc: nowUtc,
      data: assistantMessage,
    });
    if (scheduleChanges.length > 0) {
      this.sse.publish({
        type: "schedule.updated",
        agentId: input.agentId,
        occurredAtUtc: nowUtc,
        data: scheduleChanges,
      });
    }
    if (stateChanged) {
      this.sse.publish({
        type: "state.updated",
        agentId: input.agentId,
        occurredAtUtc: nowUtc,
        data: nextState,
      });
    }
    return {
      idempotentReplay: false,
      userMessage,
      assistantMessage,
      scheduleChanges,
      state: nextState,
      decision: {
        reasonCode: decision.reasonCode,
        reasonSummary: decision.reasonSummary,
        toneTags: decision.reply.toneTags,
        deliveryMode: deliveryModeForDecision(decision),
        chunks: decision.reply.chunks,
      },
    };
  }

  private async decideFixtureTurn(input: {
    spec: CharacterSpec;
    userText: string;
    agentId: string;
    nowUtc: string;
    capabilities: SimulationCapabilities;
    system: string;
    prompt: string;
    fixture: AgentTurnDecision;
  }): Promise<ResolvedTurn> {
    let decision: AgentTurnDecision | undefined;
    let initialIssues: unknown[] = [];
    try {
      decision = await this.llm.generateObject({
        purpose: "chat_turn",
        agentId: input.agentId,
        system: input.system,
        prompt: input.prompt,
        schema: agentTurnDecisionSchema,
        fixture: input.fixture,
      });
    } catch (error) {
      initialIssues = invalidOutputIssues(error);
    }

    let inspection = decision
      ? inspectDecision(
          this.schedules,
          input.agentId,
          input.spec,
          decision,
          input.nowUtc,
          input.capabilities,
        )
      : undefined;
    let repairAttempted = false;
    let usedFallback = false;
    if (!decision || !inspection || inspection.issues.length > 0) {
      repairAttempted = true;
      decision = await this.tryRepairFixtureDecision(
        input.spec,
        input.userText,
        decision,
        inspection?.issues ?? initialIssues,
        safeDecision(input.spec),
      );
      inspection = inspectDecision(
        this.schedules,
        input.agentId,
        input.spec,
        decision,
        input.nowUtc,
        input.capabilities,
      );
    }
    if (inspection.issues.length > 0) {
      decision = safeDecision(input.spec);
      usedFallback = true;
      inspection = inspectDecision(
        this.schedules,
        input.agentId,
        input.spec,
        decision,
        input.nowUtc,
        input.capabilities,
      );
    }
    return {
      decision,
      inspection,
      repairAttempted,
      usedFallback,
      modelRejections: [],
      scheduleAction: { kind: "none" },
    };
  }

  private async decidePersonaReply(input: {
    spec: CharacterSpec;
    userText: string;
    agentId: string;
    nowUtc: string;
    capabilities: SimulationCapabilities;
    system: string;
    prompt: string;
    replyStrategy: ReplyStrategy;
    effects: {
      eligible: boolean;
      schedule: ScheduleItem[];
      userText: string;
      negotiation: {
        enabled: boolean;
        enforced: boolean;
        active?: ActiveScheduleNegotiation;
      };
    };
  }): Promise<ResolvedTurn> {
    let decisionResponse: PersonaChatDecision | undefined;
    let replyResponse: PersonaChatResponse | undefined;
    let initialIssues: unknown[] = [];
    const effectsContract = [
      ...(input.effects.negotiation.enabled
        ? [
            buildScheduleNegotiationContract({
              ...(input.effects.negotiation.active === undefined
                ? {}
                : { active: input.effects.negotiation.active }),
              timezone: input.spec.identity.timezone,
              legacyEffectsEnabled: input.effects.eligible,
            }),
          ]
        : []),
      ...(input.effects.eligible
        ? [
            buildScheduleEffectsContract(
              input.effects.schedule,
              input.spec.identity.timezone,
            ),
          ]
        : []),
    ].join("\n");
    try {
      if (input.effects.eligible || input.effects.negotiation.enabled) {
        decisionResponse = PersonaChatDecisionSchema.parse(
          await this.llm.generateObject({
            purpose: "chat_turn",
            agentId: input.agentId,
            system: input.system,
            prompt: `${input.prompt}\n${effectsContract}`,
            schema: PersonaChatDecisionSchema,
            maxOutputTokens: input.replyStrategy.maxOutputTokens + 800,
          }),
        );
      } else {
        replyResponse = PersonaChatResponseSchema.parse(
          await this.llm.generateObject({
            purpose: "chat_turn",
            agentId: input.agentId,
            system: input.system,
            prompt: input.prompt,
            schema: PersonaChatResponseSchema,
            maxOutputTokens: input.replyStrategy.maxOutputTokens,
          }),
        );
      }
    } catch (error) {
      initialIssues = invalidOutputIssues(error);
    }

    const modelRejections: ModelEffectRejection[] = [];
    let decision =
      decisionResponse !== undefined
        ? this.materializeDecisionResponse(
            decisionResponse,
            input.spec,
            input.replyStrategy,
            {
              schedule: input.effects.schedule,
              timezone: input.spec.identity.timezone,
              nowUtc: input.nowUtc,
              userText: input.effects.userText,
              legacyEffectsEnabled: input.effects.eligible,
            },
            modelRejections,
          )
        : replyResponse !== undefined
          ? materializePersonaReply(
              replyResponse,
              input.spec,
              input.replyStrategy,
            )
          : safePersonaDecision(input.spec);
    let usedFallback =
      decisionResponse === undefined && replyResponse === undefined;

    let inspection = usedFallback
      ? undefined
      : inspectDecision(
          this.schedules,
          input.agentId,
          input.spec,
          decision,
          input.nowUtc,
          input.capabilities,
        );
    if (inspection && input.effects.negotiation.enforced) {
      inspection.issues = inspection.issues.filter(
        (issue) => !isUncommittedScheduleIssue(issue),
      );
    }
    let repairAttempted = false;
    if (!inspection || inspection.issues.length > 0) {
      repairAttempted = true;
      const repaired = await this.tryRepairPersonaReply(
        input.spec,
        input.userText,
        decisionResponse !== undefined
          ? {
              text: decisionResponse.text,
              ...(decisionResponse.toneTags === undefined
                ? {}
                : { toneTags: decisionResponse.toneTags }),
            }
          : replyResponse,
        inspection?.issues ?? initialIssues,
        input.replyStrategy,
      );
      if (repaired) {
        decision = materializePersonaReply(
          repaired,
          input.spec,
          input.replyStrategy,
        );
        inspection = inspectDecision(
          this.schedules,
          input.agentId,
          input.spec,
          decision,
          input.nowUtc,
          input.capabilities,
        );
        if (input.effects.negotiation.enforced) {
          inspection.issues = inspection.issues.filter(
            (issue) => !isUncommittedScheduleIssue(issue),
          );
        }
      }
    }
    if (!inspection || inspection.issues.length > 0) {
      decision = safePersonaDecision(input.spec);
      usedFallback = true;
      inspection = inspectDecision(
        this.schedules,
        input.agentId,
        input.spec,
        decision,
        input.nowUtc,
        input.capabilities,
      );
    }
    return {
      decision,
      inspection,
      repairAttempted,
      usedFallback,
      modelRejections,
      scheduleAction: decisionResponse?.scheduleAction ?? { kind: "none" },
    };
  }

  private materializeDecisionResponse(
    response: PersonaChatDecision,
    spec: CharacterSpec,
    replyStrategy: ReplyStrategy,
    context: {
      schedule: ScheduleItem[];
      timezone: string;
      nowUtc: string;
      userText: string;
      legacyEffectsEnabled: boolean;
    },
    modelRejections: ModelEffectRejection[],
  ): AgentTurnDecision {
    const base = materializePersonaReply(
      PersonaChatResponseSchema.parse({
        text: response.text,
        ...(response.toneTags === undefined
          ? {}
          : { toneTags: response.toneTags }),
        ...(response.deliveryMode === undefined
          ? {}
          : { deliveryMode: response.deliveryMode }),
        ...(response.chunks === undefined ? {} : { chunks: response.chunks }),
      }),
      spec,
      replyStrategy,
    );
    const normalized = normalizeModelEffects({
      effects: context.legacyEffectsEnabled ? response.scheduleEffects : [],
      schedule: context.schedule,
      timezone: context.timezone,
      nowUtc: context.nowUtc,
      userText: context.userText,
    });
    modelRejections.push(...normalized.rejections);
    const proposals: ScheduleEffectProposal[] = [];
    for (const proposal of normalized.accepted) {
      const parsed = ScheduleEffectProposalSchema.safeParse(proposal);
      if (parsed.success) {
        proposals.push(parsed.data);
        continue;
      }
      modelRejections.push({
        raw: proposal,
        reasonCode: "schema_mismatch",
        reasonSummary:
          "The normalized proposal did not match the strict proposal contract.",
      });
    }
    return {
      ...base,
      scheduleEffects: proposals,
      memoryCandidates: sanitizeModelMemoryCandidates(
        response.memoryCandidates,
      ),
      reasonCode: "persona_chat_decision",
      reasonSummary:
        proposals.length > 0
          ? "根据角色人格回复，并提交了通过校验的日程调整。"
          : "根据角色人格和当前对话生成自然回复。",
    };
  }

  private async tryRepairFixtureDecision(
    spec: CharacterSpec,
    userText: string,
    invalidDecision: AgentTurnDecision | undefined,
    issues: unknown,
    fixture: AgentTurnDecision,
  ): Promise<AgentTurnDecision> {
    try {
      return await this.llm.generateObject({
        purpose: "repair_chat_turn",
        agentId: spec.id,
        maxRetries: 0,
        system:
          "Repair a fictional character turn. Preserve a truthful reply, remove or correct invalid schedule effects, and return only the requested JSON object.",
        prompt: `User message: ${userText}\nInvalid decision: ${JSON.stringify(
          invalidDecision ?? null,
        )}\nValidation issues: ${JSON.stringify(issues)}\nCharacter: ${JSON.stringify(
          {
            identity: spec.identity,
            persona: spec.persona,
          },
        )}`,
        schema: agentTurnDecisionSchema,
        fixture,
      });
    } catch {
      return fixture;
    }
  }

  private async tryRepairPersonaReply(
    spec: CharacterSpec,
    userText: string,
    invalidResponse: PersonaChatResponse | undefined,
    issues: unknown,
    replyStrategy: ReplyStrategy,
  ): Promise<PersonaChatResponse | undefined> {
    try {
      const repaired = await this.llm.generateObject({
        purpose: "repair_chat_turn",
        agentId: spec.id,
        maxRetries: 0,
        maxOutputTokens: replyStrategy.maxOutputTokens,
        system:
          "Repair only the in-character conversational reply. Return one JSON object containing the complete required text plus optional toneTags and deliveryMode. chunks is optional and intended only for sequential delivery; omit chunks for single_block so the complete reply is not duplicated. Do not propose actions, schedules, memories, state changes, relationship changes, or hidden reasoning. Length guidance is soft: preserve useful substance and never pad merely to hit a number.",
        prompt:
          `Character role and persona: ${JSON.stringify({
            identity: spec.identity,
            persona: spec.persona,
            dialogue: spec.dialogue,
            forbiddenMetaKnowledge: spec.knowledge.forbiddenMetaKnowledge,
          })}\n` +
          `User message: ${JSON.stringify(userText)}\n` +
          `Invalid reply: ${JSON.stringify(invalidResponse ?? null)}\n` +
          `Persona guard issues to fix: ${JSON.stringify(issues)}\n` +
          `Soft reply strategy: ${JSON.stringify({
            complexity: replyStrategy.complexity,
            targetMinChars: replyStrategy.targetMinChars,
            targetMaxChars: replyStrategy.targetMaxChars,
            deliveryPreference: replyStrategy.deliveryPreference,
            preferredChunkCount: replyStrategy.preferredChunkCount,
          })}\n` +
          'Return at minimum {"text":"the complete repaired in-character reply"}. You may add toneTags and deliveryMode. Add chunks only when deliveryMode is sequential; omit chunks for single_block.',
        schema: PersonaChatResponseSchema,
      });
      return PersonaChatResponseSchema.parse(repaired);
    } catch {
      return undefined;
    }
  }
}

type DecisionInspection = ReturnType<typeof inspectDecision>;

type ResolvedTurn = {
  decision: AgentTurnDecision;
  inspection: DecisionInspection;
  repairAttempted: boolean;
  usedFallback: boolean;
  modelRejections: ModelEffectRejection[];
  scheduleAction: ScheduleNegotiationAction;
};

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

function inspectDecision(
  schedules: ScheduleService,
  agentId: string,
  spec: CharacterSpec,
  decision: AgentTurnDecision,
  nowUtc: string,
  capabilities: SimulationCapabilities,
): { validation: PartialProposalValidation; issues: unknown[] } {
  // Partial validation: an invalid proposal drops only itself. The remaining
  // issues are reply-level (claim consistency, persona guard) and are the
  // only conditions that can still trigger a repair or fallback.
  const validation = schedules.validateEffectsPartial(
    agentId,
    decision.scheduleEffects,
    nowUtc,
  );
  const issues: unknown[] = [];
  if (violatesTruthfulReply(decision, validation.accepted.length)) {
    issues.push({
      code: "uncommitted_schedule_claim",
      message:
        "Reply claims an explicit schedule change that was not committed.",
    });
  }
  if (capabilities.personaGuard) {
    const guarded = guardPersonaReply({
      text: decision.reply.text,
      avoidedPhrases: spec.dialogue.avoidedPhrases,
      forbiddenMetaKnowledge: spec.knowledge.forbiddenMetaKnowledge,
      acceptedScheduleEffects: toFeatureScheduleEffects(validation.accepted),
      reasonSummary: decision.reasonSummary,
    });
    if (!guarded.allowed) issues.push(...guarded.violations);
  }
  return { validation, issues };
}

function buildScheduleEffectsContract(
  items: readonly ScheduleItem[],
  timezone: string,
): string {
  const rows = items
    .filter((item) => item.status !== "cancelled")
    .slice(0, 20)
    .map((item) => ({
      itemId: item.id,
      title: item.title,
      category: item.category,
      startLocal: DateTime.fromISO(item.startAtUtc)
        .setZone(timezone)
        .toFormat("yyyy-MM-dd HH:mm"),
      endLocal: DateTime.fromISO(item.endAtUtc)
        .setZone(timezone)
        .toFormat("yyyy-MM-dd HH:mm"),
      rigidity: item.rigidity,
    }));
  return [
    "SCHEDULE_EFFECTS_CONTRACT",
    "The user message may relate to the character's plans. You may propose at most 3 schedule changes in the optional scheduleEffects array; return an empty array unless the user clearly requested, agreed to, or accepted a concrete change.",
    'Each effect MUST include "justificationQuote": a short verbatim quote from the current user message that justifies it. Effects without a grounded quote are rejected by the server.',
    "Operations: create | reschedule | cancel. reschedule and cancel need itemId from SCHEDULE_ITEMS_JSON; create needs item.title and item.startAt.",
    `Times: local clock strings in the character timezone (${timezone}), for example "19:30", "明天 09:00", or ISO UTC timestamps. Unparseable times are rejected.`,
    "SCHEDULE_ITEMS_JSON",
    JSON.stringify(rows),
  ].join("\n");
}

const MEMORY_KINDS = new Set([
  "semantic",
  "episodic",
  "relationship",
  "commitment",
]);

const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function sanitizeModelMemoryCandidates(
  records: readonly Record<string, unknown>[],
): AgentTurnDecision["memoryCandidates"] {
  const output: MemoryCandidate[] = [];
  for (const raw of records.slice(0, 4)) {
    const content =
      typeof raw.content === "string"
        ? raw.content.trim()
        : typeof raw.text === "string"
          ? raw.text.trim()
          : "";
    if (content === "") continue;
    const occurredAtUtc =
      typeof raw.occurredAtUtc === "string" &&
      UTC_PATTERN.test(raw.occurredAtUtc)
        ? raw.occurredAtUtc
        : undefined;
    const candidate = {
      kind: (typeof raw.kind === "string" && MEMORY_KINDS.has(raw.kind)
        ? raw.kind
        : "episodic") as MemoryCandidate["kind"],
      content: content.slice(0, 2_000),
      importance:
        typeof raw.importance === "number" &&
        Number.isFinite(raw.importance) &&
        raw.importance >= 0 &&
        raw.importance <= 1
          ? raw.importance
          : 0.5,
      confidence:
        typeof raw.confidence === "number" &&
        Number.isFinite(raw.confidence) &&
        raw.confidence >= 0 &&
        raw.confidence <= 1
          ? raw.confidence
          : 0.6,
      ...(occurredAtUtc === undefined ? {} : { occurredAtUtc }),
      tags: Array.isArray(raw.tags)
        ? raw.tags
            .filter(
              (tag): tag is string =>
                typeof tag === "string" && tag.trim() !== "",
            )
            .slice(0, 20)
        : [],
      sourceMessageIds: [],
      sourceActivityEventIds: [],
      origin: "runtime_simulation",
      reasonCode: "model_memory_proposal",
      reasonSummary: "模型从对话中提取的记忆候选。",
    };
    const parsed = MemoryCandidateSchema.safeParse(candidate);
    if (parsed.success) output.push(parsed.data);
  }
  return output;
}

function fixtureDecision(
  spec: CharacterSpec,
  schedule: ScheduleItem[],
  text: string,
  nowUtc: string,
): AgentTurnDecision {
  const invitation = /(晚会|派对|聚会|party|一起去|一起参加)/i.test(text);
  if (invitation && spec.schedulePolicy.enabled) {
    const nowLocal = DateTime.fromISO(nowUtc).setZone(spec.identity.timezone);
    const study = schedule.find((item) => {
      const start = DateTime.fromISO(item.startAtUtc).setZone(
        spec.identity.timezone,
      );
      return (
        item.status === "planned" &&
        item.rigidity !== "fixed" &&
        (item.category === "study" || item.title.includes("自习")) &&
        start.toISODate() === nowLocal.toISODate() &&
        start.hour >= 17
      );
    });
    if (study) {
      const effects: ScheduleEffectProposal[] = [
        {
          operation: "cancel",
          itemId: study.id,
          reasonCode: "accepted_social_invitation",
          reasonSummary: "为重要的临时邀请腾出时间。",
        },
        {
          operation: "create",
          item: {
            title: "和用户一起参加晚会",
            description: "接受用户邀请，一起参加今晚的晚会。",
            category: "social",
            startAtUtc: study.startAtUtc,
            endAtUtc: study.endAtUtc,
            timezone: study.timezone,
            rigidity: "committed",
            priority: 0.82,
            source: "user_invitation",
            adherenceProbability: 0.94,
            narrativeImportance: 0.86,
            shareable: true,
            stateEffects: {
              moodValence: 0.16,
              socialBattery: -0.16,
              energy: -0.12,
            },
          },
          reasonCode: "accepted_social_invitation",
          reasonSummary: "接受邀请，并用晚会替换可调整的自习。",
        },
      ];
      return {
        reply: {
          text: `好啊。今晚的自习本来可以调整，那我就和你一起去；我会把学习安排挪到之后。`,
          chunks: [
            "好啊。今晚的自习本来可以调整，那我就和你一起去；我会把学习安排挪到之后。",
          ],
          toneTags: ["自然", "愿意", "有主见"],
        },
        scheduleEffects: effects,
        stateDelta: { moodValence: 0.08, moodArousal: 0.1 },
        relationshipDelta: {
          closeness: 0.025,
          trust: 0.01,
          recentInteractionValence: 0.12,
        },
        memoryCandidates: [
          {
            kind: "commitment",
            content: "答应今晚和用户一起参加晚会。",
            tags: ["晚会", "共同计划"],
            importance: 0.82,
            confidence: 1,
            occurredAtUtc: nowUtc,
            sourceMessageIds: [],
            sourceActivityEventIds: [],
            origin: "runtime_simulation",
            reasonCode: "accepted_social_invitation",
            reasonSummary: "用户与角色形成了明确的共同承诺。",
          },
        ],
        reasonCode: "accepted_social_invitation",
        reasonSummary: "可调整日程与当前关系支持接受邀请。",
      };
    }
  }

  const name = spec.identity.name;
  return {
    reply: {
      text: `${text.length < 20 ? "嗯，我在听。" : "我明白你的意思了。"}我现在会按自己的节奏认真回应，也会记住真正重要的部分。`,
      chunks: [
        `${text.length < 20 ? "嗯，我在听。" : "我明白你的意思了。"}我现在会按自己的节奏认真回应，也会记住真正重要的部分。`,
      ],
      toneTags:
        spec.dialogue.warmth >= 0.6 ? ["自然", "温暖"] : ["自然", "克制"],
    },
    scheduleEffects: [],
    stateDelta: { socialBattery: -0.015, moodValence: 0.015 },
    relationshipDelta: { closeness: 0.008, recentInteractionValence: 0.03 },
    memoryCandidates:
      text.length >= 30
        ? [
            {
              kind: "episodic",
              content: `用户向${name}提到：${text.slice(0, 180)}`,
              tags: ["对话"],
              importance: 0.45,
              confidence: 0.75,
              occurredAtUtc: nowUtc,
              sourceMessageIds: [],
              sourceActivityEventIds: [],
              origin: "runtime_simulation",
              reasonCode: "conversation_memory",
              reasonSummary: "保留这次对话中较重要的用户信息。",
            },
          ]
        : [],
    reasonCode: "ordinary_conversation",
    reasonSummary: "没有需要修改日程的明确请求。",
  };
}

function safeDecision(spec: CharacterSpec): AgentTurnDecision {
  const text = createSafeFallbackReply(spec.identity.name);
  return {
    reply: {
      text,
      chunks: [text],
      toneTags:
        spec.dialogue.warmth >= 0.6 ? ["坦诚", "温和"] : ["坦诚", "克制"],
    },
    scheduleEffects: [],
    memoryCandidates: [],
    reasonCode: "safe_schedule_fallback",
    reasonSummary: "模型提案不可安全提交；未修改日程。",
  };
}

function materializePersonaReply(
  rawResponse: PersonaChatResponse,
  spec: CharacterSpec,
  replyStrategy: ReplyStrategy,
): AgentTurnDecision {
  const response = PersonaChatResponseSchema.parse(rawResponse);
  let deliveryMode = choosePersonaDeliveryMode(response, spec, replyStrategy);
  let chunks =
    deliveryMode === "sequential"
      ? (faithfulModelChunks(response) ?? splitSequentialReply(response.text))
      : [response.text];
  if (chunks.length < 2 && deliveryMode === "sequential") {
    deliveryMode = "single_block";
    chunks = [response.text];
  }

  // The persisted reply contract caps an individual chunk at 4,000 chars.
  // This safeguard preserves all text even if a provider ignores the soft
  // length guidance and returns an unusually large single block.
  if (chunks.some((chunk) => chunk.length > 4_000)) {
    chunks = splitSequentialReply(response.text);
  }
  const text = chunks.join("\n");
  return {
    reply: {
      text,
      chunks,
      toneTags: response.toneTags ?? [],
    },
    scheduleEffects: [],
    memoryCandidates: [],
    reasonCode: "persona_chat_reply",
    reasonSummary: "根据角色人格和当前对话生成自然回复。",
  };
}

function choosePersonaDeliveryMode(
  response: PersonaChatResponse,
  spec: CharacterSpec,
  strategy: ReplyStrategy,
): "single_block" | "sequential" {
  const faithfulChunks = faithfulModelChunks(response);
  if (
    response.deliveryMode === "sequential" &&
    (faithfulChunks?.length ?? 0) > 1
  ) {
    return "sequential";
  }

  const structured = isStructuredReply(response.text);
  const naturalBeatCount = sentenceUnits(
    response.text.replace(/\r\n?/gu, "\n").trim(),
  ).length;
  if (structured || strategy.complexity === "deep") return "single_block";
  if (naturalBeatCount < 2) return "single_block";

  // A low-formality character whose established style uses multiple bubbles
  // should not collapse every ordinary turn into one block merely because the
  // provider copied a conservative deliveryMode example. This calibration is
  // intentionally limited to brief/standard multi-beat conversation.
  if (
    strategy.deliveryPreference === "prefer_sequential" &&
    spec.dialogue.formality < 0.72 &&
    (strategy.complexity === "brief" || strategy.complexity === "standard")
  ) {
    return "sequential";
  }

  if (response.deliveryMode !== undefined) return response.deliveryMode;
  if ((faithfulChunks?.length ?? 0) > 1) return "sequential";
  if (strategy.complexity === "complex" && spec.dialogue.formality >= 0.58) {
    return "single_block";
  }
  return "single_block";
}

function isStructuredReply(text: string): boolean {
  return /(?:^|\n)\s*(?:[-*•]|\d+[.)、]|[一二三四五六七八九十]+[、.])/u.test(
    text,
  );
}

function faithfulModelChunks(
  response: PersonaChatResponse,
): string[] | undefined {
  if (response.chunks === undefined || response.chunks.length < 2)
    return undefined;
  const chunks = response.chunks.map((chunk) => chunk.trim());
  const completeText = comparableReply(response.text);
  const directJoin = comparableReply(chunks.join(""));
  const lineJoin = comparableReply(chunks.join("\n"));
  return directJoin === completeText || lineJoin === completeText
    ? chunks
    : undefined;
}

function comparableReply(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

/** Splits on complete sentence/beat boundaries and never drops reply text. */
function splitSequentialReply(text: string): string[] {
  const source = text.replace(/\r\n?/gu, "\n").trim();
  const units = sentenceUnits(source);
  if (units.length < 2)
    return splitLongText(source, 4_000).map((part) => part.trim());

  const expanded = units.flatMap((unit) => splitLongText(unit, 4_000));
  if (expanded.length <= 12)
    return expanded.map((part) => part.trim()).filter(Boolean);
  return packSequentialUnits(expanded, 12);
}

/** Keeps the original separator on each unit so later packing cannot glue words. */
function sentenceUnits(source: string): string[] {
  const boundary =
    /(?:[。！？!?；;]+|\.(?=\s|$))[”’"）】》」』]*(?:[ \t]*\n+[ \t]*|[ \t]+)?|\n+/gu;
  const units: string[] = [];
  let start = 0;
  for (const match of source.matchAll(boundary)) {
    const index = match.index;
    if (index === undefined) continue;
    const end = index + match[0].length;
    const unit = source.slice(start, end);
    if (unit.trim() !== "") units.push(unit);
    start = end;
  }
  const tail = source.slice(start);
  if (tail.trim() !== "") units.push(tail);
  return units;
}

function splitLongText(value: string, maximum: number): string[] {
  if (value.length <= maximum) return [value];
  const parts: string[] = [];
  for (let index = 0; index < value.length; index += maximum) {
    parts.push(value.slice(index, index + maximum));
  }
  return parts;
}

function packSequentialUnits(
  units: readonly string[],
  maximum: number,
): string[] {
  const totalLength = units.reduce((sum, unit) => sum + unit.length, 0);
  const targetSize = Math.max(1, Math.ceil(totalLength / maximum));
  const chunks: string[] = [];
  let current = "";
  for (const unit of units) {
    if (
      current !== "" &&
      chunks.length < maximum - 1 &&
      current.length + unit.length > targetSize
    ) {
      chunks.push(current.trim());
      current = unit;
    } else {
      current += unit;
    }
  }
  if (current !== "") chunks.push(current.trim());
  if (
    chunks.length <= maximum &&
    chunks.every((chunk) => chunk.length <= 4_000)
  )
    return chunks;

  // Rebuild from the raw units, not the trimmed chunks, to retain ordinary
  // spaces and original newlines while rebalancing an oversized tail.
  const source = units.join("");
  const safeSize = Math.ceil(source.length / maximum);
  return splitLongText(source, Math.min(4_000, safeSize))
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .slice(0, maximum);
}

function deliveryModeForDecision(
  decision: AgentTurnDecision,
): "single_block" | "sequential" {
  return decision.reply.chunks.length > 1 ? "sequential" : "single_block";
}

function safePersonaDecision(spec: CharacterSpec): AgentTurnDecision {
  const text =
    spec.dialogue.warmth >= 0.6
      ? "我刚才没有表达好，不过我在认真听。你愿意再多说一点吗？"
      : "我刚才没有说清楚。你可以继续，我会认真听。";
  return {
    reply: {
      text,
      chunks: [text],
      toneTags:
        spec.dialogue.warmth >= 0.6 ? ["自然", "温和"] : ["自然", "克制"],
    },
    scheduleEffects: [],
    memoryCandidates: [],
    reasonCode: "persona_chat_fallback",
    reasonSummary: "模型回复无法安全使用，返回中性角色回应。",
  };
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

function safeNegotiatedDecision(
  spec: CharacterSpec,
  committed: boolean,
): AgentTurnDecision {
  if (!committed) return safePersonaDecision(spec);
  const text =
    spec.dialogue.warmth >= 0.6
      ? "好，这个约定已经确认了。"
      : "可以，这个约定已经确认。";
  return {
    reply: {
      text,
      chunks: [text],
      toneTags:
        spec.dialogue.warmth >= 0.6 ? ["自然", "确认"] : ["自然", "克制"],
    },
    scheduleEffects: [],
    memoryCandidates: [],
    reasonCode: "schedule_negotiation_reply_fallback",
    reasonSummary: "使用与服务端提交结果一致的安全回复。",
  };
}

function appendNegotiationPresentation(
  decision: AgentTurnDecision,
  presentationText: string,
): AgentTurnDecision {
  const text = `${decision.reply.text.trim()}\n${presentationText}`.trim();
  return {
    ...decision,
    reply: {
      ...decision.reply,
      text,
      chunks: [text],
    },
  };
}

function invalidOutputIssues(error: unknown): unknown[] {
  return [
    {
      code: "invalid_model_output",
      message: error instanceof Error ? error.message : "Invalid output",
    },
  ];
}

function isUncommittedScheduleIssue(issue: unknown): boolean {
  if (typeof issue !== "object" || issue === null || Array.isArray(issue)) {
    return false;
  }
  const code = (issue as Record<string, unknown>)["code"];
  return (
    code === "uncommitted_schedule_claim" ||
    code === "UNCOMMITTED_SCHEDULE_CLAIM"
  );
}

function violatesTruthfulReply(
  decision: AgentTurnDecision,
  acceptedEffectCount: number,
): boolean {
  if (acceptedEffectCount > 0) return false;
  return /(?:已经|已|刚刚).{0,12}(?:修改|取消|移动|改(?:了|到|成)?|安排(?:好|了)?|加入).{0,12}(?:日程|计划|行程)|(?:i(?:'ve| have)) (?:rescheduled|cancelled|added .{0,12} to (?:my )?schedule)/iu.test(
    decision.reply.text,
  );
}

/**
 * A negative safety rail only: matching text can force a repair but can never
 * create or parameterize a schedule command.
 */
function replyClaimsRecordedAgreement(text: string): boolean {
  return sentenceUnits(text).some((clause) => {
    if (/[?？]|怎么样|可以吗|好吗|行吗|要不要/u.test(clause)) {
      return false;
    }
    return /(?:我.{0,4}(?:记下|记住)(?:了|啦)|说好(?:了)?|说定(?:了)?|约定(?:好|了)|已经确认|我.{0,4}(?:会|一定会)?准时到|(?:明天|明早|今晚|后天).{0,16}(?:见|等你))/iu.test(
      clause,
    );
  });
}

function replyRejectsCommittedAgreement(text: string): boolean {
  return /(?:(?:我|这次|明天|明早).{0,6}(?:不能|没法|不).{0,4}(?:去|来|参加|见|跑)|去不了|算了|改天再说|我拒绝|i (?:can't|cannot|won't) (?:go|come|make it)|no[,， ]+i (?:can't|won't))/iu.test(
    text,
  );
}

function appendNegotiationReplyIssues(
  inspection: DecisionInspection,
  text: string,
  committed: boolean,
): void {
  if (!committed && replyClaimsRecordedAgreement(text)) {
    inspection.issues.push({
      code: "uncommitted_schedule_agreement",
      message: "Reply claims an agreement without a committed command.",
    });
  }
  if (committed && replyRejectsCommittedAgreement(text)) {
    inspection.issues.push({
      code: "negotiation_reply_contradiction",
      message: "Reply rejects an agreement represented by a committed command.",
    });
  }
}

function applyTurnState(
  state: RuntimeState,
  delta: StateDelta | undefined,
  relationshipDelta: AgentTurnDecision["relationshipDelta"],
  nowUtc: string,
  capabilities: SimulationCapabilities,
): RuntimeState {
  const next = structuredClone(state);
  if (delta === undefined && relationshipDelta === undefined) return next;
  if (!capabilities.dynamicState && !capabilities.relationshipDynamics)
    return next;
  if (capabilities.dynamicState) {
    if (delta?.moodValence !== undefined)
      next.moodValence = clampSigned(next.moodValence + delta.moodValence);
    if (delta?.moodArousal !== undefined)
      next.moodArousal = clamp01(next.moodArousal + delta.moodArousal);
    if (delta?.energy !== undefined)
      next.energy = clamp01(next.energy + delta.energy);
    if (delta?.stress !== undefined)
      next.stress = clamp01(next.stress + delta.stress);
    if (delta?.socialBattery !== undefined)
      next.socialBattery = clamp01(next.socialBattery + delta.socialBattery);
    if (delta?.focus !== undefined)
      next.focus = clamp01(next.focus + delta.focus);
  }
  if (capabilities.relationshipDynamics) {
    const scale = capabilities.relationshipDeltaScale;
    const relationship = applyRelationshipDelta(
      {
        userId: next.relationship.userId,
        closeness: next.relationship.closeness,
        trust: next.relationship.trust,
        familiarity: next.relationship.familiarity,
        recentInteractionValence: next.relationship.recentInteractionValence,
        ...(next.relationship.lastInteractionAtUtc
          ? { lastInteractionAtUtc: next.relationship.lastInteractionAtUtc }
          : {}),
      },
      {
        ...(relationshipDelta?.closeness === undefined
          ? {}
          : { closeness: relationshipDelta.closeness * scale }),
        ...(relationshipDelta?.trust === undefined
          ? {}
          : { trust: relationshipDelta.trust * scale }),
        familiarity: (relationshipDelta?.familiarity ?? 0.006) * scale,
        ...(relationshipDelta?.recentInteractionValence === undefined
          ? {}
          : {
              recentInteractionValence:
                relationshipDelta.recentInteractionValence * scale,
            }),
      },
      nowUtc,
    ).state;
    next.relationship = relationship;
  }
  next.asOfUtc = nowUtc;
  next.revision += 1;
  return next;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
