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

  it("extracts source values only from spans matched in classified text", () => {
    const quotedOption = "“选项 A 是旧值”";
    const sourceText = `我在补充选项：${quotedOption}不要采纳，选项 B 是新值。`;
    const classificationText = sourceText.replace(
      quotedOption,
      " ".repeat(quotedOption.length),
    );

    expect(extractDilemmaTurnEvidence(sourceText, classificationText)).toEqual({
      kind: "option",
      optionKey: "B",
      optionIndex: 1,
      label: "新值",
    });
    expect(
      extractDilemmaTurnEvidence(
        "朋友说“选项 A 是杭州项目”。",
        "朋友说            。",
      ),
    ).toBeUndefined();
  });

  it("keeps aligned quoted values while ignoring quoted structural evidence", () => {
    for (const [sourceText, expectedLabel] of [
      ["“背景备注”选项 B 是去北京。", "去北京"],
      ["选项 B 是去北京，结尾“备注”。", "去北京"],
      ["选项 B 是“去北京”。", "去北京"],
    ] as const) {
      expect(
        extractDilemmaTurnEvidence(sourceText, maskQuoted(sourceText)),
        sourceText,
      ).toEqual({
        kind: "option",
        optionKey: "B",
        optionIndex: 1,
        label: expectedLabel,
      });
    }

    const correction = "更正：不是“杭州”，而是“北京”。";
    expect(
      extractDilemmaTurnEvidence(correction, maskQuoted(correction)),
    ).toEqual({
      kind: "correction",
      replacement: { previousValue: "杭州", currentValue: "北京" },
    });
    const rescheduled = "签约期限从“10月5日”改到“10月8日”。";
    expect(
      extractDilemmaTurnEvidence(rescheduled, maskQuoted(rescheduled)),
    ).toEqual({
      kind: "correction",
      replacement: { previousValue: "10月5日", currentValue: "10月8日" },
    });
  });

  it("uses classified text for option tradeoffs and values while preserving source text", () => {
    const sourceText =
      "选项 A 是留在上海，收入稳定；备注‘分手、梦想、压力’不是选择依据。";
    const classificationText = maskQuoted(sourceText);
    const evidence = extractDilemmaTurnEvidence(sourceText, classificationText);
    expect(evidence).toEqual({
      kind: "option",
      optionKey: "A",
      optionIndex: 0,
      label: "留在上海",
    });
    if (evidence === undefined) throw new Error("Expected option evidence.");

    const updated = applyDilemmaEvidenceToOptions(
      options(),
      evidence,
      sourceText,
      classificationText,
    );
    expect(updated[0]?.description).toBe(sourceText);
    expect(updated[0]?.valuesAtStake).toEqual(["稳定与成长"]);
    expect(updated[0]?.likelyTradeoffs.join(" ")).not.toMatch(
      /分手|梦想|压力/u,
    );
  });
});

function maskQuoted(text: string): string {
  return text.replace(/“[^”]*”|‘[^’]*’/gu, (value) => " ".repeat(value.length));
}

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
