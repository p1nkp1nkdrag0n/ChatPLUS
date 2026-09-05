import { createHash } from "node:crypto";

import type { MemoryRecallResult } from "@personasim/contracts";
import type {
  WorldEffectRejection,
  WorldEffectsValidationResult,
} from "@personasim/features";

import {
  explicitFactValueResolution,
  parseExplicitFactVerificationRequest,
  type ExplicitFactFacet,
  type ExplicitFactFacetDescriptor,
} from "../domain/explicit-fact-verification.js";
import type { AgentTurnDecision } from "../domain/schemas.js";
import {
  RetrievalReplayInputSchema,
  type CreateRetrievalRunInput,
  type RetrievalReplayInput,
} from "../repositories/retrieval-run-repository.js";
import type {
  DecisionInspection,
  ExplicitFactReplyGuardAudit,
  ResolvedTurn,
  TurnDecisionEffectContext,
} from "./turn-decision-service.js";
import type { PreparedWorldEffectTurn } from "./world-effect-service.js";

const POLICY_VERSION = "explicit_fact_checklist_v1" as const;
const BLOCKED_EFFECT_REASON = "explicit_fact_reply_guard_blocked";

const SELECTOR_REASON_BY_OUTCOME = {
  incomplete: "requested_fact_facets_incomplete",
  conflicted: "requested_fact_facets_conflicted",
  below_threshold: "requested_fact_below_caller_threshold",
  capacity_insufficient: "requested_fact_evidence_capacity_insufficient",
  scan_truncated: "requested_fact_scan_truncated",
} as const;

export function explicitFactAbstentionReason(
  outcome: keyof typeof SELECTOR_REASON_BY_OUTCOME,
): (typeof SELECTOR_REASON_BY_OUTCOME)[keyof typeof SELECTOR_REASON_BY_OUTCOME] {
  return SELECTOR_REASON_BY_OUTCOME[outcome];
}

type ExplicitFactContractReason =
  | "requested_fact_request_invalid"
  | (typeof SELECTOR_REASON_BY_OUTCOME)[keyof typeof SELECTOR_REASON_BY_OUTCOME]
  | "requested_fact_reply_contract_unavailable"
  | "requested_fact_reply_contract_invalid";

export type ExplicitFactReplyValue =
  | Readonly<{
      kind: "beverage_preference";
      valueKey: string;
      polarity: "affirmed";
      canonical: string;
      temperature: "cold" | "hot" | "warm" | "room" | "unspecified";
      sweetness: "sweetened" | "unsweetened" | "unspecified";
    }>
  | Readonly<{
      kind: "entity_inscription";
      valueKey: string;
      entity: string;
      inscription: string;
    }>;

export type ExplicitFactSafeFact = Readonly<{
  index: 0 | 1 | 2;
  facet: ExplicitFactFacetDescriptor;
  value: ExplicitFactReplyValue;
  memoryId: string;
  evidenceIds: readonly string[];
  text: string;
}>;

export type ExplicitFactReplyContract =
  | Readonly<{
      kind: "selected";
      policy: typeof POLICY_VERSION;
      expectedFacetCount: 2 | 3;
      facts: readonly ExplicitFactSafeFact[];
      selectedMemoryIds: readonly string[];
      selectedEvidenceIds: readonly string[];
      replyText: string;
    }>
  | Readonly<{
      kind: "abstain";
      policy: typeof POLICY_VERSION;
      expectedFacetCount?: 2 | 3;
      reasonCode: ExplicitFactContractReason;
      replyText: string;
    }>;

type ExplicitFactRecallRecording = Readonly<
  Pick<CreateRetrievalRunInput, "inputSnapshot" | "result">
>;

