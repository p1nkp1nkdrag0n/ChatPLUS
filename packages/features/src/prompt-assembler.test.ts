import { describe, expect, it } from "vitest";
import type { EvidenceBundle } from "@personasim/contracts";
import { buildConversationContextPlan } from "./conversation-context-plan.js";
import { turnExpressionPromptView } from "./turn-expression-policy.js";

import {
  assembleChatPrompt,
  type AssemblePromptInput,
  type ReplySteeringMode,
} from "./prompt-assembler.js";
import {
  DEFAULT_PROMPT_SEGMENT_IDS,
  estimatePromptTokens,
  PromptSegmentRegistryError,
} from "./prompt-segments/index.js";

const NOW = "2026-08-21T12:00:00.000Z";

const MEMORY_EVIDENCE: EvidenceBundle = {
  query: "What did I say about hiking?",
  mode: "verbatim_quote",
  generatedAtUtc: NOW,
  score: 1,
  evidence: [
    {
      memoryId: "memory-hiking",
      memoryContent: "The user enjoys hiking.",
      memoryKind: "semantic",
      namespace: "user_model",
      certainty: "explicit",
      attribution: "user_explicit",
      stability: "stable",
      evidence: {
        id: "evidence-hiking",
        memoryId: "memory-hiking",
        sourceType: "message",
        sourceId: "message-hiking",
        quote: "I enjoy hiking.",
        recordedAtUtc: NOW,
      },
      score: 1,
      scoreBreakdown: {
        lexical: 1,
        tag: 1,
        importance: 1,
        recency: 1,
        temporal: 1,
        namespace: 1,
      },
    },
  ],
};

describe("complete evidence budgets", () => {
  it("keeps complete records admitted by whole-record budget compaction in repair grounding", () => {
    const evidence = Array.from({ length: 8 }, (_, index) => {
      const memoryId = `budget-memory-${index}`;
      return {
        ...MEMORY_EVIDENCE.evidence[0]!,
        memoryId,
        memoryContent: `那是咖啡店${index}。${"当时公开的具体细节。".repeat(60)}`,
        evidence: {
          ...MEMORY_EVIDENCE.evidence[0]!.evidence,
          id: `budget-evidence-${index}`,
          memoryId,
          quote: `我说的是咖啡店${index}。${"当时公开的具体细节。".repeat(60)}`,
        },
      };
    });
    const result = assembleChatPrompt(
      baseInput({
        memoryEvidence: { ...MEMORY_EVIDENCE, evidence },
        memoryUse: {
          backgroundEvidenceIds: evidence.map((item) => item.evidence.id),
          behavioralPreferenceEvidenceIds: [],
          explicitMentionEvidenceIds: [],
          omissions: [],
        },
      }),
    );
    const admitted = promptSegmentJson(
      result.prompt,
      "RETRIEVED_EVIDENCE_JSON",
    ) as { evidence: unknown[] };
    expect(admitted.evidence.length).toBeGreaterThan(0);
    expect(admitted.evidence.length).toBeLessThan(8);
    expect(
      result.segmentTrace.segments.find(
        (item) => item.id === "13_retrieved_evidence",
      )?.truncated,
    ).toBe(true);
    expect(
      promptSegmentJson(result.replyGrounding, "RETRIEVED_EVIDENCE_JSON"),
    ).toEqual(admitted);
  });
  it("shares corrected current values with repairs while retaining the original correction only in audit", () => {
    const original: EvidenceBundle = {
      ...MEMORY_EVIDENCE,
      query: "同事叫什么？",
      factCoverage: [{ entity: "同事", attribute: "name", covered: true }],
      evidence: [
        {
          ...MEMORY_EVIDENCE.evidence[0]!,
          memoryContent: "用户的同事姓名：林桥。",
          currentFact: { entity: "同事", attribute: "name", value: "林桥" },
          evidence: {
            ...MEMORY_EVIDENCE.evidence[0]!.evidence,
            quote: "同事叫林桥，不是林乔。",
            contextSummary: "旧名字林乔已被纠正。",
          },
        },
      ],
    };
    const result = assembleChatPrompt(
      baseInput({ userMessage: original.query, memoryEvidence: original }),
    );
    expect(result.prompt).toContain("林桥");
    expect(result.prompt).not.toContain("林乔");
    expect(result.replyGrounding).toContain("林桥");
    expect(result.replyGrounding).not.toContain("林乔");
    expect(result.replyGrounding).toContain('"sourceId":"message-hiking"');
    expect(original.evidence[0]?.evidence.quote).toContain("不是林乔");
  });
  it.each([undefined, 3_000, 4_000, 8_000])(
    "keeps use permissions with evidence at %s tokens",
    (budget) => {
      const item = MEMORY_EVIDENCE.evidence[0]!;
      const result = assembleChatPrompt(
        baseInput({
          memoryEvidence: MEMORY_EVIDENCE,
          memoryUse: {
            backgroundEvidenceIds: [item.evidence.id],
            behavioralPreferenceEvidenceIds: [],
            explicitMentionEvidenceIds: [],
            omissions: [],
          },
          ...(budget === undefined ? {} : { maxInputTokens: budget }),
        }),
      );
      const lines = result.prompt.split("\n");
      const index = lines.indexOf("RETRIEVED_EVIDENCE_JSON");
      if (index >= 0) {
        const payload = JSON.parse(lines[index + 1]!) as {
          evidence: { allowedUses: string[]; memoryContent: string }[];
        };
        for (const evidence of payload.evidence) {
          expect(evidence.allowedUses).toEqual(["background"]);
          expect(evidence.memoryContent).toBe(item.memoryContent);
        }
      }
      const reference = lines.indexOf("REFERENCE_CONTEXT_JSON");
      if (reference >= 0)
        expect(JSON.parse(lines[reference + 1]!)).not.toHaveProperty(
          "memoryEvidence",
        );
    },
  );

  it("does not render excluded evidence or unrelated initial goals in ordinary sharing", () => {
    const original = baseInput({ memoryEvidence: MEMORY_EVIDENCE });
    const userMessage = "今天路上看到一只小猫，挺开心。";
    const result = assembleChatPrompt({
      ...original,
      userMessage,
      conversationPlan: buildConversationContextPlan({
        originalQuery: userMessage,
        agentId: "agent-test",
        sessionId: "session-test",
        recentMessages: [],
      }),
      memoryUse: {
        backgroundEvidenceIds: [],
        behavioralPreferenceEvidenceIds: [],
        explicitMentionEvidenceIds: [],
        omissions: [],
      },
    });
    expect(result.prompt).not.toContain("The user enjoys hiking.");
    expect(promptSegmentJson(result.system, "CORE_PERSONA_JSON")).toMatchObject(
      { goals: [] },
    );
    expect(
      promptSegmentJson(result.system, "VALUES_CONFLICTS_JSON"),
    ).toMatchObject({ contradictions: [] });
    expect(original.character.persona.goals.length).toBeGreaterThan(0);
  });
  it.each([undefined, 4_000, 8_000])(
    "keeps late qualifications intact at %s tokens",
    (budget) => {
      const quote =
        "我原来以为她已经答应了。".repeat(100) +
        "后来才发现没有，这只是我的猜想。";
      const item = {
        ...MEMORY_EVIDENCE.evidence[0]!,
        memoryContent: quote,
        evidence: {
          ...MEMORY_EVIDENCE.evidence[0]!.evidence,
          quote,
          contextSummary: quote,
        },
      };
      const result = assembleChatPrompt(
        baseInput({
          memoryEvidence: { ...MEMORY_EVIDENCE, evidence: [item] },
          ...(budget === undefined ? {} : { maxInputTokens: budget }),
        }),
      );
      const lines = result.prompt.split("\n");
      for (const label of [
        "RETRIEVED_EVIDENCE_JSON",
        "REFERENCE_CONTEXT_JSON",
      ]) {
        const index = lines.indexOf(label);
        if (index < 0) continue;
        const payload = JSON.parse(lines[index + 1]!) as {
          evidence?: EvidenceBundle["evidence"];
          memoryEvidence?: EvidenceBundle;
        };
        const evidence =
          payload.evidence ?? payload.memoryEvidence?.evidence ?? [];
        for (const retained of evidence) {
          expect(retained.memoryContent).toBe(quote);
          expect(retained.evidence.quote).toBe(quote);
          expect(retained.evidence.contextSummary).toBe(quote);
        }
      }
    },
  );

  it("retains the complete accepted current message, including its final denial", () => {
    const userMessage =
      "这只是一个设想。".repeat(2_000) + "不要执行，我没有同意。";
    const result = assembleChatPrompt(baseInput({ userMessage }));
    const lines = result.prompt.split("\n");
    expect(
      (
        JSON.parse(lines[lines.indexOf("CURRENT_USER_MESSAGE_JSON") + 1]!) as {
          content: string;
        }
      ).content,
    ).toBe(userMessage);
  });
});

