import { describe, expect, it } from "vitest";

import {
  planSelfInitiatedActivity,
  rankPersonalIntents,
  selfPlanningSeed,
  stateCompatibilityForCategory,
  type PersonalIntentLike,
  type SelfPlanningCharacterLike,
  type SelfPlanningStateLike,
} from "./self-planning.js";
import { minutesBetween } from "./shared.js";

const character: SelfPlanningCharacterLike = {
  id: "agent-1",
  version: 3,
  identity: {
    timezone: "UTC",
    workOrRole: "student",
    selfDescription: "Enjoys reading and photography.",
  },
  persona: {
    goals: [],
    preferences: [],
    traits: [],
    values: [],
  },
  dialogue: { frequentPhrases: [] },
  routines: [],
};

const state: SelfPlanningStateLike = {
  moodValence: 0.2,
  energy: 0.65,
  stress: 0.3,
  socialBattery: 0.6,
  focus: 0.7,
  sleepDebtMinutes: 0,
};

function intent(
  id: string,
  overrides: Partial<PersonalIntentLike> = {},
): PersonalIntentLike {
  return {
    id,
    agentId: "agent-1",
    activity: `Activity ${id}`,
    category: "leisure",
    desiredDurationMinutes: 60,
    priority: 0.5,
    freshness: 0.5,
    status: "pending",
    specVersion: 3,
    createdAtUtc: "2026-06-01T07:00:00.000Z",
    ...overrides,
  };
}

