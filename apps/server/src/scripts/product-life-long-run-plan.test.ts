import { describe, expect, it } from "vitest";

import {
  PRODUCT_LIFE_PLAN,
  PRODUCT_LIFE_USER_PERSONA,
} from "./product-life-long-run-plan.js";

describe("product life long-run public scenario", () => {
  it("places seven conversations at each intended catch-up boundary", () => {
    expect(PRODUCT_LIFE_PLAN).toHaveLength(42);
    expect(PRODUCT_LIFE_PLAN.map(({ day }) => day)).toEqual(
      [0, 1, 3, 10, 15, 45].flatMap((day) => Array<number>(7).fill(day)),
    );
    expect(new Set(PRODUCT_LIFE_PLAN.map(({ phase }) => phase)).size).toBe(6);
    for (let index = 0; index < PRODUCT_LIFE_PLAN.length; index += 7) {
      const phase = PRODUCT_LIFE_PLAN.slice(index, index + 7);
      expect(new Set(phase.map((step) => step.phase)).size).toBe(1);
      expect(phase.every((step) => step.brief.trim().length > 0)).toBe(true);
    }
  });

  it("gives the user model public scene briefs without private acceptance data", () => {
    for (const step of PRODUCT_LIFE_PLAN) {
      expect(Object.keys(step).sort()).toEqual(["brief", "day", "phase"]);
    }
    const userContext =
      JSON.stringify(PRODUCT_LIFE_PLAN) + PRODUCT_LIFE_USER_PERSONA;
    expect(userContext).not.toMatch(
      /runtimeState|stateDelta|relationshipDelta|验收|评分|数据库|第8天|第13天|day-8|day-13/u,
    );
    expect(PRODUCT_LIFE_USER_PERSONA).toContain("林舟");
    expect(PRODUCT_LIFE_USER_PERSONA).toContain("顾澜");
    expect(PRODUCT_LIFE_USER_PERSONA).toContain(
      "未选方案、建议、承诺和已完成的行动不是一回事",
    );
  });

  it("exposes the correction after the initial fact and asks for unaided recall", () => {
    expect(PRODUCT_LIFE_PLAN[2]?.brief).toContain("每周四");
    expect(PRODUCT_LIFE_PLAN[7]?.brief).toContain("每周二，不是周四");
    expect(PRODUCT_LIFE_PLAN[32]?.brief).not.toMatch(/周二|周四/u);
    expect(PRODUCT_LIFE_PLAN[32]?.brief).toContain("不要直接提示正确答案");
    expect(PRODUCT_LIFE_PLAN[35]?.brief).toContain("新的聊天");
    expect(PRODUCT_LIFE_PLAN[35]?.brief).toContain("不替她列出答案");
  });

  it("makes later action reports conditional on actual public choices", () => {
    for (const index of [14, 15, 23, 30, 38]) {
      expect(PRODUCT_LIFE_PLAN[index]?.brief).toMatch(/只有|仅当|仅围绕|只沿/u);
      expect(PRODUCT_LIFE_PLAN[index]?.brief).toMatch(
        /未选择|没选|没有行动|仍卡着|没有真正行动/u,
      );
    }
    expect(PRODUCT_LIFE_PLAN[13]?.brief).toContain("明确授权");
    expect(PRODUCT_LIFE_PLAN[13]?.brief).toContain("范围仅限今晚这件小事");
  });

  it("does not expose future letter content before the opening phase", () => {
    expect(PRODUCT_LIFE_PLAN[20]?.brief).toContain("想写封信");
    expect(PRODUCT_LIFE_PLAN[21]?.brief).toContain("只有公开信息确认收到了");
    expect(PRODUCT_LIFE_PLAN[27]?.brief).toContain("不声称读过");
    expect(PRODUCT_LIFE_PLAN[28]?.brief).toContain(
      "已经提供了打开后的回信正文",
    );
    expect(PRODUCT_LIFE_PLAN[28]?.brief).toContain("不捏造内容或引用");
  });
});
