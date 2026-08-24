import {
  MemoryCandidateSchema,
  type MemoryCandidate,
  type ScheduleNegotiationAction,
} from "@personasim/contracts";
import {
  auditEvidenceOnlyTextGrounding,
  isCorrectionShapedUserFactSource,
  normalizePersonalIntentCandidate,
  normalizePersonalIntentCategory,
  projectActiveCorrectionStatement,
  recallExactIdentifierAnchors,
  recallExactIdentifiers,
  splitEvidenceOnlyClauses,
  worldEffectEligibilityForTurn,
  type ValidatedWorldEffects,
} from "@personasim/features";
import { DateTime } from "luxon";

import {
  isSpecificHistoricalScheduleEntityText,
  type DatabaseStore,
  type HistoricalScheduleReadAuthorization,
  type StoredActivityEvent,
  type StoredMessage,
} from "../db/store.js";
import type { SimulationCapabilities } from "../domain/capabilities.js";
import type {
  CharacterSpec,
  RuntimeState,
  ScheduleItem,
} from "../domain/schemas.js";
import {
  ScheduleNegotiationService,
  SCHEDULE_NEGOTIATION_POLICY_VERSION,
  canonicalOfferFromStoredNegotiation,
  formatPendingOffer,
  formatWithdrawnOffer,
  type ActiveScheduleNegotiation,
  type PreparedScheduleNegotiation,
} from "./schedule-negotiation-service.js";
import {
  classifyMemoryEpistemicStatus,
  memorySourceCanAuthorizeUserFact,
} from "./memory-epistemic.js";
import { preflightMemoryCandidates } from "./memory-service.js";
import type {
  PartialProposalValidation,
  ScheduleService,
} from "./schedule-service.js";
import { projectTurnState } from "./turn-state-projection.js";
import type {
  ResolvedTurnObservation,
  ObservationRejection,
} from "./turn-understanding-service.js";

export type ScheduleOutcome =
  | { kind: "none" }
  | { kind: "read_only"; itemIds: string[] }
  | { kind: "needs_clarification"; missingFields: string[] }
  | {
      kind: "pending_confirmation";
      negotiationId: string;
      offerVersion: number;
    }
  | {
      kind: "committed";
      negotiationId: string;
      /** Final ids are filled by the atomic commit; empty means commit-ready. */
      scheduleItemIds: string[];
    }
  | { kind: "declined"; negotiationId: string }
  | { kind: "rejected"; reasonCode: string };

export type ReplyDirectiveMode =
  "casual" | "answer" | "empathize" | "clarify" | "confirm" | "decline";

export type ReplyClaimRestriction =
  | "schedule_committed"
  | "schedule_cancelled"
  | "memory_persisted"
  | "future_action_guaranteed";

export interface TurnReplyDirectives {
  mode: ReplyDirectiveMode;
  evidenceOnly: boolean;
  mustAbstain: boolean;
  mustNotInferFromPersona: boolean;
  allowedEvidenceIds: string[];
  mustAddressUserQuotes: string[];
  authoritativeFacts: Array<{
    kind:
      | "schedule"
      | "memory"
      | "state"
      | "relationship"
      | "continuity"
      | "activity";
    text: string;
    sourceId?: string;
    activityEventType?: StoredActivityEvent["eventType"];
    /** Server-authoritative schedule status; only populated for schedule facts. */
    scheduleAuthorityState?: "committed" | "pending" | "withdrawn" | "absent";
    /** Whether this turn changed the referenced schedule; schedule facts only. */
    scheduleMutationDisposition?: "unchanged" | "applied";
    /** Exact semantic/temporal anchors the reply must preserve. */
    requiredAnchors?: string[];
  }>;
  mustNotClaim: ReplyClaimRestriction[];
  presentationText?: string;
}

export interface SplitTurnProposalRejection {
  reasonCode: string;
  reasonSummary: string;
  field?: string;
  raw?: unknown;
}

export interface ValidatedTurnOutcome {
  route: ResolvedTurnObservation["route"];
  observation: ResolvedTurnObservation;
  scheduleOutcome: ScheduleOutcome;
  validation: PartialProposalValidation;
  acceptedWorldEffects: ValidatedWorldEffects;
  worldEffectsMode: "off" | "shadow" | "enforced";
  /** True only when this authoritative execution may persist accepted effects. */
  worldEffectWritesEnabled: boolean;
  proposalRejections: SplitTurnProposalRejection[];
  nextState: RuntimeState;
  stateChanged: boolean;
  replyDirectives: TurnReplyDirectives;
  /** Present only when commit may persist it, or during an explicit dry-run. */
  negotiationPlan?: PreparedScheduleNegotiation;
  scheduleWritesEnabled: boolean;
  audit: {
    schemaVersion: 1;
    policyVersion: string;
    decisionPath: string;
    dryRun: boolean;
  };
}

export interface TurnExecutionServiceOptions {
  scheduleNegotiationMode?: "legacy" | "shadow" | "enforced";
  liveWorldEffectsMode?: "off" | "shadow" | "enforced";
}

export interface TurnExecutionInput {
  sessionId: string;
  agentId: string;
  userText: string;
  userMessageId: string;
  clientMessageId: string;
  assistantMessageId: string;
  nowUtc: string;
  spec: CharacterSpec;
  state: RuntimeState;
  capabilities: SimulationCapabilities;
  recentMessages: readonly StoredMessage[];
  authoritativeSchedule: readonly ScheduleItem[];
  historicalScheduleReadAuthorizations?: readonly HistoricalScheduleReadAuthorization[];
  observation: ResolvedTurnObservation;
  memoryReplyPolicy?: {
    evidenceOnly: boolean;
    mustAbstain: boolean;
    mustNotInferFromPersona: boolean;
    allowedEvidenceIds: readonly string[];
  };
  activeNegotiation?: ActiveScheduleNegotiation;
  /** Shadow comparison can prepare a would-be plan, but never commits it. */
  dryRun?: boolean;
}

/**
 * Converts a grounded observation into commit-ready domain data. This service
 * may read authoritative state through ScheduleNegotiationService.prepare,
 * but it never writes and never consumes assistant reply text.
 */
export class TurnExecutionService {
  private readonly scheduleNegotiations: ScheduleNegotiationService;

  constructor(
    private readonly store: DatabaseStore,
    private readonly schedules: ScheduleService,
    private readonly options: TurnExecutionServiceOptions = {},
  ) {
    this.scheduleNegotiations = new ScheduleNegotiationService(
      store,
      schedules,
    );
  }

  getActive(
    sessionId: string,
    nowUtc: string,
  ): ActiveScheduleNegotiation | undefined {
    return this.scheduleNegotiations.getActive(sessionId, nowUtc);
  }

