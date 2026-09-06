import { describe, expect, it } from "vitest";
import type { DilemmaEpisode } from "@personasim/contracts";
import {
  dilemmaScopeScore,
  extractDilemmaChoices,
  matchDilemmaOption,
} from "./fuzzy-life-choice.js";

function dilemma(
  labels: [string, string],
  title = labels.join("还是"),
): DilemmaEpisode {
  return {
    id: "test-dilemma",
    agentId: "test-agent",
    subject: "user",
    domain: "rest",
    status: "open",
    sourceMessageIds: ["test-message"],
    effectiveLocalDate: "2026-09-01",
    effectivePeriod: "morning",
    temporalPrecision: "period",
    recordedAtUtc: "2026-09-01T01:00:00.000Z",
    updatedAtUtc: "2026-09-01T01:00:00.000Z",
    idempotencyKey: "test-dilemma",
    schemaVersion: 1,
    title,
    summary: title,
    options: labels.map((label, index) => ({
      id: `option-${index}`,
      label,
      description: label,
      likelyTradeoffs: ["待讨论"],
      valuesAtStake: [],
    })),
  };
}

describe("grounded dilemma choices", () => {
  it.each([
    ["我该不该辞职？", ["辞职", "不辞职"]],
    ["今晚散步二十分钟还是整理十张照片？", ["散步二十分钟", "整理十张照片"]],
    [
      "这次请你只在出门散步和整理照片之间替我选一个。",
      ["出门散步", "整理照片"],
    ],
    ["我不知道该选留在本地还是去外地实习。", ["留在本地", "去外地实习"]],
    ["我在“在家阅读”和“骑车去公园”之间犹豫。", ["在家阅读", "骑车去公园"]],
  ] as const)("extracts the offered alternatives: %s", (text, labels) => {
    expect(extractDilemmaChoices(text)?.labels).toEqual(labels);
  });

  it("keeps a missing structured counterpart explicitly unknown", () => {
    expect(extractDilemmaChoices("选项 B 是“去北京”。")).toEqual({
      labels: ["选项 A（尚未说明）", "去北京"],
      incomplete: true,
    });
  });

  it.each([
    "这不算逃避，我觉得你可以慢慢想。",
    "今天有点累，先陪我待会儿。",
    "你帮我决定吧。",
  ])("does not fabricate alternatives from an affirmation: %s", (text) => {
    expect(extractDilemmaChoices(text)).toBeUndefined();
  });

  it("does not match a different choice because it is the only old dilemma", () => {
    const old = dilemma(["完成一幅素描", "今晚暂停画画"]);
    const scope = "这次只在散步二十分钟和整理照片之间替我决定。";
    expect(dilemmaScopeScore(old, scope, extractDilemmaChoices(scope))).toBe(0);
    expect(dilemmaScopeScore(old, "这次请你替我决定")).toBe(0);
    expect(dilemmaScopeScore(old, "这幅素描该怎么办")).toBeGreaterThan(0);
  });

  it.each([
    ["我的决定：整理照片。", 1],
    ["我选散步，照片明天再整理。", 0],
    ["不要选散步。我选择整理照片。", 1],
    ["整理照片吧。", 1],
    ["我的建议是选 B。", 1],
    ["我的建议：选项 B。", 1],
    ["出去走二十分钟吧。", 0],
    ["散步和整理照片都可以。", undefined],
    ["我理解你很累，先不急着定。", undefined],
    ["如果是我，我可能会选散步。", undefined],
    ["请你选散步。", undefined],
  ] as const)("binds only the actual selected option: %s", (text, expected) => {
    expect(
      matchDilemmaOption(dilemma(["散步二十分钟", "整理照片"]), text)?.id,
    ).toBe(expected === undefined ? undefined : `option-${expected}`);
  });

  it.each([
    ["我的决定：辞职。", 0],
    ["我的决定：不辞职。", 1],
    ["我的决定：离开当前这份工作。", 0],
    ["我选择不辞职，因为准备还不充分。", 1],
  ] as const)("keeps opposite choices distinct: %s", (text, expected) => {
    expect(matchDilemmaOption(dilemma(["辞职", "不辞职"]), text)?.id).toBe(
      `option-${expected}`,
    );
  });

  it.each(["压力还是 7/10。", "决定权还是在我。", "我最终还是自己决定。"])(
    "does not mistake a state or retained authority for alternatives: %s",
    (text) => {
      expect(extractDilemmaChoices(text)).toBeUndefined();
    },
  );

  it("does not use shared duration as the topic or selection", () => {
    const options = dilemma(["散步二十分钟", "整理照片二十分钟"]);
    expect(matchDilemmaOption(options, "二十分钟就好。")).toBeUndefined();
    expect(dilemmaScopeScore(options, "今晚画画二十分钟")).toBe(0);
  });

  it("does not bind a new object through a generic shared activity verb", () => {
    const old = dilemma(["整理书架", "清理衣柜"]);
    const text = "只在整理照片和整理笔记之间替我决定";
    expect(dilemmaScopeScore(old, text, extractDilemmaChoices(text))).toBe(0);
  });

  it("recognizes a yes/no reference to an existing concrete option", () => {
    const old = dilemma(["留在目前公司", "正式辞职"]);
    const text = "这次请你替我决定要不要辞职。";
    expect(
      dilemmaScopeScore(old, text, extractDilemmaChoices(text)),
    ).toBeGreaterThan(0);
    const unrelated = "这次请你替我决定要不要搬家。";
    expect(
      dilemmaScopeScore(old, unrelated, extractDilemmaChoices(unrelated)),
    ).toBe(0);
  });
});
