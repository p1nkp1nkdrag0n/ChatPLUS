import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type {
  DefaultPromptContext,
  PromptSegment,
  WorldEffectRejection,
  WorldEffectsValidationResult,
} from "@personasim/features";

import type { AgentTurnDecision } from "../domain/schemas.js";
import {
  CONSENT_MODALITY_POLICY_VERSION,
  analyzeThirdPartyConsentContainment,
  analyzeThirdPartyConsentFollowUp,
  consentClaimsFromUnknown,
  isConsentControlledActivity,
  isConsentDerivedSemanticCandidate,
  isUnsupportedConsentAssertion,
  type ThirdPartyConsentClaim,
  type ThirdPartyConsentScopeKind,
  type ThirdPartyConsentStatus,
} from "./consent-modality.js";
import type {
  ConsentModalityGuardAudit,
  DecisionInspection,
  ResolvedTurn,
  TurnDecisionEffectContext,
} from "./turn-decision-service.js";
import type { PreparedWorldEffectTurn } from "./world-effect-service.js";

const BLOCKED_EFFECT_REASON = "consent_modality_effect_blocked";

export interface ConsentModalityGuardContract {
  policyVersion: typeof CONSENT_MODALITY_POLICY_VERSION;
  sourceKind: "assertion" | "query" | "mixed";
  subject: string;
  status: ThirdPartyConsentStatus;
  scopes: ReadonlyArray<{
    kind: ThirdPartyConsentScopeKind;
    label: string;
    resource: string;
    beneficiary?: string;
    beneficiaryKey?: string;
    restrictions?: string[];
  }>;
  claims: readonly ThirdPartyConsentClaim[];
  consentOnly: boolean;
  independentText: string;
  evidenceText: string;
  safeReplyText: string;
}

export function buildConsentModalityGuardContract(input: {
  userText: string;
  priorClaims?: readonly ThirdPartyConsentClaim[];
}): ConsentModalityGuardContract | undefined {
  const directAnalysis = analyzeThirdPartyConsentContainment(input.userText);
  const analysis =
    directAnalysis.claims.length > 0
      ? directAnalysis
      : analyzeThirdPartyConsentFollowUp(
          input.userText,
          input.priorClaims ?? [],
        );
  const primary = analysis.claims[0];
  if (primary === undefined) return undefined;
  const claims = analysis.claims.map((claim) => ({ ...claim }));
  const claimSourceKinds = new Set(claims.map((claim) => claim.sourceKind));
  const sourceKind: ConsentModalityGuardContract["sourceKind"] =
    claimSourceKinds.size > 1 ? "mixed" : primary.sourceKind;
  const contract = {
    policyVersion: CONSENT_MODALITY_POLICY_VERSION,
    sourceKind,
    subject: primary.subject,
    status: primary.status,
    scopes: claims.map((claim) => ({
      kind: claim.scopeKind,
      label: claim.scopeLabel,
      resource: claim.resource,
      ...(claim.beneficiary === undefined
        ? {}
        : {
            beneficiary: claim.beneficiary,
            beneficiaryKey: claim.beneficiaryKey,
          }),
      ...(claim.restrictions === undefined
        ? {}
        : { restrictions: [...claim.restrictions] }),
    })),
    claims,
    consentOnly: analysis.consentOnly,
    independentText: analysis.independentText,
    evidenceText: normalizeEvidence(input.userText),
  };
  const renderedReply = renderSafeConsentReply(contract);
  const safeReplyText = isUnsupportedConsentAssertion({
    authoritativeText: contract.evidenceText,
    authoritativeClaims: contract.claims,
    candidateText: renderedReply,
  })
    ? "我会严格按你刚才描述的第三方授权边界处理：不把可能或待确认当成已经授权，也不把任何范围扩展到未明确提及的对象、资源、用途或时限。"
    : renderedReply;
  return {
    ...contract,
    safeReplyText,
  };
}

