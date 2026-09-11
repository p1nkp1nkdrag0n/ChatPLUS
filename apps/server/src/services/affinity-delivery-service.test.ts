import { describe, expect, it, vi } from "vitest";
import { deriveReplyStrategy } from "@personasim/features";
import type { AgentTurnDecision } from "../domain/schemas.js";
import type { LlmService } from "./llm-service.js";
import { replyTextHash } from "./semantic-reply-guard.js";
import { TurnLlmCallBudget } from "./turn-llm-call-budget.js";
import {
  AffinityDeliveryService,
  finalizeAffinityDeliveryAudit,
  visibleReplyCharacters,
} from "./affinity-delivery-service.js";

const LONG = "今天有不少小事想与你慢慢聊。".repeat(10);
const SHORT = "今天过得还不错，想听听你的近况。";
function decision(text = LONG): AgentTurnDecision {
  return {
    reply: { text, chunks: [text], toneTags: [] },
    scheduleEffects: [],
    memoryCandidates: [],
    reasonCode: "persona_chat_reply",
    reasonSummary: "测试角色对话",
  };
}
function setup(limit = 12) {
  const generateObject = vi.fn().mockResolvedValue({ text: SHORT });
  const captured = {
    capabilities: { maxContextTokens: 131_072, maxOutputTokens: 32_768 },
    generateObject,
  } as unknown as LlmService;
  const budget = new TurnLlmCallBudget(limit);
  const input = {
    llm: budget.bind(captured),
    agentId: "agent-affinity",
    userText: "今天想跟你聊两句。",
    generationSystem: "固定人格",
    generationPrompt: "固定历史",
    strategy: deriveReplyStrategy(
      "今天想跟你聊两句。",
      { averageMessageLength: 45, verbosity: 0.4 },
      { relationship: { closeness: 0.1 } },
    ),
    decision: decision(),
    authoritativeEffects: { frozen: true },
    allowRewrite: true,
    qualityRepairAttempted: false,
    budget,
    reservedFinalReviewCalls: 0,
    materialize: (text: string) => decision(text).reply,
    inspect: vi.fn().mockReturnValue([]),
  };
  return { input, generateObject, budget };
}

describe("single-affinity final delivery", () => {
  it("counts complete visible Unicode graphemes across bubbles, without counting whitespace twice", () => {
    expect(visibleReplyCharacters("你\n 好 👨‍👩‍👧‍👦 e\u0301")).toBe(4);
  });

  it("rewrites at most once and keeps every non-reply decision field unchanged", async () => {
    const { input, generateObject, budget } = setup();
    const before = structuredClone(input.decision);
    const result = await new AffinityDeliveryService().resolve(input);
    expect(generateObject).toHaveBeenCalledOnce();
    expect(generateObject.mock.calls[0]![0]).toMatchObject({
      purpose: "rewrite_reply_affinity",
      maxRetries: 0,
    });
    expect(result.decision.reply.text).toBe(SHORT);
    expect(result.decision.scheduleEffects).toBe(
      input.decision.scheduleEffects,
    );
    expect(result.decision.memoryCandidates).toBe(
      input.decision.memoryCandidates,
    );
    expect(input.decision).toEqual(before);
    expect(result.audit).toMatchObject({
      rewriteStatus: "rewritten",
      initialOverUpper: true,
      finalOverUpper: false,
      logicalCalls: 1,
    });
    expect(result.audit.finalTextSha256).toBe(replyTextHash(SHORT));
    const afterGoalReview = finalizeAffinityDeliveryAudit(
      result.audit,
      decision("最终目标复核后的完整回复。").reply,
      budget,
    );
    expect(afterGoalReview.finalTextSha256).toBe(
      replyTextHash("最终目标复核后的完整回复。"),
    );
    expect(afterGoalReview.finalCharacters).toBe(
      visibleReplyCharacters("最终目标复核后的完整回复。"),
    );
  });

  it.each([
    ["authoritative_presentation", { allowRewrite: false }],
    ["quality_repair_precedence", { qualityRepairAttempted: true }],
  ] as const)("skips %s without spending calls", async (status, changes) => {
    const { input, generateObject } = setup();
    const result = await new AffinityDeliveryService().resolve({
      ...input,
      ...changes,
    });
    expect(result.decision).toBe(input.decision);
    expect(result.audit.rewriteStatus).toBe(status);
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("reserves the complete final goal-review allowance", async () => {
    const { input, generateObject } = setup(3);
    const result = await new AffinityDeliveryService().resolve({
      ...input,
      reservedFinalReviewCalls: 3,
    });
    expect(result.audit.rewriteStatus).toBe("budget_exhausted");
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("does not expand a high-affinity short reply or rewrite explicit requested detail", async () => {
    const { input, generateObject } = setup();
    const short = await new AffinityDeliveryService().resolve({
      ...input,
      decision: decision("嗯，好。"),
    });
    expect(short.audit.rewriteStatus).toBe("not_needed");
    const detailed = await new AffinityDeliveryService().resolve({
      ...input,
      strategy: deriveReplyStrategy(
        "请详细分析原因。",
        { averageMessageLength: 45 },
        { relationship: { closeness: 0.9 } },
      ),
    });
    expect(detailed.audit.rewriteStatus).toBe("ineligible");
    expect(generateObject).not.toHaveBeenCalled();
  });

  it.each(["network", "invalid", "still_long"])(
    "preserves the valid original after a %s rewrite failure",
    async (failure) => {
      const { input, generateObject } = setup();
      if (failure === "network")
        generateObject.mockRejectedValue(new Error("network unavailable"));
      if (failure === "invalid")
        input.inspect.mockReturnValue([{ code: "unsupported_fact" }]);
      if (failure === "still_long")
        generateObject.mockResolvedValue({ text: LONG });
      const result = await new AffinityDeliveryService().resolve(input);
      expect(generateObject).toHaveBeenCalledOnce();
      expect(result.decision).toBe(input.decision);
      expect(result.audit.finalOverUpper).toBe(true);
      expect(result.audit.rewriteStatus).toBe(
        failure === "network" ? "rewrite_failed" : "rewrite_rejected",
      );
    },
  );
});

describe("shared turn logical-call budget", () => {
  it("counts attempted calls across purposes and enforces the total independently of style", async () => {
    const { input, generateObject, budget } = setup(2);
    const shape = generateObject;
    const request = {
      purpose: "chat_turn",
      system: "",
      prompt: "",
      schema: input.strategy,
    };
    await input.llm.generateObject(request as never);
    await input.llm.generateObject({
      ...request,
      purpose: "review_reply_goal",
    } as never);
    expect(() => input.llm.generateObject(request as never)).toThrow(
      "本轮模型调用已达到上限",
    );
    expect(shape).toHaveBeenCalledTimes(2);
    expect(budget.purposes).toEqual(["chat_turn", "review_reply_goal"]);
  });
});
