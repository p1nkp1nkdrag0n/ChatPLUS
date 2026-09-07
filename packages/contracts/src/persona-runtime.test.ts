import { describe, expect, it } from "vitest";

import { PersonaPracticeProposalSchema } from "./persona-runtime.js";

describe("finite persona expression practice contracts", () => {
  it.each([
    ["advice_timing", "listen_first"],
    ["follow_up_questions", "fewer_questions"],
    ["follow_up_questions", "natural_questions"],
    ["expression_style", "plain_expression"],
  ])("keeps the %s / %s pairing compatible", (facet, practice) => {
    expect(
      PersonaPracticeProposalSchema.safeParse({
        kind: "relationship_practice",
        facet,
        practice,
        scope: { userId: "user" },
        content: "用户明确提供的长期偏好原文。",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["follow_up_questions", "plain_expression"],
    ["expression_style", "natural_questions"],
    ["expression_style", "listen_first"],
    ["advice_timing", "fewer_questions"],
  ])("rejects crossing finite meanings for %s / %s", (facet, practice) => {
    expect(
      PersonaPracticeProposalSchema.safeParse({
        kind: "relationship_practice",
        facet,
        practice,
        scope: { userId: "user" },
        content: "不得错误映射偏好方向。",
      }).success,
    ).toBe(false);
  });
});
