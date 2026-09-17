import { describe, expect, it } from "vitest";

import {
  applyFollowUpMessageEvaluation,
  buildFollowUpDedupeKey,
  canAttemptFollowUp,
  didMentionCareCue,
  dismissCareCue,
  evaluateFollowUpMessage,
  expireCareCue,
  expireFollowUp,
  markFollowUpSent,
  normalizeFollowUpCandidate,
  isFollowUpReschedule,
  recordCareCueMention,
  resolveFollowUpWindow,
  selectRelevantCareCues,
  shouldDismissCareCue,
  type CareCueLike,
  type FollowUpLike,
} from "./follow-up.js";

const NOW_UTC = "2026-08-21T04:00:00.000Z";

function followUp(overrides: Partial<FollowUpLike> = {}): FollowUpLike {
  return {
    id: "followup-1",
    agentId: "agent-1",
    subjectType: "user_event",
    contextSummary: "\u7528\u6237\u660e\u5929\u53c2\u52a0\u7b54\u8fa9",
    expectedOutcomeDescription: "\u7b54\u8fa9\u7ed3\u679c",
    earliestAtUtc: "2026-08-22T10:00:00.000Z",
    expiresAtUtc: "2026-08-25T10:00:00.000Z",
    status: "pending",
    maxAttempts: 1,
    attemptCount: 0,
    dedupeKey: "followup:v1:defense",
    revision: 0,
    generationEpoch: 0,
    createdAtUtc: NOW_UTC,
    updatedAtUtc: NOW_UTC,
    ...overrides,
  };
}

function cue(overrides: Partial<CareCueLike> = {}): CareCueLike {
  return {
    id: "cue-1",
    contextSummary: "The user is preparing a portfolio.",
    mentionGuidance: "Ask about the portfolio only in a related context.",
    expiresAtUtc: "2026-09-01T04:00:00.000Z",
    status: "active",
    maxMentions: 1,
    mentionCount: 0,
    dedupeKey: "carecue:v1:portfolio",
    revision: 0,
    createdAtUtc: NOW_UTC,
    updatedAtUtc: NOW_UTC,
    ...overrides,
  };
}

