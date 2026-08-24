import { DateTime } from "luxon";
import type {
  ContextPlan,
  MemoryRecallQuery,
  MemoryRecallRuntimeDiagnostic,
} from "@personasim/contracts";
import {
  DEFAULT_CONVERSATION_RETENTION_POLICY,
  assembleChatPrompt,
  buildPlannedPersonaContext,
  deriveReplyStrategy,
  recallExactEntityAnchors,
  recallExactIdentifierAnchors,
  selectConversationRetention,
  type ConversationRetentionPolicy,
  type ScheduleCapability,
} from "@personasim/features";

import type {
  DatabaseStore,
  StoredMessage,
  StoredSession,
} from "../db/store.js";
import { capabilitiesForTier } from "../domain/capabilities.js";
import { ApiError, notFound } from "../domain/errors.js";
import { createEntityId } from "../domain/id.js";
import {
  chatMessageInputSchema,
  type CharacterSpec,
  type RuntimeState,
  type ScheduleItem,
} from "../domain/schemas.js";
import {
  toFeatureScheduleItems,
  toFeatureState,
} from "../domain/feature-adapters.js";
import type { Clock } from "../runtime/clock.js";
import type { SseHub } from "../sse/hub.js";
import type { ConversationContextService } from "./conversation-context-service.js";
import { ContextPlanService } from "./context-plan-service.js";
import { calculateLlmPromptTokenBudget } from "./llm-prompt-headroom.js";
import type { LlmService } from "./llm-service.js";
import { MemoryRecallService } from "./memory-recall-service.js";
import {
  classifyMemoryEpistemicStatus,
  isMemoryEpistemicStatus,
  isUserFactRecallRequest,
  isUserMemorySummaryRequest,
} from "./memory-epistemic.js";
import {
  readActiveMemories,
  readActiveMemoryRecords,
} from "./memory-service.js";
import { PersonalIntentService } from "./personal-intent-service.js";
import { ReplyRepairService } from "./reply-repair-service.js";
import {
  ReplyGenerationService,
  type GeneratedPersonaReply,
} from "./reply-generation-service.js";
import type { ScheduleService } from "./schedule-service.js";
import type { SettlementService } from "./settlement-service.js";
import {
  TurnCommitService,
  buildMemoryRecallDiagnostic,
  type ChatTurnResult as CommittedChatTurnResult,
  type TurnPipelineShadowComparison,
} from "./turn-commit-service.js";
import { TurnDecisionService } from "./turn-decision-service.js";
import {
  TurnExecutionService,
  allowsHistoricalCommittedSharedEntityRead,
  type ValidatedTurnOutcome,
} from "./turn-execution-service.js";
import {
  TurnUnderstandingService,
  type ResolvedTurnObservation,
} from "./turn-understanding-service.js";
import {
  WorldEffectService,
  type ChatTurnDecisionPath,
  type PreparedWorldEffectTurn,
} from "./world-effect-service.js";

export type { ChatTurnDecisionPath };
export type ChatTurnResult = CommittedChatTurnResult;

export interface ConversationServiceOptions {
  chatEffectsMode?: "off" | "gated";
  turnPipelineMode?: "legacy" | "shadow" | "enforced";
  personaContextMode?: "legacy" | "shadow" | "enforced";
  scheduleNegotiationMode?: "legacy" | "shadow" | "enforced";
  liveWorldEffectsMode?: "off" | "shadow" | "enforced";
  memoryRecallMode?: "legacy" | "shadow" | "enforced";
  conversationRetention?: ConversationRetentionPolicy;
}

