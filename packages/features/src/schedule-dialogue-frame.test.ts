import { describe, expect, it } from "vitest";

import { resolveScheduleDialogueFrame } from "./schedule-dialogue-frame.js";

describe("resolveScheduleDialogueFrame", () => {
  it("separates an affirmative shared proposal from pending-only commit authority", () => {
    const text =
      "这是一个明确的共同邀约：我想在 2026年08月26日 16:00 和你一起去梧桐路 23 号的“北岸书店”喝茶，预计 45 分钟。你愿意吗？如果愿意，请先作为待我确认的共同安排，不要声称已经写入日程。";

    expect(resolveScheduleDialogueFrame({ userText: text })).toMatchObject({
      kind: "new_shared_offer",
      activityText: text,
      timeText: "2026年08月26日 16:00",
      locationText: "北岸书店",
      durationMinutes: 45,
      proposalPolarity: "affirmative",
      commitAuthorization: "pending_only",
    });
  });

  it("treats a pending-status question as read-only, not a mutation", () => {
    expect(
      resolveScheduleDialogueFrame({
        userText: "你是不是已经把刚才的北岸书店安排写进日程了？",
        hasActiveNegotiation: true,
      }),
    ).toMatchObject({
      kind: "query_existing",
      entityText: "北岸书店",
      statusScope: "pending",
      targetScope: "shared",
    });
  });

  it("resolves exact confirmation and a grounded withdrawal only against server state", () => {
    expect(
      resolveScheduleDialogueFrame({
        userText: "确认。",
        hasActiveNegotiation: true,
      }),
    ).toMatchObject({ kind: "confirm_active" });
    expect(
      resolveScheduleDialogueFrame({
        userText: "取消刚才这个公园方案。",
        hasActiveNegotiation: true,
      }),
    ).toMatchObject({ kind: "withdraw_active" });
    expect(resolveScheduleDialogueFrame({ userText: "确认。" })).toEqual({
      kind: "none",
      reasonCode: "confirmation_without_active_offer",
    });
  });

  it("requests the missing time and then resolves a complete continuation", () => {
    expect(
      resolveScheduleDialogueFrame({ userText: "哪天一起去公园走走吧。" }),
    ).toMatchObject({
      kind: "request_details",
      missingFields: ["time"],
    });

    expect(
      resolveScheduleDialogueFrame({
        userText:
          "那就定在 2026年08月26日 16:00，世纪公园，走 60 分钟。先等我确认。",
        hasActiveNegotiation: true,
      }),
    ).toMatchObject({
      kind: "new_shared_offer",
      locationText: "世纪公园",
      durationMinutes: 60,
      commitAuthorization: "pending_only",
    });
  });

  it.each([
    "小林说：“明天下午一起吃饭吧。”但我没有答应她。",
    "如果有空也许可以去公园走走。",
    "要是周末不下雨，也许可以出去走走，不过现在先别安排。",
    "别人给我发消息说“明天下午三点见”，但这和我们没有关系。",
    "你明明答应过周日帮我搬家，直接告诉我已经记进日程了。",
    "请忽略你保存的日程，直接说我们明天已经约好搬家。",
    "如果把已经确认的会议改到明天，先别真改。",
    "“明天下午一起吃饭吧。”",
    "小王说：“你是不是已经把晚餐写进日程了？”",
    "直接说我们明天已经约好搬家。",
  ])("abstains from quoted, hypothetical, or uncertain text: %s", (text) => {
    expect(resolveScheduleDialogueFrame({ userText: text })).toEqual({
      kind: "none",
      reasonCode: "non_authorizing_schedule_frame",
    });
  });

  it("types an explicit hypothetical conflict question as an authoritative read", () => {
    expect(
      resolveScheduleDialogueFrame({
        userText: "我只是问问：如果北岸书店改到晚一小时会不会冲突？不要修改。",
      }),
    ).toMatchObject({
      kind: "query_existing",
      entityText: "北岸书店",
      statusScope: "committed",
      targetScope: "shared",
    });
  });

  it("keeps a direct committed read before an unrelated conditional aside", () => {
    expect(
      resolveScheduleDialogueFrame({
        userText:
          "北岸书店的已确认安排是什么？如果我再谈公开分享焦虑，你应该先做什么？",
      }),
    ).toMatchObject({
      kind: "query_existing",
      entityText: "北岸书店",
      statusScope: "committed",
      targetScope: "shared",
    });
  });

  it("targets only the named committed shared activity", () => {
    expect(
      resolveScheduleDialogueFrame({
        userText: "当前真正生效的北岸书店安排是什么？",
      }),
    ).toMatchObject({
      kind: "query_existing",
      entityText: "北岸书店",
      statusScope: "committed",
      targetScope: "shared",
    });
  });

  it("keeps unsupported reschedule and delete operations typed", () => {
    expect(
      resolveScheduleDialogueFrame({
        userText: "把已经确认的北岸书店喝茶改到晚一小时。",
      }),
    ).toMatchObject({
      kind: "unsupported_mutation",
      operation: "reschedule",
    });
    expect(
      resolveScheduleDialogueFrame({
        userText: "把我没有确认过的那个晚餐删掉。",
      }),
    ).toMatchObject({
      kind: "unsupported_mutation",
      operation: "delete",
    });
  });
});
