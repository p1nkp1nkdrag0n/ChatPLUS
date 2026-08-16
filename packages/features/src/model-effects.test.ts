import { describe, expect, it } from "vitest";

import {
  hasScheduleIntent,
  justificationIsGrounded,
  normalizeModelEffects,
  parseModelTime,
  type ModelEffectScheduleItemLike,
} from "./model-effects.js";

const NOW = "2026-08-16T06:00:00.000Z"; // 14:00 Asia/Shanghai
const TIMEZONE = "Asia/Shanghai";

const SCHEDULE: ModelEffectScheduleItemLike[] = [
  {
    id: "schedule_meal",
    title: "午餐",
    category: "meal",
    startAtUtc: "2026-08-16T05:00:00.000Z",
    endAtUtc: "2026-08-16T05:45:00.000Z",
    status: "planned",
    rigidity: "committed",
  },
  {
    id: "schedule_study",
    title: "晚间学习",
    category: "study",
    startAtUtc: "2026-08-16T10:00:00.000Z",
    endAtUtc: "2026-08-16T13:00:00.000Z",
    status: "planned",
    rigidity: "flexible",
  },
];

function normalize(
  effects: unknown[],
  userText = "今晚要不要一起去参加学校的晚会？可以把学习挪到明天。",
) {
  return normalizeModelEffects({
    effects,
    schedule: SCHEDULE,
    timezone: TIMEZONE,
    nowUtc: NOW,
    userText,
  });
}

describe("hasScheduleIntent", () => {
  it("detects invitations and reschedule wording", () => {
    expect(hasScheduleIntent("今晚要不要一起去参加晚会？")).toBe(true);
    expect(hasScheduleIntent("我们把明天的计划推迟一点吧")).toBe(true);
    expect(hasScheduleIntent("can we reschedule the study session?")).toBe(
      true,
    );
  });

  it("ignores ordinary conversation", () => {
    expect(hasScheduleIntent("今天过得怎么样？")).toBe(false);
    expect(hasScheduleIntent("我觉得这首歌很好听")).toBe(false);
  });
});

describe("justificationIsGrounded", () => {
  it("accepts verbatim and lightly paraphrased quotes", () => {
    expect(
      justificationIsGrounded(
        "今晚要不要一起去参加学校的晚会",
        "今晚要不要一起去参加学校的晚会？可以把学习挪到明天。",
      ),
    ).toBe(true);
    expect(
      justificationIsGrounded(
        "一起去参加学校的晚会吧",
        "今晚要不要一起去参加学校的晚会？",
      ),
    ).toBe(true);
  });

  it("rejects invented quotes", () => {
    expect(
      justificationIsGrounded(
        "用户要求取消本周全部安排",
        "今晚要不要一起去参加学校的晚会？",
      ),
    ).toBe(false);
    expect(
      justificationIsGrounded("", "今晚要不要一起去参加学校的晚会？"),
    ).toBe(false);
  });
});

describe("parseModelTime", () => {
  const context = { timezone: TIMEZONE, nowUtc: NOW };

  it("parses local clock times in the character timezone", () => {
    expect(parseModelTime("19:30", context)).toBe("2026-08-16T11:30:00.000Z");
    expect(parseModelTime("晚上8点", context)).toBe("2026-08-16T12:00:00.000Z");
  });

  it("rolls already-passed clock times to tomorrow", () => {
    expect(parseModelTime("09:00", context)).toBe("2026-08-17T01:00:00.000Z");
  });

  it("parses explicit day references", () => {
    expect(parseModelTime("明天 9:00", context)).toBe(
      "2026-08-17T01:00:00.000Z",
    );
    expect(parseModelTime("明天上午10:30", context)).toBe(
      "2026-08-17T02:30:00.000Z",
    );
    expect(parseModelTime("明早七点", context)).toBe(
      "2026-08-16T23:00:00.000Z",
    );
    expect(parseModelTime("明天早上七点一起跑半小时", context)).toBe(
      "2026-08-16T23:00:00.000Z",
    );
    expect(parseModelTime("后天晚上八点半", context)).toBe(
      "2026-08-18T12:30:00.000Z",
    );
    expect(parseModelTime("明天 7点半", context)).toBe(
      "2026-08-16T23:30:00.000Z",
    );
    expect(parseModelTime("明天 7点一刻", context)).toBe(
      "2026-08-16T23:15:00.000Z",
    );
    expect(parseModelTime("明天 7点三刻", context)).toBe(
      "2026-08-16T23:45:00.000Z",
    );
    expect(parseModelTime("今晚12点", context)).toBe(
      "2026-08-16T16:00:00.000Z",
    );
    expect(parseModelTime("晚上十二点半", context)).toBe(
      "2026-08-16T16:30:00.000Z",
    );
  });

  it("parses ISO timestamps and relative offsets", () => {
    expect(parseModelTime("2026-08-16T19:00:00Z", context)).toBe(
      "2026-08-16T19:00:00.000Z",
    );
    expect(parseModelTime("2026-08-16T19:00", context)).toBe(
      "2026-08-16T11:00:00.000Z",
    );
    expect(parseModelTime("2小时后", context)).toBe("2026-08-16T08:00:00.000Z");
    expect(parseModelTime("in 90 minutes", context)).toBe(
      "2026-08-16T07:30:00.000Z",
    );
  });

  it("returns undefined for garbage", () => {
    expect(parseModelTime("随便", context)).toBeUndefined();
    expect(parseModelTime(null, context)).toBeUndefined();
  });
});

