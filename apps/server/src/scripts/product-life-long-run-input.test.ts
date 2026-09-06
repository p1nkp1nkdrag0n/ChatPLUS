import { describe, expect, it } from "vitest";
import {
  appendProductLifeHistory,
  inspectProductLifeUserText,
  productLifePublicContext,
  productLifeRecallProbe,
  productLifeUserTextSchema,
  type ProductLifeHistoryMessage,
} from "./product-life-long-run-input.js";

describe("product long-run input boundaries", () => {
  const message: ProductLifeHistoryMessage = {
    sourceId: "reply-1",
    role: "assistant",
    content: "我明天打算剪片。",
    channel: "letter",
    authoredAtUtc: "2026-09-10T01:00:00.000Z",
    firstVisibleAtUtc: "2026-09-15T01:00:00.000Z",
  };
  it("preserves first visibility and authored time when a letter is reopened", () => {
    const history: ProductLifeHistoryMessage[] = [];
    appendProductLifeHistory(history, [message]);
    appendProductLifeHistory(history, [
      { ...message, firstVisibleAtUtc: "2026-10-15T01:00:00.000Z" },
    ]);
    expect(history).toEqual([message]);
    expect(
      productLifePublicContext(history, "2026-09-14T01:00:00.000Z")
        .publicHistory,
    ).toEqual([]);
    const context = productLifePublicContext(
      history,
      "2026-09-15T01:00:00.000Z",
    );
    expect(context.publicHistory[0]).toMatchObject({
      speakerName: "顾澜",
      authoredAtLocal: "2026-09-10T09:00:00.000+08:00",
      firstVisibleAtLocal: "2026-09-15T09:00:00.000+08:00",
    });
    expect(() =>
      appendProductLifeHistory(history, [
        { ...message, content: "a changed source" },
      ]),
    ).toThrow("public_history_source_changed");
  });
  it("retains recent public messages when bounded", () => {
    const context = productLifePublicContext(
      [message, { ...message, sourceId: "new", content: "新内容" }],
      "2026-09-15T01:00:00.000Z",
      3,
    );
    expect(context.publicHistory.map((item) => item.sourceId)).toEqual(["new"]);
    expect(context.omittedEarlierMessages).toBe(1);
  });
  it("keeps the visible-history prefix stable across time changes and restart serialization", () => {
    const first = productLifePublicContext(
      [message],
      "2026-09-15T01:00:00.000Z",
    );
    const restored = JSON.parse(
      JSON.stringify([message]),
    ) as ProductLifeHistoryMessage[];
    const later = productLifePublicContext(
      restored,
      "2026-09-16T01:00:00.000Z",
    );
    const text = JSON.stringify(first);
    const boundary = text.indexOf('"currentTimeUtc"');
    expect(boundary).toBeGreaterThan(text.indexOf('"publicHistory"'));
    expect(JSON.stringify(later).slice(0, boundary)).toBe(
      text.slice(0, boundary),
    );
    expect(later.currentTimeUtc).toBe("2026-09-16T01:00:00.000Z");
    expect(later.currentTimeLocal).toBe("2026-09-16T09:00:00.000+08:00");
    expect(later.publicHistory).toEqual(first.publicHistory);
    const future = {
      ...message,
      sourceId: "future",
      firstVisibleAtUtc: "2026-09-17T01:00:00.000Z",
    };
    expect(
      productLifePublicContext([...restored, future], later.currentTimeUtc)
        .publicHistory,
    ).toEqual(first.publicHistory);
  });
  it.each([
    "林舟，你回来啦。",
    "早上好。林舟，别担心。",
    "顾澜：这阵子我忙着剪片。",
  ])("rejects an explicit role swap: %s", (text) => {
    expect(inspectProductLifeUserText(text)).not.toEqual([]);
  });
  it.each([
    "我叫林舟，你可以直接叫我名字。",
    "顾澜，你最近还好吗？",
    "你说‘林舟，你可以休息’，这句我记着。",
  ])(
    "permits introductions, real addressees and inline quotations: %s",
    (text) => {
      expect(inspectProductLifeUserText(text)).toEqual([]);
    },
  );
  it("escapes user names when testing self-address", () => {
    expect(inspectProductLifeUserText("A+，你回来啦。", "A+")).not.toEqual([]);
    expect(inspectProductLifeUserText("AAA，你回来啦。", "A+")).toEqual([]);
  });
  it.each([33, 36])(
    "constrains recall turn %s to questions without supplied answers",
    (turn) => {
      const schema = productLifeUserTextSchema(turn);
      for (const text of productLifeRecallProbe(turn)!.questions)
        expect(schema.safeParse({ text }).success).toBe(true);
      expect(
        schema.safeParse({ text: "顾澜，还记得我改成周二画画了吗？" }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ text: "还记得我外包、你短片那些事吗？" }).success,
      ).toBe(false);
    },
  );
});
