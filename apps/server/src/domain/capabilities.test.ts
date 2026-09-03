import { describe, expect, it } from "vitest";

import { capabilitiesForRuntime, capabilitiesForTier } from "./capabilities.js";

describe("simulation capability boundaries", () => {
  it("represents fuzzy life without advertising an exact schedule", () => {
    const capabilities = capabilitiesForRuntime("high_fidelity", "fuzzy");

    expect(capabilities).toMatchObject({
      fuzzyLife: true,
      legacyExactSchedule: false,
      schedule: false,
    });
  });

  it("retains the old schedule alias only for explicit legacy regression", () => {
    const capabilities = capabilitiesForRuntime(
      "high_fidelity",
      "legacy_exact",
    );

    expect(capabilities).toMatchObject({
      fuzzyLife: false,
      legacyExactSchedule: true,
      schedule: true,
    });
  });

  it("keeps tier support separate from the selected runtime world model", () => {
    expect(capabilitiesForTier("daily").legacyExactSchedule).toBe(true);
    expect(capabilitiesForTier("lightweight").legacyExactSchedule).toBe(false);
  });
});
