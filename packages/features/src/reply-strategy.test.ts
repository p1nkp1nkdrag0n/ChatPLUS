import { describe, expect, it } from "vitest";

import { deriveReplyStrategy } from "./reply-strategy.js";

describe("deriveReplyStrategy", () => {
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
});
