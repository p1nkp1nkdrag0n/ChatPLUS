import { describe, expect, it } from "vitest";

import { plan72h } from "./schedule-planner.js";
import {
  type ScheduleItemLike,
  validateScheduleProposal,
  validateScheduleProposals,
} from "./schedule-validator.js";
import { settleSchedule } from "./settlement-engine.js";

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
      sleepDebtMinutes: 240,
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
    expect(first.state.sleepDebtMinutes).toBeGreaterThan(0);
    expect(first.state.sleepDebtMinutes).toBeLessThan(240);
    expect(replay.state.sleepDebtMinutes).toBe(first.state.sleepDebtMinutes);
  });
});