export function consentModalityClaimsFromAudit(
  value: unknown,
): ThirdPartyConsentClaim[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  const rawClaims = (value as Record<string, unknown>)["claims"];
  if (!Array.isArray(rawClaims)) return [];
  const statuses = new Set<ThirdPartyConsentStatus>([
    "possible",
    "pending",
    "granted",
    "denied",
    "revoked",
  ]);
  const scopeKinds = new Set<ThirdPartyConsentScopeKind>([
    "view",
    "publish",
    "display",
    "share",
    "forward",
    "download",
    "copy",
    "use",
    "adapt",
  ]);
  return rawClaims.flatMap((raw): ThirdPartyConsentClaim[] => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return [];
    }
    const claim = raw as Record<string, unknown>;
    const sourceKind = claim["sourceKind"];
    const subject = claim["subject"];
    const subjectKey = claim["subjectKey"];
    const status = claim["status"];
    const scopeKind = claim["scopeKind"];
    const scopeKey = claim["scopeKey"];
    const scopeLabel = claim["scopeLabel"];
    const resource = claim["resource"];
    const evidenceText = claim["evidenceText"];
    if (
      (sourceKind !== "assertion" && sourceKind !== "query") ||
      typeof subject !== "string" ||
      typeof subjectKey !== "string" ||
      typeof status !== "string" ||
      !statuses.has(status as ThirdPartyConsentStatus) ||
      typeof scopeKind !== "string" ||
      !scopeKinds.has(scopeKind as ThirdPartyConsentScopeKind) ||
      typeof scopeKey !== "string" ||
      typeof scopeLabel !== "string" ||
      typeof resource !== "string" ||
      typeof evidenceText !== "string"
    ) {
      return [];
    }
    const beneficiary = claim["beneficiary"];
    const beneficiaryKey = claim["beneficiaryKey"];
    const restrictions = claim["restrictions"];
    return [
      {
        sourceKind,
        subject,
        subjectKey,
        status: status as ThirdPartyConsentStatus,
        scopeKind: scopeKind as ThirdPartyConsentScopeKind,
        scopeKey,
        scopeLabel,
        resource,
        evidenceText,
        ...(typeof beneficiary === "string" &&
        typeof beneficiaryKey === "string"
          ? { beneficiary, beneficiaryKey }
          : {}),
        ...(Array.isArray(restrictions) &&
        restrictions.every((item) => typeof item === "string")
          ? { restrictions: [...restrictions] as string[] }
          : {}),
      },
    ];
  });
}

/** A mixed turn is not a unique conversational referent, even when it happens
 * to contain only one consent claim. Keep the audit intact, but do not use it
 * to resolve a later object-free answer. */
export function consentModalityFollowUpClaimsFromAudit(
  value: unknown,
): ThirdPartyConsentClaim[] {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Record<string, unknown>)["consentOnly"] !== true
  ) {
    return [];
  }
  return consentModalityClaimsFromAudit(value);
}

export function consentModalityPromptSegment(
  contract: ConsentModalityGuardContract,
): PromptSegment<DefaultPromptContext> {
  const payload = {
    policyVersion: contract.policyVersion,
    sourceKind: contract.sourceKind,
    consentOnly: contract.consentOnly,
    evidenceText: contract.evidenceText,
    claims: contract.claims.map((claim) => ({
      subject: claim.subject,
      beneficiary: claim.beneficiary,
      beneficiaryKey: claim.beneficiaryKey,
      sourceKind: claim.sourceKind,
      status: claim.status,
      scopeKind: claim.scopeKind,
      scopeLabel: claim.scopeLabel,
      resource: claim.resource,
      restrictions: claim.restrictions,
    })),
  };
  return {
    id: "14a_consent_modality_guard",
    placement: "prompt",
    priority: 97,
    tokenBudget: 900,
    required: true,
    cacheable: false,
    render: () =>
      [
        "THIRD-PARTY CONSENT MODALITY IS SERVER-CONTROLLED.",
        "Keep the named subject, resource, scope, polarity, and time modality exact. possible/pending is never granted.",
        "A grant for one scope never grants publication, display, sharing, forwarding, downloading, copying, use, adaptation, or any other omitted scope.",
        "Do not turn a restriction, absence of confirmation, historical grant, conditional statement, or possible willingness into a current permission. Do not invent a denial for an omitted scope either.",
        "CONSENT_MODALITY_GUARD_JSON",
        JSON.stringify(payload),
      ].join("\n"),
  };
}

export function consentModalityEffectContext(
  current: TurnDecisionEffectContext,
  contract: ConsentModalityGuardContract,
): TurnDecisionEffectContext {
  return contract.consentOnly
    ? {
        effectsEligible: false,
        scheduleNegotiationEligible: false,
        negotiationEnforced: false,
      }
    : {
        ...current,
        consentModality: {
          evidenceText: contract.evidenceText,
          claims: contract.claims.map((claim) => ({ ...claim })),
        },
      };
}

