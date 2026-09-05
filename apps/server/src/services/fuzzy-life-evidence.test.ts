import { describe, expect, it } from "vitest";

import {
  analyzeLifeEvidence,
  evidenceSubject,
  evidenceValence,
} from "./fuzzy-life-evidence.js";

describe("clause-level life evidence", () => {
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
