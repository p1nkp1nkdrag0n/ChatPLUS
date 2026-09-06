import { describe, expect, it } from "vitest";
import {
  matchesConversationTopic,
  resolveCurrentConversationTopic,
} from "./conversation-topic.js";

describe("resolved current conversation topic", () => {
  const preference = { id: "preference", text: "以后聊工作时，请先听我说。" };

  it.each([
    "她说电影很好看，我也觉得挺有意思。",
    "换个话题，不聊工作了，昨晚电影很好看。",
    "她说‘工作还是太忙’，但这部电影很有意思。",
  ])(
    "does not authorize an old work practice from retrieval context: %s",
    (originalQuery) => {
      const topic = resolveCurrentConversationTopic({
        originalQuery,
        recentUserMessages: [preference],
      });
      expect(matchesConversationTopic("工作烦恼", topic.text)).toBe(false);
      expect(topic.basis).toBe("current_message");
      expect(topic.sourceMessageIds).toEqual([]);
    },
  );

  it("inherits a single recent work reference while retaining its source boundary", () => {
    const source = {
      id: "work_event",
      text: "回到工作，我的同事小林又临时改需求了。",
    };
    const topic = resolveCurrentConversationTopic({
      originalQuery: "她又那样了。",
      recentUserMessages: [preference, source],
    });
    expect(topic).toMatchObject({
      basis: "recent_user_continuity",
      sourceMessageIds: [source.id],
    });
    expect(matchesConversationTopic("工作烦恼", topic.text)).toBe(true);
  });

  it.each([
    [preference],
    [
      { id: "sister", text: "姐姐搬家了。" },
      { id: "colleague", text: "工作中的同事临时取消约定。" },
    ],
    [{ id: "long", text: "同事工作".repeat(400) }],
    [{ id: "quoted", text: "她说‘同事工作很忙’。" }],
  ])(
    "keeps unresolved references from activating topic practices",
    (...recentUserMessages) => {
      const topic = resolveCurrentConversationTopic({
        originalQuery: "她又那样了。",
        recentUserMessages,
      });
      expect(topic).toMatchObject({
        text: "",
        basis: "unresolved",
        sourceMessageIds: [],
      });
    },
  );

  it("honors an explicit topic switch before inheriting the latest person", () => {
    const topic = resolveCurrentConversationTopic({
      originalQuery: "她又那样了。",
      recentUserMessages: [
        preference,
        { id: "colleague", text: "工作同事临时改需求。" },
        { id: "sister", text: "换个话题，妹妹昨天看电影了。" },
      ],
    });
    expect(topic).toMatchObject({
      basis: "recent_user_continuity",
      sourceMessageIds: ["sister"],
    });
    expect(matchesConversationTopic("工作", topic.text)).toBe(false);
  });
});