export function applyConsentModalityGuard(input: {
  turn: ResolvedTurn;
  contract: ConsentModalityGuardContract;
  inspectDecision: (decision: AgentTurnDecision) => DecisionInspection;
}): ResolvedTurn {
  const guardedReply = guardReply(input.turn.decision, input.contract);
  const sanitizedDecision = sanitizeDecision(
    guardedReply.decision,
    input.contract,
  );
  const sanitizedTurnContinuity = sanitizeUnknownEffect(
    input.turn.continuityEffects,
    input.contract,
  );
  const worldEffectsAudit = sanitizeWorldEffectsAudit(
    input.turn.worldEffectsAudit,
    input.contract,
  );
  const sanitizedScheduleAction = sanitizeScheduleAction(
    input.turn.scheduleAction,
    input.contract,
  );
  const scheduleAction = sanitizedScheduleAction.action;
  const blockedByGuard =
    sanitizedDecision.blocked ||
    sanitizedTurnContinuity.blocked ||
    worldEffectsAudit.blocked ||
    sanitizedScheduleAction.blocked;
  const alreadyHasConsentEffectRejection = input.turn.modelRejections.some(
    (rejection) => rejection.reasonCode === BLOCKED_EFFECT_REASON,
  );
  const blocked = blockedByGuard || alreadyHasConsentEffectRejection;
  const nextTurn = { ...input.turn };
  if (sanitizedTurnContinuity.value === undefined) {
    delete nextTurn.continuityEffects;
  } else {
    nextTurn.continuityEffects = sanitizedTurnContinuity.value;
  }

  return {
    ...nextTurn,
    decision: sanitizedDecision.decision,
    inspection: input.inspectDecision(sanitizedDecision.decision),
    modelRejections: [
      ...input.turn.modelRejections,
      ...(blockedByGuard && !alreadyHasConsentEffectRejection
        ? [
            {
              raw: blockedEffectSummary(input.turn, input.contract),
              reasonCode: BLOCKED_EFFECT_REASON,
              reasonSummary:
                "Third-party consent semantics require authoritative scope and modality; unsupported model effects were not applied.",
            },
          ]
        : []),
    ],
    scheduleAction,
    modelScheduleActionAudit: sanitizedScheduleAction.blocked
      ? { origin: "model_invalid", kind: "none" }
      : input.turn.modelScheduleActionAudit,
    ...(worldEffectsAudit.value === undefined
      ? {}
      : { worldEffectsAudit: worldEffectsAudit.value }),
    consentModalityGuardAudit: buildGuardAudit({
      contract: input.contract,
      finalText: sanitizedDecision.decision.reply.text,
      modelReplyContentChanged: guardedReply.changed,
      modelSideEffectsBlocked: blocked,
    }),
  };
}

/**
 * World resolution may add deterministic schedule presentation text or perform
 * another reply repair. Re-check the final text and effects before commit so
 * reply truthfulness, audit hash, memory writes, and continuity stay atomic.
 */
export function finalizeConsentModalityWorld(input: {
  turn: ResolvedTurn;
  world: PreparedWorldEffectTurn;
  contract: ConsentModalityGuardContract;
}): { turn: ResolvedTurn; world: PreparedWorldEffectTurn } {
  const acceptedScheduleEffects = input.world.validation.accepted.filter(
    (effect) => !isConsentScheduleEffect(effect, input.contract),
  );
  const blockedAcceptedEffects = input.world.validation.accepted.filter(
    (effect) => isConsentScheduleEffect(effect, input.contract),
  );
  const negotiationPlanBlocked =
    input.world.negotiationPlan !== undefined &&
    isConsentNegotiationPlan(input.world.negotiationPlan, input.contract);
  const worldDecisionWithoutBlockedPresentation =
    negotiationPlanBlocked &&
    input.world.negotiationPlan?.presentationText !== undefined
      ? replaceReply(
          input.world.decision,
          removeSchedulePresentation(
            input.world.decision.reply.text,
            input.world.negotiationPlan.presentationText,
          ),
        )
      : input.world.decision;
  const sanitizedWorldDecision = sanitizeDecision(
    worldDecisionWithoutBlockedPresentation,
    input.contract,
  );
  const guardedReply = guardReply(
    sanitizedWorldDecision.decision,
    input.contract,
  );
  const safePresentation = negotiationPlanBlocked
    ? undefined
    : input.world.negotiationPlan?.presentationText;
  const safeFinalText = guardedReply.changed
    ? appendServerSchedulePresentation(
        guardedReply.decision.reply.text,
        safePresentation,
      )
    : guardedReply.decision.reply.text;
  const finalDecision = sanitizeDecision(
    safeFinalText === guardedReply.decision.reply.text
      ? guardedReply.decision
      : replaceReply(guardedReply.decision, safeFinalText),
    input.contract,
  );
  assertPureConsentWorldIsEffectFree(input.world, input.contract);

  const priorAudit = input.turn.consentModalityGuardAudit;
  if (priorAudit === undefined) {
    throw new TypeError("Consent modality finalizer requires a guard audit");
  }
  const finalAudit: ConsentModalityGuardAudit = {
    ...priorAudit,
    modelReplyContentChanged:
      priorAudit.modelReplyContentChanged || guardedReply.changed,
    modelSideEffectsBlocked:
      priorAudit.modelSideEffectsBlocked ||
      sanitizedWorldDecision.blocked ||
      blockedAcceptedEffects.length > 0 ||
      negotiationPlanBlocked ||
      finalDecision.blocked,
    independentReplyText: extractIndependentReplyText(
      safeFinalText,
      input.contract,
    ),
    finalTextSha256: sha256(safeFinalText),
  };
  const turn = {
    ...input.turn,
    decision: finalDecision.decision,
    consentModalityGuardAudit: finalAudit,
  };
  const worldWithoutBlockedNegotiation = { ...input.world };
  if (negotiationPlanBlocked) {
    delete worldWithoutBlockedNegotiation.negotiationPlan;
  }
  const postWorldRejections = blockedAcceptedEffects.map((effect) => ({
    reasonCode: BLOCKED_EFFECT_REASON,
    reasonSummary:
      "A post-resolution schedule effect derived from third-party consent was blocked before commit.",
    raw: effect,
  }));
  const negotiationEffectAlreadyRejected =
    input.world.negotiationPlan?.effect !== undefined &&
    blockedAcceptedEffects.some(
      (effect) =>
        effect === input.world.negotiationPlan?.effect ||
        isDeepStrictEqual(effect, input.world.negotiationPlan?.effect),
    );
  const retainedEffectCount = acceptedScheduleEffects.length;
  const decisionPath =
    blockedAcceptedEffects.length === 0 && !negotiationPlanBlocked
      ? input.world.decisionPath
      : retainedEffectCount > 0
        ? "partial"
        : "effects_rejected";
  return {
    turn,
    world: {
      ...worldWithoutBlockedNegotiation,
      decision: finalDecision.decision,
      validation: {
        ...input.world.validation,
        accepted: acceptedScheduleEffects,
        rejections: [
          ...input.world.validation.rejections,
          ...blockedAcceptedEffects.map((effect) => ({
            index: input.world.validation.accepted.indexOf(effect),
            code: BLOCKED_EFFECT_REASON,
            message:
              "Third-party consent cannot authorize a schedule mutation.",
            proposal: effect,
          })),
        ],
      },
      proposalRejections: [
        ...input.world.proposalRejections,
        ...postWorldRejections,
        ...(negotiationPlanBlocked && !negotiationEffectAlreadyRejected
          ? [
              {
                reasonCode: BLOCKED_EFFECT_REASON,
                reasonSummary:
                  "A consent-derived schedule negotiation was blocked before commit.",
                raw:
                  input.world.negotiationPlan?.effect ??
                  input.world.negotiationPlan,
              },
            ]
          : []),
      ],
      decisionPath,
      effectTrace:
        blockedAcceptedEffects.length === 0 && !negotiationPlanBlocked
          ? input.world.effectTrace
          : {
              ...input.world.effectTrace,
              rejectionCodes: [
                ...new Set([
                  ...input.world.effectTrace.rejectionCodes,
                  BLOCKED_EFFECT_REASON,
                ]),
              ],
            },
    },
  };
}

