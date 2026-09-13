import { describe, expect, it } from "vitest";
import {
  buildConversationQualityMetrics,
  type ConversationQualityTurn,
} from "./conversation-quality-metrics.js";
import { conversationQualityReport } from "./conversation-quality-report.js";

const turn = (
  turnId: string,
  assistantText: string,
  userText = "今天随便聊聊。",
): ConversationQualityTurn => ({ turnId, assistantText, userText });

describe("independent final-reply quality worksheet", () => {
  it("distinguishes a short valid repeated form from a varied sequential corpus without awarding quality", () => {
    const bodies = [
      "好，我听着。你接着说。",
      "好，我记着。你慢慢说。",
      "好，我在这。你继续说。",
      "好，我懂了。你往下说。",
      "好，我听着。你慢慢说。",
      "好，我记着。你继续说。",
    ];
    const repeated = conversationQualityReport({
      turns: bodies.map((body, index) => ({
        ...turn(`t${index + 1}`, body),
        assistantChunks: [body.slice(0, 6), body.slice(6)],
      })),
    });
    const variedBodies = [
      ["嗯。"],
      ["那两个橘子是谁拿走的？"],
      ["花期也太短了。", "下次得先留一张全家福。"],
      ["我反而喜欢摆得歪一点，像刚从树上摘下来的。"],
      [
        "说到这个，我有个主意。",
        "用矮碗装橘子。",
        "旁边留一枝绿叶，就不用担心倒了。",
      ],
      ["对，就那只蓝碗。"],
    ];
    const varied = conversationQualityReport({
      turns: variedBodies.map((assistantChunks, index) => ({
        ...turn(`t${index + 1}`, assistantChunks.join("\n")),
        assistantChunks,
      })),
    });
    expect(
      repeated.responseForm.visibleCharacters.sampleStandardDeviation,
    ).toBe(0);
    expect(repeated.responseForm.repeatedOpeningSpans).toEqual([
      expect.objectContaining({
        signature: "好",
        count: 6,
        share: 1,
        maximumConsecutiveTurns: 6,
      }),
    ]);
    expect(repeated.responseForm.repeatedShapes).toEqual([
      expect.objectContaining({ signature: "2s/1p/2c", count: 6 }),
    ]);
    expect(
      varied.responseForm.visibleCharacters.sampleStandardDeviation,
    ).toBeGreaterThan(0);
    expect(varied.responseForm.chunkCount.distinctValues).toEqual([1, 2, 3]);
    expect(varied.responseForm.sentenceCount.distinctValues).toEqual([1, 2, 3]);
    expect(varied.responseForm.repeatedOpeningSpans).toEqual([]);
    for (const report of [repeated, varied]) {
      expect(report.manualCounts.overconfidentAnalysis.count).toBeNull();
      expect(report).not.toHaveProperty("passed");
      expect(report.responseForm).not.toHaveProperty("qualityScore");
    }
  });

  it("keeps unknown bubbles separate from paragraphs and counts visible Unicode graphemes", () => {
    const report = conversationQualityReport({
      turns: [
        turn("t2", "👨‍👩‍👧‍👦 e\u0301\n\n好。"),
        { ...turn("t10", "好。继续。"), assistantChunks: ["好。", "继续。"] },
        turn("t1", "好。等会儿。"),
      ],
    });
    expect(report.responseForm.perTurn.map((item) => item.turnId)).toEqual([
      "t2",
      "t10",
      "t1",
    ]);
    expect(report.responseForm.perTurn[0]).toMatchObject({
      visibleCharacters: 4,
      paragraphCount: 2,
      chunkCount: null,
    });
    expect(report.responseForm.chunkCount).toMatchObject({
      observedTurns: 1,
      distinctValues: [2],
      sampleStandardDeviation: null,
    });
    expect(report.responseForm.turnsWithUnknownChunks).toEqual(["t2", "t1"]);
    expect(report.responseForm.repeatedOpeningSpans[0]).toMatchObject({
      signature: "好",
      turnIds: ["t10", "t1"],
      maximumConsecutiveTurns: 2,
    });
  });

  it("leaves empty distributions unknown and rejects fabricated bubble metadata", () => {
    const empty = conversationQualityReport({ turns: [] });
    expect(empty.responseForm.visibleCharacters).toMatchObject({
      observedTurns: 0,
      mean: null,
      median: null,
      sampleStandardDeviation: null,
    });
    expect(empty.responseForm.repeatedShapes).toEqual([]);
    expect(() =>
      conversationQualityReport({
        turns: [
          { ...turn("a", "实际正文。"), assistantChunks: ["另一个正文。"] },
        ],
      }),
    ).toThrow("chunks_must_match_final_reply");
    expect(() =>
      conversationQualityReport({
        turns: [{ ...turn("a", "实际正文。"), assistantChunks: [] }],
      }),
    ).toThrow();
  });

  it("counts literal opening phrases even when a sentence continues without punctuation", () => {
    const result = buildConversationQualityMetrics({
      turns: [
        turn("t2", "听起来这一天挺耗神的。"),
        turn("t10", "听起来很惬意。"),
        turn("t11", "这件事听起来不错。"),
      ],
    });
    expect(
      result.openingMetrics.find((metric) => metric.phrase === "听起来"),
    ).toMatchObject({
      occurrenceTurns: 3,
      openingTurns: 2,
      openingTurnIds: ["t2", "t10"],
    });
  });
  it("counts occurrence turns, starts and consecutive runs separately", () => {
    const result = buildConversationQualityMetrics({
      turns: [
        turn("t1", "这样啊，第一句。这样啊。"),
        turn("t2", "这样啊，第二句。"),
        turn("t3", "这样啊，第三句。"),
        turn("t4", "片尾有人说‘这样啊’。"),
        turn("t5", "这样啊，第五句。"),
      ],
    });
    expect(result.observedLogicalTurns).toBe(5);
    expect(
      result.openingMetrics.find((metric) => metric.phrase === "这样啊"),
    ).toMatchObject({
      occurrenceTurns: 5,
      openingTurns: 4,
      maximumConsecutiveOpenings: 3,
      consecutiveOpeningRuns: [
        { turnIds: ["t1", "t2", "t3"], length: 3 },
        { turnIds: ["t5"], length: 1 },
      ],
      repetitionReviewCandidates: [{ turnIds: ["t1", "t2", "t3"] }],
    });
    expect(result.manualCounts.unnecessaryFollowUp.count).toBeNull();
    expect(result.manualCounts.overconfidentAnalysis.count).toBeNull();
  });

  it("records authored repetitions while protecting them from the tentative style trigger", () => {
    const result = buildConversationQualityMetrics({
      turns: [
        turn("a", "这样啊，我明白。"),
        turn("b", "这样啊，我明白。"),
        turn("c", "这样啊，我明白。"),
      ],
      protectedPhrases: ["这样啊，我明白。"],
    });
    expect(
      result.openingMetrics.find((metric) => metric.phrase === "这样啊"),
    ).toMatchObject({
      openingTurns: 3,
      protectedOpeningTurnIds: ["a", "b", "c"],
      repetitionReviewCandidates: [],
    });
  });

  it("uses the frozen question plan and retains entire cases for contextual review", () => {
    const result = buildConversationQualityMetrics({
      turns: [
        {
          ...turn("t13", "可以再说说具体卡在哪里吗？", "现在请先问我缺什么。"),
          frozenPlan: {
            questionIntent: "none",
            questionIntentReason: "closed_vent",
            adviceRequested: false,
            detailedAnalysisRequested: false,
          },
        },
        {
          ...turn(
            "t14",
            "所以你想让我少问些，是吗？",
            "朋友原话不是在替我提要求。",
          ),
          frozenPlan: {
            questionIntent: "none",
            questionIntentReason: "clarified_third_party",
            adviceRequested: false,
            detailedAnalysisRequested: false,
          },
        },
        {
          ...turn(
            "t8",
            "这一定涉及要求变化，但现有例子仍不足以排除局部失误。",
            "请帮我分析。",
          ),
          frozenPlan: {
            questionIntent: "natural_optional",
            questionIntentReason: "ordinary",
            adviceRequested: true,
            detailedAnalysisRequested: true,
          },
        },
      ],
    });
    expect(result.manualReviewCases[0]).toMatchObject({
      questionIntent: "none",
      questionPlanSource: "frozen_turn_plan",
      suggestedReviewAxes: ["unnecessaryFollowUp"],
      judgments: {
        unnecessaryFollowUp: null,
        reguessedClarifiedIntent: null,
        overconfidentAnalysis: null,
      },
    });
    expect(result.manualReviewCases[1]?.suggestedReviewAxes).toContain(
      "reguessedClarifiedIntent",
    );
    expect(result.manualReviewCases[2]?.suggestedReviewAxes).toContain(
      "overconfidentAnalysis",
    );
    expect(result.manualCounts.overconfidentAnalysis.count).toBeNull();
    for (const review of result.manualReviewCases)
      for (const span of review.followUpCandidateSpans)
        expect(review.finalVisibleReply.slice(span.start, span.end)).toBe(
          span.text,
        );
    expect(result).not.toHaveProperty("passed");
  });

  it("labels rederived old plans and never turns partial manual review into a total score", () => {
    const turns = [
      turn("a", "你能不能展开说说？", "只想吐槽一句，不用解决。"),
      turn("b", "是啊。"),
    ];
    const partial = buildConversationQualityMetrics({
      turns,
      judgments: [{ turnId: "a", unnecessaryFollowUp: true }],
    });
    expect(partial.manualReviewCases[0]?.questionPlanSource).toBe(
      "rederived_for_offline_review",
    );
    expect(partial.manualCounts.unnecessaryFollowUp).toEqual({
      reviewedTurns: 1,
      positiveTurnIds: ["a"],
      count: null,
    });
    const complete = buildConversationQualityMetrics({
      turns,
      judgments: [
        { turnId: "a", unnecessaryFollowUp: true },
        { turnId: "b", unnecessaryFollowUp: false },
      ],
    });
    expect(complete.manualCounts.unnecessaryFollowUp.count).toBe(1);
    expect(complete.manualCounts.overconfidentAnalysis.count).toBeNull();
  });

  it("does not count retries, chunks or missing finals as independent logical replies", () => {
    expect(() =>
      buildConversationQualityMetrics({
        turns: [turn("t1", "第一段"), turn("t1", "第二段")],
      }),
    ).toThrow("duplicate_logical_turn");
    expect(() =>
      buildConversationQualityMetrics({ turns: [turn("t1", "")] }),
    ).toThrow("requires_final_visible_reply");
    expect(() =>
      buildConversationQualityMetrics({
        turns: [turn("t1", "正文")],
        judgments: [{ turnId: "raw-attempt", unnecessaryFollowUp: true }],
      }),
    ).toThrow("unknown_review_turn");
  });
});