export function buildExplicitFactReplyContract(input: {
  userText: string;
  recall?: ExplicitFactRecallRecording;
}): ExplicitFactReplyContract | undefined {
  const parsed = parseExplicitFactVerificationRequest(input.userText);
  if (parsed.kind !== "valid") {
    return parsed.kind === "invalid"
      ? abstainContract(undefined, parsed.reason)
      : undefined;
  }

  const expectedFacetCount = parsed.request.expectedFacetCount as 2 | 3;
  const recall = input.recall;
  if (recall === undefined) {
    return abstainContract(
      expectedFacetCount,
      "requested_fact_reply_contract_unavailable",
    );
  }
  const parsedSnapshot = RetrievalReplayInputSchema.safeParse(
    recall.inputSnapshot,
  );
  if (!parsedSnapshot.success) {
    return abstainContract(
      expectedFacetCount,
      "requested_fact_reply_contract_invalid",
    );
  }
  const snapshot = parsedSnapshot.data;
  const audit = snapshot.hierarchy?.selectorAudit;
  if (
    snapshot.query.query !== input.userText ||
    audit === undefined ||
    audit.policy !== POLICY_VERSION ||
    audit.expectedFacetCount !== expectedFacetCount ||
    audit.attempts.some(
      (attempt) =>
        attempt.facets.length !== expectedFacetCount ||
        attempt.facets.some(
          (facet, index) =>
            facet.index !== index ||
            !sameFacetDescriptor(
              facet.request,
              descriptorForFacet(parsed.request.facets[index]),
            ),
        ),
    )
  ) {
    return abstainContract(
      expectedFacetCount,
      "requested_fact_reply_contract_invalid",
    );
  }

  if (audit.outcome !== "selected") {
    const expectedReason = explicitFactAbstentionReason(audit.outcome);
    if (
      !recall.result.abstained ||
      recall.result.abstentionReason !== expectedReason
    ) {
      return abstainContract(
        expectedFacetCount,
        "requested_fact_reply_contract_invalid",
      );
    }
    return abstainContract(expectedFacetCount, expectedReason);
  }

  if (recall.result.abstained || audit.scanTruncated) {
    return abstainContract(
      expectedFacetCount,
      "requested_fact_reply_contract_invalid",
    );
  }
  return (
    selectedContract({
      userText: input.userText,
      expectedFacetCount,
      facets: parsed.request.facets,
      audit,
      result: recall.result,
      snapshot,
    }) ??
    abstainContract(expectedFacetCount, "requested_fact_reply_contract_invalid")
  );
}

