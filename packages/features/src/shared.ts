import { DateTime } from "luxon";

export const HOUR_MS = 60 * 60 * 1_000;
export const MINUTE_MS = 60 * 1_000;

export function clamp(value: number, minimum = 0, maximum = 1): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, value));
}

export function parseInstant(value: string, label = "instant"): DateTime {
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) {
    throw new TypeError(`${label} must be a valid ISO-8601 instant`);
  }
  return parsed.toUTC();
}

export function parseZone(value: string): string {
  const parsed = DateTime.now().setZone(value);
  if (!parsed.isValid) {
    throw new TypeError(`Invalid IANA timezone: ${value}`);
  }
  return value;
}

/** FNV-1a, kept deliberately small and runtime-independent for deterministic fixtures. */
export function stableHash(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function stableId(prefix: string, input: string): string {
  return `${prefix}_${stableHash(input).toString(36).padStart(7, "0")}`;
}

export function seededUnit(seed: string): number {
  // One avalanche step avoids visible correlations for adjacent schedule ids.
  let value = stableHash(seed);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x1_0000_0000;
}

export function overlaps(
  left: { startAtUtc: string; endAtUtc: string },
  right: { startAtUtc: string; endAtUtc: string },
): boolean {
  const leftStart = parseInstant(left.startAtUtc, "left.startAtUtc").toMillis();
  const leftEnd = parseInstant(left.endAtUtc, "left.endAtUtc").toMillis();
  const rightStart = parseInstant(
    right.startAtUtc,
    "right.startAtUtc",
  ).toMillis();
  const rightEnd = parseInstant(right.endAtUtc, "right.endAtUtc").toMillis();
  return leftStart < rightEnd && rightStart < leftEnd;
}

export function localDayKey(instantUtc: string, timezone: string): string {
  parseZone(timezone);
  return parseInstant(instantUtc).setZone(timezone).toISODate() ?? "";
}

export function minutesBetween(startAtUtc: string, endAtUtc: string): number {
  return (
    (parseInstant(endAtUtc).toMillis() - parseInstant(startAtUtc).toMillis()) /
    MINUTE_MS
  );
}

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s]+/gu, " ")
    .trim();
}