function baseInput(
  overrides: Partial<AssemblePromptInput> = {},
): AssemblePromptInput {
  const input: AssemblePromptInput = {
    character: {
      id: "agent-private-id",
      tier: "high_fidelity",
      sourceType: "structured",
      identity: {
        name: "Lin",
        workOrRole: "student",
        worldSetting: "a contemporary city",
        selfDescription: "steady and observant",
        timezone: "Asia/Shanghai",
      },
      persona: {
        traits: ["steady"],
        values: ["honesty"],
        contradictions: ["independent but caring"],
        goals: ["finish the term well"],
        preferences: ["quiet walks"],
        boundaries: ["do not invent completed actions"],
      },
      dialogue: {
        register: "warm and concise",
        vocabulary: "everyday",
        avoidedPhrases: ["as an AI"],
      },
      userRelationship: { relationshipType: "friend" },
      routines: [],
      schedulePolicy: {},
      proactivePolicy: {},
      knowledge: {
        knownFacts: ["The term ends in June."],
        uncertainFacts: [],
        forbiddenMetaKnowledge: [],
      },
      sources: [{ excerpt: "A short allowed source excerpt." }],
    },
    state: {
      agentId: "agent-private-id",
      asOfUtc: NOW,
      moodValence: 0.1,
      moodArousal: 0.4,
      energy: 0.6,
      stress: 0.2,
      socialBattery: 0.7,
      focus: 0.8,
      relationship: {
        userId: "user-private-id",
        closeness: 0.6,
        trust: 0.7,
        familiarity: 0.5,
        recentInteractionValence: 0.2,
      },
      revision: 1,
    },
    schedule: [],
    memories: [],
    recentMessages: [],
    nowUtc: NOW,
    userMessage: "How was your day?",
  };
  return { ...input, ...overrides };
}

function promptSegmentJson(prompt: string, label: string): unknown {
  const lines = prompt.split("\n");
  const index = lines.indexOf(label);
  if (index < 0) {
    throw new Error(`Missing prompt segment ${label}`);
  }
  const serialized = lines[index + 1];
  if (serialized === undefined) {
    throw new Error(`Missing prompt payload for ${label}`);
  }
  return JSON.parse(serialized) as unknown;
}

describe("one admitted conversation history", () => {
  const current = "好呀很高兴与你聊天";
  function planFor(text: string) {
    return buildConversationContextPlan({
      originalQuery: current,
      agentId: "agent-private-id",
      sessionId: "history-test",
      recentMessages: [
        {
          id: "history-source",
          agentId: "agent-private-id",
          sessionId: "history-test",
          role: "user",
          text,
        },
      ],
      protectedPhrases: ["作者指定的表达"],
    });
  }

  it("uses the selected history once without restoring a different planner view", () => {
    const selected = "选入原文：刚来学校时我有些不安。";
    const excluded = "计划旧视图：未经本轮选择的旧消息。";
    const plan = planFor(excluded);
    const before = structuredClone(plan);
    const result = assembleChatPrompt(
      baseInput({
        userMessage: current,
        conversationPlan: plan,
        recentMessages: [{ role: "user", content: selected }],
      }),
    );
    for (const prompt of [result.prompt, result.replyGrounding]) {
      expect(prompt.split(selected)).toHaveLength(2);
      expect(prompt).not.toContain(excluded);
    }
    const strategy = promptSegmentJson(
      result.prompt,
      "REPLY_STRATEGY_JSON",
    ) as {
      expression: ReturnType<typeof turnExpressionPromptView>;
    };
    expect(strategy.expression.recentExpression).toMatchObject({
      protectedPhrases: ["作者指定的表达"],
      repeatedOpenings: [],
    });
    expect(strategy.expression.recentExpression).not.toHaveProperty(
      "recentDialogue",
    );
    expect(plan).toEqual(before);
  });

  it("honors an explicitly empty history window even when the planner retains it", () => {
    const previous = "已关闭历史窗口的原文不能通过表达策略重新出现。";
    const result = assembleChatPrompt(
      baseInput({
        userMessage: current,
        conversationPlan: planFor(previous),
        recentMessages: [{ role: "user", content: previous }],
        maxRecentMessages: 0,
      }),
    );
    expect(result.prompt).not.toContain(previous);
    expect(result.replyGrounding).not.toContain(previous);
  });

  it("does not restore budget-omitted history inside required expression controls", () => {
    const previous = "历史预算标记。" + "一段完整的旧对话。".repeat(100);
    const input = baseInput({
      userMessage: current,
      conversationPlan: planFor(previous),
      recentMessages: [{ role: "user", content: previous }],
    });
    const full = assembleChatPrompt(input);
    expect(full.prompt).toContain(previous);
    const budget = full.segmentTrace.segments
      .filter((segment) => segment.required)
      .reduce((total, segment) => total + segment.estimatedTokens + 1, 100);
    const constrained = assembleChatPrompt({
      ...input,
      maxInputTokens: budget,
    });
    expect(constrained.prompt).not.toContain("历史预算标记");
    expect(constrained.replyGrounding).not.toContain("历史预算标记");
    expect(constrained.segmentTrace.estimatedInputTokens).toBeLessThanOrEqual(
      budget,
    );
    expect(
      promptSegmentJson(constrained.prompt, "REPLY_STRATEGY_JSON"),
    ).toEqual(promptSegmentJson(full.prompt, "REPLY_STRATEGY_JSON"));
  });

  it("shares whole admitted messages with repairs after history compaction", () => {
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: "user" as const,
      content: `完整消息${index}。${"过去的一段具体对话。".repeat(100)}`,
    }));
    const result = assembleChatPrompt(
      baseInput({
        userMessage: current,
        conversationPlan: planFor(history[0]!.content),
        recentMessages: history,
      }),
    );
    const admitted = promptSegmentJson(
      result.prompt,
      "RECENT_VERBATIM_JSON",
    ) as typeof history;
    expect(admitted.length).toBeGreaterThan(0);
    expect(admitted.length).toBeLessThan(history.length);
    expect(admitted).toEqual(history.slice(-admitted.length));
    expect(
      promptSegmentJson(result.replyGrounding, "RECENT_VERBATIM_JSON"),
    ).toEqual(admitted);
    expect(result.prompt).not.toContain(history[0]!.content);
  });

  it("keeps the admitted story-time projection in generation and repair history", () => {
    const previous = "书店门前刚才下了一阵雨。";
    const input = baseInput({
      userMessage: current,
      conversationPlan: planFor(previous),
      recentMessages: [{ role: "user", content: previous, createdAtUtc: NOW }],
    });
    input.character.identity.temporalFrame = {
      mode: "anchored_story",
      eraLabel: "1951年",
      storyAnchorLocalDate: "1951-09-01",
      systemAnchorUtc: NOW,
      anchorPrecision: "day",
    };
    const result = assembleChatPrompt(input);
    for (const prompt of [result.prompt, result.replyGrounding]) {
      const history = promptSegmentJson(
        prompt,
        "RECENT_VERBATIM_JSON",
      ) as Array<Record<string, unknown>>;
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        role: "user",
        content: previous,
      });
      expect(history[0]?.createdAtCharacterLocal).toEqual(
        expect.stringContaining("1951-09-01"),
      );
      expect(history[0]).not.toHaveProperty("createdAtUtc");
      expect(prompt.split(previous)).toHaveLength(2);
    }
  });
});