function selectedContract(input: {
  userText: string;
  expectedFacetCount: 2 | 3;
  facets: readonly ExplicitFactFacet[];
  audit: NonNullable<
    NonNullable<
      CreateRetrievalRunInput["inputSnapshot"]["hierarchy"]
    >["selectorAudit"]
  >;
  result: Extract<MemoryRecallResult, { abstained: false }>;
  snapshot: RetrievalReplayInput;
}): Extract<ExplicitFactReplyContract, { kind: "selected" }> | undefined {
  const selectedAttempts = input.audit.attempts.filter(
    (attempt) => attempt.outcome === "selected",
  );
  const selectedAttempt = selectedAttempts[0];
  if (
    selectedAttempts.length !== 1 ||
    selectedAttempt === undefined ||
    selectedAttempt.tier !== input.snapshot.hierarchy?.finalTier ||
    selectedAttempt.facets.length !== input.expectedFacetCount ||
    input.result.evidenceBundle.query !== input.userText ||
    input.result.evidenceBundle.generatedAtUtc !== input.snapshot.nowUtc
  ) {
    return undefined;
  }

  const selectorInput = input.snapshot.selectorAuditInput;
  if (selectorInput === undefined) return undefined;
  const frozenMemoryById = new Map(
    selectorInput.memories.map((memory) => [memory.id, memory]),
  );
  const frozenEvidenceById = new Map(
    selectorInput.evidence.map((evidence) => [evidence.id, evidence]),
  );

  const resultEvidenceIds = input.result.evidenceBundle.evidence.map(
    (item) => item.evidence.id,
  );
  if (
    !sameStringSet(resultEvidenceIds, input.result.selectedEvidenceIds) ||
    (input.audit.replayEvidenceIds !== undefined &&
      input.result.selectedEvidenceIds.some(
        (id) => !input.audit.replayEvidenceIds!.includes(id),
      ))
  ) {
    return undefined;
  }

  const facts: ExplicitFactSafeFact[] = [];
  for (const [index, facetAudit] of selectedAttempt.facets.entries()) {
    const requestedFacet = input.facets[index];
    const descriptor = descriptorForFacet(requestedFacet);
    if (
      requestedFacet === undefined ||
      descriptor === undefined ||
      facetAudit.index !== index ||
      facetAudit.outcome !== "selected" ||
      !sameFacetDescriptor(facetAudit.request, descriptor)
    ) {
      return undefined;
    }
    const selectedCandidates = facetAudit.candidates.filter(
      (candidate) => candidate.decision === "selected",
    );
    const candidate = selectedCandidates[0];
    if (
      selectedCandidates.length !== 1 ||
      candidate === undefined ||
      candidate.valueGroupId === undefined ||
      !input.result.selectedMemoryIds.includes(candidate.memoryId)
    ) {
      return undefined;
    }
    const acceptedEvidenceIds = new Set(
      candidate.evidence.flatMap((evidence) =>
        evidence.decision === "accepted" ? [evidence.evidenceId] : [],
      ),
    );
    const evidenceItems = input.result.evidenceBundle.evidence.filter(
      (item) =>
        item.memoryId === candidate.memoryId &&
        acceptedEvidenceIds.has(item.evidence.id) &&
        input.result.selectedEvidenceIds.includes(item.evidence.id),
    );
    if (evidenceItems.length === 0) return undefined;

    let valueKey: string | undefined;
    for (const item of evidenceItems) {
      const frozenMemory = frozenMemoryById.get(item.memoryId);
      const frozenEvidence = frozenEvidenceById.get(item.evidence.id);
      if (
        frozenMemory === undefined ||
        frozenEvidence === undefined ||
        frozenEvidence.memoryId !== frozenMemory.id ||
        item.memoryContent !== frozenMemory.content ||
        !sameJson(item.evidence, frozenEvidence)
      ) {
        return undefined;
      }
      const memoryValue = explicitFactValueResolution(
        frozenMemory.content,
        descriptor,
      );
      const quote = frozenEvidence.quote;
      const evidenceValue =
        quote === undefined
          ? { kind: "none" as const }
          : explicitFactValueResolution(quote, descriptor);
      if (
        memoryValue.kind !== "resolved" ||
        evidenceValue.kind !== "resolved" ||
        memoryValue.valueKey !== evidenceValue.valueKey ||
        (valueKey !== undefined && valueKey !== memoryValue.valueKey)
      ) {
        return undefined;
      }
      valueKey = memoryValue.valueKey;
    }
    if (valueKey === undefined) return undefined;
    const value = decodeExplicitFactReplyValue({
      facet: descriptor,
      valueKey,
    });
    const text =
      value === undefined ? undefined : renderExplicitFactSafeText(value);
    if (value === undefined || text === undefined) return undefined;
    facts.push({
      index: index as 0 | 1 | 2,
      facet: descriptor,
      value,
      memoryId: candidate.memoryId,
      evidenceIds: evidenceItems.map((item) => item.evidence.id),
      text,
    });
  }

  const selectedMemoryIds = [...new Set(facts.map((fact) => fact.memoryId))];
  const selectedEvidenceIds = [
    ...new Set(facts.flatMap((fact) => fact.evidenceIds)),
  ];
  if (
    facts.length !== input.expectedFacetCount ||
    !sameStringSet(selectedMemoryIds, input.result.selectedMemoryIds) ||
    !sameStringSet(selectedEvidenceIds, input.result.selectedEvidenceIds)
  ) {
    return undefined;
  }
  const replyText = `${facts.map((fact) => fact.text).join("；")}。`;
  if (replyText.length > 4_000) return undefined;
  return {
    kind: "selected",
    policy: POLICY_VERSION,
    expectedFacetCount: input.expectedFacetCount,
    facts,
    selectedMemoryIds,
    selectedEvidenceIds,
    replyText,
  };
}

