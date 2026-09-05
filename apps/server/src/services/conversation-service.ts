import { DateTime } from "luxon";
import type { MemoryRecallRuntimeDiagnostic } from "@personasim/contracts";
import {
  DEFAULT_CONVERSATION_RETENTION_POLICY,
  assembleChatPrompt,
  selectConversationRetention,
  type ConversationRetentionPolicy,
} from "@personasim/features";

import type {
  DatabaseStore,
  StoredMessage,
  StoredSession,
} from "../db/store.js";
import { capabilitiesForRuntime } from "../domain/capabilities.js";
import { ApiError, notFound } from "../domain/errors.js";
import { createEntityId } from "../domain/id.js";
import { chatMessageInputSchema } from "../domain/schemas.js";
import {
  toFeatureScheduleItems,
  toFeatureState,
} from "../domain/feature-adapters.js";
import type { Clock } from "../runtime/clock.js";
import type { SseHub } from "../sse/hub.js";
import type { ConversationContextService } from "./conversation-context-service.js";
import {
  applyExplicitFactReplyGuard,
  buildExplicitFactReplyContract,
  explicitFactReplyEffectContext,
  finalizeExplicitFactWorld,
} from "./explicit-fact-reply-guard.js";
import type { FuzzyLifeService } from "./fuzzy-life-service.js";
import { calculateLlmPromptTokenBudget } from "./llm-prompt-headroom.js";
import type { LlmService } from "./llm-service.js";
import { MemoryRecallService } from "./memory-recall-service.js";
import { readActiveMemories } from "./memory-service.js";
import { PersonalIntentService } from "./personal-intent-service.js";
import { ReplyRepairService } from "./reply-repair-service.js";
import type { ScheduleService } from "./schedule-service.js";
import type { SettlementService } from "./settlement-service.js";
import {
  TurnCommitService,
  buildMemoryRecallDiagnostic,
  type ChatTurnResult as CommittedChatTurnResult,
} from "./turn-commit-service.js";
import { TurnDecisionService } from "./turn-decision-service.js";
import {
  WorldEffectService,
  type ChatTurnDecisionPath,
} from "./world-effect-service.js";

export type { ChatTurnDecisionPath };
export type ChatTurnResult = CommittedChatTurnResult;

export interface ConversationServiceOptions {
  chatEffectsMode?: "off" | "gated";
  scheduleNegotiationMode?: "off" | "legacy" | "shadow" | "enforced";
  liveWorldEffectsMode?: "off" | "shadow" | "enforced";
  memoryRecallMode?: "legacy" | "shadow" | "enforced";
  lifePlanningMode?: "fuzzy" | "legacy_exact";
  conversationRetention?: ConversationRetentionPolicy;
}

export interface ConversationTurnCollaborators {
  replyRepairs?: ReplyRepairService;
  decisions?: TurnDecisionService;
  worldEffects?: WorldEffectService;
  commits?: TurnCommitService;
  fuzzyLife?: FuzzyLifeService;
}

/**
 * Coordinates a chat turn. Domain decisions, repair, world-effect preparation,
 * and durable commit are delegated to explicit collaborators.
 */
export class ConversationService {
  private readonly memoryRecalls: MemoryRecallService;
  private readonly decisions: TurnDecisionService;
  private readonly worldEffects: WorldEffectService;
  private readonly commits: TurnCommitService;
  private readonly fuzzyLife: FuzzyLifeService | undefined;

