import { describe, expect, it } from "vitest";

import { buildConversationContextPlan } from "./conversation-context-plan.js";
import { deriveReplyStrategy } from "./reply-strategy.js";

const base = { agentId: "agent_1", sessionId: "session_1", recentMessages: [] };

describe("conversation context planning", () => {
  it("distinguishes emotional why from requested help without changing legacy strategy", () => {
    const originalQuery = "为什么我总把事情搞砸，今天真难过。";
    const plan = buildConversationContextPlan({ ...base, originalQuery });
    expect(plan).toMatchObject({
      intent: "venting",
      adviceRequested: false,
      supportStyle: "listen",
      maxExplicitMemories: 0,
    });
    expect(
      deriveReplyStrategy(originalQuery, {}, { conversationPlan: plan })
        .complexity,
    ).toBe("standard");
    expect(deriveReplyStrategy(originalQuery, {}).complexity).toBe("complex");
    const help = buildConversationContextPlan({
      ...base,
      originalQuery: "请详细分析我为什么总把事情搞砸，并给我具体建议。",
    });
    expect(help).toMatchObject({
      adviceRequested: true,
      detailedAnalysisRequested: true,
      supportStyle: "offer_requested_help",
    });
    expect(
      deriveReplyStrategy(help.originalQuery, {}, { conversationPlan: help })
        .complexity,
    ).toBe("deep");
  });

  it("keeps listening requests explicit and ignores a plan for another turn", () => {
    expect(
      buildConversationContextPlan({
        ...base,
        originalQuery: "她今天详细跟我说了这件事。",
      }),
    ).toMatchObject({ intent: "sharing", detailedAnalysisRequested: false });
    const plan = buildConversationContextPlan({
      ...base,
      originalQuery: "我只是想吐槽，先听我说，不要建议。",
    });
    expect(plan.adviceRequested).toBe(false);
    expect(
      deriveReplyStrategy(
        "请详细分析这个架构。",
        {},
        { conversationPlan: plan },
      ).complexity,
    ).toBe("deep");
    expect(
      buildConversationContextPlan({
        ...base,
        originalQuery: "不要详细分析，先听我说就好。",
      }).detailedAnalysisRequested,
    ).toBe(false);
  });

  it("keeps multiple reference candidates unresolved and preserves their original source text", () => {
    const plan = buildConversationContextPlan({
      ...base,
      originalQuery: "她今天又那样了",
      recentMessages: [
        {
          ...base,
          id: "other_session",
          sessionId: "session_2",
          role: "user",
          text: "我的妈妈在住院。",
        },
        {
          ...base,
          id: "other_agent",
          agentId: "agent_2",
          role: "user",
          text: "我的老师准备退休。",
        },
        { ...base, id: "assistant", role: "assistant", text: "可能是你姐姐。" },
        { ...base, id: "sister", role: "user", text: "姐姐说她想搬家。" },
        { ...base, id: "colleague", role: "user", text: "同事今天又迟到了。" },
      ],
    });
    expect(plan.expandedQueries).toEqual([
      "姐姐说她想搬家。",
      "同事今天又迟到了。",
    ]);
    expect(plan.contextMessageIds).toEqual(["sister", "colleague"]);
    expect(plan.unresolvedReferences).toEqual(["她", "那样"]);
    expect(plan.originalQuery).toBe("她今天又那样了");
    expect(plan.adviceRequested).toBe(false);
  });

  it("uses bounded whole context messages and only expands retrospective recall to eight", () => {
    const message = {
      ...base,
      id: "long",
      role: "user" as const,
      text: "姐姐".repeat(800),
    };
    expect(
      buildConversationContextPlan({
        ...base,
        originalQuery: "她呢",
        recentMessages: [message],
      }).expandedQueries,
    ).toEqual([]);
    expect(
      buildConversationContextPlan({
        ...base,
        originalQuery: "回顾我们这些年聊过的事情和变化。",
      }).maxRecallEvidence,
    ).toBe(8);
    expect(
      buildConversationContextPlan({
        ...base,
        originalQuery: "今天吃到了好吃的面包。",
      }),
    ).toMatchObject({
      intent: "sharing",
      maxRecallEvidence: 3,
      maxExplicitMemories: 2,
    });
    expect(
      buildConversationContextPlan({
        ...base,
        originalQuery: "你最近在忙什么？",
      }).allowCharacterLifeMention,
    ).toBe(true);
  });
});
