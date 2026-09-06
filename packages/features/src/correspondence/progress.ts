import { UtcDateTimeSchema, type Letter } from "@personasim/contracts";

export interface TransitProgressInput {
  readonly dispatchedAtUtc: string;
  readonly arrivalDueAtUtc: string;
  readonly observedAtUtc: string;
}

/**
 * Computes wall-clock progress on demand. It is deliberately a projection,
 * not persisted state: callers provide the observed clock for deterministic
 * tests and calculate again whenever the letter is read.
 */
export function calculateTransitProgress(input: TransitProgressInput): number {
  UtcDateTimeSchema.parse(input.dispatchedAtUtc);
  UtcDateTimeSchema.parse(input.arrivalDueAtUtc);
  UtcDateTimeSchema.parse(input.observedAtUtc);

  const dispatchedMs = Date.parse(input.dispatchedAtUtc);
  const arrivalMs = Date.parse(input.arrivalDueAtUtc);
  if (arrivalMs <= dispatchedMs) {
    throw new RangeError("arrivalDueAtUtc must be later than dispatchedAtUtc");
  }

  const observedMs = Date.parse(input.observedAtUtc);
  return Math.min(
    1,
    Math.max(0, (observedMs - dispatchedMs) / (arrivalMs - dispatchedMs)),
  );
}

export function deriveLetterTransitProgress(
  letter: Readonly<
    Pick<Letter, "status" | "dispatchedAtUtc" | "arrivalDueAtUtc">
  >,
  observedAtUtc: string,
): number {
  if (letter.status === "draft" || letter.status === "cancelled") return 0;
  if (letter.status === "delivered_unread" || letter.status === "read")
    return 1;
  if (
    letter.dispatchedAtUtc === undefined ||
    letter.arrivalDueAtUtc === undefined
  ) {
    throw new RangeError(
      `Letter in status ${letter.status} requires transit timestamps`,
    );
  }
  return calculateTransitProgress({
    dispatchedAtUtc: letter.dispatchedAtUtc,
    arrivalDueAtUtc: letter.arrivalDueAtUtc,
    observedAtUtc,
  });
}
