import { describe, expect, it } from "vitest";

import {
  RECENT_INTERACTION_VALENCE_HALF_LIFE_HOURS,
  RECENT_INTERACTION_VALENCE_NEW_SIGNAL_WEIGHT,
  RELATIONSHIP_BASELINE_FAMILIARITY_PER_TURN,
  RELATIONSHIP_DAILY_LIMITS,
  applyRelationshipDelta,
  applyRelationshipInteraction,
  decayRecentInteractionValence,
  type RelationshipDailyUsageSnapshot,
  type RelationshipStateLike,
} from "./relationship-engine.js";

const DAY_START = "2026-08-28T00:00:00.000Z";

describe("applyRelationshipInteraction", () => {
  it("adds the deterministic baseline to the scaled model proposal", () => {
    const state = relationshipState();

    const result = applyRelationshipInteraction({
      state,
      atUtc: "2026-08-28T01:00:00.000Z",
      capabilityScale: 0.5,
      proposal: {
        closeness: 0.04,
        trust: 0.02,
        familiarity: 0.004,
      },
    });

    expect(result.before).toEqual(state);
    expect(result.proposedDelta).toEqual({
      closeness: 0.04,
      trust: 0.02,
      familiarity: 0.004,
    });
    expect(result.baselineDelta.familiarity).toBeCloseTo(0.0005, 10);
    expect(result.acceptedProposalDelta).toMatchObject({
      closeness: 0.02,
      trust: 0.01,
      familiarity: 0.002,
    });
    expect(result.appliedProposalDelta.closeness).toBeCloseTo(0.02, 10);
    expect(result.appliedProposalDelta.trust).toBeCloseTo(0.01, 10);
    expect(result.appliedProposalDelta.familiarity).toBeCloseTo(0.002, 10);
    expect(result.after.closeness).toBeCloseTo(0.22, 10);
    expect(result.after.trust).toBeCloseTo(0.21, 10);
    expect(result.after.familiarity).toBeCloseTo(0.1025, 10);
    expect(result.appliedDelta.familiarity).toBeCloseTo(0.0025, 10);
    expect(result.after.lastInteractionAtUtc).toBe("2026-08-28T01:00:00.000Z");
    expect(result.limitsApplied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "familiarity",
          source: "baseline",
          stage: "capability_scale",
        }),
        expect.objectContaining({
          field: "closeness",
          source: "proposal",
          stage: "capability_scale",
        }),
      ]),
    );
  });

  it("calibrates ordinary same-day familiarity at 1, 10, 30, and 100 turns", () => {
    expect(ordinaryTurnCurve([1, 10, 30, 100])).toEqual([
      expect.closeTo(0.101, 10),
      expect.closeTo(0.11, 10),
      expect.closeTo(0.112, 10),
      expect.closeTo(0.112, 10),
    ]);

    expect(RELATIONSHIP_BASELINE_FAMILIARITY_PER_TURN).toBe(0.001);
    expect(RELATIONSHIP_DAILY_LIMITS.familiarity).toBe(0.012);
  });

  it("caps absolute same-day movement after single-turn limiting and scaling", () => {
    const first = applyRelationshipInteraction({
      state: relationshipState(),
      atUtc: "2026-08-28T01:00:00.000Z",
      capabilityScale: 1,
      proposal: {
        closeness: 1,
        trust: 1,
        familiarity: 1,
        recentInteractionValence: 1,
      },
    });

    expect(first.after.closeness).toBeCloseTo(0.24, 10);
    expect(first.after.trust).toBeCloseTo(0.23, 10);
    expect(first.after.familiarity).toBeCloseTo(0.112, 10);
    expect(first.dailyUsageAfter.closeness).toBeCloseTo(
      RELATIONSHIP_DAILY_LIMITS.closeness,
      10,
    );
    expect(first.dailyUsageAfter.trust).toBeCloseTo(
      RELATIONSHIP_DAILY_LIMITS.trust,
      10,
    );
    expect(first.dailyUsageAfter.familiarity).toBeCloseTo(
      RELATIONSHIP_DAILY_LIMITS.familiarity,
      10,
    );
    expect(first.limitsApplied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "closeness",
          stage: "single_turn",
          requested: 1,
          applied: 0.08,
        }),
        expect.objectContaining({
          field: "closeness",
          stage: "daily_cap",
          applied: 0.04,
        }),
        expect.objectContaining({
          field: "trust",
          stage: "daily_cap",
          applied: 0.03,
        }),
      ]),
    );

    const attemptedOscillation = applyRelationshipInteraction({
      state: first.after,
      atUtc: "2026-08-28T02:00:00.000Z",
      capabilityScale: 1,
      dailyUsage: first.dailyUsageAfter,
      proposal: { closeness: -1, trust: -1, familiarity: 1 },
    });

    expect(attemptedOscillation.after.closeness).toBeCloseTo(
      first.after.closeness,
      10,
    );
    expect(attemptedOscillation.after.trust).toBeCloseTo(first.after.trust, 10);
    expect(attemptedOscillation.after.familiarity).toBeCloseTo(
      first.after.familiarity,
      10,
    );
  });

  it("decays old valence before blending a bounded new interaction signal", () => {
    const state = relationshipState({
      recentInteractionValence: 0.4,
      lastInteractionAtUtc: "2026-08-26T00:00:00.000Z",
    });

    const result = applyRelationshipInteraction({
      state,
      atUtc: "2026-08-28T00:00:00.000Z",
      capabilityScale: 1,
      proposal: { recentInteractionValence: -1 },
    });

    expect(RECENT_INTERACTION_VALENCE_HALF_LIFE_HOURS).toBe(48);
    expect(RECENT_INTERACTION_VALENCE_NEW_SIGNAL_WEIGHT).toBe(0.35);
    expect(result.valence.elapsedHours).toBe(48);
    expect(result.valence.decayFactor).toBeCloseTo(0.5, 10);
    expect(result.valence.decayed).toBeCloseTo(0.2, 10);
    expect(result.valence.proposedSignal).toBe(-0.3);
    expect(result.valence.appliedMovement).toBeCloseTo(-0.175, 10);
    expect(result.after.recentInteractionValence).toBeCloseTo(0.025, 10);
    expect(result.after.recentInteractionValence).not.toBeCloseTo(-0.6, 10);
    expect(
      decayRecentInteractionValence(
        0.4,
        "2026-08-26T00:00:00.000Z",
        "2026-08-28T00:00:00.000Z",
      ),
    ).toBeCloseTo(0.2, 10);
  });

  it("lets the caller reset daily usage on a new local day", () => {
    const capped = applyRelationshipInteraction({
      state: relationshipState(),
      atUtc: "2026-08-28T23:50:00.000Z",
      capabilityScale: 1,
      dailyUsage: {
        familiarity: RELATIONSHIP_DAILY_LIMITS.familiarity,
      },
    });
    expect(capped.baselineDelta.familiarity).toBe(0);

    const nextLocalDay = applyRelationshipInteraction({
      state: capped.after,
      atUtc: "2026-08-29T00:10:00.000Z",
      capabilityScale: 1,
      dailyUsage: {},
    });
    expect(nextLocalDay.baselineDelta.familiarity).toBeCloseTo(0.001, 10);
    expect(nextLocalDay.after.familiarity).toBeCloseTo(0.101, 10);
  });

  it("keeps interaction time and valence monotonic when the clock moves backward", () => {
    const state = relationshipState({
      recentInteractionValence: 0.4,
      lastInteractionAtUtc: "2026-08-28T10:00:00.000Z",
    });

    const result = applyRelationshipInteraction({
      state,
      atUtc: "2026-08-28T09:00:00.000Z",
      capabilityScale: 1,
    });

    expect(result.after.lastInteractionAtUtc).toBe("2026-08-28T10:00:00.000Z");
    expect(result.valence.elapsedHours).toBe(0);
    expect(result.after.recentInteractionValence).toBe(0.4);
    expect(
      applyRelationshipDelta(
        state,
        { closeness: 0.01 },
        result.after.lastInteractionAtUtc!,
      ).state.lastInteractionAtUtc,
    ).toBe("2026-08-28T10:00:00.000Z");
  });

  it("reports accepted and actually applied movement separately at state bounds", () => {
    const result = applyRelationshipInteraction({
      state: relationshipState({ familiarity: 0.9998 }),
      atUtc: "2026-08-28T01:00:00.000Z",
      capabilityScale: 1,
      proposal: { familiarity: 0.004 },
    });

    expect(result.baselineDelta.familiarity).toBeCloseTo(0.0002, 10);
    expect(result.acceptedProposalDelta.familiarity).toBeCloseTo(0.004, 10);
    expect(result.appliedProposalDelta.familiarity).toBe(0);
    expect(result.after.familiarity).toBe(1);
    expect(result.limitsApplied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "familiarity",
          source: "proposal",
          stage: "state_boundary",
          applied: 0,
        }),
      ]),
    );
  });

  it("applies a non-chat relationship cause without the interaction baseline", () => {
    const result = applyRelationshipInteraction({
      state: relationshipState(),
      atUtc: "2026-08-28T03:00:00.000Z",
      capabilityScale: 1,
      includeInteractionBaseline: false,
      proposal: { closeness: 0.006, familiarity: 0.002 },
    });

    expect(result.baselineDelta).toEqual({ familiarity: 0 });
    expect(result.after.closeness).toBeCloseTo(0.206, 10);
    expect(result.after.familiarity).toBeCloseTo(0.102, 10);
  });
});

function ordinaryTurnCurve(checkpoints: number[]): number[] {
  let state = relationshipState();
  let dailyUsage: RelationshipDailyUsageSnapshot | undefined;
  const output: number[] = [];
  const checkpointSet = new Set(checkpoints);
  const maximum = Math.max(...checkpoints);

  for (let turn = 1; turn <= maximum; turn += 1) {
    const result = applyRelationshipInteraction({
      state,
      atUtc: new Date(Date.parse(DAY_START) + turn * 1_000).toISOString(),
      capabilityScale: 1,
      ...(dailyUsage === undefined ? {} : { dailyUsage }),
    });
    state = result.after;
    dailyUsage = result.dailyUsageAfter;
    if (checkpointSet.has(turn)) output.push(state.familiarity);
  }
  return output;
}

function relationshipState(
  overrides: Partial<RelationshipStateLike> = {},
): RelationshipStateLike {
  return {
    userId: "local-user",
    closeness: 0.2,
    trust: 0.2,
    familiarity: 0.1,
    recentInteractionValence: 0,
    ...overrides,
  };
}
