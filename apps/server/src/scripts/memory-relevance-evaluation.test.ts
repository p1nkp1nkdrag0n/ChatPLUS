import { describe, expect, it } from "vitest";

import { evaluateMemoryRelevance } from "./memory-relevance-evaluation.js";

describe("retrieval and use 2x2 mechanism experiment", () => {
  it("separates semantic candidate recall from permission to mention", () => {
    const results = evaluateMemoryRelevance();
    for (const caseId of ["paraphrase", "chinese-paraphrase"]) {
      const arms = results.filter((item) => item.caseId === caseId);
      expect(arms.map((item) => item.selectedMemoryIds.length)).toEqual([
        0, 0, 1, 1,
      ]);
      expect(arms.map((item) => item.explicitMemoryIds.length)).toEqual([
        0, 0, 0, 1,
      ]);
    }
  });

  it("preserves independently labeled authority, scope and repetition constraints in every arm", () => {
    const results = evaluateMemoryRelevance();
    expect(results).toHaveLength(48);
    for (const result of results) {
      expect(
        result.checks.forbiddenRecall,
        `${result.caseId}/${result.arm}`,
      ).toEqual([]);
      expect(
        result.checks.forbiddenUse,
        `${result.caseId}/${result.arm}`,
      ).toEqual([]);
      expect(
        result.checks.unexpectedMentions,
        `${result.caseId}/${result.arm}`,
      ).toEqual([]);
    }
    expect(
      results
        .filter((item) => item.caseId === "lexical-unindexed")
        .every((item) => item.checks.missedRelevantMemories.length === 0),
    ).toBe(true);
    for (const result of results.filter(
      (item) => item.caseId === "behavior-only",
    )) {
      expect(result.use.behavioralPreferenceEvidenceIds).toEqual([
        "evidence-listening",
      ]);
      expect(result.explicitMemoryIds).toEqual([]);
    }
  });
});
