import { describe, expect, it } from "vitest";

import type { OriginalCharacterInput } from "./schemas.js";
import {
  buildOriginalDraft,
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
