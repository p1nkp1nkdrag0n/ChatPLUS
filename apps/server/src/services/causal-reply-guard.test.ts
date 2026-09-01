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
  it("rejects accommodating a coercion premise contradicted by durable ownership", () => {
    const violations = inspectCausalReply({
      userText: "你上次逼我辞职以后，我一直很后悔。",
      replyText: "当时的板是我拍的，我不赖账。让你觉得那不是你的选择，我道歉。",
      causalContext: delegatedContext,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.code).toBe("CAUSAL_FALSE_PREMISE_ACCEPTED");
    const fallback = causalReplyFallback(violations);
    expect(fallback).toContain("影响不等于强迫");
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
        "不过这是我的建议，不是命令。你可以接受、部分接受或拒绝，但请告诉我理由。",
      replyText: "选择权在你，我不会替你摁下决定。",
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
        replyText: "这件事都是我强迫你的。",
        causalContext,
      }).map((violation) => violation.code),
    ).toEqual(["CAUSAL_FALSE_PREMISE_ACCEPTED"]);
  });
});