describe("FollowUp grounding and time", () => {
  it.each(["明天下午三点", "明天十五点", "明天下午三点半"])(
    "parses Chinese numeral clocks in explicit reminders: %s",
    (text) => {
      expect(
        resolveFollowUpWindow(text, NOW_UTC, "Asia/Shanghai", "reminder")
          ?.earliestAtUtc,
      ).toBe(
        text.endsWith("半")
          ? "2026-08-22T07:30:00.000Z"
          : "2026-08-22T07:00:00.000Z",
      );
    },
  );
  it.each([
    "明天下午25:99",
    "明天下午123:00",
    "明天下午9:599",
    "明天下午二十五点",
  ])(
    "rejects invalid explicit clocks without falling back to a default: %s",
    (text) => {
      expect(
        resolveFollowUpWindow(text, NOW_UTC, "Asia/Shanghai", "reminder"),
      ).toBeUndefined();
    },
  );
  it("resolves weekdays and 明晚 without choosing quiet hours for event aftermath", () => {
    expect(
      resolveFollowUpWindow(
        "下周三下午有面试",
        NOW_UTC,
        "Asia/Shanghai",
        "event_aftermath",
      )?.earliestAtUtc,
    ).toBe("2026-08-26T10:00:00.000Z");
    expect(
      resolveFollowUpWindow(
        "next Wednesday afternoon",
        NOW_UTC,
        "Asia/Shanghai",
        "event_aftermath",
      )?.earliestAtUtc,
    ).toBe("2026-08-26T10:00:00.000Z");
    expect(
      resolveFollowUpWindow(
        "明晚有面试",
        NOW_UTC,
        "Asia/Shanghai",
        "event_aftermath",
      )?.earliestAtUtc,
    ).toBe("2026-08-23T02:00:00.000Z");
    expect(
      resolveFollowUpWindow(
        "下周有面试",
        NOW_UTC,
        "Asia/Shanghai",
        "event_aftermath",
      ),
    ).toBeUndefined();
  });

  it("separates exact reminders from event start times and gives reminders a finite useful window", () => {
    expect(
      resolveFollowUpWindow(
        "明晚九点半提醒我交材料",
        NOW_UTC,
        "Asia/Shanghai",
        "reminder",
      )?.earliestAtUtc,
    ).toBe("2026-08-22T13:30:00.000Z");
    expect(
      resolveFollowUpWindow(
        "明天25:00提醒我交材料",
        NOW_UTC,
        "Asia/Shanghai",
        "reminder",
      ),
    ).toBeUndefined();
    const reminder = resolveFollowUpWindow(
      "明晚8:00提醒我交材料",
      NOW_UTC,
      "Asia/Shanghai",
      "reminder",
    );
    expect(reminder).toEqual({
      earliestAtUtc: "2026-08-22T12:00:00.000Z",
      expiresAtUtc: "2026-08-22T14:00:00.000Z",
      currentSchedule: {
        timezone: "Asia/Shanghai",
        referenceAtUtc: NOW_UTC,
        localDate: "2026-08-22",
        precision: "minute",
        period: "evening",
        localTime: "20:00",
        atUtc: "2026-08-22T12:00:00.000Z",
      },
    });
    expect(
      resolveFollowUpWindow(
        "明天下午3点有面试",
        NOW_UTC,
        "Asia/Shanghai",
        "event_aftermath",
      )?.earliestAtUtc,
    ).toBe("2026-08-22T09:00:00.000Z");
    expect(
      resolveFollowUpWindow(
        "明天下午3点问我结果",
        NOW_UTC,
        "Asia/Shanghai",
        "appointment",
      )?.earliestAtUtc,
    ).toBe("2026-08-22T07:00:00.000Z");
  });

  it("keeps an explicit event start separate from the delayed contact window", () => {
    const window = resolveFollowUpWindow(
      "明晚九点半有面试",
      NOW_UTC,
      "Asia/Shanghai",
      "event_aftermath",
    );
    expect(window).toEqual({
      earliestAtUtc: "2026-08-23T02:00:00.000Z",
      expiresAtUtc: "2026-08-26T02:00:00.000Z",
      currentSchedule: {
        timezone: "Asia/Shanghai",
        referenceAtUtc: NOW_UTC,
        localDate: "2026-08-22",
        precision: "minute",
        period: "evening",
        localTime: "21:30",
        atUtc: "2026-08-22T13:30:00.000Z",
      },
    });
  });

  it.each([
    ["明晚有面试", { precision: "period", period: "evening" }],
    ["明天有面试", { precision: "day" }],
  ])(
    "does not invent exact event times for vague arrangements: %s",
    (text, timing) => {
      const schedule = resolveFollowUpWindow(
        text,
        NOW_UTC,
        "Asia/Shanghai",
        "event_aftermath",
      )?.currentSchedule;
      expect(schedule).toEqual({
        timezone: "Asia/Shanghai",
        referenceAtUtc: NOW_UTC,
        localDate: "2026-08-22",
        ...timing,
      });
      expect(schedule).not.toHaveProperty("atUtc");
      expect(schedule).not.toHaveProperty("localTime");
    },
  );

  it("resolves the arrangement date from the source's local day across midnight", () => {
    expect(
      resolveFollowUpWindow(
        "明天下午三点有面试",
        "2026-08-21T16:30:00.000Z",
        "Asia/Shanghai",
        "event_aftermath",
      )?.currentSchedule,
    ).toEqual({
      timezone: "Asia/Shanghai",
      referenceAtUtc: "2026-08-21T16:30:00.000Z",
      localDate: "2026-08-23",
      precision: "minute",
      period: "afternoon",
      localTime: "15:00",
      atUtc: "2026-08-23T07:00:00.000Z",
    });
  });

  it("uses an explicit requested follow-up day rather than the earlier event day", () => {
    const text = "我明天有面试，后天问我结果。";
    expect(
      normalizeFollowUpCandidate({
        candidate: {
          subjectType: "user_event",
          contextSummary: text,
          expectedOutcomeDescription: "面试结果",
          timingHint: "tomorrow",
          evidenceQuotes: [text],
          reasonCode: "request",
          reasonSummary: "request",
        },
        agentId: "agent-1",
        sourceMessage: { id: "user-1", role: "user", text },
        nowUtc: NOW_UTC,
        timezone: "Asia/Shanghai",
      }),
    ).toMatchObject({
      accepted: true,
      followUp: {
        earliestAtUtc: "2026-08-23T12:00:00.000Z",
        grounding: { timingIntent: "appointment" },
      },
    });
  });
  it("grounds a fuzzy candidate in a verbatim user quote", () => {
    const result = normalizeFollowUpCandidate({
      candidate: {
        subjectType: "user_event",
        contextSummary: "The user has a portfolio review tomorrow.",
        expectedOutcomeDescription: "How the portfolio review went.",
        timingHint: "after the event in the afternoon",
        evidenceQuotes: ["portfolio review tomorrow"],
        reasonCode: "future_user_event",
        reasonSummary: "The user stated a bounded future event.",
      },
      agentId: "agent-1",
      sourceMessage: {
        id: "message-user-1",
        role: "user",
        text: "I have a portfolio review tomorrow.",
      },
      nowUtc: NOW_UTC,
      timezone: "Asia/Shanghai",
    });

    expect(result).toMatchObject({
      accepted: true,
      followUp: {
        sourceMessageId: "message-user-1",
        earliestAtUtc: "2026-08-22T12:00:00.000Z",
        expiresAtUtc: "2026-08-25T12:00:00.000Z",
      },
    });
  });

  it("rejects ungrounded context, incompatible authorship, and exact model time", () => {
    const base = {
      subjectType: "user_event" as const,
      contextSummary: "The user has a portfolio review tomorrow.",
      expectedOutcomeDescription: "How the portfolio review went.",
      timingHint: "tomorrow afternoon",
      evidenceQuotes: ["portfolio review tomorrow"],
      reasonCode: "future_user_event",
      reasonSummary: "The user stated a bounded future event.",
    };
    const sourceMessage = {
      id: "message-user-1",
      role: "user" as const,
      text: "I have a portfolio review tomorrow.",
    };
    expect(
      normalizeFollowUpCandidate({
        candidate: {
          ...base,
          contextSummary: "The user is running a marathon.",
        },
        agentId: "agent-1",
        sourceMessage,
        nowUtc: NOW_UTC,
        timezone: "UTC",
      }),
    ).toMatchObject({
      accepted: false,
      rejection: { reasonCode: "unrelated_context" },
    });
    expect(
      normalizeFollowUpCandidate({
        candidate: {
          ...base,
          subjectType: "character_commitment",
        },
        agentId: "agent-1",
        sourceMessage,
        nowUtc: NOW_UTC,
        timezone: "UTC",
      }),
    ).toMatchObject({
      accepted: false,
      rejection: { reasonCode: "invalid_source_role" },
    });
    expect(
      normalizeFollowUpCandidate({
        candidate: {
          ...base,
          timingHint: "2026-08-22T10:00:00Z",
        },
        agentId: "agent-1",
        sourceMessage,
        nowUtc: NOW_UTC,
        timezone: "UTC",
      }),
    ).toMatchObject({
      accepted: false,
      rejection: { reasonCode: "ambiguous_timing" },
    });
    expect(
      normalizeFollowUpCandidate({
        candidate: {
          ...base,
          contextSummary: "The user has a portfolio review.",
          timingHint: "after the event",
          evidenceQuotes: ["portfolio review"],
        },
        agentId: "agent-1",
        sourceMessage: {
          ...sourceMessage,
          text: "I have a portfolio review.",
        },
        nowUtc: NOW_UTC,
        timezone: "UTC",
      }),
    ).toMatchObject({
      accepted: false,
      rejection: { reasonCode: "ambiguous_timing" },
    });
  });

  it("resolves a DST-local window and keeps a 72-hour TTL", () => {
    const window = resolveFollowUpWindow(
      "tomorrow afternoon",
      "2026-10-31T16:00:00.000Z",
      "America/New_York",
    );
    expect(window).toBeDefined();
    expect(window!.earliestAtUtc).toBe("2026-11-01T23:00:00.000Z");
    expect(
      Date.parse(window!.expiresAtUtc) - Date.parse(window!.earliestAtUtc),
    ).toBe(72 * 60 * 60 * 1_000);
  });
  it("honors an explicit local clock inside a fuzzy future-day request", () => {
    expect(
      resolveFollowUpWindow(
        "明天中午12:10能问我答辩结束了吗？",
        NOW_UTC,
        "Asia/Shanghai",
      ),
    ).toEqual({
      earliestAtUtc: "2026-08-22T04:10:00.000Z",
      expiresAtUtc: "2026-08-25T04:10:00.000Z",
      currentSchedule: {
        timezone: "Asia/Shanghai",
        referenceAtUtc: NOW_UTC,
        localDate: "2026-08-22",
        precision: "minute",
        period: "noon",
        localTime: "12:10",
        atUtc: "2026-08-22T04:10:00.000Z",
      },
    });
    expect(
      resolveFollowUpWindow("明天下午3:05提醒我", NOW_UTC, "Asia/Shanghai")
        ?.earliestAtUtc,
    ).toBe("2026-08-22T07:05:00.000Z");
  });
  it("resolves 次日 as the next local day", () => {
    expect(
      resolveFollowUpWindow("次日下午问问进展", NOW_UTC, "Asia/Shanghai"),
    ).toEqual({
      earliestAtUtc: "2026-08-22T10:00:00.000Z",
      expiresAtUtc: "2026-08-25T10:00:00.000Z",
      currentSchedule: {
        timezone: "Asia/Shanghai",
        referenceAtUtc: NOW_UTC,
        localDate: "2026-08-22",
        precision: "period",
        period: "afternoon",
      },
    });
  });

  it("uses the subject and local day in a stable dedupe key", () => {
    const base = {
      agentId: "agent-1",
      subjectType: "user_event" as const,
      earliestAtUtc: "2026-08-22T10:00:00.000Z",
      timezone: "Asia/Shanghai",
    };
    expect(
      buildFollowUpDedupeKey({
        ...base,
        contextSummary: "Portfolio   review",
      }),
    ).toBe(
      buildFollowUpDedupeKey({
        ...base,
        contextSummary: "Portfolio review",
      }),
    );
    expect(
      buildFollowUpDedupeKey({
        ...base,
        earliestAtUtc: "2026-08-23T10:00:00.000Z",
        contextSummary: "Portfolio review",
      }),
    ).not.toBe(
      buildFollowUpDedupeKey({
        ...base,
        contextSummary: "Portfolio review",
      }),
    );
  });
});

