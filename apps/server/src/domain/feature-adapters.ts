import type {
  RuntimeStateLike,
  ScheduleEffectProposalLike,
  ScheduleItemLike,
} from "@personasim/features";

import type {
  RuntimeState,
  ScheduleEffectProposal,
  ScheduleItem,
} from "./schemas.js";

// Contracts model optional fields as `T | undefined`; feature engines use
// exact optional properties. JSON domain values cannot contain undefined, so
// this boundary adapter removes it before delegating to the shared engines.
export function toFeatureState(state: RuntimeState): RuntimeStateLike {
  return withoutUndefined<RuntimeStateLike>(state);
}

export function toFeatureScheduleItems(
  items: readonly ScheduleItem[],
): ScheduleItemLike[] {
  return items.map((item) => withoutUndefined<ScheduleItemLike>(item));
}

export function toFeatureScheduleEffects(
  effects: readonly ScheduleEffectProposal[],
): ScheduleEffectProposalLike[] {
  return effects.map((effect) =>
    withoutUndefined<ScheduleEffectProposalLike>(effect),
  );
}

export function withoutUndefined<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
