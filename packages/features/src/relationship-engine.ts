import { clamp } from "./shared.js";

export interface RelationshipStateLike {
  userId: string;
  closeness: number;
  trust: number;
  familiarity: number;
  recentInteractionValence: number;
  lastInteractionAtUtc?: string;
}

export interface RelationshipDeltaLike {
  closeness?: number;
  trust?: number;
  familiarity?: number;
  recentInteractionValence?: number;
}

export interface RelationshipUpdateResult<T extends RelationshipStateLike> {
  state: T;
  appliedDelta: RelationshipDeltaLike;
  limited: boolean;
}

export function applyRelationshipDelta<T extends RelationshipStateLike>(
  state: T,
  delta: RelationshipDeltaLike,
  atUtc: string,
): RelationshipUpdateResult<T> {
  const limits: Required<RelationshipDeltaLike> = {
    closeness: 0.08,
    trust: 0.08,
    familiarity: 0.05,
    recentInteractionValence: 0.3,
  };
  const appliedDelta: RelationshipDeltaLike = {};
  let limited = false;

  for (const key of Object.keys(limits) as Array<keyof RelationshipDeltaLike>) {
    const requested = delta[key];
    if (requested === undefined || !Number.isFinite(requested)) continue;
    const limit = limits[key];
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
    lastInteractionAtUtc: atUtc,
  };

  return { state: next, appliedDelta, limited };
}
