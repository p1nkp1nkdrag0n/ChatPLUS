import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ReplyGoalReviewSchema,
  ReplyGoalRewriteSchema,
} from "@personasim/contracts";
import type { AgentTurnDecision } from "../domain/schemas.js";
import type { LlmService } from "./llm-service.js";
import { ReplyGoalReviewService } from "./reply-goal-review-service.js";
import { replyTextHash } from "./semantic-reply-guard.js";

const pass = {
  goalAchieved: true,
  explanation: "回应了当前请求。",
  deviations: [],
  revisionInstructions: "",
};
const fail = {
  goalAchieved: false,
  explanation: "遗漏关键请求。",
  deviations: ["没有回答原因"],
  revisionInstructions: "补充具体原因。",
};

function setup(
  outputs: unknown[],
  options: { contextTokens?: number; allowRewrite?: boolean } = {},
) {
  const queue = [...outputs];
  const generateObject = vi.fn(() => {
    const result = queue.shift();
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  });
  const decision: AgentTurnDecision = {
    reply: { text: "原始候选。", chunks: ["原始候选。"], toneTags: ["自然"] },
    scheduleEffects: [],
    memoryCandidates: [],
    reasonCode: "persona_chat_reply",
    reasonSummary: "原始已验证决定。",
  };
  const input = {
    llm: {
      generateObject,
      capabilities: {
        maxContextTokens: options.contextTokens ?? 32_000,
        maxOutputTokens: 16_384,
      },
    } as unknown as LlmService,
    agentId: "agent-test",
    userText: "请说明原因。",
    generationSystem: "已投递角色定义",
    generationPrompt: "已投递受控上下文",
    decision,
    authoritativeEffects: { scheduleChanges: [] },
    allowRewrite: options.allowRewrite ?? true,
    materialize: (text: string) => ({ text, chunks: [text], toneTags: [] }),
    inspect: vi.fn((): unknown[] => []),
  };
  return { input, generateObject, service: new ReplyGoalReviewService() };
}

describe("bounded reply goal review", () => {
  it("accepts one independent review without rewriting and preserves the exact decision", async () => {
    const { input, service, generateObject } = setup([pass]);
    const result = await service.resolve(input);
    expect(result.decision).toBe(input.decision);
    expect(result.audit).toMatchObject({
      reviewCalls: 1,
      rewriteAttempted: false,
      finalTextSha256: replyTextHash(input.decision.reply.text),
    });
    expect(generateObject).toHaveBeenCalledTimes(1);
    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "review_reply_goal", maxRetries: 0 }),
    );
  });

  it("reviews the materialized final reply and cannot replace non-text effects", async () => {
    const { input, service, generateObject } = setup([
      fail,
      { text: "新的说明。" },
      pass,
    ]);
    input.materialize = (text) => ({
      text: text + "\n第二段。",
      chunks: [text, "第二段。"],
      toneTags: [],
    });
    const result = await service.resolve(input);
    expect(result.decision.scheduleEffects).toBe(
      input.decision.scheduleEffects,
    );
    expect(result.decision.memoryCandidates).toBe(
      input.decision.memoryCandidates,
    );
    expect(result.decision.reasonCode).toBe(input.decision.reasonCode);
    expect(generateObject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        purpose: "rewrite_reply_goal",
        maxRetries: 0,
      }),
    );
    const call = generateObject.mock.calls[2] as unknown as [
      { prompt: string },
    ];
    const parsed = JSON.parse(call[0].prompt) as { candidate: unknown };
    expect(parsed.candidate).toEqual(result.decision.reply);
    const rewriteCall = generateObject.mock.calls[1] as unknown as [
      { prompt: string },
    ];
    expect(rewriteCall[0].prompt).toContain("补充具体原因");
    expect(result.audit).toMatchObject({
      reviewCalls: 2,
      rewriteAttempted: true,
      finalTextSha256: replyTextHash(result.decision.reply.text),
    });
  });

  it.each([
    [
      "first review transport failure",
      [new Error("provider token must stay private")],
      "reply_goal_review_unavailable",
      1,
    ],
    [
      "malformed pass",
      [{ ...pass, deviations: ["unresolved"] }],
      "reply_goal_review_unavailable",
      1,
    ],
    [
      "rewrite transport failure",
      [fail, new Error("failed")],
      "reply_goal_rewrite_unavailable",
      2,
    ],
    [
      "effect injection",
      [fail, { text: "新回复", stateDelta: { energy: 1 } }],
      "reply_goal_rewrite_unavailable",
      2,
    ],
    [
      "second rejection",
      [fail, { text: "新的说明。" }, fail],
      "reply_goal_review_failed",
      3,
    ],
    [
      "second review failure",
      [fail, { text: "新的说明。" }, new Error("failed")],
      "reply_goal_review_unavailable",
      3,
    ],
  ])(
    "fails closed on %s with bounded calls",
    async (_label, outputs, code, count) => {
      const { input, service, generateObject } = setup(outputs as unknown[]);
      await expect(service.resolve(input)).rejects.toMatchObject({
        statusCode: 502,
        code,
      });
      expect(generateObject).toHaveBeenCalledTimes(count);
      expect(input.decision.reply.text).toBe("原始候选。");
    },
  );

  it("rejects a rule-invalid revision before any further model call", async () => {
    const { input, service, generateObject } = setup([
      fail,
      { text: "作为AI，我已经替你改了日程。" },
      pass,
    ]);
    input.inspect.mockReturnValue([{ code: "uncommitted_schedule_claim" }]);
    await expect(service.resolve(input)).rejects.toMatchObject({
      code: "reply_goal_rewrite_invalid",
    });
    expect(generateObject).toHaveBeenCalledTimes(2);
  });

  it("never rewrites an authoritative presentation after rejection", async () => {
    const { input, service, generateObject } = setup([fail], {
      allowRewrite: false,
    });
    await expect(service.resolve(input)).rejects.toMatchObject({
      code: "reply_goal_review_failed",
    });
    expect(generateObject).toHaveBeenCalledTimes(1);
  });

  it("adjusts output budget without trimming admitted context", async () => {
    const { input, service, generateObject } = setup(
      [fail, { text: "新回复。" }, pass],
      { contextTokens: 8_000 },
    );
    await service.resolve(input);
    for (const args of generateObject.mock.calls as unknown as [
      { maxOutputTokens: number; prompt: string },
    ][]) {
      expect(args[0].maxOutputTokens).toBeLessThan(8_000);
      expect(args[0].prompt).toContain(input.generationPrompt);
    }
  });

  it("reports exhausted context capacity before dispatch", async () => {
    const { input, service, generateObject } = setup([pass], {
      contextTokens: 2_000,
    });
    await expect(service.resolve(input)).rejects.toMatchObject({
      code: "reply_goal_review_context_exceeded",
    });
    expect(generateObject).not.toHaveBeenCalled();
  });

  it("uses a provider-compatible object schema with runtime verdict consistency", () => {
    expect(z.toJSONSchema(ReplyGoalReviewSchema).type).toBe("object");
    expect(
      ReplyGoalReviewSchema.safeParse({ ...fail, deviations: [] }).success,
    ).toBe(false);
    expect(ReplyGoalReviewSchema.safeParse(pass).success).toBe(true);
    expect(
      ReplyGoalRewriteSchema.safeParse({ text: "新回复", worldEffects: {} })
        .success,
    ).toBe(false);
  });
});
