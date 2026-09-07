import { describe, expect, it } from "vitest";
import {
  buildTurnExpressionContext,
  deriveQuestionIntent,
  turnExpressionPromptView,
} from "./turn-expression-policy.js";
import { buildConversationContextPlan } from "./conversation-context-plan.js";

describe("turn-local expression policy", () => {
  it.each([
    [
      "朋友那句‘少追问我’不是在替我提要求，但请先问我还缺哪些信息。",
      "necessary_for_explicit_task",
    ],
    ["不是在替我请求，不过请帮我分析一下修改边界。", "natural_optional"],
    [
      "单纯想吐槽一句，不用替我解决。不过现在请先问我需要补充哪些信息。",
      "necessary_for_explicit_task",
    ],
    ["只是吐槽一句，不用解决，但请具体分析这份修改意见。", "natural_optional"],
    [
      "只是吐槽一句，不用解决。现在请帮我分析一下修改意见。",
      "natural_optional",
    ],
    [
      "请先问我还缺什么信息。刚才朋友那句话不是在替我提要求。",
      "necessary_for_explicit_task",
    ],
    ["请先不要问我，直接给我建议。", "none"],
    ["请先问我缺什么信息，不过不用问了，我只想说到这。", "none"],
    [
      "不用追问我。现在请先问我验收还缺什么条件。",
      "necessary_for_explicit_task",
    ],
    ["朋友说请先问我哪些条件，那不是在替我提要求。", "none"],
    ["假设我说请你先问我问题，这样会发生什么？", "natural_optional"],
    ["假设有人说这不是在替我提要求，你会怎样理解？", "natural_optional"],
    ["朋友说他不是在替我提要求，你听懂他那句话了吗？", "natural_optional"],
    [
      "朋友说‘只想吐槽一句，不用解决’，不是在替我提要求。‘请问我还缺哪些信息’也是他的原话。",
      "none",
    ],
  ])(
    "uses operative current requests without overriding or inventing help: %s",
    (text, questionIntent) => {
      expect(deriveQuestionIntent(text).questionIntent).toBe(questionIntent);
    },
  );
  it("lets a closed vent and an already clarified third-party request end", () => {
    expect(
      deriveQuestionIntent(
        "说回工作，今天又改了两版，单纯想吐槽一句，不用替我解决。",
      ),
    ).toMatchObject({
      questionIntent: "none",
      questionIntentReason: "closed_vent",
    });
    expect(
      deriveQuestionIntent(
        "我有个朋友说‘以后少追问我’，那是他跟别人说的，不是在替我提要求。",
      ),
    ).toMatchObject({
      questionIntent: "none",
      questionIntentReason: "clarified_third_party",
    });
    expect(
      deriveQuestionIntent(
        "朋友说‘只想吐槽一句，不用解决’，请先问我还缺哪些信息。 ",
      ),
    ).toMatchObject({ questionIntent: "necessary_for_explicit_task" });
    expect(deriveQuestionIntent("请帮我分析一下验收标准。")).toMatchObject({
      questionIntent: "natural_optional",
    });
  });
  it("bounds repeated openings to five final replies and preserves authored phrases", () => {
    expect(
      buildTurnExpressionContext({
        assistantTexts: [
          "这样啊。1",
          "这样啊。2",
          "谈谈电影。",
          "嗯。",
          "内容。",
          "那好。",
          "电影结束了。",
        ],
      }).repeatedOpenings,
    ).toEqual([]);
    expect(
      buildTurnExpressionContext({
        assistantTexts: ["这样啊。1", "这样啊。2", "电影不错。"],
      }).repeatedOpenings,
    ).toEqual([{ text: "这样啊", count: 2 }]);
    expect(
      buildTurnExpressionContext({
        assistantTexts: ["这样啊。1", "这样啊。2"],
        protectedPhrases: ["这样啊"],
      }).repeatedOpenings,
    ).toEqual([]);
    expect(
      buildTurnExpressionContext({
        assistantTexts: ["本片的摄影不错。", "本片的摄影不错。"],
      }).repeatedOpenings,
    ).toEqual([]);
    expect(
      buildTurnExpressionContext({
        assistantTexts: ["嗯，好。", "嗯，我在。"],
        protectedPhrases: ["嗯哼"],
      }).repeatedOpenings,
    ).toEqual([{ text: "嗯", count: 2 }]);
    expect(
      buildTurnExpressionContext({
        assistantTexts: ["这样啊，我明白。", "这样啊，我明白。"],
        protectedPhrases: ["这样啊，我明白。"],
      }).repeatedOpenings,
    ).toEqual([]);
  });
  it("protects all authored phrases when the compact view omits unrelated entries", () => {
    const result = buildTurnExpressionContext({
      assistantTexts: ["这样啊，我明白。", "这样啊，我明白。"],
      protectedPhrases: [
        ...Array.from({ length: 24 }, (_, index) => `作者固定语${index}`),
        "这样啊，我明白。",
      ],
    });
    expect(result.protectedPhrases).toHaveLength(24);
    expect(result.repeatedOpenings).toEqual([]);
  });

  it("ignores other sessions, users, and characters when freezing style evidence", () => {
    const plan = buildConversationContextPlan({
      agentId: "a",
      sessionId: "s",
      originalQuery: "只想吐槽一句，不用解决。",
      recentMessages: [
        {
          id: "m1",
          agentId: "a",
          sessionId: "s",
          role: "assistant",
          text: "这样啊。1",
        },
        {
          id: "m2",
          agentId: "a",
          sessionId: "other",
          role: "assistant",
          text: "这样啊。2",
        },
        {
          id: "m3",
          agentId: "a",
          sessionId: "s",
          role: "user",
          text: "这样啊。3",
        },
      ],
    });
    expect(plan.expressionContext?.repeatedOpenings).toEqual([]);
    expect(turnExpressionPromptView(plan)).toMatchObject({
      questionIntent: "none",
    });
    expect(turnExpressionPromptView(plan).analysisGuidance).toContain(
      "Multiple causes can coexist",
    );
  });
});
