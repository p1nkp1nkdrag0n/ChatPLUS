import { clamp } from "./shared.js";

export interface RelationshipStateLike {
  userId: string;
  closeness: number;
  lastInteractionAtUtc?: string | undefined;
}
export interface RelationshipDeltaLike {
  closeness?: number | undefined;
}
export interface RelationshipUpdateResult<T extends RelationshipStateLike> {
  state: T;
  appliedDelta: RelationshipDeltaLike;
  limited: boolean;
}

export const RELATIONSHIP_BASELINE_CLOSENESS_PER_TURN = 0.001;
export const RELATIONSHIP_BASELINE_DAILY_LIMIT = 0.012;
export const RELATIONSHIP_SINGLE_TURN_LIMITS = { closeness: 0.08 } as const;
export const RELATIONSHIP_DAILY_LIMITS = { closeness: 0.04 } as const;
export type RelationshipDeltaField = keyof RelationshipDeltaLike;

/**
 * One local day's budget, reconstructed from committed events. closeness is
 * signed net movement, bounded to +/-0.04 by both chat and shared activities.
 * baselineCloseness is cumulative awarded baseline, never refunded by a
 * negative event or repair. It is budget metadata, not a relationship axis.
 */
export interface RelationshipDailyUsage {
  closeness?: number;
  baselineCloseness?: number;
}
export interface RelationshipDailyUsageSnapshot {
  closeness: number;
  baselineCloseness: number;
}
export type RelationshipLimitStage =
  | "single_turn"
  | "capability_scale"
  | "baseline_daily_cap"
  | "daily_cap"
  | "state_boundary";
export interface RelationshipLimitApplication {
  field: RelationshipDeltaField;
  source: "baseline" | "proposal";
  stage: RelationshipLimitStage;
  requested: number;
  applied: number;
  limit: number;
}
export interface RelationshipInteractionInput<
  T extends RelationshipStateLike = RelationshipStateLike,
> {
  state: T;
  atUtc: string;
  capabilityScale: number;
  proposal?: RelationshipDeltaLike;
  dailyUsage?: RelationshipDailyUsage;
  /** Caller must affirm a successful, eligible, non-replayed chat interaction. */
  includeInteractionBaseline?: boolean;
}
export interface RelationshipInteractionResult<
  T extends RelationshipStateLike = RelationshipStateLike,
> {
  before: T;
  after: T;
  baselineDelta: RelationshipDeltaLike;
  proposedDelta: RelationshipDeltaLike;
  acceptedProposalDelta: RelationshipDeltaLike;
  appliedProposalDelta: RelationshipDeltaLike;
  appliedDelta: RelationshipDeltaLike;
  dailyUsageAfter: RelationshipDailyUsageSnapshot;
  limitsApplied: RelationshipLimitApplication[];
}

/** Pure consequences; callers persist the trace and state in one transaction. */
export function applyRelationshipInteraction<T extends RelationshipStateLike>(
  input: RelationshipInteractionInput<T>,
): RelationshipInteractionResult<T> {
  const before = { ...input.state };
  const after = { ...input.state };
  const limitsApplied: RelationshipLimitApplication[] = [];
  const proposedDelta = finiteDelta(input.proposal);
  const acceptedProposalDelta: RelationshipDeltaLike = {};
  const appliedProposalDelta: RelationshipDeltaLike = {};
  const dailyUsageAfter = normalizeDailyUsage(input.dailyUsage);
  const capabilityScale = clampFinite(input.capabilityScale, 0, 1, 0);
  const effectiveAtUtc = monotonicUtc(
    input.state.lastInteractionAtUtc,
    input.atUtc,
  );

  let baseline =
    input.includeInteractionBaseline === true
      ? RELATIONSHIP_BASELINE_CLOSENESS_PER_TURN
      : 0;
  baseline = limit(
    "baseline",
    "capability_scale",
    baseline,
    baseline * capabilityScale,
    capabilityScale,
    limitsApplied,
  );
  const baselineRemaining = Math.max(
    0,
    RELATIONSHIP_BASELINE_DAILY_LIMIT - dailyUsageAfter.baselineCloseness,
  );
  baseline = limit(
    "baseline",
    "baseline_daily_cap",
    baseline,
    Math.min(baseline, baselineRemaining),
    baselineRemaining,
    limitsApplied,
  );
  baseline = applyDailyLimit(
    "baseline",
    baseline,
    dailyUsageAfter,
    limitsApplied,
  );
  const baselineApplied = applyStateBoundary(
    "baseline",
    after.closeness,
    baseline,
    limitsApplied,
  );
  after.closeness = stableNumber(clamp(after.closeness + baselineApplied));
  dailyUsageAfter.closeness = stableNumber(
    dailyUsageAfter.closeness + baselineApplied,
  );
  dailyUsageAfter.baselineCloseness = stableNumber(
    dailyUsageAfter.baselineCloseness + baselineApplied,
  );
  const baselineDelta = { closeness: baselineApplied };

  if (proposedDelta.closeness !== undefined) {
    let proposed = proposedDelta.closeness;
    proposed = limit(
      "proposal",
      "single_turn",
      proposed,
      clamp(
        proposed,
        -RELATIONSHIP_SINGLE_TURN_LIMITS.closeness,
        RELATIONSHIP_SINGLE_TURN_LIMITS.closeness,
      ),
      RELATIONSHIP_SINGLE_TURN_LIMITS.closeness,
      limitsApplied,
    );
    proposed = limit(
      "proposal",
      "capability_scale",
      proposed,
      proposed * capabilityScale,
      capabilityScale,
      limitsApplied,
    );
    const accepted = applyDailyLimit(
      "proposal",
      proposed,
      dailyUsageAfter,
      limitsApplied,
    );
    acceptedProposalDelta.closeness = accepted;
    const applied = applyStateBoundary(
      "proposal",
      after.closeness,
      accepted,
      limitsApplied,
    );
    appliedProposalDelta.closeness = applied;
    after.closeness = stableNumber(clamp(after.closeness + applied));
    dailyUsageAfter.closeness = stableNumber(
      dailyUsageAfter.closeness + applied,
    );
  }

  after.lastInteractionAtUtc = effectiveAtUtc;
  const movement = stableNumber(after.closeness - before.closeness);
  return {
    before,
    after,
    baselineDelta,
    proposedDelta,
    acceptedProposalDelta,
    appliedProposalDelta,
    appliedDelta: movement === 0 ? {} : { closeness: movement },
    dailyUsageAfter,
    limitsApplied,
  };
}