export function decodeExplicitFactReplyValue(input: {
  facet: ExplicitFactFacetDescriptor;
  valueKey: string;
}): ExplicitFactReplyValue | undefined {
  if (input.facet.kind === "beverage_preference") {
    const [polarity, canonical, temperature, sweetness, overflow] =
      input.valueKey.split(":");
    if (
      overflow !== undefined ||
      polarity !== "affirmed" ||
      canonical === undefined ||
      !Object.hasOwn(BEVERAGE_LABELS, canonical) ||
      !isTemperature(temperature) ||
      !isSweetness(sweetness)
    ) {
      return undefined;
    }
    return {
      kind: "beverage_preference",
      valueKey: input.valueKey,
      polarity,
      canonical,
      temperature,
      sweetness,
    };
  }
  const prefix = `entity_inscription:${input.facet.entity}:`;
  if (!input.valueKey.startsWith(prefix)) return undefined;
  const inscription = input.valueKey.slice(prefix.length).trim();
  if (
    inscription.length === 0 ||
    inscription.length > 160 ||
    hasUnsafeDisplayText(inscription)
  ) {
    return undefined;
  }
  return {
    kind: "entity_inscription",
    valueKey: input.valueKey,
    entity: input.facet.entity,
    inscription,
  };
}

export function renderExplicitFactSafeText(
  value: ExplicitFactReplyValue,
): string | undefined {
  if (value.kind === "entity_inscription") {
    if (hasUnsafeDisplayText(value.entity)) return undefined;
    const inscription = value.inscription.replace(/\s*\/\s*/gu, " / ");
    return `${value.entity}标签：${inscription}`;
  }
  const beverage = BEVERAGE_LABELS[value.canonical];
  if (beverage === undefined) return undefined;
  const temperature = TEMPERATURE_LABELS[value.temperature];
  const sweetness = SWEETNESS_LABELS[value.sweetness];
  const drink = `${temperature}${beverage}`;
  const qualified = sweetness === "" ? drink : `${drink}（${sweetness}）`;
  return `饮品记录：${qualified}`;
}

export function applyExplicitFactReplyGuard(input: {
  turn: ResolvedTurn;
  contract: ExplicitFactReplyContract;
  inspectDecision: (decision: AgentTurnDecision) => DecisionInspection;
}): ResolvedTurn {
  const decision = explicitFactDecision(input.contract);
  const modelSideEffectsBlocked = hasModelSideEffects(input.turn);
  const worldEffectsAudit = sanitizeWorldEffectsAudit(
    input.turn.worldEffectsAudit,
  );
  const guardAudit = replyGuardAudit(
    input.turn,
    input.contract,
    modelSideEffectsBlocked,
  );
  const withoutContinuity = { ...input.turn };
  delete withoutContinuity.continuityEffects;
  return {
    ...withoutContinuity,
    decision,
    inspection: input.inspectDecision(decision),
    usedFallback: input.turn.usedFallback,
    modelRejections: [
      ...input.turn.modelRejections,
      ...(modelSideEffectsBlocked
        ? [
            {
              raw: blockedEffectSummary(input.turn),
              reasonCode: BLOCKED_EFFECT_REASON,
              reasonSummary:
                "Explicit fact verification is server-controlled; model semantic effects were not applied.",
            },
          ]
        : []),
    ],
    scheduleAction: { kind: "none" },
    ...(worldEffectsAudit === undefined ? {} : { worldEffectsAudit }),
    explicitFactReplyGuardAudit: guardAudit,
  };
}

export function explicitFactReplyEffectContext(): TurnDecisionEffectContext {
  return {
    effectsEligible: false,
    scheduleNegotiationEligible: false,
    negotiationEnforced: false,
  };
}

export function finalizeExplicitFactWorld(input: {
  world: PreparedWorldEffectTurn;
  contract: ExplicitFactReplyContract;
}): PreparedWorldEffectTurn {
  const { world } = input;
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
      "Explicit fact reply guard cannot commit semantic or schedule effects",
    );
  }
  return { ...world, decision: explicitFactDecision(input.contract) };
}

function explicitFactDecision(
  contract: ExplicitFactReplyContract,
): AgentTurnDecision {
  const selected = contract.kind === "selected";
  return {
    reply: {
      text: contract.replyText,
      chunks: [contract.replyText],
      toneTags: ["事实核对"],
    },
    scheduleEffects: [],
    memoryCandidates: [],
    personalIntentCandidates: [],
    reasonCode: selected
      ? "explicit_fact_reply_guard_selected"
      : "explicit_fact_reply_guard_abstained",
    reasonSummary: selected
      ? "依据本轮冻结且完整通过证据校验的事实分面生成原子化答复。"
      : "本轮事实分面未能全部安全核对，使用不披露部分值的整体拒答。",
  };
}

