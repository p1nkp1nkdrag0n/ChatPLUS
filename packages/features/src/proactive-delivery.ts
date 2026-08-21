export type ProactiveDeliverySubjectLike =
  | {
      kind: "activity_candidate";
      status: string;
      earliestAtUtc: string;
      expiresAtUtc: string;
      alreadyDiscussed: boolean;
    }
  | {
      kind: "follow_up";
      status: string;
      earliestAtUtc: string;
      expiresAtUtc: string;
      alreadyDiscussed: boolean;
      attemptCount: number;
      maxAttempts: 1;
    };

export type ProactivePreflightRejectionCode =
  | "tier_not_supported"
  | "policy_disabled"
  | "generation_in_progress"
  | "source_not_pending"
  | "source_expired"
  | "source_not_due"
  | "max_attempts_reached"
  | "already_discussed"
  | "quiet_hours"
  | "daily_cap_reached"
  | "relationship_below_minimum"
  | "cooldown_active"
  | "unanswered_limit_reached"
  | "active_conversation";

export type ProactivePreflightDecision =
  | { allowed: true }
  | { allowed: false; reasonCode: ProactivePreflightRejectionCode };

export interface ProactivePreflightInput {
  subject: ProactiveDeliverySubjectLike;
  nowUtc: string;
  tierSupportsProactive: boolean;
  policyEnabled: boolean;
  generationInProgress: boolean;
  quietHours: boolean;
  sentToday: number;
  dailyLimit: number;
  relationshipCloseness: number;
  minimumCloseness: number;
  cooldownUntilUtc?: string;
  unansweredCount: number;
  maximumUnanswered: number;
  activeConversation: boolean;
}

export function evaluateProactivePreflight(
  input: ProactivePreflightInput,
): ProactivePreflightDecision {
  if (!input.tierSupportsProactive) {
    return rejected("tier_not_supported");
  }
  if (!input.policyEnabled) {
    return rejected("policy_disabled");
  }
  if (input.generationInProgress) {
    return rejected("generation_in_progress");
  }
  if (input.subject.status !== "pending") {
    return rejected("source_not_pending");
  }

  const now = Date.parse(input.nowUtc);
  if (Date.parse(input.subject.expiresAtUtc) <= now) {
    return rejected("source_expired");
  }
  if (Date.parse(input.subject.earliestAtUtc) > now) {
    return rejected("source_not_due");
  }
  if (
    input.subject.kind === "follow_up" &&
    input.subject.attemptCount >= input.subject.maxAttempts
  ) {
    return rejected("max_attempts_reached");
  }
  if (input.subject.alreadyDiscussed) {
    return rejected("already_discussed");
  }
  if (input.quietHours) {
    return rejected("quiet_hours");
  }
  if (input.sentToday >= Math.max(0, input.dailyLimit)) {
    return rejected("daily_cap_reached");
  }
  if (input.relationshipCloseness < input.minimumCloseness) {
    return rejected("relationship_below_minimum");
  }
  if (
    input.cooldownUntilUtc !== undefined &&
    Date.parse(input.cooldownUntilUtc) > now
  ) {
    return rejected("cooldown_active");
  }
  if (input.unansweredCount >= Math.max(0, input.maximumUnanswered)) {
    return rejected("unanswered_limit_reached");
  }
  if (input.activeConversation) {
    return rejected("active_conversation");
  }
  return { allowed: true };
}

export type ProactivePostflightRejectionCode =
  | ProactivePreflightRejectionCode
  | "stale_generation"
  | "agent_revision_changed"
  | "user_returned"
  | "new_message_arrived"
  | "source_not_claimed";

export type ProactivePostflightDecision =
  | { allowed: true }
  | { allowed: false; reasonCode: ProactivePostflightRejectionCode };

export interface ProactivePostflightInput {
  generationMatches: boolean;
  preflightSpecVersion: number;
  currentSpecVersion: number;
  preflightStateRevision: number;
  currentStateRevision: number;
  preflightUserArrivalEpoch: number;
  currentUserArrivalEpoch: number;
  inFlightUserTurns: number;
  preflightLastUserMessageRowid: number;
  currentLastUserMessageRowid: number;
  preflightMessageRowid: number;
  currentMessageRowid: number;
  sourceStillClaimed: boolean;
  sourceExpired: boolean;
  alreadyDiscussed: boolean;
  dynamicGateFailure?: ProactivePreflightRejectionCode;
}

export function evaluateProactivePostflight(
  input: ProactivePostflightInput,
): ProactivePostflightDecision {
  if (!input.generationMatches) {
    return postflightRejected("stale_generation");
  }
  if (
    input.preflightSpecVersion !== input.currentSpecVersion ||
    input.preflightStateRevision !== input.currentStateRevision
  ) {
    return postflightRejected("agent_revision_changed");
  }
  if (
    input.currentUserArrivalEpoch !== input.preflightUserArrivalEpoch ||
    input.inFlightUserTurns > 0 ||
    input.currentLastUserMessageRowid > input.preflightLastUserMessageRowid
  ) {
    return postflightRejected("user_returned");
  }
  if (input.currentMessageRowid > input.preflightMessageRowid) {
    return postflightRejected("new_message_arrived");
  }
  if (!input.sourceStillClaimed) {
    return postflightRejected("source_not_claimed");
  }
  if (input.sourceExpired) {
    return postflightRejected("source_expired");
  }
  if (input.alreadyDiscussed) {
    return postflightRejected("already_discussed");
  }
  if (input.dynamicGateFailure !== undefined) {
    return postflightRejected(input.dynamicGateFailure);
  }
  return { allowed: true };
}

export function isProactiveDeliverySubject(
  value: unknown,
): value is ProactiveDeliverySubjectLike {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate["kind"] !== "activity_candidate" &&
    candidate["kind"] !== "follow_up"
  ) {
    return false;
  }
  if (
    typeof candidate["status"] !== "string" ||
    typeof candidate["earliestAtUtc"] !== "string" ||
    typeof candidate["expiresAtUtc"] !== "string" ||
    typeof candidate["alreadyDiscussed"] !== "boolean"
  ) {
    return false;
  }
  return (
    candidate["kind"] !== "follow_up" ||
    (typeof candidate["attemptCount"] === "number" &&
      candidate["maxAttempts"] === 1)
  );
}

function rejected(
  reasonCode: ProactivePreflightRejectionCode,
): ProactivePreflightDecision {
  return { allowed: false, reasonCode };
}

function postflightRejected(
  reasonCode: ProactivePostflightRejectionCode,
): ProactivePostflightDecision {
  return { allowed: false, reasonCode };
}
