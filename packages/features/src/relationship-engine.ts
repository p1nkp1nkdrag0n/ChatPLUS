import { clamp } from "./shared.js";

export interface RelationshipStateLike {
  userId: string;
  closeness: number;
  trust: number;
  familiarity: number;
  recentInteractionValence: number;
  lastInteractionAtUtc?: string | undefined;
}

export interface RelationshipDeltaLike {
  closeness?: number | undefined;
  trust?: number | undefined;
  familiarity?: number | undefined;
  recentInteractionValence?: number | undefined;
}

export interface RelationshipUpdateResult<T extends RelationshipStateLike> {
  state: T;
  appliedDelta: RelationshipDeltaLike;
  limited: boolean;
}

export const RELATIONSHIP_BASELINE_FAMILIARITY_PER_TURN = 0.001;

export const RELATIONSHIP_SINGLE_TURN_LIMITS = {
  closeness: 0.08,
  trust: 0.08,
  familiarity: 0.05,
  recentInteractionValence: 0.3,
} as const satisfies Readonly<Record<RelationshipDeltaField, number>>;

/**
 * Daily movement is deliberately much smaller than the state range. One busy
 * day can therefore matter without turning a few conversations into an
 * established relationship. The familiarity budget includes both the
 * deterministic interaction baseline and model-proposed familiarity.
 */
export const RELATIONSHIP_DAILY_LIMITS = {
  closeness: 0.04,
  trust: 0.03,
  familiarity: 0.012,
  recentInteractionValence: 0.3,
} as const satisfies Readonly<Record<RelationshipDeltaField, number>>;

/**
 * Recent interaction valence is a short-lived signal: after two days without
 * an interaction, half of the prior signal remains. A new proposal contributes
 * as an observation through an EMA instead of being permanently accumulated.
 */
export const RECENT_INTERACTION_VALENCE_HALF_LIFE_HOURS = 48;
export const RECENT_INTERACTION_VALENCE_NEW_SIGNAL_WEIGHT = 0.35;

export type RelationshipDeltaField = keyof RelationshipDeltaLike;

export type RelationshipDailyUsage = Partial<
  Record<RelationshipDeltaField, number>
>;

export type RelationshipDailyUsageSnapshot = Record<
  RelationshipDeltaField,
  number
>;

export type RelationshipLimitStage =
  "single_turn" | "capability_scale" | "daily_cap" | "state_boundary";

export interface RelationshipLimitApplication {
  field: RelationshipDeltaField;
  source: "baseline" | "proposal";
  stage: RelationshipLimitStage;
  requested: number;
  applied: number;
  limit: number;
}

export interface RecentInteractionValenceTrace {
  before: number;
  elapsedHours: number;
  decayFactor: number;
  decayed: number;
  proposedSignal?: number;
  blendWeight: number;
  requestedMovement: number;
  acceptedMovement: number;
  appliedMovement: number;
  after: number;
}

export interface RelationshipInteractionInput<
  T extends RelationshipStateLike = RelationshipStateLike,
> {
  state: T;
  atUtc: string;
  capabilityScale: number;
  proposal?: RelationshipDeltaLike;
  dailyUsage?: RelationshipDailyUsage;
  /** False for non-chat causes such as a settled shared activity. */
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
  valence: RecentInteractionValenceTrace;
}

const RELATIONSHIP_DELTA_FIELDS = [
  "closeness",
  "trust",
  "familiarity",
  "recentInteractionValence",
] as const satisfies readonly RelationshipDeltaField[];

const MILLISECONDS_PER_HOUR = 60 * 60 * 1_000;

/**
 * Applies the deterministic and model-proposed relationship consequences of
 * one successful, non-replayed user-character turn. This function is pure;
 * callers own daily-usage persistence and the surrounding database transaction.
 */