/** Validate a model proposal's single-turn magnitude without awarding baseline. */
export function applyRelationshipDelta<T extends RelationshipStateLike>(
  state: T,
  delta: RelationshipDeltaLike,
  atUtc: string,
): RelationshipUpdateResult<T> {
  const requested = finiteDelta(delta).closeness;
  const accepted =
    requested === undefined
      ? undefined
      : clamp(
          requested,
          -RELATIONSHIP_SINGLE_TURN_LIMITS.closeness,
          RELATIONSHIP_SINGLE_TURN_LIMITS.closeness,
        );
  return {
    state: {
      ...state,
      closeness: stableNumber(clamp(state.closeness + (accepted ?? 0))),
      lastInteractionAtUtc: monotonicUtc(state.lastInteractionAtUtc, atUtc),
    },
    appliedDelta: accepted === undefined ? {} : { closeness: accepted },
    limited: accepted !== requested,
  };
}

function finiteDelta(
  delta: RelationshipDeltaLike | undefined,
): RelationshipDeltaLike {
  const value = delta?.closeness;
  return value !== undefined && Number.isFinite(value)
    ? { closeness: value }
    : {};
}
function normalizeDailyUsage(
  usage: RelationshipDailyUsage | undefined,
): RelationshipDailyUsageSnapshot {
  return {
    closeness: finiteNumber(usage?.closeness),
    baselineCloseness: Math.max(0, finiteNumber(usage?.baselineCloseness)),
  };
}
function applyDailyLimit(
  source: RelationshipLimitApplication["source"],
  requested: number,
  usage: RelationshipDailyUsageSnapshot,
  limits: RelationshipLimitApplication[],
): number {
  const available = Math.max(
    0,
    RELATIONSHIP_DAILY_LIMITS.closeness -
      Math.sign(requested) * usage.closeness,
  );
  const applied = stableNumber(
    Math.sign(requested) * Math.min(Math.abs(requested), available),
  );
  return limit(source, "daily_cap", requested, applied, available, limits);
}
function applyStateBoundary(
  source: RelationshipLimitApplication["source"],
  current: number,
  requested: number,
  limits: RelationshipLimitApplication[],
): number {
  const applied = stableNumber(clamp(current + requested) - current);
  return limit(
    source,
    "state_boundary",
    requested,
    applied,
    requested >= 0 ? 1 - current : current,
    limits,
  );
}
function limit(
  source: RelationshipLimitApplication["source"],
  stage: RelationshipLimitStage,
  requested: number,
  applied: number,
  maximum: number,
  output: RelationshipLimitApplication[],
): number {
  if (Math.abs(requested - applied) > 1e-12)
    output.push({
      field: "closeness",
      source,
      stage,
      requested,
      applied,
      limit: maximum,
    });
  return applied;
}
function finiteNumber(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}
function clampFinite(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isFinite(value) ? clamp(value, minimum, maximum) : fallback;
}
function monotonicUtc(
  previousUtc: string | undefined,
  requestedUtc: string,
): string {
  const requestedMillis = Date.parse(requestedUtc);
  if (!Number.isFinite(requestedMillis))
    throw new RangeError(`Invalid interaction timestamp: ${requestedUtc}`);
  if (previousUtc === undefined) return requestedUtc;
  const previousMillis = Date.parse(previousUtc);
  if (!Number.isFinite(previousMillis))
    throw new RangeError(
      `Invalid previous interaction timestamp: ${previousUtc}`,
    );
  return requestedMillis < previousMillis ? previousUtc : requestedUtc;
}
function stableNumber(value: number): number {
  return Number(value.toFixed(12));
}
