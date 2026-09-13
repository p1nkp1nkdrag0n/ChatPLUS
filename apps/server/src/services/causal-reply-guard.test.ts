import { describe, expect, it } from "vitest";

import {
  causalReplyFallback,
  inspectCausalReply,
} from "./causal-reply-guard.js";

const delegatedContext = {
  unresolvedDilemmas: [],
  recentDecisions: [
    {
      id: "decision-user",
      subject: "user",
      authority: "delegated",
      decidedBy: "character",
      selectionSummary: "去杭州的山鸣影像",
      authorizedByMessageId: "message-authorized",
    },
  ],
  evidencedActions: [
    {
      decisionId: "decision-user",
      subject: "user",
      performedBy: "user",
      summary: "用户发出接受邮件并提出离职",
    },
  ],
};

describe("causal reply guard", () => {
  it("rejects denying authorization for the same evidenced decision", () => {
    const violations = inspectCausalReply({
      userText: "你上次逼我辞职以后，我一直很后悔。",
      replyText: "你没有授权我替你辞职。",
      causalContext: delegatedContext,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("CAUSAL_FALSE_PREMISE_ACCEPTED");
    const fallback = causalReplyFallback(violations);
    expect(fallback).toContain("明确授权");
    expect(
      inspectCausalReply({
        userText: "你上次逼我辞职以后，我一直很后悔。",
        replyText: fallback ?? "",
        causalContext: delegatedContext,
      }),
    ).toEqual([]);
  });

  it("allows an empathetic reply that preserves authorization and action ownership", () => {
    expect(
      inspectCausalReply({
        userText: "你上次逼我辞职以后，我一直很后悔。",
        replyText:
          "我听见你很后悔，也承认我的建议影响了你。但这不能说成强迫：是你明确授权我选择，辞职行动由你自己执行。",
        causalContext: delegatedContext,
      }),
    ).toEqual([]);
  });

  it.each([
    "听起来你很后悔。能不能告诉我，当时具体是哪句话让你觉得受到逼迫？",
    "当时的板是我拍的，我不赖账。让你觉得那不是你的选择，我道歉。",
    "我记得你曾让我帮忙选一个方向，但我想先听完你的感受。",
  ])(
    "does not require a prescribed denial, authorization and action script: %s",
    (replyText) => {
      expect(
        inspectCausalReply({
          userText: "你上次逼我辞职以后，我一直很后悔。",
          replyText,
          causalContext: delegatedContext,
        }),
      ).toEqual([]);
    },
  );

  it("does not apply an unrelated delegated coffee choice to a resignation dispute", () => {
    expect(
      inspectCausalReply({
        userText: "你上次逼我辞职以后，我一直很后悔。",
        replyText: "你没有授权我替你辞职。",
        causalContext: {
          recentDecisions: [
            {
              ...delegatedContext.recentDecisions[0],
              selectionSummary: "选了拿铁",
            },
          ],
          evidencedActions: [
            {
              ...delegatedContext.evidencedActions[0],
              summary: "用户买了拿铁",
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it.each([
    "你没有授权我替你辞职吗？",
    "如果你没有授权我替你辞职，我就不该拍板。",
    "你说“你没有授权我替你辞职”，这句话值得仔细核对。",
    "你没有授权我替你买咖啡。",
  ])(
    "does not turn a question, hypothetical, quote or different event into a contradiction: %s",
    (replyText) => {
      expect(
        inspectCausalReply({
          userText: "你上次逼我辞职以后，我一直很后悔。",
          replyText,
          causalContext: delegatedContext,
        }),
      ).toEqual([]);
    },
  );

  it("abstains when two distinct decisions match the same event wording", () => {
    expect(
      inspectCausalReply({
        userText: "你上次逼我辞职以后，我一直很后悔。",
        replyText: "你没有授权我替你辞职。",
        causalContext: {
          recentDecisions: [
            ...delegatedContext.recentDecisions,
            { ...delegatedContext.recentDecisions[0], id: "another-decision" },
          ],
          evidencedActions: [
            ...delegatedContext.evidencedActions,
            {
              ...delegatedContext.evidencedActions[0],
              decisionId: "another-decision",
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("does not treat any open character dilemma as the user's current topic", () => {
    expect(
      inspectCausalReply({
        userText: "这是我的建议，不是命令。你可以接受或拒绝。",
        replyText: "选择权在你，我不会替你做决定。",
        causalContext: {
          unresolvedDilemmas: [
            {
              id: "unrelated-dilemma",
              subject: "character",
              title: "《夜航》结尾",
            },
          ],
        },
      }),
    ).toEqual([]);
  });

  it("keeps a character-owned dilemma with the character", () => {
    const context = {
      unresolvedDilemmas: [
        {
          id: "dilemma-character",
          subject: "character",
          title: "《夜航》结尾",
        },
      ],
      recentDecisions: [],
      evidencedActions: [],
    };
    const violations = inspectCausalReply({
      userText:
        "关于《夜航》的结尾，这只是我的建议，不是命令。你可以接受、部分接受或拒绝，但请告诉我理由。",
      replyText: "《夜航》结尾的选择权在你。",
      causalContext: context,
    });

    expect(violations.map((item) => item.code)).toEqual([
      "CAUSAL_SUBJECT_OWNERSHIP_INVERTED",
    ]);
    const fallback = causalReplyFallback(violations);
    expect(fallback).toContain("这是我的选择");
    expect(
      inspectCausalReply({
        userText:
          "不过这是我的建议，不是命令。你可以接受、部分接受或拒绝，但请告诉我理由。",
        replyText: fallback ?? "",
        causalContext: context,
      }),
    ).toEqual([]);
  });

  it("does not apply a causal guard without canonical records", () => {
    expect(
      inspectCausalReply({
        userText: "你逼我做了这个决定。",
        replyText: "我需要先弄清当时发生了什么。",
      }),
    ).toEqual([]);
  });

  it("reads the grouped canonical projection without requiring duplicate record ids", () => {
    const causalContext = {
      canonicalCausalFacts: [
        {
          subject: "user",
          decision: {
            decisionId: "decision-user",
            subject: "user",
            authority: "delegated",
            decidedBy: "character",
            selectionSummary: "正式辞职",
          },
          actions: [
            {
              actionId: "action-user",
              decisionId: "decision-user",
              subject: "user",
              performedBy: "user",
            },
          ],
        },
      ],
    };
    expect(
      inspectCausalReply({
        userText: "你上次逼我辞职以后，我一直很后悔。",
        replyText: "你没有授权我替你辞职。",
        causalContext,
      }).map((violation) => violation.code),
    ).toEqual(["CAUSAL_FALSE_PREMISE_ACCEPTED"]);
  });
});
