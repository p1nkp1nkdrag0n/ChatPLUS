import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import {
  projectFuzzyLifeEffectiveAtUtc,
  registerFuzzyLifeEffectiveAtSqlFunction,
} from "./fuzzy-life-effective-time.js";

describe("fuzzy-life effective-time projection", () => {
  let database: Database | undefined;

  afterEach(() => database?.close());

  it("projects period and day precision in the supplied IANA timezone", () => {
    expect(
      projectFuzzyLifeEffectiveAtUtc(
        {
          effectiveLocalDate: "2026-09-08",
          effectivePeriod: "morning",
          temporalPrecision: "period",
        },
        "Asia/Shanghai",
      ),
    ).toBe("2026-09-07T22:00:00.000Z");
    expect(
      projectFuzzyLifeEffectiveAtUtc(
        {
          effectiveLocalDate: "2026-09-15",
          effectivePeriod: null,
          temporalPrecision: "day",
        },
        "America/Los_Angeles",
      ),
    ).toBe("2026-09-15T07:00:00.000Z");
  });

  it("rejects invalid precision/period pairs and invalid timezones", () => {
    expect(() =>
      projectFuzzyLifeEffectiveAtUtc(
        {
          effectiveLocalDate: "2026-09-08",
          effectivePeriod: "afternoon",
          temporalPrecision: "day",
        },
        "Asia/Shanghai",
      ),
    ).toThrow(/does not match its precision/u);
    expect(() =>
      projectFuzzyLifeEffectiveAtUtc(
        {
          effectiveLocalDate: "2026-09-08",
          effectivePeriod: null,
          temporalPrecision: "period",
        },
        "Mars/Olympus_Mons",
      ),
    ).toThrow();
  });

  it("exposes the same deterministic projection to SQLite", () => {
    database = openDatabase(":memory:");
    registerFuzzyLifeEffectiveAtSqlFunction(database);
    expect(
      database
        .prepare(
          `SELECT fuzzy_life_effective_at_utc(
             '2026-09-15', 'morning', 'period', 'America/Los_Angeles'
           ) AS effectiveAtUtc`,
        )
        .get(),
    ).toEqual({ effectiveAtUtc: "2026-09-15T13:00:00.000Z" });
  });
});