export interface ConversationTurnCollaborators {
  replyRepairs?: ReplyRepairService;
  decisions?: TurnDecisionService;
  worldEffects?: WorldEffectService;
  commits?: TurnCommitService;
  turnUnderstandings?: TurnUnderstandingService;
  turnExecutions?: TurnExecutionService;
  contextPlans?: ContextPlanService;
  replyGenerations?: ReplyGenerationService;
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
  private readonly turnUnderstandings: TurnUnderstandingService;
  private readonly turnExecutions: TurnExecutionService;
  private readonly contextPlans: ContextPlanService;
  private readonly replyGenerations: ReplyGenerationService;

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
      );
    this.turnUnderstandings =
      collaborators.turnUnderstandings ?? new TurnUnderstandingService(llm);
    this.turnExecutions =
      collaborators.turnExecutions ??
      new TurnExecutionService(store, schedules, options);
    this.contextPlans = collaborators.contextPlans ?? new ContextPlanService();
    this.replyGenerations =
      collaborators.replyGenerations ??
      new ReplyGenerationService(llm, replyRepairs);
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
    const turnStartedAtMs = performance.now();
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
    const preparedContext = this.contexts?.prepare({
      agentId: input.agentId,
      userText: input.text,
      nowUtc,
      timezone: spec.identity.timezone,
    });
    const userMessageId = createEntityId("message");
    const assistantMessageId = createEntityId("message");
    const capabilities = capabilitiesForTier(spec.tier);
    const schedule = capabilities.schedule
      ? this.store.listSchedule(input.agentId, {
          fromUtc: nowUtc,
          toUtc: DateTime.fromISO(nowUtc).plus({ hours: 72 }).toUTC().toISO()!,
        })
      : [];
    const legacyMemories = capabilities.longTermMemory
      ? readActiveMemories(this.store, input.agentId, nowUtc)
      : [];
    const knownUserMemoryContents = capabilities.longTermMemory
      ? readActiveMemoryRecords(this.store, input.agentId, nowUtc, 500)
          .filter(
            (memory) =>
              memory.status === "active" &&
              memory.namespace === "user_model" &&
              memory.certainty === "explicit" &&
              memory.attribution === "user_explicit",
          )
          .map((memory) => memory.content)
      : [];
    // These contents only disambiguate bare entity queries. Reply authorization
    // still comes exclusively from the selected, verified evidence IDs below.
    const memoryRecallMode = this.options.memoryRecallMode ?? "legacy";
    const recallRecording =
      capabilities.longTermMemory && memoryRecallMode !== "legacy"
        ? this.memoryRecalls.preparePreviewRecording({
            agentId: input.agentId,
            sessionId,
            query: memoryRecallQueryForTurn(
              input.text,
              knownUserMemoryContents,
            ),
            nowUtc,
            timezone: spec.identity.timezone,
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
    const recentUserFactEvidence = selectSafeRecentUserFactEvidence(
      input.text,
      recentMessages,
    );
    const memoryReplyPolicy = buildMemoryReplyPolicy({
      userText: input.text,
      memoryRecallMode,
      recallResult: recallPreview?.result,
      recentUserFactEvidence,
      knownUserMemoryContents,
    });
    const promptMessages = recentMessages.map((message) => ({
      role: message.role === "system" ? ("assistant" as const) : message.role,
      content: message.content,
      createdAtUtc: message.createdAtUtc,
    }));
    const activeNegotiation = this.turnExecutions.getActive(sessionId, nowUtc);
    const currentActivity = selectCurrentActivity(schedule, state, nowUtc);
    const scheduleCapability = scheduleCapabilityFor(
      spec,
      capabilities.schedule,
    );
    const prepareSplit = async (dryRun: boolean) => {
      const observation = await this.turnUnderstandings.understand({
        agentId: input.agentId,
        userText: input.text,
        nowUtc,
        timezone: spec.identity.timezone,
        state,
        scheduleCapability,
        ...(activeNegotiation === undefined ? {} : { activeNegotiation }),
        ...(currentActivity === undefined ? {} : { currentActivity }),
        authoritativeSchedule: schedule,
        recentMessages,
        ...(preparedContext === undefined
          ? {}
          : {
              careCueTexts: preparedContext.continuity.careCues.flatMap(
                (cue) => [cue.contextSummary, cue.mentionGuidance],
              ),
            }),
        ...(capabilities.longTermMemory
          ? {
              explicitMemoryPolicy:
                "Only propose memory candidates grounded in exact current-user evidence; an explicit remember request never proves persistence.",
            }
          : {}),
      });
      const historicalScheduleMatches =
        allowsHistoricalCommittedSharedEntityRead(observation) &&
        observation.scheduleFrame?.kind === "query_existing" &&
        observation.scheduleFrame.entityText !== undefined
          ? this.store.listAuthorizedHistoricalSharedSchedulesByEntity({
              agentId: input.agentId,
              entityText: observation.scheduleFrame.entityText,
              nowUtc,
              limit: 3,
            })
          : [];
      const executionSchedule = mergeScheduleItems(
        schedule,
        historicalScheduleMatches.map((match) => match.item),
      );
      const outcome = this.turnExecutions.execute({
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
        authoritativeSchedule: executionSchedule,
        ...(historicalScheduleMatches.length === 0
          ? {}
          : {
              historicalScheduleReadAuthorizations:
                historicalScheduleMatches.map((match) => match.authorization),
            }),
        observation,
        memoryReplyPolicy,
        ...(activeNegotiation === undefined ? {} : { activeNegotiation }),
        ...(dryRun ? { dryRun: true } : {}),
      });
      const contextPlan = this.contextPlans.build({
        character: spec,
        userText: input.text,
        outcome,
        ...(currentActivity === undefined
          ? {}
          : {
              currentActivity: {
                title: currentActivity.title,
                description: currentActivity.description,
                category: currentActivity.category,
              },
            }),
        ...(memoryEvidence === undefined
          ? {}
          : { retrievedEvidence: memoryEvidence }),
        ...(preparedContext === undefined
          ? {}
          : {
              careCueTexts: preparedContext.continuity.careCues.flatMap(
                (cue) => [cue.contextSummary, cue.mentionGuidance],
              ),
              segmentHints: {
                ...(preparedContext.calendarContext.length === 0
                  ? {}
                  : { calendarRelevant: true }),
              },
            }),
        recentAssistantMessages: recentMessages
          .filter((message) => message.role === "assistant")
          .map((message) => ({
            role: "assistant",
            content: message.content,
            metadata: message.metadata,
          })),
      });
      return { observation, outcome, contextPlan, executionSchedule };
    };

    const generateSplitReply = async (split: {
      outcome: ValidatedTurnOutcome;
      contextPlan: ContextPlan;
      executionSchedule: readonly ScheduleItem[];
    }): Promise<GeneratedPersonaReply> => {
      const replyStrategy = deriveReplyStrategy(input.text, spec.dialogue, {
        state: split.outcome.nextState,
      });
      return this.replyGenerations.generate({
        character: spec,
        state: split.outcome.nextState,
        schedule: toFeatureScheduleItems(split.executionSchedule),
        memories,
        ...(memoryEvidence === undefined ? {} : { memoryEvidence }),
        ...(recentUserFactEvidence.length === 0
          ? {}
          : {
              recentUserFactEvidence: recentUserFactEvidence.map((message) => ({
                role: "user" as const,
                content: message.content,
                createdAtUtc: message.createdAtUtc,
              })),
            }),
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
              additionalPromptSegments:
                preparedContext.additionalPromptSegments,
            }),
        recentMessages: promptMessages,
        nowUtc,
        userMessage: input.text,
        contextPlan: split.contextPlan,
        personaContextMode: this.options.personaContextMode ?? "legacy",
        validatedOutcome: split.outcome,
        replyStrategy,
        maxInputTokens: calculateLlmPromptTokenBudget(this.llm.capabilities),
      });
    };

    if ((this.options.turnPipelineMode ?? "legacy") === "enforced") {
      const split = await prepareSplit(false);
      const generated = await generateSplitReply(split);
      return this.commits.commitSplit({
        sessionId,
        command: input,
        spec,
        nowUtc,
        turnStartedAtMs,
        expectedStateRevision: state.revision,
        userMessageId,
        ...(recallRecording === undefined
          ? {}
          : { retrievalRun: recallRecording.retrievalRun }),
        assistantMessageId,
        capabilities,
        ...(recallDiagnostic === undefined ? {} : { recallDiagnostic }),
        ...(preparedContext === undefined ? {} : { preparedContext }),
        observation: split.observation,
        outcome: split.outcome,
        reply: generated.reply,
        replyAudit: {
          repairAttempted: generated.repairAttempted,
          usedFallback: generated.usedFallback,
          issueCodes: generated.issues.map((issue) => issue.code),
          promptSegmentTrace: generated.promptSegmentTrace ?? [],
        },
        contextPlanTrace: split.contextPlan,
      });
    }

    let splitShadow:
      | {
          observation: ResolvedTurnObservation;
          outcome: ValidatedTurnOutcome;
          contextPlan: ContextPlan;
          reply?: GeneratedPersonaReply;
        }
      | undefined;
    const splitFailures: string[] = [];
    if (this.options.turnPipelineMode === "shadow") {
      try {
        const prepared = await prepareSplit(true);
        splitShadow = prepared;
        try {
          splitShadow = {
            ...prepared,
            reply: await generateSplitReply(prepared),
          };
        } catch (error) {
          splitFailures.push(`reply_generation:${shadowFailureCode(error)}`);
        }
      } catch (error) {
        splitFailures.push(shadowFailureCode(error));
      }
    }

    let contextPlanTrace =
      this.options.personaContextMode === "shadow" ||
      this.options.personaContextMode === "enforced"
        ? undefined
        : splitShadow?.contextPlan;
    if (
      this.options.personaContextMode === "shadow" ||
      this.options.personaContextMode === "enforced"
    ) {
      try {
        contextPlanTrace = this.contextPlans.build({
          character: spec,
          userText: input.text,
          ...(currentActivity === undefined
            ? {}
            : {
                currentActivity: {
                  title: currentActivity.title,
                  description: currentActivity.description,
                  category: currentActivity.category,
                },
              }),
          ...(memoryEvidence === undefined
            ? {}
            : { retrievedEvidence: memoryEvidence }),
          ...(preparedContext === undefined
            ? {}
            : {
                careCueTexts: preparedContext.continuity.careCues.flatMap(
                  (cue) => [cue.contextSummary, cue.mentionGuidance],
                ),
                segmentHints: {
                  ...(preparedContext.calendarContext.length === 0
                    ? {}
                    : { calendarRelevant: true }),
                },
              }),
          recentAssistantMessages: recentMessages
            .filter((message) => message.role === "assistant")
            .map((message) => ({
              role: "assistant",
              content: message.content,
              metadata: message.metadata,
            })),
        });
      } catch (error) {
        splitFailures.push(`context_plan:${shadowFailureCode(error)}`);
      }
    }

    const effects = this.worldEffects.prepareDecisionContext({
      sessionId,
      nowUtc,
      userText: input.text,
      spec,
      capabilities,
      providerName: this.llm.providerName,
    });
    const legacyRepairPersonaContext =
      this.options.personaContextMode === "enforced" &&
      contextPlanTrace !== undefined
        ? buildPlannedPersonaContext(spec, contextPlanTrace)
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
      recentMessages: promptMessages,
      nowUtc,
      userMessage: input.text,
      decisionMode: effects.scheduleNegotiationEligible
        ? this.options.scheduleNegotiationMode === "shadow"
          ? "schedule_negotiation_shadow"
          : "schedule_negotiation"
        : effects.effectsEligible
          ? "legacy_effects"
          : "reply_only",
      ...(this.options.liveWorldEffectsMode === undefined
        ? {}
        : { liveWorldEffectsMode: this.options.liveWorldEffectsMode }),
      personaContextMode: this.options.personaContextMode ?? "legacy",
      ...(contextPlanTrace === undefined
        ? {}
        : { contextPlan: contextPlanTrace }),
    });
    const turn = await this.decisions.decide({
      spec,
      userText: input.text,
      agentId: input.agentId,
      nowUtc,
      capabilities,
      system: assembledPrompt.system,
      prompt: assembledPrompt.prompt,
      replyStrategy: assembledPrompt.replyStrategy,
      schedule,
      effects,
      ...(legacyRepairPersonaContext === undefined
        ? {}
        : { repairPersonaContext: legacyRepairPersonaContext }),
    });
    const world = await this.worldEffects.resolve({
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
      effects,
      turn,
      ...(legacyRepairPersonaContext === undefined
        ? {}
        : { repairPersonaContext: legacyRepairPersonaContext }),
    });
    const pipelineShadowComparison =
      this.options.turnPipelineMode === "shadow"
        ? compareTurnPipelines(
            world,
            turn.scheduleAction.kind,
            splitShadow,
            splitFailures,
          )
        : undefined;
    return this.commits.commit({
      sessionId,
      command: input,
      spec,
      nowUtc,
      turnStartedAtMs,
      userMessageId,
      ...(recallRecording === undefined
        ? {}
        : { retrievalRun: recallRecording.retrievalRun }),
      assistantMessageId,
      capabilities,
      ...(recallDiagnostic === undefined ? {} : { recallDiagnostic }),
      promptSegmentTrace: assembledPrompt.segmentTrace,
      ...(pipelineShadowComparison === undefined
        ? {}
        : { pipelineShadowComparison }),
      ...(contextPlanTrace === undefined ? {} : { contextPlanTrace }),
      ...(preparedContext === undefined ? {} : { preparedContext }),
      turn,
      world,
    });
  }
}

