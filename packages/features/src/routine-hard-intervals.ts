import type { DateTime } from "luxon";

import type { ScheduleIntervalLike } from "./free-slot.js";
import { normalizeCategory } from "./schedule-planner.js";
import { parseInstant, parseZone } from "./shared.js";

export interface RoutineHardIntervalSource {
  id: string;
  title: string;
  category: string;
  /** Local wall-clock time in "HH:MM" form. */
  preferredStartLocal: string;
  preferredDurationMinutes: number;
}

export interface RoutineHardIntervalCharacterLike {
  identity: { timezone: string };
  routines: readonly RoutineHardIntervalSource[];
}

/**
 * Meal routines block self-planning placements even when their schedule items
 * have not been materialized yet. Sleep is deliberately excluded: persisted
 * sleep items already block normal slots, and the night bundle path must stay
 * able to shorten sleep, which a sleep hard interval would forbid.
 */
const HARD_INTERVAL_CATEGORIES = new Set(["meal"]);

const MAX_DERIVED_INTERVALS = 500;

function toUtcIso(value: DateTime): string {
  return value.toUTC().toISO() ?? value.toJSDate().toISOString();
}

function clockParts(
  value: string,
  routineId: string,
): {
  hour: number;
  minute: number;
} {
  const match = /^(\d{2}):(\d{2})$/.exec(value.trim());
  if (match === null) {
    throw new TypeError(
      `Routine ${routineId} has an invalid preferredStartLocal: ${value}`,
    );
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

/**
 * Deterministically expands meal routines into concrete UTC intervals for each
 * local day inside the planning horizon. Partial overlaps with the horizon are
 * clamped; days fully outside it are skipped.
 */
export function deriveRoutineHardIntervals(
  character: RoutineHardIntervalCharacterLike,
  input: { horizonStartAtUtc: string; horizonEndAtUtc: string },
): ScheduleIntervalLike[] {
  const zone = parseZone(character.identity.timezone);
  const horizonStartMillis = parseInstant(
    input.horizonStartAtUtc,
    "horizonStartAtUtc",
  ).toMillis();
  const horizonEndMillis = parseInstant(
    input.horizonEndAtUtc,
    "horizonEndAtUtc",
  ).toMillis();
  if (horizonEndMillis <= horizonStartMillis) {
    throw new TypeError("horizonEndAtUtc must be after horizonStartAtUtc");
  }

  const intervals: ScheduleIntervalLike[] = [];
  for (const routine of character.routines) {
    const category = normalizeCategory(routine.category);
    if (!HARD_INTERVAL_CATEGORIES.has(category)) continue;
    if (
      !Number.isInteger(routine.preferredDurationMinutes) ||
      routine.preferredDurationMinutes <= 0
    ) {
      continue;
    }
    const { hour, minute } = clockParts(
      routine.preferredStartLocal,
      routine.id,
    );
    let day = parseInstant(input.horizonStartAtUtc, "horizonStartAtUtc")
      .setZone(zone)
      .startOf("day")
      .minus({ days: 1 });
    const lastDay = parseInstant(input.horizonEndAtUtc, "horizonEndAtUtc")
      .setZone(zone)
      .startOf("day");
    while (day <= lastDay && intervals.length < MAX_DERIVED_INTERVALS) {
      const start = day.set({ hour, minute });
      const end = start.plus({ minutes: routine.preferredDurationMinutes });
      day = day.plus({ days: 1 });
      if (end.toMillis() <= horizonStartMillis) continue;
      if (start.toMillis() >= horizonEndMillis) continue;
      const clippedStart = Math.max(start.toMillis(), horizonStartMillis);
      const clippedEnd = Math.min(end.toMillis(), horizonEndMillis);
      if (clippedEnd <= clippedStart) continue;
      intervals.push({
        id: `${routine.id}:${start.toISODate() ?? start.toMillis()}`,
        startAtUtc: toUtcIso(start),
        endAtUtc: toUtcIso(end),
        status: "planned",
        category,
      });
    }
  }
  return intervals;
}
