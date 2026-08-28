import { describe, expect, it } from "vitest";

import { readConfig } from "./config.js";

describe("server configuration", () => {
  it("uses the canonical conversation retention defaults", () => {
    expect(readConfig().conversationRetention).toEqual({
      fullVerbatimHours: 24,
      softTokenLimit: 8_000,
      hardTokenLimit: 12_000,
      minimumTailTokens: 3_000,
      minimumRecentTurns: 12,
    });
  });

  it("defaults schedule negotiation to shadow comparison mode", () => {
    const previous = process.env["SCHEDULE_NEGOTIATION_MODE"];
    delete process.env["SCHEDULE_NEGOTIATION_MODE"];
    try {
      expect(readConfig().scheduleNegotiationMode).toBe("shadow");
    } finally {
      if (previous === undefined)
        delete process.env["SCHEDULE_NEGOTIATION_MODE"];
      else process.env["SCHEDULE_NEGOTIATION_MODE"] = previous;
    }
  });

  it("enables the local state and personal-life loops by default", () => {
    const previousPlanning = process.env["SELF_INITIATED_PLANNING"];
    const previousWorldEffects = process.env["LIVE_WORLD_EFFECTS"];
    delete process.env["SELF_INITIATED_PLANNING"];
    delete process.env["LIVE_WORLD_EFFECTS"];
    try {
      const config = readConfig();
      expect(config.selfInitiatedPlanningMode).toBe("enforced");
      expect(config.liveWorldEffectsMode).toBe("enforced");
    } finally {
      if (previousPlanning === undefined)
        delete process.env["SELF_INITIATED_PLANNING"];
      else process.env["SELF_INITIATED_PLANNING"] = previousPlanning;
      if (previousWorldEffects === undefined)
        delete process.env["LIVE_WORLD_EFFECTS"];
      else process.env["LIVE_WORLD_EFFECTS"] = previousWorldEffects;
    }
  });

  it("allows explicit experiment overrides for both core loops", () => {
    const previousPlanning = process.env["SELF_INITIATED_PLANNING"];
    const previousWorldEffects = process.env["LIVE_WORLD_EFFECTS"];
    process.env["SELF_INITIATED_PLANNING"] = "shadow";
    process.env["LIVE_WORLD_EFFECTS"] = "off";
    try {
      const config = readConfig();
      expect(config.selfInitiatedPlanningMode).toBe("shadow");
      expect(config.liveWorldEffectsMode).toBe("off");
    } finally {
      if (previousPlanning === undefined)
        delete process.env["SELF_INITIATED_PLANNING"];
      else process.env["SELF_INITIATED_PLANNING"] = previousPlanning;
      if (previousWorldEffects === undefined)
        delete process.env["LIVE_WORLD_EFFECTS"];
      else process.env["LIVE_WORLD_EFFECTS"] = previousWorldEffects;
    }
  });

  it("rejects an invalid conversation retention boundary", () => {
    expect(() =>
      readConfig({
        conversationRetention: {
          fullVerbatimHours: 24,
          softTokenLimit: 12_000,
          hardTokenLimit: 8_000,
          minimumTailTokens: 3_000,
          minimumRecentTurns: 12,
        },
      }),
    ).toThrowError(/softTokenLimit/u);
  });
});
