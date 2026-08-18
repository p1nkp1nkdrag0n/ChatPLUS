export const SCHEDULE_NEGOTIATION_STATUSES = [
  "collecting_details",
  "awaiting_confirmation",
  "committed",
  "declined",
  "withdrawn",
  "expired",
  "conflicted",
] as const;

export type ScheduleNegotiationStatus =
  (typeof SCHEDULE_NEGOTIATION_STATUSES)[number];

const TERMINAL_STATUSES = new Set<ScheduleNegotiationStatus>([
  "committed",
  "declined",
  "withdrawn",
  "expired",
  "conflicted",
]);

/**
 * Server-canonical create terms. In particular, callers must resolve the
 * instant and supply any category-based duration default before reducing.
 */
export interface CanonicalScheduleOffer {
  operation: "create";
  activity: string;
  category: string;
  startAtUtc: string;
  durationMinutes: number;
  timezone: string;
}

export interface VersionedScheduleOffer extends CanonicalScheduleOffer {
  version: number;
  offeredAtUtc: string;
  validUntilUtc?: string;
  evidenceIds: readonly string[];
}

export type PartialScheduleOfferDetails = Partial<
  Omit<CanonicalScheduleOffer, "operation">
>;

export interface ScheduleNegotiation {
  id: string;
  status: ScheduleNegotiationStatus;
  /** Highest version ever issued, including a superseded offer. */
  offerVersion: number;
  details: PartialScheduleOfferDetails;
  offer?: VersionedScheduleOffer;
  evidenceIds: readonly string[];
  terminalReasonCode?: string;
  createdAtUtc: string;
  updatedAtUtc: string;
}

/** Evidence for the action currently being reduced; it is never parsed. */
export interface CurrentScheduleNegotiationEvidence {
  evidenceId: string;
  observedAtUtc: string;
}

/**
 * A persisted negotiation snapshot from the same conversation/session.
 * Callers scope the window; the reducer uses only structured lifecycle data.
 */
export interface RecentScheduleNegotiationEvidence {
  evidenceId: string;
  negotiationId: string;
  observedAtUtc: string;
  status: ScheduleNegotiationStatus;
  offerVersion: number;
  offerValidUntilUtc?: string;
}

export interface ScheduleNegotiationEvidenceWindow {
  current: CurrentScheduleNegotiationEvidence;
  recent?: readonly RecentScheduleNegotiationEvidence[];
}

export type ScheduleNegotiationAction =
  | {
      type: "collect_details";
      details: PartialScheduleOfferDetails;
    }
  | {
      type: "present_offer";
      offer: CanonicalScheduleOffer;
      validUntilUtc?: string;
      supportingEvidenceIds?: readonly string[];
    }
  | {
      type: "accept_pending";
      /** Optional when a short confirmation refers to the sole pending offer. */
      offerVersion?: number;
    }
  | { type: "decline"; reasonCode?: string }
  | { type: "withdraw"; reasonCode?: string }
  | { type: "expire"; reasonCode?: string }
  | { type: "mark_conflicted"; reasonCode: string };

export type ScheduleNegotiationTransitionReason =
  | "details_collected"
  | "offer_presented"
  | "offer_accepted"
  | "declined"
  | "withdrawn"
  | "expired"
  | "conflicted"
  | "offer_expired"
  | "terminal_state"
  | "invalid_evidence"
  | "invalid_offer"
  | "invalid_action_for_status"
  | "missing_pending_offer"
  | "confirmation_not_subsequent"
  | "stale_offer_version"
  | "ambiguous_pending_offer";

export interface ScheduleNegotiationTransition {
  action: ScheduleNegotiationAction["type"];
  fromStatus: ScheduleNegotiationStatus;
  toStatus: ScheduleNegotiationStatus;
  applied: boolean;
  reason: ScheduleNegotiationTransitionReason;
  occurredAtUtc: string;
  evidenceIds: readonly string[];
  offerVersion?: number;
}

export interface ScheduleNegotiationReduction {
  state: ScheduleNegotiation;
  transition: ScheduleNegotiationTransition;
  readyToCommit: boolean;
  offerToCommit?: VersionedScheduleOffer;
}

export interface CreateScheduleNegotiationInput {
  negotiationId: string;
  evidence: CurrentScheduleNegotiationEvidence;
  details?: PartialScheduleOfferDetails;
}

export interface ReduceScheduleNegotiationInput {
  state: ScheduleNegotiation;
  action: ScheduleNegotiationAction;
  evidence: ScheduleNegotiationEvidenceWindow;
}

