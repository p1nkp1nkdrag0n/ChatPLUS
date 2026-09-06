import { describe, expect, it } from "vitest";
import {
  analyzeCharacterSupportOffer,
  analyzeSpeakerSelfDisclosure,
} from "./fuzzy-life-support.js";

describe("speaker-owned disclosures and offered support", () => {
  it.each([
    "我最近剪片很累，肩膀一直绷着。",
    "我因为展览的事有点焦虑，压力是 7/10。",
  ])("recognizes the speaker's own pressure: %s", (text) => {
    expect(analyzeSpeakerSelfDisclosure(text).pressureText).not.toBe("");
  });

  it("retains actual alternatives and excludes the listener's separate pressure", () => {
    const result = analyzeSpeakerSelfDisclosure(
      "你今天工作压力很大。我在重剪结尾和保留原版之间犹豫，我也有点累。",
    );
    expect(result.dilemmaText).toContain("重剪结尾和保留原版");
    expect(result.pressureText).toBe("我也有点累");
    expect(result.dilemmaText).not.toContain("你今天");
  });

  it.each([
    "如果我是你，我在散步和画画之间犹豫，也会很焦虑。",
    "你说你在散步和画画之间犹豫，你最近很焦虑。",
    "我听朋友说他很焦虑，还在散步和画画之间犹豫。",
    "我的同事在散步和画画之间犹豫，他很累。",
    "这是一个例句：我在散步和画画之间犹豫，我很焦虑。",
    "我并不焦虑，也不累。",
    "我不焦虑，也不累。",
    "我知道你最近很累，压力很大。",
    "我觉得你最近很焦虑。",
    "我听得出你很累。",
    "你刚才说“我很累，我在散步和画画之间犹豫”。",
  ])(
    "does not turn hypothetical, reported, or denied pressure into self-disclosure: %s",
    (text) => {
      expect(analyzeSpeakerSelfDisclosure(text)).toEqual({
        dilemmaText: "",
        pressureText: "",
        feedbackText: "",
      });
    },
  );

  it.each([
    ["你可以慢慢说，我在听。", "listen_only"],
    ["你不用急着解决，我陪着你。", "listen_only"],
    ["我陪你一起梳理这两个选项。", "deliberate"],
    ["我的建议是保留原版，最后还是由你自己决定。", "recommend"],
  ])(
    "recognizes a natural offer without reversing its direction: %s",
    (text, mode) => {
      expect(analyzeCharacterSupportOffer(text)?.mode).toBe(mode);
    },
  );

  it.each([
    "我很焦虑，请你陪我聊聊。",
    "我不想听你说这些。",
    "请翻译“我陪着你，我在听”。",
    "她说她愿意陪你梳理。",
    "如果以后有空，我会陪你聊聊。",
    "我会选择先解决我自己的考试压力。",
  ])("does not fabricate an active offer: %s", (text) => {
    expect(analyzeCharacterSupportOffer(text)).toBeUndefined();
  });

  it("keeps a hypothetical personal perspective as advice to the listener", () => {
    expect(
      analyzeCharacterSupportOffer("如果是我，我会优先保护被摄者的尊严。")
        ?.mode,
    ).toBe("recommend");
  });

  it("does not turn a past pressure topic into a present disclosure", () => {
    expect(
      analyzeSpeakerSelfDisclosure(
        "既然把话题从我的焦虑里拔出来了，我想反过来问问你。",
        true,
      ).pressureText,
    ).toBe("");
    expect(
      analyzeSpeakerSelfDisclosure(
        "既然把话题从我的焦虑里拔出来了。但我现在还是压力 8/10。",
        true,
      ).pressureText,
    ).toBe("但我现在还是压力 8/10");
  });

  it("keeps an explicitly named offer scope even when it precedes a listening clause", () => {
    const offer =
      analyzeCharacterSupportOffer("关于外包申请，你可以慢慢说，我在听。");
    expect(offer?.scopeText).toContain("外包申请");
    expect(offer?.contextual).toBe(false);
  });

  it.each([
    ["你这样说让我感到很累。", "pressureText"],
    ["你这样说让我感到被理解。", "feedbackText"],
    ["我知道你很累，但我也很焦虑。", "pressureText"],
  ] as const)("retains the speaker's actual experience: %s", (text, kind) => {
    const disclosure = analyzeSpeakerSelfDisclosure(text);
    expect(disclosure[kind]).not.toBe("");
    expect(disclosure[kind]).not.toContain("我知道你");
  });

  it("does not let the speaker's separate pressure determine the listener's support scope", () => {
    const offer = analyzeCharacterSupportOffer(
      "你可以慢慢说，我在听。我也因为考试焦虑，压力 8/10。",
    );
    expect(offer?.scopeText).not.toContain("考试");
    expect(offer?.contextual).toBe(true);
  });
});