describe("FollowUp conservative lifecycle", () => {
  it.each([
    "面试可能改到下周三。",
    "面试改到下周三吗？",
    "别把面试改到下周三。",
  ])(
    "does not interpret a hypothetical or declined reschedule as an update: %s",
    (text) => {
      expect(isFollowUpReschedule(text)).toBe(false);
    },
  );
  it.each([
    "面试可能取消。",
    "如果面试通过了就好了。",
    "面试通过了吗？",
    "面试取消了吗？",
    "面试不会取消。",
    "面试没有结束。",
  ])(
    "does not close a subject on hypothetical, queried or negated outcomes: %s",
    (text) => {
      expect(
        evaluateFollowUpMessage(
          followUp({
            contextSummary: "明天有面试",
            expectedOutcomeDescription: "面试是否发生",
          }),
          text,
        ).outcome,
      ).toBe("none");
    },
  );
  it("scopes mixed clauses to the follow-up subject rather than unrelated future plans", () => {
    const interview = followUp({
      contextSummary: "我明天有面试",
      expectedOutcomeDescription: "面试结果",
    });
    expect(
      evaluateFollowUpMessage(interview, "面试通过了，明天报到。"),
    ).toMatchObject({ outcome: "resolved" });
    expect(
      evaluateFollowUpMessage(interview, "面试结果出来了，我被录取了。"),
    ).toMatchObject({ outcome: "resolved" });
    expect(
      evaluateFollowUpMessage(interview, "面试通过了，明天不去聚餐。"),
    ).toMatchObject({ outcome: "resolved" });
    expect(
      evaluateFollowUpMessage(interview, "面试还在等结果，答辩通过了。"),
    ).toMatchObject({ outcome: "none" });
    expect(
      evaluateFollowUpMessage(interview, "面试结束了，还在等结果。"),
    ).toMatchObject({ outcome: "none" });
    expect(
      evaluateFollowUpMessage(interview, "面试没有取消，还在准备。"),
    ).toMatchObject({ outcome: "none" });
    expect(
      evaluateFollowUpMessage(
        followUp({
          contextSummary: "我明天有面试",
          expectedOutcomeDescription: "面试是否发生",
        }),
        "面试结束了，还在等结果。",
      ),
    ).toMatchObject({ outcome: "resolved" });
  });

  it("requires server-bound context before accepting a deictic refusal", () => {
    expect(evaluateFollowUpMessage(followUp(), "这件事别再问了。")).toEqual({
      outcome: "none",
      reasonCode: "subject_mismatch",
    });
    expect(
      evaluateFollowUpMessage(followUp(), "这件事别再问了。", {
        contextualSubjectMatch: true,
      }),
    ).toMatchObject({
      outcome: "cancelled",
      reasonCode: "user_declined_followup",
    });
  });

  it("does not match unrelated English subjects through generic words", () => {
    expect(
      evaluateFollowUpMessage(
        followUp({
          contextSummary: "The interview is tomorrow",
          expectedOutcomeDescription: "Interview result",
        }),
        "The city race was cancelled.",
      ),
    ).toEqual({ outcome: "none", reasonCode: "subject_mismatch" });
  });
  it("resolves only an explicit outcome for the same subject", () => {
    expect(
      evaluateFollowUpMessage(
        followUp(),
        "\u7b54\u8fa9\u8fc7\u4e86\uff0c\u603b\u7b97\u7ed3\u675f\u4e86\u3002",
      ),
    ).toMatchObject({
      outcome: "resolved",
      reasonCode: "explicit_outcome",
    });
    expect(
      evaluateFollowUpMessage(
        followUp(),
        "\u7b54\u8fa9\u660e\u5929\u624d\u5f00\u59cb\u3002",
      ),
    ).toEqual({
      outcome: "none",
      reasonCode: "no_explicit_outcome",
    });
    expect(
      evaluateFollowUpMessage(followUp(), "\u9762\u8bd5\u8fc7\u4e86\u3002"),
    ).toEqual({
      outcome: "none",
      reasonCode: "subject_mismatch",
    });
  });

  it("cancels only explicit cancellation or a request not to follow up", () => {
    expect(
      evaluateFollowUpMessage(
        followUp(),
        "\u7b54\u8fa9\u53d6\u6d88\u4e86\uff0c\u4e0d\u53c2\u52a0\u4e86\u3002",
      ),
    ).toMatchObject({
      outcome: "cancelled",
      reasonCode: "explicit_cancellation",
    });
    expect(
      evaluateFollowUpMessage(
        followUp(),
        "\u522b\u518d\u95ee\u7b54\u8fa9\u4e86\u3002",
      ),
    ).toMatchObject({
      outcome: "cancelled",
      reasonCode: "user_declined_followup",
    });
  });

  it("does not cancel a reminder from unrelated test boilerplate or status words", () => {
    expect(
      evaluateFollowUpMessage(
        followUp({
          contextSummary:
            "\u3010\u865a\u6784\u6d4b\u8bd5\u573a\u666f\u3011\u660e\u5929\u628a\u4e09\u6bb5\u6d4b\u8bd5\u97f3\u9891\u7684\u68c0\u67e5\u6e05\u5355\u53d1\u7ed9\u5c0f\u5468\uff0c\u63d0\u9192\u6211\u6e05\u5355\u53d1\u51fa\u4e86\u5417\uff1f",
          expectedOutcomeDescription:
            "\u8be2\u95ee\u7528\u6237\u6240\u8ff0\u4e8b\u9879\u662f\u5426\u5df2\u7ecf\u5b8c\u6210\uff0c\u5e76\u63a5\u6536\u5176\u7ed3\u679c\u3002",
        }),
        "\u3010\u865a\u6784\u6d4b\u8bd5\u4e8b\u5b9e\uff0c\u8bf7\u8bb0\u4f4f\u3011\u6211\u4e0d\u53c2\u52a0\u5e86\u529f\u5bb4\uff1b\u4efb\u52a1\u5b8c\u6210\u540e\uff0c\u6211\u66f4\u559c\u6b22\u53bb\u5b89\u9759\u7684\u6cb3\u8fb9\u6563\u6b65\u590d\u76d8\u3002",
      ),
    ).toEqual({
      outcome: "none",
      reasonCode: "subject_mismatch",
    });
  });

  it("applies resolution evidence and never exceeds maxAttempts=1", () => {
    const evaluated = evaluateFollowUpMessage(
      followUp(),
      "\u7b54\u8fa9\u8fc7\u4e86\u3002",
    );
    const resolved = applyFollowUpMessageEvaluation(
      followUp(),
      evaluated,
      "message-user-2",
      "2026-08-22T11:00:00.000Z",
    );
    expect(resolved).toMatchObject({
      status: "resolved",
      resolutionMessageId: "message-user-2",
      revision: 1,
    });

    const sent = markFollowUpSent(
      followUp(),
      "message-proactive-1",
      "2026-08-22T11:00:00.000Z",
    );
    expect(sent).toMatchObject({
      status: "sent",
      attemptCount: 1,
      sentMessageId: "message-proactive-1",
    });
    expect(
      canAttemptFollowUp(
        { ...sent, status: "pending" },
        "2026-08-22T12:00:00.000Z",
      ),
    ).toBe(false);
    expect(
      markFollowUpSent(
        { ...sent, status: "pending" },
        "message-proactive-2",
        "2026-08-22T12:00:00.000Z",
      ),
    ).toEqual({ ...sent, status: "pending" });
  });

  it("expires only unresolved active follow-ups", () => {
    expect(
      expireFollowUp(followUp(), "2026-08-25T10:00:00.000Z"),
    ).toMatchObject({ status: "expired", revision: 1 });
    expect(
      expireFollowUp(
        followUp({
          status: "resolved",
          resolutionMessageId: "message-user-2",
        }),
        "2026-08-25T10:00:00.000Z",
      ).status,
    ).toBe("resolved");
  });
});