export function applyRelationshipInteraction<T extends RelationshipStateLike>(
  input: RelationshipInteractionInput<T>,
): RelationshipInteractionResult<T> {
  const before = { ...input.state };
  const after = { ...input.state };
  const limitsApplied: RelationshipLimitApplication[] = [];
  const proposedDelta = finiteDelta(input.proposal);
  const acceptedProposalDelta: RelationshipDeltaLike = {};
  const appliedProposalDelta: RelationshipDeltaLike = {};
  const appliedDelta: RelationshipDeltaLike = {};
  const dailyUsageAfter = normalizeDailyUsage(input.dailyUsage);
  const capabilityScale = clampFinite(input.capabilityScale, 0, 1, 0);
  const effectiveAtUtc = monotonicUtc(
    input.state.lastInteractionAtUtc,
    input.atUtc,
  );

  const baselineRequested =
    input.includeInteractionBaseline === false
      ? 0
      : RELATIONSHIP_BASELINE_FAMILIARITY_PER_TURN;
  const baselineScaled = applyCapabilityScale(
    "familiarity",
    "baseline",
    baselineRequested,
    capabilityScale,
    limitsApplied,
  );
  const baselineAccepted = applyDailyLimit(
    "familiarity",
    "baseline",
    baselineScaled,
    dailyUsageAfter,
    limitsApplied,
  );
  const baselineApplied = applyStateBoundary(
    "familiarity",
    "baseline",
    after.familiarity,
    baselineAccepted,
    limitsApplied,
  );
  after.familiarity = clamp(after.familiarity + baselineApplied);
  dailyUsageAfter.familiarity += Math.abs(baselineApplied);
  const baselineDelta: RelationshipDeltaLike = {
    familiarity: baselineApplied,
  };

  for (const field of ["closeness", "trust", "familiarity"] as const) {
    const proposed = proposedDelta[field];
    if (proposed === undefined) continue;
    const turnLimited = applySingleTurnLimit(field, proposed, limitsApplied);
    const scaled = applyCapabilityScale(
      field,
      "proposal",
      turnLimited,
      capabilityScale,
      limitsApplied,
    );
    const dailyLimited = applyDailyLimit(
      field,
      "proposal",
      scaled,
      dailyUsageAfter,
      limitsApplied,
    );
    acceptedProposalDelta[field] = dailyLimited;
    const current = after[field];
    const applied = applyStateBoundary(
      field,
      "proposal",
      current,
      dailyLimited,
      limitsApplied,
    );
    after[field] = clamp(current + applied);
    appliedProposalDelta[field] = applied;
    dailyUsageAfter[field] += Math.abs(applied);
  }

  const previousAtUtc = input.state.lastInteractionAtUtc;
  const elapsedHours = elapsedHoursBetween(previousAtUtc, effectiveAtUtc);
  const decayFactor = Math.pow(
    0.5,
    elapsedHours / RECENT_INTERACTION_VALENCE_HALF_LIFE_HOURS,
  );
  const valenceBefore = clamp(input.state.recentInteractionValence, -1, 1);
  const decayedValence = clamp(valenceBefore * decayFactor, -1, 1);
  after.recentInteractionValence = decayedValence;

  const proposedValence = proposedDelta.recentInteractionValence;
  let acceptedValenceMovement = 0;
  let appliedValenceMovement = 0;
  let requestedValenceMovement = 0;
  let proposedSignal: number | undefined;
  const blendWeight =
    RECENT_INTERACTION_VALENCE_NEW_SIGNAL_WEIGHT * capabilityScale;
  if (proposedValence !== undefined) {
    proposedSignal = applySingleTurnLimit(
      "recentInteractionValence",
      proposedValence,
      limitsApplied,
    );
    const unscaledMovement =
      (proposedSignal - decayedValence) *
      RECENT_INTERACTION_VALENCE_NEW_SIGNAL_WEIGHT;
    const scaledMovement = (proposedSignal - decayedValence) * blendWeight;
    requestedValenceMovement = scaledMovement;
    recordLimit(
      limitsApplied,
      "recentInteractionValence",
      "proposal",
      "capability_scale",
      unscaledMovement,
      scaledMovement,
      capabilityScale,
    );
    acceptedValenceMovement = applyDailyLimit(
      "recentInteractionValence",
      "proposal",
      scaledMovement,
      dailyUsageAfter,
      limitsApplied,
    );
    acceptedProposalDelta.recentInteractionValence = acceptedValenceMovement;
    appliedValenceMovement = applyStateBoundary(
      "recentInteractionValence",
      "proposal",
      decayedValence,
      acceptedValenceMovement,
      limitsApplied,
    );
    after.recentInteractionValence = clamp(
      decayedValence + appliedValenceMovement,
      -1,
      1,
    );
    appliedProposalDelta.recentInteractionValence = appliedValenceMovement;
    dailyUsageAfter.recentInteractionValence += Math.abs(
      appliedValenceMovement,
    );
  }

  after.lastInteractionAtUtc = effectiveAtUtc;
  for (const field of RELATIONSHIP_DELTA_FIELDS) {
    const difference = stableRelationshipNumber(after[field] - before[field]);
    if (difference !== 0) appliedDelta[field] = difference;
  }

  const valence: RecentInteractionValenceTrace = {
    before: valenceBefore,
    elapsedHours,
    decayFactor,
    decayed: decayedValence,
    ...(proposedSignal === undefined ? {} : { proposedSignal }),
    blendWeight,
    requestedMovement: requestedValenceMovement,
    acceptedMovement: acceptedValenceMovement,
    appliedMovement: appliedValenceMovement,
    after: after.recentInteractionValence,
  };

  return {
    before,
    after,
    baselineDelta,
    proposedDelta,
    acceptedProposalDelta,
    appliedProposalDelta,
    appliedDelta,
    dailyUsageAfter,
    limitsApplied,
    valence,
  };
}