function memoryRecallQueryForTurn(
  text: string,
  knownUserMemoryContents: readonly string[],
): string | MemoryRecallQuery {
  if (isUserMemorySummaryRequest(text)) {
    return {
      query: text,
      namespaces: ["user_model"],
      purpose: "user_memory_summary",
    };
  }
  if (isUserFactRecallRequest(text, { knownUserMemoryContents })) {
    return {
      query: text,
      namespaces: ["user_model"],
      purpose: "user_fact_query",
    };
  }
  return text;
}

function buildMemoryReplyPolicy(input: {
  userText: string;
  memoryRecallMode: "legacy" | "shadow" | "enforced";
  recallResult: ReturnType<MemoryRecallService["recall"]> | undefined;
  recentUserFactEvidence: readonly StoredMessage[];
  knownUserMemoryContents: readonly string[];
}): {
  evidenceOnly: boolean;
  mustAbstain: boolean;
  mustNotInferFromPersona: boolean;
  allowedEvidenceIds: string[];
} {
  const summary = isUserMemorySummaryRequest(input.userText);
  const selectedUserMemoryContents =
    input.recallResult === undefined || input.recallResult.abstained
      ? []
      : input.recallResult.evidenceBundle.evidence
          .filter(
            (item) =>
              item.namespace === "user_model" &&
              item.certainty === "explicit" &&
              item.attribution === "user_explicit",
          )
          .map((item) => item.memoryContent);
  const userFactQuery = isUserFactRecallRequest(input.userText, {
    knownUserMemoryContents: [
      ...input.knownUserMemoryContents,
      ...selectedUserMemoryContents,
    ],
  });
  const authoritativeMode = input.memoryRecallMode === "enforced";
  const memoryRequest = summary || userFactQuery;
  const selectedEvidenceIds =
    input.recallResult === undefined || input.recallResult.abstained
      ? []
      : input.recallResult.selectedEvidenceIds;
  const recentSupport = !summary && input.recentUserFactEvidence.length > 0;
  return {
    evidenceOnly: authoritativeMode && summary,
    mustAbstain:
      authoritativeMode &&
      memoryRequest &&
      selectedEvidenceIds.length === 0 &&
      !recentSupport,
    mustNotInferFromPersona: authoritativeMode && memoryRequest,
    allowedEvidenceIds: authoritativeMode ? [...selectedEvidenceIds] : [],
  };
}