  execute(input: TurnExecutionInput): ValidatedTurnOutcome {
    const dryRun = input.dryRun === true;
    const worldEffectsMode = this.options.liveWorldEffectsMode ?? "off";
    const scheduleWritesEnabled =
      this.options.scheduleNegotiationMode === "enforced";
    const canPrepareSchedule =
      input.capabilities.schedule &&
      input.spec.schedulePolicy.enabled &&
      input.spec.tier === "high_fidelity" &&
      input.observation.route !== "schedule_query" &&
      (input.observation.route === "schedule_mutation" ||
        input.observation.route === "mixed");
    const writerDisabledForMutation =
      !dryRun &&
      !scheduleWritesEnabled &&
      input.observation.route !== "schedule_query" &&
      (input.observation.route === "schedule_mutation" ||
        input.observation.route === "mixed");

    const scheduleRejections: SplitTurnProposalRejection[] = [];
    let preparedPlan: PreparedScheduleNegotiation | undefined;
    let preflightRejectionCode: string | undefined;
    if (input.observation.scheduleIntent.kind === "unsupported_mutation") {
      scheduleRejections.push({
        reasonCode: "unsupported_schedule_operation",
        reasonSummary:
          "The server-owned negotiation writer does not support this schedule operation.",
        field: "scheduleIntent",
      });
    } else if (canPrepareSchedule && !writerDisabledForMutation) {
      preparedPlan = this.scheduleNegotiations.prepare({
        agentId: input.agentId,
        sessionId: input.sessionId,
        timezone: input.spec.identity.timezone,
        nowUtc: input.nowUtc,
        userMessage: provisionalUserMessage(input),
        assistantMessageId: input.assistantMessageId,
        recentMessages: input.recentMessages,
        action: scheduleActionForObservation(input.observation),
        allowTextActionInference: false,
      });
      scheduleRejections.push(
        ...preparedPlan.rejections.map((rejection) => ({
          reasonCode: rejection.reasonCode,
          reasonSummary: rejection.reasonSummary,
          field: "scheduleIntent",
          raw: rejection.raw,
        })),
      );
      if (preparedPlan.rejections.length === 0) {
        const preflight = this.scheduleNegotiations.validatePresentedOffer(
          input.agentId,
          preparedPlan,
          input.nowUtc,
        );
        if (
          preflight !== undefined &&
          (preflight.accepted.length !== 1 || preflight.rejections.length > 0)
        ) {
          preflightRejectionCode =
            preflight.rejections[0]?.code ??
            "schedule_preflight_validation_failed";
          scheduleRejections.push(
            ...(preflight.rejections.length === 0
              ? [
                  {
                    reasonCode: preflightRejectionCode,
                    reasonSummary:
                      "The proposed schedule offer failed authoritative preflight validation.",
                    field: "scheduleOffer",
                  },
                ]
              : preflight.rejections.map((rejection) => ({
                  reasonCode: rejection.code,
                  reasonSummary: rejection.message,
                  field: "scheduleOffer",
                  raw: rejection.proposal,
                }))),
          );
          preparedPlan = undefined;
        }
      }
    }

    if (writerDisabledForMutation) {
      scheduleRejections.push({
        reasonCode: "schedule_writer_not_enforced",
        reasonSummary:
          "The split pipeline cannot authorize schedule mutation while the schedule writer is not enforced.",
        field: "scheduleOutcome",
      });
    }

    const usablePlan = writerDisabledForMutation ? undefined : preparedPlan;
    const candidateValidation = validatePreparedEffect(
      this.schedules,
      input,
      usablePlan,
    );
    scheduleRejections.push(
      ...candidateValidation.rejections.map((rejection) => ({
        reasonCode: rejection.code,
        reasonSummary: rejection.message,
        field: "scheduleEffect",
        raw: rejection.proposal,
      })),
    );
    const validation = writerDisabledForMutation
      ? emptyScheduleValidation()
      : candidateValidation;
    const scheduleOutcome = writerDisabledForMutation
      ? ({
          kind: "rejected",
          reasonCode: "schedule_writer_not_enforced",
        } as const)
      : preflightRejectionCode !== undefined
        ? ({
            kind: "rejected",
            reasonCode: preflightRejectionCode,
          } as const)
        : resolveScheduleOutcome(input, usablePlan, validation);

    const effects = resolveAcceptedWorldEffects(
      this.store,
      input,
      scheduleOutcome,
      worldEffectsMode,
    );
    const projectedWorldEffects =
      worldEffectsMode === "enforced" || dryRun
        ? effects.accepted
        : emptyWorldEffects();
    const stateProjection = projectTurnState({
      state: input.state,
      stateDelta: projectedWorldEffects.stateDelta,
      relationshipDelta: projectedWorldEffects.relationshipDelta,
      nowUtc: input.nowUtc,
      capabilities: input.capabilities,
    });
    const proposalRejections = [
      ...input.observation.rejectedFields.map(observationRejection),
      ...input.observation.worldEffectsValidation.rejections.map(
        (rejection) => ({
          reasonCode: rejection.reasonCode,
          reasonSummary: `${rejection.effect}: ${rejection.reasonSummary}`,
          field: rejection.effect,
          raw: rejection.raw,
        }),
      ),
      ...effects.rejections,
      ...scheduleRejections,
    ];
    const acceptedWorldEffects = effects.accepted;
    const decisionPath = decisionPathFor({
      scheduleOutcome,
      acceptedWorldEffects,
      proposalRejections,
    });

    return {
      route: input.observation.route,
      observation: input.observation,
      scheduleOutcome,
      validation,
      acceptedWorldEffects,
      worldEffectsMode,
      worldEffectWritesEnabled: worldEffectsMode === "enforced" && !dryRun,
      proposalRejections,
      nextState: stateProjection.nextState,
      stateChanged: stateProjection.stateChanged,
      replyDirectives: buildReplyDirectives(
        this.store,
        input,
        scheduleOutcome,
        usablePlan,
      ),
      ...((scheduleWritesEnabled || dryRun) && usablePlan !== undefined
        ? { negotiationPlan: usablePlan }
        : {}),
      scheduleWritesEnabled: scheduleWritesEnabled && !dryRun,
      audit: {
        schemaVersion: 1,
        policyVersion: `schedule-negotiation-${String(SCHEDULE_NEGOTIATION_POLICY_VERSION)}`,
        decisionPath,
        dryRun,
      },
    };
  }
}

function provisionalUserMessage(input: TurnExecutionInput): StoredMessage {
  return {
    id: input.userMessageId,
    sessionId: input.sessionId,
    agentId: input.agentId,
    role: "user",
    content: input.userText,
    messageKind: "user",
    clientMessageId: input.clientMessageId,
    metadata: {},
    createdAtUtc: input.nowUtc,
  };
}

