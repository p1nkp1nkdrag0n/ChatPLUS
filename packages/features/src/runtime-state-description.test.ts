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
    expect(description.socialBattery).toContain("\u5c11\u8bf4");
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
});