function replyGuardAudit(
  turn: ResolvedTurn,
  contract: ExplicitFactReplyContract,
  modelSideEffectsBlocked: boolean,
): ExplicitFactReplyGuardAudit {
  const selected = contract.kind === "selected";
  return {
    policyVersion: POLICY_VERSION,
    outcome: selected ? "selected" : "abstained",
    reasonCode: selected
      ? "explicit_fact_reply_guard_selected"
      : contract.reasonCode,
    ...(contract.expectedFacetCount === undefined
      ? {}
      : { expectedFacetCount: contract.expectedFacetCount }),
    selectedMemoryIds: selected ? [...contract.selectedMemoryIds] : [],
    selectedEvidenceIds: selected ? [...contract.selectedEvidenceIds] : [],
    serverGuardApplied: true,
    modelReplyContentChanged:
      turn.decision.reply.text !== contract.replyText ||
      turn.decision.reply.chunks.length !== 1 ||
      turn.decision.reply.chunks[0] !== contract.replyText,
    modelSideEffectsBlocked,
    modelRepairAttempted: turn.repairAttempted,
    modelGenerationFallbackUsed: turn.usedFallback,
    contentDerivedSemanticsSkipped: true,
    finalTextSha256: createHash("sha256")
      .update(contract.replyText, "utf8")
      .digest("hex"),
  };
}

function sanitizeWorldEffectsAudit(
  audit: ResolvedTurn["worldEffectsAudit"],
): ResolvedTurn["worldEffectsAudit"] {
  if (audit === undefined) return undefined;
  const guardRejections = blockedWorldEffectRejections(audit.validation);
  return {
    ...audit,
    validation: {
      ...audit.validation,
      effects: { memoryCandidates: [], personalIntentCandidates: [] },
      rejections: [...audit.validation.rejections, ...guardRejections],
    },
  };
}