function scheduleActionForObservation(
  observation: ResolvedTurnObservation,
): ScheduleNegotiationAction {
  const intent = observation.scheduleIntent;
  switch (intent.kind) {
    case "none":
    case "query_schedule":
    case "unsupported_mutation":
    case "ambiguous":
      return { kind: "none" };
    case "confirm_pending_offer":
      return {
        kind: "accept_pending_offer",
        evidenceQuotes: intent.evidenceQuotes.map((quote) => quote.text),
      };
    case "decline_pending_offer":
      return { kind: "withdraw_offer" };
    case "create_shared_activity": {
      const quotes = uniqueStrings([
        intent.activityQuote.text,
        ...(intent.timeQuote === undefined ? [] : [intent.timeQuote.text]),
        ...(intent.participantQuote === undefined
          ? []
          : [intent.participantQuote.text]),
      ]);
      const category = normalizePersonalIntentCategory(
        undefined,
        intent.activityQuote.text,
      );
      if (intent.timeQuote === undefined || intent.missingFields.length > 0) {
        return {
          kind: "request_details",
          offer: {
            activity: intent.activityQuote.text,
            category,
            ...(intent.timeQuote === undefined
              ? {}
              : { startAt: intent.timeQuote.text }),
            ...(intent.durationMinutes === undefined
              ? {}
              : { durationMinutes: intent.durationMinutes }),
            evidenceQuotes: quotes,
          },
        };
      }
      return {
        kind: "accept_user_offer",
        offer: {
          activity: intent.activityQuote.text,
          category,
          startAt: intent.timeQuote.text,
          ...(intent.durationMinutes === undefined
            ? {}
            : { durationMinutes: intent.durationMinutes }),
          evidenceQuotes: quotes,
        },
      };
    }
  }
}

function validatePreparedEffect(
  schedules: ScheduleService,
  input: TurnExecutionInput,
  plan: PreparedScheduleNegotiation | undefined,
): PartialProposalValidation {
  return plan?.effect === undefined
    ? emptyScheduleValidation()
    : schedules.validateEffectsPartial(
        input.agentId,
        [plan.effect],
        input.nowUtc,
      );
}

function emptyScheduleValidation(): PartialProposalValidation {
  return { accepted: [], rejections: [] };
}

function resolveScheduleOutcome(
  input: TurnExecutionInput,
  plan: PreparedScheduleNegotiation | undefined,
  validation: PartialProposalValidation,
): ScheduleOutcome {
  if (input.observation.route === "schedule_query") {
    return {
      kind: "read_only",
      itemIds: authoritativeReadItems(input).map((item) => item.id),
    };
  }
  if (input.observation.scheduleIntent.kind === "unsupported_mutation") {
    return { kind: "rejected", reasonCode: "unsupported_schedule_operation" };
  }
  if (input.observation.scheduleIntent.kind === "ambiguous") {
    return {
      kind: "needs_clarification",
      missingFields: input.observation.scheduleIntent.missingFields,
    };
  }
  if (
    input.observation.scheduleIntent.kind === "create_shared_activity" &&
    input.observation.scheduleIntent.missingFields.length > 0
  ) {
    return {
      kind: "needs_clarification",
      missingFields: input.observation.scheduleIntent.missingFields,
    };
  }
  if (plan === undefined) return { kind: "none" };
  const rejection = plan.rejections[0] ?? validation.rejections[0];
  if (rejection !== undefined) {
    return {
      kind: "rejected",
      reasonCode:
        "reasonCode" in rejection ? rejection.reasonCode : rejection.code,
    };
  }
  const committed = plan.updates.find(
    (update) => update.status === "committed",
  );
  if (plan.effect !== undefined && validation.accepted.length === 1) {
    const negotiationId =
      committed?.id ??
      plan.expectedActive?.id ??
      input.activeNegotiation?.stored.id;
    return negotiationId === undefined
      ? { kind: "rejected", reasonCode: "missing_negotiation_identity" }
      : { kind: "committed", negotiationId, scheduleItemIds: [] };
  }
  const declined = plan.updates.find(
    (update) => update.status === "declined" || update.status === "withdrawn",
  );
  if (declined !== undefined) {
    return { kind: "declined", negotiationId: declined.id };
  }
  const pending =
    [...plan.updates]
      .reverse()
      .find((update) => update.status === "awaiting_confirmation") ??
    (input.activeNegotiation?.state.status === "awaiting_confirmation"
      ? input.activeNegotiation.stored
      : undefined);
  if (pending !== undefined) {
    return {
      kind: "pending_confirmation",
      negotiationId: pending.id,
      offerVersion: pending.offerVersion,
    };
  }
  if (plan.actionKind === "request_details") {
    return {
      kind: "needs_clarification",
      missingFields:
        input.observation.scheduleIntent.kind === "create_shared_activity"
          ? input.observation.scheduleIntent.missingFields
          : ["activity", "time"],
    };
  }
  return { kind: "none" };
}