describe("CareCue lifecycle", () => {
  it("selects at most two relevant, live cues", () => {
    const selected = selectRelevantCareCues({
      cues: [
        cue(),
        cue({
          id: "cue-2",
          contextSummary: "The user has another portfolio deadline.",
          dedupeKey: "carecue:v1:portfolio-2",
          expiresAtUtc: "2026-08-30T04:00:00.000Z",
        }),
        cue({
          id: "cue-3",
          contextSummary: "The user is training for a marathon.",
          mentionGuidance: "Mention running only in a related context.",
          dedupeKey: "carecue:v1:running",
        }),
      ],
      userText: "I am working on the portfolio layout today.",
      nowUtc: "2026-08-22T04:00:00.000Z",
      limit: 8,
    });
    expect(selected.map((item) => item.id)).toEqual(["cue-2", "cue-1"]);
  });

  it("records an actual mention once and exhausts the cue", () => {
    const item = cue();
    expect(didMentionCareCue(item, "How is the portfolio layout going?")).toBe(
      true,
    );
    const mentioned = recordCareCueMention(
      item,
      "message-assistant-2",
      "2026-08-22T04:00:00.000Z",
    );
    expect(mentioned).toMatchObject({
      status: "exhausted",
      mentionCount: 1,
      lastMentionedMessageId: "message-assistant-2",
    });
    expect(
      recordCareCueMention(
        mentioned,
        "message-assistant-3",
        "2026-08-23T04:00:00.000Z",
      ),
    ).toEqual(mentioned);
  });

  it("dismisses only a related explicit request and otherwise expires", () => {
    const item = cue();
    expect(
      shouldDismissCareCue(item, "Please do not ask about my portfolio."),
    ).toBe(true);
    expect(shouldDismissCareCue(item, "Please do not ask about running.")).toBe(
      false,
    );
    expect(
      dismissCareCue(item, "message-user-2", "2026-08-22T04:00:00.000Z"),
    ).toMatchObject({
      status: "dismissed",
      dismissedByMessageId: "message-user-2",
    });
    expect(expireCareCue(item, "2026-09-01T04:00:00.000Z")).toMatchObject({
      status: "expired",
      revision: 1,
    });
  });
});