function selectSafeRecentUserFactEvidence(
  userText: string,
  recentMessages: readonly StoredMessage[],
): StoredMessage[] {
  const userMessages = recentMessages.filter(
    (message) => message.role === "user",
  );
  const lastRetractionIndex = userMessages.findLastIndex(
    (message) => recentMessageEpistemicStatus(message) === "retracted",
  );
  const safeUserMessages = userMessages
    .slice(lastRetractionIndex + 1)
    .filter(
      (message) => recentMessageEpistemicStatus(message) === "asserted_fact",
    );
  if (safeUserMessages.length === 0) return [];
  if (/(?:刚才|前面|上一条|上条)/u.test(userText)) {
    return safeUserMessages.slice(-1);
  }
  const anchors = [
    ...recallExactIdentifierAnchors(userText),
    ...recallExactEntityAnchors(userText),
  ];
  if (anchors.length === 0) return [];
  return safeUserMessages.filter((message) =>
    anchors.every((anchor) =>
      message.content
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes(anchor.normalize("NFKC").toLocaleLowerCase()),
    ),
  );
}

function recentMessageEpistemicStatus(
  message: StoredMessage,
): ReturnType<typeof classifyMemoryEpistemicStatus> {
  const storedStatus = message.metadata["epistemicStatus"];
  return isMemoryEpistemicStatus(storedStatus)
    ? storedStatus
    : classifyMemoryEpistemicStatus(message.content);
}