function resolveAcceptedWorldEffects(
  store: DatabaseStore,
  input: TurnExecutionInput,
  scheduleOutcome: ScheduleOutcome,
  mode: "off" | "shadow" | "enforced",
): {
  accepted: ValidatedWorldEffects;
  rejections: SplitTurnProposalRejection[];
} {
  const proposed = input.observation.worldEffectsValidation.effects;
  if (mode === "off") {
    return { accepted: emptyWorldEffects(), rejections: [] };
  }
  const rejections: SplitTurnProposalRejection[] = [];
  const eligibility = worldEffectEligibility(input);
  const authoritativeScheduleDialogue =
    input.observation.scheduleFrame !== undefined ||
    input.observation.route === "schedule_query" ||
    input.observation.route === "schedule_mutation";
  const personalIntentCandidates: ValidatedWorldEffects["personalIntentCandidates"] =
    [];
  for (const candidate of proposed.personalIntentCandidates) {
    if (!eligibility.personalIntent) {
      rejections.push({
        reasonCode: "personal_intent_not_eligible_for_turn",
        reasonSummary:
          "The current turn contains no grounded character-intent signal.",
        field: "personal_intent_candidate",
        raw: candidate,
      });
      continue;
    }
    if (authoritativeScheduleDialogue) {
      rejections.push({
        reasonCode: "schedule_proposal_owned_by_negotiation",
        reasonSummary:
          "A server-owned schedule dialogue cannot also create a shadow personal intent.",
        field: "personal_intent_candidate",
        raw: candidate,
      });
      continue;
    }
    const normalized = normalizePersonalIntentCandidate({
      candidate,
      agentId: input.agentId,
      spec: input.spec,
      currentUserMessage: { id: input.userMessageId, text: input.userText },
      nowUtc: input.nowUtc,
      timezone: input.spec.identity.timezone,
    });
    if (normalized.accepted) {
      personalIntentCandidates.push(candidate);
    } else {
      rejections.push({
        reasonCode: normalized.rejection.reasonCode,
        reasonSummary: normalized.rejection.reasonSummary,
        field: "personal_intent_candidate",
        raw: candidate,
      });
    }
  }
  const scheduleCommitted = scheduleOutcome.kind === "committed";
  const nonShadowMemoryCandidates = proposed.memoryCandidates.filter(
    (candidate) => {
      if (
        !authoritativeScheduleDialogue ||
        !SCHEDULE_LIFECYCLE_MEMORY_PATTERN.test(candidate.content)
      ) {
        return true;
      }
      rejections.push({
        reasonCode: "schedule_memory_requires_authoritative_state",
        reasonSummary:
          "Schedule negotiation lifecycle is represented by authoritative negotiation and command records, not a parallel model memory.",
        field: "memory_candidate",
        raw: candidate,
      });
      return false;
    },
  );
  const eligibleMemoryCandidates = nonShadowMemoryCandidates.filter(
    (candidate) => {
      if (eligibility.memory) return true;
      rejections.push({
        reasonCode: "memory_not_eligible_for_turn",
        reasonSummary:
          "The current turn contains no explicit or stable user-fact signal.",
        field: "memory_candidate",
        raw: candidate,
      });
      return false;
    },
  );
  const scheduleEligibleMemoryCandidates = eligibleMemoryCandidates.filter(
    (candidate) => {
      if (candidate.kind !== "commitment" || scheduleCommitted) return true;
      rejections.push({
        reasonCode: "uncommitted_schedule_commitment",
        reasonSummary:
          "A schedule commitment memory requires an authoritative committed schedule outcome.",
        field: "memory_candidate",
        raw: candidate,
      });
      return false;
    },
  );
  const memoryCandidateLimit = Math.max(
    0,
    Math.trunc(input.capabilities.memoryCandidatesPerTurn),
  );
  const memoryPreflight = input.capabilities.longTermMemory
    ? preflightMemoryCandidates({
        store,
        agentId: input.agentId,
        candidates: scheduleEligibleMemoryCandidates,
        nowUtc: input.nowUtc,
        maxCandidates: memoryCandidateLimit,
        authoritativeMessageId: input.userMessageId,
        authoritativeMessage: {
          id: input.userMessageId,
          role: "user",
          content: input.userText,
          createdAtUtc: input.nowUtc,
        },
      })
    : { accepted: [], rejections: [] };
  rejections.push(
    ...memoryPreflight.rejections.map((rejection) => ({
      reasonCode: rejection.reasonCode,
      reasonSummary: rejection.reasonSummary,
      field: "memory_candidate",
      raw: scheduleEligibleMemoryCandidates[rejection.index],
    })),
  );
  let memoryCandidates = input.capabilities.longTermMemory
    ? memoryPreflight.accepted
    : [];
  const explicitSourceCandidate =
    input.capabilities.longTermMemory &&
    memoryCandidateLimit > 0 &&
    eligibility.memory
      ? explicitSourceMemoryCandidate(input)
      : undefined;
  const explicitSourceFallback =
    explicitSourceCandidate !== undefined &&
    shouldAddExplicitSourceMemoryFallback(
      explicitSourceCandidate,
      memoryCandidates,
    )
      ? explicitSourceCandidate
      : undefined;
  if (explicitSourceFallback !== undefined) {
    const fallbackPreflight = preflightMemoryCandidates({
      store,
      agentId: input.agentId,
      candidates: [explicitSourceFallback],
      nowUtc: input.nowUtc,
      maxCandidates: 1,
      authoritativeMessageId: input.userMessageId,
      authoritativeMessage: {
        id: input.userMessageId,
        role: "user",
        content: input.userText,
        createdAtUtc: input.nowUtc,
      },
    });
    rejections.push(
      ...fallbackPreflight.rejections.map((rejection) => ({
        reasonCode: rejection.reasonCode,
        reasonSummary: rejection.reasonSummary,
        field: "memory_candidate",
        raw: explicitSourceFallback,
      })),
    );
    const acceptedFallback = fallbackPreflight.accepted[0];
    if (acceptedFallback !== undefined) {
      const sourceBoundCandidates = memoryCandidates.filter((candidate) =>
        candidate.sourceMessageIds.includes(input.userMessageId),
      );
      if (sourceBoundCandidates.length > 0) {
        const sourceBound = new Set(sourceBoundCandidates);
        memoryCandidates = memoryCandidates.filter(
          (candidate) => !sourceBound.has(candidate),
        );
        for (const displaced of sourceBoundCandidates) {
          rejections.push({
            reasonCode:
              "memory_candidate_displaced_by_explicit_source_fallback",
            reasonSummary:
              "A current-source model candidate was displaced because the exact-source fallback subsumes it and preserves complete authoritative fact coverage.",
            field: "memory_candidate",
            raw: displaced,
          });
        }
      }
      while (memoryCandidates.length >= memoryCandidateLimit) {
        const displaced = memoryCandidates.pop();
        if (displaced === undefined) break;
        rejections.push({
          reasonCode: "memory_candidate_displaced_by_explicit_source_fallback",
          reasonSummary:
            "A grounded model candidate was displaced to preserve complete authoritative fact coverage within the per-turn memory limit.",
          field: "memory_candidate",
          raw: displaced,
        });
      }
      memoryCandidates = [...memoryCandidates, acceptedFallback];
    }
  }
  if (proposed.stateDelta !== undefined && !eligibility.stateDelta) {
    rejections.push({
      reasonCode: "state_delta_not_eligible_for_turn",
      reasonSummary:
        "The current turn contains no grounded emotional or interaction signal.",
      field: "state_delta",
      raw: proposed.stateDelta,
    });
  }
  if (
    proposed.relationshipDelta !== undefined &&
    !eligibility.relationshipDelta
  ) {
    rejections.push({
      reasonCode: "relationship_delta_not_eligible_for_turn",
      reasonSummary:
        "The current turn contains no grounded relationship signal.",
      field: "relationship_delta",
      raw: proposed.relationshipDelta,
    });
  }
  return {
    accepted: {
      ...(input.capabilities.dynamicState &&
      proposed.stateDelta !== undefined &&
      eligibility.stateDelta
        ? { stateDelta: proposed.stateDelta }
        : {}),
      ...(input.capabilities.relationshipDynamics &&
      proposed.relationshipDelta !== undefined &&
      eligibility.relationshipDelta
        ? { relationshipDelta: proposed.relationshipDelta }
        : {}),
      memoryCandidates,
      personalIntentCandidates,
    },
    rejections,
  };
}

function worldEffectEligibility(input: TurnExecutionInput): {
  stateDelta: boolean;
  relationshipDelta: boolean;
  memory: boolean;
  personalIntent: boolean;
} {
  return worldEffectEligibilityForTurn({
    userMessage: input.userText,
    route: input.observation.route,
  });
}

const SCHEDULE_LIFECYCLE_MEMORY_PATTERN =
  /(?:待确认|待定(?:安排|方案|邀约)|已确认(?:安排|方案|邀约)|已经确认|写入日程|加入日程|共同安排|共同邀约|取消(?:了|掉)?(?:.*(?:安排|方案|邀约))|撤回(?:了|掉)?(?:.*(?:安排|方案|邀约))|\b(?:pending|confirmed|committed|withdrawn|cancelled)\b.{0,30}\b(?:schedule|offer|invitation|plan)\b)/iu;

const EXPLICIT_SOURCE_FALLBACK_QUESTION_PATTERN =
  /[?？]|(?:是不是|是否|哪里|哪儿|什么|谁|多少|怎么|如何|真的吗|对吗|记得吗)/iu;
const EXPLICIT_SOURCE_FALLBACK_UNCERTAINTY_PATTERN =
  /(?:也许|或许|可能|大概|没准|猜测|听说|似乎|好像|应该是)|\b(?:maybe|perhaps|possibly|probably|i\s+(?:guess|suppose|heard))\b/iu;
