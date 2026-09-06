import { describe, expect, it } from "vitest";

import { buildConversationContextPlan } from "./conversation-context-plan.js";
import { deriveReplyStrategy } from "./reply-strategy.js";

const base = { agentId: "agent_1", sessionId: "session_1", recentMessages: [] };

describe("conversation context planning", () => {
  it.each([
    "工作倒没有出大事，就是改了一天东西，回家以后脑子还是停不下来。",
    "都下班了，脑子还在转个不停。",
    "事情过去了，思绪却静不下来。",
  ])(
    "recognizes ongoing mental overload while keeping help authorization separate: %s",
    (originalQuery) => {
      expect(
        buildConversationContextPlan({ ...base, originalQuery }),
      ).toMatchObject({
        intent: "venting",
        adviceRequested: false,
        supportStyle: "listen",
        advicePolicy: "none_now",
        advicePolicyVersion: "advice_load_v1",
      });
      expect(
        buildConversationContextPlan({
          ...base,
          originalQuery: `${originalQuery}请帮我分析一下。`,
        }),
      ).toMatchObject({
        intent: "help",
        adviceRequested: true,
        advicePolicy: "requested",
      });
    },
  );

  it("bounds ordinary sharing without asking the user to choose a support mode", () => {
    expect(
      buildConversationContextPlan({
        ...base,
        originalQuery: "刚刚看到一朵很漂亮的云。",
      }),
    ).toMatchObject({
      adviceRequested: false,
      supportStyle: "respond_naturally",
      advicePolicy: "optional_light",
    });
  });

  it.each([
    "不用先听我说，直接给我建议。",
    "不是让你先听我说，是请你帮我分析。",
    "不要只是听我说，帮我想想办法。",
    "她说‘先听我说’，但我想请你分析一下。",
    "先听我说。不，改成直接给我建议。",
    "Don't just listen; give me advice.",
    "没必要先听我说，直接给建议。",
  ])("honors the active help request in %s", (originalQuery) => {
    expect(
      buildConversationContextPlan({ ...base, originalQuery }),
    ).toMatchObject({
      intent: "help",
      adviceRequested: true,
      supportStyle: "offer_requested_help",
    });
  });

  it("preserves ordered listening before requested analysis", () => {
    const plan = buildConversationContextPlan({
      ...base,
      originalQuery: "先让我说完，再帮我详细分析。",
    });
    expect(plan).toMatchObject({
      intent: "help",
      adviceRequested: true,
      supportStyle: "listen_then_help",
      helpTiming: "after_user_finishes",
    });
    expect(
      deriveReplyStrategy(plan.originalQuery, {}, { conversationPlan: plan })
        .complexity,
    ).toBe("standard");
  });

  it.each([
    "我不想请你分析，先听我说就好。",
    "请别给我建议，我只想吐槽。",
    "她说‘给我建议’，但我只想说说。",
    "给我建议。不过先听我说就好。",
    "I don't want advice; just listen.",
    "给我建议。不，还是先听我说就好。",
  ])("keeps negated or superseded help inactive in %s", (originalQuery) => {
    expect(
      buildConversationContextPlan({ ...base, originalQuery }),
    ).toMatchObject({
      adviceRequested: false,
      supportStyle: "listen",
    });
  });

  it("recognizes analysis deferred without repeating an imperative", () => {
    expect(
      buildConversationContextPlan({
        ...base,
        originalQuery: "先让我说完，再详细分析。",
      }),
    ).toMatchObject({
      adviceRequested: true,
      detailedAnalysisRequested: true,
      supportStyle: "listen_then_help",
      helpTiming: "after_user_finishes",
    });
  });

  it.each([
    "她说‘先听我说’。",
    "如果我说先听我说，你会怎么办？",
    "先听我说，也请帮我分析。",
  ])(
    "does not impose a strong style for quoted, conditional or conflicting requests: %s",
    (originalQuery) => {
      expect(
        buildConversationContextPlan({ ...base, originalQuery }).supportStyle,
      ).toBe("respond_naturally");
    },
  );

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

  it("separates old work retrieval candidates from the resolved movie topic", () => {
    const plan = buildConversationContextPlan({
      ...base,
      originalQuery: "她说电影很好看，我也觉得挺有意思。",
      recentMessages: [
        {
          ...base,
          id: "work",
          role: "user",
          text: "以后聊工作时，请先听我说，不要急着给建议。",
        },
        {
          ...base,
          id: "movie",
          role: "user",
          text: "换个话题，昨晚和妹妹看了一部电影。",
        },
      ],
    });
    expect(plan.expandedQueries[0]).toContain("工作");
    expect(plan).toMatchObject({
      resolvedCurrentTopic: {
        text: "她说电影很好看，我也觉得挺有意思。",
        basis: "current_message",
        sourceMessageIds: [],
      },
    });
  });
});