function sanitizeDecision(
  decision: AgentTurnDecision,
  contract: ConsentModalityGuardContract,
): { decision: AgentTurnDecision; blocked: boolean } {
  if (contract.consentOnly) {
    const blocked = hasDecisionEffects(decision);
    return {
      decision: clearDecisionEffects(decision),
      blocked,
    };
  }

  const memoryCandidateResult = sanitizeMemoryCandidates(
    decision.memoryCandidates,
    contract,
  );
  const memoryCandidates = memoryCandidateResult.values;
  const personalIntentCandidates = (
    decision.personalIntentCandidates ?? []
  ).filter((candidate) => !isConsentEffect(candidate.activity, contract));
  const scheduleEffects = decision.scheduleEffects.filter(
    (effect) => !isConsentScheduleEffect(effect, contract),
  );
  const continuity = sanitizeUnknownEffect(
    decision.continuityEffects,
    contract,
  );
  const sanitized = { ...decision };
  if (continuity.value === undefined) delete sanitized.continuityEffects;
  else sanitized.continuityEffects = continuity.value as never;
  return {
    decision: {
      ...sanitized,
      scheduleEffects,
      memoryCandidates,
      personalIntentCandidates,
    },
    blocked:
      scheduleEffects.length !== decision.scheduleEffects.length ||
      memoryCandidates.length !== decision.memoryCandidates.length ||
      memoryCandidateResult.blocked ||
      personalIntentCandidates.length !==
        (decision.personalIntentCandidates?.length ?? 0) ||
      continuity.blocked,
  };
}

function sanitizeScheduleAction(
  action: ResolvedTurn["scheduleAction"],
  contract: ConsentModalityGuardContract,
): { action: ResolvedTurn["scheduleAction"]; blocked: boolean } {
  if (action.kind === "none") return { action, blocked: false };
  if (contract.consentOnly) {
    return { action: { kind: "none" }, blocked: true };
  }
  const offer = "offer" in action ? action.offer : undefined;
  if (
    offer !== undefined &&
    typeof offer.activity === "string" &&
    (isConsentEffect(offer, contract) ||
      isConsentControlledActivity({
        claims: contract.claims,
        candidateText: offer.activity,
      }))
  ) {
    return { action: { kind: "none" }, blocked: true };
  }
  return { action, blocked: false };
}

function isConsentScheduleEffect(
  effect: AgentTurnDecision["scheduleEffects"][number],
  contract: ConsentModalityGuardContract,
): boolean {
  if (isConsentEffect(effect, contract)) return true;
  if (effect.operation !== "create" || effect.item === undefined) return false;
  const operationText = consentClaimsFromUnknown({
    title: effect.item.title,
    description: effect.item.description,
  });
  return (
    isConsentEffect(operationText, contract) ||
    isConsentControlledActivity({
      claims: contract.claims,
      candidateText: operationText,
    })
  );
}

