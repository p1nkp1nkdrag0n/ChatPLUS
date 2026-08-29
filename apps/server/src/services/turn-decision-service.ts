import { DateTime } from "luxon";
import {
  MemoryCandidateSchema,
  PersonaChatDecisionSchema,
  PersonaChatResponseSchema,
  ScheduleNegotiationActionSchema,
  StrictPersonaTurnProviderEnvelopeSchema,
  ScheduleEffectProposalSchema,
  type MemoryCandidate,
  type PersonaChatDecision,
  type PersonaChatResponse,
  type PersonaTurnProviderEnvelope,
  type ScheduleNegotiationAction,
} from "@personasim/contracts";
import {
  createSafeFallbackReply,
  deriveExplicitUserMemoryClaim,
  guardPersonaReply,
  hasExplicitMemoryCorrection,
  isExplicitUserMemoryStatement,
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
import {
  CHAT_TURN_OUTPUT_TOKEN_TARGET,
  resolveChatOutputTokenBudget,
} from "./chat-output-budget.js";
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

export type ModelScheduleActionOrigin =
  | "model_explicit_valid"
  | "model_missing"
  | "model_invalid"
  | "model_unavailable"
  | "fixture";

export interface ModelScheduleActionAudit {
  origin: ModelScheduleActionOrigin;
  kind: ScheduleNegotiationAction["kind"];
}

export type ResolvedTurn = {
  decision: AgentTurnDecision;
  inspection: DecisionInspection;
  repairAttempted: boolean;
  usedFallback: boolean;
  modelRejections: ModelEffectRejection[];
  scheduleAction: ScheduleNegotiationAction;
  modelScheduleActionAudit: ModelScheduleActionAudit;
  continuityEffects?: unknown;
  worldEffectsAudit?: {
    mode: "shadow" | "enforced";
    validation: WorldEffectsValidationResult;
  };
};

const EnforcedScheduleTurnProviderEnvelopeSchema =
  StrictPersonaTurnProviderEnvelopeSchema.superRefine((value, context) => {
    const audit = inspectModelScheduleAction(value.replyDecision);
    if (audit.origin === "model_explicit_valid") return;
    context.addIssue({
      code: "custom",
      path: ["replyDecision", "scheduleAction"],
      message:
        audit.origin === "model_missing"
          ? "Enforced schedule turns require an explicit scheduleAction."
          : "Enforced schedule turns require a valid scheduleAction.",
    });
  });

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
    effects: TurnDecisionEffectContext;
  }): Promise<ResolvedTurn> {
    let decision: AgentTurnDecision | undefined;
    let providerEnvelope: PersonaTurnProviderEnvelope | undefined;
    let worldValidation: WorldEffectsValidationResult | undefined;
    let initialIssues: unknown[] = [];
    const worldEffectsEnabled =
      this.options.liveWorldEffectsMode !== undefined &&
      this.options.liveWorldEffectsMode !== "off";
    const effectsEnforced = this.options.liveWorldEffectsMode === "enforced";
    const deterministicEnvelope = fixtureProviderEnvelope(
      input.fixture,
      worldEffectsEnabled,
    );
    try {
      providerEnvelope = StrictPersonaTurnProviderEnvelopeSchema.parse(
        await this.llm.generateObject({
          purpose: "chat_turn",
          agentId: input.agentId,
          system: input.system,
          prompt: input.prompt,
          schema: StrictPersonaTurnProviderEnvelopeSchema,
          ...(effectsEnforced ? {} : { fixture: deterministicEnvelope }),
        }),
      );
      const decisionEnvelope = effectsEnforced
        ? deterministicEnvelope
        : providerEnvelope;
      worldValidation = worldEffectsEnabled
        ? validateWorldEffects(decisionEnvelope.worldEffects)
        : undefined;
      decision = attachValidatedWorldEffects(
        materializeFixtureProviderDecision(decisionEnvelope, input.fixture),
        effectsEnforced
          ? preserveTrustedFixtureMemories(
              worldValidation?.effects,
              input.fixture.memoryCandidates,
            )
          : undefined,
      );
    } catch (error) {
      initialIssues = invalidOutputIssues(error);
    }

    const validatedWorldEffects = effectsEnforced
      ? preserveTrustedFixtureMemories(
          worldValidation?.effects,
          input.fixture.memoryCandidates,
        )
      : undefined;

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
      const repaired = await this.repairs.repairFixtureDecision({
        spec: input.spec,
        userText: input.userText,
        invalidDecision: decision,
        issues: inspection?.issues ?? initialIssues,
        fallback: safeScheduleDecision(input.spec),
      });
      decision = attachValidatedWorldEffects(
        withoutWorldEffects(repaired),
        validatedWorldEffects,
      );
      inspection = this.inspect({
        agentId: input.agentId,
        spec: input.spec,
        decision,
        nowUtc: input.nowUtc,
        capabilities: input.capabilities,
      });
    }
    if (inspection.issues.length > 0) {
      decision = attachValidatedWorldEffects(
        withoutWorldEffects(safeScheduleDecision(input.spec)),
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
    const scheduleAction = fixtureScheduleNegotiationAction(input);
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
      modelRejections: (worldValidation?.rejections ?? []).map((rejection) => ({
        raw: rejection.raw,
        reasonCode: rejection.reasonCode,
        reasonSummary: `${rejection.effect}: ${rejection.reasonSummary}`,
      })),
      scheduleAction,
      modelScheduleActionAudit: {
        origin: "fixture",
        kind: scheduleAction.kind,
      },
      ...(effectsEnforced &&
      providerEnvelope?.worldEffects.continuityEffects !== undefined
        ? {
            continuityEffects: providerEnvelope.worldEffects.continuityEffects,
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
    let envelopeResponse: PersonaTurnProviderEnvelope | undefined;
    let initialIssues: unknown[] = [];
    let modelScheduleActionAudit: ModelScheduleActionAudit = {
      origin: "model_unavailable",
      kind: "none",
    };
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
    const providerSchema =
      input.effects.scheduleNegotiationEligible &&
      input.effects.negotiationEnforced
        ? EnforcedScheduleTurnProviderEnvelopeSchema
        : StrictPersonaTurnProviderEnvelopeSchema;
    try {
      envelopeResponse = providerSchema.parse(
        await this.llm.generateObject({
          purpose: "chat_turn",
          agentId: input.agentId,
          system: input.system,
          prompt:
            effectsContract === ""
              ? input.prompt
              : `${input.prompt}\n${effectsContract}`,
          schema: providerSchema,
          maxOutputTokens: resolveChatOutputTokenBudget(
            this.llm.capabilities,
            CHAT_TURN_OUTPUT_TOKEN_TARGET,
            input.replyStrategy.maxOutputTokens +
              (worldEffectsEnabled ||
              input.effects.effectsEligible ||
              input.effects.scheduleNegotiationEligible
                ? 800
                : 0),
          ),
        }),
      );
      modelScheduleActionAudit = inspectModelScheduleAction(
        envelopeResponse.replyDecision,
      );
      const parsedReply = PersonaChatDecisionSchema.safeParse(
        providerReplyCandidate(envelopeResponse),
      );
      if (parsedReply.success) {
        decisionResponse = parsedReply.data;
      } else {
        initialIssues = parsedReply.error.issues;
      }
    } catch (error) {
      initialIssues = invalidOutputIssues(error);
    }

    const modelRejections: ModelEffectRejection[] = [];
    const worldValidation: WorldEffectsValidationResult | undefined =
      !worldEffectsEnabled || envelopeResponse === undefined
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
    const replyOnly =
      !worldEffectsEnabled &&
      !input.effects.effectsEligible &&
      !input.effects.scheduleNegotiationEligible;
    let decision =
      materializedResponse !== undefined
        ? replyOnly
          ? materializePersonaReply(
              materializedResponse,
              input.spec,
              input.replyStrategy,
            )
          : this.materializeDecisionResponse(
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
        : safePersonaDecision(input.spec);
    let usedFallback = materializedResponse === undefined;
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
            : undefined,
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
      modelScheduleActionAudit,
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

/**
 * Fixture decisions are assembled and parsed as the strict server-owned turn
 * contract before they are wrapped in the deliberately fuzzy provider
 * envelope. Keep their already-validated memory semantics: passing them back
 * through the model-facing normalizer would otherwise discard claim,
 * attribution and stability metadata that the fixture is specifically meant
 * to exercise. Other world effects continue to use the ordinary validator.
 */
function preserveTrustedFixtureMemories(
  effects: ValidatedWorldEffects | undefined,
  memories: AgentTurnDecision["memoryCandidates"],
): ValidatedWorldEffects | undefined {
  if (effects === undefined) return undefined;
  return { ...effects, memoryCandidates: memories };
}

function inspectModelScheduleAction(value: unknown): ModelScheduleActionAudit {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.prototype.hasOwnProperty.call(value, "scheduleAction")
  ) {
    return { origin: "model_missing", kind: "none" };
  }
  const parsed = ScheduleNegotiationActionSchema.safeParse(
    (value as Record<string, unknown>)["scheduleAction"],
  );
  return parsed.success
    ? {
        origin: "model_explicit_valid",
        kind: parsed.data.kind,
      }
    : {
        origin: "model_invalid",
        kind: "none",
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

function fixtureProviderEnvelope(
  decision: AgentTurnDecision,
  includeWorldEffects = true,
): PersonaTurnProviderEnvelope {
  return StrictPersonaTurnProviderEnvelopeSchema.parse({
    replyDecision: decision.reply,
    worldEffects: includeWorldEffects
      ? {
          ...(decision.stateDelta === undefined
            ? {}
            : { stateDelta: decision.stateDelta }),
          ...(decision.relationshipDelta === undefined
            ? {}
            : { relationshipDelta: decision.relationshipDelta }),
          memoryCandidates: decision.memoryCandidates,
          ...(decision.personalIntentCandidates === undefined
            ? {}
            : {
                personalIntentCandidates: decision.personalIntentCandidates,
              }),
          ...(decision.continuityEffects === undefined
            ? {}
            : { continuityEffects: decision.continuityEffects }),
        }
      : {},
    scheduleEffects: decision.scheduleEffects,
  });
}

function materializeFixtureProviderDecision(
  envelope: PersonaTurnProviderEnvelope,
  serverDecision: AgentTurnDecision,
): AgentTurnDecision {
  return agentTurnDecisionSchema.parse({
    reply: envelope.replyDecision,
    // Fixture schedule behavior is server-owned and deterministic. The
    // provider envelope supplies only the conversational reply and proposed
    // world effects, which are validated and attached separately.
    scheduleEffects: serverDecision.scheduleEffects,
    memoryCandidates: [],
    reasonCode: serverDecision.reasonCode,
    reasonSummary: serverDecision.reasonSummary,
  });
}

function withoutWorldEffects(decision: AgentTurnDecision): AgentTurnDecision {
  return agentTurnDecisionSchema.parse({
    reply: decision.reply,
    scheduleEffects: decision.scheduleEffects,
    memoryCandidates: [],
    reasonCode: decision.reasonCode,
    reasonSummary: decision.reasonSummary,
  });
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

  const explicitFacts = deriveServerOwnedUserMemoryCandidates(text, nowUtc);
  const personalIntentCandidates = fixturePersonalIntentCandidates(text);
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
    memoryCandidates: explicitFacts,
    ...(personalIntentCandidates.length === 0
      ? {}
      : { personalIntentCandidates }),
    reasonCode: "ordinary_conversation",
    reasonSummary:
      "\u6ca1\u6709\u9700\u8981\u4fee\u6539\u65e5\u7a0b\u7684\u660e\u786e\u8bf7\u6c42\u3002",
  };
}

/**
 * The fixture provider is used to prove that the server-owned negotiation
 * pipeline works without relying on a paid model. Keep the fixture action
 * intentionally small: it may accept a complete, grounded shared invitation,
 * ask for missing details, or act on one persisted pending offer. The
 * ScheduleNegotiationService still owns canonicalization and every write.
 */
function fixtureScheduleNegotiationAction(input: {
  userText: string;
  effects: TurnDecisionEffectContext;
}): ScheduleNegotiationAction {
  if (!input.effects.scheduleNegotiationEligible) return { kind: "none" };

  const text = input.userText.normalize("NFKC").trim();
  const active = input.effects.activeNegotiation;
  if (active?.state.offer !== undefined) {
    if (/^(?:确认|确定|同意|没问题|可以|好|就按这个来)[。.!！]?$/u.test(text)) {
      return { kind: "accept_pending_offer", evidenceQuotes: [text] };
    }
    if (/^(?:算了|取消|不要了|不用了|先不定了)[\s\S]*$/u.test(text)) {
      return { kind: "withdraw_offer" };
    }
    return { kind: "none" };
  }

  if (
    /(?:假设|也许|还没决定|先别|不要|不用现在承诺|没确认过|不存在)/u.test(
      text,
    ) ||
    /(?:已经进日程|还在日程|有哪些|为什么会出现在日程|说一遍|几条)/u.test(text)
  ) {
    return { kind: "none" };
  }
  if (/^(?:算了|取消|不要了|不用了|先不定了)[\s\S]*$/u.test(text)) {
    return { kind: "withdraw_offer" };
  }

  const activity = fixtureScheduleActivity(text);
  const sharedInvitation =
    /一起|见面|约会|陪我|来参加|愿意.{0,20}(?:见面|约会)/u.test(text);
  if (!sharedInvitation || activity === undefined) return { kind: "none" };

  const startAt = fixtureScheduleStartEvidence(text);
  if (startAt === undefined) {
    return {
      kind: "request_details",
      offer: {
        activity: activity.activity,
        category: activity.category,
        evidenceQuotes: [text],
      },
    };
  }
  return {
    kind: "accept_user_offer",
    offer: {
      activity: activity.activity,
      category: activity.category,
      startAt,
      evidenceQuotes: [text],
    },
  };
}

function fixtureScheduleActivity(
  text: string,
): { activity: string; category: "exercise" | "meal" | "social" } | undefined {
  if (/喝茶|下午茶|茶馆/u.test(text)) {
    return { activity: "喝茶", category: "social" };
  }
  if (/见面|约会/u.test(text)) {
    return { activity: "见面", category: "social" };
  }
  if (/吃饭|晚餐|午餐|早餐/u.test(text)) {
    return { activity: "吃饭", category: "meal" };
  }
  if (/散步|走走|公园.{0,12}走|走.{0,12}公园/u.test(text)) {
    return { activity: "散步", category: "exercise" };
  }
  if (/跑步|晨跑|夜跑/u.test(text)) {
    return { activity: "跑步", category: "exercise" };
  }
  return undefined;
}

function fixtureScheduleStartEvidence(text: string): string | undefined {
  return /今天|今晚|明天|明早|后天|周[一二三四五六日天]|星期[一二三四五六日天]|\d{1,2}\s*月\s*\d{1,2}\s*日|\d{1,2}\s*[:：点]\s*\d{0,2}/u.test(
    text,
  )
    ? text
    : undefined;
}

function fixturePersonalIntentCandidates(
  text: string,
): NonNullable<AgentTurnDecision["personalIntentCandidates"]> {
  const normalized = text.normalize("NFKC").trim();
  if (
    !/(?:河边|江边).{0,20}(?:夜景|灯光).{0,30}(?:片子|纪录片)/u.test(normalized)
  ) {
    return [];
  }
  return [
    {
      activity: "河边夜景拍摄",
      category: "travel",
      durationHint: "60 分钟",
      timingHint: "明天晚上",
      basisKind: "chat",
      evidenceQuotes: [normalized],
      reasonCode: "fixture_chat_grounded_night_shoot",
      reasonSummary: "用户提到的河边夜景为纪录片拍摄提供了可追溯的灵感。",
    },
  ];
}

export function deriveServerOwnedUserMemoryCandidates(
  text: string,
  nowUtc: string,
): MemoryCandidate[] {
  const normalized = text.normalize("NFKC").trim();
  if (fixtureMemoryStatementIsUnsafe(normalized)) return [];

  const candidates: MemoryCandidate[] = [];
  const correction = hasExplicitMemoryCorrection(normalized);

  const sharedRoutine = normalized.match(
    /^我希望你记住[，,:：]\s*(.+(?:每周|每月|每天).*(?:一起|共同).+)$/u,
  )?.[1];
  if (sharedRoutine !== undefined) {
    candidates.push(
      MemoryCandidateSchema.parse({
        kind: "semantic",
        content: `用户明确希望记住：${sharedRoutine}`,
        tags: ["user_fact", "shared_routine"],
        importance: 0.76,
        confidence: 1,
        sourceMessageIds: [],
        sourceActivityEventIds: [],
        origin: "runtime_simulation",
        namespace: "user_model",
        certainty: "explicit",
        attribution: "user_explicit",
        stability: "stable",
        shouldWrite: true,
        forbiddenOverclaims: [],
        reasonCode: "explicit_shared_routine",
        reasonSummary:
          "The user explicitly asked to retain a recurring shared routine.",
      }),
    );
  }

  const anchor = normalized.match(
    /^记住[:：]\s*(.+?代号\s*([A-Z][A-Z0-9-]{2,}))[。.!！]?$/iu,
  );
  const anchorContent = anchor?.[1]?.trim();
  const anchorCode = anchor?.[2]?.trim().toLocaleLowerCase();
  if (anchorContent !== undefined && anchorCode !== undefined) {
    candidates.push(
      MemoryCandidateSchema.parse({
        kind: "semantic",
        content: `用户明确要求记住：${anchorContent}。`,
        tags: ["user_fact", "explicit_anchor", anchorCode],
        importance: 0.88,
        confidence: 1,
        sourceMessageIds: [],
        sourceActivityEventIds: [],
        origin: "runtime_simulation",
        namespace: "user_model",
        certainty: "explicit",
        attribution: "user_explicit",
        stability: "stable",
        claim: {
          subjectKey: `user_fact:anchor:${anchorCode}`,
          disposition: "affirmed",
          recordedAtUtc: nowUtc,
        },
        shouldWrite: true,
        forbiddenOverclaims: [],
        reasonCode: "explicit_user_anchor",
        reasonSummary: "The user explicitly asked to retain a unique anchor.",
      }),
    );
  }

  const relationship = normalized.match(
    /(?:^|[，,；;。:：]\s*)([\p{Script=Han}A-Za-z0-9·]{1,24}?)(?:其实)?是(?:我|用户)?(?:的)?(大学同学|高中同学|初中同学|小学同学|研究生同学|夜校同学|工作同学|公司同学|表姐|表妹|表哥|表弟|堂姐|堂妹|堂哥|堂弟)(?:[，,；;。]|$)/u,
  );
  if (relationship !== null) {
    const person = relationship[1]?.trim();
    const relation = relationship[2]?.trim();
    if (person !== undefined && person !== "" && relation !== undefined) {
      const content = `${person}是用户的${relation}。`;
      const claim = deriveExplicitUserMemoryClaim({
        category: "user_fact",
        evidenceText: normalized,
        candidateContent: content,
      });
      if (claim !== undefined) {
        candidates.push(
          MemoryCandidateSchema.parse({
            kind: "semantic",
            content,
            tags: [
              "user_fact",
              "person_relationship",
              ...(correction ? ["explicit_correction"] : []),
            ],
            importance: 0.72,
            confidence: 1,
            sourceMessageIds: [],
            sourceActivityEventIds: [],
            origin: "runtime_simulation",
            namespace: "user_model",
            certainty: "explicit",
            attribution: "user_explicit",
            stability: "stable",
            claim: {
              ...claim,
              recordedAtUtc: nowUtc,
              ...(correction
                ? { revisionIntent: "explicit_correction" as const }
                : {}),
            },
            shouldWrite: true,
            forbiddenOverclaims: [],
            reasonCode: correction
              ? "explicit_user_correction"
              : "explicit_user_fact",
            reasonSummary: correction
              ? "The user explicitly corrected a previously stated relationship fact."
              : "The user explicitly stated a stable relationship fact.",
          }),
        );
      }

      const location = normalized.match(
        /(?:现在|目前|确实)?住在([\p{Script=Han}A-Za-z0-9·]{1,24})(?:[，,；;。]|$)/u,
      )?.[1];
      if (!correction && location !== undefined) {
        const locationContent = `${person}的居住地是${location}。`;
        const locationClaim = deriveExplicitUserMemoryClaim({
          category: "user_fact",
          evidenceText: normalized,
          candidateContent: locationContent,
        });
        if (locationClaim !== undefined) {
          candidates.push(
            MemoryCandidateSchema.parse({
              kind: "semantic",
              content: locationContent,
              tags: ["user_fact", "person_location"],
              importance: 0.68,
              confidence: 1,
              sourceMessageIds: [],
              sourceActivityEventIds: [],
              origin: "runtime_simulation",
              namespace: "user_model",
              certainty: "explicit",
              attribution: "user_explicit",
              stability: "stable",
              claim: { ...locationClaim, recordedAtUtc: nowUtc },
              shouldWrite: true,
              forbiddenOverclaims: [],
              reasonCode: "explicit_user_fact",
              reasonSummary:
                "The user explicitly stated a person's current location.",
            }),
          );
        }
      }
    }
  }

  const drink = (
    normalized.match(/更常喝([^，,。.!！]+)(?:[，,。.!！]|$)/u)?.[1] ??
    normalized.match(/更喜欢([^，,。.!！]+)(?:[，,。.!！]|$)/u)?.[1] ??
    normalized.match(
      /^我(?:最近|平时|通常)?(?:经常|常|通常)?喝([^，,。.!！]+)(?:[，,。.!！]|$)/u,
    )?.[1]
  )?.trim();
  if (drink !== undefined && drink !== "") {
    const content = `用户最近常喝${drink}。`;
    const claim = deriveExplicitUserMemoryClaim({
      category: "user_preference",
      evidenceText: normalized,
      candidateContent: content,
    });
    if (claim !== undefined) {
      candidates.push(
        MemoryCandidateSchema.parse({
          kind: "semantic",
          content,
          tags: [
            "user_preference",
            "usual_drink",
            ...(correction ? ["explicit_correction"] : []),
          ],
          importance: 0.65,
          confidence: 1,
          sourceMessageIds: [],
          sourceActivityEventIds: [],
          origin: "runtime_simulation",
          namespace: "user_model",
          certainty: "explicit",
          attribution: "user_explicit",
          stability: "stable",
          claim: {
            ...claim,
            recordedAtUtc: nowUtc,
            ...(correction
              ? { revisionIntent: "explicit_correction" as const }
              : {}),
          },
          shouldWrite: true,
          forbiddenOverclaims: [],
          reasonCode: correction
            ? "explicit_user_correction"
            : "explicit_user_preference",
          reasonSummary: correction
            ? "The user explicitly corrected a stable personal preference."
            : "The user explicitly stated a stable personal preference.",
        }),
      );
    }
  }

  const plannedTask = /我打算明天/u.test(normalized)
    ? normalized.includes("答辩稿")
      ? { subjectKey: "user_task:defense_draft", label: "答辩稿最后一遍" }
      : normalized.includes("汇报")
        ? { subjectKey: "user_task:report", label: "汇报" }
        : undefined
    : undefined;
  if (
    plannedTask !== undefined &&
    /(?:还没|尚未)(?:开始|做|完成)/u.test(normalized)
  ) {
    candidates.push(
      MemoryCandidateSchema.parse({
        kind: "commitment",
        content: `用户计划明天完成${plannedTask.label}，目前尚未完成。`,
        tags: ["user_fact", "user_plan"],
        importance: 0.72,
        confidence: 1,
        sourceMessageIds: [],
        sourceActivityEventIds: [],
        origin: "runtime_simulation",
        namespace: "user_model",
        certainty: "explicit",
        attribution: "user_explicit",
        stability: "situational",
        claim: {
          subjectKey: plannedTask.subjectKey,
          disposition: "affirmed",
          recordedAtUtc: nowUtc,
        },
        temporalMetadata: {
          recordedAtUtc: nowUtc,
          temporalCertainty: "date_only",
          temporalStatus: "planned",
        },
        shouldWrite: true,
        forbiddenOverclaims: [],
        reasonCode: "explicit_user_plan",
        reasonSummary:
          "The user explicitly described an unfinished future plan.",
      }),
    );
  }

  const completedTask =
    /^(?:更新(?:一下)?[:：]?\s*)?(?:我|答辩稿|汇报)/u.test(normalized) &&
    /(?:已经完成|已经顺完)/u.test(normalized)
      ? normalized.includes("答辩稿")
        ? { subjectKey: "user_task:defense_draft", label: "答辩稿最后一遍" }
        : normalized.includes("汇报")
          ? { subjectKey: "user_task:report", label: "汇报" }
          : undefined
      : undefined;
  if (completedTask !== undefined) {
    candidates.push(
      MemoryCandidateSchema.parse({
        kind: "commitment",
        content: `用户的${completedTask.label}已经完成。`,
        tags: ["user_fact", "user_plan", "status_update"],
        importance: 0.76,
        confidence: 1,
        occurredAtUtc: nowUtc,
        sourceMessageIds: [],
        sourceActivityEventIds: [],
        origin: "runtime_simulation",
        namespace: "user_model",
        certainty: "explicit",
        attribution: "user_explicit",
        stability: "situational",
        claim: {
          subjectKey: completedTask.subjectKey,
          disposition: "completed",
          recordedAtUtc: nowUtc,
          revisionIntent: "explicit_correction",
        },
        temporalMetadata: {
          occurredStartAtUtc: nowUtc,
          recordedAtUtc: nowUtc,
          temporalCertainty: "approximate",
          temporalStatus: "occurred",
        },
        shouldWrite: true,
        forbiddenOverclaims: [],
        reasonCode: "explicit_user_status_update",
        reasonSummary:
          "The user explicitly reported that the planned task is complete.",
      }),
    );
  }

  if (/河边夜景.*(?:适合|可以用在).*片子/u.test(normalized)) {
    candidates.push(
      MemoryCandidateSchema.parse({
        kind: "semantic",
        content: "用户建议河边夜景的灯光可能适合顾澜的纪录片。",
        tags: ["character_inspiration", "river_night_scene"],
        importance: 0.64,
        confidence: 0.9,
        sourceMessageIds: [],
        sourceActivityEventIds: [],
        origin: "runtime_simulation",
        namespace: "character_self",
        certainty: "explicit",
        attribution: "user_explicit",
        stability: "situational",
        shouldWrite: true,
        forbiddenOverclaims: [],
        reasonCode: "explicit_user_inspiration",
        reasonSummary:
          "The user explicitly offered an idea without claiming it was scheduled.",
      }),
    );
  }
  return candidates;
}

function fixtureMemoryStatementIsUnsafe(text: string): boolean {
  return (
    !isExplicitUserMemoryStatement(text) ||
    /^(?:假设|假如|如果|比如|例如|听说|据说|有人说|同事说)/u.test(text) ||
    /(?:可能|也许|或许|大概|似乎|好像|不确定|未确认|没有确认).{0,30}(?:是我|是用户|已经完成|已经顺完)/u.test(
      text,
    ) ||
    /(?:只是举例|别当成(?:我的)?事实|没有确认|别据此改(?:记忆|记录)|不要记住|别记住)/u.test(
      text,
    )
  );
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
