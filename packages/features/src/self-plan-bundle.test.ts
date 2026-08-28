import type {
  ScheduleMutationBundle,
  SelfPlanBundle,
  ServerScheduleItemDraft,
} from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import {
  scheduleSourceForOwner,
  validateFinalScheduleProjection,
  type FinalScheduleProjectionContext,
} from "./self-plan-bundle.js";
import type { ScheduleItemLike } from "./schedule-validator.js";

const NOW = "2026-06-01T08:00:00.000Z";
const policy = {
  horizonHours: 72,
  maxCommittedHoursPerDay: 10,
  sleepWindow: { startLocal: "23:00", endLocal: "07:00" },
};

function item(
  id: string,
  startAtUtc: string,
  endAtUtc: string,
  rigidity: ScheduleItemLike["rigidity"] = "flexible",
  category = "study",
  agentId = "agent-1",
): ScheduleItemLike {
  return {
    id,
    agentId,
    title: category === "sleep" ? "sleep" : "existing activity",
    description: "test fixture",
    category,
    startAtUtc,
    endAtUtc,
    timezone: "UTC",
    status: "planned",
    rigidity,
    priority: 0.7,
    source: "initial_plan",
    adherenceProbability: 0.9,
    narrativeImportance: 0.5,
    shareable: category !== "sleep",
    stateEffects: {},
    revision: 2,
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  };
}

function activity(
  startAtUtc: string,
  endAtUtc: string,
  title = "self activity",
): ServerScheduleItemDraft {
  return {
    title,
    description: "server planner fixture",
    category: "leisure",
    startAtUtc,
    endAtUtc,
    timezone: "UTC",
    rigidity: "flexible",
    priority: 0.6,
    adherenceProbability: 0.8,
    narrativeImportance: 0.7,
    shareable: true,
    stateEffects: { energy: -0.1 },
  };
}

function historicalSelfInitiated(
  id: string,
  startAtUtc: string,
  endAtUtc: string,
  overrides: Partial<ScheduleItemLike> = {},
): ScheduleItemLike {
  return {
    ...item(id, startAtUtc, endAtUtc, "flexible", "leisure"),
    title: "historical self-initiated night activity",
    source: "self_initiated",
    status: "completed",
    ...overrides,
  };
}

function context(
  existingItems: readonly ScheduleItemLike[],
  minimumSleepMinutes?: number,
  overrides: Partial<FinalScheduleProjectionContext> = {},
): FinalScheduleProjectionContext {
  return {
    agentId: "agent-1",
    nowUtc: NOW,
    timezone: "UTC",
    existingItems,
    policy,
    ...(minimumSleepMinutes === undefined ? {} : { minimumSleepMinutes }),
    ...overrides,
  };
}