function isConsentNegotiationPlan(
  plan: NonNullable<PreparedWorldEffectTurn["negotiationPlan"]>,
  contract: ConsentModalityGuardContract,
): boolean {
  if (
    plan.effect !== undefined &&
    isConsentScheduleEffect(plan.effect, contract)
  ) {
    return true;
  }
  return isConsentControlledActivity({
    claims: contract.claims,
    candidateText: consentClaimsFromUnknown({
      presentationText: plan.presentationText,
      updates: plan.updates,
    }),
  });
}

function clearDecisionEffects(decision: AgentTurnDecision): AgentTurnDecision {
  const cleared = { ...decision };
  delete cleared.stateDelta;
  delete cleared.relationshipDelta;
  delete cleared.continuityEffects;
  return {
    ...cleared,
    scheduleEffects: [],
    memoryCandidates: [],
    personalIntentCandidates: [],
  };
}

function replaceReply(
  decision: AgentTurnDecision,
  text: string,
): AgentTurnDecision {
  return {
    ...decision,
    reply: {
      text,
      chunks: [text],
      toneTags: ["谨慎", "授权边界"],
    },
    reasonCode: "consent_modality_guard_applied",
    reasonSummary:
      "第三方授权状态或范围不能由不确定表达、上下文省略或模型推断升级。",
  };
}

function guardReply(
  decision: AgentTurnDecision,
  contract: ConsentModalityGuardContract,
): { decision: AgentTurnDecision; changed: boolean } {
  const textUnsupported = isUnsupportedConsentAssertion({
    authoritativeText: contract.evidenceText,
    authoritativeClaims: contract.claims,
    candidateText: decision.reply.text,
  });
  const chunkUnsupported = decision.reply.chunks.some((chunk) =>
    isUnsupportedConsentAssertion({
      authoritativeText: contract.evidenceText,
      authoritativeClaims: contract.claims,
      candidateText: chunk,
    }),
  );
  if (!textUnsupported && !chunkUnsupported) {
    return { decision, changed: false };
  }
  if (!textUnsupported) {
    return {
      decision: replaceReply(decision, decision.reply.text),
      changed: true,
    };
  }

  const independentUnits = splitReplyUnits(decision.reply.text).filter(
    (unit) =>
      !looksLikeConsentReplyFragment(unit, contract) &&
      !isUnsupportedConsentAssertion({
        authoritativeText: contract.evidenceText,
        authoritativeClaims: contract.claims,
        candidateText: unit,
      }),
  );
  const safeText = [contract.safeReplyText, ...independentUnits].join("\n");
  return {
    decision: replaceReply(decision, safeText),
    changed: true,
  };
}

function splitReplyUnits(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .match(/[^。！？!?；;\n]+[。！？!?；;]?/gu)
      ?.flatMap((unit) =>
        unit.split(
          /(?=(?:而且|并且|同时|另外|此外|顺便|然后|接着)(?:我|你|用户|姨妈|姑妈|舅妈|阿姨|外婆|奶奶|妈妈|爸爸|她|他|对方|这|那))/u,
        ),
      )
      .map((unit) => unit.trim())
      .filter(Boolean) ?? []
  );
}

function looksLikeConsentReplyFragment(
  text: string,
  contract: ConsentModalityGuardContract,
): boolean {
  if (isConsentEffect(text, contract)) return true;
  if (
    /授权|许可|权限|待确认|明确确认|不能当作已经|授权范围|许可范围|新开的口子|新口子|点头|开(?:了)?绿灯/u.test(
      text,
    )
  ) {
    return true;
  }
  const mentionsSubject = contract.claims.some(
    (claim) =>
      text.includes(claim.subject) ||
      (/她|他|对方/u.test(text) &&
        /同意|允许|答应|愿意|确认|拒绝|撤回/u.test(text)),
  );
  const mentionsResource = contract.claims.some((claim) =>
    text.includes(claim.resource),
  );
  return (
    (mentionsSubject || mentionsResource) &&
    /同意|允许|答应|愿意|确认|拒绝|撤回|公开|发布|展示|分享|转发|查看|下载|复制|改编/u.test(
      text,
    )
  );
}

function sanitizeWorldEffectsAudit(
  audit: ResolvedTurn["worldEffectsAudit"],
  contract: ConsentModalityGuardContract,
): { value?: ResolvedTurn["worldEffectsAudit"]; blocked: boolean } {
  if (audit === undefined) return { blocked: false };
  const effects = audit.validation.effects;
  const memoryCandidateResult = sanitizeMemoryCandidates(
    effects.memoryCandidates,
    contract,
  );
  const memoryCandidates = memoryCandidateResult.values;
  const personalIntentCandidates = effects.personalIntentCandidates.filter(
    (candidate) => !isConsentEffect(candidate.activity, contract),
  );
  const blockedRejections = blockedWorldEffectRejections(
    audit.validation,
    contract,
  );
  const sanitizedEffects = contract.consentOnly
    ? { memoryCandidates: [], personalIntentCandidates: [] }
    : {
        ...(effects.stateDelta === undefined
          ? {}
          : { stateDelta: effects.stateDelta }),
        ...(effects.relationshipDelta === undefined
          ? {}
          : { relationshipDelta: effects.relationshipDelta }),
        memoryCandidates,
        personalIntentCandidates,
      };
  return {
    value: {
      ...audit,
      validation: {
        ...audit.validation,
        effects: sanitizedEffects,
        rejections: [...audit.validation.rejections, ...blockedRejections],
      },
    },
    blocked: blockedRejections.length > 0 || memoryCandidateResult.blocked,
  };
}

