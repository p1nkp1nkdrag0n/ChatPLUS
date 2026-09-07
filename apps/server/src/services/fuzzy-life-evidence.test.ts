import { describe, expect, it } from "vitest";

import {
  analyzeLifeEvidence,
  analyzeStateAttributions,
  STATE_ATTRIBUTION_VERSION,
  evidenceSubject,
  evidenceValence,
} from "./fuzzy-life-evidence.js";
import { collectLifeAssociationEvidence } from "./fuzzy-life-association.js";

describe("versioned relative state attribution", () => {
  const candidates = (
    text: string,
    speakerRole: "character" | "user" = "character",
  ) =>
    analyzeStateAttributions({
      text,
      speakerRole,
      sourceMessageId: "source-state-1",
    });

  it.each([
    ["我理解你的疲惫。", "addressee", "explicit", "asserted"],
    [
      "我觉得可以分开来看，在这种时候你的疲惫是合理的反应。",
      "addressee",
      "explicit",
      "asserted",
    ],
    ["她说‘我压力很大’。", "third_party", "explicit", "reported"],
    ["如果是我，我可能也会焦虑。", "speaker", "explicit", "conditional"],
    ["我并不疲惫，只是在理解你。", "speaker", "explicit", "negated"],
    ["我明天会很焦虑。", "speaker", "explicit", "planned"],
    ["我很焦虑吗？", "speaker", "explicit", "question"],
    ["请翻译：我很焦虑。", "speaker", "explicit", "meta"],
    ["我觉得可以分开来看，压力很大。", "unknown", "unresolved", "asserted"],
    ["最近压力很大。", "unknown", "unresolved", "asserted"],
  ] as const)(
    "keeps the local experiencer and evidence mode: %s",
    (text, experiencer, bindingMethod, modality) => {
      expect(
        candidates(text).find((item) => item.kind === "pressure"),
      ).toMatchObject({
        experiencer,
        bindingMethod,
        modality,
        attributionVersion: STATE_ATTRIBUTION_VERSION,
        speakerRole: "character",
        sourceMessageId: "source-state-1",
      });
    },
  );

  it("does not let the cognition speaker leak across a sentence boundary", () => {
    expect(
      candidates("我觉得你很累。最近压力很大。").map(
        (item) => item.experiencer,
      ),
    ).toEqual(["addressee", "unknown"]);
  });

  it.each(["user", "character"] as const)(
    "binds first person to the actual %s speaker while preserving legacy subject semantics",
    (speakerRole) => {
      const text = "我最近加班，累得不行。";
      expect(candidates(text, speakerRole)).toEqual([
        expect.objectContaining({
          sourceText: "累得不行",
          speakerRole,
          experiencer: "speaker",
          bindingMethod: "local_ellipsis",
          modality: "asserted",
        }),
      ]);
      expect(analyzeLifeEvidence(text).clauses[0]?.subject).toBe("user");
    },
  );

  it.each([
    "我觉得我有点累。",
    "我觉得很累。",
    "听你这么说，我也有点难受。",
    "你的话让我很焦虑。",
  ])("recognizes the embedded or affected experiencer: %s", (text) => {
    expect(candidates(text)).toContainEqual(
      expect.objectContaining({
        experiencer: "speaker",
        bindingMethod: "explicit",
        modality: "asserted",
      }),
    );
  });

  it("retains quantified pressure and feedback with raw source spans", () => {
    const text =
      "🎬　我最近加班，　累得不行。\n我压力是 0.72。你这样说让我感到被理解，压力缓解了。";
    const result = candidates(text);
    expect(
      result.some(
        (item) => item.kind === "feedback" && item.experiencer === "speaker",
      ),
    ).toBe(true);
    expect(result.some((item) => item.sourceText === "我压力是 0.72")).toBe(
      true,
    );
    for (const item of result) {
      expect(text.slice(item.sourceSpan.start, item.sourceSpan.end)).toBe(
        item.sourceText,
      );
    }
  });

  it.each([
    "我最近加班。累得不行。",
    "我最近加班；累得不行。",
    "我最近加班，另外这个项目压力很大，累得不行。",
    "我最近加班，但压力很大。",
    "我最近加班，‘你很焦虑’，累得不行。",
  ])("abstains after topic, quote and sentence boundaries: %s", (text) => {
    expect(
      candidates(text).filter(
        (item) =>
          item.experiencer === "speaker" && item.modality === "asserted",
      ),
    ).toEqual([]);
  });
});

