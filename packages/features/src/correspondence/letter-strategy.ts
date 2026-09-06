export type LetterStationeryType = "postcard" | "standard" | "extended";
export type LetterSalutationStyle = "courteous" | "warm" | "intimate";
export type LetterClosingStyle = "formal" | "gentle" | "affectionate";

export interface LetterStrategyContext {
  readonly characterVerbosity?: number;
  readonly relationship?: {
    readonly closeness: number;
    readonly trust: number;
  };
  readonly stationeryType?: LetterStationeryType;
}

export interface LetterStrategy {
  readonly targetMinChars: number;
  readonly targetChars: number;
  readonly targetMaxChars: number;
  readonly maxOutputTokens: number;
  readonly paragraphCount: number;
  readonly salutationStyle: LetterSalutationStyle;
  readonly closingStyle: LetterClosingStyle;
  readonly lengthGuidance: string;
  readonly structureGuidance: string;
  readonly evidenceGuidance: string;
}

/**
 * Derives a broad, letter-specific expression budget. The result deliberately
 * contains no topic, event, claim, or suggested fact: factual content remains
 * exclusively owned by the frozen generation snapshot.
 */
export function deriveLetterStrategy(
  incomingLetterBody: string,
  context: LetterStrategyContext = {},
): LetterStrategy {
  const stationeryType = context.stationeryType ?? "standard";
  const verbosity = clamp(context.characterVerbosity ?? 0.5, 0, 1);
  const closeness = clamp(context.relationship?.closeness ?? 0.5, 0, 1);
  const trust = clamp(context.relationship?.trust ?? 0.5, 0, 1);
  const relationshipStrength = (closeness + trust) / 2;
  const incomingLengthSignal = clamp(
    incomingLetterBody.trim().length / 1_200,
    0,
    1,
  );
  const stationery = stationeryBudget(stationeryType);
  const target = clamp(
    Math.round(
      stationery.baseline +
        incomingLengthSignal * 340 +
        verbosity * 280 +
        relationshipStrength * 180,
    ),
    400,
    stationery.maximum,
  );
  const rangeRadius = Math.max(100, Math.round(target * 0.22));
  const targetMinChars = clamp(target - rangeRadius, 400, 1_600);
  const targetMaxChars = clamp(
    target + rangeRadius,
    targetMinChars,
    stationery.maximum,
  );
  const paragraphCount = clamp(
    Math.round(target / 230),
    stationeryType === "postcard" ? 2 : 3,
    stationeryType === "extended" ? 7 : 6,
  );
  const salutationStyle: LetterSalutationStyle =
    closeness >= 0.78 && trust >= 0.68
      ? "intimate"
      : relationshipStrength >= 0.45
        ? "warm"
        : "courteous";
  const closingStyle: LetterClosingStyle =
    closeness >= 0.8 && trust >= 0.75
      ? "affectionate"
      : relationshipStrength >= 0.4
        ? "gentle"
        : "formal";

  return Object.freeze({
    targetMinChars,
    targetChars: target,
    targetMaxChars,
    maxOutputTokens: clamp(Math.ceil(targetMaxChars * 1.8 + 600), 2_000, 4_800),
    paragraphCount,
    salutationStyle,
    closingStyle,
    lengthGuidance: `Aim for roughly ${targetMinChars}-${targetMaxChars} Chinese characters; this is a soft budget, and grounded completeness matters more than an exact count.`,
    structureGuidance: `Write one complete letter in about ${paragraphCount} coherent paragraphs, with a ${salutationStyle} salutation and a ${closingStyle} closing.`,
    evidenceGuidance:
      "This strategy controls expression only. It supplies no facts; use only facts and evidence present in the frozen snapshot.",
  });
}

function stationeryBudget(type: LetterStationeryType): {
  baseline: number;
  maximum: number;
} {
  switch (type) {
    case "postcard":
      return { baseline: 400, maximum: 800 };
    case "standard":
      return { baseline: 560, maximum: 1_300 };
    case "extended":
      return { baseline: 760, maximum: 1_600 };
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
