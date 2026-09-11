import { describe, expect, it } from "vitest";
import { validateRelationshipSemanticDirection } from "./world-effect-service.js";

describe("relationship evidence attribution", () => {
  it.each([
    ["我今天跑步受伤了，这和你没关系。", "neutral"],
    ["我的同事今天受伤了，我有点不舒服。", "neutral"],
    ["你知道吗，我觉得跑步后身体不舒服。", "neutral"],
    ["你知道我的同事越界了，我只是在转述。", "neutral"],
    ["我没有违背对你的承诺。", "neutral"],
    ["你没有欺骗我，我只是今天有点累。", "neutral"],
    ["我不太同意你的看法，但愿意听你的理由。", "neutral"],
    ["先别再问我这个，我今天很累，明天聊。", "temporary_boundary"],
    ["如果我说停，就先别再讨论这件事。", "temporary_boundary"],
    ["如果我说原谅你，那只是一个假设。", "unconfirmed_repair"],
    ["朋友说“我原谅你”，这是一段电影台词。", "unconfirmed_repair"],
    ["我没有原谅你。", "unconfirmed_repair"],
    ["朋友说“你骗了我”，我只是转述。", "neutral"],
  ] as const)(
    "rejects permanent loss without current relationship damage: %s",
    (userText, evidence) => {
      const result = validateRelationshipSemanticDirection({
        userText,
        delta: { closeness: -0.02 },
      });
      expect(result.evidence).toBe(evidence);
      expect(result.accepted).toBeUndefined();
      expect(result.rejections.map((item) => item.reasonCode)).toEqual([
        "relationship_direction_unsupported",
      ]);
    },
  );

  it.each([
    "我没有原谅你，我还是觉得你刚才越界了。",
    "你刚才骗了我，我不再信任你。",
    "等等，你刚才把我的意思理解反了，我有点受伤。",
    "你就是个废物，我就是故意羞辱你。",
    "我骗了你，我没有遵守对你的承诺。",
  ])(
    "permits bounded model-proposed loss for attributed rupture: %s",
    (userText) => {
      const negative = validateRelationshipSemanticDirection({
        userText,
        delta: { closeness: -0.02 },
      });
      expect(negative.evidence).toBe("rupture_or_boundary");
      expect(negative.accepted).toEqual({ closeness: -0.02 });
      expect(
        validateRelationshipSemanticDirection({
          userText,
          delta: { closeness: 0.02 },
        }).accepted,
      ).toBeUndefined();
    },
  );

  it.each([
    "如果我说原谅你，那只是一个假设。",
    "我没有原谅你。",
    "先别再问我这个，我今天很累，明天聊。",
    "朋友说“我原谅你”，这是一段电影台词。",
  ])(
    "does not turn an unestablished repair or temporary boundary into a reward: %s",
    (userText) => {
      expect(
        validateRelationshipSemanticDirection({
          userText,
          delta: { closeness: 0.02 },
        }).accepted,
      ).toBeUndefined();
    },
  );

  it("accepts an affirmative repair without creating an automatic delta", () => {
    const userText = "谢谢你停下来重新听我说，也把误会讲清楚了。我们和好了。";
    expect(
      validateRelationshipSemanticDirection({
        userText,
        delta: { closeness: 0.02 },
      }),
    ).toMatchObject({
      evidence: "explicit_repair",
      accepted: { closeness: 0.02 },
      rejections: [],
    });
    expect(
      validateRelationshipSemanticDirection({ userText, delta: undefined })
        .accepted,
    ).toBeUndefined();
  });
});
