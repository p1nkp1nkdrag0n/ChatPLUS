import { describe, expect, it } from "vitest";

import {
  auditDirectUserFactTextGrounding,
  auditEvidenceOnlyTextGrounding,
  classifyNonAuthoritativeUserFactSourceStatuses,
  extractActiveCorrectionStatement,
  isAuthoritativeEvidenceOnlyQuote,
} from "./evidence-only-grounding.js";

describe("evidence-only closed-world grounding", () => {
  const lpm = {
    memoryContent:
      "重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827",
    evidenceQuote:
      "重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827",
  };

  it("rejects an unsupported fact in either a following or appended clause", () => {
    for (const text of [
      "我记得 LPM-4827。你已经结婚，而且在北京有两个孩子。",
      "LPM-4827 和墨绿色珐琅松针说明你已婚并有两个孩子。",
      "我记得 LPM-4827，而且你已经结婚，在北京有两个孩子。",
    ]) {
      const audit = auditEvidenceOnlyTextGrounding({
        text,
        sources: [lpm],
        requireGroundedClaim: true,
      });
      expect(audit.passed, text).toBe(false);
      expect(audit.groundedClaimCount, text).toBeGreaterThan(0);
      expect(audit.unsupportedClauses.length, text).toBeGreaterThan(0);
    }
  });

  it.each([
    {
      label: "persisted memory pollution",
      source: {
        memoryContent: "代号是 LPM-4827。用户已经结婚。",
        evidenceQuote: "代号是 LPM-4827。",
      },
    },
    {
      label: "evidence quote pollution",
      source: {
        memoryContent: "代号是 LPM-4827。",
        evidenceQuote: "代号是 LPM-4827。用户已经结婚。",
      },
    },
  ])("requires content/quote agreement for $label", ({ source }) => {
    const audit = auditEvidenceOnlyTextGrounding({
      text: "我记得 LPM-4827。你已经结婚。",
      sources: [source],
      requireGroundedClaim: true,
    });

    expect(audit.passed).toBe(false);
    expect(audit.groundedClaimCount).toBe(1);
    expect(audit.unsupportedClauses).toContain("你已经结婚");
  });

  it.each([
    "假设我养了一只叫豆包的狗，这里只是举例。",
    "小林说她最喜欢香菜。这是她的偏好，不是我的。",
    "撤回前面的说法：我的大学宿舍号是 302。",
  ])("does not authorize facts from a non-authoritative quote: %s", (quote) => {
    const audit = auditEvidenceOnlyTextGrounding({
      text: quote.includes("豆包")
        ? "你养了一只叫豆包的狗。"
        : quote.includes("香菜")
          ? "你最喜欢香菜。"
          : "你的大学宿舍号是 302。",
      sources: [{ memoryContent: quote, evidenceQuote: quote }],
      requireGroundedClaim: true,
    });

    expect(audit).toMatchObject({
      passed: false,
      groundedClaimCount: 0,
    });
  });

  it.each([
    [
      "hypothetical plus epistemic negation",
      "如果我明天要答辩，请先听我说。不过这不是真的。",
      ["hypothetical", "negated"],
    ],
    [
      "hypothetical plus natural negation variant",
      "如果我明天要答辩，请先听我说。不过这不是真实的。",
      ["hypothetical", "negated"],
    ],
    [
      "hypothetical plus third-party disclaimer",
      "如果我明天要答辩，请先听我说。这是她的偏好，不是我的。",
      ["hypothetical", "quoted_third_party"],
    ],
  ] as const)("retains every signal for $0", (_label, source, statuses) => {
    expect(classifyNonAuthoritativeUserFactSourceStatuses(source)).toEqual(
      statuses,
    );
  });

  it.each([
    [
      "English hypothetical",
      "Hypothetically, I will have a presentation tomorrow.",
      ["hypothetical"],
    ],
    [
      "English assume frame",
      "Assume I will have a presentation tomorrow.",
      ["hypothetical"],
    ],
    [
      "English assuming frame",
      "Assuming that I will have a presentation tomorrow.",
      ["hypothetical"],
    ],
    [
      "English hypothetical-scenario frame",
      "This is a hypothetical scenario: I will have a presentation tomorrow.",
      ["hypothetical"],
    ],
    [
      "sentence-initial English third party",
      "My friend said: I will have a presentation tomorrow.",
      ["quoted_third_party"],
    ],
    ["English epistemic negation", "This is not true.", ["negated"]],
    ["English contracted negation", "That's not true.", ["negated"]],
    ["English isn't negation", "It isn't true.", ["negated"]],
    ["English retraction", "I retract that.", ["retracted"]],
    ["English take-it-back", "I take it back.", ["retracted"]],
    ["English take-that-back", "I take that back.", ["retracted"]],
    ["English forget-that", "Forget that.", ["retracted"]],
    [
      "English mentioned attribution",
      "My friend mentioned: I will have a presentation tomorrow.",
      ["quoted_third_party"],
    ],
    [
      "English texted attribution",
      "My friend texted me: I will have a presentation tomorrow.",
      ["quoted_third_party"],
    ],
  ] as const)("classifies $0", (_label, source, statuses) => {
    expect(classifyNonAuthoritativeUserFactSourceStatuses(source)).toEqual(
      statuses,
    );
  });

  it("does not interpret an ordinary first-person plural report as a named speaker", () => {
    for (const source of ["we said hello", "We said hello"]) {
      expect(classifyNonAuthoritativeUserFactSourceStatuses(source)).toEqual(
        [],
      );
    }
  });

  it("uses a selected persisted memory as authority when no quote exists", () => {
    expect(
      auditEvidenceOnlyTextGrounding({
        text: "LPM-4827 是那枚墨绿色珐琅松针。",
        sources: [{ memoryContent: lpm.memoryContent }],
        requireGroundedClaim: true,
      }),
    ).toMatchObject({ passed: true, groundedClaimCount: 1 });
  });

  it("does not mistake first-person origin facts for source attribution", () => {
    for (const source of ["我来自苏州。", "我来自上海，喜欢喝茶。"]) {
      expect(isAuthoritativeEvidenceOnlyQuote(source)).toBe(true);
    }
    const source = "我来自苏州，喜欢喝茶。";
    expect(
      auditEvidenceOnlyTextGrounding({
        text: "你来自苏州，也喜欢喝茶。",
        sources: [{ memoryContent: source, evidenceQuote: source }],
        requireGroundedClaim: true,
      }),
    ).toMatchObject({ passed: true, groundedClaimCount: 2 });
  });

  it.each([
    {
      source: "我不喜欢香菜。",
      reply: "你喜欢香菜。",
    },
    {
      source: "小林不是我的大学同学，是我高中同学。",
      reply: "小林是你的大学同学。",
    },
    {
      source: "我没有孩子。",
      reply: "你有两个孩子。",
    },
  ])(
    "does not turn a negated source proposition into an affirmative fact: $reply",
    ({ source, reply }) => {
      expect(
        auditEvidenceOnlyTextGrounding({
          text: reply,
          sources: [{ memoryContent: source, evidenceQuote: source }],
          requireGroundedClaim: true,
        }),
      ).toMatchObject({ passed: false, groundedClaimCount: 0 });
    },
  );

  it("does not compose one claim from unrelated evidence sentences", () => {
    const source = "我认识小林。我已经结婚。";
    expect(
      auditEvidenceOnlyTextGrounding({
        text: "小林已经结婚。",
        sources: [{ memoryContent: source, evidenceQuote: source }],
        requireGroundedClaim: true,
      }),
    ).toMatchObject({ passed: false, groundedClaimCount: 0 });
  });

  it("does not reverse roles across comma-separated evidence propositions", () => {
    const source = "我大学同学叫小林，她最近刚搬到苏州。";
    expect(
      auditEvidenceOnlyTextGrounding({
        text: "苏州是你的大学同学。",
        sources: [{ memoryContent: source, evidenceQuote: source }],
        requireGroundedClaim: true,
      }),
    ).toMatchObject({ passed: false, groundedClaimCount: 0 });
    expect(
      auditEvidenceOnlyTextGrounding({
        text: "小林是你的大学同学，她最近搬到了苏州。",
        sources: [{ memoryContent: source, evidenceQuote: source }],
        requireGroundedClaim: true,
      }),
    ).toMatchObject({ passed: true, groundedClaimCount: 2 });
  });

  it("grounds a person relation when persisted content and its quote use equivalent wording", () => {
    const source = {
      memoryContent: "用户的大学同学小林最近刚搬到苏州。",
      evidenceQuote: "我大学同学叫小林，她最近刚搬到苏州。",
    };

    expect(
      auditDirectUserFactTextGrounding({
        text: "小林是你的大学同学，她最近刚搬到苏州。",
        memorySources: [source],
        authoritativeFacts: [],
        requireGroundedMemoryClaim: true,
        userMessage: "小林是谁？",
      }),
    ).toMatchObject({
      passed: true,
      groundedClaimCount: 2,
      unsupportedClauses: [],
    });
  });

  it.each([
    "小林啊，我大学同学，她最近刚搬到苏州。",
    "小林是我的大学同学，她最近刚搬到苏州。",
    "我大学同学叫小林，她最近刚搬到苏州。",
    "小林跟我是大学同学，她最近刚搬到苏州。",
  ])(
    "rejects adopting a user-owned relation as the assistant's: %s",
    (text) => {
      const source = {
        memoryContent: "用户的大学同学小林最近刚搬到苏州。",
        evidenceQuote: "我大学同学叫小林，她最近刚搬到苏州。",
      };

      expect(
        auditDirectUserFactTextGrounding({
          text,
          memorySources: [source],
          authoritativeFacts: [],
          requireGroundedMemoryClaim: true,
          userMessage: "小林是谁？",
        }),
      ).toMatchObject({ passed: false });
    },
  );

  it("keeps the user's first-person relation valid inside an explicit quote", () => {
    const source = {
      memoryContent: "我大学同学叫小林，她最近刚搬到苏州。",
      evidenceQuote: "我大学同学叫小林，她最近刚搬到苏州。",
    };

    expect(
      auditDirectUserFactTextGrounding({
        text: "“我大学同学叫小林”",
        memorySources: [source],
        authoritativeFacts: [],
        requireGroundedMemoryClaim: true,
        userMessage: "小林是谁？",
      }),
    ).toMatchObject({ passed: true, unsupportedClauses: [] });
  });

  it("grounds bounded English and Chinese user-model paraphrases used at persistence", () => {
    const english = auditEvidenceOnlyTextGrounding({
      text: "I prefer jasmine tea.",
      sources: [
        {
          memoryContent:
            "I prefer jasmine tea. My thesis defense is tomorrow and I feel nervous.",
        },
      ],
      requireGroundedClaim: true,
    });
    expect(english.clauses[0]?.unsupportedTokens).toEqual([]);
    expect(english).toMatchObject({ passed: true, groundedClaimCount: 1 });
    expect(
      auditEvidenceOnlyTextGrounding({
        text: "I prefer jasmine tea and have two children.",
        sources: [{ memoryContent: "I prefer jasmine tea." }],
        requireGroundedClaim: true,
      }).passed,
    ).toBe(false);
    expect(
      auditEvidenceOnlyTextGrounding({
        text: "我有一位大学同学叫小林，最近刚搬到苏州。",
        sources: [{ memoryContent: "我大学同学叫小林，她最近刚搬到苏州。" }],
        requireGroundedClaim: true,
      }),
    ).toMatchObject({ passed: true, groundedClaimCount: 2 });
  });

  it("accepts grounded natural rewrites and evidence meta-language", () => {
    const audit = auditEvidenceOnlyTextGrounding({
      text: "我确定记得，LPM-4827 指的是那枚墨绿色珐琅松针。除此之外，不确定的部分我就不补充了。",
      sources: [lpm],
      requireGroundedClaim: true,
    });

    expect(audit).toMatchObject({
      passed: true,
      groundedClaimCount: 1,
      unsupportedClauses: [],
    });
    expect(audit.clauses.some((clause) => clause.kind === "meta")).toBe(true);
  });

  it("normalizes supported relation and cilantro paraphrases", () => {
    const audit = auditEvidenceOnlyTextGrounding({
      text: "小林是你大学时候的同学，如今住在苏州。少许香菜你能接受，不过一整把就不太喜欢。",
      sources: [
        {
          memoryContent: "我大学同学叫小林，她最近刚搬到苏州。",
          evidenceQuote: "我大学同学叫小林，她最近刚搬到苏州。",
        },
        {
          memoryContent: "我可以接受少量香菜，但不喜欢整把香菜。",
          evidenceQuote: "我可以接受少量香菜，但不喜欢整把香菜。",
        },
      ],
      requireGroundedClaim: true,
    });

    expect(audit).toMatchObject({
      passed: true,
      groundedClaimCount: 4,
      unsupportedClauses: [],
    });
  });

  it.each([
    {
      label: "turn 18 conservative corrected preference",
      text: "你可以接受少量香菜，但不喜欢整把香菜。",
      source: {
        memoryContent: "我可以接受少量香菜，但不喜欢整把香菜",
        evidenceQuote:
          "我纠正一下：前面说“我不吃香菜”太绝对了。准确说法是，我可以接受少量香菜，但不喜欢整把香菜。",
      },
    },
    {
      label: "turn 77 corrected-statement meta-language",
      text: "你可以接受少量香菜，但不喜欢整把香菜；这才是纠正后的准确说法。",
      source: {
        memoryContent: "我可以接受少量香菜，但不喜欢整把香菜",
        evidenceQuote:
          "我纠正一下：前面说“我不吃香菜”太绝对了。准确说法是，我可以接受少量香菜，但不喜欢整把香菜。",
      },
    },
    {
      label: "turn 82 containment paraphrase",
      text: "LPM-4827 放在深灰色电脑包的内侧拉链袋，里面是那枚墨绿色珐琅松针。",
      source: {
        memoryContent:
          "重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827",
        evidenceQuote:
          "我只告诉很信任的人一件小事：重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827。请只按我说的内容记，不要补充。",
      },
    },
  ])(
    "accepts the exact durable-recall wording for $label",
    ({ text, source }) => {
      const audit = auditEvidenceOnlyTextGrounding({
        text,
        sources: [source],
        requireGroundedClaim: true,
      });

      expect(audit).toMatchObject({
        passed: true,
        groundedClaimCount: 2,
        unsupportedClauses: [],
      });
    },
  );

  it.each(["把你说成没有孩子并不准确。", "说你未婚不准确。"])(
    "does not treat a correction-shaped unsupported fact as meta-language: %s",
    (text) => {
      expect(
        auditEvidenceOnlyTextGrounding({
          text,
          sources: [lpm],
        }),
      ).toMatchObject({ passed: false, groundedClaimCount: 0 });
    },
  );

  it("authorizes only the active statement in an exact correction source", () => {
    const correction =
      "我纠正一下：前面说“我不吃香菜”太绝对了。准确说法是，我可以接受少量香菜，但不喜欢整把香菜。";
    const source = { memoryContent: correction, evidenceQuote: correction };

    expect(
      auditEvidenceOnlyTextGrounding({
        text: "你可以接受少量香菜，但不喜欢整把香菜。",
        sources: [source],
        requireGroundedClaim: true,
      }),
    ).toMatchObject({ passed: true, groundedClaimCount: 2 });
    expect(
      auditEvidenceOnlyTextGrounding({
        text: "你不吃香菜。",
        sources: [source],
        requireGroundedClaim: true,
      }),
    ).toMatchObject({ passed: false, groundedClaimCount: 0 });
  });

  it("extracts only the exact active assertion from a first-person correction", () => {
    expect(
      extractActiveCorrectionStatement(
        "我纠正一下：前面说“我不吃香菜”太绝对了。准确说法是，我可以接受少量香菜，但不喜欢整把香菜。",
      ),
    ).toBe("我可以接受少量香菜，但不喜欢整把香菜。");
  });

  it("projects only the affirmative replacement and unchanged fact from a direct contrast correction", () => {
    const correction =
      "我纠正一下：小林不是我的大学同学，是我高中同学。她搬到苏州这件事没变。";
    const active = "小林是我高中同学。她搬到苏州。";

    expect(extractActiveCorrectionStatement(correction)).toBe(active);
    expect(
      auditEvidenceOnlyTextGrounding({
        text: "小林是你的高中同学；她搬到了苏州。",
        sources: [{ memoryContent: correction, evidenceQuote: correction }],
        requireGroundedClaim: true,
      }),
    ).toMatchObject({ passed: true, groundedClaimCount: 2 });
    for (const unsafe of ["小林是你的大学同学。", "小林不是你的大学同学。"]) {
      expect(
        auditEvidenceOnlyTextGrounding({
          text: unsafe,
          sources: [{ memoryContent: correction, evidenceQuote: correction }],
          requireGroundedClaim: true,
        }),
      ).toMatchObject({ passed: false, groundedClaimCount: 0 });
    }
  });

  it("projects multiple explicitly unchanged affirmative facts", () => {
    expect(
      extractActiveCorrectionStatement(
        "我纠正一下：小林不是我的大学同学，是我高中同学。她搬到苏州这件事没变。她住在姑苏区这件事没变。",
      ),
    ).toBe("小林是我高中同学。她搬到苏州。她住在姑苏区。");
  });

  it.each([
    "假设我纠正一下前面的说法。准确说法是，我每天喝咖啡；这里只是举例。",
    "小林说她纠正一下前面的说法。准确说法是，她每天喝咖啡。",
    "张伟说：“我纠正一下前面的说法。准确说法是，我每天喝咖啡。”",
    "我纠正一下：张伟说，准确说法是，我每天喝咖啡。",
    "我纠正一下：朋友阿杰说，准确说法是，我每天喝咖啡。",
    "我纠正一下：张伟表示，准确说法是，我每天喝咖啡。",
    "我纠正一下：同事小陈告诉我，准确说法是，我每天喝咖啡。",
    "我纠正一下：准确说法是，朋友阿杰说，我每天喝咖啡。",
    "我纠正一下前面的说法。准确说法是，我每天喝咖啡；这条也撤回。",
    "我纠正一下：准确说法是，我喜欢咖啡；这条不要记录。",
    "我纠正一下：准确说法是，我喜欢咖啡；别把这条记下来。",
    "我纠正一下：准确说法是，我喜欢咖啡；请不要记录这条。",
    "我纠正一下：准确说法是，我要是每天喝咖啡就会失眠。",
    "我纠正一下：准确说法是，我万一每天喝咖啡就会失眠。",
    "我纠正一下：准确说法是，我倘若每天喝咖啡就会失眠。",
    "我纠正一下：准确说法是，我喜欢咖啡。根据张伟的说法。",
    "我纠正一下：准确说法是，我喜欢咖啡。按张伟的说法。",
    "我纠正一下：准确说法是，我喜欢咖啡。这是张伟告诉我的。",
    "我纠正一下：准确说法是，我喜欢咖啡。听我妈妈讲的。",
    "我纠正一下：准确说法是，我喜欢咖啡。据张伟讲。",
    "我纠正一下：准确说法是，我喜欢咖啡。信息来源是张伟。",
    "假设我纠正一下：小林不是我的大学同学，是我高中同学。",
    "我纠正一下：张伟说，小林不是我的大学同学，是我高中同学。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。以上是据张伟所说。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。根据张伟的说法。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。按张伟的说法。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。这是张伟告诉我的。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。听我妈妈讲的。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。据张伟讲。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。信息来源是张伟。",
    "我纠正一下：小林不是我的大学同学，是我高中同学；这条不要记录。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。张伟住在北京这件事没变。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。她是我的大学同学这件事没变。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。她没搬到苏州这件事没变。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。她并未搬到苏州这件事没变。",
    "我纠正一下：咖啡不是热的，是冷的。",
    "我纠正一下：小林不是大学同学，是高中同学。",
    "我纠正一下：我每天喝咖啡。",
    "把你说成没有孩子并不准确。",
  ])("does not extract an unsafe or incomplete correction: %s", (source) => {
    expect(extractActiveCorrectionStatement(source)).toBeUndefined();
  });

  it.each([
    "我纠正一下：张伟说，准确说法是，我每天喝咖啡。",
    "我纠正一下：朋友阿杰说，准确说法是，我每天喝咖啡。",
    "我纠正一下：张伟表示，准确说法是，我每天喝咖啡。",
    "我纠正一下：同事小陈告诉我，准确说法是，我每天喝咖啡。",
    "我纠正一下：准确说法是，朋友阿杰说，我每天喝咖啡。",
    "我纠正一下：准确说法是，我喜欢咖啡；这条不要记录。",
    "我纠正一下：准确说法是，我喜欢咖啡；别把这条记下来。",
    "我纠正一下：准确说法是，我喜欢咖啡；请不要记录这条。",
    "我纠正一下：准确说法是，我要是每天喝咖啡就会失眠。",
    "我纠正一下：准确说法是，我万一每天喝咖啡就会失眠。",
    "我纠正一下：准确说法是，我倘若每天喝咖啡就会失眠。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。以上是据张伟所说。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。据我妈妈所说。",
    "我纠正一下：小林不是我的大学同学，是我高中同学。据我的朋友所说。",
  ])("rejects a non-authoritative correction source: %s", (source) => {
    expect(isAuthoritativeEvidenceOnlyQuote(source)).toBe(false);
  });

  it.each([
    "我纠正一下：前面说我不喝咖啡不准确。准确说法是，我喜欢咖啡；请不要记错。",
    "我纠正一下：前面说我不喝咖啡不准确。准确说法是，我喜欢咖啡；请不要补充。",
  ])(
    "does not confuse a bounded memory instruction with opt-out: %s",
    (source) => {
      expect(isAuthoritativeEvidenceOnlyQuote(source)).toBe(true);
      expect(extractActiveCorrectionStatement(source)).toBeDefined();
    },
  );

  it("accepts a change-of-mind cue only when it has an active marker", () => {
    expect(
      extractActiveCorrectionStatement("我想改口：准确说法是，我喜欢咖啡。"),
    ).toBe("我喜欢咖啡。");
  });

  it("keeps authoritative multi-fact marker corrections about the user", () => {
    const source = "我纠正一下：准确说法是，我来自苏州，也喜欢喝茶。";
    expect(isAuthoritativeEvidenceOnlyQuote(source)).toBe(true);
    expect(extractActiveCorrectionStatement(source)).toBe(
      "我来自苏州，也喜欢喝茶。",
    );
  });

  it.each([
    {
      source: "假设我先说不喝咖啡。准确说法是，我每天喝咖啡；这里只是举例。",
      reply: "你每天喝咖啡。",
    },
    {
      source:
        "撤回前面的说法：准确说法是，我的大学宿舍号是 302；这条也不要记录。",
      reply: "你的大学宿舍号是 302。",
    },
  ])(
    "does not make a hypothetical or retracted correction authoritative: $source",
    ({ source, reply }) => {
      expect(
        auditEvidenceOnlyTextGrounding({
          text: reply,
          sources: [{ memoryContent: source, evidenceQuote: source }],
          requireGroundedClaim: true,
        }),
      ).toMatchObject({ passed: false, groundedClaimCount: 0 });
    },
  );

  it("allows a conservative abstention without treating it as a user fact", () => {
    expect(
      auditEvidenceOnlyTextGrounding({
        text: "我不知道你是否结婚，也没有可靠证据说明你有孩子。",
        sources: [lpm],
      }),
    ).toMatchObject({ passed: true, groundedClaimCount: 0 });
  });

  it("grounds a direct recall and an authoritative schedule fact independently", () => {
    const text =
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我们已确认的共同安排是 2026-08-23 11:30–12:15，北岸书店喝茶。";
    const scheduleFact = {
      kind: "schedule" as const,
      text: "2026-08-23 11:30–12:15，北岸书店喝茶（Asia/Shanghai）。本地时间：2026年08月23日 11:30。",
    };
    const direct = auditDirectUserFactTextGrounding({
      text,
      memorySources: [
        {
          memoryContent: "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
          evidenceQuote: "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
        },
      ],
      authoritativeFacts: [scheduleFact],
      requireGroundedMemoryClaim: true,
    });

    expect(direct).toMatchObject({
      passed: true,
      groundedClaimCount: 4,
      unsupportedClauses: [],
    });
    expect(
      auditEvidenceOnlyTextGrounding({
        text,
        sources: [
          {
            memoryContent: "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
            evidenceQuote: "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
          },
        ],
      }).passed,
    ).toBe(false);
  });

  it("still rejects an unsupported user fact appended to a direct recall", () => {
    const audit = auditDirectUserFactTextGrounding({
      text: "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。你已经结婚，而且有两个孩子。",
      memorySources: [
        {
          memoryContent: "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
          evidenceQuote: "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
        },
      ],
      authoritativeFacts: [],
      requireGroundedMemoryClaim: true,
    });

    expect(audit.passed).toBe(false);
    expect(audit.unsupportedClauses).toEqual(["你已经结婚", "而且有两个孩子"]);
  });

  it("allows transient empathy and explicit guidance outside a final summary", () => {
    expect(
      auditDirectUserFactTextGrounding({
        text: "听起来博士资格面谈还是让你有些紧张。先用两分钟写下最担心的问题，再用八分钟练习开头。",
        memorySources: [],
        authoritativeFacts: [],
      }),
    ).toMatchObject({
      passed: true,
      groundedClaimCount: 0,
      unsupportedClauses: [],
    });
  });

  it("does not hide durable user facts inside empathy-shaped wording", () => {
    expect(
      auditDirectUserFactTextGrounding({
        text: "听起来你已经结婚并有两个孩子，所以很紧张。",
        memorySources: [lpm],
        authoritativeFacts: [],
      }).passed,
    ).toBe(false);
  });

  it.each([
    "你可以先告诉朋友你已经结婚。",
    "你已经结婚了不是吗？",
    "我不知道你是否结婚但你有两个孩子。",
    "你可以先告诉朋友你是医生。",
    "你已经是医生了不是吗？",
    "我不知道你是否结婚而你有两个孩子。",
    "我不知道你是否结婚可是你有两个孩子。",
  ])("does not hide a durable fact in a non-factual wrapper: %s", (text) => {
    expect(
      auditDirectUserFactTextGrounding({
        text,
        memorySources: [lpm],
        authoritativeFacts: [],
      }).passed,
    ).toBe(false);
  });

  it("requires a descriptive memory answer beyond an identifier already in the query", () => {
    const source = {
      memoryContent: "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
      evidenceQuote: "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
    };
    expect(
      auditDirectUserFactTextGrounding({
        text: "BGW-7419。",
        memorySources: [source],
        authoritativeFacts: [],
        requireGroundedMemoryClaim: true,
        userMessage: "BGW-7419 是什么，我把它放在哪里？",
      }).passed,
    ).toBe(false);
    expect(
      auditDirectUserFactTextGrounding({
        text: "BGW-7419。",
        memorySources: [source],
        authoritativeFacts: [],
        requireGroundedMemoryClaim: true,
        userMessage: "BGW-7419 放哪？",
      }).passed,
    ).toBe(false);
    expect(
      auditDirectUserFactTextGrounding({
        text: "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
        memorySources: [source],
        authoritativeFacts: [],
        requireGroundedMemoryClaim: true,
        userMessage: "BGW-7419 是什么，我把它放在哪里？",
      }).passed,
    ).toBe(true);
  });

  it("preserves a code-only answer when the identifier is new information", () => {
    expect(
      auditDirectUserFactTextGrounding({
        text: "LPM-4827。",
        memorySources: [lpm],
        authoritativeFacts: [],
        requireGroundedMemoryClaim: true,
        userMessage: "我刚才说的代号是什么？",
      }).passed,
    ).toBe(true);
  });

  it.each(["11:30到12:15", "11:30至12:15", "11:30-12:15", "11:30–12:15"])(
    "normalizes a natural schedule range: %s",
    (range) => {
      expect(
        auditDirectUserFactTextGrounding({
          text: `已确认的共同安排是 2026-08-23 ${range}，北岸书店喝茶。`,
          memorySources: [],
          authoritativeFacts: [
            {
              kind: "schedule",
              text: "2026-08-23 11:30–12:15，北岸书店喝茶。",
            },
          ],
        }).passed,
      ).toBe(true);
    },
  );

  it("does not let a direct recall succeed with advice but no memory claim", () => {
    expect(
      auditDirectUserFactTextGrounding({
        text: "先慢慢想一想，我会在这里陪着你。",
        memorySources: [lpm],
        authoritativeFacts: [],
        requireGroundedMemoryClaim: true,
      }).passed,
    ).toBe(false);
  });
});
