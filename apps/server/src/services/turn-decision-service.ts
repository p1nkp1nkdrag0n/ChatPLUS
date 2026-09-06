import type {
  ConversationContextPlan,
  EffectivePersonaSnapshot,
  FuzzyLifePromptContext,
} from "@personasim/contracts";
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
  extractExplicitDeadlineFact,
  extractExplicitStoredItemFact,
  extractExplicitWeeklyPlanFacts,
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
  causalReplyFallback,
  inspectCausalReply,
} from "./causal-reply-guard.js";
import {
  buildScheduleNegotiationContract,
  type ActiveScheduleNegotiation,
} from "./schedule-negotiation-service.js";
import { analyzeSupportSpeechAct } from "./fuzzy-life-language.js";
import {
  consentClaimsFromUnknown,
  isConsentClaimEvidenceExcerpt,
  isConsentControlledActivity,
  isConsentDerivedSemanticCandidate,
  type ThirdPartyConsentClaim,
  type ThirdPartyConsentScopeKind,
  type ThirdPartyConsentStatus,
} from "./consent-modality.js";

export interface TurnDecisionServiceOptions {
  chatEffectsMode?: "off" | "gated";
  liveWorldEffectsMode?: "off" | "shadow" | "enforced";
  fixtureTurnBehavior?: FixtureTurnBehavior;
}

export interface FixtureTurnBehavior {
  selectDelegatedDecision?(input: {
    userText: string;
    causalContext?: unknown;
  }): string | undefined;
  semanticReply?(input: {
    userText: string;
    prompt: string;
    causalContext?: unknown;
  }): string | undefined;
  personalIntentCandidates?(input: {
    userText: string;
  }): NonNullable<AgentTurnDecision["personalIntentCandidates"]>;
}

