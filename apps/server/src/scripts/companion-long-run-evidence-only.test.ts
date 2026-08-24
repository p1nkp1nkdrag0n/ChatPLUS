import { describe, expect, it } from "vitest";

import {
  buildCompanionEvidenceOnlySummary,
  extractCompanionSummaryFacts,
  supportedCompanionSummaryFacts,
} from "./companion-long-run-evidence-only";

describe("companion long-run evidence-only summaries", () => {
  it.each([
    "我不喜欢香菜。",
    "我并不喜欢吃香菜。",
    "我不太喜欢香菜。",
    "我不怎么喜欢香菜。",
  ])("preserves a negated cilantro preference: %s", (statement) => {
    const extracted = extractCompanionSummaryFacts(statement);
    expect(extracted).toContain("cilantro:dislikes");
    expect(extracted).not.toContain("cilantro:likes");

    const evidence = [{ memoryContent: statement, evidenceQuote: statement }];
    expect(supportedCompanionSummaryFacts(evidence)).toContain(
      "cilantro:dislikes",
    );
    const summary = buildCompanionEvidenceOnlySummary(evidence);
    expect(summary).toContain("你不喜欢香菜");
    expect(summary).not.toMatch(/你喜欢香菜/u);
  });

  it("still recognizes an affirmative cilantro preference", () => {
    const statement = "我喜欢香菜。";
    const summary = buildCompanionEvidenceOnlySummary([
      { memoryContent: statement, evidenceQuote: statement },
    ]);

    expect(extractCompanionSummaryFacts(statement)).toContain("cilantro:likes");
    expect(summary).toContain("你喜欢香菜");
  });
});
