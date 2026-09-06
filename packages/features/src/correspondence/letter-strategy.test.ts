import { describe, expect, it } from "vitest";

import { deriveLetterStrategy } from "./letter-strategy.js";

describe("deriveLetterStrategy", () => {
  it("keeps every soft character budget inside the 400-1600 letter range", () => {
    for (const strategy of [
      deriveLetterStrategy("短笺", {
        characterVerbosity: -10,
        relationship: { closeness: -1, trust: -1 },
        stationeryType: "postcard",
      }),
      deriveLetterStrategy("很长的原信".repeat(2_000), {
        characterVerbosity: 10,
        relationship: { closeness: 10, trust: 10 },
        stationeryType: "extended",
      }),
    ]) {
      expect(strategy.targetMinChars).toBeGreaterThanOrEqual(400);
      expect(strategy.targetMinChars).toBeLessThanOrEqual(strategy.targetChars);
      expect(strategy.targetChars).toBeLessThanOrEqual(strategy.targetMaxChars);
      expect(strategy.targetMaxChars).toBeLessThanOrEqual(1_600);
    }
  });

  it("allows a longer original, a verbose character, and extended paper more room", () => {
    const restrained = deriveLetterStrategy("近来可好？", {
      characterVerbosity: 0.1,
      relationship: { closeness: 0.2, trust: 0.3 },
      stationeryType: "postcard",
    });
    const expansive = deriveLetterStrategy("这一阵发生了许多事。".repeat(120), {
      characterVerbosity: 0.9,
      relationship: { closeness: 0.9, trust: 0.9 },
      stationeryType: "extended",
    });

    expect(expansive.targetChars).toBeGreaterThan(restrained.targetChars);
    expect(expansive.paragraphCount).toBeGreaterThan(restrained.paragraphCount);
    expect(expansive.salutationStyle).toBe("intimate");
    expect(expansive.closingStyle).toBe("affectionate");
  });

  it("returns expression controls without inventing factual content", () => {
    const strategy = deriveLetterStrategy("明天也许会去旅行。", {
      relationship: { closeness: 0.6, trust: 0.7 },
    });

    expect(strategy.evidenceGuidance).toContain("supplies no facts");
    expect(strategy).not.toHaveProperty("facts");
    expect(strategy).not.toHaveProperty("topics");
    expect(strategy).not.toHaveProperty("events");
  });
});
