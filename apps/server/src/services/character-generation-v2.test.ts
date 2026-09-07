import { describe, expect, it } from "vitest";

import { buildImportedDraft, buildOriginalDraft } from "../domain/defaults.js";
import {
  characterDraftSchema,
  type OriginalCharacterInput,
} from "../domain/schemas.js";
import { ensureTimeBasedGoalMilestones } from "./character-clock.js";
import {
  authoritativeImportedDraft,
  authoritativeOriginalDraft,
  buildCompilePrompt,
} from "./character-compiler.js";

const INPUT: OriginalCharacterInput = {
  name: "阿澄",
  worldSetting: "当代城市",
  workOrRole: "书店店员",
  coreTraits: ["习惯先听别人说完"],
  initialRelationship: "邻居",
  dialogueStyle: "轻松自然",
  tier: "daily",
  timezone: "Asia/Shanghai",
};
const POLICY = "companion_character_v2";

describe("companion character compilation", () => {
  it("keeps new drafts free of placeholder goals, tensions and inferred author values", () => {
    const fallback = buildOriginalDraft(INPUT, POLICY);
    const draft = authoritativeOriginalDraft(fallback, INPUT, fallback);
    expect(characterDraftSchema.parse(draft).persona.goals).toEqual([]);
    expect(draft.persona.contradictions).toEqual([]);
    expect(
      draft.persona.values.every(
        (value) => value.origin === "synthetic_extension",
      ),
    ).toBe(true);
    expect(draft.compilationPolicyVersion).toBe(POLICY);
    expect(buildCompilePrompt(INPUT)).toContain("goals=[] is valid");
    expect(buildCompilePrompt(INPUT)).toContain(
      '"field":"coreTraits.0","ruleId":"trait-1"',
    );
    expect(buildCompilePrompt(INPUT)).not.toContain('"field":"mainGoal"');
  });

  it("matches author fields by identity after reordering and keeps unrelated model values and goals", () => {
    const input = {
      ...INPUT,
      mainGoal: "完成漫画",
      coreContradiction: "想独处，也想见朋友",
    };
    const fallback = buildOriginalDraft(input, POLICY);
    expect(fallback.persona.goals[0]?.progress).toBe(0);
    expect(buildCompilePrompt(input)).toContain(
      '"field":"mainGoal","ruleId":"goal-1"',
    );
    const candidate = structuredClone(fallback);
    candidate.persona.values = [
      {
        ...candidate.persona.values[0]!,
        id: "honesty",
        name: "诚实",
        description: "重视诚实",
        origin: "user_spec",
        sourceRefs: ["original-form"],
      },
    ];
    candidate.persona.goals.unshift({
      ...candidate.persona.goals[0]!,
      id: "other-goal",
      title: "读完小说",
      description: "独立的阅读愿望",
    });
    candidate.persona.contradictions.unshift({
      ...candidate.persona.contradictions[0]!,
      id: "other-tension",
      sideA: "另一处有依据的犹豫",
    });
    candidate.persona.traits.unshift({
      ...candidate.persona.traits[0]!,
      id: "other-trait",
      name: "另一项特质",
      description: "不能误绑到作者特质",
    });
    const result = authoritativeOriginalDraft(candidate, input, fallback);
    expect(result.persona.values[0]).toMatchObject({
      description: "重视诚实",
      origin: "model_inference",
    });
    expect(result.persona.goals.map((goal) => goal.title)).toEqual([
      "完成漫画",
      "读完小说",
    ]);
    expect(result.persona.goals[1]).toMatchObject({
      id: "other-goal",
      origin: "model_inference",
    });
    expect(result.persona.contradictions[1]?.id).toBe("other-tension");
    expect(result.persona.traits[0]?.description).toBe(
      fallback.persona.traits[0]?.description,
    );
    expect(result.persona.traits[1]?.id).toBe("other-trait");
    expect(result.identity.selfDescription).not.toContain(input.mainGoal);
    expect(
      result.persona.goals.every((goal) => goal.milestones === undefined),
    ).toBe(true);
  });

  it("preserves historical milestone backfill but never invents one for v2", () => {
    const input = { ...INPUT, mainGoal: "完成漫画" };
    const legacy = buildOriginalDraft(input);
    const companion = buildOriginalDraft(input, POLICY);
    delete legacy.persona.goals[0]!.milestones;
    expect(
      ensureTimeBasedGoalMilestones(legacy).persona.goals[0]?.milestones?.map(
        (milestone) => milestone.afterDays,
      ),
    ).toEqual([0, 14, 45, 90, 180]);
    expect(
      ensureTimeBasedGoalMilestones(companion).persona.goals[0],
    ).not.toHaveProperty("milestones");
    expect(legacy).not.toHaveProperty("compilationPolicyVersion");
  });

  it("never joins a generic trait ID to unrelated model semantics and retains the candidate", () => {
    const fallback = buildOriginalDraft(INPUT, POLICY);
    const candidate = structuredClone(fallback);
    candidate.persona.traits[0] = {
      ...candidate.persona.traits[0]!,
      name: "爱主动表达",
      description: "有话时通常先说出自己的想法",
      triggers: ["朋友还在叙述时"],
      exceptions: ["没有想法时"],
    };
    const before = structuredClone(candidate);
    const result = authoritativeOriginalDraft(candidate, INPUT, fallback);
    expect(result.persona.traits[0]).toMatchObject({
      ...fallback.persona.traits[0],
      id: expect.any(String),
    });
    expect(result.persona.traits[0]?.id).not.toBe("trait-1");
    expect(result.persona.traits[1]).toEqual({
      ...candidate.persona.traits[0],
      origin: "model_inference",
      sourceRefs: ["original-form"],
    });
    expect(candidate).toEqual(before);
  });

  it("falls back to the author sentence when duplicate model names cannot be uniquely matched", () => {
    const fallback = buildOriginalDraft(INPUT, POLICY);
    const candidate = structuredClone(fallback);
    candidate.persona.traits[0]!.description = "候选一";
    candidate.persona.traits.push({
      ...candidate.persona.traits[0]!,
      id: "another-listening-trait",
      description: "候选二",
    });
    const result = authoritativeOriginalDraft(candidate, INPUT, fallback);
    expect(result.persona.traits.map((trait) => trait.description)).toEqual([
      fallback.persona.traits[0]!.description,
      "候选一",
      "候选二",
    ]);
    expect(
      result.persona.traits
        .slice(1)
        .every((trait) => trait.origin === "model_inference"),
    ).toBe(true);
  });

  it("does not invent canon goals or tensions for an imported fallback", () => {
    const input = {
      characterName: "阿澄",
      workTitle: "街角",
      storyStage: "第一章",
      sourceText: "阿澄在书店工作。",
      sourceFormat: "pasted_text" as const,
      tier: "daily" as const,
      timezone: "Asia/Shanghai",
    };
    const fallback = buildImportedDraft(input, POLICY);
    const draft = authoritativeImportedDraft(
      fallback,
      input,
      fallback,
      "a".repeat(64),
    );
    expect(characterDraftSchema.parse(draft).persona.goals).toEqual([]);
    expect(draft.persona.contradictions).toEqual([]);
    expect(
      draft.persona.traits.every(
        (trait) => trait.origin === "synthetic_extension",
      ),
    ).toBe(true);
    expect(draft.compilationPolicyVersion).toBe(POLICY);
  });

  it("does not let imported model tensions claim author-specified provenance", () => {
    const input = {
      characterName: "阿澄",
      workTitle: "街角",
      storyStage: "第一章",
      sourceText: "阿澄既想独处，又想见朋友。",
      sourceFormat: "pasted_text" as const,
      tier: "daily" as const,
      timezone: "Asia/Shanghai",
    };
    const fallback = buildImportedDraft(input, POLICY);
    const candidate = structuredClone(fallback);
    candidate.persona.contradictions = [
      {
        id: "inferred-tension",
        sideA: "想独处",
        sideB: "也想见朋友",
        triggerConditions: ["收到朋友邀请时"],
        resolutionPattern: "结合当时的精力决定",
        origin: "user_spec",
      },
    ];
    const result = authoritativeImportedDraft(
      candidate,
      input,
      fallback,
      "a".repeat(64),
    );
    expect(result.persona.contradictions[0]?.origin).toBe("model_inference");
    expect(candidate.persona.contradictions[0]?.origin).toBe("user_spec");
  });
});
