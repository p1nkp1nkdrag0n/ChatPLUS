import type { CompanionTurnSpec } from "./companion-long-run-types.js";
import { companionLongRunManifest } from "./companion-long-run-manifest.js";

export type CompanionLongRunTurnCount = 20 | 30 | 50 | 100;

/**
 * Nightly profiles are explicit and versioned with the manifest. They keep
 * their original order and include the prerequisite writes, offers and
 * session-creation actions needed by later risk probes.
 */
export const COMPANION_LONG_RUN_TURN_PROFILES = {
  20: [
    11, 12, 13, 14, 17, 18, 31, 32, 33, 34, 39, 40, 41, 45, 76, 81, 82, 84, 87,
    100,
  ],
  30: [
    1, 11, 12, 13, 14, 17, 18, 21, 24, 26, 28, 31, 32, 33, 34, 39, 40, 41, 43,
    45, 52, 60, 68, 70, 76, 81, 82, 84, 87, 100,
  ],
  50: [
    ...Array.from({ length: 45 }, (_, index) => index + 1),
    52,
    60,
    68,
    76,
    81,
  ],
  100: Array.from({ length: 100 }, (_, index) => index + 1),
} as const satisfies Record<CompanionLongRunTurnCount, readonly number[]>;

const REQUIRED_PREDECESSORS: Readonly<Record<number, readonly number[]>> = {
  12: [11],
  16: [11],
  17: [13],
  18: [13, 17],
  26: [21],
  31: [],
  32: [31],
  33: [31],
  34: [31, 33],
  40: [39],
  41: [39, 40],
  42: [39, 40, 41],
  43: [31, 33],
  44: [31, 33],
  45: [31, 33],
  52: [31, 33],
  76: [11],
  77: [13, 17, 76],
  78: [21, 76],
  79: [31, 33, 76],
  81: [76],
  82: [11, 76, 81],
  84: [14],
  85: [31, 33, 84],
  89: [14, 84],
  90: [14, 84, 89],
  96: [11, 84],
  97: [13, 14, 17, 84, 89],
  99: [21, 31, 33, 84],
  100: [11, 13, 14],
};

export function validateCompanionLongRunTurnProfiles(): string[] {
  const issues: string[] = [];
  for (const count of [20, 30, 50, 100] as const) {
    const numbers = COMPANION_LONG_RUN_TURN_PROFILES[count];
    if (numbers.length !== count) {
      issues.push(`profile ${count} must contain exactly ${count} turns`);
    }
    if (new Set(numbers).size !== numbers.length) {
      issues.push(`profile ${count} contains duplicate turns`);
    }
    if (numbers.some((number) => number < 1 || number > 100)) {
      issues.push(`profile ${count} contains an out-of-range turn`);
    }
    if (
      !numbers.every(
        (number, index) => index === 0 || number > numbers[index - 1]!,
      )
    ) {
      issues.push(`profile ${count} must preserve manifest order`);
    }
    const included = new Set<number>(numbers);
    for (const number of numbers) {
      for (const predecessor of REQUIRED_PREDECESSORS[number] ?? []) {
        if (!included.has(predecessor)) {
          issues.push(
            `profile ${count} turn ${number} is missing prerequisite turn ${predecessor}`,
          );
        }
      }
    }
    const phases = new Set(
      companionLongRunManifest.turns
        .filter((turn) => included.has(turn.number))
        .map((turn) => turn.phase),
    );
    if (count < 100 && phases.size < 8) {
      issues.push(`profile ${count} must cover at least eight risk phases`);
    }
  }
  return issues;
}

export function selectCompanionLongRunTurns(
  count: CompanionLongRunTurnCount,
): readonly CompanionTurnSpec[] {
  const issues = validateCompanionLongRunTurnProfiles();
  if (issues.length > 0) {
    throw new Error(
      `Invalid companion long-run profiles:\n- ${issues.join("\n- ")}`,
    );
  }
  const selected = new Set<number>(COMPANION_LONG_RUN_TURN_PROFILES[count]);
  return companionLongRunManifest.turns.filter((turn) =>
    selected.has(turn.number),
  );
}