const EXPLICIT_SOURCE_FALLBACK_FACT_PATTERN =
  /(?:我|我的|本人|物件|代号|编号|标识符|习惯|偏好|生日|家乡|住在|来自|放在|位于|叫|喜欢|不喜欢|讨厌|过敏|每次|通常|一直|总是|从不)|\b(?:i|my|mine|habit|preference|identifier|code|located|stored|keep|put)\b/iu;
const MAX_EXPLICIT_SOURCE_MEMORY_LENGTH = 2_000;

function shouldAddExplicitSourceMemoryFallback(
  explicitSource: MemoryCandidate,
  accepted: readonly MemoryCandidate[],
): boolean {
  if (accepted.length === 0) return true;
  const identifiers = recallExactIdentifiers(explicitSource.content);
  const covered = new Set(
    accepted.flatMap((candidate) => recallExactIdentifiers(candidate.content)),
  );
  if (identifiers.some((identifier) => !covered.has(identifier))) return true;
  const acceptedSources = accepted.map((candidate) => ({
    memoryContent: candidate.content,
  }));
  return authoritativeMemoryCoverageClauses(explicitSource.content).some(
    (clause) =>
      !auditEvidenceOnlyTextGrounding({
        text: clause,
        sources: acceptedSources,
        requireGroundedClaim: true,
      }).passed,
  );
}

const EXPLICIT_MEMORY_INSTRUCTION_CLAUSE_PATTERN =
  /^(?:(?:另)?请|麻烦(?:你)?|帮我|务必|不要|别|只(?:按|根据)|如果不确定|不确定(?:就|的话)|请只按).{0,80}(?:记|记录|保存|补充|猜|说|内容|事实)(?:下来|住)?$/u;
const EXPLICIT_MEMORY_FRAMING_CLAUSE_PATTERN =
  /^(?:再|另外|此外)?(?:请)?(?:记|记住|记下(?:来)?|记录|保存)(?:一个|一条|一下)?(?:饮食|个人|生活|长期)?(?:偏好|事实|信息|内容|习惯)?$/u;
const EXPLICIT_CARE_REQUEST_CLAUSE_PATTERN =
  /^(?:我)?(?:希望|想让|需要|想请)你(?:先|别|不要|能|可以|听|陪|问)/u;
const LEADING_EXPLICIT_MEMORY_INSTRUCTION_PATTERN =
  /^(?:(?:另)?请|麻烦(?:你)?|帮我|务必)?(?:记住|记下(?:来)?|记录|保存)(?:一下)?(?:这个|这件|以下)?(?:事实|内容)?[\s：:]*/u;

function authoritativeMemoryCoverageClauses(source: string): string[] {
  return splitEvidenceOnlyClauses(source)
    .map((clause) => clause.trim())
    .filter(
      (clause) =>
        clause !== "" &&
        !EXPLICIT_MEMORY_INSTRUCTION_CLAUSE_PATTERN.test(clause) &&
        !EXPLICIT_MEMORY_FRAMING_CLAUSE_PATTERN.test(clause) &&
        !EXPLICIT_CARE_REQUEST_CLAUSE_PATTERN.test(clause),
    )
    .map((clause) =>
      clause.replace(LEADING_EXPLICIT_MEMORY_INSTRUCTION_PATTERN, "").trim(),
    )
    .filter(Boolean);
}

function explicitSourceMemoryCandidate(
  input: TurnExecutionInput,
): MemoryCandidate | undefined {
  const rawSource = input.userText.trim();
  const normalizedRawSource = rawSource.normalize("NFKC");
  const rawEpistemicStatus = classifyMemoryEpistemicStatus(normalizedRawSource);
  if (
    normalizedRawSource.length === 0 ||
    !memorySourceCanAuthorizeUserFact({
      text: normalizedRawSource,
      status: rawEpistemicStatus,
    }) ||
    rawEpistemicStatus === "hypothetical" ||
    rawEpistemicStatus === "quoted_third_party" ||
    rawEpistemicStatus === "negated" ||
    rawEpistemicStatus === "retracted"
  ) {
    return undefined;
  }
  const activeCorrection = projectActiveCorrectionStatement(rawSource);
  if (
    activeCorrection === undefined &&
    isCorrectionShapedUserFactSource(rawSource)
  ) {
    return undefined;
  }
  const source = activeCorrection?.text ?? rawSource;
  const normalized = source.normalize("NFKC");
  if (
    !memorySourceCanAuthorizeUserFact({ text: normalized }) ||
    EXPLICIT_SOURCE_FALLBACK_QUESTION_PATTERN.test(normalized) ||
    EXPLICIT_SOURCE_FALLBACK_UNCERTAINTY_PATTERN.test(normalized) ||
    !EXPLICIT_SOURCE_FALLBACK_FACT_PATTERN.test(normalized)
  ) {
    return undefined;
  }
  const epistemicStatus = classifyMemoryEpistemicStatus(normalized);
  if (
    epistemicStatus === "hypothetical" ||
    epistemicStatus === "quoted_third_party" ||
    epistemicStatus === "negated" ||
    epistemicStatus === "retracted"
  ) {
    return undefined;
  }
  const content = boundedExplicitSourceExcerpt(source);
  const evidenceQuote = boundedExplicitSourceExcerpt(
    activeCorrection?.evidenceQuote ?? content,
  );
  return MemoryCandidateSchema.parse({
    kind: "semantic",
    content,
    importance: 0.7,
    confidence: 1,
    tags: ["user_fact", "explicit_source_fallback"],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "stable",
    evidence: [
      {
        sourceType: "message",
        sourceId: input.userMessageId,
        quote: evidenceQuote,
        recordedAtUtc: input.nowUtc,
      },
    ],
    shouldWrite: true,
    forbiddenOverclaims: [],
    reasonCode: "explicit_source_memory_fallback",
    reasonSummary:
      "The server preserved a stable explicit user fact after model candidates failed authoritative coverage.",
  });
}

function boundedExplicitSourceExcerpt(source: string): string {
  if (source.length <= MAX_EXPLICIT_SOURCE_MEMORY_LENGTH) return source;
  const normalized = source.toLocaleLowerCase();
  const anchors = recallExactIdentifierAnchors(source);
  const firstAnchorIndex = anchors
    .map((anchor) => normalized.indexOf(anchor))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  if (firstAnchorIndex === undefined) {
    return source.slice(0, MAX_EXPLICIT_SOURCE_MEMORY_LENGTH).trim();
  }
  const start = Math.max(
    0,
    Math.min(
      source.length - MAX_EXPLICIT_SOURCE_MEMORY_LENGTH,
      firstAnchorIndex - Math.floor(MAX_EXPLICIT_SOURCE_MEMORY_LENGTH / 2),
    ),
  );
  return source.slice(start, start + MAX_EXPLICIT_SOURCE_MEMORY_LENGTH).trim();
}

