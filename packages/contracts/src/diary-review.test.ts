import { describe, expect, it } from "vitest";
import { DiaryReviewSchema } from "./diary-review.js";

describe("diary review receipt", () => {
  it("accepts concise approval or actionable rejection", () => {
    expect(DiaryReviewSchema.parse({ valid: true, issues: [] })).toEqual({
      valid: true,
      issues: [],
    });
    expect(
      DiaryReviewSchema.parse({
        valid: false,
        issues: ["段落1把尚未执行的计划写成已经发生。"],
      }).valid,
    ).toBe(false);
  });
  it.each([
    { valid: true, issues: ["仍有错误"] },
    { valid: false, issues: [] },
    { valid: false, issues: [" "] },
    { valid: true, issues: [], reasoning: "hidden reasoning" },
    { valid: "true", issues: [] },
    { valid: false, issues: ["x".repeat(601)] },
  ])(
    "rejects contradictory, ambiguous or oversized review output: %#",
    (value) => {
      expect(DiaryReviewSchema.safeParse(value).success).toBe(false);
    },
  );
});
