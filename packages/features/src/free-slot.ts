import type { ScheduleRigidity } from "@personasim/contracts";
import type { DateTime } from "luxon";

import { minutesBetween, parseInstant, parseZone } from "./shared.js";

export interface ScheduleIntervalLike {
  startAtUtc: string;
  endAtUtc: string;
  status?: string;
  category?: string;
  id?: string;
  /** Present for persisted schedule items; hard intervals may omit it. */
  rigidity?: ScheduleRigidity;
}

export interface FreeSlot {
  startAtUtc: string;
  endAtUtc: string;
  durationMinutes: number;
  targetLocalDay: string;
  crossesLocalMidnight: boolean;
}

export interface FindFreeSlotsInput {
  horizonStartAtUtc: string;
  horizonEndAtUtc: string;
  timezone: string;
  existingItems: readonly ScheduleIntervalLike[];
  /**
   * Exact server-derived sleep/meal or other hard intervals that may not yet
   * be persisted in the current schedule.
   */
  hardIntervals?: readonly ScheduleIntervalLike[];
  durationMinutes: number;
  minimumDurationMinutes?: number;
  bufferMinutes?: number;
}

interface MillisecondInterval {
  start: number;
  end: number;
}

function requireNonNegativeInteger(
  value: number,
  label: string,
  allowZero: boolean,
): number {
  if (
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value < (allowZero ? 0 : 1)
  ) {
    throw new TypeError(
      `${label} must be ${allowZero ? "a non-negative" : "a positive"} integer`,
    );
  }
  return value;
}

function toUtcIso(value: DateTime): string {
  return value.toUTC().toISO() ?? value.toJSDate().toISOString();
}

function clippedBlockedInterval(
  interval: ScheduleIntervalLike,
  horizonStart: number,
  horizonEnd: number,
  bufferMilliseconds: number,
  label: string,
): MillisecondInterval | undefined {
  if (interval.status === "cancelled") return undefined;
  const start = parseInstant(interval.startAtUtc, `${label}.startAtUtc`);
  const end = parseInstant(interval.endAtUtc, `${label}.endAtUtc`);
  if (end <= start) {
    throw new TypeError(`${label}.endAtUtc must be after startAtUtc`);
  }
  const clippedStart = Math.max(
    horizonStart,
    start.toMillis() - bufferMilliseconds,
  );
  const clippedEnd = Math.min(horizonEnd, end.toMillis() + bufferMilliseconds);
  return clippedEnd <= clippedStart
    ? undefined
    : { start: clippedStart, end: clippedEnd };
}

function mergeIntervals(
  intervals: readonly MillisecondInterval[],
): MillisecondInterval[] {
  const sorted = [...intervals].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged: MillisecondInterval[] = [];
  for (const interval of sorted) {
    const previous = merged.at(-1);
    if (previous === undefined || interval.start > previous.end) {
      merged.push({ ...interval });
      continue;
    }
    previous.end = Math.max(previous.end, interval.end);
  }
  return merged;
}

function slotFromMilliseconds(
  startMilliseconds: number,
  endMilliseconds: number,
  timezone: string,
): FreeSlot {
  const start = parseInstant(new Date(startMilliseconds).toISOString()).setZone(
    timezone,
  );
  const end = parseInstant(new Date(endMilliseconds).toISOString()).setZone(
    timezone,
  );
  const lastIncludedInstant = end.minus({ milliseconds: 1 });
  return {
    startAtUtc: toUtcIso(start),
    endAtUtc: toUtcIso(end),
    durationMinutes: (endMilliseconds - startMilliseconds) / 60_000,
    targetLocalDay: start.toISODate() ?? "",
    crossesLocalMidnight: start.toISODate() !== lastIncludedInstant.toISODate(),
  };
}

/**
 * Subtracts every non-cancelled interval (plus buffer) from the exact planning
 * horizon. No global active-hours window is imposed. UTC subtraction preserves
 * real elapsed duration while local-day metadata remains timezone/DST aware.
 */
export function findFreeSlots(input: FindFreeSlotsInput): FreeSlot[] {
  parseZone(input.timezone);
  const horizonStart = parseInstant(
    input.horizonStartAtUtc,
    "horizonStartAtUtc",
  );
  const horizonEnd = parseInstant(input.horizonEndAtUtc, "horizonEndAtUtc");
  if (horizonEnd <= horizonStart) {
    throw new TypeError("horizonEndAtUtc must be after horizonStartAtUtc");
  }

  const durationMinutes = requireNonNegativeInteger(
    input.durationMinutes,
    "durationMinutes",
    false,
  );
  const minimumDurationMinutes = requireNonNegativeInteger(
    input.minimumDurationMinutes ?? durationMinutes,
    "minimumDurationMinutes",
    false,
  );
  const requiredMinutes = Math.max(durationMinutes, minimumDurationMinutes);
  const bufferMinutes = requireNonNegativeInteger(
    input.bufferMinutes ?? 0,
    "bufferMinutes",
    true,
  );
  const horizonStartMilliseconds = horizonStart.toMillis();
  const horizonEndMilliseconds = horizonEnd.toMillis();
  const bufferMilliseconds = bufferMinutes * 60_000;

  const blocked: MillisecondInterval[] = [];
  for (const [index, interval] of [
    ...input.existingItems,
    ...(input.hardIntervals ?? []),
  ].entries()) {
    const clipped = clippedBlockedInterval(
      interval,
      horizonStartMilliseconds,
      horizonEndMilliseconds,
      bufferMilliseconds,
      `intervals.${index}`,
    );
    if (clipped !== undefined) blocked.push(clipped);
  }

  const free: FreeSlot[] = [];
  let cursor = horizonStartMilliseconds;
  for (const interval of mergeIntervals(blocked)) {
    if (interval.start > cursor) {
      const duration = (interval.start - cursor) / 60_000;
      if (duration >= requiredMinutes) {
        free.push(slotFromMilliseconds(cursor, interval.start, input.timezone));
      }
    }
    cursor = Math.max(cursor, interval.end);
  }
  if (cursor < horizonEndMilliseconds) {
    const duration = (horizonEndMilliseconds - cursor) / 60_000;
    if (duration >= requiredMinutes) {
      free.push(
        slotFromMilliseconds(cursor, horizonEndMilliseconds, input.timezone),
      );
    }
  }

  return free;
}

export function freeSlotDurationMinutes(
  slot: Pick<FreeSlot, "startAtUtc" | "endAtUtc">,
): number {
  return minutesBetween(slot.startAtUtc, slot.endAtUtc);
}