function emptyWorldEffects(): ValidatedWorldEffects {
  return { memoryCandidates: [], personalIntentCandidates: [] };
}

function observationRejection(
  rejection: ObservationRejection,
): SplitTurnProposalRejection {
  return {
    reasonCode: rejection.reasonCode,
    reasonSummary: rejection.reasonSummary,
    field: rejection.field,
  };
}

function buildReplyDirectives(
  store: DatabaseStore,
  input: TurnExecutionInput,
  scheduleOutcome: ScheduleOutcome,
  plan: PreparedScheduleNegotiation | undefined,
): TurnReplyDirectives {
  const activityFacts = authoritativeRecentActivityFacts(store, input);
  const facts: TurnReplyDirectives["authoritativeFacts"] = [...activityFacts];
  const unsupportedCommittedFact =
    scheduleOutcome.kind === "rejected" &&
    scheduleOutcome.reasonCode === "unsupported_schedule_operation"
      ? authoritativeUnsupportedMutationFact(input)
      : undefined;
  if (scheduleOutcome.kind === "read_only") {
    facts.push(...authoritativeScheduleReadFacts(store, input));
  } else if (unsupportedCommittedFact !== undefined) {
    facts.push(unsupportedCommittedFact);
  } else if (plan?.presentationText !== undefined) {
    facts.push({
      kind: "schedule",
      text: plan.presentationText,
      requiredAnchors: schedulePresentationAnchors(plan.presentationText),
      ...(scheduleOutcome.kind === "pending_confirmation" ||
      scheduleOutcome.kind === "committed" ||
      scheduleOutcome.kind === "declined"
        ? { sourceId: scheduleOutcome.negotiationId }
        : {}),
    });
  }
  const mustNotClaim: ReplyClaimRestriction[] = [
    "memory_persisted",
    "future_action_guaranteed",
  ];
  const readReportsCommitted =
    scheduleOutcome.kind === "read_only" && scheduleOutcome.itemIds.length > 0;
  const readReportsWithdrawal =
    scheduleOutcome.kind === "read_only" &&
    facts.some((fact) => fact.text.includes("已取消待确认方案"));
  if (readReportsWithdrawal) {
    mustNotClaim.push("schedule_committed");
  } else if (
    scheduleOutcome.kind === "committed" ||
    readReportsCommitted ||
    unsupportedCommittedFact !== undefined
  ) {
    mustNotClaim.push("schedule_cancelled");
  } else {
    mustNotClaim.push("schedule_committed", "schedule_cancelled");
  }
  return {
    mode:
      activityFacts.length > 0
        ? "answer"
        : replyModeFor(input.observation.route, scheduleOutcome),
    evidenceOnly: input.memoryReplyPolicy?.evidenceOnly ?? false,
    mustAbstain: input.memoryReplyPolicy?.mustAbstain ?? false,
    mustNotInferFromPersona:
      input.memoryReplyPolicy?.mustNotInferFromPersona ?? false,
    allowedEvidenceIds: [
      ...new Set(input.memoryReplyPolicy?.allowedEvidenceIds ?? []),
    ].slice(0, 3),
    mustAddressUserQuotes: input.observation.validatedEvidence
      .map((item) => item.text)
      .slice(0, 4),
    authoritativeFacts: facts,
    mustNotClaim,
    ...(plan?.presentationText === undefined
      ? {}
      : { presentationText: plan.presentationText }),
  };
}

const RECENT_SETTLED_ACTIVITY_QUERY =
  /(?:(?:刚才|刚刚|上一项|前一项|之前那项|方才).{0,12}(?:活动|事情|工作|安排|那项|它)?.{0,12}(?:结束|完成|做完|结算)(?:了)?(?:吗|么|没有|没|了没|了么|否|[？?])|(?:刚才|刚刚|上一项|前一项|之前那项|方才)(?:那项)?(?:活动|事情|工作|安排)?(?:结束|完成|做完|结算)(?:了吗|了么|了没|没有|没|[？?]))/u;
const TERMINAL_ACTIVITY_TYPES = new Set<StoredActivityEvent["eventType"]>([
  "completed",
  "partial",
  "skipped",
  "cancelled",
]);
const RECENT_ACTIVITY_MAX_AGE_HOURS = 6;

/** High-precision gate for a deictic query about the most recently settled activity. */
export function isRecentSettledActivityQuery(userText: string): boolean {
  return RECENT_SETTLED_ACTIVITY_QUERY.test(userText.normalize("NFKC"));
}

function authoritativeRecentActivityFacts(
  store: DatabaseStore,
  input: TurnExecutionInput,
): TurnReplyDirectives["authoritativeFacts"] {
  if (!isRecentSettledActivityQuery(input.userText)) return [];
  const now = DateTime.fromISO(input.nowUtc);
  if (!now.isValid) return [];
  const event = store
    .listActivityEvents(input.agentId, 50)
    .find((candidate) => {
      if (!TERMINAL_ACTIVITY_TYPES.has(candidate.eventType)) return false;
      const occurredAt = DateTime.fromISO(candidate.occurredAtUtc);
      if (!occurredAt.isValid || occurredAt > now) return false;
      return (
        now.diff(occurredAt, "hours").hours <= RECENT_ACTIVITY_MAX_AGE_HOURS
      );
    });
  if (event === undefined) return [];

  const item =
    event.scheduleItemId === undefined
      ? undefined
      : store.getScheduleItem(event.scheduleItemId);
  const title =
    item?.title.trim() || compactActivityTitle(event.summary) || "刚才那项活动";
  const outcome = terminalActivityOutcome(event.eventType);
  return [
    {
      kind: "activity",
      sourceId: event.id,
      activityEventType: event.eventType,
      text: `最近一次已结算活动“${title}”已经结束，结果为${outcome.label}。`,
      requiredAnchors: uniqueStrings([title, outcome.anchor]),
    },
  ];
}

function terminalActivityOutcome(eventType: StoredActivityEvent["eventType"]): {
  label: string;
  anchor: string;
} {
  switch (eventType) {
    case "completed":
      return { label: "已完成", anchor: "已完成" };
    case "partial":
      return { label: "部分完成", anchor: "部分完成" };
    case "skipped":
      return { label: "已跳过", anchor: "已跳过" };
    case "cancelled":
      return { label: "已取消", anchor: "已取消" };
    case "started":
      return { label: "已开始", anchor: "已开始" };
  }
}

function compactActivityTitle(summary: string): string | undefined {
  const compact = summary.replace(/\s+/gu, " ").trim();
  if (compact === "") return undefined;
  return compact.slice(0, 80);
}

