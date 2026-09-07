import { describe, expect, it } from "vitest";

import {
  normalizeFollowUpCandidate,
  type FollowUpSubjectTypeLike,
} from "./follow-up.js";

function candidate(
  text: string,
  subjectType: FollowUpSubjectTypeLike = "user_event",
  role: "user" | "assistant" = "user",
) {
  return {
    agentId: "agent",
    sourceMessage: { id: "source", role, text },
    nowUtc: "2026-08-21T04:00:00.000Z",
    timezone: "Asia/Shanghai",
    candidate: {
      subjectType,
      contextSummary: text,
      expectedOutcomeDescription: "用户完成清单并取得成功，再汇报结果",
      timingHint: "tomorrow afternoon",
      evidenceQuotes: [text],
      reasonCode: "model_proposal",
      reasonSummary: "candidate",
    },
  };
}

describe("server-owned follow-up grounding", () => {
  it.each([
    "我现在想具体想一想了，请帮我分析一下：怎样区分真正做错了，和只是被反复修改弄得烦。",
    "谢谢，我懂了。",
    "好。",
    "请帮我分析明天有哪些方法。",
    "我想知道明天是否会去做清单。",
    "如果明天不加班，我也许试试清单。",
    "朋友说明天他会做清单。",
    "你说我明天可以试试清单。",
    "明天不用问我有没有做清单。",
    "我明天不会参加面试。",
    "我姐姐明天有面试。",
    "明天我朋友有面试。",
    "My sister has an interview tomorrow.",
    "明天我试试。",
    "明天我试试你说的办法。",
    "我明天没有面试。",
    "我明天不去面试。",
    "我明天没有计划做清单。",
    "My thesis defense is not tomorrow.",
    "我明天有面试吗？我记不清了。",
    "Do I have an interview tomorrow?",
    "“明天提醒我做清单。”",
  ])(
    "does not promote a request, politeness, condition, report, or negation: %s",
    (text) => {
      expect(normalizeFollowUpCandidate(candidate(text)).accepted).toBe(false);
    },
  );

  it.each([
    "user_goal",
    "user_event",
    "shared_commitment",
    "character_commitment",
  ] as const)(
    "cannot bypass adoption by changing subjectType to %s",
    (subject) => {
      const input = candidate(
        "请帮我分析怎样区分真正做错了和修改带来的烦躁。",
        subject,
      );
      expect(normalizeFollowUpCandidate(input).accepted).toBe(false);
    },
  );

  it.each([
    ["明天我试试你说的清单。", "user_plan"],
    ["明天下午有面试。", "user_event"],
    ["明天问问我有没有做清单。", "explicit_follow_up_request"],
    ["明天提醒我把清单发给同事。", "explicit_follow_up_request"],
  ])(
    "keeps an actual bounded matter with uncertain outcome: %s",
    (text, basisKind) => {
      const result = normalizeFollowUpCandidate(candidate(text));
      expect(result).toMatchObject({
        accepted: true,
        followUp: { grounding: { basisKind, sourceMessageIds: ["source"] } },
      });
      if (!result.accepted) throw new Error("Expected grounded plan");
      expect(result.followUp.expectedOutcomeDescription).not.toContain(
        "取得成功",
      );
      expect(result.followUp.expectedOutcomeDescription).toContain(
        "不预设执行或成功",
      );
    },
  );

  it("requires both speakers for a shared plan and uses the final assistant source for its own commitment", () => {
    const user = candidate("我们明天会一起检查清单。", "shared_commitment");
    expect(normalizeFollowUpCandidate(user)).toMatchObject({
      accepted: false,
      rejection: { reasonCode: "missing_shared_commitment_evidence" },
    });
    expect(
      normalizeFollowUpCandidate({
        ...user,
        supportingMessages: [
          {
            id: "assistant",
            role: "assistant",
            text: "好，我们明天会一起检查清单。",
          },
        ],
      }),
    ).toMatchObject({
      accepted: true,
      followUp: { grounding: { sourceMessageIds: ["source", "assistant"] } },
    });
    expect(
      normalizeFollowUpCandidate(
        candidate(
          "我明天会整理读书笔记。",
          "character_commitment",
          "assistant",
        ),
      ).accepted,
    ).toBe(true);
    expect(
      normalizeFollowUpCandidate(
        candidate(
          "你明天可以整理读书笔记。",
          "character_commitment",
          "assistant",
        ),
      ).accepted,
    ).toBe(false);
  });

  it.each([
    "我觉得你明天会完成清单。",
    "我想你明天会完成清单。",
    "I think you will finish the checklist tomorrow.",
  ])(
    "does not mistake a prediction about the user for a character commitment: %s",
    (text) => {
      expect(
        normalizeFollowUpCandidate(
          candidate(text, "character_commitment", "assistant"),
        ).accepted,
      ).toBe(false);
    },
  );

  it("does not let a model move the actual event date or clock", () => {
    const input = candidate("明天下午3:00有面试。");
    input.candidate.timingHint = "in 7 days";
    expect(normalizeFollowUpCandidate(input)).toMatchObject({
      accepted: true,
      followUp: { earliestAtUtc: "2026-08-22T07:00:00.000Z" },
    });
  });
});
