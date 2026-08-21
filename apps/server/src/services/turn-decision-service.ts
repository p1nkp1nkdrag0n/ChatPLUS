import { DateTime } from "luxon";
import {
  MemoryCandidateSchema,
  PersonaChatDecisionSchema,
  PersonaChatResponseSchema,
  PersonaTurnProviderEnvelopeSchema,
  ScheduleEffectProposalSchema,
  type MemoryCandidate,
  type PersonaChatDecision,
  type PersonaChatResponse,
  type PersonaTurnProviderEnvelope,
  type ScheduleNegotiationAction,
} from "@personasim/contracts";
import {
  createSafeFallbackReply,
  guardPersonaReply,
  normalizeModelEffects,
  validateWorldEffects,
  type ModelEffectRejection,
  type ReplyStrategy,
  type ValidatedWorldEffects,
  type WorldEffectsValidationResult,
} from "@personasim/features";

import type { SimulationCapabilities } from "../domain/capabilities.js";
import { toFeatureScheduleEffects } from "../domain/feature-adapters.js";
import {
  agentTurnDecisionSchema,
  type AgentTurnDecision,
  type CharacterSpec,
  type ScheduleEffectProposal,
  type ScheduleItem,
} from "../domain/schemas.js";
import type { LlmService } from "./llm-service.js";
import type { ReplyRepairService } from "./reply-repair-service.js";
import type {
  PartialProposalValidation,
  ScheduleService,
} from "./schedule-service.js";
import {
  buildScheduleNegotiationContract,
  type ActiveScheduleNegotiation,
} from "./schedule-negotiation-service.js";

export interface TurnDecisionServiceOptions {
  chatEffectsMode?: "off" | "gated";
  liveWorldEffectsMode?: "off" | "shadow" | "enforced";
}

export interface TurnDecisionEffectContext {
  effectsEligible: boolean;
  scheduleNegotiationEligible: boolean;
  negotiationEnforced: boolean;
  activeNegotiation?: ActiveScheduleNegotiation;
}

export type DecisionInspection = {
  validation: PartialProposalValidation;
  issues: unknown[];
};

export type ResolvedTurn = {
  decision: AgentTurnDecision;
  inspection: DecisionInspection;
  repairAttempted: boolean;
  usedFallback: boolean;
  modelRejections: ModelEffectRejection[];
  scheduleAction: ScheduleNegotiationAction;
  continuityEffects?: unknown;
  worldEffectsAudit?: {
    mode: "shadow" | "enforced";
    validation: WorldEffectsValidationResult;
  };
};

/** Resolves provider output without writing durable state. */
export class TurnDecisionService {
  constructor(
    private readonly llm: LlmService,
    private readonly schedules: ScheduleService,
    private readonly repairs: ReplyRepairService,
    private readonly options: TurnDecisionServiceOptions = {},
  ) {}

  async decide(input: {
    spec: CharacterSpec;
    userText: string;
    agentId: string;
    nowUtc: string;
    capabilities: SimulationCapabilities;
    system: string;
    prompt: string;
    replyStrategy: ReplyStrategy;
    schedule: ScheduleItem[];
    effects: TurnDecisionEffectContext;
  }): Promise<ResolvedTurn> {
    if (this.llm.providerName === "fixture") {
      const rawFixture = fixtureDecision(
        input.spec,
        input.schedule,
        input.userText,
        input.nowUtc,
      );
      const fixture =
        (this.options.chatEffectsMode === "off" ||
          input.effects.negotiationEnforced) &&
        rawFixture.scheduleEffects.length > 0
          ? safeScheduleDecision(input.spec)
          : rawFixture;
      return this.decideFixtureTurn({ ...input, fixture });
    }
    return this.decidePersonaReply(input);
  }

  inspect(input: {
    agentId: string;
    spec: CharacterSpec;
    decision: AgentTurnDecision;
    nowUtc: string;
    capabilities: SimulationCapabilities;
  }): DecisionInspection {
    return inspectDecision(
      this.schedules,
      input.agentId,
      input.spec,
      input.decision,
      input.nowUtc,
      input.capabilities,
    );
  }

  materializeReply(
    response: PersonaChatResponse,
    spec: CharacterSpec,
    replyStrategy: ReplyStrategy,
  ): AgentTurnDecision {
    return materializePersonaReply(response, spec, replyStrategy);
  }

  safePersonaDecision(spec: CharacterSpec): AgentTurnDecision {
    return safePersonaDecision(spec);
  }

