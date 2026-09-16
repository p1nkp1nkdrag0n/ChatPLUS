import { describe, expect, it } from "vitest";
import { buildConversationContextPlan } from "./conversation-context-plan.js";
import { describeRuntimeState } from "./runtime-state-description.js";

import {
  deriveReplyStrategy,
  replyStrategyPromptView,
  type ReplyStrategyContext,
} from "./reply-strategy.js";

describe("deriveReplyStrategy", () => {
  const affinityStyle = { averageMessageLength: 45, verbosity: 0.4 };
  const affinityStrategy = (
    closeness: number,
    text = "今天忽然想找你聊两句。",
  ) =>
    deriveReplyStrategy(text, affinityStyle, { relationship: { closeness } });

  it("lets familiarity change relational expression without setting the reply length", () => {
    const targets = Array.from(
      { length: 101 },
      (_, n) => affinityStrategy(n / 100).targetChars,
    );
    expect(new Set(targets).size).toBe(1);
    expect(affinityStrategy(0.1).affinityApplied).toBe(false);
    expect(affinityStrategy(0.1).affinityGuidance).not.toBe(
      affinityStrategy(0.9).affinityGuidance,
    );
    expect(affinityStrategy(0.1).affinityGuidance).not.toContain(
      "one short, complete thought",
    );
  });

  it("preserves both short and talkative authored baselines in ordinary planning", () => {
    const targets = [18, 30, 140, 300, 600].map(
      (averageMessageLength) =>
        deriveReplyStrategy(
          "今天在路上看到一只猫。",
          { averageMessageLength, verbosity: 0.5 },
          { relationship: { closeness: 0.1 } },
        ).targetChars,
    );
    expect(targets[0]).toBeLessThan(30);
    expect(
      targets.every((target, i) => i === 0 || target > targets[i - 1]!),
    ).toBe(true);
    expect(targets.at(-1)).toBeGreaterThan(600);
  });

  it("keeps ordinary planning numbers out of the model-visible strategy", () => {
    const strategy = affinityStrategy(0.1);
    const view = replyStrategyPromptView(strategy);
    expect(view).toMatchObject({
      affinityPolicyVersion: "persona_expression_v2",
      lengthOverride: "none",
    });
    for (const key of [
      "softTargetCharacters",
      "preferredChunkCount",
      "reviewUpperChars",
      "affinityApplied",
      "stateGuidance",
    ])
      expect(view).not.toHaveProperty(key);
    expect(strategy.lengthGuidance).not.toContain("characters");
    expect(strategy.deliveryGuidance).not.toMatch(/\d+ chunks/u);
    expect(
      replyStrategyPromptView(affinityStrategy(0.1, "只用一句话告诉我。")),
    ).toHaveProperty("softTargetCharacters");
  });

  it.each([
    "今天工作碰到了一点问题。",
    "朋友说他最近不知道如何是好。",
    "猫今天趴在窗边，一点也不关心世界的问题。",
  ])(
    "does not turn analytical vocabulary into a requested length quota: %s",
    (text) => {
      for (const conversationPlan of [
        undefined,
        buildConversationContextPlan({
          originalQuery: text,
          agentId: "agent-test",
          sessionId: "session-test",
          recentMessages: [],
        }),
      ]) {
        const strategy = deriveReplyStrategy(text, affinityStyle, {
          ...(conversationPlan === undefined ? {} : { conversationPlan }),
        });
        expect(strategy.lengthOverride).toBe("none");
        expect(replyStrategyPromptView(strategy)).not.toHaveProperty(
          "softTargetCharacters",
        );
      }
    },
  );

  it.each([
    "晚安",
    "只用一句话告诉我。",
    "今天只想有人安静陪我待一会儿。",
    "请详细解释为什么会出现这个问题。",
  ])("keeps an explicit need independent of affinity: %s", (text) => {
    const low = affinityStrategy(0.1, text);
    const high = affinityStrategy(0.9, text);
    expect(high.targetChars).toBe(low.targetChars);
    expect(low.affinityApplied).toBe(false);
    expect(high.lengthOverride).not.toBe("none");
  });

  it("keeps high affinity fatigue effective and never buffs capacity at 0.8", () => {
    const input = "今天忽然想找你聊两句。";
    const tired = deriveReplyStrategy(input, affinityStyle, {
      relationship: { closeness: 0.9 },
      state: { energy: 0.1, stress: 0.8, socialBattery: 0.1 },
    });
    expect(tired.targetChars).toBeLessThan(
      affinityStrategy(0.9, input).targetChars,
    );
    expect(tired.preferredChunkCount).toBe(1);
  });
  const withPlan = (text: string) =>
    deriveReplyStrategy(
      text,
      {
        averageMessageLength: 100,
        verbosity: 0.5,
      },
      {
        conversationPlan: buildConversationContextPlan({
          originalQuery: text,
          agentId: "agent-test",
          sessionId: "session-test",
          recentMessages: [],
        }),
      },
    );

  it.each([
    "请给我一个适合首次参会时照着做的发言顺序。",
    "请列一份适合第一次主持会议时用的准备清单。",
    "替我梳理明天办手续的流程。",
  ])(
    "gives an explicit procedural output room for practical detail: %s",
    (text) => {
      expect(withPlan(text).complexity).toBe("complex");
      expect(withPlan(text).targetChars).toBeGreaterThan(
        deriveReplyStrategy(text, {
          averageMessageLength: 100,
          verbosity: 0.5,
        }).targetChars,
      );
      expect(withPlan(text).lengthGuidance).toContain("not a quota");
    },
  );

  it.each([
    "帮我拟一版。",
    "帮我写一条拒绝回复。",
    "帮我写一条回复介绍准备顺序。",
    "帮我写一条回复，里面提到‘准备清单’。",
    "她说，给我一个准备顺序。",
    "不要给我一个准备顺序。",
    "给我一点时间整理准备顺序。",
    "明天再给我清单，今晚只想说说。",
    "先让我说完，再帮我列一个准备清单。",
    "先听我说，也请给我一个准备清单。",
  ])(
    "does not expand short drafts or inactive procedural requests: %s",
    (text) => {
      expect(withPlan(text).complexity).toBe("standard");
    },
  );

  it("keeps an explicit concise instruction ahead of the procedural floor", () => {
    const text = "请给我一个准备顺序，只用一句话。";
    expect(withPlan(text).complexity).toBe("brief");
    expect(withPlan("请总结完整方案，只用一句话。").complexity).toBe("brief");
  });

  it("does not apply a stale plan's procedural floor to a new short request", () => {
    const plan = buildConversationContextPlan({
      originalQuery: "请给我一个准备顺序。",
      agentId: "agent-test",
      sessionId: "session-test",
      recentMessages: [],
    });
    expect(
      deriveReplyStrategy("帮我拟一版。", {}, { conversationPlan: plan })
        .complexity,
    ).toBe("standard");
  });

  it("keeps greetings brief while expanding analytical questions", () => {
    const dialogue = {
      verbosity: 0.45,
      averageMessageLength: 90,
      averageChunksPerTurn: 1,
    };
    const greeting = deriveReplyStrategy("你好！", dialogue);
    const analysis = deriveReplyStrategy(
      "为什么大模型有时不能有效反应？请详细分析可能的原因和改进方案。",
      dialogue,
    );

    expect(greeting.complexity).toBe("brief");
    expect(analysis.complexity).toBe("deep");
    expect(analysis.targetChars).toBeGreaterThan(greeting.targetChars * 4);
    expect(analysis.targetMinChars).toBeLessThan(analysis.targetMaxChars);
  });

  it("honors an explicit concise request without erasing persona differences", () => {
    const restrained = deriveReplyStrategy("请用一两句简单说说原因。", {
      verbosity: 0.2,
      averageMessageLength: 70,
    });
    const talkative = deriveReplyStrategy("请用一两句简单说说原因。", {
      verbosity: 0.9,
      averageMessageLength: 220,
    });

    expect(restrained.complexity).toBe("brief");
    expect(talkative.complexity).toBe("brief");
    expect(talkative.targetChars).toBeGreaterThan(restrained.targetChars);
  });

  it("derives a soft delivery preference from the character style", () => {
    const sequential = deriveReplyStrategy("今天过得怎么样？", {
      averageChunksPerTurn: 4,
      averageMessageLength: 100,
      verbosity: 0.5,
    });
    const block = deriveReplyStrategy("今天过得怎么样？", {
      averageChunksPerTurn: 1,
      averageMessageLength: 100,
      verbosity: 0.5,
    });

    expect(sequential.deliveryPreference).toBe("prefer_sequential");
    expect(sequential.preferredChunkCount).toBe(4);
    expect(block.deliveryPreference).toBe("prefer_single_block");
    expect(sequential.deliveryGuidance).toContain("style decision");
    expect(sequential.lengthGuidance).toContain("not a quota");
  });

  it("does not misread negated brevity or English substrings", () => {
    const style = {
      verbosity: 0.5,
      averageMessageLength: 120,
      averageChunksPerTurn: 1,
    };

    expect(
      deriveReplyStrategy("不要简短，请详细分析这个方案。", style).complexity,
    ).toBe("deep");
    expect(deriveReplyStrategy("请写一个完整故事。", style).complexity).toBe(
      "deep",
    );
    expect(
      deriveReplyStrategy(
        "This is not a short answer; explain the trade-offs in detail.",
        style,
      ).complexity,
    ).toBe("deep");
    expect(deriveReplyStrategy("Somehow it works.", style).complexity).toBe(
      "standard",
    );
    expect(deriveReplyStrategy("How does it work?", style).complexity).toBe(
      "complex",
    );
  });

  it("lets an explicit short request override negated detail in Chinese and English", () => {
    const style = {
      verbosity: 0.8,
      averageMessageLength: 240,
      averageChunksPerTurn: 2,
    };

    expect(
      deriveReplyStrategy("不用详细，简短说就好。", style).complexity,
    ).toBe("brief");
    expect(
      deriveReplyStrategy("不要详细分析，只用一句话。", style).complexity,
    ).toBe("brief");
    expect(
      deriveReplyStrategy("Not in detail; give me a short answer.", style)
        .complexity,
    ).toBe("brief");
    expect(
      deriveReplyStrategy("不要简短，请详细展开。", style).complexity,
    ).toBe("complex");
    expect(
      deriveReplyStrategy("Not a short answer; explain it in detail.", style)
        .complexity,
    ).toBe("deep");
  });

  it("budgets safely for optional duplicated sequential chunks", () => {
    const strategy = deriveReplyStrategy("请从零开始给出完整设计和详细规划。", {
      verbosity: 1,
      averageMessageLength: 800,
      averageChunksPerTurn: 4,
    });

    expect(strategy.maxOutputTokens).toBeGreaterThan(
      strategy.targetMaxChars * 2,
    );
    expect(strategy.maxOutputTokens).toBeLessThanOrEqual(8_000);
  });

  it("lets fatigue shape casual delivery without reducing an explicit detailed answer", () => {
    const dialogue = {
      verbosity: 0.65,
      averageMessageLength: 180,
      averageChunksPerTurn: 4,
    };
    const rested = {
      state: {
        energy: 0.9,
        stress: 0.1,
        socialBattery: 0.9,
        sleepDebtMinutes: 0,
      },
    };
    const fatigued = {
      state: {
        energy: 0.1,
        stress: 0.9,
        socialBattery: 0.1,
        sleepDebtMinutes: 600,
      },
    };

    const restedCasual = deriveReplyStrategy(
      "Tell me about your day.",
      dialogue,
      rested,
    );
    const fatiguedCasual = deriveReplyStrategy(
      "Tell me about your day.",
      dialogue,
      fatigued,
    );
    const restedDetailed = deriveReplyStrategy(
      "Explain the design in detail, step-by-step.",
      dialogue,
      rested,
    );
    const fatiguedDetailed = deriveReplyStrategy(
      "Explain the design in detail, step-by-step.",
      dialogue,
      fatigued,
    );

    expect(fatiguedCasual.targetChars).toBeLessThan(restedCasual.targetChars);
    expect(fatiguedCasual.preferredChunkCount).toBe(1);
    expect(fatiguedDetailed.targetChars).toBe(restedDetailed.targetChars);
    expect(fatiguedDetailed.targetMinChars).toBe(restedDetailed.targetMinChars);
    expect(fatiguedDetailed.targetMaxChars).toBe(restedDetailed.targetMaxChars);
    expect(fatiguedDetailed.stateGuidance).not.toBe(
      restedDetailed.stateGuidance,
    );
    expect(fatiguedDetailed.complexity).toBe("deep");
  });

  it("keeps affect, focus, and social capacity as distinct soft state signals", () => {
    const dialogue = {
      verbosity: 0.6,
      averageMessageLength: 160,
      averageChunksPerTurn: 3,
    };
    const input = "I was thinking about you today.";
    const calmFocused = deriveReplyStrategy(input, dialogue, {
      state: {
        moodValence: 0.8,
        moodArousal: 0.1,
        energy: 0.85,
        stress: 0.1,
        socialBattery: 0.9,
        focus: 0.9,
        sleepDebtMinutes: 0,
      },
    });
    const activatedDistracted = deriveReplyStrategy(input, dialogue, {
      state: {
        moodValence: -0.8,
        moodArousal: 0.9,
        energy: 0.85,
        stress: 0.1,
        socialBattery: 0.9,
        focus: 0.1,
        sleepDebtMinutes: 0,
      },
    });
    const sociallyDrained = deriveReplyStrategy(input, dialogue, {
      state: {
        moodValence: 0,
        moodArousal: 0.5,
        energy: 0.85,
        stress: 0.1,
        socialBattery: 0.05,
        focus: 0.9,
        sleepDebtMinutes: 0,
      },
    });

    expect(calmFocused.stateGuidance).toContain("情绪明显正向");
    expect(calmFocused.stateGuidance).toContain("唤醒度较低");
    expect(activatedDistracted.stateGuidance).toContain("情绪明显低落");
    expect(activatedDistracted.targetChars).toBeLessThan(
      calmFocused.targetChars,
    );
    expect(activatedDistracted.stateGuidance).toContain("高度激活");
    expect(sociallyDrained.stateGuidance).toContain("社交精力很低");
    expect(sociallyDrained.preferredChunkCount).toBeLessThanOrEqual(2);
  });

  it("consumes each runtime-state dimension independently for the same message", () => {
    const dialogue = {
      verbosity: 0.6,
      averageMessageLength: 160,
      averageChunksPerTurn: 3,
    };
    const input = "I was thinking about you today.";
    const derive = (overrides: Partial<StateInput> = {}) =>
      deriveReplyStrategy(input, dialogue, {
        state: {
          moodValence: 0,
          moodArousal: 0.5,
          energy: 0.9,
          stress: 0.1,
          socialBattery: 0.9,
          focus: 0.5,
          sleepDebtMinutes: 0,
          ...overrides,
        },
      });

    const highEnergy = derive({ energy: 0.9 });
    const lowEnergy = derive({ energy: 0.1 });
    expect(lowEnergy.targetChars).toBeLessThan(highEnergy.targetChars);

    const lowStress = derive({ energy: 0.5, stress: 0.1 });
    const highStress = derive({ energy: 0.5, stress: 1 });
    expect(highStress.targetChars).toBeLessThan(lowStress.targetChars);

    const positive = derive({ moodValence: 0.8, moodArousal: 0.5 });
    const negative = derive({ moodValence: -0.8, moodArousal: 0.5 });
    expect(positive.stateGuidance).toContain("情绪明显正向");
    expect(negative.stateGuidance).toContain("情绪明显低落");

    const calm = derive({ moodValence: 0.8, moodArousal: 0.1 });
    const activated = derive({ moodValence: 0.8, moodArousal: 0.9 });
    expect(calm.stateGuidance).toContain("唤醒度较低");
    expect(activated.stateGuidance).toContain("高度激活");
    expect(activated.preferredChunkCount).toBeGreaterThan(
      calm.preferredChunkCount,
    );

    const lowFocus = derive({ focus: 0.1 });
    const highFocus = derive({ focus: 0.9 });
    expect(lowFocus.targetChars).toBeLessThan(highFocus.targetChars);
    expect(lowFocus.stateGuidance).toContain("很难持续专注");
    expect(highFocus.stateGuidance).toContain("注意力高度集中");

    const lowSocial = derive({ socialBattery: 0.05 });
    const highSocial = derive({ socialBattery: 0.9 });
    expect(lowSocial.preferredChunkCount).toBe(1);
    expect(lowSocial.deliveryPreference).toBe("prefer_single_block");
    expect(highSocial.preferredChunkCount).toBeGreaterThan(1);
    expect(highSocial.stateGuidance).toContain("社交精力充足");
  });

  it("uses the canonical semantic bands even when planning thresholds differ", () => {
    const state = {
      moodValence: -0.2,
      moodArousal: 0.8,
      energy: 0.2,
      stress: 0.3,
      socialBattery: 0.9,
      focus: 0.9,
      sleepDebtMinutes: 0,
    };
    const strategy = deriveReplyStrategy("今天想聊聊。", {}, { state });
    expect(strategy.stateGuidance).toBe(describeRuntimeState(state).summary);
    expect(strategy.stateGuidance).toContain("略偏负向");
    expect(strategy.stateGuidance).toContain("注意力高度集中");
    expect(strategy.stateGuidance).not.toContain("注意力已经明显下降");
    expect(replyStrategyPromptView(strategy)).not.toHaveProperty(
      "stateGuidance",
    );
  });

  it("ignores unavailable sleep debt while preserving maintained sleep fatigue calculations", () => {
    const state = {
      energy: 0.9,
      stress: 0.1,
      socialBattery: 0.9,
      focus: 0.9,
      sleepDebtMinutes: 720,
    };
    const dialogue = { averageMessageLength: 180, averageChunksPerTurn: 4 };
    const derive = (sleepDebtAvailable: boolean, sleepDebtMinutes = 720) =>
      deriveReplyStrategy("今天想聊聊。", dialogue, {
        state: { ...state, sleepDebtMinutes },
        sleepDebtAvailable,
      });
    const unavailable = derive(false);
    const maintained = derive(true);
    expect(unavailable).toEqual(derive(false, 0));
    expect(unavailable.stateGuidance).not.toContain("睡眠");
    expect(maintained.stateGuidance).toContain("睡眠债很高");
    expect(maintained.targetChars).toBeLessThan(unavailable.targetChars);
    expect(maintained.preferredChunkCount).toBeLessThan(
      unavailable.preferredChunkCount,
    );
    expect(maintained).toEqual(
      deriveReplyStrategy("今天想聊聊。", dialogue, { state }),
    );
  });
});

type StateInput = NonNullable<ReplyStrategyContext["state"]>;