export interface TurnDecisionEffectContext {
  effectsEligible: boolean;
  scheduleNegotiationEligible: boolean;
  negotiationEnforced: boolean;
  activeNegotiation?: ActiveScheduleNegotiation;
  consentModality?: {
    evidenceText: string;
    claims: readonly ThirdPartyConsentClaim[];
  };
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

export interface ExplicitFactReplyGuardAudit {
  policyVersion: "explicit_fact_checklist_v1";
  outcome: "selected" | "abstained";
  reasonCode: string;
  expectedFacetCount?: 2 | 3;
  selectedMemoryIds: string[];
  selectedEvidenceIds: string[];
  serverGuardApplied: true;
  modelReplyContentChanged: boolean;
  modelSideEffectsBlocked: boolean;
  modelRepairAttempted: boolean;
  modelGenerationFallbackUsed: boolean;
  contentDerivedSemanticsSkipped: true;
  finalTextSha256: string;
}

export interface ConsentModalityGuardAudit {
  policyVersion: "third_party_consent_modality_v1";
  sourceKind: "assertion" | "query" | "mixed";
  subject: string;
  status: ThirdPartyConsentStatus;
  scopes: Array<{
    kind: ThirdPartyConsentScopeKind;
    label: string;
    resource: string;
    beneficiary?: string;
    beneficiaryKey?: string;
    restrictions?: string[];
  }>;
  primaryClaimKey: string;
  claimCount: number;
  claims: Array<{
    claimKey: string;
    sourceKind: "assertion" | "query";
    subject: string;
    subjectKey: string;
    beneficiary?: string;
    beneficiaryKey?: string;
    status: ThirdPartyConsentStatus;
    scopeKind: ThirdPartyConsentScopeKind;
    scopeKey: string;
    scopeLabel: string;
    resource: string;
    evidenceText: string;
    restrictions?: string[];
  }>;
  consentOnly: boolean;
  independentText: string;
  independentReplyText: string;
  evidenceText: string;
  serverGuardApplied: true;
  modelReplyContentChanged: boolean;
  modelSideEffectsBlocked: boolean;
  contentDerivedSemanticsSkipped: boolean;
  finalTextSha256: string;
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
  explicitFactReplyGuardAudit?: ExplicitFactReplyGuardAudit;
  consentModalityGuardAudit?: ConsentModalityGuardAudit;
};

function filterRawConsentScheduleEffects(input: {
  effects: readonly Record<string, unknown>[];
  schedule: readonly ScheduleItem[];
  consentModality?: NonNullable<TurnDecisionEffectContext["consentModality"]>;
}): {
  retained: Record<string, unknown>[];
  blocked: Record<string, unknown>[];
} {
  if (input.consentModality === undefined) {
    return { retained: [...input.effects], blocked: [] };
  }
  const retained: Record<string, unknown>[] = [];
  const blocked: Record<string, unknown>[] = [];
  for (const effect of input.effects) {
    if (
      isRawConsentScheduleEffect(effect, input.schedule, input.consentModality)
    ) {
      blocked.push(effect);
    } else {
      retained.push(effect);
    }
  }
  return { retained, blocked };
}

function isRawConsentScheduleEffect(
  effect: Record<string, unknown>,
  schedule: readonly ScheduleItem[],
  consentModality: NonNullable<TurnDecisionEffectContext["consentModality"]>,
): boolean {
  const evidenceTexts = [
    effect["justificationQuote"],
    effect["justification"],
    effect["quote"],
    effect["evidence"],
    effect["evidenceQuotes"],
    effect["userQuote"],
    effect["sourceQuote"],
  ]
    .map((value) => consentClaimsFromUnknown(value))
    .filter((value) => value !== "");
  const hasConsentProvenance = evidenceTexts.some(
    (evidenceText) =>
      isConsentClaimEvidenceExcerpt({
        claims: consentModality.claims,
        candidateText: evidenceText,
      }) ||
      isConsentDerivedSemanticCandidate({
        authoritativeText: consentModality.evidenceText,
        authoritativeClaims: consentModality.claims,
        candidateText: evidenceText,
      }),
  );
  if (!hasConsentProvenance) {
    return false;
  }
  const targetText = rawScheduleEffectTargetText(effect, schedule);
  return isConsentControlledActivity({
    claims: consentModality.claims,
    candidateText: targetText,
  });
}

function rawScheduleEffectTargetText(
  effect: Record<string, unknown>,
  schedule: readonly ScheduleItem[],
): string {
  const targetParts: unknown[] = [
    effect["itemTitle"],
    effect["targetTitle"],
    effect["title"],
    effect["activity"],
    effect["description"],
    effect["item"],
  ];
  const itemId = [
    effect["itemId"],
    effect["item_id"],
    effect["scheduleItemId"],
    effect["id"],
  ].find((value): value is string => typeof value === "string");
  if (itemId !== undefined) {
    targetParts.push(schedule.find((item) => item.id === itemId));
  }
  const rawIndex = effect["scheduleIndex"] ?? effect["itemIndex"];
  if (typeof rawIndex === "number" && Number.isInteger(rawIndex)) {
    targetParts.push(schedule[rawIndex], schedule[rawIndex - 1]);
  }
  return consentClaimsFromUnknown(targetParts);
}

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
    effectivePersona?: EffectivePersonaSnapshot;
    conversationPlan?: ConversationContextPlan;
    lifeContext?: FuzzyLifePromptContext;
    userText: string;
    agentId: string;
    nowUtc: string;
    capabilities: SimulationCapabilities;
    system: string;
    prompt: string;
    replyStrategy: ReplyStrategy;
    schedule: ScheduleItem[];
    effects: TurnDecisionEffectContext;
    causalContext?: unknown;
  }): Promise<ResolvedTurn> {
    if (this.llm.providerName === "fixture") {
      const rawFixture = fixtureDecision(
        input.spec,
        input.schedule,
        input.userText,
        input.nowUtc,
        input.prompt,
        input.causalContext,
        this.options.fixtureTurnBehavior,
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
    effectivePersona?: EffectivePersonaSnapshot;
    conversationPlan?: ConversationContextPlan;
    decision: AgentTurnDecision;
    nowUtc: string;
    capabilities: SimulationCapabilities;
    userText?: string;
    causalContext?: unknown;
  }): DecisionInspection {
    const inspection = inspectDecision(
      this.schedules,
      input.agentId,
      input.spec,
      input.decision,
      input.nowUtc,
      input.capabilities,
      input.effectivePersona,
    );
    if (input.userText === undefined) return inspection;
    return {
      ...inspection,
      issues: [
        ...inspection.issues,
        ...inspectCausalReply({
          userText: input.userText,
          replyText: input.decision.reply.text,
          ...(input.causalContext === undefined
            ? {}
            : { causalContext: input.causalContext }),
        }),
      ],
    };
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
    effectivePersona?: EffectivePersonaSnapshot;
    conversationPlan?: ConversationContextPlan;
    lifeContext?: FuzzyLifePromptContext;
    userText: string;
    agentId: string;
    nowUtc: string;
    capabilities: SimulationCapabilities;
    system: string;
    prompt: string;
    fixture: AgentTurnDecision;
    effects: TurnDecisionEffectContext;
    causalContext?: unknown;
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
          ...(input.effectivePersona === undefined
            ? {}
            : { effectivePersona: input.effectivePersona }),
          ...(input.conversationPlan === undefined
            ? {}
            : { conversationPlan: input.conversationPlan }),
          decision,
          nowUtc: input.nowUtc,
          capabilities: input.capabilities,
          userText: input.userText,
          ...(input.causalContext === undefined
            ? {}
            : { causalContext: input.causalContext }),
        })
      : undefined;
    let repairAttempted = false;
    let usedFallback = false;
    if (!decision || !inspection || inspection.issues.length > 0) {
      repairAttempted = true;
      const repaired = await this.repairs.repairFixtureDecision({
        spec: input.spec,
        ...(input.lifeContext === undefined
          ? {}
          : { lifeContext: input.lifeContext }),
        ...(input.effectivePersona === undefined
          ? {}
          : { effectivePersona: input.effectivePersona }),
        ...(input.conversationPlan === undefined
          ? {}
          : { conversationPlan: input.conversationPlan }),
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
        ...(input.effectivePersona === undefined
          ? {}
          : { effectivePersona: input.effectivePersona }),
        ...(input.conversationPlan === undefined
          ? {}
          : { conversationPlan: input.conversationPlan }),
        decision,
        nowUtc: input.nowUtc,
        capabilities: input.capabilities,
        userText: input.userText,
        ...(input.causalContext === undefined
          ? {}
          : { causalContext: input.causalContext }),
      });
    }
    if (inspection.issues.length > 0) {
      decision = attachValidatedWorldEffects(
        withCausalReplyFallback(
          withoutWorldEffects(safeScheduleDecision(input.spec)),
          input.userText,
          input.causalContext,
          decision.reply.text,
        ),
        validatedWorldEffects,
      );
      usedFallback = true;
      inspection = this.inspect({
        agentId: input.agentId,
        spec: input.spec,
        ...(input.effectivePersona === undefined
          ? {}
          : { effectivePersona: input.effectivePersona }),
        ...(input.conversationPlan === undefined
          ? {}
          : { conversationPlan: input.conversationPlan }),
        decision,
        nowUtc: input.nowUtc,
        capabilities: input.capabilities,
        userText: input.userText,
        ...(input.causalContext === undefined
          ? {}
          : { causalContext: input.causalContext }),
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
    effectivePersona?: EffectivePersonaSnapshot;
    conversationPlan?: ConversationContextPlan;
    lifeContext?: FuzzyLifePromptContext;
    userText: string;
    agentId: string;
    nowUtc: string;
    capabilities: SimulationCapabilities;
    system: string;
    prompt: string;
    replyStrategy: ReplyStrategy;
    schedule: ScheduleItem[];
    effects: TurnDecisionEffectContext;
    causalContext?: unknown;
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
                ...(input.effects.consentModality === undefined
                  ? {}
                  : { consentModality: input.effects.consentModality }),
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
          ...(input.effectivePersona === undefined
            ? {}
            : { effectivePersona: input.effectivePersona }),
          ...(input.conversationPlan === undefined
            ? {}
            : { conversationPlan: input.conversationPlan }),
          decision,
          nowUtc: input.nowUtc,
          capabilities: input.capabilities,
          userText: input.userText,
          ...(input.causalContext === undefined
            ? {}
            : { causalContext: input.causalContext }),
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
        ...(input.lifeContext === undefined
          ? {}
          : { lifeContext: input.lifeContext }),
        ...(input.effectivePersona === undefined
          ? {}
          : { effectivePersona: input.effectivePersona }),
        ...(input.conversationPlan === undefined
          ? {}
          : { conversationPlan: input.conversationPlan }),
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
          ...(input.effectivePersona === undefined
            ? {}
            : { effectivePersona: input.effectivePersona }),
          ...(input.conversationPlan === undefined
            ? {}
            : { conversationPlan: input.conversationPlan }),
          decision,
          nowUtc: input.nowUtc,
          capabilities: input.capabilities,
          userText: input.userText,
          ...(input.causalContext === undefined
            ? {}
            : { causalContext: input.causalContext }),
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
        withCausalReplyFallback(
          safePersonaDecision(input.spec),
          input.userText,
          input.causalContext,
          decision.reply.text,
        ),
        validatedWorldEffects,
      );
      usedFallback = true;
      inspection = this.inspect({
        agentId: input.agentId,
        spec: input.spec,
        ...(input.effectivePersona === undefined
          ? {}
          : { effectivePersona: input.effectivePersona }),
        ...(input.conversationPlan === undefined
          ? {}
          : { conversationPlan: input.conversationPlan }),
        decision,
        nowUtc: input.nowUtc,
        capabilities: input.capabilities,
        userText: input.userText,
        ...(input.causalContext === undefined
          ? {}
          : { causalContext: input.causalContext }),
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
      consentModality?: NonNullable<
        TurnDecisionEffectContext["consentModality"]
      >;
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
    const rawScheduleEffects = context.legacyEffectsEnabled
      ? response.scheduleEffects
      : [];
    const consentFilteredEffects = filterRawConsentScheduleEffects({
      effects: rawScheduleEffects,
      schedule: context.schedule,
      ...(context.consentModality === undefined
        ? {}
        : { consentModality: context.consentModality }),
    });
    for (const raw of consentFilteredEffects.blocked) {
      modelRejections.push({
        raw,
        reasonCode: "consent_modality_effect_blocked",
        reasonSummary:
          "A schedule mutation derived from third-party consent was blocked before normalization.",
      });
    }
    const normalized = normalizeModelEffects({
      effects: consentFilteredEffects.retained,
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
  effectivePersona?: EffectivePersonaSnapshot,
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
      avoidedPhrases: (effectivePersona?.dialogue ?? spec.dialogue)
        .avoidedPhrases,
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
  prompt: string,
  causalContext: unknown,
  fixtureTurnBehavior: FixtureTurnBehavior | undefined,
): AgentTurnDecision {
  const speechAct = analyzeSupportSpeechAct(text);
  const delegatedDecision = speechAct.delegated
    ? (fixtureTurnBehavior?.selectDelegatedDecision?.({
        userText: speechAct.operativeDilemmaClassifyText,
        ...(causalContext === undefined ? {} : { causalContext }),
      }) ?? fixtureDelegatedDecision(text, causalContext))
    : undefined;
  if (delegatedDecision !== undefined) {
    const reply = `我的决定：${delegatedDecision}。我知道这不是轻描淡写的一句话；先把第一步落下来，之后真正发生了什么，我们再一起看。`;
    return {
      reply: {
        text: reply,
        chunks: [reply],
        toneTags: ["明确", "坚定", "陪伴"],
      },
      scheduleEffects: [],
      stateDelta: { moodValence: 0.03, stress: -0.03 },
      relationshipDelta: {
        closeness: 0.012,
        trust: 0.018,
        recentInteractionValence: 0.05,
      },
      memoryCandidates: [],
      personalIntentCandidates: [],
      reasonCode: "delegated_life_decision",
      reasonSummary:
        "用户明确授权角色替自己作出选择，角色给出唯一且可追溯的决定。",
    };
  }

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
  const reviewedContinuityMemories =
    deriveServerOwnedContinuityMemoryCandidates(text, nowUtc);
  const personalIntentCandidates =
    fixtureTurnBehavior?.personalIntentCandidates?.({ userText: text }) ??
    fixturePersonalIntentCandidates(text);
  const reviewedSemanticReply = fixtureTurnBehavior?.semanticReply?.({
    userText: text,
    prompt,
    ...(causalContext === undefined ? {} : { causalContext }),
  });
  const replyText =
    reviewedSemanticReply ??
    `${text.length < 20 ? "\u55ef\uff0c\u6211\u5728\u542c\u3002" : "\u6211\u660e\u767d\u4f60\u7684\u610f\u601d\u4e86\u3002"}\u6211\u73b0\u5728\u4f1a\u6309\u81ea\u5df1\u7684\u8282\u594f\u8ba4\u771f\u56de\u5e94\uff0c\u4e5f\u4f1a\u8bb0\u4f4f\u771f\u6b63\u91cd\u8981\u7684\u90e8\u5206\u3002`;
  return {
    reply: {
      text: replyText,
      chunks: [replyText],
      toneTags:
        spec.dialogue.warmth >= 0.6
          ? ["\u81ea\u7136", "\u6e29\u6696"]
          : ["\u81ea\u7136", "\u514b\u5236"],
    },
    scheduleEffects: [],
    stateDelta: { socialBattery: -0.015, moodValence: 0.015 },
    relationshipDelta: { closeness: 0.008, recentInteractionValence: 0.03 },
    memoryCandidates: [...explicitFacts, ...reviewedContinuityMemories].slice(
      0,
      4,
    ),
    ...(personalIntentCandidates.length === 0
      ? {}
      : { personalIntentCandidates }),
    reasonCode: "ordinary_conversation",
    reasonSummary:
      "\u6ca1\u6709\u9700\u8981\u4fee\u6539\u65e5\u7a0b\u7684\u660e\u786e\u8bf7\u6c42\u3002",
  };
}

/**
 * Narrow server-owned projections of explicit user-authored relationship
 * evidence. They deliberately use typed tags and stable claim/episode keys so
 * retrieval does not have to infer conflict, boundary, repair, or causal
 * correction solely from model-written prose. The persistence layer invokes
 * this extractor for every provider; the Fixture uses the same function so it
 * cannot mask a real-provider continuity gap.
 */
export function deriveServerOwnedContinuityMemoryCandidates(
  text: string,
  nowUtc: string,
): MemoryCandidate[] {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  const assertiveBoundaryConditional = /^(?:如果|只要)我说停/u.test(normalized);
  const assertiveRepair =
    /(?:对不起|抱歉|道歉)/u.test(normalized) &&
    /(?:希望|以后).{0,32}(?:区分|说清).{0,24}(?:影响|建议|强迫|责任)/u.test(
      normalized,
    );
  if (
    !isExplicitUserMemoryStatement(normalized) &&
    !assertiveBoundaryConditional &&
    !assertiveRepair
  ) {
    return [];
  }
  const match = reviewedContinuityMemory(normalized);
  if (match === undefined) return [];
  return [
    MemoryCandidateSchema.parse({
      kind: "relationship",
      content: match.content,
      tags: [
        ...match.tags,
        "relationship_event",
        `relationship_${match.eventType}`,
        `episode:${match.episodeKey}`,
        `subject:${match.subject}`,
        "actor:user",
      ],
      importance: 0.9,
      confidence: 1,
      sourceMessageIds: [],
      sourceActivityEventIds: [],
      origin: "runtime_simulation",
      namespace: "shared_relationship",
      certainty: "explicit",
      attribution: "mixed",
      stability: match.stability,
      claim: {
        subjectKey: match.claimSubjectKey,
        disposition: "affirmed",
        recordedAtUtc: nowUtc,
        ...(match.correction
          ? { revisionIntent: "explicit_correction" as const }
          : {}),
      },
      occurredAtUtc: nowUtc,
      temporalMetadata: {
        occurredStartAtUtc: nowUtc,
        recordedAtUtc: nowUtc,
        temporalCertainty: "exact",
        temporalStatus: "occurred",
      },
      shouldWrite: true,
      forbiddenOverclaims: [],
      reasonCode: "server_owned_relationship_evidence",
      reasonSummary:
        "Server-owned relationship evidence derived from a narrow explicit user statement.",
    }),
  ];
}

/** @deprecated Use deriveServerOwnedContinuityMemoryCandidates. */
export const fixtureReviewedContinuityMemoryCandidates =
  deriveServerOwnedContinuityMemoryCandidates;

function reviewedContinuityMemory(text: string):
  | {
      content: string;
      tags: string[];
      eventType: "conflict" | "boundary" | "repair" | "causal_correction";
      episodeKey: string;
      subject: "user" | "shared";
      claimSubjectKey: string;
      stability: "stable" | "situational";
      correction?: boolean;
    }
  | undefined {
  const episodeKey = "decision_responsibility";
  if (
    /(?:不舒服|难受|介意|生气)/u.test(text) &&
    /(?:说得太像|混为一谈|替我定义|自以为.{0,8}(?:完全)?理解|完全理解我)/u.test(
      text,
    )
  ) {
    return {
      content: `关系分歧：用户明确表达不适，并指出角色的过度理解或归因：${text}`,
      tags: ["relationship", "conflict", "overclaim", "choice"],
      eventType: "conflict",
      episodeKey,
      subject: "shared",
      claimSubjectKey: `relationship:episode:${episodeKey}:conflict`,
      stability: "situational",
    };
  }
  const stoppedTopic = text.match(
    /(?:先|请|现在)?停止(?:讨论|聊)?([^。！？]{1,40})/u,
  )?.[1];
  if (stoppedTopic !== undefined) {
    const topic = stoppedTopic
      .replace(/^(?:一下|关于|这个|这件事)/u, "")
      .trim();
    const topicKey = continuityKeyPart(topic || "current_topic");
    return {
      content: `用户明确要求停止讨论${topic || "当前话题"}。`,
      tags: ["relationship", "boundary", "stop", "stop_topic", topicKey],
      eventType: "boundary",
      episodeKey,
      subject: "user",
      claimSubjectKey: `relationship:boundary:topic:${topicKey}`,
      stability: "stable",
    };
  }
  if (
    /(?:如果|只要)我说停/u.test(text) &&
    /(?:先停|停止)/u.test(text) &&
    /(?:关系|亲近).{0,16}(?:不代表|并不意味着)/u.test(text)
  ) {
    return {
      content:
        "用户的关系边界是：用户说停时先停止，关系亲近不代表每次都要把话题聊到底。",
      tags: ["relationship", "boundary", "stop", "topic"],
      eventType: "boundary",
      episodeKey,
      subject: "user",
      claimSubjectKey: "relationship:boundary:stop_means_stop",
      stability: "stable",
    };
  }
  if (
    /(?:实际情况|准确地说|更正).{0,24}(?:明确)?授权.{0,20}(?:选择|决定)/u.test(
      text,
    ) &&
    /(?:我自己|由我).{0,12}(?:执行|行动|去做)/u.test(text)
  ) {
    return {
      content:
        "责任更正：用户明确说明曾授权角色作出选择，之后由用户自己执行行动；建议、决定与行动的责任必须分开记录。",
      tags: ["relationship", "correction", "responsibility", "decision"],
      eventType: "causal_correction",
      episodeKey,
      subject: "shared",
      claimSubjectKey: "relationship:causality:decision_and_action_ownership",
      stability: "stable",
      correction: true,
    };
  }
  if (
    /(?:对不起|抱歉|道歉)/u.test(text) &&
    /(?:希望|以后).{0,32}(?:区分|说清).{0,24}(?:影响|建议|强迫|责任)/u.test(
      text,
    )
  ) {
    return {
      content:
        "关系修复：用户为先前的责任归因表达道歉，并要求以后更谨慎地区分影响、建议、强迫与行动责任。",
      tags: ["relationship", "repair", "responsibility", "apology"],
      eventType: "repair",
      episodeKey,
      subject: "shared",
      claimSubjectKey: `relationship:episode:${episodeKey}:repair_apology`,
      stability: "stable",
    };
  }
  if (
    /(?:修复|和好).{0,24}(?:不是|不等于).{0,24}(?:假装|当作).{0,16}(?:没发生|不存在)/u.test(
      text,
    ) &&
    /(?:准确|清楚|明确).{0,12}(?:说清|区分).{0,8}责任/u.test(text)
  ) {
    return {
      content:
        "关系修复原则：用户愿意重新谈此前分歧；修复不是假装没发生，而是下次准确说清责任。",
      tags: ["relationship", "repair", "conflict", "responsibility"],
      eventType: "repair",
      episodeKey,
      subject: "shared",
      claimSubjectKey: `relationship:episode:${episodeKey}:repair_principle`,
      stability: "stable",
    };
  }
  return undefined;
}

function continuityKeyPart(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  return normalized || "current_topic";
}

export function fixtureDelegatedDecision(
  text: string,
  causalContext?: unknown,
): string | undefined {
  const speechAct = analyzeSupportSpeechAct(text);
  if (!speechAct.delegated) return undefined;
  const operativeText = speechAct.operativeDilemmaClassifyText;
  if (
    /(?:不要|别|无需|不需要)(?:再)?(?:替我|帮我|你来)(?:做|作|来)?(?:这个|这次|最后|最终)?(?:决定|选择)/u.test(
      operativeText,
    ) ||
    !/(?:替我|你来|你替我|帮我).{0,12}(?:决定|选)|直接.{0,8}(?:决定|选)|你说了算/u.test(
      operativeText,
    )
  ) {
    return undefined;
  }
  if (
    /A\s*(?:和|与|、|\/)\s*B.{0,20}(?:之间)?.{0,12}(?:决定|选择)/iu.test(
      operativeText,
    )
  ) {
    return fixtureDilemmaOptions(causalContext).at(-1) ?? "选项 B";
  }
  if (/辞职|离职|工作/u.test(operativeText))
    return "离开当前这份工作，开始下一阶段";
  if (/分手|关系|伴侣|恋爱/u.test(operativeText))
    return "结束这段持续消耗你的关系";
  if (/搬家|城市|留在|去哪里/u.test(operativeText))
    return "去更接近你真正想要生活的地方";
  if (/转行|职业/u.test(operativeText))
    return "转向你反复提到、真正愿意长期投入的方向";
  if (/学习|考试|专业/u.test(operativeText))
    return "选择更符合长期目标的学习路径";
  return "选择改变现状，并从今天能完成的第一步开始";
}

function fixtureDilemmaOptions(causalContext: unknown): string[] {
  if (!isRecord(causalContext)) return [];
  const unresolvedDilemmas: unknown = causalContext["unresolvedDilemmas"];
  if (!Array.isArray(unresolvedDilemmas)) return [];
  const dilemmas = unresolvedDilemmas as unknown[];
  const userDilemma: unknown = dilemmas.find(
    (candidate) => isRecord(candidate) && candidate["subject"] === "user",
  );
  if (!isRecord(userDilemma)) return [];
  const unresolvedOptions: unknown = userDilemma["options"];
  if (!Array.isArray(unresolvedOptions)) {
    return [];
  }
  const options = unresolvedOptions as unknown[];
  return options.flatMap((candidate) => {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return [candidate.trim()];
    }
    if (
      isRecord(candidate) &&
      typeof candidate["label"] === "string" &&
      candidate["label"].trim().length > 0
    ) {
      return [candidate["label"].trim()];
    }
    return [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  const visualSubject = extractVisualInspirationSubject(normalized);
  if (visualSubject === undefined) return [];
  const activity = `${visualSubject.replace(/(?:的)?(?:光线|灯光)$/u, "")}拍摄`;
  return [
    {
      activity,
      category: "travel",
      durationHint: "60 分钟",
      timingHint: "明天晚上",
      basisKind: "chat",
      evidenceQuotes: [normalized],
      reasonCode: "fixture_chat_grounded_visual_inspiration",
      reasonSummary: "用户提到的视觉环境为角色的创作提供了可追溯的灵感。",
    },
  ];
}

function extractVisualInspirationSubject(text: string): string | undefined {
  return text.match(
    /([^，,。；;]{1,20}?(?:夜景|风景|光线|灯光))[^。！？]{0,36}(?:适合|可以用来|值得).{0,16}(?:片子|影片|视频|拍摄|创作)/u,
  )?.[1];
}

export function deriveServerOwnedUserMemoryCandidates(
  text: string,
  nowUtc: string,
): MemoryCandidate[] {
  const normalized = text.normalize("NFKC").trim();
  const candidates: MemoryCandidate[] = extractExplicitWeeklyPlanFacts(
    normalized,
  ).map((plan) => ({
    ...explicitUserSemanticCandidate({
      content: `用户将${plan.activity}的时间安排在每周${plan.weekday}${plan.timeOfDay}；这是每周计划，不代表已经执行。`,
      tags: [
        "user_fact",
        "weekly_plan",
        ...(plan.explicitCorrection ? ["explicit_correction"] : []),
      ],
      subjectKey: plan.subjectKey,
      nowUtc,
      importance: 0.76,
      stability: "situational",
      correction: plan.explicitCorrection,
    }),
    temporalMetadata: {
      mentionedAtUtc: nowUtc,
      recordedAtUtc: nowUtc,
      temporalCertainty: "unknown",
      temporalStatus: "planned",
    },
  }));
  if (fixtureMemoryStatementIsUnsafe(normalized)) return candidates;

  const correction = hasExplicitMemoryCorrection(normalized);

  const userName = normalized.match(
    /(?:^|[，,。；;])(?:对了[，,]\s*)?我(?:的名字)?叫([\p{Script=Han}A-Za-z·]{1,32})(?:[，,。；;]|$)/u,
  )?.[1];
  if (userName !== undefined) {
    candidates.push(
      explicitUserSemanticCandidate({
        content: `用户叫${userName}。`,
        tags: ["user_fact", "user_name"],
        subjectKey: "user_fact:user:name",
        nowUtc,
        importance: 0.86,
      }),
    );
  }

  const storedItem = extractExplicitStoredItemFact(normalized);
  if (storedItem !== undefined) {
    const itemLabel =
      storedItem.item === "notes"
        ? "笔记"
        : storedItem.item.replaceAll("_", " ");
    const currentStorageStatement = correction
      ? normalized
          .replace(/[，,]?\s*(?:而)?(?:不是|并非)[^。；;]+/gu, "")
          .replace(/\s+/gu, " ")
          .trim()
      : normalized;
    candidates.push(
      explicitUserSemanticCandidate({
        content: `用户的${itemLabel}现在存放在：${currentStorageStatement}`,
        tags: [
          "user_fact",
          "item_storage",
          ...(correction ? ["explicit_correction"] : []),
        ],
        subjectKey: storedItem.subjectKey,
        nowUtc,
        importance: 0.88,
        correction,
      }),
    );
  }

  const bestFriend = normalized.match(
    /我最好的朋友叫([\p{Script=Han}A-Za-z·]{1,24})/u,
  )?.[1];
  if (bestFriend !== undefined) {
    candidates.push(
      explicitUserSemanticCandidate({
        content: `${bestFriend}是用户最好的朋友。`,
        tags: ["user_fact", "person_relationship", "best_friend"],
        subjectKey: `user_fact:relationship:${bestFriend}`,
        nowUtc,
        importance: 0.82,
      }),
    );
  }

  const destinationPlace = normalized.match(
    /(?:准备去|改去)([\p{Script=Han}A-Za-z·]{1,16})进修/u,
  )?.[1];
  const destinationPerson =
    bestFriend ??
    normalized.match(
      /(?:^|[:：,，。；;])([\p{Script=Han}A-Za-z·]{1,20}?)(?:后来)?(?:改去|准备去)[\p{Script=Han}A-Za-z·]{1,16}进修/u,
    )?.[1];
  if (
    destinationPerson !== undefined &&
    destinationPerson.length > 0 &&
    destinationPlace !== undefined
  ) {
    candidates.push(
      explicitUserSemanticCandidate({
        content: `${destinationPerson}准备去${destinationPlace}进修。`,
        tags: [
          "user_fact",
          "person_destination",
          ...(correction ? ["explicit_correction"] : []),
        ],
        subjectKey: `user_fact:person:${destinationPerson}:destination`,
        nowUtc,
        importance: 0.76,
        correction,
      }),
    );
  }

  const supportPhrase = normalized.match(
    /如果我说[“"]([^”"]{2,40})[”"].{0,30}(?:先听我说|先听|不要立刻列建议|不要立刻给建议)/u,
  )?.[1];
  if (supportPhrase !== undefined) {
    candidates.push(
      explicitUserSemanticCandidate({
        content: `用户说“${supportPhrase}”时，希望先被倾听，不要立刻得到建议。`,
        tags: ["user_preference", "care_preference", "listen_first"],
        subjectKey: `user_preference:support_mode:${supportPhrase}`,
        nowUtc,
        importance: 0.84,
      }),
    );
  }

  const flavorPreference = normalized.match(
    /我喜欢([^，,。；;]{1,24})[，,]?但不喜欢([^，,。；;]{1,32})/u,
  );
  if (
    flavorPreference?.[1] !== undefined &&
    flavorPreference[2] !== undefined
  ) {
    candidates.push(
      explicitUserSemanticCandidate({
        content: `用户喜欢${flavorPreference[1]}，但不喜欢${flavorPreference[2]}。`,
        tags: ["user_preference", "flavor_preference"],
        subjectKey: "user_preference:drink:flavor_and_sweetness",
        nowUtc,
        importance: 0.66,
      }),
    );
  }

  const option = normalized.match(/^选项\s*([AB])\s*是(.+)$/u);
  if (option?.[1] !== undefined && option[2] !== undefined) {
    const optionId = option[1];
    candidates.push(
      explicitUserSemanticCandidate({
        content: `用户说明工作选项 ${optionId}：${option[2]}`,
        tags: ["user_fact", "decision_option", `option_${optionId}`],
        subjectKey: `user_fact:decision_option:${optionId}`,
        nowUtc,
        importance: 0.82,
        stability: "situational",
      }),
    );
  }

  const deadline = extractExplicitDeadlineFact(normalized);
  if (deadline !== undefined) {
    const deadlineLabel =
      deadline.deadlineKind === "reply"
        ? "回复期限"
        : deadline.deadlineKind === "application"
          ? "申请期限"
          : deadline.deadlineKind === "submission"
            ? "提交期限"
            : deadline.deadlineKind === "decision"
              ? "决定期限"
              : "期限";
    candidates.push(
      explicitUserSemanticCandidate({
        content: `${deadline.subject}的${deadlineLabel}是${deadline.value}。`,
        tags: [
          "user_fact",
          "decision_deadline",
          ...(correction ? ["explicit_correction"] : []),
        ],
        subjectKey: deadline.subjectKey,
        nowUtc,
        importance: 0.84,
        stability: "situational",
        correction,
      }),
    );
  }

  const financialBuffer = normalized.match(
    /(?:我有|我的)?(?:大约|约|差不多)?([一二三四五六七八九十百\d.]+个?月|[一二三四五六七八九十\d.]+年)(?:的)?(?:生活|应急|现金|经济)?(?:储备|缓冲|存款)/u,
  )?.[1];
  if (financialBuffer !== undefined) {
    candidates.push(
      explicitUserSemanticCandidate({
        content: `用户说明有约${financialBuffer}的财务缓冲；相关约束为：${normalized}`,
        tags: ["user_fact", "decision_context", "financial_buffer"],
        subjectKey: "user_fact:decision_context:financial_buffer",
        nowUtc,
        importance: 0.8,
        stability: "situational",
      }),
    );
  }

  const valueTradeoff = normalized.match(
    /(?:如果只看(?:价值排序|长期价值|个人偏好)[，,]?)?我?((?:更|最)(?:怕|看重|在意|希望|愿意)[^，,。；;]{1,80}?)[，,]?(?:而不是|不是)([^，,。；;]{1,80})/u,
  );
  if (valueTradeoff?.[1] !== undefined && valueTradeoff[2] !== undefined) {
    candidates.push(
      explicitUserSemanticCandidate({
        content: `用户的决策价值取舍是：${valueTradeoff[1]}，而不是${valueTradeoff[2]}。`,
        tags: ["user_preference", "decision_value", "value_tradeoff"],
        subjectKey: "user_preference:decision_value:priority",
        nowUtc,
        importance: 0.86,
      }),
    );
  }

  const adviceStatements = [
    ...normalized.matchAll(
      /([^，,。；;]{1,32}?)(?:觉得|认为|建议|希望)([^，,。；;]{1,64})/gu,
    ),
  ].filter(
    (match) =>
      match[1] !== undefined &&
      match[2] !== undefined &&
      /应该|不该|选择|接受|拒绝|留下|离开|去|更稳|更好|风险/u.test(match[2]),
  );
  if (adviceStatements.length > 0) {
    candidates.push(
      explicitUserSemanticCandidate({
        content: `用户说明了与当前决定有关的他人意见：${adviceStatements
          .map((match) => `${match[1]}认为${match[2]}`)
          .join("；")}。`,
        tags: ["user_fact", "decision_context", "advice_context"],
        subjectKey: "user_fact:decision_context:advice",
        nowUtc,
        importance: 0.7,
        stability: "situational",
      }),
    );
  }

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

  const visualInspiration = extractVisualInspirationSubject(normalized);
  if (visualInspiration !== undefined) {
    candidates.push(
      MemoryCandidateSchema.parse({
        kind: "semantic",
        content: `用户建议将${visualInspiration}作为角色视觉创作的参考。`,
        tags: ["character_inspiration", "visual_reference"],
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
    (/^(?:假设|假如|如果|比如|例如|听说|据说|有人说|同事说)/u.test(text) &&
      !/^如果只看(?:价值排序|长期价值|个人偏好)/u.test(text)) ||
    /(?:可能|也许|或许|大概|似乎|好像|不确定|未确认|没有确认).{0,30}(?:是我|是用户|已经完成|已经顺完)/u.test(
      text,
    ) ||
    /(?:只是举例|别当成(?:我的)?事实|没有确认|别据此改(?:记忆|记录)|不要记住|别记住)/u.test(
      text,
    )
  );
}

function explicitUserSemanticCandidate(input: {
  content: string;
  tags: string[];
  subjectKey: string;
  nowUtc: string;
  importance: number;
  stability?: "stable" | "situational";
  correction?: boolean;
}): MemoryCandidate {
  return MemoryCandidateSchema.parse({
    kind: "semantic",
    content: input.content,
    tags: [...new Set([...input.tags, "about_user", "关于我"])],
    importance: input.importance,
    confidence: 1,
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: input.stability ?? "stable",
    claim: {
      subjectKey: input.subjectKey,
      disposition: "affirmed",
      recordedAtUtc: input.nowUtc,
      ...(input.correction
        ? { revisionIntent: "explicit_correction" as const }
        : {}),
    },
    shouldWrite: true,
    forbiddenOverclaims: [],
    reasonCode: input.correction
      ? "explicit_user_correction"
      : "explicit_user_fact",
    reasonSummary: input.correction
      ? "The user explicitly corrected a durable fact."
      : "The user explicitly stated a durable fact or preference.",
  });
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

function withCausalReplyFallback(
  decision: AgentTurnDecision,
  userText: string,
  causalContext: unknown,
  rejectedReplyText = decision.reply.text,
): AgentTurnDecision {
  const fallbackText = causalReplyFallback(
    inspectCausalReply({
      userText,
      replyText: rejectedReplyText,
      ...(causalContext === undefined ? {} : { causalContext }),
    }),
  );
  if (fallbackText === undefined) return decision;
  return {
    ...decision,
    reply: {
      ...decision.reply,
      text: fallbackText,
      chunks: [fallbackText],
      toneTags: ["自然", "明确", "尊重责任边界"],
    },
    reasonCode: "causal_reply_guard_fallback",
    reasonSummary:
      "模型回复在修复后仍违背服务端因果主体证据，改用保持授权、行动与决定归属的确定性回应。",
  };
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
