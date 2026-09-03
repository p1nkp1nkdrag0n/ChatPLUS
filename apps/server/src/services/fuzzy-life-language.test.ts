import { describe, expect, it } from "vitest";

import {
  compactLifePromptText,
  exactlyOne,
  hasExplicitCausalStageReference,
  inferActionKind,
  inferOutcomeValence,
  isActionEvidence,
  isDelegatedDecision,
  isOutcomeEvidence,
  isReflectionEvidence,
  parseScaleMetric,
  pressureKind,
  reflectionStance,
  supportMode,
} from "./fuzzy-life-language.js";

describe("fuzzy-life language helpers", () => {
  it("keeps explicit delegation separate from a negated delegation", () => {
    expect(isDelegatedDecision("这次请你替我决定选哪个")).toBe(true);
    expect(isDelegatedDecision("这次不要你替我决定，我自己选")).toBe(false);
  });

  it("preserves support-mode precedence", () => {
    expect(supportMode("随便", true, false)).toBe("delegated_decision");
    expect(supportMode("请陪我一起分析收益和代价", false, false)).toBe(
      "deliberate",
    );
    expect(supportMode("先听我说，不要分析", false, true)).toBe("listen_only");
    expect(supportMode("请直接推荐一个方向", false, false)).toBe("recommend");
    expect(supportMode("我该不该换工作", false, true)).toBe("deliberate");
    expect(supportMode("今天有点累", false, false)).toBe("listen_only");
  });

  it("parses explicit ten-point scales and clamps the result", () => {
    expect(parseScaleMetric("压力大概 7.5 / 10", "pressure")).toBe(0.75);
    expect(parseScaleMetric("清晰度升到 12/10", "clarity")).toBe(1);
    expect(parseScaleMetric("压力有一点高", "pressure")).toBeUndefined();
  });

  it("does not turn negated plans or provenance questions into actions", () => {
    expect(isActionEvidence("我今天已经提交了申请")).toBe(true);
    expect(isActionEvidence("我还没有提交申请，只是计划去做")).toBe(false);
    expect(isActionEvidence("请按顺序回顾决定、行动和结果分别是什么")).toBe(
      false,
    );
  });

  it("requires observed outcome language instead of questions or scale-only feedback", () => {
    expect(isOutcomeEvidence("后来公司同意了申请，结果比预期更好")).toBe(true);
    expect(isOutcomeEvidence("还没有最终结果，公司也没有反馈")).toBe(false);
    expect(isOutcomeEvidence("压力 6/10，清晰度 8/10")).toBe(false);
  });

  it("distinguishes reflection evidence from a reflection request", () => {
    expect(isReflectionEvidence("回头看，我很庆幸做了这个决定")).toBe(true);
    expect(isReflectionEvidence("你现在怎么看自己的选择？")).toBe(false);
    expect(reflectionStance("我仍认同这个方向，但也担心代价")).toBe("mixed");
    expect(reflectionStance("我后悔了，觉得自己选错了")).toBe("reverse");
  });

  it("keeps causal-stage gates and small normalization helpers deterministic", () => {
    expect(
      hasExplicitCausalStageReference(
        "为了这个决定，我已经开始落实第一步",
        "action",
      ),
    ).toBe(true);
    expect(
      hasExplicitCausalStageReference("后来公司回复并同意了", "outcome"),
    ).toBe(true);
    expect(inferActionKind("我已经完成了申请")).toBe("completed");
    expect(inferOutcomeValence("结果成功了，但收入更不稳定")).toBe("mixed");
    expect(pressureKind("creative")).toBe("work");
    expect(exactlyOne(["only"])).toBe("only");
    expect(exactlyOne(["one", "two"])).toBeUndefined();
    expect(compactLifePromptText("  一段\n  文本  ", 20)).toBe("一段 文本");
  });
});