describe("deterministic self planning", () => {
  it("tries the next ranked intent when the first has no valid placement", () => {
    const blockedFirst = intent("first", {
      priority: 0.95,
      earliestAtUtc: "2026-06-01T10:00:00.000Z",
      latestAtUtc: "2026-06-01T11:00:00.000Z",
    });
    const placeableSecond = intent("second", {
      priority: 0.7,
      earliestAtUtc: "2026-06-01T12:00:00.000Z",
      latestAtUtc: "2026-06-01T16:00:00.000Z",
    });

    const result = planSelfInitiatedActivity({
      character,
      state,
      intents: [placeableSecond, blockedFirst],
      existingItems: [
        {
          startAtUtc: "2026-06-01T10:00:00.000Z",
          endAtUtc: "2026-06-01T11:00:00.000Z",
          status: "planned",
          category: "work",
        },
      ],
      nowUtc: "2026-06-01T08:00:00.000Z",
      horizonEndAtUtc: "2026-06-01T18:00:00.000Z",
      bufferMinutes: 0,
    });

    expect(result.rankedCandidates.map((entry) => entry.intentId)).toEqual([
      "first",
      "second",
    ]);
    expect(result.skipped).toContainEqual({
      intentId: "first",
      reason: "no_free_slot",
    });
    expect(result.selectedIntentId).toBe("second");
    expect(result.bundle?.intentId).toBe("second");
    expect(result.bundle?.activity).not.toHaveProperty("source");
    expect(result.bundle?.activity.rigidity).toBe("flexible");
    expect(
      minutesBetween(
        result.bundle!.activity.startAtUtc,
        result.bundle!.activity.endAtUtc,
      ),
    ).toBe(60);
  });

  it("returns at most one plan and replays the exact seed deterministically", () => {
    const inputs = {
      character,
      state,
      intents: [
        intent("preferred", { priority: 0.9 }),
        intent("also-placeable", { priority: 0.8 }),
      ],
      existingItems: [],
      nowUtc: "2026-06-01T00:00:00.000Z",
      horizonEndAtUtc: "2026-06-01T06:00:00.000Z",
      bufferMinutes: 0,
    } as const;

    const first = planSelfInitiatedActivity(inputs);
    const replay = planSelfInitiatedActivity(inputs);

    expect(first).toEqual(replay);
    expect(first.selectedIntentId).toBe("preferred");
    expect(first.bundle).toBeDefined();
    expect(first.seed).toBe(
      selfPlanningSeed("agent-1", "preferred", 3, "2026-06-01"),
    );
    expect(Date.parse(first.bundle!.activity.startAtUtc)).toBeLessThan(
      Date.parse("2026-06-01T09:00:00.000Z"),
    );
  });

  it("uses affinity and then state compatibility after priority and freshness", () => {
    const tiredState: SelfPlanningStateLike = {
      ...state,
      energy: 0.1,
      stress: 0.9,
      focus: 0.2,
    };
    const exercise = intent("exercise", {
      category: "exercise",
      priority: 0.5,
      freshness: 0.5,
    });
    const selfCare = intent("self-care", {
      category: "self_care",
      priority: 0.5,
      freshness: 0.5,
    });
    const ranked = rankPersonalIntents(
      [exercise, selfCare],
      {
        categoryScores: {
          sleep: 0.5,
          work: 0.5,
          study: 0.5,
          meal: 0.5,
          exercise: 0.5,
          social: 0.5,
          travel: 0.5,
          leisure: 0.5,
          self_care: 0.5,
          errand: 0.5,
          other: 0.5,
        },
        nightOwlBias: 0.05,
      },
      tiredState,
    );

    expect(
      stateCompatibilityForCategory("self_care", tiredState),
    ).toBeGreaterThan(stateCompatibilityForCategory("exercise", tiredState));
    expect(ranked.map((entry) => entry.intent.id)).toEqual([
      "self-care",
      "exercise",
    ]);
  });

  it("rejects stale spec versions without blocking a valid candidate", () => {
    const result = planSelfInitiatedActivity({
      character,
      state,
      intents: [
        intent("stale", { priority: 1, specVersion: 2 }),
        intent("current", { priority: 0.5 }),
      ],
      existingItems: [],
      nowUtc: "2026-06-01T08:00:00.000Z",
      horizonEndAtUtc: "2026-06-01T18:00:00.000Z",
      bufferMinutes: 0,
    });

    expect(result.skipped).toContainEqual({
      intentId: "stale",
      reason: "spec_version_mismatch",
    });
    expect(result.selectedIntentId).toBe("current");
  });

  it("pairs a night activity with a sleep adjustment only after normal placement fails", () => {
    const result = planSelfInitiatedActivity({
      character,
      state,
      intents: [
        intent("night-photo", {
          activity: "Night photography by the river",
          desiredDurationMinutes: 120,
          earliestAtUtc: "2026-06-01T22:00:00.000Z",
          latestAtUtc: "2026-06-02T07:00:00.000Z",
        }),
      ],
      existingItems: [
        {
          id: "sleep-1",
          startAtUtc: "2026-06-01T22:00:00.000Z",
          endAtUtc: "2026-06-02T07:00:00.000Z",
          status: "planned",
          category: "sleep",
          rigidity: "fixed",
        },
        {
          id: "work-1",
          startAtUtc: "2026-06-02T07:00:00.000Z",
          endAtUtc: "2026-06-02T18:00:00.000Z",
          status: "planned",
          category: "work",
          rigidity: "fixed",
        },
      ],
      nowUtc: "2026-06-01T21:55:00.000Z",
      horizonEndAtUtc: "2026-06-02T18:00:00.000Z",
      bufferMinutes: 0,
    });

    expect(result.bundle?.activity.startAtUtc).toBe("2026-06-01T22:00:00.000Z");
    expect(result.bundle?.activity.endAtUtc).toBe("2026-06-02T00:00:00.000Z");
    expect(result.bundle?.sleepAdjustment).toEqual({
      sleepItemId: "sleep-1",
      newStartAtUtc: "2026-06-02T00:00:00.000Z",
      newEndAtUtc: "2026-06-02T07:00:00.000Z",
      lostSleepMinutes: 120,
    });
    expect(
      minutesBetween(
        result.bundle!.sleepAdjustment!.newStartAtUtc,
        result.bundle!.sleepAdjustment!.newEndAtUtc,
      ),
    ).toBe(420);
    expect(result.bundle?.activity.stateEffects.energy).not.toBe(-0.2);
  });

  it("leaves ordinary free-slot placement and category effects unchanged", () => {
    const result = planSelfInitiatedActivity({
      character,
      state,
      intents: [
        intent("evening-reading", {
          activity: "Evening reading",
          earliestAtUtc: "2026-06-01T18:00:00.000Z",
          latestAtUtc: "2026-06-01T20:00:00.000Z",
        }),
      ],
      existingItems: [
        {
          id: "sleep-1",
          startAtUtc: "2026-06-01T22:00:00.000Z",
          endAtUtc: "2026-06-02T07:00:00.000Z",
          status: "planned",
          category: "sleep",
          rigidity: "fixed",
        },
      ],
      nowUtc: "2026-06-01T17:00:00.000Z",
      horizonEndAtUtc: "2026-06-02T07:00:00.000Z",
      bufferMinutes: 0,
    });

    expect(result.bundle?.sleepAdjustment).toBeUndefined();
    expect(result.bundle?.activity.stateEffects).toEqual({
      energy: -0.04,
      stress: -0.05,
      moodValence: 0.08,
    });
  });

  it("never shortens committed sleep", () => {
    const result = planSelfInitiatedActivity({
      character,
      state,
      intents: [
        intent("night-run", {
          activity: "Night run",
          earliestAtUtc: "2026-06-01T22:00:00.000Z",
          latestAtUtc: "2026-06-02T06:00:00.000Z",
        }),
      ],
      existingItems: [
        {
          id: "committed-sleep",
          startAtUtc: "2026-06-01T22:00:00.000Z",
          endAtUtc: "2026-06-02T06:00:00.000Z",
          status: "planned",
          category: "sleep",
          rigidity: "committed",
        },
      ],
      nowUtc: "2026-06-01T21:55:00.000Z",
      horizonEndAtUtc: "2026-06-02T06:00:00.000Z",
      bufferMinutes: 0,
    });

    expect(result.bundle).toBeUndefined();
    expect(result.skipped).toContainEqual({
      intentId: "night-run",
      reason: "no_free_slot",
    });
  });

  it("preserves the configured minimum sleep and tries the next candidate", () => {
    const result = planSelfInitiatedActivity({
      character,
      state,
      intents: [
        intent("too-long", {
          activity: "Night photography expedition",
          desiredDurationMinutes: 120,
          priority: 0.95,
          earliestAtUtc: "2026-06-01T22:00:00.000Z",
          latestAtUtc: "2026-06-02T06:00:00.000Z",
        }),
        intent("fits", {
          activity: "Night photography walk",
          desiredDurationMinutes: 60,
          priority: 0.7,
          earliestAtUtc: "2026-06-01T22:00:00.000Z",
          latestAtUtc: "2026-06-02T06:00:00.000Z",
        }),
      ],
      existingItems: [
        {
          id: "sleep-1",
          startAtUtc: "2026-06-01T22:00:00.000Z",
          endAtUtc: "2026-06-02T06:00:00.000Z",
          status: "planned",
          category: "sleep",
          rigidity: "fixed",
        },
      ],
      nowUtc: "2026-06-01T21:55:00.000Z",
      horizonEndAtUtc: "2026-06-02T06:00:00.000Z",
      minimumSleepMinutes: 420,
      bufferMinutes: 0,
    });

    expect(result.skipped).toContainEqual({
      intentId: "too-long",
      reason: "no_free_slot",
    });
    expect(result.selectedIntentId).toBe("fits");
    expect(result.bundle?.sleepAdjustment?.lostSleepMinutes).toBe(60);
    expect(
      minutesBetween(
        result.bundle!.sleepAdjustment!.newStartAtUtc,
        result.bundle!.sleepAdjustment!.newEndAtUtc,
      ),
    ).toBe(420);
  });

  it("uses real elapsed instants across local midnight and a DST transition", () => {
    const dstCharacter: SelfPlanningCharacterLike = {
      ...character,
      identity: {
        ...character.identity,
        timezone: "America/New_York",
      },
    };
    const result = planSelfInitiatedActivity({
      character: dstCharacter,
      state,
      intents: [
        intent("dst-stargazing", {
          activity: "Stargazing after dark",
          desiredDurationMinutes: 60,
          earliestAtUtc: "2026-03-08T04:00:00.000Z",
          latestAtUtc: "2026-03-08T11:00:00.000Z",
        }),
      ],
      existingItems: [
        {
          id: "dst-sleep",
          startAtUtc: "2026-03-08T04:00:00.000Z",
          endAtUtc: "2026-03-08T11:00:00.000Z",
          status: "planned",
          category: "sleep",
          rigidity: "fixed",
        },
      ],
      nowUtc: "2026-03-08T03:55:00.000Z",
      horizonEndAtUtc: "2026-03-08T12:00:00.000Z",
      bufferMinutes: 0,
    });

    expect(result.targetLocalDay).toBe("2026-03-07");
    expect(result.bundle?.sleepAdjustment).toEqual({
      sleepItemId: "dst-sleep",
      newStartAtUtc: "2026-03-08T05:00:00.000Z",
      newEndAtUtc: "2026-03-08T11:00:00.000Z",
      lostSleepMinutes: 60,
    });
    expect(
      minutesBetween(
        result.bundle!.sleepAdjustment!.newStartAtUtc,
        result.bundle!.sleepAdjustment!.newEndAtUtc,
      ),
    ).toBe(360);
  });

  it("scales night fatigue with lost sleep, current debt, and next-day workload", () => {
    const plan = (
      durationMinutes: number,
      sleepDebtMinutes: number,
      withWorkload: boolean,
    ) =>
      planSelfInitiatedActivity({
        character,
        state: { ...state, sleepDebtMinutes },
        intents: [
          intent(`night-${durationMinutes}-${sleepDebtMinutes}`, {
            activity: "Night photography",
            desiredDurationMinutes: durationMinutes,
            earliestAtUtc: "2026-06-01T22:00:00.000Z",
            latestAtUtc: "2026-06-02T08:00:00.000Z",
          }),
        ],
        existingItems: [
          {
            id: "sleep-1",
            startAtUtc: "2026-06-01T22:00:00.000Z",
            endAtUtc: "2026-06-02T08:00:00.000Z",
            status: "planned",
            category: "sleep",
            rigidity: "fixed",
          },
          ...(withWorkload
            ? [
                {
                  id: "work-1",
                  startAtUtc: "2026-06-02T08:00:00.000Z",
                  endAtUtc: "2026-06-02T16:00:00.000Z",
                  status: "planned",
                  category: "work",
                  rigidity: "fixed" as const,
                },
              ]
            : []),
        ],
        nowUtc: "2026-06-01T21:55:00.000Z",
        horizonEndAtUtc: "2026-06-02T16:00:00.000Z",
        bufferMinutes: 0,
      }).bundle!;

    const low = plan(60, 0, false).activity.stateEffects;
    const moreLost = plan(120, 0, false).activity.stateEffects;
    const debtAndWork = plan(60, 600, true).activity.stateEffects;

    expect(moreLost.energy!).toBeLessThan(low.energy!);
    expect(debtAndWork.energy!).toBeLessThan(low.energy!);
    expect(debtAndWork.focus!).toBeLessThan(low.focus!);
    expect(debtAndWork.stress!).toBeGreaterThan(low.stress!);
    expect(
      new Set([low.energy, moreLost.energy, debtAndWork.energy]).size,
    ).toBe(3);
  });
});
