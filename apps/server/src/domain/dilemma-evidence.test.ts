import { describe, expect, it } from "vitest";

import type { DilemmaOption } from "@personasim/contracts";

import {
  applyDilemmaEvidenceToOptions,
  dilemmaCorrectionMatchesOptions,
  extractDilemmaTurnEvidence,
} from "./dilemma-evidence.js";

describe("generic dilemma evidence", () => {
  it("extracts structured options and reusable decision context", () => {
    expect(
      extractDilemmaTurnEvidence(
        "选项 B 是去成都的清岚工作室。项目更喜欢，但需要搬家。",
      ),
    ).toEqual({
      kind: "option",
      optionKey: "B",
      optionIndex: 1,
      label: "去成都的清岚工作室",
    });
    expect(
      extractDilemmaTurnEvidence(
        "周然认为我应该去成都；伴侣更担心项目合同的风险。",
      ),
    ).toEqual({ kind: "context" });
    expect(
      extractDilemmaTurnEvidence("今天天气很好，我去散了步。"),
    ).toBeUndefined();
  });

  it("replaces a corrected fact in the option that contains the old value", () => {
    const sourceText =
      "更正一个事实：清岚工作室后来把签约期限延到 10 月 8 日，不是 10 月 5 日。";
    const evidence = extractDilemmaTurnEvidence(sourceText);
    expect(evidence).toEqual({
      kind: "correction",
      replacement: {
        previousValue: "10 月 5 日",
        currentValue: "10 月 8 日",
      },
    });
    if (evidence === undefined)
      throw new Error("Expected correction evidence.");

    expect(
      dilemmaCorrectionMatchesOptions(options(), evidence, sourceText),
    ).toBe(true);

    const updated = applyDilemmaEvidenceToOptions(
      options(),
      evidence,
      sourceText,
    );
    expect(updated[0]?.description).toBe("留在现岗位，继续观察。");
    expect(updated[1]?.description).toContain("10 月 8 日");
    expect(updated[1]?.description).not.toContain("10 月 5 日");

    const unrelated =
      extractDilemmaTurnEvidence("更正：牙医预约改到周五，不是周四。");
    expect(unrelated).toBeDefined();
    if (unrelated === undefined)
      throw new Error("Expected unrelated correction evidence.");
    expect(
      dilemmaCorrectionMatchesOptions(
        options(),
        unrelated,
        "牙医预约改到周五，不是周四。",
      ),
    ).toBe(false);
  });
});

function options(): DilemmaOption[] {
  return [
    {
      id: "option-a",
      label: "保留现岗位",
      description: "留在现岗位，继续观察。",
      likelyTradeoffs: ["稳定，但成长较慢"],
      valuesAtStake: ["稳定"],
    },
    {
      id: "option-b",
      label: "加入清岚工作室",
      description: "加入清岚工作室，签约期限是 10 月 5 日。",
      likelyTradeoffs: ["项目更喜欢，但合同较短"],
      valuesAtStake: ["成长"],
    },
  ];
}
