import { describe, expect, it } from "vitest";

import { createLifeContextPromptSegment } from "./default-segments.js";
import { estimatePromptTokens, PromptSegmentRegistry } from "./registry.js";

function longLivedLifeContext() {
  return {
    authority: "server_persisted_fuzzy_life",
    recentDecisionDilemmas: Array.from({ length: 4 }, (_, index) => ({
      id: `dilemma-${String(index)}`,
      summary: `困境${String(index)}-${"证据".repeat(225)}`,
      closingDecisionId: `decision-${String(index)}`,
    })),
    evidencedSupport: Array.from({ length: 8 }, (_, index) => ({
      id: `support-${String(index)}`,
      sourceMessageId: `message-${String(index)}`,
      summary: `支持${String(index)}-${"陪伴".repeat(140)}`,
    })),
    canonicalCausalFacts: [
      {
        dilemmaId: "dilemma-0",
        decision: {
          decisionId: "decision-0",
          selectionSummary: "选择稳定工作，独立项目尚未启动。",
        },
        actions: [{ actionId: "action-0", summary: "已签署工作合同。" }],
        outcomes: [{ outcomeId: "outcome-0", summary: "尚未收到首月工资。" }],
      },
    ],
  };
}

describe("fuzzy-life prompt segment budget", () => {
  it("retains a complete long-lived Chinese causal projection above the former local slot", () => {
    const lifeContext = longLivedLifeContext();
    const expected = `LIFE_CONTEXT_JSON\n${JSON.stringify(lifeContext)}`;
    expect(estimatePromptTokens(expected)).toBeGreaterThan(8_000);

    const registry = new PromptSegmentRegistry([
      createLifeContextPromptSegment(),
    ]);
    const result = registry.render({ lifeContext }, { maxInputTokens: 16_000 });

    expect(result.prompt).toBe(expected);
    expect(
      JSON.parse(result.prompt.slice("LIFE_CONTEXT_JSON\n".length)),
    ).toEqual(lifeContext);
    expect(result.trace.segments[0]).toMatchObject({
      included: true,
      truncated: false,
    });
    expect(result.trace.estimatedInputTokens).toBeLessThanOrEqual(16_000);
  });

  it("still drops the complete causal projection when the global input budget cannot fit it", () => {
    const registry = new PromptSegmentRegistry([
      createLifeContextPromptSegment(),
    ]);
    const result = registry.render(
      { lifeContext: longLivedLifeContext() },
      { maxInputTokens: 8_000 },
    );

    expect(result.prompt).toBe("");
    expect(result.trace.segments[0]).toMatchObject({
      included: false,
      truncated: false,
      reason: "global_budget",
    });
  });

  it("still rejects oversized local payloads even when the global budget is large", () => {
    const registry = new PromptSegmentRegistry([
      createLifeContextPromptSegment(),
    ]);
    const result = registry.render(
      {
        lifeContext: {
          authority: "server_persisted_fuzzy_life",
          evidence: "证据".repeat(4_000),
        },
      },
      { maxInputTokens: 32_000 },
    );

    expect(result.prompt).toBe("");
    expect(result.trace.segments[0]).toMatchObject({
      included: false,
      truncated: false,
      reason: "segment_budget",
    });
  });
});