export function decayRecentInteractionValence(
  value: number,
  fromUtc: string | undefined,
  toUtc: string,
): number {
  const elapsedHours = elapsedHoursBetween(
    fromUtc,
    monotonicUtc(fromUtc, toUtc),
  );
  return clamp(
    clamp(value, -1, 1) *
      Math.pow(0.5, elapsedHours / RECENT_INTERACTION_VALENCE_HALF_LIFE_HOURS),
    -1,
    1,
  );
}

export function applyRelationshipDelta<T extends RelationshipStateLike>(
  state: T,
  delta: RelationshipDeltaLike,
  atUtc: string,
): RelationshipUpdateResult<T> {
  const appliedDelta: RelationshipDeltaLike = {};
  let limited = false;

  for (const key of RELATIONSHIP_DELTA_FIELDS) {
    const requested = delta[key];
    if (requested === undefined || !Number.isFinite(requested)) continue;
    const limit = RELATIONSHIP_SINGLE_TURN_LIMITS[key];
    let applied = clamp(requested, -limit, limit);
    if (key === "familiarity") applied = Math.max(0, applied);
    appliedDelta[key] = applied;
    limited ||= applied !== requested;
  }

  const next = {
    ...state,
    closeness: clamp(state.closeness + (appliedDelta.closeness ?? 0)),
    trust: clamp(state.trust + (appliedDelta.trust ?? 0)),
    familiarity: clamp(state.familiarity + (appliedDelta.familiarity ?? 0)),
    recentInteractionValence: clamp(
      state.recentInteractionValence +
        (appliedDelta.recentInteractionValence ?? 0),
      -1,
      1,
    ),
    lastInteractionAtUtc: monotonicUtc(state.lastInteractionAtUtc, atUtc),
  };

  return { state: next, appliedDelta, limited };
}

function finiteDelta(
  delta: RelationshipDeltaLike | undefined,
): RelationshipDeltaLike {
  const finite: RelationshipDeltaLike = {};
  if (delta === undefined) return finite;
  for (const field of RELATIONSHIP_DELTA_FIELDS) {
    const value = delta[field];
    if (value !== undefined && Number.isFinite(value)) finite[field] = value;
  }
  return finite;
}

