import { describe, expect, it } from "vitest";

import { selectCharacterContextForTurn } from "./character-context-selection.js";
import { buildConversationContextPlan } from "./conversation-context-plan.js";
import type { AssemblePromptInput } from "./prompt-assembler.js";

const character: AssemblePromptInput["character"] = {
  tier: "daily",
  identity: {
    name: "阿澄",
    workOrRole: "摄影师",
    worldSetting: "现代城市",
    selfDescription: "住在河边的摄影师",
    timezone: "Asia/Shanghai",
  },
  persona: {
    traits: [{ name: "独立" }],
    values: [{ name: "诚实", description: "不为讨好而改变事实" }],
    goals: [
      {
        id: "album",
        title: "完成摄影集",
        description: "整理暗房底片与海边照片",
      },
      { id: "running", title: "参加城市马拉松", description: "坚持长跑训练" },
      { id: "garden", title: "种一座玫瑰花园", description: "学习种植玫瑰" },
      { id: "book", title: "读完天文书籍", description: "了解星空和星座" },
    ],
    contradictions: [
      {
        id: "album_tension",
        sideA: "想独立完成摄影集",
        sideB: "愿意听取暗房老师的帮助",
        triggerConditions: ["摄影集的暗房底片需要修复"],
      },
      {
        id: "generic_tension",
        sideA: "重视生活中的独立",
        sideB: "也需要朋友的支持",
        triggerConditions: ["需要决定或面对工作压力时"],
      },
    ],
    preferences: [],
    boundaries: [],
  },
  dialogue: {},
  userRelationship: {},
  routines: [],
  schedulePolicy: {},
  proactivePolicy: {},
  knowledge: { knownFacts: [], uncertainFacts: [], forbiddenMetaKnowledge: [] },
};
function plan(originalQuery: string) {
  return buildConversationContextPlan({
    originalQuery,
    agentId: "agent",
    sessionId: "session",
    recentMessages: [],
  });
}

describe("optional character goal and contradiction exposure", () => {
  it.each([
    "今天吃到了很好吃的面包。",
    "今天工作压力很大，为什么我总把事情搞砸？",
    "请给我工作方面的建议。",
  ])(
    "keeps ordinary sharing and unrelated support free of character goals: %s",
    (text) => {
      const result = selectCharacterContextForTurn(character, plan(text));
      expect(result.character.persona.goals).toEqual([]);
      expect(result.character.persona.contradictions).toEqual([]);
      expect(result.character.persona.values).toBe(character.persona.values);
      expect(character.persona.goals).toHaveLength(4);
    },
  );

  it("retains bounded intentions for a direct character question without defaulting to inner conflicts", () => {
    const result = selectCharacterContextForTurn(
      character,
      plan("你最近有什么计划和目标？"),
    );
    expect(result.selectedGoalIds).toHaveLength(3);
    expect(result.selectedContradictionIds).toEqual([]);
    expect(
      selectCharacterContextForTurn(character, plan("你最近过得怎么样？"))
        .selectedGoalIds,
    ).toHaveLength(3);
  });

  it("keeps specific topics and triggered tensions rather than every unrelated life strand", () => {
    const result = selectCharacterContextForTurn(
      character,
      plan("那本摄影集的暗房底片修复得怎么样了？"),
    );
    expect(result.selectedGoalIds).toEqual(["album"]);
    expect(result.selectedContradictionIds).toEqual(["album_tension"]);
    expect(
      selectCharacterContextForTurn(character, plan("你的矛盾和纠结有哪些？"))
        .selectedContradictionIds,
    ).toHaveLength(2);
  });

  it("supports empty personas and preserves the exact old path when no plan was supplied", () => {
    const legacy = selectCharacterContextForTurn(character);
    expect(legacy.character).toBe(character);
    expect(legacy.selectedGoalIds).toHaveLength(4);
    expect(legacy.policyVersion).toBe("legacy_all");
    const empty = {
      ...character,
      persona: { ...character.persona, goals: [], contradictions: [] },
    };
    expect(
      selectCharacterContextForTurn(empty, plan("你最近有什么目标？")).character
        .persona.goals,
    ).toEqual([]);
  });
});
