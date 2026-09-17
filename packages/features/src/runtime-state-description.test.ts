import { describe, expect, it } from "vitest";

import { describeRuntimeState } from "./runtime-state-description.js";

describe("describeRuntimeState", () => {
  it("turns machine metrics into qualitative persona context", () => {
    const description = describeRuntimeState({
      moodValence: -0.6,
      moodArousal: 0.9,
      energy: 0.2,
      stress: 0.82,
      socialBattery: 0.1,
      focus: 0.3,
      sleepDebtMinutes: 180,
    });

    expect(description.energy).toContain("\u7cbe\u529b\u89c1\u5e95");
    expect(description.moodValence).toContain("情绪明显低落");
    expect(description.moodArousal).toContain("高度激活");
    expect(description.stress).toContain("\u538b\u529b\u5f88\u9ad8");
    expect(description.socialBattery).toContain("社交精力很低");
    expect(description.sleepDebt).toContain("180");
    expect(description.summary).toContain("\u7761\u7720\u503a");
  });

  it("clamps malformed runtime values for a stable description", () => {
    const description = describeRuntimeState({
      moodValence: 10,
      moodArousal: -1,
      energy: 10,
      stress: -1,
      socialBattery: Number.NaN,
      focus: 0.8,
      sleepDebtMinutes: 900,
    });

    expect(description.energy).toContain("\u7cbe\u529b\u5145\u8db3");
    expect(description.moodValence).toContain("情绪明显正向");
    expect(description.moodArousal).toContain("唤醒度较低");
    expect(description.stress).toContain("\u538b\u529b\u8f83\u4f4e");
    expect(description.sleepDebt).toContain("720");
  });

  it("describes valence and arousal as independent affect dimensions", () => {
    const calmPositive = describeRuntimeState({
      moodValence: 0.8,
      moodArousal: 0.1,
      energy: 0.7,
      stress: 0.2,
      socialBattery: 0.6,
      focus: 0.7,
      sleepDebtMinutes: 0,
    });
    const activatedNegative = describeRuntimeState({
      moodValence: -0.8,
      moodArousal: 0.9,
      energy: 0.7,
      stress: 0.2,
      socialBattery: 0.6,
      focus: 0.7,
      sleepDebtMinutes: 0,
    });

    expect(calmPositive.moodValence).not.toBe(activatedNegative.moodValence);
    expect(calmPositive.moodArousal).not.toBe(activatedNegative.moodArousal);
  });

  const baseline = {
    moodValence: -0.2,
    moodArousal: 0.5,
    energy: 0.2,
    stress: 0.2,
    socialBattery: 0.9,
    focus: 0.9,
    sleepDebtMinutes: 0,
  };

  it("keeps exhaustion separate from concentration and social capacity separate from personality", () => {
    const result = describeRuntimeState(baseline);
    expect(result.moodValence).toContain("略偏负向");
    expect(result.energy).toContain("精力见底");
    expect(result.energy).not.toMatch(/注意力|专注/u);
    expect(result.focus).toContain("注意力高度集中");
    expect(result.socialBattery).toBe("社交精力充足");
    expect(result.socialBattery).not.toMatch(/主动|意愿|热络/u);
  });

  it("does not turn stress alone into a mood or a mandatory withdrawal", () => {
    const low = describeRuntimeState({ ...baseline, stress: 0.1 });
    const high = describeRuntimeState({ ...baseline, stress: 0.9 });
    expect(low.stress).not.toMatch(/心态放松|开心|愉快/u);
    expect(high.stress).not.toMatch(/需要优先|拒绝|暂停/u);
    expect(low.moodValence).toBe(high.moodValence);
    expect(low.energy).toBe(high.energy);
    expect(low.focus).toBe(high.focus);
  });

  it.each([
    ["moodValence", -0.5, "明显低落", "略偏负向"],
    ["moodValence", -0.1, "略偏负向", "相对平稳"],
    ["moodValence", 0.35, "相对平稳", "明显正向"],
    ["moodArousal", 0.25, "唤醒度较低", "活跃度适中"],
    ["moodArousal", 0.55, "活跃度适中", "较活跃"],
    ["moodArousal", 0.8, "较活跃", "高度激活"],
    ["energy", 0.25, "精力见底", "有些疲惫"],
    ["energy", 0.5, "有些疲惫", "精力尚可"],
    ["energy", 0.78, "精力尚可", "精力充足"],
    ["stress", 0.3, "压力较低", "一些压力"],
    ["stress", 0.55, "一些压力", "压力偏高"],
    ["stress", 0.75, "压力偏高", "压力很高"],
    ["socialBattery", 0.2, "社交精力很低", "社交精力有限"],
    ["socialBattery", 0.45, "社交精力有限", "社交精力尚可"],
    ["socialBattery", 0.75, "社交精力尚可", "社交精力充足"],
    ["focus", 0.25, "很难持续专注", "容易波动"],
    ["focus", 0.5, "容易波动", "专注状态稳定"],
    ["focus", 0.78, "专注状态稳定", "注意力高度集中"],
  ] as const)(
    "preserves the %s band boundary at %s",
    (field, boundary, below, at) => {
      expect(
        describeRuntimeState({ ...baseline, [field]: boundary - 0.0001 })[
          field
        ],
      ).toContain(below);
      expect(
        describeRuntimeState({ ...baseline, [field]: boundary })[field],
      ).toContain(at);
    },
  );

  it.each([0, 600])(
    "does not interpret unavailable sleep debt (%s) as a sleep fact",
    (sleepDebtMinutes) => {
      const result = describeRuntimeState(
        { ...baseline, sleepDebtMinutes },
        { sleepDebtAvailable: false },
      );
      expect(result).not.toHaveProperty("sleepDebt");
      expect(result.summary).not.toContain("睡眠");
    },
  );
});
