import {
  IanaTimezoneSchema,
  UtcDateTimeSchema,
  type FixedTransitPolicyV1Contract,
  type LetterDirection,
} from "@personasim/contracts";
import { DateTime } from "luxon";

export type LetterTransitLeg = "outbound" | "return";

export const FixedTransitPolicyV1 = Object.freeze({
  version: "fixed_5d_v1",
  outboundDays: 5,
  returnDays: 5,
  progressBasis: "wall_clock",
  displayPrecision: "day",
} as const satisfies FixedTransitPolicyV1Contract);

export const FIXED_TRANSIT_POLICY_V1 = FixedTransitPolicyV1;

export function transitLegForLetterDirection(
  direction: LetterDirection,
): LetterTransitLeg {
  return direction === "user_to_agent" ? "outbound" : "return";
}

/**
 * Adds local civil/calendar days in the character's IANA timezone, preserving
 * the local clock time across offset changes. The returned instant is always a
 * normalized UTC ISO timestamp suitable for UtcDateTimeSchema.
 */
export function calculateFixedTransitArrivalUtc(
  dispatchedAtUtc: string,
  characterTimezone: string,
  leg: LetterTransitLeg,
): string {
  UtcDateTimeSchema.parse(dispatchedAtUtc);
  IanaTimezoneSchema.parse(characterTimezone);

  const dispatched = DateTime.fromISO(dispatchedAtUtc, { zone: "utc" });
  const localDispatched = dispatched.setZone(characterTimezone);
  const days =
    leg === "outbound"
      ? FixedTransitPolicyV1.outboundDays
      : FixedTransitPolicyV1.returnDays;
  const arrival = localDispatched.plus({ days }).toUTC();
  const arrivalUtc = arrival.toISO({
    includeOffset: true,
    suppressMilliseconds: false,
  });

  if (arrivalUtc === null) {
    throw new RangeError("Could not calculate a valid transit arrival instant");
  }
  return UtcDateTimeSchema.parse(arrivalUtc);
}

export function calculateLetterArrivalDueAtUtc(
  dispatchedAtUtc: string,
  characterTimezone: string,
  direction: LetterDirection,
): string {
  return calculateFixedTransitArrivalUtc(
    dispatchedAtUtc,
    characterTimezone,
    transitLegForLetterDirection(direction),
  );
}
