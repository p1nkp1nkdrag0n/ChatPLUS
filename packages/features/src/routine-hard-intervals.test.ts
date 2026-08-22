import { describe, expect, it } from "vitest";

import { findFreeSlots } from "./free-slot.js";
import { deriveRoutineHardIntervals } from "./routine-hard-intervals.js";

const CHARACTER = {
  identity: { timezone: "Asia/Shanghai" },
  routines: [
    {
      id: "routine-lunch",
      title: "Lunch",
      category: "用餐",
      preferredStartLocal: "12:00",
      preferredDurationMinutes: 60,
    },
    {
      id: "routine-sleep",
      title: "Sleep",
      category: "睡眠",
      preferredStartLocal: "23:00",
      preferredDurationMinutes: 480,
    },
    {
      id: "routine-work",
      title: "Work",
      category: "工作",
      preferredStartLocal: "09:00",
      preferredDurationMinutes: 480,
    },
  ],
};

describe("deriveRoutineHardIntervals", () => {
  it("includes a meal inside a same-local-day horizon", () => {
    const intervals = deriveRoutineHardIntervals(CHARACTER, {
      horizonStartAtUtc: "2026-08-21T02:00:00.000Z", // 10:00 local
      horizonEndAtUtc: "2026-08-21T12:00:00.000Z", // 20:00 local
    });

    expect(intervals).toEqual([
      expect.objectContaining({
        category: "meal",
        startAtUtc: "2026-08-21T04:00:00.000Z",
        endAtUtc: "2026-08-21T05:00:00.000Z",
      }),
    ]);
  });

  it("excludes a same-day meal when the horizon ends before lunch", () => {
    const intervals = deriveRoutineHardIntervals(CHARACTER, {
      horizonStartAtUtc: "2026-08-21T02:00:00.000Z", // 10:00 local
      horizonEndAtUtc: "2026-08-21T03:00:00.000Z", // 11:00 local
    });

    expect(intervals).toEqual([]);
  });

  it("expands meal routines per local day and excludes sleep and work", () => {
    const intervals = deriveRoutineHardIntervals(CHARACTER, {
      horizonStartAtUtc: "2026-08-21T04:00:00.000Z", // 12:00 local
      horizonEndAtUtc: "2026-08-23T04:00:00.000Z", // 12:00 local two days later
    });

    // The 08-23 12:00 local meal starts exactly at the horizon end and is
    // therefore excluded; the 08-20 meal predates the horizon.
    expect(intervals).toHaveLength(2);
    for (const interval of intervals) {
      expect(interval.category).toBe("meal");
      expect(interval.status).toBe("planned");
    }
    // 12:00 Asia/Shanghai == 04:00 UTC.
    expect(intervals.map((interval) => interval.startAtUtc)).toEqual([
      "2026-08-21T04:00:00.000Z",
      "2026-08-22T04:00:00.000Z",
    ]);
  });

  it("skips meal windows that end before the horizon starts", () => {
    const intervals = deriveRoutineHardIntervals(CHARACTER, {
      horizonStartAtUtc: "2026-08-21T13:00:00.000Z", // 21:00 local
      horizonEndAtUtc: "2026-08-22T04:00:00.000Z",
    });

    // 08-21 12:00 local already ended; 08-22 12:00 local starts exactly at
    // the horizon end. Nothing overlaps the horizon.
    expect(intervals).toEqual([]);
  });

  it("blocks meal windows in free-slot calculation across a DST-free zone", () => {
    const horizonStartAtUtc = "2026-08-21T04:00:00.000Z";
    const horizonEndAtUtc = "2026-08-22T04:00:00.000Z";
    const intervals = deriveRoutineHardIntervals(CHARACTER, {
      horizonStartAtUtc,
      horizonEndAtUtc,
    });

    const slots = findFreeSlots({
      horizonStartAtUtc,
      horizonEndAtUtc,
      timezone: CHARACTER.identity.timezone,
      existingItems: [],
      hardIntervals: intervals,
      durationMinutes: 60,
    });

    for (const slot of slots) {
      for (const interval of intervals) {
        const overlap =
          slot.startAtUtc < interval.endAtUtc &&
          interval.startAtUtc < slot.endAtUtc;
        expect(overlap).toBe(false);
      }
    }
  });

  it("handles a late-night meal crossing local midnight", () => {
    const character = {
      identity: { timezone: "UTC" },
      routines: [
        {
          id: "routine-late-snack",
          title: "Late snack",
          category: "meal",
          preferredStartLocal: "23:30",
          preferredDurationMinutes: 60,
        },
      ],
    };
    const intervals = deriveRoutineHardIntervals(character, {
      horizonStartAtUtc: "2026-08-21T00:00:00.000Z",
      horizonEndAtUtc: "2026-08-22T00:30:00.000Z",
    });

    expect(intervals.map((interval) => interval.startAtUtc)).toEqual([
      "2026-08-20T23:30:00.000Z",
      "2026-08-21T23:30:00.000Z",
    ]);
    expect(intervals[0]?.endAtUtc).toBe("2026-08-21T00:30:00.000Z");
    expect(intervals[1]?.endAtUtc).toBe("2026-08-22T00:30:00.000Z");
  });
});
