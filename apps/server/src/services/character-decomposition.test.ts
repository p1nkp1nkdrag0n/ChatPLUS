import { describe, expect, it } from "vitest";

import { buildOriginalDraft } from "../domain/defaults.js";
import { ApiError } from "../domain/errors.js";
import type { OriginalCharacterInput } from "../domain/schemas.js";
import {
  applyLifePlanningAuthority,
  normalizeTemporalAnchor,
} from "./character-clock.js";
import {
  applyCharacterMutation,
  protectLockedCharacterFields,
} from "./character-draft-editor.js";

const BASE_INPUT: OriginalCharacterInput = {
  name: "结构测试角色",
  worldSetting: "当代城市",
  workOrRole: "插画师",
  coreTraits: ["认真", "独立", "温和"],
  coreContradiction: "计划与变化之间的张力",
  mainGoal: "完成作品",
  initialRelationship: "认识了一段时间的朋友",
  dialogueStyle: "自然简洁",
  tier: "high_fidelity",
  timezone: "Asia/Shanghai",
};

describe("character draft collaborators", () => {
  it("makes fuzzy life authoritative without mutating legacy-compatible drafts", () => {
    const draft = buildOriginalDraft(BASE_INPUT);
    draft.schedulePolicy.enabled = true;

    const fuzzy = applyLifePlanningAuthority(draft, "fuzzy");
    const legacy = applyLifePlanningAuthority(draft, "legacy_exact");

    expect(fuzzy.schedulePolicy.enabled).toBe(false);
    expect(legacy.schedulePolicy.enabled).toBe(true);
    expect(draft.schedulePolicy.enabled).toBe(true);
  });

  it("normalizes a year-precision story clock once and then preserves it", () => {
    const draft = buildOriginalDraft({
      ...BASE_INPUT,
      worldSetting: "时代背景为1951年的苏联明斯克",
    });
    const first = normalizeTemporalAnchor(draft, "2026-09-03T06:00:00.000Z");
    const second = normalizeTemporalAnchor(
      draft,
      "2026-12-20T06:00:00.000Z",
      first,
    );

    expect(first.identity.temporalFrame).toMatchObject({
      mode: "anchored_story",
      anchorPrecision: "year",
      storyAnchorLocalDate: "1951-09-03",
      systemAnchorUtc: "2026-09-03T06:00:00.000Z",
    });
    expect(second.identity.temporalFrame).toEqual(first.identity.temporalFrame);
  });

  it("keeps JSON-path mutation separate from locked-field enforcement", () => {
    const draft = buildOriginalDraft(BASE_INPUT);
    draft.lockedPaths = ["identity.name"];
    const candidate = applyCharacterMutation(draft, {
      path: "identity.name",
      value: "被覆盖的名字",
    });

    expect(candidate.identity.name).toBe("被覆盖的名字");
    try {
      protectLockedCharacterFields(draft, candidate);
      throw new Error("Expected locked-field enforcement to reject the edit");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      if (!(error instanceof ApiError)) throw error;
      expect(error).toMatchObject({
        code: "field_locked",
        statusCode: 409,
      });
    }
  });
});
