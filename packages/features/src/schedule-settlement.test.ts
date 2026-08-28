import { describe, expect, it } from "vitest";

import { plan72h } from "./schedule-planner.js";
import {
  type ScheduleItemLike,
  validateScheduleProposal,
  validateScheduleProposals,
} from "./schedule-validator.js";
import { computeActivitySeed, settleSchedule } from "./settlement-engine.js";
import { seededUnit } from "./shared.js";
import { calculateActivityCompletionProbability } from "./state-engine.js";

const NOW = "2026-06-01T08:00:00.000Z";

function item(
  id: string,
  startAtUtc: string,
  endAtUtc: string,
  rigidity: ScheduleItemLike["rigidity"] = "flexible",
  category = "study",
): ScheduleItemLike {
  return {
    id,
    agentId: "agent-1",
    title: category === "sleep" ? "睡眠" : "自习",
    description: "test",
    category,
    startAtUtc,
    endAtUtc,
    timezone: "UTC",
    status: "planned",
    rigidity,
    priority: 0.8,
    source: "initial_plan",
    adherenceProbability: 0.95,
    narrativeImportance: 0.7,
    shareable: category !== "sleep",
    stateEffects: { energy: -0.1, focus: -0.1 },
    revision: 0,
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  };
}

const policy = {
  horizonHours: 72,
  maxCommittedHoursPerDay: 10,
  sleepWindow: { startLocal: "23:00", endLocal: "08:00" },
};

