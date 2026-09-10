import { describe, expect, it } from "vitest";
import {
  CharacterInterviewAnswersSchema,
  CharacterInterviewCompileRequestSchema,
  CharacterInterviewProposalSchema,
} from "./character-interview.js";

const answers = {
  gender: "自定义性别",
  name: "阿澄",
  ageText: "二十多岁",
  worldSetting: "当代城市",
  workOrRole: "书店店员",
  personality: "习惯先听别人说完",
};
describe("character interview contracts", () => {
  it("accepts free-text gender and age and optional unanswered questions", () => {
    expect(CharacterInterviewAnswersSchema.parse(answers)).toEqual(answers);
    expect(
      CharacterInterviewAnswersSchema.parse({
        ...answers,
        currentFocus: "",
        advanced: {},
      }).currentFocus,
    ).toBe("");
    for (const field of Object.keys(answers))
      expect(
        CharacterInterviewAnswersSchema.safeParse({ ...answers, [field]: " " })
          .success,
      ).toBe(false);
    expect(
      CharacterInterviewAnswersSchema.safeParse({
        ...answers,
        personality: "长".repeat(121),
      }).success,
    ).toBe(false);
  });
  it("bounds optional enrichment and requires versioned draft replacement", () => {
    expect(CharacterInterviewProposalSchema.parse({ questions: [] })).toEqual({
      questions: [],
    });
    expect(
      CharacterInterviewProposalSchema.safeParse({
        questions: ["一？", "二？", "三？"],
      }).success,
    ).toBe(false);
    expect(
      CharacterInterviewCompileRequestSchema.safeParse({
        answers,
        characterId: "character_1",
      }).success,
    ).toBe(false);
    expect(
      CharacterInterviewCompileRequestSchema.safeParse({
        answers,
        expectedVersion: 1,
      }).success,
    ).toBe(false);
    expect(
      CharacterInterviewCompileRequestSchema.safeParse({
        answers,
        characterId: "character_1",
        expectedVersion: 1,
      }).success,
    ).toBe(true);
  });
});