function scheduleCapabilityFor(
  spec: CharacterSpec,
  scheduleEnabled: boolean,
): ScheduleCapability {
  if (!scheduleEnabled || !spec.schedulePolicy.enabled) return "none";
  return spec.tier === "high_fidelity" ? "read_write" : "read_only";
}

function selectCurrentActivity(
  schedule: readonly ScheduleItem[],
  state: RuntimeState,
  nowUtc: string,
): ScheduleItem | undefined {
  if (state.currentActivityId !== undefined) {
    const selected = schedule.find(
      (item) =>
        item.id === state.currentActivityId && item.status !== "cancelled",
    );
    if (selected !== undefined) return selected;
  }
  const now = DateTime.fromISO(nowUtc).toMillis();
  return schedule.find(
    (item) =>
      item.status !== "cancelled" &&
      DateTime.fromISO(item.startAtUtc).toMillis() <= now &&
      DateTime.fromISO(item.endAtUtc).toMillis() > now,
  );
}

function mergeScheduleItems(
  primary: readonly ScheduleItem[],
  additional: readonly ScheduleItem[],
): ScheduleItem[] {
  const byId = new Map(primary.map((item) => [item.id, item]));
  for (const item of additional) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()];
}

function compareTurnPipelines(
  legacy: PreparedWorldEffectTurn,
  legacyScheduleAction: string,
  split:
    | {
        observation: ResolvedTurnObservation;
        outcome: ValidatedTurnOutcome;
        reply?: GeneratedPersonaReply;
      }
    | undefined,
  failures: readonly string[],
): TurnPipelineShadowComparison {
  const comparison: TurnPipelineShadowComparison = {
    legacyDecisionPath: legacy.decisionPath,
    legacyScheduleAction,
    legacyAcceptedEffectKinds: legacyAcceptedEffectKinds(legacy),
    splitAcceptedEffectKinds:
      split === undefined ? [] : splitAcceptedEffectKinds(split.outcome),
    nextStateFieldDiffs:
      split === undefined
        ? []
        : stateFieldDiffs(legacy.nextState, split.outcome.nextState),
    splitFailures: [...new Set(failures)].slice(0, 12),
    ...(split === undefined
      ? {}
      : {
          splitRoute: split.observation.route,
          splitObservationConfidence: split.observation.confidence,
          splitObservationRejectedFields: split.observation.rejectedFields
            .slice(0, 12)
            .map((rejection) => ({
              field: categoricalShadowField(rejection.field),
              reasonCode: categoricalShadowFailureCode(rejection.reasonCode),
            })),
          splitScheduleIntent: split.observation.scheduleIntent.kind,
          splitScheduleOutcomeKind: split.outcome.scheduleOutcome.kind,
          splitUnderstandingOrigin: split.observation.origin,
          splitProposalRejectionCodes: uniqueSafeCodes(
            split.outcome.proposalRejections.map(
              (rejection) => rejection.reasonCode,
            ),
          ),
          legacyObjectiveReplyAligned: replyAlignsWithObjective(
            split.outcome,
            legacy.decision.reply.text,
          ),
          ...(split.reply === undefined
            ? { splitReplyStatus: "failed" as const }
            : {
                splitReplyStatus: split.reply.usedFallback
                  ? ("fallback" as const)
                  : split.reply.repairAttempted
                    ? ("repaired" as const)
                    : ("generated" as const),
                splitReplyRepairAttempted: split.reply.repairAttempted,
                splitReplyUsedFallback: split.reply.usedFallback,
                splitReplyIssueCodes: uniqueSafeCodes(
                  split.reply.issues.map((issue) => issue.code),
                ),
                splitObjectiveReplyAligned: replyAlignsWithObjective(
                  split.outcome,
                  split.reply.reply.text,
                ),
              }),
        }),
  };
  return comparison;
}

