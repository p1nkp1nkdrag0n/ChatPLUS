import { DateTime } from "luxon";

export function formatLocalTime(
  utc: string,
  timezone = "Asia/Shanghai",
): string {
  return DateTime.fromISO(utc, { zone: "utc" })
    .setZone(timezone)
    .toFormat("HH:mm");
}

export function formatLocalDateTime(
  utc: string,
  timezone = "Asia/Shanghai",
): string {
  return DateTime.fromISO(utc, { zone: "utc" })
    .setZone(timezone)
    .toFormat("MM 月 dd 日 HH:mm");
}

export function nowWindow(
  hours = 24,
  referenceUtc?: string,
  lookbackHours = 2,
): { fromUtc: string; toUtc: string } {
  const reference = referenceUtc
    ? DateTime.fromISO(referenceUtc, { setZone: true }).toUTC()
    : DateTime.utc();
  const now = reference.isValid ? reference : DateTime.utc();
  const fromUtc = now.minus({ hours: lookbackHours }).toISO();
  const toUtc = now.plus({ hours }).toISO();
  if (!fromUtc || !toUtc) {
    throw new Error("Unable to construct a valid UTC time window");
  }
  return {
    fromUtc,
    toUtc,
  };
}