function sanitizeMemoryCandidates<
  T extends { content: string; tags?: readonly string[] },
>(
  candidates: readonly T[],
  contract: ConsentModalityGuardContract,
): { values: T[]; blocked: boolean } {
  let blocked = false;
  const values = candidates.flatMap((candidate): T[] => {
    if (isConsentEffect(candidate.content, contract)) {
      blocked = true;
      return [];
    }
    if (candidate.tags === undefined) return [candidate];
    const tags = candidate.tags.filter(
      (tag) => !isConsentEffect(tag, contract),
    );
    if (tags.length === candidate.tags.length) return [candidate];
    blocked = true;
    return [{ ...candidate, tags }];
  });
  return { values, blocked };
}

function blockedWorldEffectRejections(
  validation: WorldEffectsValidationResult,
  contract: ConsentModalityGuardContract,
): WorldEffectRejection[] {
  const effects = validation.effects;
  return [
    ...(contract.consentOnly && effects.stateDelta !== undefined
      ? [blockedWorldEffect("state_delta", effects.stateDelta)]
      : []),
    ...(contract.consentOnly && effects.relationshipDelta !== undefined
      ? [blockedWorldEffect("relationship_delta", effects.relationshipDelta)]
      : []),
    ...effects.memoryCandidates.flatMap((candidate, index) =>
      contract.consentOnly ||
      isConsentEffect(candidate.content, contract) ||
      candidate.tags?.some((tag) => isConsentEffect(tag, contract)) === true
        ? [blockedWorldEffect("memory_candidate", candidate, index)]
        : [],
    ),
    ...effects.personalIntentCandidates.flatMap((candidate, index) =>
      contract.consentOnly || isConsentEffect(candidate.activity, contract)
        ? [blockedWorldEffect("personal_intent_candidate", candidate, index)]
        : [],
    ),
  ];
}

function blockedWorldEffect(
  effect: WorldEffectRejection["effect"],
  raw: unknown,
  index?: number,
): WorldEffectRejection {
  return {
    effect,
    ...(index === undefined ? {} : { index }),
    reasonCode: BLOCKED_EFFECT_REASON,
    reasonSummary:
      "The model effect asserted or derived third-party consent outside the authoritative modality and scope.",
    raw,
  };
}

function sanitizeUnknownEffect(
  value: unknown,
  contract: ConsentModalityGuardContract,
): { value?: unknown; blocked: boolean } {
  if (value === undefined) return { blocked: false };
  if (contract.consentOnly) {
    return { blocked: true };
  }
  const structured = sanitizeContinuityCandidateCollections(value, contract);
  if (structured !== undefined) return structured;
  if (isConsentEffect(value, contract)) return { blocked: true };
  return { value, blocked: false };
}

function sanitizeContinuityCandidateCollections(
  value: unknown,
  contract: ConsentModalityGuardContract,
): { value: unknown; blocked: boolean } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const keys = [
    "followUpCandidates",
    "followUpTransitions",
    "careCueCandidates",
  ] as const;
  if (!keys.some((key) => Array.isArray(record[key]))) return undefined;

  let blocked = false;
  const sanitized: Record<string, unknown> = {};
  for (const key of keys) {
    const candidates = record[key];
    if (!Array.isArray(candidates)) continue;
    const retained = candidates.filter(
      (candidate) => !isConsentContinuityCandidate(candidate, contract),
    );
    if (retained.length !== candidates.length) blocked = true;
    sanitized[key] = retained;
  }
  return { value: sanitized, blocked };
}

function isConsentContinuityCandidate(
  value: unknown,
  contract: ConsentModalityGuardContract,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return isConsentEffect(value, contract);
  }
  const semanticFields = Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      ([key]) => key !== "evidenceQuotes",
    ),
  );
  return isConsentEffect(semanticFields, contract);
}

function isConsentEffect(
  value: unknown,
  contract: ConsentModalityGuardContract,
): boolean {
  return isConsentDerivedSemanticCandidate({
    authoritativeText: contract.evidenceText,
    authoritativeClaims: contract.claims,
    candidateText: consentClaimsFromUnknown(value),
  });
}

function hasDecisionEffects(decision: AgentTurnDecision): boolean {
  return (
    decision.scheduleEffects.length > 0 ||
    decision.stateDelta !== undefined ||
    decision.relationshipDelta !== undefined ||
    decision.memoryCandidates.length > 0 ||
    (decision.personalIntentCandidates?.length ?? 0) > 0 ||
    decision.continuityEffects !== undefined
  );
}

