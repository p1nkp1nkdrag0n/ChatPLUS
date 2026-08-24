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

  it("keeps both new rollout controls in legacy unless explicitly promoted", () => {
    const config = readConfig({
      databasePath: ":memory:",
      turnPipelineMode: "legacy",
      personaContextMode: "legacy",
    });

    expect(config.turnPipelineMode).toBe("legacy");
    expect(config.personaContextMode).toBe("legacy");
  });

  it("rejects an enforced split pipeline backed by the legacy schedule writer", () => {
    expect(() =>
      readConfig({
        databasePath: ":memory:",
        turnPipelineMode: "enforced",
        scheduleNegotiationMode: "legacy",
      }),
    ).toThrow(/legacy schedule writer/u);
  });
});
