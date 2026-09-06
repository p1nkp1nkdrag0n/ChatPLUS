import {
  DayPeriodSchema,
  IanaTimezoneSchema,
  LocalDateSchema,
  TemporalPrecisionSchema,
  UtcDateTimeSchema,
  type DayPeriod,
} from "@personasim/contracts";
import { DateTime } from "luxon";

import type { Database } from "../db/connection.js";

export const FUZZY_LIFE_EFFECTIVE_AT_SQL_FUNCTION =
  "fuzzy_life_effective_at_utc";

export interface FuzzyLifeEffectiveTimeInput {
  readonly effectiveLocalDate: unknown;
  readonly effectivePeriod: unknown;
  readonly temporalPrecision: unknown;
}

type ConcreteDayPeriod = Exclude<DayPeriod, "anytime">;

const ConcreteDayPeriodSchema = DayPeriodSchema.exclude(["anytime"]);

// These boundaries are the inverse of fuzzy-life-planning.dayPeriod(). A
// period-precision fact becomes effective at the beginning of its named local
// wall-clock period; a day-precision fact becomes effective at local midnight.
// Audit timestamps never make a story fact happen early.
const DAY_PERIOD_START_HOUR: Readonly<Record<ConcreteDayPeriod, number>> = {
  early_morning: 0,
  morning: 6,
  midday: 11,
  afternoon: 14,
  evening: 18,
  late_night: 23,
};

export function projectFuzzyLifeEffectiveAtUtc(
  input: FuzzyLifeEffectiveTimeInput,
  characterTimezone: unknown,
): string {
  const timezone = IanaTimezoneSchema.parse(characterTimezone);
  const localDate = LocalDateSchema.parse(input.effectiveLocalDate);
  const precision = TemporalPrecisionSchema.parse(input.temporalPrecision);
  const period =
    input.effectivePeriod === null || input.effectivePeriod === undefined
      ? undefined
      : ConcreteDayPeriodSchema.parse(input.effectivePeriod);

  if (
    (precision === "day" && period !== undefined) ||
    (precision === "period" && period === undefined)
  ) {
    throw new TypeError(
      "Persisted fuzzy-life effective period does not match its precision",
    );
  }

  const hour = period === undefined ? 0 : DAY_PERIOD_START_HOUR[period];
  const projected = DateTime.fromObject(
    {
      year: Number(localDate.slice(0, 4)),
      month: Number(localDate.slice(5, 7)),
      day: Number(localDate.slice(8, 10)),
      hour,
    },
    { zone: timezone },
  );
  if (!projected.isValid || projected.toISODate() !== localDate) {
    throw new TypeError(
      "Could not project fuzzy-life effective time in the character timezone",
    );
  }

  const effectiveAtUtc = projected.toUTC().toISO();
  if (effectiveAtUtc === null) {
    throw new TypeError("Could not serialize fuzzy-life effective time");
  }
  return UtcDateTimeSchema.parse(effectiveAtUtc);
}

/**
 * Makes the shared projection available inside SQLite so WHERE, ORDER BY,
 * cursor comparisons, and LIMIT all operate on the same true UTC instant.
 */
export function registerFuzzyLifeEffectiveAtSqlFunction(
  database: Database,
): void {
  database.function(
    FUZZY_LIFE_EFFECTIVE_AT_SQL_FUNCTION,
    { deterministic: true },
    (
      effectiveLocalDate: unknown,
      effectivePeriod: unknown,
      temporalPrecision: unknown,
      characterTimezone: unknown,
    ) =>
      projectFuzzyLifeEffectiveAtUtc(
        { effectiveLocalDate, effectivePeriod, temporalPrecision },
        characterTimezone,
      ),
  );
}
