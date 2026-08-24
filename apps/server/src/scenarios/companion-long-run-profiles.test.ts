import { describe, expect, it } from "vitest";

import {
  COMPANION_LONG_RUN_TURN_PROFILES,
  selectCompanionLongRunTurns,
  validateCompanionLongRunTurnProfiles,
} from "./companion-long-run-profiles.js";

describe("companion long-run risk profiles", () => {
  it("keeps the 20/30/50/100 profiles ordered, complete and dependency-closed", () => {
    expect(validateCompanionLongRunTurnProfiles()).toEqual([]);
    for (const count of [20, 30, 50, 100] as const) {
      expect(
        selectCompanionLongRunTurns(count).map((turn) => turn.number),
      ).toEqual([...COMPANION_LONG_RUN_TURN_PROFILES[count]]);
    }
  });

  it("keeps the paid high-risk 20 focused on schedule and memory regressions", () => {
    expect(COMPANION_LONG_RUN_TURN_PROFILES[20]).toEqual(
      expect.arrayContaining([
        12, 17, 18, 31, 32, 33, 34, 39, 40, 41, 45, 82, 84, 87, 100,
      ]),
    );
  });

  it("keeps restart, replay and late-session poisoning probes in nightly 30", () => {
    expect(COMPANION_LONG_RUN_TURN_PROFILES[30]).toEqual(
      expect.arrayContaining([76, 81, 82, 84, 87, 100]),
    );
  });

  it("keeps the short-profile Xiaolin fact uncorrected until turn 89 actually runs", () => {
    for (const count of [20, 30] as const) {
      expect(COMPANION_LONG_RUN_TURN_PROFILES[count]).toEqual(
        expect.arrayContaining([14, 84, 100]),
      );
      expect(COMPANION_LONG_RUN_TURN_PROFILES[count]).not.toContain(89);
    }
    expect(COMPANION_LONG_RUN_TURN_PROFILES[100]).toEqual(
      expect.arrayContaining([14, 84, 89, 100]),
    );
  });
});