describe("authoritative final schedule projection", () => {
  it("validates cancellation plus creation against the final snapshot", () => {
    const existing = item(
      "flexible-1",
      "2026-06-01T18:00:00.000Z",
      "2026-06-01T20:00:00.000Z",
    );
    const bundle: ScheduleMutationBundle = {
      owner: "manual",
      create: [
        activity(
          "2026-06-01T18:00:00.000Z",
          "2026-06-01T20:00:00.000Z",
          "replacement activity",
        ),
      ],
      cancel: [{ itemId: existing.id, expectedRevision: existing.revision }],
    };

    const result = validateFinalScheduleProjection(bundle, context([existing]));

    expect(result.ok).toBe(true);
    expect(
      result.projectedItems.find((entry) => entry.id === existing.id)?.status,
    ).toBe("cancelled");
    expect(result.createdItems).toHaveLength(1);
    expect(result.createdItems[0]?.source).toBe("manual");
  });

  it("rejects final conflicts and exposes no partial projection", () => {
    const fixed = item(
      "fixed-1",
      "2026-06-01T12:00:00.000Z",
      "2026-06-01T13:00:00.000Z",
      "fixed",
      "work",
    );
    const bundle: ScheduleMutationBundle = {
      owner: "manual",
      create: [
        activity("2026-06-01T12:30:00.000Z", "2026-06-01T13:30:00.000Z"),
      ],
    };

    const result = validateFinalScheduleProjection(bundle, context([fixed]));

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("OVERLAP_FIXED");
    expect(result.projectedItems).toEqual([fixed]);
    expect(result.createdItems).toHaveLength(0);
  });

  it("keeps fixed and committed items immovable and rolls back all changes", () => {
    const fixed = item(
      "fixed-1",
      "2026-06-01T12:00:00.000Z",
      "2026-06-01T13:00:00.000Z",
      "fixed",
      "work",
    );
    const committed = item(
      "committed-1",
      "2026-06-01T15:00:00.000Z",
      "2026-06-01T16:00:00.000Z",
      "committed",
      "work",
    );
    const bundle: ScheduleMutationBundle = {
      owner: "user_negotiation",
      create: [
        activity("2026-06-01T10:00:00.000Z", "2026-06-01T11:00:00.000Z"),
      ],
      reschedule: [
        {
          itemId: fixed.id,
          newStartAtUtc: "2026-06-01T13:00:00.000Z",
          newEndAtUtc: "2026-06-01T14:00:00.000Z",
        },
      ],
      cancel: [{ itemId: committed.id }],
    };

    const result = validateFinalScheduleProjection(
      bundle,
      context([fixed, committed]),
    );
    const codes = result.errors.map((error) => error.code);

    expect(codes).toContain("FIXED_ITEM_IMMUTABLE");
    expect(codes).toContain("COMMITTED_ITEM_IMMUTABLE");
    expect(result.projectedItems).toEqual([fixed, committed]);
    expect(result.createdItems).toHaveLength(0);
    expect(result.changedItems).toHaveLength(0);
  });

  it("maps only server capabilities to persisted schedule sources", () => {
    expect(scheduleSourceForOwner("routine")).toBe("routine");
    expect(scheduleSourceForOwner("user_negotiation")).toBe("user_invitation");
    expect(scheduleSourceForOwner("self_planner")).toBe("self_initiated");
    expect(scheduleSourceForOwner("manual")).toBe("manual");
  });
});

