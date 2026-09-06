import { describe, expect, it } from "vitest";
import {
  isCompleteEvidenceSelection,
  validateEvidenceSemantics,
  validateEvidenceSpan,
} from "./evidence-semantics.js";

describe("complete-source semantic boundary", () => {
  it.each([
    ["我没有辞职，只是考虑过。", "用户已经辞职。"],
    ["我不是不喜欢父亲，今天只是不想谈。", "用户不喜欢父亲。"],
    ["她说自己准备搬家。", "用户准备搬家。"],
    ["如果拿到录取，我就搬过去。", "用户已经决定搬家。"],
    ["今天我什么人都不想见。", "用户不喜欢社交。"],
    ["用户说‘我已经通过面试’。", "系统独立验证用户已通过面试。"],
    ["Finished the morning run.", "Never finished the morning run."],
  ])("does not use shared words as entailment: %s", (sourceText, candidate) => {
    expect(validateEvidenceSemantics({ sourceText, candidate }).verdict).toBe(
      "insufficient",
    );
    expect(
      validateEvidenceSemantics({ sourceText, candidate: sourceText }).verdict,
    ).toBe("supported");
  });

  it("does not mistake a valid substring for a complete claim", () => {
    const text = "她说自己准备搬家。";
    expect(
      validateEvidenceSpan({
        sourceId: "m1",
        citedSourceId: "m1",
        text,
        quote: "准备搬家",
        start: 4,
        end: 8,
      }),
    ).toBe(true);
    expect(
      validateEvidenceSpan({
        sourceId: "m1",
        citedSourceId: "m2",
        text,
        quote: "准备搬家",
        start: 4,
        end: 8,
      }),
    ).toBe(false);
    expect(
      validateEvidenceSemantics({ sourceText: text, candidate: "准备搬家" })
        .verdict,
    ).toBe("insufficient");
  });

  it("requires exact server reports and whole summary entries", () => {
    const sourceText = "我没有成功。";
    const verifiedReport = `对方在对话中说过：「${sourceText}」`;
    expect(
      validateEvidenceSemantics({
        candidate: verifiedReport,
        sourceText,
        verifiedReport,
        allowVerbatim: false,
      }).verdict,
    ).toBe("supported");
    expect(
      validateEvidenceSemantics({
        candidate: verifiedReport + "所以他总是失败。",
        sourceText,
        verifiedReport,
      }).verdict,
    ).toBe("insufficient");
    expect(
      isCompleteEvidenceSelection("甲。\n乙。", ["甲。", "乙。", "丙。"]),
    ).toBe(true);
    expect(
      isCompleteEvidenceSelection("我成功了。", [
        "我成功了。\n刚才是在引用别人。",
      ]),
    ).toBe(false);
  });
});