  attachValidatedWorldEffects(
    decision: AgentTurnDecision,
    effects: ValidatedWorldEffects | undefined,
  ): AgentTurnDecision {
    return attachValidatedWorldEffects(decision, effects);
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
    const continuityEnabled = this.options.liveWorldEffectsMode === "enforced";
    try {
      const providerDecision = await this.llm.generateObject({
        purpose: "chat_turn",
        agentId: input.agentId,
        system: input.system,
        prompt: input.prompt,
        schema: agentTurnDecisionSchema,
        ...(continuityEnabled ? {} : { fixture: input.fixture }),
      });
      // The server fixture owns deterministic schedule behavior. In enforced
      // continuity mode the canonical fixture provider still runs so grounded
      // continuity candidates survive without replacing that schedule fixture.
      decision = continuityEnabled
        ? {
            ...input.fixture,
            ...(providerDecision.continuityEffects === undefined
              ? {}
              : {
                  continuityEffects: providerDecision.continuityEffects,
                }),
          }
        : providerDecision;
    } catch (error) {
      initialIssues = invalidOutputIssues(error);
    }

    let inspection = decision
      ? this.inspect({
          agentId: input.agentId,
          spec: input.spec,
          decision,
          nowUtc: input.nowUtc,
          capabilities: input.capabilities,
        })
      : undefined;
    let repairAttempted = false;
    let usedFallback = false;
    if (!decision || !inspection || inspection.issues.length > 0) {
      repairAttempted = true;
      decision = await this.repairs.repairFixtureDecision({
        spec: input.spec,
        userText: input.userText,
        invalidDecision: decision,
        issues: inspection?.issues ?? initialIssues,
        fallback: safeScheduleDecision(input.spec),
      });
      inspection = this.inspect({
        agentId: input.agentId,
        spec: input.spec,
        decision,
        nowUtc: input.nowUtc,
        capabilities: input.capabilities,
      });
    }
    if (inspection.issues.length > 0) {
      decision = safeScheduleDecision(input.spec);
      usedFallback = true;
      inspection = this.inspect({
        agentId: input.agentId,
        spec: input.spec,
        decision,
        nowUtc: input.nowUtc,
        capabilities: input.capabilities,
      });
    }
    return {
      decision,
      inspection,
      repairAttempted,
      usedFallback,
      modelRejections: [],
      scheduleAction: { kind: "none" },
      ...(continuityEnabled && decision.continuityEffects !== undefined
        ? {
            continuityEffects: decision.continuityEffects,
          }
        : {}),
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
    schedule: ScheduleItem[];
    effects: TurnDecisionEffectContext;
  }): Promise<ResolvedTurn> {
    let decisionResponse: PersonaChatDecision | undefined;
    let replyResponse: PersonaChatResponse | undefined;
    let envelopeResponse: PersonaTurnProviderEnvelope | undefined;
    let initialIssues: unknown[] = [];
    const effectsContract = [
      ...(input.effects.scheduleNegotiationEligible
        ? [
            buildScheduleNegotiationContract({
              ...(input.effects.activeNegotiation === undefined
                ? {}
                : { active: input.effects.activeNegotiation }),
              timezone: input.spec.identity.timezone,
              nowUtc: input.nowUtc,
              legacyEffectsEnabled: input.effects.effectsEligible,
            }),
          ]
        : []),
      ...(input.effects.effectsEligible
        ? [
            buildScheduleEffectsContract(
              input.schedule,
              input.spec.identity.timezone,
            ),
          ]
        : []),
    ].join("\n");
    const worldEffectsEnabled =
      this.options.liveWorldEffectsMode !== undefined &&
      this.options.liveWorldEffectsMode !== "off";
    try {
      if (worldEffectsEnabled) {
        envelopeResponse = PersonaTurnProviderEnvelopeSchema.parse(
          await this.llm.generateObject({
            purpose: "chat_turn",
            agentId: input.agentId,
            system: input.system,
            prompt:
              effectsContract === ""
                ? input.prompt
                : `${input.prompt}\n${effectsContract}`,
            schema: PersonaTurnProviderEnvelopeSchema,
            maxOutputTokens: input.replyStrategy.maxOutputTokens + 800,
          }),
        );
        const parsedReply = PersonaChatDecisionSchema.safeParse(
          providerReplyCandidate(envelopeResponse),
        );
        if (parsedReply.success) {
          decisionResponse = parsedReply.data;
        } else {
          initialIssues = parsedReply.error.issues;
        }
      } else if (
        input.effects.effectsEligible ||
        input.effects.scheduleNegotiationEligible
      ) {
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
    const worldValidation: WorldEffectsValidationResult | undefined =
      envelopeResponse === undefined
        ? undefined
        : validateWorldEffects(envelopeResponse.worldEffects);
    for (const rejection of worldValidation?.rejections ?? []) {
      modelRejections.push({
        raw: rejection.raw,
        reasonCode: rejection.reasonCode,
        reasonSummary: `${rejection.effect}: ${rejection.reasonSummary}`,
      });
    }
    const validatedWorldEffects =
      this.options.liveWorldEffectsMode === "enforced"
        ? worldValidation?.effects
        : undefined;
    const materializedResponse = decisionResponse;
    let decision =
      materializedResponse !== undefined
        ? this.materializeDecisionResponse(
            materializedResponse,
            input.spec,
            input.replyStrategy,
            {
              schedule: input.schedule,
              timezone: input.spec.identity.timezone,
              nowUtc: input.nowUtc,
              userText: input.userText,
              legacyEffectsEnabled: input.effects.effectsEligible,
              worldEffectsEnabled,
              ...(validatedWorldEffects === undefined
                ? {}
                : { validatedWorldEffects }),
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
      materializedResponse === undefined && replyResponse === undefined;
    let inspection = usedFallback
      ? undefined
      : this.inspect({
          agentId: input.agentId,
          spec: input.spec,
          decision,
          nowUtc: input.nowUtc,
          capabilities: input.capabilities,
        });
    if (inspection && input.effects.negotiationEnforced) {
      inspection.issues = inspection.issues.filter(
        (issue) => !isUncommittedScheduleIssue(issue),
      );
    }
    let repairAttempted = false;
    if (!inspection || inspection.issues.length > 0) {
      repairAttempted = true;
      const repaired = await this.repairs.repairPersonaReply({
        spec: input.spec,
        userText: input.userText,
        invalidResponse:
          materializedResponse !== undefined
            ? {
                text: materializedResponse.text,
                ...(materializedResponse.toneTags === undefined
                  ? {}
                  : { toneTags: materializedResponse.toneTags }),
              }
            : replyResponse,
        issues: inspection?.issues ?? initialIssues,
        replyStrategy: input.replyStrategy,
      });
      if (repaired) {
        usedFallback = false;
        decision = attachValidatedWorldEffects(
          materializePersonaReply(repaired, input.spec, input.replyStrategy),
          validatedWorldEffects,
        );
        inspection = this.inspect({
          agentId: input.agentId,
          spec: input.spec,
          decision,
          nowUtc: input.nowUtc,
          capabilities: input.capabilities,
        });
        if (input.effects.negotiationEnforced) {
          inspection.issues = inspection.issues.filter(
            (issue) => !isUncommittedScheduleIssue(issue),
          );
        }
      }
    }
    if (!inspection || inspection.issues.length > 0) {
      decision = attachValidatedWorldEffects(
        safePersonaDecision(input.spec),
        validatedWorldEffects,
      );
      usedFallback = true;
      inspection = this.inspect({
        agentId: input.agentId,
        spec: input.spec,
        decision,
        nowUtc: input.nowUtc,
        capabilities: input.capabilities,
      });
    }
    return {
      decision,
      inspection,
      repairAttempted,
      usedFallback,
      ...(worldValidation === undefined ||
      this.options.liveWorldEffectsMode === undefined ||
      this.options.liveWorldEffectsMode === "off"
        ? {}
        : {
            worldEffectsAudit: {
              mode: this.options.liveWorldEffectsMode,
              validation: worldValidation,
            },
          }),
      modelRejections,
      scheduleAction: materializedResponse?.scheduleAction ?? { kind: "none" },
      ...(this.options.liveWorldEffectsMode === "enforced" &&
      envelopeResponse?.worldEffects.continuityEffects !== undefined
        ? {
            continuityEffects: envelopeResponse.worldEffects.continuityEffects,
          }
        : {}),
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
      worldEffectsEnabled: boolean;
      validatedWorldEffects?: ValidatedWorldEffects;
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
      ...(context.validatedWorldEffects?.stateDelta === undefined
        ? {}
        : { stateDelta: context.validatedWorldEffects.stateDelta }),
      ...(context.validatedWorldEffects?.relationshipDelta === undefined
        ? {}
        : {
            relationshipDelta: context.validatedWorldEffects.relationshipDelta,
          }),
      memoryCandidates: context.worldEffectsEnabled
        ? (context.validatedWorldEffects?.memoryCandidates ?? [])
        : sanitizeModelMemoryCandidates(response.memoryCandidates),
      personalIntentCandidates:
        context.validatedWorldEffects?.personalIntentCandidates ?? [],
      reasonCode: "persona_chat_decision",
      reasonSummary:
        proposals.length > 0
          ? "\u6839\u636e\u89d2\u8272\u4eba\u683c\u56de\u590d\uff0c\u5e76\u63d0\u4ea4\u4e86\u901a\u8fc7\u6821\u9a8c\u7684\u65e5\u7a0b\u8c03\u6574\u3002"
          : "\u6839\u636e\u89d2\u8272\u4eba\u683c\u548c\u5f53\u524d\u5bf9\u8bdd\u751f\u6210\u81ea\u7136\u56de\u590d\u3002",
    };
  }
}

function attachValidatedWorldEffects(
  decision: AgentTurnDecision,
  effects: ValidatedWorldEffects | undefined,
): AgentTurnDecision {
  if (effects === undefined) return decision;
  return {
    ...decision,
    ...(effects.stateDelta === undefined
      ? {}
      : { stateDelta: effects.stateDelta }),
    ...(effects.relationshipDelta === undefined
      ? {}
      : { relationshipDelta: effects.relationshipDelta }),
    memoryCandidates: effects.memoryCandidates,
    personalIntentCandidates: effects.personalIntentCandidates,
  };
}

function providerReplyCandidate(
  envelope: PersonaTurnProviderEnvelope,
): unknown {
  const scheduleEffects =
    envelope.scheduleEffects === undefined
      ? {}
      : { scheduleEffects: envelope.scheduleEffects };
  if (
    typeof envelope.replyDecision === "object" &&
    envelope.replyDecision !== null &&
    !Array.isArray(envelope.replyDecision)
  ) {
    return { ...envelope.replyDecision, ...scheduleEffects };
  }
  return { reply: envelope.replyDecision, ...scheduleEffects };
}

function inspectDecision(
  schedules: ScheduleService,
  agentId: string,
  spec: CharacterSpec,
  decision: AgentTurnDecision,
  nowUtc: string,
  capabilities: SimulationCapabilities,
): DecisionInspection {
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
    `Times: local clock strings in the character timezone (${timezone}), for example "19:30", "\u660e\u5929 09:00", or ISO UTC timestamps. Unparseable times are rejected.`,
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
      reasonSummary:
        "\u6a21\u578b\u4ece\u5bf9\u8bdd\u4e2d\u63d0\u53d6\u7684\u8bb0\u5fc6\u5019\u9009\u3002",
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
  const invitation =
    /(\u665a\u4f1a|\u6d3e\u5bf9|\u805a\u4f1a|party|\u4e00\u8d77\u53bb|\u4e00\u8d77\u53c2\u52a0)/i.test(
      text,
    );
  if (invitation && spec.schedulePolicy.enabled) {
    const nowLocal = DateTime.fromISO(nowUtc).setZone(spec.identity.timezone);
    const study = schedule.find((item) => {
      const start = DateTime.fromISO(item.startAtUtc).setZone(
        spec.identity.timezone,
      );
      return (
        item.status === "planned" &&
        item.rigidity !== "fixed" &&
        (item.category === "study" || item.title.includes("\u81ea\u4e60")) &&
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
          reasonSummary:
            "\u4e3a\u91cd\u8981\u7684\u4e34\u65f6\u9080\u8bf7\u817e\u51fa\u65f6\u95f4\u3002",
        },
        {
          operation: "create",
          item: {
            title: "\u548c\u7528\u6237\u4e00\u8d77\u53c2\u52a0\u665a\u4f1a",
            description:
              "\u63a5\u53d7\u7528\u6237\u9080\u8bf7\uff0c\u4e00\u8d77\u53c2\u52a0\u4eca\u665a\u7684\u665a\u4f1a\u3002",
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
          reasonSummary:
            "\u63a5\u53d7\u9080\u8bf7\uff0c\u5e76\u7528\u665a\u4f1a\u66ff\u6362\u53ef\u8c03\u6574\u7684\u81ea\u4e60\u3002",
        },
      ];
      return {
        reply: {
          text: "\u597d\u554a\u3002\u4eca\u665a\u7684\u81ea\u4e60\u672c\u6765\u53ef\u4ee5\u8c03\u6574\uff0c\u90a3\u6211\u5c31\u548c\u4f60\u4e00\u8d77\u53bb\uff1b\u6211\u4f1a\u628a\u5b66\u4e60\u5b89\u6392\u632a\u5230\u4e4b\u540e\u3002",
          chunks: [
            "\u597d\u554a\u3002\u4eca\u665a\u7684\u81ea\u4e60\u672c\u6765\u53ef\u4ee5\u8c03\u6574\uff0c\u90a3\u6211\u5c31\u548c\u4f60\u4e00\u8d77\u53bb\uff1b\u6211\u4f1a\u628a\u5b66\u4e60\u5b89\u6392\u632a\u5230\u4e4b\u540e\u3002",
          ],
          toneTags: ["\u81ea\u7136", "\u613f\u610f", "\u6709\u4e3b\u89c1"],
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
            content:
              "\u7b54\u5e94\u4eca\u665a\u548c\u7528\u6237\u4e00\u8d77\u53c2\u52a0\u665a\u4f1a\u3002",
            tags: ["\u665a\u4f1a", "\u5171\u540c\u8ba1\u5212"],
            importance: 0.82,
            confidence: 1,
            occurredAtUtc: nowUtc,
            sourceMessageIds: [],
            sourceActivityEventIds: [],
            origin: "runtime_simulation",
            reasonCode: "accepted_social_invitation",
            reasonSummary:
              "\u7528\u6237\u4e0e\u89d2\u8272\u5f62\u6210\u4e86\u660e\u786e\u7684\u5171\u540c\u627f\u8bfa\u3002",
          },
        ],
        reasonCode: "accepted_social_invitation",
        reasonSummary:
          "\u53ef\u8c03\u6574\u65e5\u7a0b\u4e0e\u5f53\u524d\u5173\u7cfb\u652f\u6301\u63a5\u53d7\u9080\u8bf7\u3002",
      };
    }
  }

  const name = spec.identity.name;
  return {
    reply: {
      text: `${text.length < 20 ? "\u55ef\uff0c\u6211\u5728\u542c\u3002" : "\u6211\u660e\u767d\u4f60\u7684\u610f\u601d\u4e86\u3002"}\u6211\u73b0\u5728\u4f1a\u6309\u81ea\u5df1\u7684\u8282\u594f\u8ba4\u771f\u56de\u5e94\uff0c\u4e5f\u4f1a\u8bb0\u4f4f\u771f\u6b63\u91cd\u8981\u7684\u90e8\u5206\u3002`,
      chunks: [
        `${text.length < 20 ? "\u55ef\uff0c\u6211\u5728\u542c\u3002" : "\u6211\u660e\u767d\u4f60\u7684\u610f\u601d\u4e86\u3002"}\u6211\u73b0\u5728\u4f1a\u6309\u81ea\u5df1\u7684\u8282\u594f\u8ba4\u771f\u56de\u5e94\uff0c\u4e5f\u4f1a\u8bb0\u4f4f\u771f\u6b63\u91cd\u8981\u7684\u90e8\u5206\u3002`,
      ],
      toneTags:
        spec.dialogue.warmth >= 0.6
          ? ["\u81ea\u7136", "\u6e29\u6696"]
          : ["\u81ea\u7136", "\u514b\u5236"],
    },
    scheduleEffects: [],
    stateDelta: { socialBattery: -0.015, moodValence: 0.015 },
    relationshipDelta: { closeness: 0.008, recentInteractionValence: 0.03 },
    memoryCandidates:
      text.length >= 30
        ? [
            {
              kind: "episodic",
              content: `\u7528\u6237\u5411${name}\u63d0\u5230\uff1a${text.slice(0, 180)}`,
              tags: ["\u5bf9\u8bdd"],
              importance: 0.45,
              confidence: 0.75,
              occurredAtUtc: nowUtc,
              sourceMessageIds: [],
              sourceActivityEventIds: [],
              origin: "runtime_simulation",
              reasonCode: "conversation_memory",
              reasonSummary:
                "\u4fdd\u7559\u8fd9\u6b21\u5bf9\u8bdd\u4e2d\u8f83\u91cd\u8981\u7684\u7528\u6237\u4fe1\u606f\u3002",
            },
          ]
        : [],
    reasonCode: "ordinary_conversation",
    reasonSummary:
      "\u6ca1\u6709\u9700\u8981\u4fee\u6539\u65e5\u7a0b\u7684\u660e\u786e\u8bf7\u6c42\u3002",
  };
}

function safeScheduleDecision(spec: CharacterSpec): AgentTurnDecision {
  const text = createSafeFallbackReply(spec.identity.name);
  return {
    reply: {
      text,
      chunks: [text],
      toneTags:
        spec.dialogue.warmth >= 0.6
          ? ["\u5766\u8bda", "\u6e29\u548c"]
          : ["\u5766\u8bda", "\u514b\u5236"],
    },
    scheduleEffects: [],
    memoryCandidates: [],
    reasonCode: "safe_schedule_fallback",
    reasonSummary:
      "\u6a21\u578b\u63d0\u6848\u4e0d\u53ef\u5b89\u5168\u63d0\u4ea4\uff1b\u672a\u4fee\u6539\u65e5\u7a0b\u3002",
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
    reasonSummary:
      "\u6839\u636e\u89d2\u8272\u4eba\u683c\u548c\u5f53\u524d\u5bf9\u8bdd\u751f\u6210\u81ea\u7136\u56de\u590d\u3002",
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
  return /(?:^|\n)\s*(?:[-*\u2022]|\d+[.)\u3001]|[\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341]+[\u3001.])/u.test(
    text,
  );
}

function faithfulModelChunks(
  response: PersonaChatResponse,
): string[] | undefined {
  if (response.chunks === undefined || response.chunks.length < 2) {
    return undefined;
  }
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

function splitSequentialReply(text: string): string[] {
  const source = text.replace(/\r\n?/gu, "\n").trim();
  const units = sentenceUnits(source);
  if (units.length < 2) {
    return splitLongText(source, 4_000).map((part) => part.trim());
  }
  const expanded = units.flatMap((unit) => splitLongText(unit, 4_000));
  if (expanded.length <= 12) {
    return expanded.map((part) => part.trim()).filter(Boolean);
  }
  return packSequentialUnits(expanded, 12);
}

export function sentenceUnits(source: string): string[] {
  const boundary =
    /(?:[\u3002\uff01\uff1f!?\uff1b;]+|\.(?=\s|$))[\u201d\u2019"\uff09\u3011\u300b\u300d\u300f]*(?:[ \t]*\n+[ \t]*|[ \t]+)?|\n+/gu;
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
  ) {
    return chunks;
  }
  const source = units.join("");
  const safeSize = Math.ceil(source.length / maximum);
  return splitLongText(source, Math.min(4_000, safeSize))
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .slice(0, maximum);
}

export function deliveryModeForDecision(
  decision: AgentTurnDecision,
): "single_block" | "sequential" {
  return decision.reply.chunks.length > 1 ? "sequential" : "single_block";
}

function safePersonaDecision(spec: CharacterSpec): AgentTurnDecision {
  const text =
    spec.dialogue.warmth >= 0.6
      ? "\u6211\u521a\u624d\u6ca1\u6709\u8868\u8fbe\u597d\uff0c\u4e0d\u8fc7\u6211\u5728\u8ba4\u771f\u542c\u3002\u4f60\u613f\u610f\u518d\u591a\u8bf4\u4e00\u70b9\u5417\uff1f"
      : "\u6211\u521a\u624d\u6ca1\u6709\u8bf4\u6e05\u695a\u3002\u4f60\u53ef\u4ee5\u7ee7\u7eed\uff0c\u6211\u4f1a\u8ba4\u771f\u542c\u3002";
  return {
    reply: {
      text,
      chunks: [text],
      toneTags:
        spec.dialogue.warmth >= 0.6
          ? ["\u81ea\u7136", "\u6e29\u548c"]
          : ["\u81ea\u7136", "\u514b\u5236"],
    },
    scheduleEffects: [],
    memoryCandidates: [],
    reasonCode: "persona_chat_fallback",
    reasonSummary:
      "\u6a21\u578b\u56de\u590d\u65e0\u6cd5\u5b89\u5168\u4f7f\u7528\uff0c\u8fd4\u56de\u4e2d\u6027\u89d2\u8272\u56de\u5e94\u3002",
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
  return /(?:\u5df2\u7ecf|\u5df2|\u521a\u521a).{0,12}(?:\u4fee\u6539|\u53d6\u6d88|\u79fb\u52a8|\u6539(?:\u4e86|\u5230|\u6210)?|\u5b89\u6392(?:\u597d|\u4e86)?|\u52a0\u5165).{0,12}(?:\u65e5\u7a0b|\u8ba1\u5212|\u884c\u7a0b)|(?:i(?:'ve| have)) (?:rescheduled|cancelled|added .{0,12} to (?:my )?schedule)/iu.test(
    decision.reply.text,
  );
}