function normalizeDailyUsage(
  usage: RelationshipDailyUsage | undefined,
): RelationshipDailyUsageSnapshot {
  return {
    closeness: nonnegativeFinite(usage?.closeness),
    trust: nonnegativeFinite(usage?.trust),
    familiarity: nonnegativeFinite(usage?.familiarity),
    recentInteractionValence: nonnegativeFinite(
      usage?.recentInteractionValence,
    ),
  };
}

function nonnegativeFinite(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function applySingleTurnLimit(
  field: RelationshipDeltaField,
  requested: number,
  limitsApplied: RelationshipLimitApplication[],
): number {
  const limit = RELATIONSHIP_SINGLE_TURN_LIMITS[field];
  const lower = field === "familiarity" ? 0 : -limit;
  const applied = clamp(requested, lower, limit);
  recordLimit(
    limitsApplied,
    field,
    "proposal",
    "single_turn",
    requested,
    applied,
    limit,
  );
  return applied;
}

function applyCapabilityScale(
  field: RelationshipDeltaField,
  source: "baseline" | "proposal",
  requested: number,
  scale: number,
  limitsApplied: RelationshipLimitApplication[],
): number {
  const applied = requested * scale;
  recordLimit(
    limitsApplied,
    field,
    source,
    "capability_scale",
    requested,
    applied,
    scale,
  );
  return applied;
}

function applyDailyLimit(
  field: RelationshipDeltaField,
  source: "baseline" | "proposal",
  requested: number,
  usage: RelationshipDailyUsageSnapshot,
  limitsApplied: RelationshipLimitApplication[],
): number {
  const dailyLimit = RELATIONSHIP_DAILY_LIMITS[field];
  const remaining = Math.max(0, dailyLimit - usage[field]);
  const applied =
    Math.sign(requested) * Math.min(Math.abs(requested), remaining);
  recordLimit(
    limitsApplied,
    field,
    source,
    "daily_cap",
    requested,
    applied,
    remaining,
  );
  return applied;
}

function applyStateBoundary(
  field: RelationshipDeltaField,
  source: "baseline" | "proposal",
  current: number,
  requested: number,
  limitsApplied: RelationshipLimitApplication[],
): number {
  const minimum = field === "recentInteractionValence" ? -1 : 0;
  const next = clamp(current + requested, minimum, 1);
  const applied = stableRelationshipNumber(next - current);
  recordLimit(
    limitsApplied,
    field,
    source,
    "state_boundary",
    requested,
    applied,
    requested >= 0 ? 1 - current : current - minimum,
  );
  return applied;
}

function recordLimit(
  output: RelationshipLimitApplication[],
  field: RelationshipDeltaField,
  source: "baseline" | "proposal",
  stage: RelationshipLimitStage,
  requested: number,
  applied: number,
  limit: number,
): void {
  if (Math.abs(requested - applied) <= 1e-12) return;
  output.push({ field, source, stage, requested, applied, limit });
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
  const requestedMillis = utcMillis(requestedUtc);
  if (requestedMillis === undefined) {
    throw new RangeError(`Invalid interaction timestamp: ${requestedUtc}`);
  }
  if (previousUtc === undefined) return requestedUtc;
  const previousMillis = utcMillis(previousUtc);
  if (previousMillis === undefined) {
    throw new RangeError(
      `Invalid previous interaction timestamp: ${previousUtc}`,
    );
  }
  return requestedMillis < previousMillis ? previousUtc : requestedUtc;
}

function elapsedHoursBetween(
  fromUtc: string | undefined,
  toUtc: string,
): number {
  if (fromUtc === undefined) return 0;
  const fromMillis = utcMillis(fromUtc);
  const toMillis = utcMillis(toUtc);
  if (fromMillis === undefined || toMillis === undefined) return 0;
  return Math.max(0, toMillis - fromMillis) / MILLISECONDS_PER_HOUR;
}

function utcMillis(value: string): number | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function stableRelationshipNumber(value: number): number {
  return Number(value.toFixed(12));
}