function replyAlignsWithObjective(
  outcome: ValidatedTurnOutcome,
  replyText: string,
): boolean {
  const anchors = [
    ...outcome.replyDirectives.mustAddressUserQuotes,
    ...outcome.replyDirectives.authoritativeFacts.map((fact) => fact.text),
  ];
  if (anchors.length === 0) return true;
  const normalizedReply = normalizeAlignmentText(replyText);
  return anchors.some((anchor) => {
    const normalizedAnchor = normalizeAlignmentText(anchor);
    if (normalizedAnchor === "") return false;
    if (normalizedReply.includes(normalizedAnchor)) return true;
    const tokens = normalizedAnchor.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
    return tokens.some((token) => normalizedReply.includes(token));
  });
}

function normalizeAlignmentText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function uniqueSafeCodes(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .map((value) => value.trim().toLocaleLowerCase())
        .filter((value) => /^[a-z][a-z0-9_]{0,63}$/u.test(value)),
    ),
  ].slice(0, 12);
}

function legacyAcceptedEffectKinds(world: PreparedWorldEffectTurn): string[] {
  const kinds: string[] = [];
  if (world.validation.accepted.length > 0) kinds.push("schedule");
  if (world.decision.stateDelta !== undefined) kinds.push("state_delta");
  if (world.decision.relationshipDelta !== undefined) {
    kinds.push("relationship_delta");
  }
  if (world.decision.memoryCandidates.length > 0) {
    kinds.push("memory_candidate");
  }
  if ((world.decision.personalIntentCandidates?.length ?? 0) > 0) {
    kinds.push("personal_intent_candidate");
  }
  return kinds;
}

function splitAcceptedEffectKinds(outcome: ValidatedTurnOutcome): string[] {
  const kinds: string[] = [];
  if (outcome.validation.accepted.length > 0) kinds.push("schedule");
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
  return kinds;
}

function stateFieldDiffs(legacy: RuntimeState, split: RuntimeState): string[] {
  const keys = new Set([...Object.keys(legacy), ...Object.keys(split)]);
  return [...keys]
    .filter(
      (key) =>
        JSON.stringify(legacy[key as keyof RuntimeState]) !==
        JSON.stringify(split[key as keyof RuntimeState]),
    )
    .sort()
    .slice(0, 32);
}

function shadowFailureCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return categoricalShadowFailureCode(error.code);
  }
  if (error instanceof Error && error.name.trim() !== "") {
    return categoricalShadowFailureCode(
      error.name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLocaleLowerCase(),
    );
  }
  return "unknown_split_failure";
}

function categoricalShadowFailureCode(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/u.test(normalized)
    ? normalized
    : "non_categorical_split_failure";
}

function categoricalShadowField(value: string): string {
  const normalized = value.trim().toLocaleLowerCase();
  return /^[a-z][a-z0-9_]{0,63}$/u.test(normalized)
    ? normalized
    : "non_categorical_field";
}
