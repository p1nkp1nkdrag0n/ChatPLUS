import { applyRelationshipDelta } from "@personasim/features";

import type { SimulationCapabilities } from "../domain/capabilities.js";
import type { AgentTurnDecision, RuntimeState } from "../domain/schemas.js";

export interface TurnStateProjection {
  nextState: RuntimeState;
  stateChanged: boolean;
}

/**
 * Projects one validated turn onto runtime state without writing it.
 *
 * Both the legacy and split pipelines use this function so rollout comparison
 * cannot drift because of duplicated clamping, relationship scaling, or
 * revision semantics.
 */
export function projectTurnState(input: {
  state: RuntimeState;
  stateDelta: AgentTurnDecision["stateDelta"];
  relationshipDelta: AgentTurnDecision["relationshipDelta"];
  nowUtc: string;
  capabilities: SimulationCapabilities;
}): TurnStateProjection {
  const nextState = structuredClone(input.state);
  if (input.stateDelta === undefined && input.relationshipDelta === undefined) {
    return { nextState, stateChanged: false };
  }
  if (
    !input.capabilities.dynamicState &&
    !input.capabilities.relationshipDynamics
  ) {
    return { nextState, stateChanged: false };
  }

  if (input.capabilities.dynamicState) {
    if (input.stateDelta?.moodValence !== undefined) {
      nextState.moodValence = clampSigned(
        nextState.moodValence + input.stateDelta.moodValence,
      );
    }
    if (input.stateDelta?.moodArousal !== undefined) {
      nextState.moodArousal = clamp01(
        nextState.moodArousal + input.stateDelta.moodArousal,
      );
    }
    if (input.stateDelta?.energy !== undefined) {
      nextState.energy = clamp01(nextState.energy + input.stateDelta.energy);
    }
    if (input.stateDelta?.stress !== undefined) {
      nextState.stress = clamp01(nextState.stress + input.stateDelta.stress);
    }
    if (input.stateDelta?.socialBattery !== undefined) {
      nextState.socialBattery = clamp01(
        nextState.socialBattery + input.stateDelta.socialBattery,
      );
    }
    if (input.stateDelta?.focus !== undefined) {
      nextState.focus = clamp01(nextState.focus + input.stateDelta.focus);
    }
  }

  if (input.capabilities.relationshipDynamics) {
    const scale = input.capabilities.relationshipDeltaScale;
    nextState.relationship = applyRelationshipDelta(
      {
        userId: nextState.relationship.userId,
        closeness: nextState.relationship.closeness,
        trust: nextState.relationship.trust,
        familiarity: nextState.relationship.familiarity,
        recentInteractionValence:
          nextState.relationship.recentInteractionValence,
        ...(nextState.relationship.lastInteractionAtUtc
          ? {
              lastInteractionAtUtc: nextState.relationship.lastInteractionAtUtc,
            }
          : {}),
      },
      {
        ...(input.relationshipDelta?.closeness === undefined
          ? {}
          : {
              closeness: input.relationshipDelta.closeness * scale,
            }),
        ...(input.relationshipDelta?.trust === undefined
          ? {}
          : { trust: input.relationshipDelta.trust * scale }),
        familiarity: (input.relationshipDelta?.familiarity ?? 0.006) * scale,
        ...(input.relationshipDelta?.recentInteractionValence === undefined
          ? {}
          : {
              recentInteractionValence:
                input.relationshipDelta.recentInteractionValence * scale,
            }),
      },
      input.nowUtc,
    ).state;
  }

  nextState.asOfUtc = input.nowUtc;
  nextState.revision += 1;
  return { nextState, stateChanged: true };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampSigned(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
