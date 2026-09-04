import { describe, expect, it } from "vitest";

import {
  buildKeepsakeSemanticKey,
  evaluateKeepsakeEligibility,
  type KeepsakeSourceCandidate,
} from "./eligibility.js";

const NOW = "2026-09-20T12:00:00.000Z";

function candidate(
  overrides: Partial<KeepsakeSourceCandidate> = {},
): KeepsakeSourceCandidate {
  return {
    agentId: "agent-1",
    sourceType: "life_outcome",
    sourceId: "outcome-1",
    status: "confirmed",
    significance: 0.86,
    effectiveAtUtc: "2026-09-08T12:00:00.000Z",
    semanticTags: ["cinema", "rain"],
    ...overrides,
  };
}

describe("keepsake deterministic eligibility", () => {
  it("rejects planned, unknown, low-significance, and future sources before a model call", () => {
    expect(
      evaluateKeepsakeEligibility(candidate({ status: "planned" }), [], NOW)
        .reasonCodes,
    ).toContain("source_not_settled");
    expect(
      evaluateKeepsakeEligibility(candidate({ status: "unknown" }), [], NOW)
        .reasonCodes,
    ).toContain("source_not_settled");
    expect(
      evaluateKeepsakeEligibility(candidate({ significance: 0.4 }), [], NOW)
        .reasonCodes,
    ).toContain("below_significance_threshold");
    expect(
      evaluateKeepsakeEligibility(
        candidate({ effectiveAtUtc: "2026-09-21T00:00:00.000Z" }),
        [],
        NOW,
      ).reasonCodes,
    ).toContain("source_in_future");
  });

  it("accepts only read letters as durable letter sources", () => {
    expect(
      evaluateKeepsakeEligibility(
        candidate({ sourceType: "letter", status: "observed" }),
        [],
        NOW,
      ).eligible,
    ).toBe(false);
    expect(
      evaluateKeepsakeEligibility(
        candidate({ sourceType: "letter", status: "read" }),
        [],
        NOW,
      ).eligible,
    ).toBe(true);
  });

  it("deduplicates an identical semantic source and enforces same-kind cooldown", () => {
    const input = candidate();
    const decision = evaluateKeepsakeEligibility(input, [], NOW);
    expect(decision).toMatchObject({ eligible: true, kind: "ticket_stub" });

    expect(
      evaluateKeepsakeEligibility(
        input,
        [
          {
            kind: decision.kind,
            semanticKey: decision.semanticKey,
            createdEffectiveAtUtc: "2026-09-07T12:00:00.000Z",
          },
        ],
        NOW,
      ).reasonCodes,
    ).toEqual(["duplicate_semantic_signature", "kind_cooldown_active"]);
  });

  it("builds a code-unit-stable key independent of tag order and duplicates", () => {
    const first = candidate({ semanticTags: ["雨", "cinema", "雨"] });
    const second = candidate({ semanticTags: ["cinema", "雨"] });
    expect(buildKeepsakeSemanticKey(first, "ticket_stub")).toBe(
      buildKeepsakeSemanticKey(second, "ticket_stub"),
    );
  });

  it("derives the first structured template kind without model discretion", () => {
    expect(
      evaluateKeepsakeEligibility(
        candidate({ semanticTags: ["旅行", "location"] }),
        [],
        NOW,
      ).kind,
    ).toBe("postcard");
    expect(
      evaluateKeepsakeEligibility(
        candidate({ semanticTags: ["食谱", "food"] }),
        [],
        NOW,
      ).kind,
    ).toBe("recipe_or_note_card");
  });
});