function buildGuardAudit(input: {
  contract: ConsentModalityGuardContract;
  finalText: string;
  modelReplyContentChanged: boolean;
  modelSideEffectsBlocked: boolean;
}): ConsentModalityGuardAudit {
  return {
    policyVersion: CONSENT_MODALITY_POLICY_VERSION,
    subject: input.contract.subject,
    status: input.contract.status,
    // Legacy summary fields describe only the primary claim. Multi-claim
    // consumers must use claims[] so a denied or differently-owned scope can
    // never be mistaken for part of the primary granted state.
    scopes: [{ ...input.contract.scopes[0]! }],
    primaryClaimKey: consentClaimKey(input.contract.claims[0]!),
    claimCount: input.contract.claims.length,
    claims: input.contract.claims.map((claim) => ({
      claimKey: consentClaimKey(claim),
      sourceKind: claim.sourceKind,
      subject: claim.subject,
      subjectKey: claim.subjectKey,
      ...(claim.beneficiary === undefined
        ? {}
        : {
            beneficiary: claim.beneficiary,
            beneficiaryKey: claim.beneficiaryKey,
          }),
      status: claim.status,
      scopeKind: claim.scopeKind,
      scopeKey: claim.scopeKey,
      scopeLabel: claim.scopeLabel,
      resource: claim.resource,
      evidenceText: claim.evidenceText,
      ...(claim.restrictions === undefined
        ? {}
        : { restrictions: [...claim.restrictions] }),
    })),
    sourceKind: input.contract.sourceKind,
    consentOnly: input.contract.consentOnly,
    independentText: input.contract.independentText,
    independentReplyText: extractIndependentReplyText(
      input.finalText,
      input.contract,
    ),
    evidenceText: input.contract.evidenceText,
    serverGuardApplied: true,
    modelReplyContentChanged: input.modelReplyContentChanged,
    modelSideEffectsBlocked: input.modelSideEffectsBlocked,
    contentDerivedSemanticsSkipped: input.contract.consentOnly,
    finalTextSha256: sha256(input.finalText),
  };
}

function extractIndependentReplyText(
  text: string,
  contract: ConsentModalityGuardContract,
): string {
  const withoutDeterministicConsentReply = text
    .replace(contract.safeReplyText, "")
    .trim();
  return splitReplyUnits(withoutDeterministicConsentReply)
    .filter((unit) => !looksLikeConsentReplyFragment(unit, contract))
    .join(" ")
    .trim();
}

function renderSafeConsentReply(input: {
  sourceKind: "assertion" | "query" | "mixed";
  subject: string;
  status: ThirdPartyConsentStatus;
  claims: readonly ThirdPartyConsentClaim[];
}): string {
  if (input.sourceKind === "query") {
    const questions = input.claims
      .map((claim) => `${claim.subject}是否同意${renderClaimScopeLabel(claim)}`)
      .filter((value, index, all) => all.indexOf(value) === index)
      .join("、");
    return `这个问题本身不能证明已经取得授权。目前${questions}仍待本人明确确认，也不能据此扩展到任何未明确提及的范围或用途。`;
  }
  const distinctStatuses = new Set(input.claims.map((claim) => claim.status));
  const distinctSubjects = new Set(
    input.claims.map((claim) => claim.subjectKey),
  );
  const distinctSourceKinds = new Set(
    input.claims.map((claim) => claim.sourceKind),
  );
  if (
    distinctStatuses.size > 1 ||
    distinctSubjects.size > 1 ||
    distinctSourceKinds.size > 1
  ) {
    const statements = input.claims
      .map((claim) => renderConsentClaim(claim))
      .filter((value, index, all) => all.indexOf(value) === index)
      .join("；");
    return `目前只能逐项确认：${statements}。不能把某一范围的状态扩展到另一范围，也不能推断任何未明确提及的用途。`;
  }
  const scopeText = input.claims
    .map(renderClaimScopeLabel)
    .filter((value, index, all) => all.indexOf(value) === index)
    .join("、");
  const mentionedKinds = new Set(input.claims.map((claim) => claim.scopeKind));
  const omittedExamples = [
    ["publish", "公开"],
    ["display", "展示"],
    ["share", "分享"],
    ["forward", "转发"],
  ]
    .filter(([kind]) => !mentionedKinds.has(kind as ThirdPartyConsentScopeKind))
    .map(([, label]) => label)
    .join("、");
  const boundary = `不能仅凭这句话扩展到任何未明确提及的范围或用途${
    omittedExamples === "" ? "" : `，包括${omittedExamples}`
  }。`;
  switch (input.status) {
    case "possible":
      return `关于${scopeText}，目前只能确认${input.subject}表达的是可能意向，不能当作已经授权。需要等${input.subject}本人明确确认；${boundary}`;
    case "pending":
      return `关于${scopeText}，目前仍待${input.subject}确认，不能当作已经授权。需要等${input.subject}本人明确确认；${boundary}`;
    case "granted":
      return `目前仅能确认：${input.subject}已同意${scopeText}。这份确认只覆盖上述范围；${boundary}`;
    case "denied":
      return `目前仅能确认：${input.subject}明确不允许${scopeText}。这不代表其他未提及范围已经获准；${boundary}`;
    case "revoked":
      return `目前仅能确认：${input.subject}已撤回${scopeText}的授权。这不代表其他未提及范围仍然获准；${boundary}`;
  }
}