describe("normalizeModelEffects", () => {
  it("accepts a grounded reschedule by title and normalizes local times", () => {
    const result = normalize([
      {
        operation: "move",
        itemTitle: "晚间学习",
        newStart: "明天 09:00",
        justificationQuote: "可以把学习挪到明天",
        reasonCode: "Accepted Invitation",
        reasonSummary: "为晚会让路，学习移到明早。",
      },
    ]);

    expect(result.rejections).toEqual([]);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      operation: "reschedule",
      itemId: "schedule_study",
      newStartAtUtc: "2026-08-17T01:00:00.000Z",
      newEndAtUtc: "2026-08-17T04:00:00.000Z",
      reasonCode: "accepted_invitation",
    });
  });

  it("accepts a grounded create with defaults for missing detail", () => {
    const result = normalize([
      {
        operation: "create",
        justificationQuote: "一起去参加学校的晚会",
        item: {
          title: "和用户参加晚会",
          category: "party!!",
          startAt: "19:00",
          durationMinutes: 180,
          priority: 82,
        },
      },
    ]);

    expect(result.rejections).toEqual([]);
    const proposal = result.accepted[0];
    expect(proposal?.operation).toBe("create");
    if (proposal?.operation !== "create") return;
    expect(proposal.item.category).toBe("social");
    expect(proposal.item.startAtUtc).toBe("2026-08-16T11:00:00.000Z");
    expect(proposal.item.endAtUtc).toBe("2026-08-16T14:00:00.000Z");
    expect(proposal.item.priority).toBe(0.82);
    expect(proposal.item.rigidity).toBe("flexible");
    expect(proposal.item.source).toBe("user_invitation");
  });

  it("rejects effects without grounded justification but keeps others", () => {
    const result = normalize([
      {
        operation: "cancel",
        itemId: "schedule_study",
        justificationQuote: "用户说不用学习了",
      },
      {
        operation: "cancel",
        itemId: "schedule_meal",
        justificationQuote: "一起去参加学校的晚会",
      },
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).toMatchObject({
      operation: "cancel",
      itemId: "schedule_meal",
    });
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.reasonCode).toBe("ungrounded_justification");
  });

  it("rejects unknown operations, unresolved items and unparseable times individually", () => {
    const result = normalize([
      {
        operation: "destroy_everything",
        justificationQuote: "一起去参加学校的晚会",
      },
      {
        operation: "cancel",
        itemId: "does-not-exist",
        justificationQuote: "一起去参加学校的晚会",
      },
      {
        operation: "reschedule",
        itemTitle: "晚间学习",
        newStart: "不知道",
        justificationQuote: "可以把学习挪到明天",
      },
    ]);

    expect(result.accepted).toEqual([]);
    expect(result.rejections.map((item) => item.reasonCode)).toEqual([
      "unknown_operation",
      "unresolved_item",
      "unparseable_time",
    ]);
  });

  it("resolves items by index when the model echoes the prompt list", () => {
    const result = normalize([
      {
        operation: "cancel",
        scheduleIndex: 1,
        justificationQuote: "可以把学习挪到明天",
      },
    ]);
    expect(result.accepted[0]).toMatchObject({
      operation: "cancel",
      itemId: "schedule_study",
    });
  });

  it("caps committed effects per turn and records the overflow", () => {
    const result = normalize([
      {
        operation: "cancel",
        itemId: "schedule_study",
        justificationQuote: "一起去参加学校的晚会",
      },
      {
        operation: "create",
        justificationQuote: "一起去参加学校的晚会",
        item: { title: "晚会", startAt: "19:00" },
      },
      {
        operation: "create",
        justificationQuote: "一起去参加学校的晚会",
        item: { title: "夜宵", startAt: "22:00" },
      },
      {
        operation: "create",
        justificationQuote: "一起去参加学校的晚会",
        item: { title: "散步", startAt: "23:00" },
      },
    ]);

    expect(result.accepted).toHaveLength(3);
    expect(result.rejections).toHaveLength(1);
    expect(result.rejections[0]?.reasonCode).toBe("too_many_effects");
  });
});
