import { describe, expect, it } from "vitest";
import {
  CharacterInterviewAnswersSchema,
  CharacterInterviewCompileRequestSchema,
  CharacterInterviewProposalSchema,
  CharacterInterviewRefineRequestSchema,
  CharacterRefinementPlanSchema,
  CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH,
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
  it("requires a bounded, versioned and idempotent refinement with content-only scope", () => {
    const request = {
      characterId: "character_1",
      expectedVersion: 1,
      requestId: "refine_1",
      feedback: "把性格改为沉静但有主见",
    };
    expect(CharacterInterviewRefineRequestSchema.parse(request)).toEqual(
      request,
    );
    for (const patch of [
      { feedback: " " },
      { feedback: "改".repeat(5_001) },
      { requestId: undefined },
      { expectedVersion: undefined },
    ])
      expect(
        CharacterInterviewRefineRequestSchema.safeParse({
          ...request,
          ...patch,
        }).success,
      ).toBe(false);
    expect(
      CharacterRefinementPlanSchema.safeParse({
        answersPatch: { name: "林汐" },
        changedPaths: ["identity.name"],
      }).success,
    ).toBe(true);
    for (const path of [
      "authorityAudit",
      "sources",
      "lockedPaths",
      "userRelationship.sharedContext",
      "identity.__proto__",
    ])
      expect(
        CharacterRefinementPlanSchema.safeParse({
          answersPatch: {},
          changedPaths: [path],
        }).success,
      ).toBe(false);
  });
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
        personality: "长".repeat(CHARACTER_INTERVIEW_ANSWER_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });
  it.each([
    "gender",
    "name",
    "ageText",
    "workOrRole",
    "personality",
    "appearanceDescription",
    "dailyHabits",
    "importantExperience",
    "dialogueStyle",
    "currentFocus",
  ])(
    "accepts 2000 characters for %s and rejects only the overflow",
    (field) => {
      expect(
        CharacterInterviewAnswersSchema.safeParse({
          ...answers,
          [field]: "描".repeat(2_000),
        }).success,
      ).toBe(true);
      expect(
        CharacterInterviewAnswersSchema.safeParse({
          ...answers,
          [field]: "描".repeat(2_001),
        }).success,
      ).toBe(false);
    },
  );
  it("accepts expanded follow-ups and era text while retaining longer existing answer limits", () => {
    const expanded = {
      ...answers,
      worldSetting: "世".repeat(4_000),
      additionalDetails: "补".repeat(6_000),
      followUps: [
        { id: "one", question: "为什么？", answer: "答".repeat(2_000) },
      ],
      advanced: { storyEra: "代".repeat(2_000) },
    };
    expect(CharacterInterviewAnswersSchema.parse(expanded)).toEqual(expanded);
    expect(
      CharacterInterviewAnswersSchema.safeParse({
        ...expanded,
        followUps: [{ ...expanded.followUps[0], answer: "答".repeat(2_001) }],
      }).success,
    ).toBe(false);
    expect(
      CharacterInterviewAnswersSchema.safeParse({
        ...expanded,
        advanced: { storyEra: "代".repeat(2_001) },
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