describe("clause-level life evidence", () => {
  it("retains actual acceptance and its funding cost without promoting a possible future salary", () => {
    const text =
      "山鸣影像确认接受我，但项目资金延迟，入职后的头两个月可能只能拿八成薪资；同时现公司愿意让我带一个更有自主权的小组。这是混合结果，不是纯好消息。";
    const outcomes = collectLifeAssociationEvidence(
      analyzeLifeEvidence(text),
      "outcome",
    );
    expect(outcomes[0]).toMatchObject({
      sourceText: "山鸣影像确认接受我,但项目资金延迟",
      classifyText: "山鸣影像确认接受我,但项目资金延迟",
      modality: "asserted",
      outcome: true,
      valence: "mixed",
    });
    expect(
      outcomes.every((clause) => !/八成薪资|入职后/u.test(clause.sourceText)),
    ).toBe(true);
    expect(
      collectLifeAssociationEvidence(
        analyzeLifeEvidence(outcomes[0]!.sourceText),
        "outcome",
      )[0],
    ).toMatchObject({ sourceText: outcomes[0]!.sourceText, valence: "mixed" });
  });

  it.each([
    "公司确认录用我，但项目资金可能延迟。",
    "公司确认录用我，但项目资金没有延迟。",
    "公司确认录用我，但明天项目资金才会延迟。",
  ])(
    "does not turn a possible or denied cost into a mixed actual result: %s",
    (text) => {
      const outcomes = collectLifeAssociationEvidence(
        analyzeLifeEvidence(text),
        "outcome",
      );
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({
        sourceText: "公司确认录用我",
        valence: "positive",
      });
    },
  );

  it.each([
    "据说公司确认接受我，但项目资金延迟。",
    "如果公司确认录用我，但项目资金延迟。",
    "公司确认录取我朋友。",
    "公司确认接受我的同事。",
    "公司没有确认录用我。",
  ])("does not manufacture the speaker's actual acceptance: %s", (text) => {
    expect(
      collectLifeAssociationEvidence(analyzeLifeEvidence(text), "outcome"),
    ).toEqual([]);
  });

  it.each([
    "我刚换好鞋出门了。",
    "散步回来，顺手画了几笔线。",
    "我把画具放下了。",
    "我昨晚补了两笔颜色。",
    "我今天已经提交了申请。",
    "我已经完成了申请。",
    "后来我跟客户确认了合同范围。",
  ])("recognizes a reported action: %s", (text) => {
    expect(
      analyzeLifeEvidence(text).clauses.some((clause) => clause.action),
    ).toBe(true);
  });

  it.each([
    "我准备明天出门。",
    "我今天打算提交申请。",
    "我今天决定提交申请。",
    "今天的安排是提交申请。",
    "我今天想提交申请。",
    "我已经决定辞职了。",
    "现在我明确授权你替我在留在目前公司和正式辞职之间作决定。",
    "我准备好了，但还没有提交申请。",
    "我今天会把申请提交。",
    "接下来两周先观察执行情况。",
    "今天把记录继续写着，先看实际执行是否顺利。",
    "我还没有提交申请。",
    "我没有实际出门，只是计划去做。",
    "我没有画过那幅画。",
    "我昨天没有去散步。",
    "我昨天没发出邮件。",
    "我昨天没有收起画具。",
    "我今天想先散步二十分钟。",
    "我今天要出门。",
    "我今天想把画具收起。",
    "我昨天差点就提交了申请，但最后没有提交。",
    "我刚才险些发出邮件。",
    "我今天听王明说已经提交了申请。",
    "我今天听医生讲已经完成了申请。",
    "我聊完了自己的近况。王明昨天提交了申请。",
    "我聊完了自己的近况。程夏出门了。",
    "如果我已经提交了申请，再联系公司。",
    "我已经提交申请了吗？",
    "我是否已经提交了申请。",
    "我有没有出门散步。",
    "请翻译：我已经提交了申请。",
    "原文：我已经提交了申请。",
    "我已经提交了申请，这只是一个例句。",
    "听说我已经提交了申请。",
    "请按顺序回顾我已经提交申请后的决定、行动和结果。",
    "我朋友今天已经提交了申请。",
    "公司今天已经提交了申请。",
    "回头看，我很庆幸当时提交了申请。",
  ])("does not manufacture an action: %s", (text) => {
    expect(
      analyzeLifeEvidence(text).clauses.some((clause) => clause.action),
    ).toBe(false);
  });

  it("keeps actual clauses when a neighboring clause is a plan or denial", () => {
    const analysis = analyzeLifeEvidence(
      "我今天已经提交了申请；明天会联系公司，结果还没出来。另一个话题，我刚换好鞋出门了。",
    );
    expect(
      analysis.clauses
        .filter((clause) => clause.action)
        .map((clause) => clause.sourceText),
    ).toEqual(["我今天已经提交了申请", "我刚换好鞋出门了"]);
    expect(analysis.clauses.some((clause) => clause.outcome)).toBe(false);
  });

  it("carries completed first-person action across a same-sentence coordinated step", () => {
    const clauses = analyzeLifeEvidence(
      "我今天已经拒绝副主编合同，并和伙伴确认启动项目。这是实际行动。",
    ).clauses.filter((clause) => clause.action);
    expect(clauses.slice(0, 2)).toMatchObject([
      { sourceText: "我今天已经拒绝副主编合同", subject: "user" },
      { sourceText: "并和伙伴确认启动项目", subject: "user" },
    ]);
  });

  it.each([
    "我今天已经拒绝副主编合同，并和伙伴准备启动项目。",
    "我今天已经拒绝副主编合同，并和伙伴确认下周启动项目。",
    "我今天已经拒绝副主编合同，并没有确认启动项目。",
    "我今天已经拒绝副主编合同，并且我朋友确认启动项目。",
    "我今天已经拒绝副主编合同。并和伙伴确认启动项目。",
    "我今天已经拒绝副主编合同，并和伙伴确认启动项目了吗？",
  ])("does not invent a coordinated completed step: %s", (text) => {
    expect(
      analyzeLifeEvidence(text).clauses.some(
        (clause) => clause.action && clause.classifyText.includes("启动项目"),
      ),
    ).toBe(false);
  });

  it("does not execute a delegated option but preserves an independent completed action", () => {
    const analysis = analyzeLifeEvidence(
      "现在我明确授权你替我在留在目前公司和正式辞职之间作决定。我已经按照这个决定向主管提出离职。",
    );
    expect(
      analysis.clauses
        .filter((clause) => clause.action)
        .map((clause) => clause.sourceText),
    ).toEqual(["我已经按照这个决定向主管提出离职"]);
  });

  it("keeps an earlier event when an independent clause requests translation", () => {
    const analysis = analyzeLifeEvidence(
      "我已经提交了申请，顺便请翻译‘good luck’。",
    );
    expect(
      analysis.clauses
        .filter((clause) => clause.action)
        .map((clause) => clause.sourceText),
    ).toEqual(["我已经提交了申请"]);
  });

  it("retains quoted sources without classifying the quote as an event", () => {
    const analysis = analyzeLifeEvidence(
      "我已经把写着‘我成功了’的申请提交了。她说‘我已经出门了’。",
    );
    expect(analysis.sourceText).toContain("‘我成功了’");
    expect(analysis.classifyText).not.toContain("我成功了");
    expect(analysis.clauses.filter((clause) => clause.action)).toHaveLength(1);
    expect(analysis.clauses.some((clause) => clause.outcome)).toBe(false);
  });

  it("attributes independent assertions to their own actor", () => {
    const analysis = analyzeLifeEvidence(
      "我朋友已经提交了申请。你散步回来了吗？我刚出门了。",
    );
    expect(evidenceSubject(analysis, "action")).toBe("user");
    expect(analysis.clauses.filter((clause) => clause.action)).toHaveLength(1);
    expect(
      evidenceSubject(analyzeLifeEvidence("你今天已经提交了申请。"), "action"),
    ).toBe("character");
  });

  it.each([
    "脑子里的嗡嗡声退了一点。",
    "我现在松快了不少。",
    "走回来以后，心里安静了一些。",
    "我没那么焦虑了。",
    "后来公司同意了申请。",
    "我拿到了录用通知。",
  ])("recognizes actual feedback: %s", (text) => {
    expect(
      analyzeLifeEvidence(text).clauses.some((clause) => clause.outcome),
    ).toBe(true);
  });

  it.each([
    "信我收到了，别担心。",
    "明天我可能会轻松多了。",
    "我没有收到录用通知。",
    "公司没有同意申请。",
    "我并没有轻松多了。",
    "没有更难受，也没有变得轻松。",
    "对方现在不是拒绝，而是还在讨论。",
    "我并没有更焦虑。",
    "我没有失败，现在仍然在等结果。",
    "我只是期待会轻松多了。",
    "后来我朋友成功了。",
    "如果公司同意了申请，我会高兴。",
    "压力 6/10，清晰度 8/10。",
  ])(
    "does not treat hypothetical or unrelated receipt as an outcome: %s",
    (text) => {
      expect(
        analyzeLifeEvidence(text).clauses.some((clause) => clause.outcome),
      ).toBe(false);
    },
  );

  it("keeps reassurance polarity separate from negative outcomes", () => {
    expect(evidenceValence("别担心，信收到了。")).toBe("neutral");
    expect(evidenceValence("我没那么焦虑了。")).toBe("positive");
    expect(evidenceValence("申请失败了，收入也不稳定。")).toBe("negative");
    expect(evidenceValence("结果成功了，但收入更不稳定。")).toBe("mixed");
  });

  it("does not inherit the subject of a question into the speaker's report", () => {
    const analysis = analyzeLifeEvidence("你回来了吗？刚刚把画具放下了。");
    expect(evidenceSubject(analysis, "action")).toBe("unspecified");
  });

  it("does not negate an action because an unrelated object is absent", () => {
    expect(
      analyzeLifeEvidence("我没戴耳机就出门了。").clauses.some(
        (clause) => clause.action,
      ),
    ).toBe(true);
  });

  it("does not let a later future clause erase an independent reflection", () => {
    const analysis = analyzeLifeEvidence(
      "回头看，我很庆幸做了这个决定。明天我会继续申请。",
    );
    expect(analysis.clauses.some((clause) => clause.reflection)).toBe(true);
    expect(analysis.clauses.some((clause) => clause.action)).toBe(false);
  });

  it("keeps independent completed actions next to intentions, denials and counterfactuals", () => {
    const analysis = analyzeLifeEvidence(
      "我今天想先散步二十分钟。我昨天已经提交了申请。我刚才险些发出邮件，但我后来确实发出了邮件。我昨天没有收起画具；另外我刚刚把画具收起了。",
    );
    expect(
      analysis.clauses
        .filter((clause) => clause.action)
        .map((clause) => clause.sourceText),
    ).toEqual([
      "我昨天已经提交了申请",
      "但我后来确实发出了邮件",
      "另外我刚刚把画具收起了",
    ]);
  });

  it("does not carry a named third-party or reported-speech frame into a new explicit user assertion", () => {
    const analysis = analyzeLifeEvidence(
      "王明昨天提交了申请，我今天也提交了申请。我听程夏说她已经出门，我刚刚把画具收起了。",
    );
    expect(
      analysis.clauses
        .filter((clause) => clause.action)
        .map((clause) => [clause.sourceText, clause.subject]),
    ).toEqual([
      ["我今天也提交了申请", "user"],
      ["我刚刚把画具收起了", "user"],
    ]);
    expect(evidenceSubject(analysis, "action")).toBe("user");
  });

  it("preserves verb-led subject ellipsis after yesterday and today", () => {
    const analysis = analyzeLifeEvidence(
      "昨晚补了两笔颜色。今天已经提交了申请。散步回来，刚刚把画具放下了。",
    );
    expect(analysis.clauses.filter((clause) => clause.action)).toHaveLength(4);
    expect(evidenceSubject(analysis, "action")).toBe("unspecified");
  });

  it.each([
    ["我仍认同保留克制结尾，因为尊严更重要。", true],
    ["我不再认同这个选择。", true],
    ["如果以后我仍认同这个选择，我会告诉你。", false],
    ["你现在仍认同这个选择吗？", false],
    ["请翻译‘我仍认同这个选择’。", false],
  ] as const)(
    "recognizes only an actual expressed reinterpretation: %s",
    (text, expected) => {
      expect(
        analyzeLifeEvidence(text).clauses.some((clause) => clause.reflection),
      ).toBe(expected);
    },
  );

  it("treats an external acceptance and offer as observed responses, never the user's completed action", () => {
    const analysis = analyzeLifeEvidence(
      "青屿影像确认接受我，但项目资金延迟；同时现公司愿意让我带一个更有自主权的小组。这是混合结果。",
    );
    expect(
      analysis.clauses
        .filter((clause) => clause.outcome)
        .map((clause) => clause.sourceText),
    ).toEqual([
      "青屿影像确认接受我",
      "但项目资金延迟",
      "同时现公司愿意让我带一个更有自主权的小组",
      "这是混合结果",
    ]);
    expect(analysis.clauses.some((clause) => clause.action)).toBe(false);
    expect(
      analyzeLifeEvidence(
        "如果青屿影像确认接受我，现公司也许愿意让我带组。",
      ).clauses.some((clause) => clause.outcome),
    ).toBe(false);
  });

  it.each(["现公司不愿意让我带小组。", "项目资金没有延迟。"])(
    "does not turn a negated external offer or delay into its positive event: %s",
    (text) => {
      expect(
        analyzeLifeEvidence(text).clauses.some((clause) => clause.outcome),
      ).toBe(false);
    },
  );

  it.each([
    ["你的外包项目申请后来被拒绝了。", false, true],
    ["我今天拒绝了这份邀请。", true, true],
    ["我被拒绝后又提交了新的申请。", true, true],
  ] as const)(
    "separates a passive response from an actual performed action: %s",
    (text, action, outcome) => {
      const clauses = analyzeLifeEvidence(text).clauses;
      expect(clauses.some((clause) => clause.action)).toBe(action);
      expect(clauses.some((clause) => clause.outcome)).toBe(outcome);
    },
  );

  it("does not count a negated deterioration but keeps actual negative feedback", () => {
    const negated = analyzeLifeEvidence("我并没有更焦虑。");
    expect(
      negated.clauses.some(
        (clause) => clause.outcome || clause.pressureFeedback,
      ),
    ).toBe(false);
    expect(
      analyzeLifeEvidence("我没有被理解，反而更难受了。").clauses.some(
        (clause) => clause.pressureFeedback,
      ),
    ).toBe(true);
    expect(
      analyzeLifeEvidence("对方不是拒绝，而是后来同意了申请。")
        .clauses.filter((clause) => clause.outcome)
        .map((clause) => clause.sourceText),
    ).toEqual(["而是后来同意了申请"]);
  });
});