  constructor(
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly llm: LlmService,
    schedules: ScheduleService,
    private readonly settlements: SettlementService,
    sse: SseHub,
    private readonly options: ConversationServiceOptions = {},
    personalIntents?: PersonalIntentService,
    memoryRecalls?: MemoryRecallService,
    private readonly contexts?: ConversationContextService,
    collaborators: ConversationTurnCollaborators = {},
  ) {
    this.fuzzyLife = collaborators.fuzzyLife;
    const intentService =
      personalIntents ?? new PersonalIntentService(store, clock);
    this.memoryRecalls = memoryRecalls ?? new MemoryRecallService(store);
    const replyRepairs =
      collaborators.replyRepairs ?? new ReplyRepairService(llm);
    this.decisions =
      collaborators.decisions ??
      new TurnDecisionService(llm, schedules, replyRepairs, options);
    this.worldEffects =
      collaborators.worldEffects ??
      new WorldEffectService(
        store,
        schedules,
        this.decisions,
        replyRepairs,
        options,
      );
    this.commits =
      collaborators.commits ??
      new TurnCommitService(
        store,
        schedules,
        intentService,
        sse,
        contexts,
        options,
        this.fuzzyLife,
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
      title?.trim() || `\u4e0e${spec.identity.name}\u7684\u5bf9\u8bdd`,
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
      return this.commits.replay({
        turn: {
          userMessage: existing.userMessage,
          assistantMessage: existing.assistantMessage,
        },
        command: input,
      });
    }

    const fuzzyLifeEnabled = this.options.lifePlanningMode === "fuzzy";
    if (fuzzyLifeEnabled) {
      if (this.fuzzyLife === undefined) {
        throw new Error(
          "Fuzzy life mode requires a composed FuzzyLifeService.",
        );
      }
      this.fuzzyLife.advance(input.agentId);
    } else {
      await this.settlements.settleAndExtend(input.agentId);
    }
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
    const preparedContext = this.contexts?.prepare({
      agentId: input.agentId,
      userText: input.text,
      nowUtc,
      timezone: spec.identity.timezone,
    });
    const userMessageId = createEntityId("message");
    const assistantMessageId = createEntityId("message");
    const capabilities = capabilitiesForRuntime(
      spec.tier,
      fuzzyLifeEnabled ? "fuzzy" : "legacy_exact",
    );
    const schedule = capabilities.legacyExactSchedule
      ? this.store.listSchedule(input.agentId, {
          fromUtc: nowUtc,
          toUtc: DateTime.fromISO(nowUtc).plus({ hours: 72 }).toUTC().toISO()!,
        })
      : [];
    const legacyMemories = capabilities.longTermMemory
      ? readActiveMemories(this.store, input.agentId, nowUtc)
      : [];
    const memoryRecallMode = this.options.memoryRecallMode ?? "legacy";
    const recallRecording =
      capabilities.longTermMemory && memoryRecallMode !== "legacy"
        ? this.memoryRecalls.preparePreviewRecording({
            agentId: input.agentId,
            sessionId,
            query: input.text,
            nowUtc,
            timezone: spec.identity.timezone,
            requireDurableEvidence: memoryRecallMode === "enforced",
          })
        : undefined;
    const recallPreview = recallRecording?.preview;
    const selectedRecallMemories =
      memoryRecallMode === "enforced" && recallPreview !== undefined
        ? recallPreview.result.selectedMemoryIds.map((id) => ({ id }))
        : legacyMemories;
    const memories =
      memoryRecallMode === "enforced" && recallPreview !== undefined
        ? []
        : legacyMemories;
    const memoryEvidence =
      memoryRecallMode === "enforced" &&
      recallPreview !== undefined &&
      !recallPreview.result.abstained
        ? recallPreview.result.evidenceBundle
        : undefined;
    const recallDiagnostic: MemoryRecallRuntimeDiagnostic | undefined =
      recallPreview === undefined
        ? undefined
        : buildMemoryRecallDiagnostic(
            memoryRecallMode,
            legacyMemories,
            selectedRecallMemories,
            recallPreview,
          );
    const explicitFactReplyContract =
      memoryRecallMode === "enforced"
        ? buildExplicitFactReplyContract({
            userText: input.text,
            ...(recallRecording === undefined
              ? {}
              : { recall: recallRecording.retrievalRun }),
          })
        : undefined;
    const contextSelection = selectConversationRetention({
      messages: this.store.listMessagesForContext(sessionId).map((message) => ({
        id: message.id,
        role: message.role,
        text: message.content,
        createdAtUtc: message.createdAtUtc,
        origin:
          message.messageKind === "assistant_proactive"
            ? "proactive"
            : message.role === "user"
              ? "user"
              : message.messageKind === "system_notice"
                ? "deterministic_fallback"
                : "reactive",
        stored: message,
      })),
      nowUtc,
      policy:
        this.options.conversationRetention ??
        DEFAULT_CONVERSATION_RETENTION_POLICY,
    });
    const recentMessages = contextSelection.messages.map((message) => ({
      ...message.stored,
      content: message.text,
    }));
    const effects = this.worldEffects.prepareDecisionContext({
      sessionId,
      nowUtc,
      userText: input.text,
      spec,
      capabilities,
      providerName: this.llm.providerName,
    });
    const turnEffectContext =
      explicitFactReplyContract === undefined
        ? effects
        : explicitFactReplyEffectContext();
    const lifeContext = fuzzyLifeEnabled
      ? this.fuzzyLife!.promptContext(input.agentId, nowUtc)
      : undefined;
    const assembledPrompt = assembleChatPrompt({
      character: spec,
      state: toFeatureState(state),
      ...(preparedContext?.autobiography === undefined
        ? {}
        : { autobiography: preparedContext.autobiography }),
      ...(preparedContext === undefined
        ? {}
        : {
            calendarContext: preparedContext.calendarContext,
            ...(preparedContext.continuity.careCues.length === 0
              ? {}
              : {
                  followUpContext: {
                    careCues: preparedContext.continuity.careCues,
                  },
                }),
            additionalPromptSegments: preparedContext.additionalPromptSegments,
          }),
      maxInputTokens: calculateLlmPromptTokenBudget(this.llm.capabilities),
      schedule: toFeatureScheduleItems(schedule),
      memories,
      ...(memoryEvidence === undefined ? {} : { memoryEvidence }),
      recentMessages: recentMessages.map((message) => ({
        role: message.role === "system" ? "assistant" : message.role,
        content: message.content,
        createdAtUtc: message.createdAtUtc,
      })),
      nowUtc,
      userMessage: input.text,
      ...(this.options.lifePlanningMode === undefined
        ? {}
        : { lifePlanningMode: this.options.lifePlanningMode }),
      ...(lifeContext === undefined ? {} : { lifeContext }),
      decisionMode: turnEffectContext.scheduleNegotiationEligible
        ? this.options.scheduleNegotiationMode === "shadow"
          ? "schedule_negotiation_shadow"
          : "schedule_negotiation"
        : turnEffectContext.effectsEligible
          ? "legacy_effects"
          : "reply_only",
      ...(this.options.liveWorldEffectsMode === undefined
        ? {}
        : { liveWorldEffectsMode: this.options.liveWorldEffectsMode }),
    });
    const decidedTurn = await this.decisions.decide({
      spec,
      userText: input.text,
      agentId: input.agentId,
      nowUtc,
      capabilities,
      system: assembledPrompt.system,
      prompt: assembledPrompt.prompt,
      ...(lifeContext === undefined ? {} : { causalContext: lifeContext }),
      replyStrategy: assembledPrompt.replyStrategy,
      schedule,
      effects: turnEffectContext,
    });
    const candidateTurn = fuzzyLifeEnabled
      ? {
          ...decidedTurn,
          decision: {
            ...decidedTurn.decision,
            scheduleEffects: [],
            personalIntentCandidates: [],
          },
        }
      : decidedTurn;
    const turn =
      explicitFactReplyContract === undefined
        ? candidateTurn
        : applyExplicitFactReplyGuard({
            turn: candidateTurn,
            contract: explicitFactReplyContract,
            inspectDecision: (decision) =>
              this.decisions.inspect({
                agentId: input.agentId,
                spec,
                decision,
                nowUtc,
                capabilities,
                userText: input.text,
                ...(lifeContext === undefined
                  ? {}
                  : { causalContext: lifeContext }),
              }),
          });
    const preparedWorld = await this.worldEffects.resolve({
      sessionId,
      agentId: input.agentId,
      userText: input.text,
      userMessageId,
      clientMessageId: input.clientMessageId,
      assistantMessageId,
      nowUtc,
      spec,
      state,
      capabilities,
      recentMessages,
      replyStrategy: assembledPrompt.replyStrategy,
      effects: turnEffectContext,
      turn,
    });
    const world =
      explicitFactReplyContract === undefined
        ? preparedWorld
        : finalizeExplicitFactWorld({
            world: preparedWorld,
            contract: explicitFactReplyContract,
          });
    return this.commits.commit({
      sessionId,
      command: input,
      spec,
      nowUtc,
      userMessageId,
      ...(recallRecording === undefined
        ? {}
        : { retrievalRun: recallRecording.retrievalRun }),
      assistantMessageId,
      capabilities,
      ...(recallDiagnostic === undefined ? {} : { recallDiagnostic }),
      promptSegmentTrace: assembledPrompt.segmentTrace,
      ...(preparedContext === undefined ? {} : { preparedContext }),
      turn,
      world,
    });
  }
}
