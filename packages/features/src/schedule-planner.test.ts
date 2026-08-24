import { describe, expect, it } from "vitest";

import {
  plan72HoursDetailed,
  type PlanningCharacterLike,
} from "./schedule-planner.js";

const NOW_UTC = "2026-08-24T00:00:00.000Z";

function planningCharacter(
  routines: PlanningCharacterLike["routines"],
): PlanningCharacterLike {
  return {
    id: "character-sleep-priority",
    identity: { name: "顾澜", timezone: "Asia/Shanghai" },
    routines,
    schedulePolicy: {
      enabled: true,
      horizonHours: 72,
      sleepWindow: { startLocal: "00:00", endLocal: "07:00" },
      maxCommittedHoursPerDay: 8,
      routineAdherence: 0.6,
    },
  };
}

describe("72-hour schedule planner", () => {
  it("reserves cross-midnight sleep before a late routine with a buffered boundary", () => {
    const result = plan72HoursDetailed({
      character: planningCharacter([
        {
          id: "late-editing",
          title: "夜间剪辑工作",
          category: "work",
          recurrence: "daily",
          preferredStartLocal: "22:00",
          preferredDurationMinutes: 120,
          rigidity: "flexible",
          priority: 0.8,
        },
      ]),
      nowUtc: NOW_UTC,
      horizonHours: 72,
    });

    const sleep = result.createdItems.filter(
      (item) => item.category === "sleep",
    );
    expect(sleep).toHaveLength(3);
    expect(
      result.createdItems.some((item) => item.title === "夜间剪辑工作"),
    ).toBe(false);
    expect(
      result.createdItems.every(
        (item) =>
          Date.parse(item.startAtUtc) >= Date.parse(NOW_UTC) &&
          Date.parse(item.endAtUtc) <= Date.parse(result.horizonEndUtc),
      ),
    ).toBe(true);
    expect(hasOverlap(result.createdItems)).toBe(false);
  });

  it("keeps an ordinary daytime routine alongside mandatory sleep", () => {
    const result = plan72HoursDetailed({
      character: planningCharacter([
        {
          id: "daytime-editing",
          title: "上午剪辑",
          category: "work",
          recurrence: "daily",
          preferredStartLocal: "10:00",
          preferredDurationMinutes: 90,
          rigidity: "committed",
          priority: 0.8,
        },
      ]),
      nowUtc: NOW_UTC,
      horizonHours: 72,
    });

    expect(
      result.createdItems.filter((item) => item.category === "sleep"),
    ).toHaveLength(3);
    expect(
      result.createdItems.filter((item) => item.title === "上午剪辑"),
    ).toHaveLength(3);
    expect(hasOverlap(result.createdItems)).toBe(false);
  });
});

function hasOverlap(
  items: ReturnType<typeof plan72HoursDetailed>["createdItems"],
): boolean {
  const ordered = [...items].sort((left, right) =>
    left.startAtUtc.localeCompare(right.startAtUtc),
  );
  return ordered.some(
    (item, index) =>
      index > 0 &&
      Date.parse(item.startAtUtc) < Date.parse(ordered[index - 1]!.endAtUtc),
  );
}