describe("complete turn-control delivery", () => {
  it("reuses only complete admitted grounding in repairs", () => {
    const result = assembleChatPrompt(
      baseInput({
        userMessage: "那家店怎么样？",
        recentMessages: [{ role: "user", content: "是咖啡店，灯光很舒服。" }],
      }),
    );
    expect(result.replyGrounding).toContain("咖啡店");
    expect(result.replyGrounding).toContain("RECENT_VERBATIM_JSON");
    expect(result.replyGrounding).not.toContain("OUTPUT_CONTRACT_JSON");
    expect(result.replyGrounding).not.toContain("REPLY_STRATEGY_JSON");
  });
  it.each([
    "只是抱怨一下今天又改了方案，不用解决。",
    "朋友说‘别再问我’，那是他对别人说的，不是在替我提要求。",
    "请帮我分析一下，是哪里出了错，还有什么需要核对？",
  ])("delivers the complete frozen guidance for %s", (userMessage) => {
    const conversationPlan = buildConversationContextPlan({
      originalQuery: userMessage,
      agentId: "agent-test",
      sessionId: "session-test",
      recentMessages: [],
      protectedPhrases: Array.from({ length: 24 }, (_, i) => `作者用语 ${i}`),
    });
    const before = structuredClone(conversationPlan);
    const result = assembleChatPrompt(
      baseInput({ userMessage, conversationPlan }),
    );
    const strategy = promptSegmentJson(
      result.prompt,
      "REPLY_STRATEGY_JSON",
    ) as {
      expression: ReturnType<typeof turnExpressionPromptView>;
      guidance: string;
    };
    expect(strategy.expression).toEqual(
      turnExpressionPromptView(before, [], { includeRecentDialogue: false }),
    );
    expect(strategy.expression.questionGuidance).toContain(
      "For a closed vent, do not announce that you are following a listening policy",
    );
    expect(strategy.expression.expressionGuidance).toContain(
      "psychological traits or abilities",
    );
    expect(strategy.expression.analysisGuidance).toContain(
      "Do not redefine an actual mistake as requiring irreversible harm",
    );
    expect(strategy.guidance).toContain(
      "do not collapse the ordered request into advice now or indefinite listening",
    );
    expect(
      result.segmentTrace.segments.find((s) => s.id === "15_reply_strategy"),
    ).toMatchObject({ included: true, truncated: false });
    expect(result.messages[1]!.content).toBe(result.prompt);
    expect(conversationPlan).toEqual(before);
  });

  it("keeps turn controls complete while optional context competes for a fixed total budget", () => {
    const userMessage = "先让我说完，再帮我详细分析。";
    const conversationPlan = buildConversationContextPlan({
      originalQuery: userMessage,
      agentId: "agent-test",
      sessionId: "session-test",
      recentMessages: [],
    });
    const input = baseInput({ userMessage, conversationPlan });
    const unconstrained = assembleChatPrompt(input);
    const maximumTokens = unconstrained.segmentTrace.segments
      .filter((segment) => segment.required)
      .reduce((total, segment) => total + segment.estimatedTokens + 1, 100);
    const constrained = assembleChatPrompt({
      ...input,
      maxInputTokens: maximumTokens,
      recentMessages: Array.from({ length: 30 }, (_, i) => ({
        role: "assistant" as const,
        content: `历史 ${i}。${"这是一段较长的历史对话。".repeat(80)}`,
      })),
    });
    expect(
      (
        promptSegmentJson(constrained.prompt, "REPLY_STRATEGY_JSON") as {
          expression: unknown;
          helpTiming: unknown;
        }
      ).expression,
    ).toEqual(
      turnExpressionPromptView(conversationPlan, [], {
        includeRecentDialogue: false,
      }),
    );
    expect(
      promptSegmentJson(constrained.prompt, "REPLY_STRATEGY_JSON"),
    ).toMatchObject({ helpTiming: "after_user_finishes" });
    expect(constrained.segmentTrace.estimatedInputTokens).toBeLessThanOrEqual(
      maximumTokens,
    );
    expect(
      constrained.segmentTrace.segments.some(
        (segment) =>
          !segment.required &&
          (segment.truncated || segment.reason === "global_budget"),
      ),
    ).toBe(true);
  });

  it("rejects insufficient total space rather than sending a clipped turn instruction", () => {
    const userMessage = "只是吐槽一句，不用解决。";
    const conversationPlan = buildConversationContextPlan({
      originalQuery: userMessage,
      agentId: "agent-test",
      sessionId: "session-test",
      recentMessages: [],
    });
    expect(() =>
      assembleChatPrompt(
        baseInput({
          userMessage,
          conversationPlan,
          maxInputTokens: 512,
        }),
      ),
    ).toThrow(PromptSegmentRegistryError);
  });
});