function isValidInstant(value: string): boolean {
  return value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function isCanonicalOffer(value: CanonicalScheduleOffer): boolean {
  return (
    value.operation === "create" &&
    value.activity.trim().length > 0 &&
    value.category.trim().length > 0 &&
    isValidInstant(value.startAtUtc) &&
    Number.isInteger(value.durationMinutes) &&
    value.durationMinutes > 0 &&
    value.timezone.trim().length > 0
  );
}

function isTerminal(status: ScheduleNegotiationStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function unchanged(
  state: ScheduleNegotiation,
  action: ScheduleNegotiationAction,
  evidence: CurrentScheduleNegotiationEvidence,
  reason: ScheduleNegotiationTransitionReason,
): ScheduleNegotiationReduction {
  return {
    state,
    transition: {
      action: action.type,
      fromStatus: state.status,
      toStatus: state.status,
      applied: false,
      reason,
      occurredAtUtc: isValidInstant(evidence.observedAtUtc)
        ? evidence.observedAtUtc
        : state.updatedAtUtc,
      evidenceIds: unique([evidence.evidenceId]),
      ...(state.offer === undefined
        ? {}
        : { offerVersion: state.offer.version }),
    },
    readyToCommit: false,
  };
}

function applied(
  previous: ScheduleNegotiation,
  state: ScheduleNegotiation,
  action: ScheduleNegotiationAction,
  evidenceIds: readonly string[],
  reason: ScheduleNegotiationTransitionReason,
  offerToCommit?: VersionedScheduleOffer,
): ScheduleNegotiationReduction {
  return {
    state,
    transition: {
      action: action.type,
      fromStatus: previous.status,
      toStatus: state.status,
      applied: true,
      reason,
      occurredAtUtc: state.updatedAtUtc,
      evidenceIds: unique(evidenceIds),
      ...(state.offer === undefined
        ? {}
        : { offerVersion: state.offer.version }),
    },
    readyToCommit: offerToCommit !== undefined,
    ...(offerToCommit === undefined ? {} : { offerToCommit }),
  };
}

function pendingEvidenceCount(
  state: ScheduleNegotiation,
  recent: readonly RecentScheduleNegotiationEvidence[],
  atUtc: string,
): number {
  const latestByNegotiation = new Map<
    string,
    { evidence: RecentScheduleNegotiationEvidence; index: number }
  >();

  recent.forEach((evidence, index) => {
    if (
      evidence.negotiationId === state.id ||
      !isValidInstant(evidence.observedAtUtc)
    ) {
      return;
    }
    const previous = latestByNegotiation.get(evidence.negotiationId);
    if (
      previous === undefined ||
      Date.parse(evidence.observedAtUtc) >
        Date.parse(previous.evidence.observedAtUtc) ||
      (evidence.observedAtUtc === previous.evidence.observedAtUtc &&
        index > previous.index)
    ) {
      latestByNegotiation.set(evidence.negotiationId, { evidence, index });
    }
  });

  let count = 1;
  for (const { evidence } of latestByNegotiation.values()) {
    if (
      evidence.status !== "awaiting_confirmation" ||
      !Number.isInteger(evidence.offerVersion) ||
      evidence.offerVersion < 1
    ) {
      continue;
    }
    if (evidence.offerValidUntilUtc !== undefined) {
      if (
        !isValidInstant(evidence.offerValidUntilUtc) ||
        Date.parse(evidence.offerValidUntilUtc) <= Date.parse(atUtc)
      ) {
        continue;
      }
    }
    count += 1;
  }
  return count;
}

export function createScheduleNegotiation(
  input: CreateScheduleNegotiationInput,
): ScheduleNegotiation {
  if (
    input.negotiationId.trim().length === 0 ||
    input.evidence.evidenceId.trim().length === 0 ||
    !isValidInstant(input.evidence.observedAtUtc)
  ) {
    throw new Error(
      "A negotiation requires valid identifiers and evidence time",
    );
  }

  return {
    id: input.negotiationId,
    status: "collecting_details",
    offerVersion: 0,
    details: { ...input.details },
    evidenceIds: [input.evidence.evidenceId],
    createdAtUtc: input.evidence.observedAtUtc,
    updatedAtUtc: input.evidence.observedAtUtc,
  };
}

/**
 * Pure create-only negotiation reducer. It consumes already-structured action
 * and lifecycle evidence; natural-language replies are deliberately absent.
 */
export function reduceScheduleNegotiation(
  input: ReduceScheduleNegotiationInput,
): ScheduleNegotiationReduction {
  const { state, action } = input;
  const { current, recent = [] } = input.evidence;

  if (
    current.evidenceId.trim().length === 0 ||
    !isValidInstant(current.observedAtUtc)
  ) {
    return unchanged(state, action, current, "invalid_evidence");
  }
  if (isTerminal(state.status)) {
    return unchanged(state, action, current, "terminal_state");
  }

  const nextEvidenceIds = unique([...state.evidenceIds, current.evidenceId]);

  switch (action.type) {
    case "collect_details": {
      const nextState: ScheduleNegotiation = {
        ...state,
        status: "collecting_details",
        details: { ...state.details, ...action.details },
        evidenceIds: nextEvidenceIds,
        updatedAtUtc: current.observedAtUtc,
      };
      delete nextState.offer;
      return applied(
        state,
        nextState,
        action,
        [current.evidenceId],
        "details_collected",
      );
    }

    case "present_offer": {
      if (!isCanonicalOffer(action.offer)) {
        return unchanged(state, action, current, "invalid_offer");
      }
      if (
        action.validUntilUtc !== undefined &&
        (!isValidInstant(action.validUntilUtc) ||
          Date.parse(action.validUntilUtc) <= Date.parse(current.observedAtUtc))
      ) {
        return unchanged(state, action, current, "invalid_offer");
      }

      const version = state.offerVersion + 1;
      const offerEvidenceIds = unique([
        current.evidenceId,
        ...(action.supportingEvidenceIds ?? []),
      ]);
      const offer: VersionedScheduleOffer = {
        ...action.offer,
        version,
        offeredAtUtc: current.observedAtUtc,
        ...(action.validUntilUtc === undefined
          ? {}
          : { validUntilUtc: action.validUntilUtc }),
        evidenceIds: offerEvidenceIds,
      };
      const nextState: ScheduleNegotiation = {
        ...state,
        status: "awaiting_confirmation",
        offerVersion: version,
        details: {
          activity: offer.activity,
          category: offer.category,
          startAtUtc: offer.startAtUtc,
          durationMinutes: offer.durationMinutes,
          timezone: offer.timezone,
        },
        offer,
        evidenceIds: unique([...nextEvidenceIds, ...offerEvidenceIds]),
        updatedAtUtc: current.observedAtUtc,
      };
      return applied(
        state,
        nextState,
        action,
        offerEvidenceIds,
        "offer_presented",
      );
    }

    case "accept_pending": {
      if (
        state.status !== "awaiting_confirmation" ||
        state.offer === undefined
      ) {
        return unchanged(state, action, current, "missing_pending_offer");
      }
      if (state.offer.evidenceIds.includes(current.evidenceId)) {
        return unchanged(state, action, current, "confirmation_not_subsequent");
      }
      if (
        action.offerVersion !== undefined &&
        action.offerVersion !== state.offer.version
      ) {
        return unchanged(state, action, current, "stale_offer_version");
      }
      if (
        state.offer.validUntilUtc !== undefined &&
        Date.parse(state.offer.validUntilUtc) <=
          Date.parse(current.observedAtUtc)
      ) {
        const nextState: ScheduleNegotiation = {
          ...state,
          status: "expired",
          evidenceIds: nextEvidenceIds,
          terminalReasonCode: "offer_expired",
          updatedAtUtc: current.observedAtUtc,
        };
        return applied(
          state,
          nextState,
          action,
          [current.evidenceId],
          "offer_expired",
        );
      }
      if (pendingEvidenceCount(state, recent, current.observedAtUtc) !== 1) {
        return unchanged(state, action, current, "ambiguous_pending_offer");
      }

      const nextState: ScheduleNegotiation = {
        ...state,
        status: "committed",
        evidenceIds: nextEvidenceIds,
        updatedAtUtc: current.observedAtUtc,
      };
      return applied(
        state,
        nextState,
        action,
        [state.offer.evidenceIds.at(-1) ?? "", current.evidenceId],
        "offer_accepted",
        state.offer,
      );
    }

    case "decline":
    case "withdraw":
    case "expire":
    case "mark_conflicted": {
      const status =
        action.type === "decline"
          ? "declined"
          : action.type === "withdraw"
            ? "withdrawn"
            : action.type === "expire"
              ? "expired"
              : "conflicted";
      const reason = action.type === "mark_conflicted" ? "conflicted" : status;
      const nextState: ScheduleNegotiation = {
        ...state,
        status,
        evidenceIds: nextEvidenceIds,
        terminalReasonCode: action.reasonCode ?? reason,
        updatedAtUtc: current.observedAtUtc,
      };
      return applied(state, nextState, action, [current.evidenceId], reason);
    }

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}
