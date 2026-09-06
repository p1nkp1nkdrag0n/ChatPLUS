import { describe, expect, it } from "vitest";

import {
  CharacterGoalSchema,
  OriginalCharacterInputSchema,
} from "./character.js";

const GOAL = {
  id: "goal-1",
  title: "完成一部长片",
  description: "持续完成一部长片",
  priority: 0.9,
  progress: 0.05,
  origin: "user_spec" as const,
  sourceRefs: ["original-form"],
};

describe("character authoring contracts", () => {
  it("normalizes absent author tensions and goals without requiring three labels", () => {
    const input = {
      name: "阿澄",
      worldSetting: "当代城市",
      workOrRole: "书店店员",
      coreTraits: ["习惯先听别人说完"],
      initialRelationship: "邻居",
      dialogueStyle: "轻松自然",
      tier: "daily",
    };
    expect(OriginalCharacterInputSchema.parse(input)).toMatchObject({
      coreTraits: ["习惯先听别人说完"],
    });
    const blank = OriginalCharacterInputSchema.parse({
      ...input,
      mainGoal: "  ",
      coreContradiction: "",
    });
    expect(blank.mainGoal).toBeUndefined();
    expect(blank.coreContradiction).toBeUndefined();
    expect(
      OriginalCharacterInputSchema.safeParse({ ...input, coreTraits: [] })
        .success,
    ).toBe(false);
  });
  it("keeps legacy goals readable while validating time milestone order", () => {
    expect(CharacterGoalSchema.parse(GOAL)).not.toHaveProperty("milestones");

    expect(
      CharacterGoalSchema.safeParse({
        ...GOAL,
        milestones: [
          {
            id: "milestone-1",
            afterDays: 0,
            title: "起步",
            focus: "梳理素材",
          },
          {
            id: "milestone-2",
            afterDays: 14,
            title: "形成节奏",
            focus: "稳定推进",
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      CharacterGoalSchema.safeParse({
        ...GOAL,
        milestones: [
          {
            id: "milestone-1",
            afterDays: 1,
            title: "错误起点",
            focus: "不应通过",
          },
          {
            id: "milestone-2",
            afterDays: 1,
            title: "重复日期",
            focus: "不应通过",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts a long optional author brief without weakening the anchor fields", () => {
    const parsed = OriginalCharacterInputSchema.parse({
      name: "卓娅",
      worldSetting: "1951 年的苏联明斯克",
      workOrRole: "档案员",
      coreTraits: ["冷静", "克制", "有责任感"],
      coreContradiction: "害怕再次失去，却不愿把恐惧转嫁给亲近的人",
      mainGoal: "参与城市档案重建",
      initialRelationship: "共同生活两年的师生",
      dialogueStyle:
        "通常说俄语，并在每个俄语消息单元后给出中文翻译；日常表达克制自然。",
      characterBrief: "人物经历与关系材料。".repeat(300),
      tier: "high_fidelity",
      timezone: "Europe/Minsk",
    });

    expect(parsed.characterBrief?.length).toBeGreaterThan(1_000);
    expect(parsed.name).toBe("卓娅");
  });
});
