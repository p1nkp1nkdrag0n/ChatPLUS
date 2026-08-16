import { clamp } from "./shared.js";
import type { RelationshipStateLike } from "./relationship-engine.js";

export interface StateDeltaLike {
  moodValence?: number;
  moodArousal?: number;
  energy?: number;
  stress?: number;
  socialBattery?: number;
  focus?: number;
}

export interface RuntimeStateLike {
  agentId: string;
  asOfUtc: string;
  moodValence: number;
  moodArousal: number;
  energy: number;
  stress: number;
  socialBattery: number;
  focus: number;
  currentActivityId?: string;
  locationContext?: string;
  relationship?: RelationshipStateLike;
  revision: number;
}

const STATE_KEYS = [
  "moodValence",
  "moodArousal",
  "energy",
  "stress",
  "socialBattery",
  "focus",
] as const;

export function clampStateDelta(delta: StateDeltaLike): StateDeltaLike {
  const result: StateDeltaLike = {};
  for (const key of STATE_KEYS) {
    const value = delta[key];
    if (value !== undefined && Number.isFinite(value)) {
      // A single domain mutation cannot completely flip state.
      result[key] = clamp(value, -0.5, 0.5);
    }
  }
  return result;
}

export function combineStateDeltas(
  deltas: readonly StateDeltaLike[],
): StateDeltaLike {
  const result: StateDeltaLike = {};
  for (const delta of deltas) {
    for (const key of STATE_KEYS) {
      const value = delta[key];
      if (value !== undefined && Number.isFinite(value)) {
        result[key] = (result[key] ?? 0) + value;
      }
    }
  }
  return clampStateDelta(result);
}

export function scaleStateDelta(
  delta: StateDeltaLike,
  factor: number,
): StateDeltaLike {
  const safeFactor = Number.isFinite(factor) ? factor : 0;
  const result: StateDeltaLike = {};
  for (const key of STATE_KEYS) {
    const value = delta[key];
    if (value !== undefined) result[key] = value * safeFactor;
  }
  return clampStateDelta(result);
}

export function applyStateDelta<TState extends RuntimeStateLike>(
  state: TState,
  delta: StateDeltaLike,
  asOfUtc: string,
  currentActivityId?: string,
): TState {
  const safe = clampStateDelta(delta);
  const next = {
    ...state,
    asOfUtc,
    moodValence: clamp(state.moodValence + (safe.moodValence ?? 0), -1, 1),
    moodArousal: clamp(state.moodArousal + (safe.moodArousal ?? 0)),
    energy: clamp(state.energy + (safe.energy ?? 0)),
    stress: clamp(state.stress + (safe.stress ?? 0)),
    socialBattery: clamp(state.socialBattery + (safe.socialBattery ?? 0)),
    focus: clamp(state.focus + (safe.focus ?? 0)),
    revision: state.revision + 1,
  };

  if (currentActivityId === undefined) {
    delete next.currentActivityId;
  } else {
    next.currentActivityId = currentActivityId;
  }
  return next;
}

export interface CompletionProbabilityInput {
  adherenceProbability: number;
  routineAdherence: number;
  rigidity: "fixed" | "committed" | "flexible" | "filler";
  energy: number;
  stress: number;
}

export function calculateActivityCompletionProbability(
  input: CompletionProbabilityInput,
): number {
  const adherence = clamp(input.adherenceProbability);
  const routine = clamp(input.routineAdherence);
  const energy = clamp(input.energy);
  const stress = clamp(input.stress);
  const rigidityAdjustment = {
    fixed: 0.28,
    committed: 0.14,
    flexible: 0,
    filler: -0.2,
  }[input.rigidity];

  const probability =
    adherence * 0.5 +
    routine * 0.2 +
    energy * 0.17 +
    (1 - stress) * 0.13 +
    rigidityAdjustment;
  if (input.rigidity === "fixed") return clamp(probability, 0.9, 0.995);
  return clamp(probability, 0.05, 0.98);
}