function scheduleItemFact(item: ScheduleItem, nowUtc?: string): string {
  const start = DateTime.fromISO(item.startAtUtc).setZone(item.timezone);
  const end = DateTime.fromISO(item.endAtUtc).setZone(item.timezone);
  const endText =
    start.toISODate() === end.toISODate()
      ? end.toFormat("HH:mm")
      : end.toFormat("yyyy-MM-dd HH:mm");
  const scheduleText = `${start.toFormat("yyyy-MM-dd HH:mm")}–${endText}，${item.title}（${item.timezone}）。本地时间：${start.toFormat("yyyy年MM月dd日 HH:mm")}。`;
  const historicalOutcome = historicalSharedCommitmentOutcome(item, nowUtc);
  if (historicalOutcome !== undefined) {
    return `这是当时已确认的共同安排：${scheduleText}${historicalOutcome}`;
  }
  return isCommittedSharedScheduleItem(item)
    ? `这是当前已确认并生效的共同安排：${scheduleText}`
    : scheduleText;
}

function scheduleItemFactAnchors(
  item: ScheduleItem,
  nowUtc?: string,
): string[] {
  const start = DateTime.fromISO(item.startAtUtc).setZone(item.timezone);
  const end = DateTime.fromISO(item.endAtUtc).setZone(item.timezone);
  const historicalOutcome = historicalSharedCommitmentOutcome(item, nowUtc);
  return uniqueStrings([
    start.toFormat("yyyy-MM-dd"),
    start.toFormat("HH:mm"),
    end.toFormat("HH:mm"),
    start.toFormat("yyyy年MM月dd日 HH:mm"),
    item.title,
    ...(historicalOutcome === undefined
      ? isCommittedSharedScheduleItem(item)
        ? ["当前已确认并生效"]
        : []
      : ["当时已确认", historicalScheduleStatusLabel(item.status)]),
  ]);
}

function isCommittedSharedScheduleItem(item: ScheduleItem): boolean {
  return (
    item.source === "user_invitation" &&
    item.shareable === true &&
    item.rigidity === "committed" &&
    item.status !== "cancelled"
  );
}

function authoritativeUnsupportedMutationFact(
  input: TurnExecutionInput,
): TurnReplyDirectives["authoritativeFacts"][number] | undefined {
  if (input.observation.scheduleIntent.kind !== "unsupported_mutation") {
    return undefined;
  }
  const item = exactCurrentCommittedSharedItemMentioned(input);
  if (item === undefined) return undefined;
  const operation = input.observation.scheduleIntent.operation;
  const disposition =
    operation === "reschedule"
      ? "本次改期未执行"
      : operation === "delete"
        ? "本次删除未执行"
        : "本次修改未执行";
  return {
    kind: "schedule",
    sourceId: item.id,
    scheduleAuthorityState: "committed",
    scheduleMutationDisposition: "unchanged",
    text: `原已确认安排保持不变；${disposition}。对应安排：${item.title}。`,
    requiredAnchors: ["原已确认安排保持不变", disposition, item.title],
  };
}