function blockedWorldEffectRejections(
  validation: WorldEffectsValidationResult,
): WorldEffectRejection[] {
  const effects = validation.effects;
  return [
    ...(effects.stateDelta === undefined
      ? []
      : [blockedWorldEffect("state_delta", effects.stateDelta)]),
    ...(effects.relationshipDelta === undefined
      ? []
      : [blockedWorldEffect("relationship_delta", effects.relationshipDelta)]),
    ...effects.memoryCandidates.map((candidate, index) =>
      blockedWorldEffect("memory_candidate", candidate, index),
    ),
    ...effects.personalIntentCandidates.map((candidate, index) =>
      blockedWorldEffect("personal_intent_candidate", candidate, index),
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
      "Explicit fact verification is server-controlled; the validated model effect was blocked.",
    raw,
  };
}

function hasModelSideEffects(turn: ResolvedTurn): boolean {
  const decision = turn.decision;
  const validated = turn.worldEffectsAudit?.validation.effects;
  return (
    decision.scheduleEffects.length > 0 ||
    decision.stateDelta !== undefined ||
    decision.relationshipDelta !== undefined ||
    decision.memoryCandidates.length > 0 ||
    (decision.personalIntentCandidates?.length ?? 0) > 0 ||
    decision.continuityEffects !== undefined ||
    turn.scheduleAction.kind !== "none" ||
    turn.continuityEffects !== undefined ||
    validated?.stateDelta !== undefined ||
    validated?.relationshipDelta !== undefined ||
    (validated?.memoryCandidates.length ?? 0) > 0 ||
    (validated?.personalIntentCandidates.length ?? 0) > 0
  );
}

function blockedEffectSummary(turn: ResolvedTurn): Record<string, unknown> {
  const decision = turn.decision;
  const validated = turn.worldEffectsAudit?.validation.effects;
  return {
    scheduleEffectCount: decision.scheduleEffects.length,
    hasStateDelta:
      decision.stateDelta !== undefined || validated?.stateDelta !== undefined,
    hasRelationshipDelta:
      decision.relationshipDelta !== undefined ||
      validated?.relationshipDelta !== undefined,
    memoryCandidateCount: Math.max(
      decision.memoryCandidates.length,
      validated?.memoryCandidates.length ?? 0,
    ),
    personalIntentCandidateCount: Math.max(
      decision.personalIntentCandidates?.length ?? 0,
      validated?.personalIntentCandidates.length ?? 0,
    ),
    hasContinuityEffects:
      decision.continuityEffects !== undefined ||
      turn.continuityEffects !== undefined,
    scheduleActionKind: turn.scheduleAction.kind,
  };
}

function abstainContract(
  expectedFacetCount: 2 | 3 | undefined,
  reasonCode: ExplicitFactContractReason,
): Extract<ExplicitFactReplyContract, { kind: "abstain" }> {
  const noun =
    expectedFacetCount === 2
      ? "这两项"
      : expectedFacetCount === 3
        ? "这三项"
        : "这些项目";
  return {
    kind: "abstain",
    policy: POLICY_VERSION,
    ...(expectedFacetCount === undefined ? {} : { expectedFacetCount }),
    reasonCode,
    replyText: `现有可靠事实不足以完整核对${noun}。`,
  };
}

function descriptorForFacet(
  facet: ExplicitFactFacet | undefined,
): ExplicitFactFacetDescriptor | undefined {
  if (facet === undefined) return undefined;
  return facet.kind === "beverage_preference"
    ? { kind: facet.kind, selector: facet.selector }
    : { kind: facet.kind, entity: facet.entity };
}

function sameFacetDescriptor(
  left: ExplicitFactFacetDescriptor,
  right: ExplicitFactFacetDescriptor | undefined,
): boolean {
  if (right === undefined || left.kind !== right.kind) return false;
  if (left.kind === "entity_inscription") {
    return right.kind === left.kind && left.entity === right.entity;
  }
  if (
    right.kind !== left.kind ||
    left.selector.scope !== right.selector.scope
  ) {
    return false;
  }
  if (left.selector.scope === "any") return true;
  return left.selector.scope === "family"
    ? right.selector.scope === "family" &&
        left.selector.family === right.selector.family
    : right.selector.scope === "specific" &&
        left.selector.canonical === right.selector.canonical;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value) => right.includes(value)) &&
    right.every((value) => left.includes(value))
  );
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isTemperature(
  value: string | undefined,
): value is Extract<
  ExplicitFactReplyValue,
  { kind: "beverage_preference" }
>["temperature"] {
  return (
    value === "cold" ||
    value === "hot" ||
    value === "warm" ||
    value === "room" ||
    value === "unspecified"
  );
}

function isSweetness(
  value: string | undefined,
): value is Extract<
  ExplicitFactReplyValue,
  { kind: "beverage_preference" }
>["sweetness"] {
  return (
    value === "sweetened" || value === "unsweetened" || value === "unspecified"
  );
}

const BEVERAGE_LABELS: Readonly<Record<string, string>> = {
  jasmine_tea: "茉莉花茶",
  oolong_tea: "乌龙茶",
  puer_tea: "普洱茶",
  black_tea: "红茶",
  green_tea: "绿茶",
  white_tea: "白茶",
  flower_tea: "花茶",
  milk_tea: "奶茶",
  tea: "茶",
  coffee: "咖啡",
  cocoa: "可可",
  juice: "果汁",
  mineral_water: "矿泉水",
  plain_water: "白水",
  water: "水",
};

const TEMPERATURE_LABELS = {
  cold: "冰",
  hot: "热",
  warm: "温",
  room: "常温",
  unspecified: "",
} as const;

const SWEETNESS_LABELS = {
  sweetened: "加糖",
  unsweetened: "不加糖",
  unspecified: "",
} as const;

function hasUnsafeDisplayText(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      codePoint === 0x061c ||
      codePoint === 0x200e ||
      codePoint === 0x200f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069) ||
      character === "“" ||
      character === "”"
    ) {
      return true;
    }
  }
  return false;
}