describe("night self-plan bundles", () => {
  it("atomically creates the activity and shortens only its paired sleep", () => {
    const sleep = item(
      "sleep-1",
      "2026-06-01T23:00:00.000Z",
      "2026-06-02T07:00:00.000Z",
      "fixed",
      "sleep",
    );
    const bundle: SelfPlanBundle = {
      intentId: "intent-1",
      activity: activity(
        "2026-06-01T23:00:00.000Z",
        "2026-06-02T01:00:00.000Z",
        "night stargazing",
      ),
      sleepAdjustment: {
        sleepItemId: sleep.id,
        newStartAtUtc: "2026-06-02T01:00:00.000Z",
        newEndAtUtc: "2026-06-02T07:00:00.000Z",
        lostSleepMinutes: 120,
      },
    };

    const result = validateFinalScheduleProjection(
      bundle,
      context([sleep], 360),
    );

    expect(result.ok).toBe(true);
    expect(result.createdItems[0]).toMatchObject({
      title: "night stargazing",
      source: "self_initiated",
    });
    expect(result.changedItems).toEqual([
      expect.objectContaining({
        id: sleep.id,
        startAtUtc: "2026-06-02T01:00:00.000Z",
        endAtUtc: "2026-06-02T07:00:00.000Z",
        plannedSleepReductionMinutes: 120,
        revision: sleep.revision + 1,
      }),
    ]);
    expect(result.lostSleepMinutes).toBe(120);
  });

  it("rejects a false sleep-loss declaration atomically", () => {
    const sleep = item(
      "sleep-1",
      "2026-06-01T23:00:00.000Z",
      "2026-06-02T07:00:00.000Z",
      "fixed",
      "sleep",
    );
    const bundle: SelfPlanBundle = {
      intentId: "intent-1",
      activity: activity(
        "2026-06-01T23:00:00.000Z",
        "2026-06-02T01:00:00.000Z",
      ),
      sleepAdjustment: {
        sleepItemId: sleep.id,
        newStartAtUtc: "2026-06-02T01:00:00.000Z",
        newEndAtUtc: "2026-06-02T07:00:00.000Z",
        lostSleepMinutes: 60,
      },
    };

    const result = validateFinalScheduleProjection(
      bundle,
      context([sleep], 360),
    );

    expect(result.errors.map((error) => error.code)).toContain(
      "LOST_SLEEP_MISMATCH",
    );
    expect(result.projectedItems).toEqual([sleep]);
    expect(result.lostSleepMinutes).toBe(0);
  });

  it("rejects five-hour sleep adjustments under the canonical default", () => {
    const sleep = item(
      "sleep-1",
      "2026-06-01T23:00:00.000Z",
      "2026-06-02T07:00:00.000Z",
      "fixed",
      "sleep",
    );
    const bundle: SelfPlanBundle = {
      intentId: "intent-1",
      activity: activity(
        "2026-06-01T23:00:00.000Z",
        "2026-06-02T02:00:00.000Z",
      ),
      sleepAdjustment: {
        sleepItemId: sleep.id,
        newStartAtUtc: "2026-06-02T02:00:00.000Z",
        newEndAtUtc: "2026-06-02T07:00:00.000Z",
        lostSleepMinutes: 180,
      },
    };

    const result = validateFinalScheduleProjection(bundle, context([sleep]));

    expect(result.errors.map((error) => error.code)).toContain(
      "MINIMUM_SLEEP_REQUIRED",
    );
    expect(result.projectedItems).toEqual([sleep]);
    expect(result.createdItems).toHaveLength(0);
  });

  it("cannot adjust another agent's sleep", () => {
    const foreignSleep = item(
      "foreign-sleep",
      "2026-06-01T23:00:00.000Z",
      "2026-06-02T07:00:00.000Z",
      "fixed",
      "sleep",
      "agent-2",
    );
    const bundle: SelfPlanBundle = {
      intentId: "intent-1",
      activity: activity(
        "2026-06-01T23:00:00.000Z",
        "2026-06-02T01:00:00.000Z",
      ),
      sleepAdjustment: {
        sleepItemId: foreignSleep.id,
        newStartAtUtc: "2026-06-02T01:00:00.000Z",
        newEndAtUtc: "2026-06-02T07:00:00.000Z",
        lostSleepMinutes: 120,
      },
    };

    const result = validateFinalScheduleProjection(
      bundle,
      context([foreignSleep], 360),
    );

    expect(result.errors.map((error) => error.code)).toContain(
      "ITEM_OWNERSHIP_MISMATCH",
    );
    expect(result.projectedItems).toEqual([foreignSleep]);
  });

  it("rejects a paired night plan when the default rolling seven-day limit is already reached", () => {
    const history = [
      historicalSelfInitiated(
        "night-history-1",
        "2026-05-27T23:00:00.000Z",
        "2026-05-28T01:00:00.000Z",
      ),
      historicalSelfInitiated(
        "night-history-2",
        "2026-05-30T23:00:00.000Z",
        "2026-05-31T01:00:00.000Z",
      ),
    ];
    const sleep = item(
      "sleep-1",
      "2026-06-01T23:00:00.000Z",
      "2026-06-02T07:00:00.000Z",
      "fixed",
      "sleep",
    );
    const bundle: SelfPlanBundle = {
      intentId: "intent-limit",
      activity: activity(
        "2026-06-01T23:00:00.000Z",
        "2026-06-02T01:00:00.000Z",
        "night plan at limit",
      ),
      sleepAdjustment: {
        sleepItemId: sleep.id,
        newStartAtUtc: "2026-06-02T01:00:00.000Z",
        newEndAtUtc: "2026-06-02T07:00:00.000Z",
        lostSleepMinutes: 120,
      },
    };

    const existing = [...history, sleep];
    const result = validateFinalScheduleProjection(
      bundle,
      context(existing, 360),
    );

    expect(result.errors.map((error) => error.code)).toContain(
      "NIGHT_SELF_PLAN_FREQUENCY_LIMIT",
    );
    expect(result.projectedItems).toEqual(existing);
    expect(result.createdItems).toHaveLength(0);
  });

  it("excludes cancelled, non-self-initiated, and non-night activities from the count", () => {
    const cancelledNight = historicalSelfInitiated(
      "cancelled-night",
      "2026-05-28T23:00:00.000Z",
      "2026-05-29T01:00:00.000Z",
      { status: "cancelled" },
    );
    const otherSourceNight = historicalSelfInitiated(
      "initial-night",
      "2026-05-29T23:00:00.000Z",
      "2026-05-30T01:00:00.000Z",
      { source: "initial_plan" },
    );
    const daytimeSelfPlan = historicalSelfInitiated(
      "daytime-self-plan",
      "2026-05-30T12:00:00.000Z",
      "2026-05-30T14:00:00.000Z",
    );
    const sleep = item(
      "sleep-1",
      "2026-06-01T23:00:00.000Z",
      "2026-06-02T07:00:00.000Z",
      "fixed",
      "sleep",
    );
    const bundle: SelfPlanBundle = {
      intentId: "intent-exclusions",
      activity: activity(
        "2026-06-01T23:00:00.000Z",
        "2026-06-02T01:00:00.000Z",
      ),
      sleepAdjustment: {
        sleepItemId: sleep.id,
        newStartAtUtc: "2026-06-02T01:00:00.000Z",
        newEndAtUtc: "2026-06-02T07:00:00.000Z",
        lostSleepMinutes: 120,
      },
    };

    const result = validateFinalScheduleProjection(
      bundle,
      context([cancelledNight, otherSourceNight, daytimeSelfPlan, sleep], 360, {
        maxNightSelfPlansPerRolling7Days: 1,
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.createdItems).toHaveLength(1);
    expect(result.createdItems[0]?.source).toBe("self_initiated");
  });

  it("counts cross-midnight night plans through a DST transition using real instants", () => {
    const timezone = "America/New_York";
    const historicalNight = historicalSelfInitiated(
      "dst-history",
      "2026-10-29T03:00:00.000Z",
      "2026-10-29T05:00:00.000Z",
      { timezone },
    );
    const sleep = {
      ...item(
        "dst-sleep",
        "2026-11-01T03:00:00.000Z",
        "2026-11-01T12:00:00.000Z",
        "fixed",
        "sleep",
      ),
      timezone,
    };
    const bundle: SelfPlanBundle = {
      intentId: "intent-dst-limit",
      activity: {
        ...activity(
          "2026-11-01T03:00:00.000Z",
          "2026-11-01T07:00:00.000Z",
          "DST night plan",
        ),
        timezone,
      },
      sleepAdjustment: {
        sleepItemId: sleep.id,
        newStartAtUtc: "2026-11-01T07:00:00.000Z",
        newEndAtUtc: "2026-11-01T12:00:00.000Z",
        lostSleepMinutes: 240,
      },
    };

    const result = validateFinalScheduleProjection(
      bundle,
      context([historicalNight, sleep], 300, {
        timezone,
        nowUtc: "2026-11-01T02:00:00.000Z",
        maxNightSelfPlansPerRolling7Days: 1,
      }),
    );

    expect(result.errors.map((error) => error.code)).toContain(
      "NIGHT_SELF_PLAN_FREQUENCY_LIMIT",
    );
    expect(result.projectedItems).toEqual([historicalNight, sleep]);
  });

  it("rejects an invalid rolling-night limit as projection context", () => {
    const sleep = item(
      "sleep-1",
      "2026-06-01T23:00:00.000Z",
      "2026-06-02T07:00:00.000Z",
      "fixed",
      "sleep",
    );
    const bundle: SelfPlanBundle = {
      intentId: "intent-invalid-limit",
      activity: activity(
        "2026-06-01T23:00:00.000Z",
        "2026-06-02T01:00:00.000Z",
      ),
      sleepAdjustment: {
        sleepItemId: sleep.id,
        newStartAtUtc: "2026-06-02T01:00:00.000Z",
        newEndAtUtc: "2026-06-02T07:00:00.000Z",
        lostSleepMinutes: 120,
      },
    };

    const result = validateFinalScheduleProjection(
      bundle,
      context([sleep], 360, {
        maxNightSelfPlansPerRolling7Days: -1,
      }),
    );

    expect(result.errors).toContainEqual({
      code: "INVALID_CONTEXT",
      path: "maxNightSelfPlansPerRolling7Days",
      message:
        "maxNightSelfPlansPerRolling7Days must be a non-negative integer",
    });
  });
});
