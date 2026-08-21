import { describe, expect, it } from "vitest";

import {
  findFreeSlots,
  freeSlotDurationMinutes,
  type ScheduleIntervalLike,
} from "./free-slot.js";

function interval(
  startAtUtc: string,
  endAtUtc: string,
  status = "planned",
  category = "work",
): ScheduleIntervalLike {
  return { startAtUtc, endAtUtc, status, category };
}

describe("free-slot calculation", () => {
  it("subtracts every live interval and hard sleep/meal interval with buffer", () => {
    const slots = findFreeSlots({
      horizonStartAtUtc: "2026-06-01T08:00:00.000Z",
      horizonEndAtUtc: "2026-06-01T18:00:00.000Z",
      timezone: "UTC",
      existingItems: [
        interval("2026-06-01T10:00:00.000Z", "2026-06-01T11:00:00.000Z"),
        interval(
          "2026-06-01T16:00:00.000Z",
          "2026-06-01T17:00:00.000Z",
          "cancelled",
        ),
      ],
      hardIntervals: [
        interval(
          "2026-06-01T12:00:00.000Z",
          "2026-06-01T13:00:00.000Z",
          "planned",
          "meal",
        ),
        interval(
          "2026-06-01T14:00:00.000Z",
          "2026-06-01T15:00:00.000Z",
          "planned",
          "sleep",
        ),
      ],
      durationMinutes: 30,
      minimumDurationMinutes: 30,
      bufferMinutes: 15,
    });

    expect(slots.map((slot) => [slot.startAtUtc, slot.endAtUtc])).toEqual([
      ["2026-06-01T08:00:00.000Z", "2026-06-01T09:45:00.000Z"],
      ["2026-06-01T11:15:00.000Z", "2026-06-01T11:45:00.000Z"],
      ["2026-06-01T13:15:00.000Z", "2026-06-01T13:45:00.000Z"],
      ["2026-06-01T15:15:00.000Z", "2026-06-01T18:00:00.000Z"],
    ]);
  });

  it("subtracts an interval that crosses local midnight", () => {
    const slots = findFreeSlots({
      horizonStartAtUtc: "2026-06-01T22:00:00.000Z",
      horizonEndAtUtc: "2026-06-02T04:00:00.000Z",
      timezone: "UTC",
      existingItems: [
        interval("2026-06-01T23:30:00.000Z", "2026-06-02T00:30:00.000Z"),
      ],
      durationMinutes: 60,
    });

    expect(slots.map((slot) => [slot.startAtUtc, slot.endAtUtc])).toEqual([
      ["2026-06-01T22:00:00.000Z", "2026-06-01T23:30:00.000Z"],
      ["2026-06-02T00:30:00.000Z", "2026-06-02T04:00:00.000Z"],
    ]);
  });

  it("uses real elapsed minutes across a DST-short local day", () => {
    const slots = findFreeSlots({
      horizonStartAtUtc: "2026-03-08T05:00:00.000Z",
      horizonEndAtUtc: "2026-03-09T04:00:00.000Z",
      timezone: "America/New_York",
      existingItems: [],
      durationMinutes: 60,
    });

    expect(slots).toHaveLength(1);
    expect(slots[0]?.targetLocalDay).toBe("2026-03-08");
    expect(slots[0]?.durationMinutes).toBe(23 * 60);
    expect(freeSlotDurationMinutes(slots[0]!)).toBe(23 * 60);
  });

  it("keeps midnight-to-dawn time available when the character schedule is free", () => {
    const slots = findFreeSlots({
      horizonStartAtUtc: "2026-06-01T00:00:00.000Z",
      horizonEndAtUtc: "2026-06-01T06:00:00.000Z",
      timezone: "UTC",
      existingItems: [],
      durationMinutes: 30,
    });

    expect(slots[0]?.startAtUtc).toBe("2026-06-01T00:00:00.000Z");
    expect(slots[0]?.endAtUtc).toBe("2026-06-01T06:00:00.000Z");
  });
});
