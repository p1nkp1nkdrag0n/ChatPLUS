/** Versioned, model-independent heuristic; never provider usage or a tokenizer. */
export const PROMPT_TOKEN_ESTIMATE_METHOD = "unicode-heuristic-v1";

/**
 * Conservative planning weights: four ASCII letters/digits/whitespace per
 * token, one token per ASCII punctuation mark, two per non-ASCII BMP code
 * point and four per supplementary code point (including emoji).
 *
 * These deliberately avoid treating Chinese or JSON as English prose. They
 * are not an upper bound for every tokenizer; transport/schema overhead still
 * needs its own reserve, and provider-reported usage is the calibration truth.
 * No normalization is applied: estimate the exact text that will be sent.
 */
export function estimatePromptTokens(value: string): number {
  let units = 0;
  for (const character of value) units += characterTokenUnits(character);
  return Math.ceil(units / 4);
}

/** Returns a Unicode code-point-safe prefix within the same planning budget. */
export function promptPrefixWithinTokenBudget(
  value: string,
  tokenBudget: number,
): string {
  const maximumUnits = Math.max(0, Math.floor(tokenBudget)) * 4;
  let units = 0;
  let end = 0;
  for (const character of value) {
    units += characterTokenUnits(character);
    if (units > maximumUnits) break;
    end += character.length;
  }
  return value.slice(0, end);
}

function characterTokenUnits(character: string): number {
  const codePoint = character.codePointAt(0)!;
  if (codePoint > 0xffff) return 16;
  if (codePoint > 0x7f) return 8;
  return /[a-z0-9\s]/iu.test(character) ? 1 : 4;
}
