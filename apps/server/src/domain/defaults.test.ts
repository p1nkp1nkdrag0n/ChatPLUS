import { describe, expect, it } from "vitest";

import type { OriginalCharacterInput } from "./schemas.js";
import {
  buildOriginalDraft,
  buildTimeBasedGoalMilestones,
  initialRelationshipPreset,
  initialRuntimeState,
} from "./defaults.js";

const BASE_INPUT: OriginalCharacterInput = {
  name: "初值测试角色",
  worldSetting: "当代城市",
  workOrRole: "学生",
  coreTraits: ["认真", "温和", "独立"],
  coreContradiction: "计划与变化之间的张力",
  mainGoal: "完成作品",
  initialRelationship: "初次建立联系的对话对象",
  dialogueStyle: "自然简洁",
  tier: "daily",
  timezone: "Asia/Shanghai",
};

describe("initial relationship defaults", () => {
  it("builds deterministic time milestones while retaining legacy routine compatibility", () => {
    const draft = buildOriginalDraft({
      ...BASE_INPUT,
      characterBrief: "公开场合保持克制，私下更柔软；主要通过行动表达关心。",
    });

    expect(draft.dialogue.authorGuidance).toBe("自然简洁");
    expect(
      draft.persona.goals[0]?.milestones?.map((item) => item.afterDays),
    ).toEqual([0, 14, 45, 90, 180]);
    expect(draft.persona.boundaries).toHaveLength(2);
    expect(draft.routines.map((routine) => routine.title)).toEqual([
      "晨间整理",
      "早餐",
      "主要工作",
      "午餐与休息",
      "晚间自习",
      "睡眠",
    ]);
    expect(draft.sources[0]?.excerpt).toContain("公开场合保持克制");
  });

  it("anchors an era-only brief without pretending its operational day was authored", () => {
    const draft = buildOriginalDraft({
      ...BASE_INPUT,
      worldSetting: "时代背景为1951年的苏联明斯克",
      characterBrief: "角色在战后参与档案重建。",
    });

    expect(draft.identity.temporalFrame).toMatchObject({
      mode: "anchored_story",
      eraLabel: "1951 年的故事世界",
      storyAnchorLocalDate: "1951-01-01",
      anchorPrecision: "year",
    });
  });

  it("uses bounded stable milestone ids for maximum-length legacy goal ids", () => {
    const milestones = buildTimeBasedGoalMilestones(
      "g".repeat(128),
      "完成作品",
    );

    expect(milestones.every((milestone) => milestone.id.length <= 128)).toBe(
      true,
    );
    expect(new Set(milestones.map((milestone) => milestone.id)).size).toBe(5);
  });

  it("starts a new or imported-style contact at an acquaintance baseline", () => {
    const draft = buildOriginalDraft(BASE_INPUT);
    const state = initialRuntimeState(
      "initial-default-agent",
      "2026-08-28T00:00:00.000Z",
      draft,
    );

    expect(draft.userRelationship).toMatchObject({
      initialCloseness: 0.18,
      initialTrust: 0.22,
    });
    expect(state.relationship).toMatchObject({
      closeness: 0.18,
      trust: 0.22,
      familiarity: 0.1,
    });
  });

  it("maps explicit relationship descriptions without flattening them", () => {
    expect(initialRelationshipPreset("认识多年的亲密好友")).toEqual({
      closeness: 0.55,
      trust: 0.6,
    });
    expect(initialRelationshipPreset("熟悉的朋友")).toEqual({
      closeness: 0.35,
      trust: 0.4,
    });
  });

  it("uses explicit edited numeric configuration at state creation", () => {
    const draft = buildOriginalDraft(BASE_INPUT);
    draft.userRelationship.initialCloseness = 0.72;
    draft.userRelationship.initialTrust = 0.81;

    expect(
      initialRuntimeState(
        "explicit-relationship-agent",
        "2026-08-28T00:00:00.000Z",
        draft,
      ).relationship,
    ).toMatchObject({
      closeness: 0.72,
      trust: 0.81,
      familiarity: 0.57,
    });
  });
});