describe("reply length steering ablation", () => {
  const removedFields = [
    "softTargetCharacters",
    "preferredChunkCount",
    "deliveryPreference",
    "lengthGuidance",
    "deliveryGuidance",
  ];

  function withoutLengthSteering(value: unknown, fields = removedFields) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter(
        ([key]) => !fields.includes(key),
      ),
    );
  }

  function expectOnlySteeringRemoved(
    input: AssemblePromptInput,
    mode: ReplySteeringMode = "no_length_steering",
    fields = removedFields,
  ) {
    const current = assembleChatPrompt(input);
    const experimental = assembleChatPrompt({
      ...input,
      replySteeringMode: mode,
    });
    const currentStrategy = promptSegmentJson(
      current.prompt,
      "REPLY_STRATEGY_JSON",
    );
    const expectedStrategy = withoutLengthSteering(currentStrategy, fields);
    // Compare every final byte outside the one JSON payload, including
    // compacted required context, optional context and the output protocol.
    expect(experimental.prompt).toBe(
      current.prompt.replace(
        "REPLY_STRATEGY_JSON\n" + JSON.stringify(currentStrategy),
        "REPLY_STRATEGY_JSON\n" + JSON.stringify(expectedStrategy),
      ),
    );
    expect(experimental.system).toBe(current.system);
    expect(experimental.replyGrounding).toBe(current.replyGrounding);
    expect(experimental.replyStrategy).toEqual(current.replyStrategy);
    expect(experimental.messages).toEqual([
      { role: "system", content: experimental.system },
      { role: "user", content: experimental.prompt },
    ]);
    expect(
      experimental.segmentTrace.segments.filter(
        (segment) => segment.id !== "15_reply_strategy",
      ),
    ).toEqual(
      current.segmentTrace.segments.filter(
        (segment) => segment.id !== "15_reply_strategy",
      ),
    );
    expect(experimental.segmentTrace.droppedSegmentIds).toEqual(
      current.segmentTrace.droppedSegmentIds,
    );
    const strategyTrace = current.segmentTrace.segments.find(
      (segment) => segment.id === "15_reply_strategy",
    )!;
    const renderedStrategy =
      "REPLY_STRATEGY_JSON\n" + JSON.stringify(expectedStrategy);
    expect(
      experimental.segmentTrace.segments.find(
        (segment) => segment.id === "15_reply_strategy",
      ),
    ).toEqual({
      ...strategyTrace,
      estimatedTokens: estimatePromptTokens(renderedStrategy),
      renderedCharacters: renderedStrategy.length,
    });
    expect(strategyTrace).toMatchObject({ included: true, required: true });
    expect(experimental.segmentTrace.estimatedInputTokens).toBe(
      estimatePromptTokens(experimental.system) +
        estimatePromptTokens(experimental.prompt),
    );
    return { current, experimental };
  }

  it.each([undefined, 512, 3_000])(
    "keeps omitted mode identical to explicit current at %s tokens",
    (maxInputTokens) => {
      const input = baseInput({
        ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
      });
      expect(assembleChatPrompt(input)).toEqual(
        assembleChatPrompt({ ...input, replySteeringMode: "current" }),
      );
    },
  );

  it("removes exactly five model-visible fields and retains derived strategy", () => {
    const { current, experimental } = expectOnlySteeringRemoved(baseInput());
    const original = promptSegmentJson(
      current.prompt,
      "REPLY_STRATEGY_JSON",
    ) as Record<string, unknown>;
    const strategy = promptSegmentJson(
      experimental.prompt,
      "REPLY_STRATEGY_JSON",
    ) as Record<string, unknown>;
    expect(Object.keys(original).filter((key) => !(key in strategy))).toEqual(
      removedFields,
    );
    expect(strategy).toEqual({
      complexity: original.complexity,
      stateGuidance: original.stateGuidance,
    });
    expect(current.replyStrategy.targetChars).toBeGreaterThan(0);
    expect(experimental.segmentTrace.estimatedInputTokens).toBeLessThan(
      current.segmentTrace.estimatedInputTokens,
    );
  });

  it.each([
    ["no_length_only_steering", ["softTargetCharacters", "lengthGuidance"]],
    ["no_chunk_count_steering", ["preferredChunkCount"]],
    ["no_delivery_steering", ["deliveryPreference", "deliveryGuidance"]],
  ] as const)(
    "isolates %s without changing other controls or admission",
    (mode, fields) => {
      const userMessage = "先让我说完，再帮我详细分析。";
      const conversationPlan = buildConversationContextPlan({
        originalQuery: userMessage,
        agentId: "agent-test",
        sessionId: "session-test",
        recentMessages: [],
      });
      const input = baseInput({
        userMessage,
        conversationPlan,
        memoryEvidence: MEMORY_EVIDENCE,
      });
      const full = assembleChatPrompt(input);
      const tightBudget = full.segmentTrace.segments
        .filter((segment) => segment.required)
        .reduce((total, segment) => total + segment.estimatedTokens + 1, 30);
      for (const maxInputTokens of [undefined, tightBudget]) {
        const { experimental } = expectOnlySteeringRemoved(
          {
            ...input,
            ...(maxInputTokens === undefined ? {} : { maxInputTokens }),
          },
          mode,
          [...fields],
        );
        const strategy = promptSegmentJson(
          experimental.prompt,
          "REPLY_STRATEGY_JSON",
        ) as Record<string, unknown>;
        expect(strategy.helpTiming).toBe("after_user_finishes");
        for (const field of removedFields) {
          expect(Object.hasOwn(strategy, field)).toBe(
            !(fields as readonly string[]).includes(field),
          );
        }
      }
    },
  );

  it.each([512, 1_000, 3_000])(
    "preserves final admission and compaction at a tight %s-token budget",
    (maxInputTokens) => {
      const { current, experimental } = expectOnlySteeringRemoved(
        baseInput({
          maxInputTokens,
          memoryEvidence: MEMORY_EVIDENCE,
          recentMessages: Array.from({ length: 30 }, (_, index) => ({
            role: "assistant" as const,
            content: `历史 ${index}。${"这是一段较长的历史对话。".repeat(80)}`,
          })),
        }),
      );
      expect(
        current.segmentTrace.segments.some(
          (segment) => segment.truncated || segment.reason === "global_budget",
        ),
      ).toBe(true);
      expect(
        experimental.segmentTrace.estimatedInputTokens,
      ).toBeLessThanOrEqual(maxInputTokens);
    },
  );

  it.each([
    "reply_only",
    "legacy_effects",
    "schedule_negotiation",
    "schedule_negotiation_shadow",
  ] as const)(
    "preserves complete controls and output protocol under pressure (%s)",
    (decisionMode) => {
      const userMessage = "先让我说完，再帮我详细分析。";
      const conversationPlan = buildConversationContextPlan({
        originalQuery: userMessage,
        agentId: "agent-test",
        sessionId: "session-test",
        recentMessages: [],
      });
      const input = baseInput({ userMessage, conversationPlan, decisionMode });
      const unconstrained = assembleChatPrompt(input);
      const maxInputTokens = unconstrained.segmentTrace.segments
        .filter((segment) => segment.required)
        .reduce((total, segment) => total + segment.estimatedTokens + 1, 30);
      const { current, experimental } = expectOnlySteeringRemoved({
        ...input,
        maxInputTokens,
      });
      expect(
        promptSegmentJson(experimental.prompt, "REPLY_STRATEGY_JSON"),
      ).toMatchObject({
        helpTiming: "after_user_finishes",
        expression: turnExpressionPromptView(conversationPlan, [], {
          includeRecentDialogue: false,
        }),
      });
      expect(
        current.segmentTrace.segments.some(
          (segment) => !segment.required && segment.reason === "global_budget",
        ),
      ).toBe(true);
      expect(() =>
        assembleChatPrompt({
          ...input,
          maxInputTokens: 512,
          replySteeringMode: "no_length_steering",
        }),
      ).toThrow(PromptSegmentRegistryError);
    },
  );

  it("does not target a matching label in another segment", () => {
    const input = baseInput({
      additionalPromptSegments: [
        {
          id: "14a_ablation_probe",
          placement: "prompt",
          renderOrder: -2,
          priority: -100,
          tokenBudget: 1_000,
          required: false,
          cacheable: false,
          globalOverflowPolicy: "drop",
          render: () =>
            'REPLY_STRATEGY_JSON\n{"lengthGuidance":"Unrelated segment, keep verbatim."}',
        },
      ],
    });
    const experimental = assembleChatPrompt({
      ...input,
      replySteeringMode: "no_length_steering",
    });
    expect(experimental.prompt).toContain(
      'REPLY_STRATEGY_JSON\n{"lengthGuidance":"Unrelated segment, keep verbatim."}',
    );
    expect(experimental.prompt).not.toContain('"softTargetCharacters"');
  });

  it("does not reinvest saved steering space in excluded optional context", () => {
    const input = baseInput({
      conversationPlan: buildConversationContextPlan({
        originalQuery: "How was your day?",
        agentId: "agent-test",
        sessionId: "session-test",
        recentMessages: [],
      }),
      additionalPromptSegments: [
        {
          id: "14a_ablation_probe",
          placement: "prompt",
          priority: -100,
          tokenBudget: 1_000,
          required: false,
          cacheable: false,
          globalOverflowPolicy: "drop",
          render: () => "ABLATION_PROBE\n" + "Optional context. ".repeat(8),
        },
      ],
    });
    const current = assembleChatPrompt(input);
    const probe = current.segmentTrace.segments.find(
      (segment) => segment.id === "14a_ablation_probe",
    )!;
    const maxInputTokens = current.segmentTrace.segments
      .filter((segment) => segment.required)
      .reduce((total, segment) => total + segment.estimatedTokens + 1, 0);
    const constrained = expectOnlySteeringRemoved({ ...input, maxInputTokens });
    expect(constrained.experimental.segmentTrace.droppedSegmentIds).toContain(
      probe.id,
    );
    expect(
      maxInputTokens -
        constrained.experimental.segmentTrace.estimatedInputTokens,
    ).toBeGreaterThan(probe.estimatedTokens);
  });
});