function exactCurrentCommittedSharedItemMentioned(
  input: TurnExecutionInput,
): ScheduleItem | undefined {
  const userText = comparableScheduleText(input.userText);
  const now = DateTime.fromISO(input.nowUtc).toMillis();
  const matches = input.authoritativeSchedule.filter((item) => {
    if (
      !isCommittedSharedScheduleItem(item) ||
      DateTime.fromISO(item.endAtUtc).toMillis() < now
    ) {
      return false;
    }
    const exactEntity = comparableScheduleText(item.title).replace(
      /^(?:和|与|跟)用户(?:在)?/u,
      "",
    );
    return exactEntity.length >= 4 && userText.includes(exactEntity);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function historicalSharedCommitmentOutcome(
  item: ScheduleItem,
  nowUtc: string | undefined,
): string | undefined {
  if (
    nowUtc === undefined ||
    item.source !== "user_invitation" ||
    item.rigidity !== "committed" ||
    DateTime.fromISO(item.endAtUtc).toMillis() >=
      DateTime.fromISO(nowUtc).toMillis()
  ) {
    return undefined;
  }
  return `记录的执行结果：${historicalScheduleStatusLabel(item.status)}。`;
}

function historicalScheduleStatusLabel(status: ScheduleItem["status"]): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "partial":
      return "部分完成";
    case "skipped":
      return "未执行";
    case "in_progress":
      return "进行中";
    case "planned":
      return "已计划，时间已过";
    case "cancelled":
      return "已取消";
  }
}

function schedulePresentationAnchors(text: string): string[] {
  const match = /】([^，]+)，([^，]+)，([^（。]+)(?:（|。)/u.exec(text);
  if (match === null) return [];
  const localLabel = /本地时间：([^。]+)/u.exec(text)?.[1] ?? "";
  return uniqueStrings([
    match[1] ?? "",
    match[2] ?? "",
    match[3] ?? "",
    localLabel,
  ]);
}

function replyModeFor(
  route: ResolvedTurnObservation["route"],
  scheduleOutcome: ScheduleOutcome,
): ReplyDirectiveMode {
  switch (scheduleOutcome.kind) {
    case "read_only":
      return "answer";
    case "needs_clarification":
    case "rejected":
      return "clarify";
    case "pending_confirmation":
    case "committed":
      return "confirm";
    case "declined":
      return "decline";
    case "none":
      return route === "explicit_memory" || route === "continuity"
        ? "empathize"
        : "casual";
  }
}

function authoritativeReadItems(input: TurnExecutionInput): ScheduleItem[] {
  const now = DateTime.fromISO(input.nowUtc).toMillis();
  const end = DateTime.fromISO(input.nowUtc).plus({ hours: 72 }).toMillis();
  const frame =
    input.observation.scheduleFrame?.kind === "query_existing"
      ? input.observation.scheduleFrame
      : undefined;
  const futureCandidates = input.authoritativeSchedule
    .filter(
      (item) =>
        item.status !== "cancelled" &&
        DateTime.fromISO(item.endAtUtc).toMillis() >= now &&
        DateTime.fromISO(item.startAtUtc).toMillis() <= end,
    )
    .filter((item) => frame?.targetScope !== "shared" || isSharedItem(item))
    .filter(
      (item) =>
        frame?.entityText === undefined ||
        scheduleEntityReferenced(frame.entityText, item.title),
    )
    .sort((left, right) => left.startAtUtc.localeCompare(right.startAtUtc));

  if (allowsHistoricalCommittedSharedEntityRead(input.observation)) {
    const entityText = frame?.entityText;
    if (entityText === undefined) return futureCandidates.slice(0, 3);
    const authorizedItemIds = new Set(
      input.historicalScheduleReadAuthorizations
        ?.filter(
          (authorization) =>
            authorization.negotiationStatus === "committed" &&
            authorization.scheduleCommandEventId.trim() !== "" &&
            authorization.negotiationId.trim() !== "" &&
            Number.isSafeInteger(authorization.offerVersion) &&
            authorization.offerVersion >= 0,
        )
        .map((authorization) => authorization.authorizedItemId) ?? [],
    );
    const historicalCandidates = input.authoritativeSchedule.filter(
      (item) =>
        authorizedItemIds.has(item.id) &&
        item.status !== "cancelled" &&
        item.source === "user_invitation" &&
        item.rigidity === "committed" &&
        DateTime.fromISO(item.endAtUtc).toMillis() < now &&
        comparableScheduleText(item.title).includes(
          comparableScheduleText(entityText),
        ),
    );
    return uniqueScheduleItems([...futureCandidates, ...historicalCandidates])
      .sort((left, right) => {
        const relevance =
          scheduleEntityRelevance(entityText, right.title) -
          scheduleEntityRelevance(entityText, left.title);
        return relevance !== 0
          ? relevance
          : right.startAtUtc.localeCompare(left.startAtUtc);
      })
      .slice(0, 3);
  }

  const candidates = futureCandidates;
  if (
    frame?.targetScope === "shared" &&
    frame.entityText === undefined &&
    candidates.length > 3
  ) {
    return candidates.slice(-3);
  }
  return candidates.slice(0, frame?.targetScope === "shared" ? 3 : 20);
}

/**
 * Historical schedule rows are intentionally unavailable to ordinary reads.
 * Only a server-resolved, high-precision query for a named shared commitment
 * may ask the caller to load them for authoritative execution.
 */
export function allowsHistoricalCommittedSharedEntityRead(
  observation: ResolvedTurnObservation,
): boolean {
  const frame = observation.scheduleFrame;
  return (
    observation.route === "schedule_query" &&
    frame?.kind === "query_existing" &&
    frame.statusScope === "committed" &&
    frame.targetScope === "shared" &&
    frame.entityText !== undefined &&
    isSpecificHistoricalScheduleEntityText(frame.entityText)
  );
}

function uniqueScheduleItems(items: readonly ScheduleItem[]): ScheduleItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function scheduleEntityRelevance(entityText: string, title: string): number {
  const entity = comparableScheduleText(entityText);
  const candidate = comparableScheduleText(title).replace(/^和用户/u, "");
  if (candidate === entity) return 4;
  if (candidate.includes(entity)) return 3;
  if (entity.includes(candidate)) return 2;
  const anchors = entity.match(/[\p{Script=Han}a-z0-9_-]{2,}/giu) ?? [];
  return anchors.filter((anchor) => candidate.includes(anchor)).length;
}

function authoritativeScheduleReadFacts(
  store: DatabaseStore,
  input: TurnExecutionInput,
): TurnReplyDirectives["authoritativeFacts"] {
  const frame =
    input.observation.scheduleFrame?.kind === "query_existing"
      ? input.observation.scheduleFrame
      : undefined;
  if (frame?.statusScope === "pending") {
    const offer = input.activeNegotiation?.state.offer;
    if (
      offer !== undefined &&
      (frame.entityText === undefined ||
        scheduleEntityReferenced(frame.entityText, offer.activity))
    ) {
      const text = formatPendingOffer(offer, input.spec.identity.timezone);
      return [
        {
          kind: "schedule",
          ...(input.activeNegotiation === undefined
            ? {}
            : { sourceId: input.activeNegotiation.stored.id }),
          text,
          requiredAnchors: schedulePresentationAnchors(text),
        },
      ];
    }
    return [noMatchingScheduleFact(frame.entityText, "pending")];
  }

  const readItems = authoritativeReadItems(input);
  if (readItems.length > 0) {
    return readItems.map((item) => ({
      kind: "schedule" as const,
      sourceId: item.id,
      ...(isCommittedSharedScheduleItem(item)
        ? {
            scheduleAuthorityState: "committed" as const,
            scheduleMutationDisposition: "unchanged" as const,
          }
        : {}),
      text: scheduleItemFact(item, input.nowUtc),
      requiredAnchors: scheduleItemFactAnchors(item, input.nowUtc),
    }));
  }

  if (frame?.statusScope === "any") {
    const withdrawn = store
      .listScheduleNegotiations({ agentId: input.agentId, limit: 30 })
      .find((candidate) => {
        if (
          candidate.status !== "withdrawn" &&
          candidate.status !== "declined"
        ) {
          return false;
        }
        const offer = canonicalOfferFromStoredNegotiation(candidate);
        return (
          offer !== undefined &&
          (frame.entityText === undefined ||
            scheduleEntityReferenced(frame.entityText, offer.activity))
        );
      });
    const offer =
      withdrawn === undefined
        ? undefined
        : canonicalOfferFromStoredNegotiation(withdrawn);
    if (withdrawn !== undefined && offer !== undefined) {
      const text = formatWithdrawnOffer(offer, input.spec.identity.timezone);
      return [
        {
          kind: "schedule",
          sourceId: withdrawn.id,
          text,
          requiredAnchors: schedulePresentationAnchors(text),
        },
      ];
    }
  }

  if (frame !== undefined) {
    return [noMatchingScheduleFact(frame.entityText, frame.statusScope)];
  }
  return [
    {
      kind: "schedule",
      text: "未来 72 小时内没有可显示的日程安排。",
      requiredAnchors: ["没有", "日程安排"],
    },
  ];
}

function noMatchingScheduleFact(
  entityText: string | undefined,
  status: "pending" | "committed" | "any",
): TurnReplyDirectives["authoritativeFacts"][number] {
  const label = entityText === undefined ? "" : `${entityText}的`;
  const text =
    status === "pending"
      ? `目前没有${label}待确认共同安排，权威日程没有因此发生变化。`
      : status === "committed"
        ? `目前没有已确认生效的${label}共同安排。`
        : `目前没有可验证的${label}共同安排。`;
  return {
    kind: "schedule",
    text,
    requiredAnchors: [
      "没有",
      ...(entityText === undefined ? [] : [entityText]),
    ],
  };
}

function isSharedItem(item: ScheduleItem): boolean {
  return item.source === "user_invitation";
}

function scheduleEntityReferenced(entityText: string, title: string): boolean {
  const entity = comparableScheduleText(entityText);
  const candidate = comparableScheduleText(title).replace(/^和用户/u, "");
  if (entity.length >= 2 && candidate.includes(entity)) return true;
  if (candidate.length >= 2 && entity.includes(candidate)) return true;
  const anchors = entity.match(/[\p{Script=Han}a-z0-9_-]{2,}/giu) ?? [];
  return anchors.some((anchor) => candidate.includes(anchor));
}

function comparableScheduleText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, "");
}

function decisionPathFor(input: {
  scheduleOutcome: ScheduleOutcome;
  acceptedWorldEffects: ValidatedWorldEffects;
  proposalRejections: readonly SplitTurnProposalRejection[];
}): string {
  const acceptedCount =
    (input.acceptedWorldEffects.stateDelta === undefined ? 0 : 1) +
    (input.acceptedWorldEffects.relationshipDelta === undefined ? 0 : 1) +
    input.acceptedWorldEffects.memoryCandidates.length +
    input.acceptedWorldEffects.personalIntentCandidates.length +
    (input.scheduleOutcome.kind === "none" ||
    input.scheduleOutcome.kind === "read_only" ||
    input.scheduleOutcome.kind === "rejected"
      ? 0
      : 1);
  if (acceptedCount === 0 && input.proposalRejections.length === 0) {
    return "reply_only";
  }
  if (acceptedCount > 0 && input.proposalRejections.length === 0) {
    return "full";
  }
  if (acceptedCount > 0) return "partial";
  return "effects_rejected";
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
