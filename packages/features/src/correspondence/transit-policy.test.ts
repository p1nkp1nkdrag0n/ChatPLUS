import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  FIXED_TRANSIT_POLICY_V1,
  FixedTransitPolicyV1,
  calculateFixedTransitArrivalUtc,
  calculateLetterArrivalDueAtUtc,
  transitLegForLetterDirection,
} from "./transit-policy.js";
import {
  calculateTransitProgress,
  deriveLetterTransitProgress,
} from "./progress.js";

describe("FixedTransitPolicyV1", () => {
  it("exposes the immutable versioned five-calendar-day policy", () => {
    expect(FixedTransitPolicyV1).toEqual({
      version: "fixed_5d_v1",
      outboundDays: 5,
      returnDays: 5,
      progressBasis: "wall_clock",
      displayPrecision: "day",
    });
    expect(FIXED_TRANSIT_POLICY_V1).toBe(FixedTransitPolicyV1);
    expect(Object.isFrozen(FixedTransitPolicyV1)).toBe(true);
  });

  it("adds five character-local calendar days for both directions", () => {
    expect(
      calculateLetterArrivalDueAtUtc(
        "2026-09-03T12:00:00.000Z",
        "Asia/Shanghai",
        "user_to_agent",
      ),
    ).toBe("2026-09-08T12:00:00.000Z");
    expect(
      calculateLetterArrivalDueAtUtc(
        "2026-09-08T12:00:00.000Z",
        "Asia/Shanghai",
        "agent_to_user",
      ),
    ).toBe("2026-09-13T12:00:00.000Z");
    expect(transitLegForLetterDirection("user_to_agent")).toBe("outbound");
    expect(transitLegForLetterDirection("agent_to_user")).toBe("return");
  });

  it("preserves local wall time across the spring DST transition", () => {
    const dispatchedAtUtc = "2026-03-06T17:00:00.000Z";
    const arrivalAtUtc = calculateFixedTransitArrivalUtc(
      dispatchedAtUtc,
      "America/New_York",
      "outbound",
    );

    expect(arrivalAtUtc).toBe("2026-03-11T16:00:00.000Z");
    expect(
      DateTime.fromISO(dispatchedAtUtc)
        .setZone("America/New_York")
        .toFormat("yyyy-MM-dd HH:mm ZZZZ"),
    ).toBe("2026-03-06 12:00 EST");
    expect(
      DateTime.fromISO(arrivalAtUtc)
        .setZone("America/New_York")
        .toFormat("yyyy-MM-dd HH:mm ZZZZ"),
    ).toBe("2026-03-11 12:00 EDT");
    expect(Date.parse(arrivalAtUtc) - Date.parse(dispatchedAtUtc)).toBe(
      119 * 60 * 60 * 1_000,
    );
  });

  it("preserves local wall time across the autumn DST transition", () => {
    const dispatchedAtUtc = "2026-10-30T16:00:00.000Z";
    const arrivalAtUtc = calculateFixedTransitArrivalUtc(
      dispatchedAtUtc,
      "America/New_York",
      "return",
    );

    expect(arrivalAtUtc).toBe("2026-11-04T17:00:00.000Z");
    expect(
      DateTime.fromISO(arrivalAtUtc)
        .setZone("America/New_York")
        .toFormat("yyyy-MM-dd HH:mm ZZZZ"),
    ).toBe("2026-11-04 12:00 EST");
    expect(Date.parse(arrivalAtUtc) - Date.parse(dispatchedAtUtc)).toBe(
      121 * 60 * 60 * 1_000,
    );
  });

  it("rejects non-UTC timestamps and invalid IANA zones", () => {
    expect(() =>
      calculateFixedTransitArrivalUtc(
        "2026-09-03T20:00:00+08:00",
        "Asia/Shanghai",
        "outbound",
      ),
    ).toThrow();
    expect(() =>
      calculateFixedTransitArrivalUtc(
        "2026-09-03T12:00:00.000Z",
        "Mars/Olympus_Mons",
        "outbound",
      ),
    ).toThrow();
  });
});

describe("transit progress projection", () => {
  const dispatchedAtUtc = "2026-09-03T12:00:00.000Z";
  const arrivalDueAtUtc = "2026-09-08T12:00:00.000Z";

  it.each([
    ["2026-09-02T12:00:00.000Z", 0],
    [dispatchedAtUtc, 0],
    ["2026-09-04T12:00:00.000Z", 0.2],
    ["2026-09-07T12:00:00.000Z", 0.8],
    [arrivalDueAtUtc, 1],
    ["2026-09-09T12:00:00.000Z", 1],
  ])(
    "calculates %s from the observed clock as %s",
    (observedAtUtc, expected) => {
      expect(
        calculateTransitProgress({
          dispatchedAtUtc,
          arrivalDueAtUtc,
          observedAtUtc,
        }),
      ).toBeCloseTo(expected);
    },
  );

  it("uses elapsed instants for wall-clock progress across DST", () => {
    const dstDispatch = "2026-03-06T17:00:00.000Z";
    const dstArrival = "2026-03-11T16:00:00.000Z";
    const midpoint = new Date(
      (Date.parse(dstDispatch) + Date.parse(dstArrival)) / 2,
    ).toISOString();

    expect(
      calculateTransitProgress({
        dispatchedAtUtc: dstDispatch,
        arrivalDueAtUtc: dstArrival,
        observedAtUtc: midpoint,
      }),
    ).toBe(0.5);
  });

  it("derives terminal progress without persisting or mutating it", () => {
    const inTransit = Object.freeze({
      status: "in_transit" as const,
      dispatchedAtUtc,
      arrivalDueAtUtc,
    });
    expect(
      deriveLetterTransitProgress(inTransit, "2026-09-04T12:00:00.000Z"),
    ).toBeCloseTo(0.2);
    expect(
      deriveLetterTransitProgress(inTransit, "2026-09-07T12:00:00.000Z"),
    ).toBeCloseTo(0.8);
    expect(Object.keys(inTransit)).not.toContain("progress");
    expect(
      deriveLetterTransitProgress(
        { status: "delivered_unread" },
        arrivalDueAtUtc,
      ),
    ).toBe(1);
    expect(
      deriveLetterTransitProgress({ status: "cancelled" }, arrivalDueAtUtc),
    ).toBe(0);
  });

  it("rejects malformed or non-chronological ranges", () => {
    expect(() =>
      calculateTransitProgress({
        dispatchedAtUtc,
        arrivalDueAtUtc: dispatchedAtUtc,
        observedAtUtc: dispatchedAtUtc,
      }),
    ).toThrow(RangeError);
    expect(() =>
      calculateTransitProgress({
        dispatchedAtUtc,
        arrivalDueAtUtc,
        observedAtUtc: "not-a-time",
      }),
    ).toThrow();
    expect(() =>
      deriveLetterTransitProgress(
        { status: "in_transit" },
        "2026-09-04T12:00:00.000Z",
      ),
    ).toThrow(RangeError);
  });
});
