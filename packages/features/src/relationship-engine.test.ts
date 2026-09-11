import { describe, expect, it } from "vitest";
import {
  RELATIONSHIP_BASELINE_CLOSENESS_PER_TURN,
  RELATIONSHIP_BASELINE_DAILY_LIMIT,
  applyRelationshipDelta,
  applyRelationshipInteraction,
  type RelationshipDailyUsageSnapshot,
  type RelationshipStateLike,
} from "./relationship-engine.js";
const DAY_START = "2026-08-28T00:00:00.000Z";
const state = (closeness = 0.2): RelationshipStateLike => ({
  userId: "local-user",
  closeness,
});

describe("single closeness relationship interactions", () => {
  it("requires an explicit eligible interaction for baseline and preserves tier scaling", () => {
    expect(
      applyRelationshipInteraction({
        state: state(),
        atUtc: DAY_START,
        capabilityScale: 1,
      }).after.closeness,
    ).toBe(0.2);
    for (const scale of [0, 0.5, 1]) {
      const result = applyRelationshipInteraction({
        state: state(),
        atUtc: DAY_START,
        capabilityScale: scale,
        includeInteractionBaseline: true,
        proposal: { closeness: 0.02 },
      });
      expect(result.baselineDelta.closeness).toBeCloseTo(0.001 * scale, 12);
      expect(result.appliedProposalDelta.closeness).toBeCloseTo(
        0.02 * scale,
        12,
      );
      expect(result.after.closeness).toBeCloseTo(0.2 + 0.021 * scale, 12);
      expect(result.dailyUsageAfter.baselineCloseness).toBeCloseTo(
        0.001 * scale,
        12,
      );
      expect(Object.keys(result.after).sort()).toEqual([
        "closeness",
        "lastInteractionAtUtc",
        "userId",
      ]);
    }
  });

  it("caps baseline awards at 0.012 regardless of further ordinary turns", () => {
    let current = state(0.1);
    let dailyUsage: RelationshipDailyUsageSnapshot | undefined;
    const checkpoints: number[] = [];
    for (let turn = 1; turn <= 100; turn++) {
      const result = applyRelationshipInteraction({
        state: current,
        atUtc: DAY_START,
        capabilityScale: 1,
        includeInteractionBaseline: true,
        ...(dailyUsage === undefined ? {} : { dailyUsage }),
      });
      current = result.after;
      dailyUsage = result.dailyUsageAfter;
      if ([1, 10, 30, 100].includes(turn)) checkpoints.push(current.closeness);
    }
    expect(checkpoints).toEqual([0.101, 0.11, 0.112, 0.112]);
    expect(RELATIONSHIP_BASELINE_CLOSENESS_PER_TURN).toBe(0.001);
    expect(RELATIONSHIP_BASELINE_DAILY_LIMIT).toBe(0.012);
    expect(dailyUsage).toEqual({ closeness: 0.012, baselineCloseness: 0.012 });
  });

  it("shares the total net cap between baseline and model proposal", () => {
    const first = applyRelationshipInteraction({
      state: state(),
      atUtc: DAY_START,
      capabilityScale: 1,
      includeInteractionBaseline: true,
      proposal: { closeness: 1 },
    });
    expect(first.after.closeness).toBe(0.24);
    expect(first.appliedProposalDelta.closeness).toBe(0.039);
    expect(first.dailyUsageAfter).toEqual({
      closeness: 0.04,
      baselineCloseness: 0.001,
    });
    expect(first.limitsApplied).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: "single_turn", applied: 0.08 }),
        expect.objectContaining({ stage: "daily_cap", applied: 0.039 }),
      ]),
    );
    const capped = applyRelationshipInteraction({
      state: first.after,
      atUtc: DAY_START,
      capabilityScale: 1,
      includeInteractionBaseline: true,
      dailyUsage: first.dailyUsageAfter,
      proposal: { closeness: 0.01 },
    });
    expect(capped.appliedDelta).toEqual({});
    expect(capped.dailyUsageAfter.baselineCloseness).toBe(0.001);
  });

  it("allows same-day rupture and repair but never refunds baseline awards", () => {
    const usage = { closeness: 0.012, baselineCloseness: 0.012 };
    const rupture = applyRelationshipInteraction({
      state: state(0.212),
      atUtc: DAY_START,
      capabilityScale: 1,
      dailyUsage: usage,
      proposal: { closeness: -0.04 },
    });
    expect(rupture.after.closeness).toBe(0.172);
    expect(rupture.dailyUsageAfter).toEqual({
      closeness: -0.028,
      baselineCloseness: 0.012,
    });
    const repair = applyRelationshipInteraction({
      state: rupture.after,
      atUtc: DAY_START,
      capabilityScale: 1,
      includeInteractionBaseline: true,
      dailyUsage: rupture.dailyUsageAfter,
      proposal: { closeness: 0.04 },
    });
    expect(repair.after.closeness).toBe(0.212);
    expect(repair.baselineDelta.closeness).toBe(0);
    expect(repair.dailyUsageAfter).toEqual(usage);
  });

  it("keeps arbitrarily alternating proposals inside both daily net boundaries", () => {
    let current = state(0.5);
    let usage: RelationshipDailyUsageSnapshot = {
      closeness: 0,
      baselineCloseness: 0,
    };
    for (let turn = 0; turn < 100; turn++) {
      const result = applyRelationshipInteraction({
        state: current,
        atUtc: DAY_START,
        capabilityScale: 1,
        dailyUsage: usage,
        includeInteractionBaseline: true,
        proposal: { closeness: turn % 2 ? -1 : 1 },
      });
      current = result.after;
      usage = result.dailyUsageAfter;
      expect(current.closeness).toBeGreaterThanOrEqual(0.46);
      expect(current.closeness).toBeLessThanOrEqual(0.54);
      expect(usage.baselineCloseness).toBeLessThanOrEqual(0.012);
    }
  });

  it("resets a new local-day budget only when supplied by the caller", () => {
    const capped = applyRelationshipInteraction({
      state: state(),
      atUtc: DAY_START,
      capabilityScale: 1,
      includeInteractionBaseline: true,
      dailyUsage: { closeness: 0.012, baselineCloseness: 0.012 },
    });
    expect(capped.baselineDelta.closeness).toBe(0);
    const next = applyRelationshipInteraction({
      state: capped.after,
      atUtc: "2026-08-29T00:00:00.000Z",
      capabilityScale: 1,
      includeInteractionBaseline: true,
      dailyUsage: {},
    });
    expect(next.baselineDelta.closeness).toBe(0.001);
  });

  it("reaches exactly one in finite steps and reports boundary-adjusted usage", () => {
    const top = applyRelationshipInteraction({
      state: state(0.9998),
      atUtc: DAY_START,
      capabilityScale: 1,
      includeInteractionBaseline: true,
      proposal: { closeness: 0.004 },
    });
    expect(top.after.closeness).toBe(1);
    expect(top.baselineDelta.closeness).toBe(0.0002);
    expect(top.acceptedProposalDelta.closeness).toBe(0.004);
    expect(top.appliedProposalDelta.closeness).toBe(0);
    expect(top.dailyUsageAfter).toEqual({
      closeness: 0.0002,
      baselineCloseness: 0.0002,
    });
    const bottom = applyRelationshipInteraction({
      state: state(0.0001),
      atUtc: DAY_START,
      capabilityScale: 1,
      proposal: { closeness: -0.01 },
    });
    expect(bottom.after.closeness).toBe(0);
    expect(bottom.dailyUsageAfter.closeness).toBe(-0.0001);
  });

  it("does not decay closeness while idle and prevents timestamps going backward", () => {
    const previous = {
      ...state(),
      lastInteractionAtUtc: "2026-08-28T10:00:00.000Z",
    };
    const backward = applyRelationshipInteraction({
      state: previous,
      atUtc: DAY_START,
      capabilityScale: 1,
    });
    expect(backward.after).toEqual(previous);
    const later = applyRelationshipInteraction({
      state: previous,
      atUtc: "2027-08-28T10:00:00.000Z",
      capabilityScale: 1,
    });
    expect(later.after.closeness).toBe(previous.closeness);
    expect(
      applyRelationshipDelta(previous, { closeness: 0.01 }, DAY_START).state
        .lastInteractionAtUtc,
    ).toBe(previous.lastInteractionAtUtc);
    expect(() =>
      applyRelationshipInteraction({
        state: previous,
        atUtc: "invalid",
        capabilityScale: 1,
      }),
    ).toThrow(RangeError);
  });

  it("uses the same net budget for non-chat causes without baseline", () => {
    const result = applyRelationshipInteraction({
      state: state(),
      atUtc: DAY_START,
      capabilityScale: 1,
      includeInteractionBaseline: false,
      proposal: { closeness: 0.006 },
      dailyUsage: { closeness: 0.039, baselineCloseness: 0.01 },
    });
    expect(result.after.closeness).toBe(0.201);
    expect(result.baselineDelta).toEqual({ closeness: 0 });
    expect(result.dailyUsageAfter).toEqual({
      closeness: 0.04,
      baselineCloseness: 0.01,
    });
  });
});