function renderConsentClaim(claim: ThirdPartyConsentClaim): string {
  const scopeLabel = renderClaimScopeLabel(claim);
  if (claim.sourceKind === "query") {
    return `这个问题本身不能证明${claim.subject}已同意${scopeLabel}，仍待本人明确确认`;
  }
  switch (claim.status) {
    case "possible":
      return `${claim.subject}对${scopeLabel}只表达了可能意向，不能当作已经授权`;
    case "pending":
      return `${claim.subject}是否同意${scopeLabel}仍待本人确认，不能当作已经授权`;
    case "granted":
      return `${claim.subject}已同意${scopeLabel}`;
    case "denied":
      return `${claim.subject}明确不允许${scopeLabel}`;
    case "revoked":
      return `${claim.subject}已撤回${scopeLabel}的授权`;
  }
}

function renderClaimScopeLabel(claim: ThirdPartyConsentClaim): string {
  const ownedScope =
    claim.beneficiary === undefined || claim.beneficiaryKey === "user"
      ? claim.scopeLabel
      : `${claim.beneficiary}${claim.scopeLabel}`;
  const restrictions = renderConsentRestrictions(claim);
  return restrictions === "" ? ownedScope : `${ownedScope}（${restrictions}）`;
}

function renderConsentRestrictions(claim: ThirdPartyConsentClaim): string {
  return (claim.restrictions ?? [])
    .flatMap((restriction): string[] => {
      switch (restriction) {
        case "visibility:private":
          return /(?:单独|私下)/u.test(claim.scopeLabel) ? [] : ["仅限私下"];
        case "time:today":
          return ["仅限今天"];
        case "occasion:this":
          return ["仅限本次"];
        case "count:once":
          return ["仅限一次"];
        case "presence:grantor_required":
          return ["须本人在场或陪同"];
        case "commercial:prohibited":
          return ["不得商用"];
        default:
          return restriction.startsWith("purpose:")
            ? [`仅限用于${restriction.slice("purpose:".length)}`]
            : [];
      }
    })
    .filter((value, index, all) => all.indexOf(value) === index)
    .join("、");
}

function consentClaimKey(claim: ThirdPartyConsentClaim): string {
  return `${claim.subjectKey}:${claim.scopeKey}:${claim.beneficiaryKey ?? "unspecified"}`;
}

function assertPureConsentWorldIsEffectFree(
  world: PreparedWorldEffectTurn,
  contract: ConsentModalityGuardContract,
): void {
  if (!contract.consentOnly) return;
  if (
    world.negotiationPlan !== undefined ||
    world.validation.accepted.length > 0 ||
    world.decision.scheduleEffects.length > 0 ||
    world.decision.stateDelta !== undefined ||
    world.decision.relationshipDelta !== undefined ||
    world.decision.memoryCandidates.length > 0 ||
    (world.decision.personalIntentCandidates?.length ?? 0) > 0 ||
    world.decision.continuityEffects !== undefined ||
    world.effectTrace.accepted.stateDelta !== undefined ||
    world.effectTrace.accepted.relationshipDelta !== undefined
  ) {
    throw new TypeError(
      "A consent-only guard turn cannot commit model semantic or schedule effects",
    );
  }
}

function appendServerSchedulePresentation(
  consentText: string,
  presentationText: string | undefined,
): string {
  if (
    presentationText === undefined ||
    presentationText.trim() === "" ||
    consentText.includes(presentationText)
  ) {
    return consentText;
  }
  return `${consentText}\n\n${presentationText}`;
}

function removeSchedulePresentation(
  replyText: string,
  presentationText: string,
): string {
  const withoutPresentation = replyText
    .replace(`\n\n${presentationText}`, "")
    .replace(presentationText, "")
    .trim();
  return withoutPresentation === ""
    ? "这项安排没有形成可提交的日程变更。"
    : withoutPresentation;
}

function blockedEffectSummary(
  turn: ResolvedTurn,
  contract: ConsentModalityGuardContract,
): Record<string, unknown> {
  return {
    consentOnly: contract.consentOnly,
    scheduleEffectCount: turn.decision.scheduleEffects.length,
    hasStateDelta: turn.decision.stateDelta !== undefined,
    hasRelationshipDelta: turn.decision.relationshipDelta !== undefined,
    memoryCandidateCount: turn.decision.memoryCandidates.length,
    personalIntentCandidateCount:
      turn.decision.personalIntentCandidates?.length ?? 0,
    hasContinuityEffects:
      turn.decision.continuityEffects !== undefined ||
      turn.continuityEffects !== undefined,
    scheduleActionKind: turn.scheduleAction.kind,
  };
}

function normalizeEvidence(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().slice(0, 4_000);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
