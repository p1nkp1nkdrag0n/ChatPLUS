import { DateTime } from "luxon";
import {
  PersonaChatResponseSchema,
  type PersonaChatResponse,
} from "@personasim/contracts";
import {
  applyRelationshipDelta,
  assembleChatPrompt,
  createSafeFallbackReply,
  guardPersonaReply,
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
  ProposalValidation,
  ScheduleService,
} from "./schedule-service.js";
import type { SettlementService } from "./settlement-service.js";

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
  constructor(
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
    private readonly llm: LlmService,
    private readonly schedules: ScheduleService,
    private readonly settlements: SettlementService,
    private readonly sse: SseHub,
  ) {}

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
    const fixture = fixtureDecision(spec, schedule, input.text, nowUtc);
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
          });
    const { decision, inspection, repairAttempted } = turn;
    const validation = inspection.validation;

    const userMessage: StoredMessage = {
      id: createEntityId("message"),
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
      id: createEntityId("message"),
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
    let scheduleChanges: ScheduleItem[] = [];
    let memoryIds: string[] = [];
    try {
      this.store.transaction(() => {
        const duplicate = this.store.findTurnByClientMessageId(
          sessionId,
          input.clientMessageId,
        );
        if (duplicate) throw new DuplicateTurnError(duplicate);
        this.store.insertMessage(userMessage);
        scheduleChanges = this.schedules.applyValidatedEffects(
          input.agentId,
          validation.valid ? validation.effects : [],
          nowUtc,
        );
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
        this.store.insertDomainEvent({
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
        });
      });
    } catch (error) {
      if (error instanceof DuplicateTurnError) {
        const stored = error.turn;
        if (!stored.assistantMessage) throw error;
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
    let initialIssues: unknown = [];
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
      inspection = inspectDecision(
        this.schedules,
        input.agentId,
        input.spec,
        decision,
        input.nowUtc,
        input.capabilities,
      );
    }
    return { decision, inspection, repairAttempted };
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
  }): Promise<ResolvedTurn> {
    let response: PersonaChatResponse | undefined;
    let initialIssues: unknown = [];
    try {
      const candidate = await this.llm.generateObject({
        purpose: "chat_turn",
        agentId: input.agentId,
        system: input.system,
        prompt: input.prompt,
        schema: PersonaChatResponseSchema,
        maxOutputTokens: input.replyStrategy.maxOutputTokens,
      });
      response = PersonaChatResponseSchema.parse(candidate);
    } catch (error) {
      initialIssues = invalidOutputIssues(error);
    }

    let decision = response
      ? materializePersonaReply(response, input.spec, input.replyStrategy)
      : safePersonaDecision(input.spec);
    let inspection = response
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
    if (!response || !inspection || inspection.issues.length > 0) {
      repairAttempted = true;
      const repaired = await this.tryRepairPersonaReply(
        input.spec,
        input.userText,
        response,
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
      }
    }
    if (!inspection || inspection.issues.length > 0) {
      decision = safePersonaDecision(input.spec);
      inspection = inspectDecision(
        this.schedules,
        input.agentId,
        input.spec,
        decision,
        input.nowUtc,
        input.capabilities,
      );
    }
    return { decision, inspection, repairAttempted };
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
): { validation: ProposalValidation; issues: unknown[] } {
  const validation = schedules.validateEffects(
    agentId,
    decision.scheduleEffects,
    nowUtc,
  );
  const issues: unknown[] = [];
  if (!validation.valid) issues.push(...validation.issues);
  if (violatesTruthfulReply(decision)) {
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
      acceptedScheduleEffects: validation.valid
        ? toFeatureScheduleEffects(validation.effects)
        : [],
      reasonSummary: decision.reasonSummary,
    });
    if (!guarded.allowed) issues.push(...guarded.violations);
  }
  return { validation, issues };
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

function invalidOutputIssues(error: unknown): unknown[] {
  return [
    {
      code: "invalid_model_output",
      message: error instanceof Error ? error.message : "Invalid output",
    },
  ];
}

function violatesTruthfulReply(decision: AgentTurnDecision): boolean {
  if (decision.scheduleEffects.length > 0) return false;
  return /(?:已经|已|刚刚).{0,12}(?:修改|取消|移动|改(?:了|到|成)?|安排(?:好|了)?|加入).{0,12}(?:日程|计划|行程)|(?:i(?:'ve| have)) (?:rescheduled|cancelled|added .{0,12} to (?:my )?schedule)/iu.test(
    decision.reply.text,
  );
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
