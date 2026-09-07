import { describe, expect, it } from "vitest";
import qwenRegressions from "../test-fixtures/qwen-fresh-regressions.json";
import {
  analyzeCharacterSupportOffer,
  analyzeSpeakerSelfDisclosure,
} from "./fuzzy-life-support.js";

// The complete delivered T8 reply from the fresh Qwen 2026-09-07 pilot.
// Keeping the surrounding cognition and topic clauses catches ownership leakage
// that the isolated fatigue clause does not reproduce.
const QWEN_T8_REPLY = qwenRegressions.pressure.assistantText;

describe("state experiencer boundaries", () => {
  it("binds the person affected after a state predicate instead of the grammatical topic", () => {
    expect(
      analyzeSpeakerSelfDisclosure(
        "最近工作上有件事一直压着我，我一想到要处理，肩膀就会绷起来。",
      ).pressureText,
    ).toContain("一直压着我");
    expect(
      analyzeSpeakerSelfDisclosure("最近这件事一直压着你。").pressureText,
    ).toBe("");
  });
  it("keeps a locally contrasted pair of explicit self scales without inheriting a new emotional topic", () => {
    expect(
      analyzeSpeakerSelfDisclosure(
        "我的压力还是 7/10，但清晰度大概到 5/10 了。",
      ).pressureText,
    ).toContain("清晰度大概到 5/10");
    expect(
      analyzeSpeakerSelfDisclosure("我压力 7/10，但最近她很累。").pressureText,
    ).not.toContain("她");
  });
  it("does not give the character pressure from the complete real T8 analysis", () => {
    expect(analyzeSpeakerSelfDisclosure(QWEN_T8_REPLY).pressureText).toBe("");
  });

  it.each([
    "我觉得可以分开来看，这时你的疲惫是合理的反应。",
    "我理解你的疲惫。",
    "我觉得你很累。最近压力很大。",
    "她说‘我压力很大’。",
    "如果是我，我可能也会焦虑。",
    "我并不疲惫，只是在理解你。",
    "我最近加班。最近压力很大。",
    "我最近加班，另外这个项目的压力很大。",
  ])(
    "does not infer a speaker state from a different or unresolved experiencer: %s",
    (text) => {
      expect(analyzeSpeakerSelfDisclosure(text).pressureText).toBe("");
    },
  );

  it.each([
    ["我最近压力很大，累得不行。", "我最近压力很大，累得不行"],
    ["我最近加班，累得不行。", "累得不行"],
    ["听你这么说，我也有点难受。", "我也有点难受"],
    ["我觉得我有点累。", "我觉得我有点累"],
    ["我最近压力很大。", "我最近压力很大"],
  ])(
    "retains explicit self experience and bounded ellipsis: %s",
    (text, expected) => {
      expect(analyzeSpeakerSelfDisclosure(text).pressureText).toBe(expected);
    },
  );
});

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

  it("retains the affected speaker's feedback without inventing pressure relief", () => {
    const result = analyzeSpeakerSelfDisclosure(
      "你刚才的陪伴让我觉得被听见了一点，但压力还是 8/10，别自动把它写成已经缓解。",
      true,
    );
    expect(result.feedbackText).toBe("你刚才的陪伴让我觉得被听见了一点");
    expect(result.feedbackText).not.toContain("缓解");
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