describe("schedule validation", () => {
  it("rejects changes to fixed items", () => {
    const fixed = item(
      "fixed-1",
      "2026-06-01T10:00:00.000Z",
      "2026-06-01T11:00:00.000Z",
      "fixed",
      "work",
    );
    const result = validateScheduleProposal(
      {
        operation: "reschedule",
        itemId: fixed.id,
        newStartAtUtc: "2026-06-01T12:00:00.000Z",
        newEndAtUtc: "2026-06-01T13:00:00.000Z",
        reasonCode: "user_request",
        reasonSummary: "requested",
      },
      {
        agentId: "agent-1",
        nowUtc: NOW,
        timezone: "UTC",
        existingItems: [fixed],
        policy,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain(
      "FIXED_ITEM_IMMUTABLE",
    );
  });

  it("uses the canonical six-hour minimum for legacy sleep reschedules", () => {
    const sleep = item(
      "sleep-1",
      "2026-06-01T23:00:00.000Z",
      "2026-06-02T07:00:00.000Z",
      "flexible",
      "sleep",
    );
    const validateStart = (newStartAtUtc: string) =>
      validateScheduleProposal(
        {
          operation: "reschedule",
          itemId: sleep.id,
          newStartAtUtc,
          newEndAtUtc: "2026-06-02T07:00:00.000Z",
          reasonCode: "user_request",
          reasonSummary: "requested",
        },
        {
          agentId: "agent-1",
          nowUtc: NOW,
          timezone: "UTC",
          existingItems: [sleep],
          policy,
        },
      );

    const fiveHour = validateStart("2026-06-02T02:00:00.000Z");
    const sixHour = validateStart("2026-06-02T01:00:00.000Z");

    expect(fiveHour.errors.map((error) => error.code)).toContain(
      "SLEEP_REQUIRED",
    );
    expect(sixHour.ok).toBe(true);
  });

  it("validates cancellation and creation as one projected proposal sequence", () => {
    const study = item(
      "study-1",
      "2026-06-01T18:00:00.000Z",
      "2026-06-01T21:00:00.000Z",
    );
    const result = validateScheduleProposals(
      [
        {
          operation: "cancel",
          itemId: study.id,
          reasonCode: "accepted_invitation",
          reasonSummary: "接受邀请",
        },
        {
          operation: "create",
          item: {
            title: "晚会",
            description: "和用户参加晚会",
            category: "social",
            startAtUtc: "2026-06-01T18:00:00.000Z",
            endAtUtc: "2026-06-01T21:00:00.000Z",
            timezone: "UTC",
            rigidity: "committed",
            priority: 0.8,
            source: "user_invitation",
            adherenceProbability: 0.9,
            narrativeImportance: 0.85,
            shareable: true,
            stateEffects: { moodValence: 0.1 },
          },
          reasonCode: "accepted_invitation",
          reasonSummary: "接受邀请",
        },
      ],
      {
        agentId: "agent-1",
        nowUtc: NOW,
        timezone: "UTC",
        existingItems: [study],
        policy,
      },
    );

    expect(result.ok).toBe(true);
    expect(
      result.projectedItems.find((entry) => entry.id === study.id)?.status,
    ).toBe("cancelled");
  });

  it("rejects sleep intrusion, horizon overflow and daily commitment overflow", () => {
    const existing = item(
      "work-1",
      "2026-06-01T09:00:00.000Z",
      "2026-06-01T19:00:00.000Z",
      "committed",
      "work",
    );
    const result = validateScheduleProposal(
      {
        operation: "create",
        item: {
          title: "深夜工作",
          description: "too much",
          category: "work",
          startAtUtc: "2026-06-01T23:00:00.000Z",
          endAtUtc: "2026-06-02T02:00:00.000Z",
          timezone: "UTC",
          rigidity: "committed",
          priority: 0.8,
          source: "runtime_replan",
          adherenceProbability: 0.8,
          narrativeImportance: 0.4,
          shareable: false,
          stateEffects: { stress: 0.1 },
        },
        reasonCode: "user_request",
        reasonSummary: "requested",
      },
      {
        agentId: "agent-1",
        nowUtc: NOW,
        timezone: "UTC",
        existingItems: [existing],
        policy,
      },
    );

    expect(result.errors.map((error) => error.code)).toContain(
      "SLEEP_WINDOW_VIOLATION",
    );
    expect(result.errors.map((error) => error.code)).toContain(
      "DAILY_COMMITMENT_LIMIT",
    );
  });
});

describe("planner and settlement", () => {
  it("plans repeatable sleep and meals without overlaps", () => {
    const planned = plan72h({
      nowUtc: NOW,
      character: {
        id: "agent-1",
        identity: { name: "林澈", workOrRole: "学生", timezone: "UTC" },
        routines: [
          {
            id: "routine-1",
            title: "下午阅读",
            category: "study",
            recurrence: "daily",
            preferredStartLocal: "15:00",
            preferredDurationMinutes: 90,
            rigidity: "flexible",
            priority: 0.7,
          },
        ],
        schedulePolicy: {
          enabled: true,
          horizonHours: 72,
          sleepWindow: { startLocal: "23:00", endLocal: "08:00" },
          maxCommittedHoursPerDay: 10,
          routineAdherence: 0.8,
        },
      },
    });

    expect(planned.some((entry) => entry.category === "sleep")).toBe(true);
    expect(planned.some((entry) => entry.category === "meal")).toBe(true);
    for (const [index, left] of planned.entries()) {
      for (const right of planned.slice(index + 1)) {
        expect(Date.parse(left.endAtUtc) <= Date.parse(right.startAtUtc)).toBe(
          true,
        );
      }
    }
  });

  it("uses stable outcomes, idempotency and never reopens terminal items", () => {
    const scheduled = item(
      "fixed-completion",
      "2026-06-01T09:00:00.000Z",
      "2026-06-01T10:00:00.000Z",
      "fixed",
      "work",
    );
    const state = {
      agentId: "agent-1",
      asOfUtc: NOW,
      moodValence: 0,
      moodArousal: 0.5,
      energy: 0.6,
      stress: 0.2,
      socialBattery: 0.6,
      focus: 0.7,
      revision: 0,
    };
    const first = settleSchedule({
      agentId: "agent-1",
      fromUtc: NOW,
      toUtc: "2026-06-01T11:00:00.000Z",
      items: [scheduled],
      state,
      routineAdherence: 0.8,
    });
    const same = settleSchedule({
      agentId: "agent-1",
      fromUtc: NOW,
      toUtc: "2026-06-01T11:00:00.000Z",
      items: [scheduled],
      state,
      routineAdherence: 0.8,
    });
    expect(first.events).toEqual(same.events);
    expect(first.items[0]?.status).not.toBe("planned");
    expect(first.state.energy).toBeGreaterThanOrEqual(0);
    expect(first.state.energy).toBeLessThanOrEqual(1);

    const duplicate = settleSchedule({
      agentId: "agent-1",
      fromUtc: NOW,
      toUtc: "2026-06-01T11:00:00.000Z",
      items: first.items,
      state: first.state,
      routineAdherence: 0.8,
      existingIdempotencyKeys: [first.idempotencyKey],
    });
    expect(duplicate.skippedAsDuplicate).toBe(true);
    expect(duplicate.events).toHaveLength(0);
    expect(duplicate.items[0]?.status).toBe(first.items[0]?.status);

    const eventReplay = settleSchedule({
      agentId: "agent-1",
      fromUtc: NOW,
      toUtc: "2026-06-01T11:00:00.000Z",
      items: [scheduled],
      state,
      routineAdherence: 0.8,
      existingIdempotencyKeys: first.events.map(
        (event) => event.idempotencyKey,
      ),
    });
    expect(eventReplay.events).toEqual([]);
    expect(eventReplay.state.revision).toBe(state.revision);
  });

  it("evaluates each terminal activity from the preceding post-state", () => {
    const state = {
      agentId: "agent-1",
      asOfUtc: NOW,
      moodValence: 0,
      moodArousal: 0.5,
      energy: 0.95,
      stress: 0.05,
      socialBattery: 0.6,
      focus: 0.7,
      revision: 0,
    };
    const first = {
      ...item(
        "exhausting-fixed-activity",
        "2026-06-01T08:15:00.000Z",
        "2026-06-01T09:00:00.000Z",
        "fixed",
        "work",
      ),
      adherenceProbability: 1,
      stateEffects: { energy: -0.5, stress: 0.5 },
    };
    const probabilityBefore = calculateActivityCompletionProbability({
      adherenceProbability: 0.4,
      routineAdherence: 0.5,
      rigidity: "flexible",
      energy: state.energy,
      stress: state.stress,
    });
    const probabilityAfterFirst = calculateActivityCompletionProbability({
      adherenceProbability: 0.4,
      routineAdherence: 0.5,
      rigidity: "flexible",
      energy: state.energy - 0.5,
      stress: state.stress + 0.5,
    });
    let later: ScheduleItemLike | undefined;
    for (let index = 0; index < 10_000; index += 1) {
      const candidate = {
        ...item(
          `state-sensitive-later-${index}`,
          "2026-06-01T09:00:00.000Z",
          "2026-06-01T10:00:00.000Z",
        ),
        adherenceProbability: 0.4,
      };
      const roll = seededUnit(
        computeActivitySeed(candidate.agentId, candidate),
      );
      if (roll >= probabilityAfterFirst && roll < probabilityBefore) {
        later = candidate;
        break;
      }
    }
    expect(later).toBeDefined();

    const settled = settleSchedule({
      agentId: "agent-1",
      fromUtc: NOW,
      toUtc: "2026-06-01T11:00:00.000Z",
      items: [later!, first],
      state,
      routineAdherence: 0.5,
    });

    const settledById = new Map(
      settled.items.map((entry) => [entry.id, entry]),
    );
    expect(settledById.get(first.id)?.status).toBe("completed");
    expect(settledById.get(later!.id)?.status).not.toBe("completed");
    expect(probabilityAfterFirst).toBeLessThan(probabilityBefore);

    const terminalEvents = settled.events.filter(
      (event) => event.kind !== "started",
    );
    expect(terminalEvents.map((event) => event.scheduleItemId)).toEqual([
      first.id,
      later!.id,
    ]);
    expect(terminalEvents[0]?.effectTrace).toMatchObject({
      reasonCode: "seeded_probability_completed",
      stateRevisionBefore: 0,
      stateRevisionAfter: 1,
    });
    expect(terminalEvents[1]?.effectTrace).toMatchObject({
      reasonCode: `seeded_probability_${settledById.get(later!.id)?.status}`,
      stateRevisionBefore: 1,
      stateRevisionAfter: 2,
      stateBefore: {
        stress: 0.55,
        revision: 1,
      },
    });
    expect(terminalEvents[1]?.effectTrace?.stateBefore.energy).toBeCloseTo(
      0.45,
    );
    expect(
      terminalEvents[0]?.effectTrace?.appliedStateDelta.energy,
    ).toBeCloseTo(-0.5);
    expect(terminalEvents[1]?.effectTrace?.outcomeProbability).toBeCloseTo(
      probabilityAfterFirst,
      12,
    );
    expect(terminalEvents[1]?.effectTrace?.outcomeRoll).toBeCloseTo(
      seededUnit(computeActivitySeed(later!.agentId, later!)),
      12,
    );
    expect(settled.state.revision).toBe(2);

    expect(
      settled.events.map((event) => [
        event.occurredAtUtc,
        event.scheduleItemId,
        event.kind,
      ]),
    ).toEqual([
      ["2026-06-01T08:15:00.000Z", first.id, "started"],
      ["2026-06-01T09:00:00.000Z", first.id, "completed"],
      ["2026-06-01T09:00:00.000Z", later!.id, "started"],
      [
        "2026-06-01T10:00:00.000Z",
        later!.id,
        settledById.get(later!.id)?.status,
      ],
    ]);

    const orderedInput = settleSchedule({
      agentId: "agent-1",
      fromUtc: NOW,
      toUtc: "2026-06-01T11:00:00.000Z",
      items: [first, later!],
      state,
      routineAdherence: 0.5,
    });
    expect(orderedInput.events).toEqual(settled.events);
    expect(orderedInput.state).toEqual(settled.state);
  });

  it("orders simultaneous terminal causes by item id", () => {
    const state = {
      agentId: "agent-1",
      asOfUtc: NOW,
      moodValence: 0,
      moodArousal: 0.5,
      energy: 0.8,
      stress: 0.2,
      socialBattery: 0.6,
      focus: 0.7,
      revision: 0,
    };
    const completedFixedItem = (
      prefix: string,
      startAtUtc: string,
    ): ScheduleItemLike => {
      for (let index = 0; index < 10_000; index += 1) {
        const candidate = {
          ...item(
            `${prefix}-${index}`,
            startAtUtc,
            "2026-06-01T10:00:00.000Z",
            "fixed",
            "work",
          ),
          adherenceProbability: 1,
          stateEffects: { energy: -0.1 },
        };
        if (
          seededUnit(computeActivitySeed(candidate.agentId, candidate)) < 0.9
        ) {
          return candidate;
        }
      }
      throw new Error("Unable to find a stable completed activity fixture");
    };
    const firstById = completedFixedItem(
      "terminal-a",
      "2026-06-01T08:30:00.000Z",
    );
    const secondById = completedFixedItem(
      "terminal-b",
      "2026-06-01T08:45:00.000Z",
    );

    const settled = settleSchedule({
      agentId: "agent-1",
      fromUtc: NOW,
      toUtc: "2026-06-01T11:00:00.000Z",
      items: [secondById, firstById],
      state,
      routineAdherence: 1,
    });
    const terminals = settled.events.filter(
      (event) => event.kind !== "started",
    );

    expect(terminals.map((event) => event.scheduleItemId)).toEqual([
      firstById.id,
      secondById.id,
    ]);
    expect(
      terminals.map((event) => [
        event.effectTrace?.stateRevisionBefore,
        event.effectTrace?.stateRevisionAfter,
      ]),
    ).toEqual([
      [0, 1],
      [1, 2],
    ]);
  });

  it("gradually repays sleep debt when sleep settles", () => {
    const sleep = {
      ...item(
        "sleep-repayment",
        "2026-06-01T23:00:00.000Z",
        "2026-06-02T07:00:00.000Z",
        "fixed",
        "sleep",
      ),
      adherenceProbability: 1,
      stateEffects: { energy: 0.2, stress: -0.08 },
    };
    const sleepyState = {
      agentId: "agent-1",
      asOfUtc: "2026-06-01T22:00:00.000Z",
      moodValence: 0,
      moodArousal: 0.4,
      energy: 0.35,
      stress: 0.45,
      socialBattery: 0.6,
      focus: 0.45,
      sleepDebtMinutes: 600,
      revision: 0,
    };
    const input = {
      agentId: "agent-1",
      fromUtc: "2026-06-01T22:00:00.000Z",
      toUtc: "2026-06-02T08:00:00.000Z",
      items: [sleep],
      state: sleepyState,
      routineAdherence: 1,
    } as const;

    const first = settleSchedule(input);
    const replay = settleSchedule(input);

    expect(first.events.map((event) => event.kind)).toContain("completed");
    // 480 completed minutes repay 240 at SLEEP_DEBT_RECOVERY_RATE 0.5.
    expect(first.state.sleepDebtMinutes).toBe(360);
    expect(first.state.sleepDebtMinutes).toBeLessThan(600);
    expect(
      first.events.find((event) => event.kind === "completed")?.effectTrace,
    ).toMatchObject({
      appliedStateDelta: { sleepDebtMinutes: -240 },
      sleepDebt: {
        debtBefore: 600,
        plannedReductionMinutes: 0,
        missedScheduledMinutes: 0,
        recoveryMinutes: 240,
        debtAfter: 360,
      },
    });
    expect(replay.state.sleepDebtMinutes).toBe(first.state.sleepDebtMinutes);
  });

  it.each([
    ["completed", 120, 0],
    ["partial", 300, 180],
    ["skipped", 480, 360],
  ] as const)(
    "realizes planned and missed sleep debt only after a %s outcome",
    (expectedStatus, expectedDebt, expectedMissedMinutes) => {
      const state = {
        agentId: "agent-1",
        asOfUtc: "2026-06-01T22:00:00.000Z",
        moodValence: 0,
        moodArousal: 0.4,
        energy: 0.5,
        stress: 0.5,
        socialBattery: 0.6,
        focus: 0.45,
        sleepDebtMinutes: 0,
        revision: 0,
      };
      const probability = calculateActivityCompletionProbability({
        adherenceProbability: 0,
        routineAdherence: 0,
        rigidity: "flexible",
        energy: state.energy,
        stress: state.stress,
      });
      let sleep: ScheduleItemLike | undefined;
      for (let index = 0; index < 10_000; index += 1) {
        const candidate = {
          ...item(
            `planned-reduction-${expectedStatus}-${index}`,
            "2026-06-02T01:00:00.000Z",
            "2026-06-02T07:00:00.000Z",
            "flexible",
            "sleep",
          ),
          adherenceProbability: 0,
          plannedSleepReductionMinutes: 120,
          stateEffects: {},
        };
        const roll = seededUnit(
          computeActivitySeed(candidate.agentId, candidate),
        );
        const status =
          roll < probability
            ? "completed"
            : roll < probability + (1 - probability) * 0.45
              ? "partial"
              : "skipped";
        if (status === expectedStatus) {
          sleep = candidate;
          break;
        }
      }
      expect(sleep).toBeDefined();

      const settled = settleSchedule({
        agentId: "agent-1",
        fromUtc: "2026-06-01T22:00:00.000Z",
        toUtc: "2026-06-02T08:00:00.000Z",
        items: [sleep!],
        state,
        routineAdherence: 0,
      });
      const terminal = settled.events.find((event) => event.kind !== "started");

      expect(terminal?.kind).toBe(expectedStatus);
      expect(settled.state.sleepDebtMinutes).toBe(expectedDebt);
      expect(terminal?.effectTrace).toMatchObject({
        stateRevisionBefore: 0,
        stateRevisionAfter: 1,
        appliedStateDelta: { sleepDebtMinutes: expectedDebt },
        sleepDebt: {
          debtBefore: 0,
          plannedReductionMinutes: 120,
          missedScheduledMinutes: expectedMissedMinutes,
          recoveryMinutes: 0,
          debtAfter: expectedDebt,
        },
      });
    },
  );

  it.each([
    ["completed", 0.006, 0.003, 0.002, 1],
    ["partial", 0.003, 0.001, 0.001, 0.5],
    ["skipped", -0.002, -0.003, 0, 0],
  ] as const)(
    "applies a bounded shared-activity relationship outcome after %s",
    (
      expectedStatus,
      closenessDelta,
      trustDelta,
      familiarityDelta,
      completionRatio,
    ) => {
      const state = {
        agentId: "agent-1",
        asOfUtc: NOW,
        moodValence: 0,
        moodArousal: 0.4,
        energy: 0.5,
        stress: 0.5,
        socialBattery: 0.6,
        focus: 0.45,
        sleepDebtMinutes: 0,
        relationship: {
          userId: "local-user",
          closeness: 0.2,
          trust: 0.25,
          familiarity: 0.1,
          recentInteractionValence: 0,
        },
        revision: 0,
      };
      const probability = calculateActivityCompletionProbability({
        adherenceProbability: 0,
        routineAdherence: 0,
        rigidity: "flexible",
        energy: state.energy,
        stress: state.stress,
      });
      let shared: ScheduleItemLike | undefined;
      for (let index = 0; index < 10_000; index += 1) {
        const candidate = {
          ...item(
            `shared-${expectedStatus}-${index}`,
            "2026-06-01T09:00:00.000Z",
            "2026-06-01T10:00:00.000Z",
          ),
          source: "user_invitation" as const,
          adherenceProbability: 0,
        };
        const roll = seededUnit(
          computeActivitySeed(candidate.agentId, candidate),
        );
        const status =
          roll < probability
            ? "completed"
            : roll < probability + (1 - probability) * 0.45
              ? "partial"
              : "skipped";
        if (status === expectedStatus) {
          shared = candidate;
          break;
        }
      }
      expect(shared).toBeDefined();

      const settled = settleSchedule({
        agentId: "agent-1",
        fromUtc: NOW,
        toUtc: "2026-06-01T11:00:00.000Z",
        items: [shared!],
        state,
        routineAdherence: 0,
        relationshipCapabilityScale: 1,
      });
      const terminal = settled.events.find((event) => event.kind !== "started");

      expect(terminal).toMatchObject({
        kind: expectedStatus,
        completionRatio,
        effectTrace: {
          relationshipSource: "shared_activity_outcome",
          relationship: {
            baselineDelta: { familiarity: 0 },
          },
        },
      });
      expect(settled.state.relationship).toMatchObject({
        closeness: 0.2 + closenessDelta,
        trust: 0.25 + trustDelta,
        familiarity: 0.1 + familiarityDelta,
        lastInteractionAtUtc: "2026-06-01T10:00:00.000Z",
      });
      expect(settled.relationshipDailyUsageApplied).toMatchObject({
        closeness: Math.abs(closenessDelta),
        trust: Math.abs(trustDelta),
      });
      expect(settled.state.revision).toBe(1);
    },
  );

  it("settles a cancelled shared activity once with a distinct relationship cause", () => {
    const cancelled = {
      ...item(
        "shared-cancelled",
        "2026-06-01T12:00:00.000Z",
        "2026-06-01T13:00:00.000Z",
      ),
      source: "user_invitation" as const,
      status: "cancelled" as const,
      updatedAtUtc: "2026-06-01T09:30:00.000Z",
      revision: 1,
    };
    const state = {
      agentId: "agent-1",
      asOfUtc: NOW,
      moodValence: 0,
      moodArousal: 0.4,
      energy: 0.5,
      stress: 0.5,
      socialBattery: 0.6,
      focus: 0.45,
      sleepDebtMinutes: 0,
      relationship: {
        userId: "local-user",
        closeness: 0.2,
        trust: 0.25,
        familiarity: 0.1,
        recentInteractionValence: 0,
      },
      revision: 0,
    };

    const settled = settleSchedule({
      agentId: "agent-1",
      fromUtc: NOW,
      toUtc: "2026-06-01T10:00:00.000Z",
      items: [cancelled],
      state,
      routineAdherence: 1,
      relationshipCapabilityScale: 1,
    });
    const cancelledEvent = settled.events.find(
      (event) => event.kind === "cancelled",
    );

    expect(cancelledEvent).toMatchObject({
      occurredAtUtc: cancelled.updatedAtUtc,
      effectTrace: {
        reasonCode: "schedule_cancelled",
        relationshipSource: "shared_activity_outcome",
      },
    });
    expect(cancelledEvent?.effectTrace).not.toHaveProperty(
      "outcomeProbability",
    );
    expect(cancelledEvent?.effectTrace).not.toHaveProperty("outcomeRoll");
    expect(settled.changedItems).toEqual([]);
    expect(settled.state.relationship).toMatchObject({
      closeness: 0.199,
      trust: 0.248,
      familiarity: 0.1,
      lastInteractionAtUtc: cancelled.updatedAtUtc,
    });

    const replay = settleSchedule({
      agentId: "agent-1",
      fromUtc: NOW,
      toUtc: "2026-06-01T10:00:00.000Z",
      items: [cancelled],
      state: settled.state,
      routineAdherence: 1,
      relationshipCapabilityScale: 1,
      existingIdempotencyKeys: [cancelledEvent!.idempotencyKey],
    });
    expect(replay.events).toEqual([]);
    expect(replay.state.revision).toBe(settled.state.revision);
  });

  it("clears the 720-minute sleep debt cap within three full nights", () => {
    const nights = [
      ["2026-06-01T23:00:00.000Z", "2026-06-02T07:00:00.000Z"],
      ["2026-06-02T23:00:00.000Z", "2026-06-03T07:00:00.000Z"],
      ["2026-06-03T23:00:00.000Z", "2026-06-04T07:00:00.000Z"],
    ] as const;
    const exhaustedState = {
      agentId: "agent-1",
      asOfUtc: "2026-06-01T22:00:00.000Z",
      moodValence: 0,
      moodArousal: 0.4,
      energy: 0.2,
      stress: 0.6,
      socialBattery: 0.5,
      focus: 0.3,
      sleepDebtMinutes: 720,
      revision: 0,
    };

    let state = exhaustedState;
    const remaining: number[] = [];
    for (const [index, [startAtUtc, endAtUtc]] of nights.entries()) {
      const settled = settleSchedule({
        agentId: "agent-1",
        fromUtc: `2026-06-0${index + 1}T22:00:00.000Z`,
        toUtc: `2026-06-0${index + 2}T08:00:00.000Z`,
        items: [
          {
            ...item(
              `sleep-cap-${index}`,
              startAtUtc,
              endAtUtc,
              "fixed",
              "sleep",
            ),
            adherenceProbability: 1,
            stateEffects: { energy: 0.2 },
          },
        ],
        state,
        routineAdherence: 1,
      } as const);
      state = settled.state;
      remaining.push(settled.state.sleepDebtMinutes ?? 0);
    }

    // 480 completed minutes repay 240 per night at SLEEP_DEBT_RECOVERY_RATE.
    expect(remaining).toEqual([480, 240, 0]);
    expect(state.sleepDebtMinutes).toBe(0);
  });
});
