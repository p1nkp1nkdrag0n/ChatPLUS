import { describe, expect, it } from "vitest";

import type { SimulationCapabilities } from "../domain/capabilities.js";
import type { RuntimeState } from "../domain/schemas.js";
import { projectTurnState } from "./turn-state-projection.js";

const NOW = "2026-08-23T04:00:00.000Z";

describe("projectTurnState", () => {
  it("preserves the legacy clamps, relationship scale, and revision rules", () => {
    const state = runtimeState();
    const projection = projectTurnState({
      state,
      stateDelta: { energy: 0.2, stress: -0.2, moodValence: 0.2 },
      relationshipDelta: { trust: 0.08 },
      nowUtc: NOW,
      capabilities: capabilities(),
    });

    expect(projection.stateChanged).toBe(true);
    expect(projection.nextState).toMatchObject({
      asOfUtc: NOW,
      energy: 1,
      stress: 0,
      moodValence: 1,
      revision: 8,
      relationship: {
        trust: 0.58,
        familiarity: 0.506,
        lastInteractionAtUtc: NOW,
      },
    });
    expect(state).toMatchObject({ revision: 7, energy: 0.9, stress: 0.1 });
  });

  it("does not advance state when there is no validated delta", () => {
    const state = runtimeState();
    const projection = projectTurnState({
      state,
      stateDelta: undefined,
      relationshipDelta: undefined,
      nowUtc: NOW,
      capabilities: capabilities(),
    });

    expect(projection).toEqual({ nextState: state, stateChanged: false });
    expect(projection.nextState).not.toBe(state);
  });
});

function runtimeState(): RuntimeState {
  return {
    agentId: "agent_projection",
    asOfUtc: "2026-08-23T03:00:00.000Z",
    moodValence: 0.9,
    moodArousal: 0.5,
    energy: 0.9,
    stress: 0.1,
    socialBattery: 0.5,
    focus: 0.5,
    sleepDebtMinutes: 0,
    relationship: {
      userId: "local-user",
      closeness: 0.5,
      trust: 0.5,
      familiarity: 0.5,
      recentInteractionValence: 0,
    },
    revision: 7,
  };
}

function capabilities(): SimulationCapabilities {
  return {
    schedule: true,
    offlineSettlement: true,
    dynamicState: true,
    longTermMemory: true,
    relationshipDynamics: true,
    relationshipDeltaScale: 1,
    proactiveDialogue: true,
    personaGuard: true,
    activityEnrichment: true,
    memoryCandidatesPerTurn: 8,
  };
}