describe("assembleChatPrompt registry integration", () => {
  it.each(["reply_only", "schedule_negotiation", "legacy_effects"] as const)(
    "keeps the system stable when authoritative memory evidence appears and disappears (%s)",
    (decisionMode) => {
      const input = baseInput({ decisionMode });
      const before = assembleChatPrompt(input);
      const withMemory = assembleChatPrompt({
        ...input,
        memoryEvidence: MEMORY_EVIDENCE,
      });
      const after = assembleChatPrompt(input);

      expect(withMemory.system).toBe(before.system);
      expect(after.system).toBe(before.system);
      expect(before.system).toContain(
        "When memoryEvidence is present, it is the sole authoritative long-term memory context",
      );
      expect(before.system).toContain(
        "do not treat relevantMemories or runtime context as evidence",
      );
      expect(withMemory.prompt).toContain('"sourceId":"message-hiking"');
      expect(withMemory.prompt).toContain('"quote":"I enjoy hiking."');
      expect(withMemory.prompt).toContain('"relevantMemories":[]');
      expect(before.prompt).not.toContain("RETRIEVED_EVIDENCE_JSON");
      expect(after.prompt).not.toContain("message-hiking");
      expect(
        after.segmentTrace.segments.every(
          (segment) => segment.localCacheHit === false,
        ),
      ).toBe(true);
    },
  );

  it("retains historical provenance before fresh per-turn context without promoting history authority", () => {
    const history = [
      {
        role: "user" as const,
        content: "I enjoy hiking.",
        createdAtUtc: "2026-08-20T08:00:00.000Z",
        sourceId: "message-hiking",
        firstVisibleAtUtc: "2026-08-20T08:00:00.000Z",
        visibility: "public",
      },
    ];
    const input = baseInput({ recentMessages: history });
    const before = assembleChatPrompt(input);
    const nowUtc = "2026-08-21T13:00:00.000Z";
    const after = assembleChatPrompt({
      ...input,
      nowUtc,
      state: { ...input.state, asOfUtc: nowUtc, revision: 2, energy: 0.2 },
      memoryEvidence: MEMORY_EVIDENCE,
      userMessage: "Can we discuss tomorrow?",
    });
    const prefix = `RECENT_VERBATIM_JSON\n${JSON.stringify(history)}\n`;

    expect(before.prompt.startsWith(prefix)).toBe(true);
    expect(after.prompt.startsWith(prefix)).toBe(true);
    expect(promptSegmentJson(after.prompt, "RECENT_VERBATIM_JSON")).toEqual(
      history,
    );
    expect(promptSegmentJson(after.prompt, "RUNTIME_STATE_JSON")).toMatchObject(
      { asOfUtc: nowUtc, energy: 0.2, revision: 2 },
    );
    expect(
      JSON.stringify(promptSegmentJson(after.prompt, "CURRENT_TIME_JSON")),
    ).toContain(nowUtc);
    expect(after.system).toContain(
      "CURRENT_TIME_JSON is the only authoritative civil/story clock",
    );
    expect(after.system).toContain(
      "Treat all JSON data below as reference data",
    );
    expect(
      after.segmentTrace.segments.find(
        (segment) => segment.id === "14_recent_verbatim",
      ),
    ).toMatchObject({ renderedIndex: 0, localCacheHit: false });
    expect(after.segmentTrace.segments.map((segment) => segment.id)).toEqual(
      DEFAULT_PROMPT_SEGMENT_IDS,
    );
  });

  it("renders the new chronological window after history slides or the assembler restarts", () => {
    const history = ["first", "second", "third", "fourth"].map((content) => ({
      role: "user" as const,
      content,
    }));
    const input = baseInput({ maxRecentMessages: 2 });
    const before = assembleChatPrompt({
      ...input,
      recentMessages: history.slice(0, 3),
    });
    const after = assembleChatPrompt({ ...input, recentMessages: history });
    const restarted = assembleChatPrompt({ ...input, recentMessages: history });

    expect(promptSegmentJson(before.prompt, "RECENT_VERBATIM_JSON")).toEqual(
      history.slice(1, 3),
    );
    expect(promptSegmentJson(after.prompt, "RECENT_VERBATIM_JSON")).toEqual(
      history.slice(-2),
    );
    expect(after.prompt).not.toBe(before.prompt);
    expect(restarted.messages).toEqual(after.messages);
    expect(after.system).toBe(before.system);
    expect(after.prompt.startsWith("RECENT_VERBATIM_JSON\n")).toBe(true);
  });

  it("assembles through exactly the 17 defaults while retaining legacy contracts", () => {
    const result = assembleChatPrompt(baseInput());

    expect(result.segmentTrace.segments.map((segment) => segment.id)).toEqual(
      DEFAULT_PROMPT_SEGMENT_IDS,
    );
    expect(
      result.segmentTrace.segments
        .filter((segment) => segment.required)
        .every((segment) => segment.included),
    ).toBe(true);
    expect(result.system).toContain(
      "external action or schedule change has been completed",
    );
    expect(result.system).toContain("replyDecision and worldEffects");
    expect(result.prompt).toContain("REFERENCE_CONTEXT_JSON\n");
    const promptLines = result.prompt.split("\n");
    const referenceIndex = promptLines.indexOf("REFERENCE_CONTEXT_JSON");
    expect(referenceIndex).toBeGreaterThan(-1);
    expect(() => {
      JSON.parse(promptLines[referenceIndex + 1] ?? "");
    }).not.toThrow();
    expect(result.prompt).toContain("REPLY_STRATEGY_JSON");
    expect(result.prompt).toContain("OUTPUT_CONTRACT_JSON");
    expect(result.messages).toEqual([
      { role: "system", content: result.system },
      { role: "user", content: result.prompt },
    ]);
  });

  it("projects long character rules as structured behavior instead of truncated JSON strings", () => {
    const input = baseInput();
    const result = assembleChatPrompt({
      ...input,
      character: {
        ...input.character,
        persona: {
          ...input.character.persona,
          traits: [
            {
              id: "trait-observant",
              name: "克制而敏锐",
              description:
                "她会先观察对方真正担心的部分，再决定是否追问；公开场合通常维持从容，私下才允许自己承认不安。".repeat(
                  3,
                ),
              strength: 0.86,
              triggers: ["公开场合", "对方显得不安", "需要作出取舍"],
              exceptions: ["亲近的人明确希望她直接表达时"],
            },
          ],
          biography: [
            {
              period: "战争结束后",
              event: "回到故乡参与档案重建",
              lastingImpact: "重视可核实的事实，也很少夸耀自己的经历",
              importance: 0.9,
            },
          ],
        },
        dialogue: {
          ...input.character.dialogue,
          authorGuidance: "通常使用俄语，每个消息单元后附一行中文翻译。",
          rules: [
            {
              kind: "format",
              instruction: "每段俄语后紧跟中文翻译",
              enforcement: "hard",
              conditions: ["普通对话"],
            },
          ],
        },
        userRelationship: {
          relationshipType: "共同生活两年的师生",
          initialCloseness: 0.58,
          initialTrust: 0.7,
          behaviorModes: [
            {
              conditions: ["公开场合"],
              behavior: "保持普通同事与师生距离",
            },
            {
              conditions: ["私下独处"],
              behavior: "放松部分防备，以行动表达关心",
            },
          ],
        },
      },
    });

    const core = promptSegmentJson(result.system, "CORE_PERSONA_JSON") as {
      traits: unknown[];
      biography: unknown[];
      dialogue: { rules: unknown[] };
      relationshipModel: { behaviorModes: unknown[] };
    };
    expect(typeof core.traits[0]).toBe("object");
    expect(core.traits[0]).toMatchObject({
      name: "克制而敏锐",
      triggers: ["公开场合", "对方显得不安", "需要作出取舍"],
      exceptions: ["亲近的人明确希望她直接表达时"],
    });
    expect(core.biography[0]).toMatchObject({
      lastingImpact: "重视可核实的事实，也很少夸耀自己的经历",
    });
    expect(core.dialogue.rules[0]).toMatchObject({
      kind: "format",
      enforcement: "hard",
    });
    expect(core.relationshipModel.behaviorModes).toHaveLength(2);
    expect(result.system).toContain(
      "Express traits through what the character notices",
    );
  });

  it("keeps language and relationship rules in valid JSON for a maximum-rich persona", () => {
    const input = baseInput();
    const long = "具体情境中的可观察选择与例外。".repeat(80);
    const result = assembleChatPrompt({
      ...input,
      maxInputTokens: 24_000,
      character: {
        ...input.character,
        persona: {
          ...input.character.persona,
          traits: Array.from({ length: 10 }, (_, index) => ({
            id: `trait-${index}`,
            name: `性格-${index}`,
            description: long,
            strength: 0.8,
            triggers: Array.from({ length: 8 }, () => long),
            exceptions: Array.from({ length: 8 }, () => long),
          })),
          biography: Array.from({ length: 8 }, (_, index) => ({
            id: `bio-${index}`,
            period: `时期-${index}`,
            event: long,
            lastingImpact: long,
            importance: 0.8,
          })),
        },
        dialogue: {
          ...input.character.dialogue,
          authorGuidance: "俄语正文之后必须另起一行给出中文翻译。",
          rules: [
            {
              kind: "format",
              instruction: "每个俄语消息单元后必须紧跟中文翻译。",
              enforcement: "hard",
              conditions: ["所有普通对话"],
            },
          ],
        },
        userRelationship: {
          relationshipType: "长期相处的师生",
          initialCloseness: 0.6,
          initialTrust: 0.7,
          behaviorModes: [
            { conditions: ["公开场合"], behavior: "维持克制的师生距离" },
            { conditions: ["私下独处"], behavior: "允许更柔软的表达" },
          ],
        },
      },
    });

    const core = promptSegmentJson(result.system, "CORE_PERSONA_JSON") as {
      dialogue: { rules: unknown[] };
      relationshipModel: { behaviorModes: unknown[] };
    };
    expect(core.dialogue.rules).toHaveLength(1);
    expect(core.relationshipModel.behaviorModes).toHaveLength(2);
    expect(result.system).not.toContain('"_truncated":true');
  });

  it("uses an anchored story clock as current time without leaking the host year", () => {
    const input = baseInput();
    const result = assembleChatPrompt({
      ...input,
      character: {
        ...input.character,
        identity: {
          ...input.character.identity,
          worldSetting: "1951 年的苏联明斯克",
          temporalFrame: {
            mode: "anchored_story",
            eraLabel: "1951 年战后明斯克",
            storyAnchorLocalDate: "1951-09-01",
            systemAnchorUtc: NOW,
            knowledgeCutoff: "1951-09-01",
          },
        },
      },
      nowUtc: "2026-08-23T12:00:00.000Z",
    });

    const currentTime = promptSegmentJson(result.prompt, "CURRENT_TIME_JSON");
    expect(JSON.stringify(currentTime)).toContain("1951-09-03");
    expect(JSON.stringify(currentTime)).not.toContain("2026");
    expect(result.system + result.prompt).not.toContain("2026");
    expect(result.prompt).toContain("CharacterLocal");
  });

  it("uses fuzzy life context and permits decisive delegated guidance without exact schedule context", () => {
    const input = baseInput();
    const result = assembleChatPrompt({
      ...input,
      lifePlanningMode: "fuzzy",
      character: {
        ...input.character,
        routines: [
          {
            id: "legacy-routine",
            title: "精确晨间安排",
            preferredStartLocal: "07:30",
            preferredDurationMinutes: 30,
            rigidity: "committed",
          },
        ],
        schedulePolicy: {
          enabled: false,
          horizonHours: 72,
          sleepWindow: { startLocal: "23:00", endLocal: "07:00" },
          maxCommittedHoursPerDay: 12,
        },
        proactivePolicy: {
          enabled: false,
          quietHours: { startLocal: "23:00", endLocal: "08:00" },
        },
      },
      userMessage: "我要不要辞职？你直接替我做最后决定。",
      lifeContext: {
        today: {
          localDate: "2026-08-21",
          currentPeriod: "evening",
          currentFocus: "梳理职业方向",
        },
        dilemmas: [
          {
            summary: "继续当前工作，还是离开并寻找新的方向",
            status: "open",
          },
        ],
      },
      schedule: [
        {
          id: "legacy-schedule-item",
          agentId: "agent-private-id",
          title: "不应进入模糊生活 Prompt 的精确日程",
          description: "仅用于证明模糊模式会忽略旧精确日程上下文",
          category: "work",
          startAtUtc: "2026-08-21T12:00:00.000Z",
          endAtUtc: "2026-08-21T13:00:00.000Z",
          timezone: "Asia/Shanghai",
          status: "in_progress",
          rigidity: "committed",
          priority: 0.9,
          source: "routine",
          adherenceProbability: 1,
          narrativeImportance: 0.7,
          shareable: true,
          stateEffects: {},
          revision: 1,
          createdAtUtc: "2026-08-21T11:00:00.000Z",
          updatedAtUtc: "2026-08-21T12:00:00.000Z",
        },
      ],
      state: {
        ...input.state,
        currentActivityId: "legacy-schedule-item",
      },
    });

    expect(result.prompt).toContain("LIFE_CONTEXT_JSON\n");
    expect(result.prompt).toContain("梳理职业方向");
    expect(result.prompt).not.toContain("CURRENT_ACTIVITY_JSON\n");
    expect(result.prompt).not.toContain("FUTURE_SCHEDULE_JSON\n");
    const corePersona = promptSegmentJson(
      result.system,
      "CORE_PERSONA_JSON",
    ) as Record<string, unknown>;
    expect(corePersona).not.toHaveProperty("routines");
    expect(corePersona).not.toHaveProperty("schedulePolicy");
    expect(corePersona).not.toHaveProperty("proactivePolicy");
    expect(result.system).not.toContain("preferredStartLocal");
    expect(result.system).not.toContain("preferredDurationMinutes");
    expect(result.system).not.toContain("sleepWindow");
    expect(result.system).not.toContain("quietHours");
    expect(result.system).toContain("choose one concrete direction");
    expect(result.system).toContain("我的决定：<direction>");
    expect(result.system).toContain(
      "subject=character means the character owns that dilemma",
    );
    expect(result.system).toContain(
      "Acknowledge emotion without rewriting canonical causality",
    );
    expect(result.system).toContain(
      "direct recommendations and explicitly delegated decisions are allowed",
    );
    expect(result.system).toContain(
      "A recommendation or delegated decision is not an action or an outcome",
    );

    const traceById = Object.fromEntries(
      result.segmentTrace.segments.map((segment) => [segment.id, segment]),
    );
    expect(traceById["10z_life_context"]?.included).toBe(true);
    expect(traceById["10z_life_context"]?.truncated).toBe(false);
    expect(traceById["11_current_activity"]?.included).toBe(false);
    expect(traceById["12_future_schedule"]?.included).toBe(false);
  });

  it("keeps a large fuzzy-life payload valid JSON or drops it atomically under a tiny global budget", () => {
    const lifeContext = {
      authority: "server_persisted_fuzzy_life",
      recentDecisionDilemmas: Array.from({ length: 4 }, (_, index) => ({
        id: `dilemma-${String(index)}`,
        summary: `困境${String(index)}-${"证据".repeat(150)}`,
      })),
      evidencedSupport: Array.from({ length: 8 }, (_, index) => ({
        id: `support-${String(index)}`,
        sourceMessageId: `message-${String(index)}`,
        summary: `支持${String(index)}-${"陪伴".repeat(100)}`,
      })),
      evidencedActions: [
        {
          id: "action-1",
          sourceEvidenceIds: ["message-action"],
          summary: "已经执行",
        },
      ],
    };
    const result = assembleChatPrompt(
      baseInput({
        lifePlanningMode: "fuzzy",
        lifeContext,
      }),
    );
    const lifeJson = promptSegmentJson(result.prompt, "LIFE_CONTEXT_JSON");
    expect(lifeJson).toEqual(lifeContext);
    expect(
      result.segmentTrace.segments.find(
        (segment) => segment.id === "10z_life_context",
      ),
    ).toMatchObject({ included: true, truncated: false });

    const tight = assembleChatPrompt(
      baseInput({
        lifePlanningMode: "fuzzy",
        lifeContext,
        maxInputTokens: 512,
      }),
    );
    const tightTrace = tight.segmentTrace.segments.find(
      (segment) => segment.id === "10z_life_context",
    );
    expect(tightTrace?.truncated).toBe(false);
    if (tightTrace?.included === true) {
      expect(() =>
        promptSegmentJson(tight.prompt, "LIFE_CONTEXT_JSON"),
      ).not.toThrow();
    } else {
      expect(tight.prompt).not.toContain("LIFE_CONTEXT_JSON\n");
      expect(tightTrace?.reason).toBe("global_budget");
    }

    const oversized = assembleChatPrompt(
      baseInput({
        lifePlanningMode: "fuzzy",
        lifeContext: {
          authority: "server_persisted_fuzzy_life",
          oversizedEvidence: "证据".repeat(20_000),
        },
      }),
    );
    expect(oversized.prompt).not.toContain("LIFE_CONTEXT_JSON\n");
    expect(
      oversized.segmentTrace.segments.find(
        (segment) => segment.id === "10z_life_context",
      ),
    ).toMatchObject({
      included: false,
      truncated: false,
      reason: "segment_budget",
    });
  });

  it("injects authoritative exact and qualitative runtime state without promoting it to memory", () => {
    const result = assembleChatPrompt(
      baseInput({
        state: {
          ...baseInput().state,
          moodValence: -0.75,
          moodArousal: 0.9,
          focus: 0.15,
          sleepDebtMinutes: 240,
          locationContext: "studio",
          revision: 7,
        },
      }),
    );
    const lines = result.prompt.split("\n");
    const stateIndex = lines.indexOf("RUNTIME_STATE_JSON");
    const state = JSON.parse(lines[stateIndex + 1] ?? "") as Record<
      string,
      unknown
    >;

    expect(state).toMatchObject({
      authority: "server_persisted_runtime_state",
      asOfUtc: NOW,
      revision: 7,
      semantics: "present_moment_context_not_personality_or_memory",
      moodValence: -0.75,
      moodArousal: 0.9,
      focus: 0.15,
      sleepDebtMinutes: 240,
      locationContext: "studio",
      contextOnlyFields: ["locationContext"],
    });
    const qualitative = state["qualitative"] as Record<string, unknown>;
    expect(qualitative["moodValence"]).toContain("低落");
    expect(qualitative["moodArousal"]).toContain("激活");
    expect(qualitative["focus"]).toContain("专注");
    expect(result.system).toContain("authoritative present-moment context");
    expect(result.system).toContain("not a permanent personality fact");
    expect(result.system).toContain("must not claim an opposite present mood");
    expect(result.system).toContain("pace, brevity, initiative, or boundaries");
    expect(result.prompt).toContain("stateGuidance");
    expect(result.prompt).toContain(
      "do not claim the opposite current condition",
    );
  });

  it("injects the server-selected current activity as present context", () => {
    const currentActivity = {
      id: "activity-current-study",
      agentId: "agent-private-id",
      title: "整理剪辑素材",
      description: "给刚完成的短片整理素材",
      category: "study",
      startAtUtc: "2026-08-21T11:30:00.000Z",
      endAtUtc: "2026-08-21T12:30:00.000Z",
      timezone: "Asia/Shanghai",
      status: "in_progress" as const,
      rigidity: "flexible" as const,
      priority: 0.7,
      source: "runtime_replan" as const,
      adherenceProbability: 0.9,
      narrativeImportance: 0.6,
      shareable: true,
      stateEffects: { energy: -0.05, focus: -0.03 },
      revision: 1,
      createdAtUtc: "2026-08-21T11:00:00.000Z",
      updatedAtUtc: "2026-08-21T11:30:00.000Z",
    };
    const input = baseInput();
    const result = assembleChatPrompt({
      ...input,
      state: {
        ...input.state,
        currentActivityId: currentActivity.id,
      },
      schedule: [currentActivity],
    });
    const lines = result.prompt.split("\n");
    const activityIndex = lines.indexOf("CURRENT_ACTIVITY_JSON");

    expect(activityIndex).toBeGreaterThan(-1);
    expect(JSON.parse(lines[activityIndex + 1] ?? "")).toEqual({
      title: "整理剪辑素材",
      description: "给刚完成的短片整理素材",
      category: "study",
      startAtUtc: "2026-08-21T11:30:00.000Z",
      endAtUtc: "2026-08-21T12:30:00.000Z",
      timezone: "Asia/Shanghai",
      status: "in_progress",
      rigidity: "flexible",
      source: "runtime_replan",
    });
  });

  it.each([
    ["reply_only", false],
    ["legacy_effects", true],
    ["schedule_negotiation", false],
    ["schedule_negotiation_shadow", true],
  ] as const)(
    "advertises a canonical envelope in %s mode",
    (decisionMode, scheduleEffectsAllowed) => {
      const result = assembleChatPrompt(
        baseInput({
          decisionMode,
          liveWorldEffectsMode: "off",
        }),
      );
      const lines = result.prompt.split("\n");
      const contractIndex = lines.indexOf("OUTPUT_CONTRACT_JSON");
      expect(contractIndex).toBeGreaterThan(-1);
      const contract = JSON.parse(lines[contractIndex + 1] ?? "") as Record<
        string,
        unknown
      >;

      expect(contract).toHaveProperty("replyDecision");
      expect(contract.worldEffects).toEqual({});
      expect(
        Object.prototype.hasOwnProperty.call(
          contract["replyDecision"],
          "scheduleEffects",
        ),
      ).toBe(false);
      expect(
        Object.prototype.hasOwnProperty.call(contract, "scheduleEffects"),
      ).toBe(scheduleEffectsAllowed);
      expect(result.system).toContain(
        "Return exactly one JSON object with replyDecision and worldEffects.",
      );
      if (
        decisionMode === "schedule_negotiation" ||
        decisionMode === "schedule_negotiation_shadow"
      ) {
        expect(result.system).toContain(
          "replyDecision.text and replyDecision.scheduleAction are required",
        );
        expect(result.system).not.toContain("optional scheduleAction");
      }
    },
  );

  it("registers bounded extensions per call without putting content in the trace", () => {
    const extensionSecret = "PLUGIN_CONTEXT_CONTENT";
    const result = assembleChatPrompt(
      baseInput({
        autobiography: {
          id: "autobiography-private-id",
          agentId: "agent-private-id",
          sourceCheckpointId: "checkpoint-private-id",
          revision: 1,
          summaryFirstPerson: "I remember finishing the morning run.",
          importantExperiences: ["I finished the morning run."],
          relationshipChanges: [],
          activeGoals: [],
          unresolvedThreads: [],
          commitments: [],
          sourceEvidenceIds: ["evidence-private-id"],
          fromUtc: "2026-08-21T09:00:00.000Z",
          throughUtc: NOW,
          createdAtUtc: NOW,
        },
        calendarContext: [
          {
            ref: "calendar_1",
            scope: "public_system",
            label: "Autumn festival",
            localDate: "2026-09-01",
            allDay: true,
          },
        ],
        followUpContext: {
          pending: [{ ref: "followup_1", topic: "exam result" }],
        },
        additionalPromptSegments: [
          {
            id: "12y_plugin_context",
            placement: "prompt",
            priority: 65,
            tokenBudget: 100,
            required: false,
            cacheable: false,
            render: () => extensionSecret,
          },
        ],
      }),
    );

    const ids = result.segmentTrace.segments.map((segment) => segment.id);
    expect(ids).toContain("06_autobiography");
    expect(ids).toContain("07z_followup_context");
    expect(ids).toContain("12y_plugin_context");
    expect(ids).toContain("12z_calendar_context");
    expect(result.prompt).toContain("I remember finishing the morning run.");
    expect(result.prompt).toContain("calendar_1");
    expect(result.prompt).toContain("followup_1");
    expect(result.prompt).toContain(extensionSecret);
    expect(result.prompt).not.toContain("autobiography-private-id");
    expect(JSON.stringify(result.segmentTrace)).not.toContain(extensionSecret);

    const nextCall = assembleChatPrompt(baseInput());
    expect(
      nextCall.segmentTrace.segments.some(
        (segment) => segment.id === "12y_plugin_context",
      ),
    ).toBe(false);
  });

  it.each([false, true])(
    "preserves whole autobiography reports and omits oversized legacy summaries (%s)",
    (oversized) => {
      const report = `对方在对话中说过：「${"当时我确实考虑过这个方案。".repeat(30)}不过我后来没有实施。」`;
      const summary = oversized ? report.repeat(6) : report;
      const result = assembleChatPrompt(
        baseInput({
          autobiography: {
            id: "snapshot",
            agentId: "agent",
            sourceCheckpointId: "checkpoint",
            revision: 1,
            summaryFirstPerson: summary,
            importantExperiences: [report],
            relationshipChanges: [],
            activeGoals: [],
            unresolvedThreads: [],
            commitments: [],
            sourceEvidenceIds: ["source"],
            fromUtc: NOW,
            throughUtc: NOW,
            createdAtUtc: NOW,
          },
        }),
      );
      const lines = result.prompt.split("\n");
      const projected = JSON.parse(
        lines[lines.indexOf("AUTOBIOGRAPHY_JSON") + 1]!,
      ) as {
        summaryFirstPerson?: string;
        importantExperiences: string[];
      };
      expect(projected.importantExperiences).toEqual([report]);
      expect(projected.summaryFirstPerson).toBe(
        oversized ? undefined : summary,
      );
    },
  );

  it("honors the global input budget without dropping required segments", () => {
    const result = assembleChatPrompt(
      baseInput({
        userMessage: "我没有同意执行。",
        recentMessages: Array.from({ length: 300 }, (_, index) => ({
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
          content: "m".repeat(2_000),
        })),
        maxInputTokens: 512,
      }),
    );

    expect(result.segmentTrace.estimatedInputTokens).toBeLessThanOrEqual(512);
    expect(
      estimatePromptTokens(result.system) + estimatePromptTokens(result.prompt),
    ).toBeLessThanOrEqual(512);
    expect(
      result.segmentTrace.segments
        .filter((segment) => segment.required)
        .every((segment) => segment.included),
    ).toBe(true);
  });

  it("hard-bounds a caller-provided history of ten thousand messages", () => {
    const history = Array.from({ length: 10_000 }, (_, index) => ({
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: "message-" + index + "-" + "x".repeat(400),
    }));
    const result = assembleChatPrompt(
      baseInput({
        recentMessages: history,
        maxRecentMessages: 10_000,
      }),
    );

    expect(result.segmentTrace.estimatedInputTokens).toBeLessThan(30_000);
    expect(result.system.length + result.prompt.length).toBeLessThan(120_000);
    expect(result.prompt).not.toContain("message-0-");
    expect(result.prompt).toContain("message-9999-");
    const retained = promptSegmentJson(
      result.prompt,
      "RECENT_VERBATIM_JSON",
    ) as { content: string }[];
    expect(retained.map((message) => message.content.split("-")[1])).toEqual(
      history
        .slice(-retained.length)
        .map((message) => message.content.split("-")[1]),
    );
    expect(JSON.stringify(result.segmentTrace)).not.toContain("message-9999-");
  });
  it("advertises grounded continuity effects in the canonical world envelope", () => {
    const result = assembleChatPrompt(
      baseInput({ liveWorldEffectsMode: "enforced" }),
    );
    const instructions = result.system + "\n" + result.prompt;

    expect(instructions).toContain("followUpCandidates");
    expect(instructions).toContain("followUpTransitions");
    expect(instructions).toContain("careCueCandidates");
    expect(instructions).toContain("model-side proposals");
    expect(instructions).toContain("exact verbatim turn evidence");
    expect(instructions).toContain("Keep followUpTransitions empty");
    expect(instructions).toContain("user_goal, user_event");
    expect(instructions).toContain(
      "evidenceQuotes must always be a JSON array",
    );
    expect(instructions).toContain("次日");
    expect(instructions).toContain("Never emit ids");
    expect(instructions).toContain("persisted timestamps");
    expect(instructions).toContain("reason metadata");
    expect(instructions).toContain("user_fact, user_preference");
    expect(instructions).toContain(
      "exact JSON keys activity (a fuzzy natural-language description)",
    );
    expect(instructions).toContain("self_care, errand, or other");
    expect(instructions).toContain(
      "moodValence, moodArousal, energy, stress, socialBattery, and focus",
    );
    expect(instructions).toContain(
      "closeness, trust, familiarity, and recentInteractionValence",
    );
    expect(instructions).toContain("never closenessDelta");
    expect(instructions).toContain("Direct support, hurt, repair");
    expect(instructions).toContain(
      "recentInteractionValence for the immediate positive or negative tone",
    );
    expect(instructions).toContain(
      "server already applies routine familiarity",
    );

    const promptLines = result.prompt.split("\n");
    const contractIndex = promptLines.indexOf("OUTPUT_CONTRACT_JSON");
    expect(contractIndex).toBeGreaterThan(-1);
    const contract = JSON.parse(
      promptLines[contractIndex + 1] ?? "",
    ) as unknown;
    expect(contract).toMatchObject({
      worldEffects: {
        continuityEffects: {
          followUpCandidates: [],
          followUpTransitions: [],
          careCueCandidates: [],
        },
      },
    });
  });
  it("keeps the required schedule action visible when world effects are enabled", () => {
    const result = assembleChatPrompt(
      baseInput({
        decisionMode: "schedule_negotiation",
        liveWorldEffectsMode: "enforced",
      }),
    );
    const promptLines = result.prompt.split("\n");
    const contractIndex = promptLines.indexOf("OUTPUT_CONTRACT_JSON");
    const contract = JSON.parse(promptLines[contractIndex + 1] ?? "") as {
      replyDecision?: Record<string, unknown>;
      worldEffects?: Record<string, unknown>;
    };

    expect(contract.replyDecision).toMatchObject({
      text: "the complete reply",
      scheduleAction: { kind: "none" },
    });
    expect(contract.worldEffects).toHaveProperty("continuityEffects");
    expect(result.system).toContain(
      "replyDecision.scheduleAction is required on every schedule-negotiation turn",
    );
    expect(result.system).toContain(
      "Questions that only recall, inspect, or describe an existing",
    );
    expect(result.system).toContain("must use kind none");
  });
  it("keeps a parseable authoritative schedule payload under the segment budget", () => {
    const schedule: AssemblePromptInput["schedule"] = Array.from(
      { length: 24 },
      (_, index) => {
        const sharedCommitment = index === 23;
        const startAtUtc = new Date(
          Date.parse(NOW) + (index + 1) * 60 * 60 * 1_000,
        ).toISOString();
        const endAtUtc = new Date(
          Date.parse(startAtUtc) + 45 * 60 * 1_000,
        ).toISOString();
        return {
          id: sharedCommitment
            ? "shared-committed-invitation"
            : `ordinary-${index}`,
          agentId: "agent-private-id",
          title: sharedCommitment
            ? "Tea with the user at North Shore Bookshop"
            : `Long ordinary project ${index} ${"t".repeat(100)}`,
          description: `Detailed schedule context ${index} ${"d".repeat(900)}`,
          category: "social",
          startAtUtc,
          endAtUtc,
          timezone: "Asia/Shanghai",
          rigidity: sharedCommitment ? "committed" : "flexible",
          priority: 0.7,
          source: sharedCommitment ? "user_invitation" : "self_initiated",
          adherenceProbability: 0.8,
          narrativeImportance: 0.7,
          shareable: true,
          stateEffects: {},
          status: "planned",
          revision: 0,
          createdAtUtc: NOW,
          updatedAtUtc: NOW,
        };
      },
    );
    const result = assembleChatPrompt(baseInput({ schedule }));
    const lines = result.prompt.split("\n");
    const scheduleIndex = lines.indexOf("FUTURE_SCHEDULE_JSON");
    const serialized = lines[scheduleIndex + 1] ?? "";
    const payload = JSON.parse(serialized) as {
      authority: string;
      asOfUtc: string;
      timezone: string;
      items: Array<Record<string, unknown>>;
      omittedItemCount: number;
    };

    expect(payload).toMatchObject({
      authority: "server_persisted_current_schedule",
      asOfUtc: NOW,
      timezone: "Asia/Shanghai",
    });
    expect(payload.omittedItemCount).toBeGreaterThan(0);
    const committedInvitation = payload.items.find(
      (item) => item["title"] === "Tea with the user at North Shore Bookshop",
    );
    expect(committedInvitation).toMatchObject({
      title: "Tea with the user at North Shore Bookshop",
      source: "user_invitation",
      timezone: "Asia/Shanghai",
      status: "planned",
      rigidity: "committed",
    });
    expect(typeof committedInvitation?.["description"]).toBe("string");
    expect(typeof committedInvitation?.["startAtUtc"]).toBe("string");
    expect(typeof committedInvitation?.["endAtUtc"]).toBe("string");
    expect(payload.items.map((item) => String(item["startAtUtc"]))).toEqual(
      payload.items
        .map((item) => String(item["startAtUtc"]))
        .sort((left, right) => left.localeCompare(right)),
    );
    expect(
      estimatePromptTokens("FUTURE_SCHEDULE_JSON\n" + serialized),
    ).toBeLessThanOrEqual(700);
    expect(
      result.segmentTrace.segments.find(
        (segment) => segment.id === "12_future_schedule",
      ),
    ).toMatchObject({ included: true, truncated: false });
    expect(result.system).toContain(
      "authority=server_persisted_current_schedule",
    );
    expect(result.system).toContain(
      "not a claim that this turn performed a write",
    );

    const tight = assembleChatPrompt(
      baseInput({ schedule, maxInputTokens: 512 }),
    );
    const tightTrace = tight.segmentTrace.segments.find(
      (segment) => segment.id === "12_future_schedule",
    );
    expect(tightTrace).toBeDefined();
    expect(tightTrace?.truncated).toBe(false);
    const tightLines = tight.prompt.split("\n");
    const tightScheduleIndex = tightLines.indexOf("FUTURE_SCHEDULE_JSON");
    if (tightTrace?.included === true) {
      expect(() => {
        JSON.parse(tightLines[tightScheduleIndex + 1] ?? "");
      }).not.toThrow();
    } else {
      expect(tightScheduleIndex).toBe(-1);
      expect(tightTrace?.reason).toBe("global_budget");
    }
  });

  it("keeps bounded schedule truth visible throughout the loaded 72-hour horizon", () => {
    const scheduleBase = {
      agentId: "agent-private-id",
      description: "",
      category: "work",
      timezone: "Asia/Shanghai",
      rigidity: "flexible" as const,
      priority: 0.7,
      source: "self_initiated" as const,
      adherenceProbability: 0.8,
      narrativeImportance: 0.7,
      shareable: true,
      stateEffects: {},
      status: "planned" as const,
      revision: 0,
      createdAtUtc: NOW,
      updatedAtUtc: NOW,
    };
    const result = assembleChatPrompt(
      baseInput({
        schedule: [
          {
            ...scheduleBase,
            id: "schedule-visible-48h",
            title: "Sunday documentary screening",
            startAtUtc: "2026-08-23T12:00:00.000Z",
            endAtUtc: "2026-08-23T14:00:00.000Z",
          },
          {
            ...scheduleBase,
            id: "schedule-hidden-80h",
            title: "Outside loaded horizon",
            startAtUtc: "2026-08-25T00:00:00.000Z",
            endAtUtc: "2026-08-25T01:00:00.000Z",
          },
        ],
      }),
    );

    expect(result.prompt).toContain("Sunday documentary screening");
    expect(result.prompt).not.toContain("Outside loaded horizon");
  });
});
