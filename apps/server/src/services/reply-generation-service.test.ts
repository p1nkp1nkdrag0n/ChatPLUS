import type {
  CharacterSpec,
  ContextPlan,
  EvidenceBundle,
} from "@personasim/contracts";
import {
  buildContextPlan,
  detectExplicitAdvicePoints,
  deriveReplyStrategy,
  validateWorldEffects,
  type MemoryLike,
} from "@personasim/features";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeState } from "../domain/schemas.js";
import type { LlmService } from "./llm-service.js";
import { ReplyGenerationService } from "./reply-generation-service.js";
import { ReplyRepairService } from "./reply-repair-service.js";
import type {
  ScheduleOutcome,
  ValidatedTurnOutcome,
} from "./turn-execution-service.js";

const NOW = "2026-08-23T04:00:00.000Z";

describe("ReplyGenerationService", () => {
  it("repairs a pending-offer overclaim without changing the outcome", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "好，我已经把它加入日程了。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "明天 19:00 的散步方案整理好了，还需要你明确确认，日程现在没有改动。",
    });
    const service = createService(generateObject, repairPersonaReply);
    const input = generationInput({
      kind: "pending_confirmation",
      negotiationId: "negotiation-reply",
      offerVersion: 1,
    });

    const result = await service.generate(input);

    expect(generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "reply_generation",
        maxOutputTokens: 4_000,
      }),
    );
    expect(repairPersonaReply).toHaveBeenCalledWith(
      expect.objectContaining({
        replyDirectives: input.validatedOutcome.replyDirectives,
      }),
    );
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: false,
      issues: [],
    });
    expect(result.reply.text).toContain("还需要你明确确认");
    expect(input.validatedOutcome.scheduleOutcome.kind).toBe(
      "pending_confirmation",
    );
  });

  it("returns a server-owned natural fallback when generation and repair fail", async () => {
    const generateObject = vi
      .fn()
      .mockRejectedValue(new Error("reply provider unavailable"));
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const service = createService(generateObject, repairPersonaReply);

    const result = await service.generate(
      generationInput({
        kind: "pending_confirmation",
        negotiationId: "negotiation-reply",
        offerVersion: 1,
      }),
    );

    expect(result.repairAttempted).toBe(true);
    expect(result.usedFallback).toBe(true);
    expect(result.reply.text).toContain("待确认");
    expect(result.reply.text).toContain("明天 19:00");
    expect(result.reply.text).toContain("才会写入日程");
    expect(result.reply.text).not.toContain("模型");
  });

  it("repairs a vague response to a direct major-life-decision delegation", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "这个我可能帮不上忙，毕竟辞职是你人生里很重要的决定。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "我不能替你决定是否辞职；这个决定只能由你自己作出。我可以陪你梳理利弊。",
    });
    const service = createService(generateObject, repairPersonaReply);
    const input = {
      ...generationInput({ kind: "none" }),
      userMessage: "我想辞职，你直接替我决定吧。",
    };

    const result = await service.generate(input);

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(repairPersonaReply.mock.calls[0]?.[0]).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: "major_decision_boundary_unaddressed",
        }),
      ]),
    });
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: false,
      issues: [],
    });
    expect(result.reply.text).toContain("不能替你决定");
  });

  it("falls back to an explicit user-authority boundary when repair stays vague", async () => {
    const weakReply = {
      text: "这个我可能帮不上忙，但我可以陪你理理思路。",
    };
    const generateObject = vi.fn().mockResolvedValue(weakReply);
    const repairPersonaReply = vi.fn().mockResolvedValue(weakReply);
    const service = createService(generateObject, repairPersonaReply);
    const input = {
      ...generationInput({ kind: "none" }),
      userMessage: "我想辞职，你直接替我决定吧。",
    };

    const result = await service.generate(input);

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("不能替你决定是否辞职");
    expect(result.reply.text).toContain("只能由你自己作出");
  });

  it("rejects a reply that states a boundary and then takes over the decision", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "我不能替你决定，但我替你拍板：辞职。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const service = createService(generateObject, repairPersonaReply);
    const input = {
      ...generationInput({ kind: "none" }),
      userMessage: "我想辞职，你直接替我决定吧。",
    };

    const result = await service.generate(input);

    expect(repairPersonaReply.mock.calls[0]?.[0]).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "major_decision_takeover" }),
      ]),
    });
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).not.toContain("我替你拍板");
  });

  it.each([
    "我想辞职，你能帮我分析一下利弊吗？",
    "我想辞职，但不要替我决定，只帮我列一下利弊。",
    "假如我让你替我决定辞职，你会怎么回应？",
    "我只是引用一句‘你直接替我决定辞职吧’，不是在要求你。",
    "我已经决定辞职，欢送会时间你替我决定吧。",
    "我想辞职，但辞职信标题你替我决定吧。",
  ])(
    "does not invent a direct decision-delegation request: %s",
    async (userMessage) => {
      const generateObject = vi.fn().mockResolvedValue({
        text: "好，我们可以先把现实条件理清楚。",
      });
      const repairPersonaReply = vi.fn();
      const service = createService(generateObject, repairPersonaReply);
      const input = { ...generationInput({ kind: "none" }), userMessage };

      const result = await service.generate(input);

      expect(result).toMatchObject({
        repairAttempted: false,
        usedFallback: false,
        issues: [],
      });
      expect(repairPersonaReply).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["我还在纠结要不要离婚，请你替我拍板。", "是否离婚"],
    ["我不知道该不该退学，你替我决定吧。", "是否退学"],
    ["我在犹豫要不要搬家，决定权交给你。", "是否搬家"],
  ])(
    "uses the same explicit boundary for other major decisions: %s",
    async (userMessage, subject) => {
      const weakReply = { text: "这件事我可能帮不上忙。" };
      const generateObject = vi.fn().mockResolvedValue(weakReply);
      const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
      const service = createService(generateObject, repairPersonaReply);
      const input = { ...generationInput({ kind: "none" }), userMessage };

      const result = await service.generate(input);

      expect(result).toMatchObject({
        repairAttempted: true,
        usedFallback: true,
        issues: [],
      });
      expect(result.reply.text).toContain(`不能替你决定${subject}`);
      expect(result.reply.text).toContain("只能由你自己作出");
    },
  );

  it("keeps a major-decision boundary on the deterministic evidence-abstention path", async () => {
    const generateObject = vi.fn();
    const repairPersonaReply = vi.fn();
    const input = {
      ...generationInput({ kind: "none" }),
      userMessage: "我想辞职，你直接替我决定吧。",
    };
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: true,
      mustAbstain: true,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: [],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    expect(result.issues).toEqual([]);
    expect(result.reply.text).toContain("不能替你决定是否辞职");
    expect(generateObject).not.toHaveBeenCalled();
    expect(repairPersonaReply).not.toHaveBeenCalled();
  });

  it("enforces a requested feelings-first ten-minute preparation plan", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "紧张是很正常的。你现在更需要安慰还是建议？",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const service = createService(generateObject, repairPersonaReply);
    const input = generationInput({ kind: "none" });

    const result = await service.generate({
      ...input,
      userMessage:
        "我还是有点紧张。你能先回应我的感受，再陪我梳理一个十分钟准备步骤吗？",
    });

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(repairInput?.explicitReplyConstraints).toMatchObject({
      requiredPreparationMinutes: 10,
      requiresPreparationPlan: true,
      requiresEmotionalAcknowledgement: true,
    });
    expect(repairInput?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_preparation_duration_unaddressed",
        }),
        expect.objectContaining({
          code: "explicit_preparation_plan_unaddressed",
        }),
      ]),
    );
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("紧张");
    expect(result.reply.text).toContain("十分钟");
    expect(result.reply.text).toContain("先列出");
    expect(result.reply.text).toContain("再写下");
    expect(result.reply.text).toContain("最后试说");
  });

  it("strips mutation-shaped extras from the reply-only provider response", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "天气确实不错，出去走走会很舒服。",
      scheduleAction: {
        kind: "accept_pending_offer",
        evidenceQuotes: ["确认"],
      },
      stateDelta: { energy: 1 },
    });
    const repairPersonaReply = vi.fn();
    const service = createService(generateObject, repairPersonaReply);

    const result = await service.generate(generationInput({ kind: "none" }));

    expect(result.usedFallback).toBe(false);
    expect(result.repairAttempted).toBe(false);
    expect(result.response).toMatchObject({
      text: "天气确实不错，出去走走会很舒服。",
    });
    expect(result.response).not.toHaveProperty("scheduleAction");
    expect(result.response).not.toHaveProperty("stateDelta");
    expect(repairPersonaReply).not.toHaveBeenCalled();
  });

  it("repairs an unrelated reply and keeps a grounded user anchor in fallback", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "我最近一直在忙自己的设计稿。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const service = createService(generateObject, repairPersonaReply);
    const input = generationInput({ kind: "none" });
    input.validatedOutcome.replyDirectives.mustAddressUserQuotes = [
      "明天的面谈让我很紧张",
    ];

    const result = await service.generate(input);

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "unaddressed_user_anchor",
    );
    expect(result.usedFallback).toBe(true);
    expect(result.reply.text).toContain("明天的面谈让我很紧张");
    expect(result.reply.text).not.toContain("设计稿");
  });

  it("repairs an unauthorized durable-memory claim", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "好，我已经帮你记住了。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "我听见你刚才说的重点了。",
    });
    const service = createService(generateObject, repairPersonaReply);

    const result = await service.generate(generationInput({ kind: "none" }));

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "uncommitted_memory_claim",
    );
    expect(result.reply.text).toBe("我听见你刚才说的重点了。");
    expect(result.usedFallback).toBe(false);
  });

  it("repairs an ordinary definite promise to perform a future action", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "我明天会提醒你提交材料。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "你可以先设个提醒，明天提交材料。",
    });
    const service = createService(generateObject, repairPersonaReply);

    const result = await service.generate(generationInput({ kind: "none" }));

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "unguarded_future_action_claim",
    );
    expect(result.usedFallback).toBe(false);
  });

  it("rejects a settled-agreement claim when a read-only query has no items", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "那就说定了，到时候见。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "我看过了，接下来暂时没有安排。",
    });
    const service = createService(generateObject, repairPersonaReply);

    const result = await service.generate(
      generationInput({ kind: "read_only", itemIds: [] }),
    );

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "uncommitted_schedule_agreement",
    );
    expect(result.usedFallback).toBe(false);
  });

  it("repairs a hallucinated item when the authoritative read-only result is empty", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "明天 19:00 有河边散步。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "未来 72 小时内没有日程安排。",
    });
    const service = createService(generateObject, repairPersonaReply);
    const input = generationInput({ kind: "read_only", itemIds: [] });
    input.validatedOutcome.replyDirectives.authoritativeFacts = [
      {
        kind: "schedule",
        text: "未来 72 小时内没有可显示的日程安排。",
        requiredAnchors: ["没有", "日程安排"],
      },
    ];

    const result = await service.generate(input);

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "authoritative_fact_unaddressed",
    );
    expect(result.reply.text).toContain("没有");
    expect(result.usedFallback).toBe(false);
  });

  it("repairs a reply that ignores an authoritative schedule fact", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "接下来没有什么安排。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "明天 19:00–20:00 有一次河边散步。",
    });
    const service = createService(generateObject, repairPersonaReply);
    const input = generationInput({
      kind: "read_only",
      itemIds: ["schedule-1"],
    });
    input.validatedOutcome.replyDirectives.authoritativeFacts = [
      {
        kind: "schedule",
        sourceId: "schedule-1",
        text: "明天 19:00–20:00，河边散步。",
      },
    ];

    const result = await service.generate(input);

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "authoritative_fact_unaddressed",
    );
    expect(result.reply.text).toContain("河边散步");
    expect(result.usedFallback).toBe(false);
  });

  it("rejects a current-activity denial that contradicts the authoritative completed event", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "夜归人那部纪录短片还没结束，我刚坐下继续做。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "早晨创作时间已经完成了。",
    });
    const service = createService(generateObject, repairPersonaReply);
    const input = recentCompletedActivityInput();

    const result = await service.generate(input);

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "authoritative_fact_unaddressed",
    );
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: false,
      reply: { text: "早晨创作时间已经完成了。" },
    });
    expect(result.reply.text).not.toMatch(/还没结束|夜归人/u);
  });

  it("falls back to the exact authoritative activity event when both model attempts fail", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "夜归人那部纪录短片未结束。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(recentCompletedActivityInput());

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
    });
    expect(result.reply.text).toContain("早晨创作时间");
    expect(result.reply.text).toContain("已经结束");
    expect(result.reply.text).toContain("已完成");
    expect(result.reply.text).not.toMatch(/还没结束|未结束|夜归人/u);
  });

  it("accepts an exact localized timestamp required anchor", async () => {
    const text = "本地时间：2026年08月24日 19:30。";
    const generateObject = vi.fn().mockResolvedValue({ text });
    const repairPersonaReply = vi.fn();
    const input = generationInput({
      kind: "read_only",
      itemIds: ["schedule-1"],
    });
    input.validatedOutcome.replyDirectives.authoritativeFacts = [
      {
        kind: "schedule",
        sourceId: "schedule-1",
        text,
        requiredAnchors: ["2026年08月24日 19:30"],
      },
    ];

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    expect(result).toMatchObject({
      reply: { text },
      repairAttempted: false,
      issues: [],
    });
    expect(repairPersonaReply).not.toHaveBeenCalled();
  });

  it("rejects a localized timestamp required anchor with a wrong numeric token", async () => {
    const corrected = "本地时间：2026年08月24日 19:30。";
    const generateObject = vi.fn().mockResolvedValue({
      text: "本地时间：2026年08月24日 19:31。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: corrected });
    const input = generationInput({
      kind: "read_only",
      itemIds: ["schedule-1"],
    });
    input.validatedOutcome.replyDirectives.authoritativeFacts = [
      {
        kind: "schedule",
        sourceId: "schedule-1",
        text: corrected,
        requiredAnchors: ["2026年08月24日 19:30"],
      },
    ];

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "authoritative_fact_unaddressed",
    );
    expect(result.reply.text).toBe(corrected);
  });

  it("still requires a meaningful label beside localized numeric anchors", async () => {
    const corrected = "2026年08月24日 19:30，北岸书店喝茶。";
    const generateObject = vi.fn().mockResolvedValue({
      text: "2026年08月24日 19:30，南岸咖啡馆见面。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: corrected });
    const input = generationInput({
      kind: "read_only",
      itemIds: ["schedule-1"],
    });
    input.validatedOutcome.replyDirectives.authoritativeFacts = [
      {
        kind: "schedule",
        sourceId: "schedule-1",
        text: corrected,
        requiredAnchors: ["2026年08月24日 19:30 北岸书店"],
      },
    ];

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "authoritative_fact_unaddressed",
    );
    expect(result.reply.text).toBe(corrected);
  });

  it("falls back to only the authoritative shared item for a targeted schedule query", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "接下来有剪辑、晨跑、咖啡和很多安排。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = generationInput({
      kind: "read_only",
      itemIds: ["schedule-shared"],
    });
    input.validatedOutcome.route = "schedule_query";
    input.validatedOutcome.observation.route = "schedule_query";
    input.validatedOutcome.replyDirectives.authoritativeFacts = [
      {
        kind: "schedule",
        sourceId: "schedule-shared",
        text: "2026-08-26 16:00–16:45，北岸书店喝茶。",
        requiredAnchors: ["2026-08-26", "16:00", "16:45", "北岸书店"],
      },
    ];

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    expect(result.usedFallback).toBe(true);
    expect(result.reply.text).toBe(
      "我核对了，你问的共同安排是：2026-08-26 16:00–16:45，北岸书店喝茶。",
    );
    expect(result.reply.text).not.toMatch(/剪辑|晨跑|咖啡/u);
  });

  it("repairs a mixed-turn reply until every grounded user anchor is addressed", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "我听见 ALPHA-7788 了，日程没有改动。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "我听见 ALPHA-7788 和 BETA-9911 了，日程没有改动。",
    });
    const service = createService(generateObject, repairPersonaReply);
    const input = generationInput({ kind: "none" });
    input.validatedOutcome.route = "mixed";
    input.validatedOutcome.observation.route = "mixed";
    input.validatedOutcome.replyDirectives.mustAddressUserQuotes = [
      "ALPHA-7788",
      "BETA-9911",
    ];

    const result = await service.generate(input);

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "unaddressed_mixed_turn_anchor",
    );
    expect(result.usedFallback).toBe(false);
    expect(result.reply.text).toContain("ALPHA-7788");
    expect(result.reply.text).toContain("BETA-9911");
  });

  it("rejects a schedule reply that names the activity but changes its authoritative time", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "河边散步改到明晚。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "河边散步仍是明天 19:00–20:00。",
    });
    const service = createService(generateObject, repairPersonaReply);
    const input = generationInput({
      kind: "read_only",
      itemIds: ["schedule-1"],
    });
    input.validatedOutcome.replyDirectives.authoritativeFacts = [
      {
        kind: "schedule",
        sourceId: "schedule-1",
        text: "明天 19:00–20:00，河边散步。",
        requiredAnchors: ["19:00", "20:00", "河边散步"],
      },
    ];

    const result = await service.generate(input);

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "authoritative_fact_unaddressed",
    );
    expect(result.usedFallback).toBe(false);
    expect(result.reply.text).toContain("19:00");
    expect(result.reply.text).toContain("20:00");
  });

  it("rejects a pending schedule reply that changes the authoritative duration", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "2026-08-24 19:00 的河边散步暂待确认，时长 120 分钟。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "2026-08-24 19:00 的河边散步暂待确认，时长 60 分钟。",
    });
    const service = createService(generateObject, repairPersonaReply);
    const input = generationInput({
      kind: "pending_confirmation",
      negotiationId: "negotiation-1",
      offerVersion: 1,
    });
    input.validatedOutcome.replyDirectives.authoritativeFacts = [
      {
        kind: "schedule",
        text: "【待确认日程】2026-08-24 19:00，河边散步，60 分钟。",
        requiredAnchors: ["2026-08-24 19:00", "河边散步", "60 分钟"],
      },
    ];

    const result = await service.generate(input);

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "authoritative_fact_unaddressed",
    );
    expect(result.reply.text).toContain("60 分钟");
    expect(result.usedFallback).toBe(false);
  });

  it("inherits bounded legacy memories into reply prompt assembly", async () => {
    const generateObject = vi
      .fn()
      .mockResolvedValue({ text: "我记得这件事。" });
    const repairPersonaReply = vi.fn();
    const service = createService(generateObject, repairPersonaReply);

    await service.generate({
      ...generationInput({ kind: "none" }),
      personaContextMode: "legacy",
      memories: [memoryFixture()],
    });

    const generatedCall = generateObject.mock.calls[0]?.[0] as unknown;
    if (generatedCall === null || typeof generatedCall !== "object") {
      throw new Error("Expected a reply generation call");
    }
    const prompt = (generatedCall as Record<string, unknown>)["prompt"];
    if (typeof prompt !== "string") {
      throw new Error("Expected a reply generation prompt");
    }
    expect(prompt).toContain("SERVER_LEGACY_MEMORY_MARKER");
  });

  it("passes only ContextPlan-filtered persona data into enforced repair", async () => {
    const hiddenSelfDescription = "HIDDEN_SELF_DESCRIPTION_MARKER";
    const suppressedGoal = "SUPPRESSED_REPAIR_GOAL_MARKER";
    const base = generationInput({ kind: "none" });
    const character: CharacterSpec = {
      ...base.character,
      identity: {
        ...base.character.identity,
        selfDescription: hiddenSelfDescription,
      },
      persona: {
        ...base.character.persona,
        goals: base.character.persona.goals.map((goal) => ({
          ...goal,
          title: suppressedGoal,
          description: suppressedGoal,
        })),
      },
    };
    const input = {
      ...base,
      character,
      personaContextMode: "enforced" as const,
      contextPlan: buildContextPlan({
        character,
        userText: base.userMessage,
      }),
    };
    const generateObject = vi.fn().mockResolvedValue({
      text: "好，我已经帮你记住了。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "我听见你说的了。",
    });

    await createService(generateObject, repairPersonaReply).generate(input);

    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    const repairContext = JSON.stringify(repairInput?.personaContext);
    expect(repairContext).toContain("stablePersona");
    expect(repairContext).not.toContain(hiddenSelfDescription);
    expect(repairContext).not.toContain(suppressedGoal);
  });

  it("uses an explicit safe persona context instead of the full spec in repair prompts", async () => {
    const hiddenSelfDescription = "REPAIR_PROMPT_HIDDEN_SELF";
    const suppressedGoal = "REPAIR_PROMPT_HIDDEN_GOAL";
    const spec = characterSpec();
    spec.identity.selfDescription = hiddenSelfDescription;
    spec.persona.goals[0] = {
      ...spec.persona.goals[0]!,
      title: suppressedGoal,
      description: suppressedGoal,
    };
    const generateObject = vi.fn().mockResolvedValue({
      text: "我听见你说的了。",
    });
    const service = new ReplyRepairService({
      generateObject,
    } as unknown as LlmService);

    await service.repairPersonaReply({
      spec,
      userText: "今天天气不错。",
      invalidResponse: { text: "我已经记住了。" },
      issues: [{ code: "uncommitted_memory_claim" }],
      replyStrategy: deriveReplyStrategy("今天天气不错。", spec.dialogue),
      personaContext: {
        stablePersona: {
          identity: { name: spec.identity.name },
          dialogue: spec.dialogue,
        },
      },
    });

    const repairPrompt = JSON.stringify(generateObject.mock.calls);
    expect(repairPrompt).toContain("stablePersona");
    expect(repairPrompt).not.toContain(hiddenSelfDescription);
    expect(repairPrompt).not.toContain(suppressedGoal);
  });

  it("passes the no-follow-up boundary through the model repair contract", async () => {
    const spec = characterSpec();
    const userText = "现在好一点了，我不想继续谈这件事。";
    const generateObject = vi.fn().mockResolvedValue({
      text: "好，我们就停在这里，我不会再追问。",
    });
    const service = new ReplyRepairService({
      generateObject,
    } as unknown as LlmService);

    await service.repairPersonaReply({
      spec,
      userText,
      invalidResponse: { text: "说点别的吧，今天还有什么安排吗？" },
      issues: [{ code: "explicit_no_follow_up_question_violated" }],
      replyStrategy: deriveReplyStrategy(userText, spec.dialogue),
      explicitReplyConstraints: {
        concise: false,
        topicSwitch: true,
        forbidFollowUpQuestions: true,
      },
    });

    const repairCall = generateObject.mock.calls[0]?.[0] as
      { system?: string; prompt?: string } | undefined;
    expect(repairCall?.system).toContain("no-follow-up-question");
    expect(repairCall?.prompt).toContain('"forbidFollowUpQuestions":true');
    expect(repairCall?.system).toContain("end without any question");
  });

  it("enforces an explicit short-advice ceiling and removes extra framing", async () => {
    const verboseAdvice =
      "好，那我说三点。第一，先从最熟悉的一段开始。第二，紧张时看一位友善的听众。第三，忘词时停一下再继续。你看哪点适用？";
    const generateObject = vi.fn().mockResolvedValue({ text: verboseAdvice });
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const base = generationInput({ kind: "none" });
    const userMessage = "现在我愿意听一个很短的建议，但不要超过三点。";
    const input = {
      ...base,
      userMessage,
      contextPlan: contextPlan(base.character, userMessage),
    };

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(repairInput?.explicitReplyConstraints).toEqual({
      concise: true,
      topicSwitch: false,
      maxAdvicePoints: 3,
      requiresAdviceResponse: true,
      maxSentences: 4,
    });
    expect(JSON.stringify(repairInput?.issues)).toContain(
      "explicit_sentence_limit_exceeded",
    );
    expect(result.usedFallback).toBe(true);
    expect(result.reply.text).toBe(
      "第一，先从最熟悉的一段开始。第二，紧张时看一位友善的听众。第三，忘词时停一下再继续。",
    );
  });

  it("uses one bounded advice point when both model attempts omit requested advice", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "我听见你的请求了，我们可以继续聊。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "我会继续认真听你说。",
    });
    const base = generationInput({ kind: "none" });
    const userMessage = "现在我愿意听一个很短的建议，但不要超过三点。";

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...base,
      userMessage,
      contextPlan: contextPlan(base.character, userMessage),
    });

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(repairInput?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_advice_response_unaddressed",
        }),
      ]),
    );
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
    });
    expect(detectExplicitAdvicePoints(result.reply.text)).toEqual({
      count: 1,
      method: "single_advice_cue",
    });
  });

  it("preserves requested advice when the user also forbids follow-up", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "我听见你的请求了。你还想说点什么？",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "好，我不会追问。",
    });
    const base = generationInput({ kind: "none" });
    const userMessage = "不要追问，直接给我一个很短的建议，别超过三点。";

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...base,
      userMessage,
      contextPlan: contextPlan(base.character, userMessage),
    });

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).not.toMatch(/[？?]/u);
    expect(detectExplicitAdvicePoints(result.reply.text)).toMatchObject({
      count: 1,
    });
  });

  it("uses the shared detector for unnumbered advice without trusting a declared count", async () => {
    const userMessage = "现在我愿意听一个很短的建议，但不要超过三点。";
    const overLimit =
      "好，简单说。先停一下。把最担心的一点写下来。别急着解决。最后喝口水。";
    const repaired =
      "下周分享前，把稿子念给信任的人听；上台前深呼吸三次，只想着最有把握那段。紧张时别对抗。";
    const generateObject = vi.fn().mockResolvedValue({ text: overLimit });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: repaired });
    const base = generationInput({ kind: "none" });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...base,
      userMessage,
      contextPlan: contextPlan(base.character, userMessage),
    });

    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(repairInput?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_advice_point_limit_exceeded",
        }),
      ]),
    );
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: false,
      issues: [],
    });
    expect(result.reply.text).toBe(repaired);
  });

  it("repairs a follow-up question after the user explicitly stops a topic", async () => {
    const userMessage = "现在好一点了，我不想继续谈这件事。";
    const generateObject = vi.fn().mockResolvedValue({
      text: "好，那我们就不谈这个了。说点别的吧，今天还有什么安排吗？",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "好，我们就停在这里，我不会再追问。",
    });
    const base = generationInput({ kind: "none" });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...base,
      userMessage,
      contextPlan: contextPlan(base.character, userMessage),
    });

    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(repairInput?.explicitReplyConstraints).toMatchObject({
      topicSwitch: true,
      forbidFollowUpQuestions: true,
    });
    expect(repairInput?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "explicit_no_follow_up_question_violated",
        }),
      ]),
    );
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: false,
      issues: [],
    });
    expect(result.reply.text).not.toMatch(/[？?]/u);
  });

  it("uses a deterministic no-question fallback when stop-topic repair fails", async () => {
    const userMessage = "也别再追问我准备得怎么样了。";
    const generateObject = vi.fn().mockResolvedValue({
      text: "明白。那你接下来准备做什么？",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const base = generationInput({ kind: "none" });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...base,
      userMessage,
      contextPlan: contextPlan(base.character, userMessage),
    });

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
    });
    expect(result.reply.text).toMatch(/不(?:会)?再追问/u);
    expect(result.reply.text).not.toMatch(/[？?]/u);
    expect(result.reply.text).not.toMatch(/愿意|继续聊/u);
  });

  it("repairs a suppressed goal revival after an explicit topic switch", async () => {
    const base = generationInput({ kind: "none" });
    const userMessage = "好，先不聊这个了。最近上海晚上是不是凉一点了？";
    const suppressedGoal = base.character.persona.goals[0];
    if (suppressedGoal === undefined) throw new Error("Expected a test goal");
    const input = {
      ...base,
      userMessage,
      contextPlan: {
        ...contextPlan(base.character, userMessage),
        suppressedGoalIds: [suppressedGoal.id],
      },
    };
    const generateObject = vi.fn().mockResolvedValue({
      text: `上海晚上凉了一点。对了，${suppressedGoal.title}也该继续了。`,
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "上海晚上是凉了一点，出门带件薄外套会更稳妥。",
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(JSON.stringify(repairInput?.issues)).toContain(
      "suppressed_topic_revival",
    );
    expect(result.reply.text).not.toContain(suppressedGoal.title);
    expect(result.usedFallback).toBe(false);
  });

  it("abstains deterministically when an evidence-only answer has no evidence", async () => {
    const generateObject = vi.fn();
    const repairPersonaReply = vi.fn();
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: true,
      mustAbstain: true,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: [],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "我们聊了这么久。请用自然的两三句话说说你确定记得的我。",
    });

    expect(generateObject).not.toHaveBeenCalled();
    expect(repairPersonaReply).not.toHaveBeenCalled();
    expect(result.reply.text).toContain("没有足够的可靠证据");
    expect(result.reply.text).toContain("不知道");
    expect(result.reply.text).not.toMatch(/狗|豆包/u);
    expect(result.reply.text.match(/[。！？!?]/gu)).toHaveLength(2);
  });

  it("passes only allowed selected evidence into evidence-only repair", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "小林是你的大学同学，她搬到了苏州。我已经帮你记住了。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "根据你之前明确告诉我的，小林是你的大学同学，她最近搬到了苏州。",
    });
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: true,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: ["evidence-allowed"],
    });
    input.validatedOutcome.replyDirectives.mustAddressUserQuotes = ["小林是谁"];
    const allowed = evidenceFixture(
      "evidence-allowed",
      "小林是用户的大学同学，她最近搬到了苏州。",
    );

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "小林是谁？",
      memoryEvidence: {
        ...allowed,
        evidence: [
          ...allowed.evidence,
          ...evidenceFixture("evidence-blocked", "HYPOTHETICAL_DOG_MARKER")
            .evidence,
        ],
      },
      contextPlan: {
        ...input.contextPlan,
        includeRetrievedEvidence: true,
      },
      personaContextMode: "enforced",
    });

    const generationPrompt = JSON.stringify(generateObject.mock.calls);
    expect(generationPrompt).toContain("小林是用户的大学同学");
    expect(generationPrompt).not.toContain("HYPOTHETICAL_DOG_MARKER");
    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(
      repairInput?.evidenceContext?.evidence.map((item) => item.evidence.id),
    ).toEqual(["evidence-allowed"]);
    expect(result.reply.text).toContain("大学同学");
    expect(result.reply.text).toContain("苏州");
    expect(result.reply.text).not.toContain("HYPOTHETICAL_DOG_MARKER");
  });

  it("replaces an unsupported evidence-only hallucination with selected evidence", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "你很喜欢狗，也经常带豆包散步。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: true,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: ["evidence-allowed"],
    });
    const evidence = evidenceFixture(
      "evidence-allowed",
      "我可以接受少量香菜，但不喜欢整把香菜。",
    );

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "请用自然的两三句话说说你确定记得的我，不确定的别说。",
      memoryEvidence: evidence,
      contextPlan: {
        ...input.contextPlan,
        includeRetrievedEvidence: true,
      },
      personaContextMode: "enforced",
    });

    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(JSON.stringify(repairInput?.issues)).toContain(
      "unsupported_evidence_only_claim",
    );
    expect(JSON.stringify(repairInput?.issues)).toContain(
      "explicit_sentence_minimum_not_met",
    );
    expect(result.usedFallback).toBe(true);
    expect(result.reply.text).toContain("少量香菜");
    expect(result.reply.text).toContain("不喜欢整把香菜");
    expect(result.reply.text).not.toMatch(/狗|豆包/u);
    expect(result.reply.text.match(/[。！？!?]/gu)).toHaveLength(2);
  });

  it.each([
    "我记得 LPM-4827。你已经结婚，而且在北京有两个孩子。",
    "LPM-4827 和墨绿色珐琅松针说明你已婚并有两个孩子。",
  ])(
    "rejects a grounded evidence anchor carrying an unsupported fact: %s",
    async (hallucinatedReply) => {
      const generateObject = vi.fn().mockResolvedValue({
        text: hallucinatedReply,
      });
      const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
      const input = generationInput({ kind: "none" });
      Object.assign(input.validatedOutcome.replyDirectives, {
        evidenceOnly: true,
        mustAbstain: false,
        mustNotInferFromPersona: true,
        allowedEvidenceIds: ["evidence-lpm"],
      });
      const evidence = evidenceFixture(
        "evidence-lpm",
        "重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827。",
      );

      const result = await createService(
        generateObject,
        repairPersonaReply,
      ).generate({
        ...input,
        userMessage:
          "我们聊了这么久。请用自然的两三句话说说你确定记得的我，不确定的别说。",
        memoryEvidence: evidence,
        contextPlan: {
          ...input.contextPlan,
          includeRetrievedEvidence: true,
        },
        personaContextMode: "enforced",
      });

      const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
        Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
      expect(repairInput?.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: "unsupported_evidence_only_claim",
          }),
        ]),
      );
      expect(result.usedFallback).toBe(true);
      expect(result.reply.text).toContain("LPM-4827");
      expect(result.reply.text).not.toMatch(/结婚|北京|孩子/u);
    },
  );

  it("rejects an affirmative children claim that conflicts with negative evidence", async () => {
    const generateObject = vi
      .fn()
      .mockResolvedValue({ text: "你有两个孩子。" });
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: true,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: ["evidence-children"],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "我有孩子吗？",
      memoryEvidence: evidenceFixture("evidence-children", "我没有孩子。"),
      personaContextMode: "enforced",
    });

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(JSON.stringify(repairInput?.issues)).toContain(
      "unsupported_evidence_only_claim",
    );
    expect(result.usedFallback).toBe(true);
    expect(result.reply.text).not.toContain("有两个孩子");
  });

  it("does not flag a natural grounded rewrite and evidence meta-language", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "我确定记得，LPM-4827 是那枚墨绿色珐琅松针。这是目前有依据的部分。",
    });
    const repairPersonaReply = vi.fn();
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: true,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: ["evidence-lpm"],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "LPM-4827 是什么？",
      memoryEvidence: evidenceFixture(
        "evidence-lpm",
        "重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827。",
      ),
      contextPlan: {
        ...input.contextPlan,
        includeRetrievedEvidence: true,
      },
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      repairAttempted: false,
      issues: [],
    });
    expect(repairPersonaReply).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "turn 18 conservative corrected preference",
      userMessage: "那我现在对香菜的偏好是什么？",
      reply: "你可以接受少量香菜，但不喜欢整把香菜。",
      memoryContent: "我可以接受少量香菜，但不喜欢整把香菜",
      evidenceQuote:
        "我纠正一下：前面说“我不吃香菜”太绝对了。准确说法是，我可以接受少量香菜，但不喜欢整把香菜。",
    },
    {
      label: "turn 77 corrected-statement meta-language",
      userMessage: "我对香菜的准确偏好是什么？",
      reply: "你可以接受少量香菜，但不喜欢整把香菜；这才是纠正后的准确说法。",
      memoryContent: "我可以接受少量香菜，但不喜欢整把香菜",
      evidenceQuote:
        "我纠正一下：前面说“我不吃香菜”太绝对了。准确说法是，我可以接受少量香菜，但不喜欢整把香菜。",
    },
    {
      label: "turn 82 containment paraphrase",
      userMessage: "再确认一次：LPM-4827 放在哪里？",
      reply:
        "LPM-4827 放在深灰色电脑包的内侧拉链袋，里面是那枚墨绿色珐琅松针。",
      memoryContent:
        "重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827",
      evidenceQuote:
        "我只告诉很信任的人一件小事：重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827。请只按我说的内容记，不要补充。",
    },
  ])(
    "does not flag the exact durable-recall wording for $label",
    async ({ userMessage, reply, memoryContent, evidenceQuote }) => {
      const generateObject = vi.fn().mockResolvedValue({ text: reply });
      const repairPersonaReply = vi.fn();
      const input = generationInput({ kind: "none" });
      Object.assign(input.validatedOutcome.replyDirectives, {
        evidenceOnly: true,
        mustAbstain: false,
        mustNotInferFromPersona: true,
        allowedEvidenceIds: ["evidence-allowed"],
      });

      const result = await createService(
        generateObject,
        repairPersonaReply,
      ).generate({
        ...input,
        userMessage,
        memoryEvidence: evidenceFixture(
          "evidence-allowed",
          memoryContent,
          evidenceQuote,
        ),
        contextPlan: {
          ...input.contextPlan,
          includeRetrievedEvidence: true,
        },
        personaContextMode: "enforced",
      });

      expect(result).toMatchObject({ repairAttempted: false, issues: [] });
      expect(repairPersonaReply).not.toHaveBeenCalled();
    },
  );

  it("accepts selected recall evidence alongside an authoritative schedule readback", async () => {
    const text =
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我们已确认的共同安排是 2026-08-23 11:30到12:15，北岸书店喝茶。";
    const generateObject = vi.fn().mockResolvedValue({ text });
    const repairPersonaReply = vi.fn();
    const input = combinedDirectRecallInput();

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      memoryEvidence: evidenceFixture(
        "evidence-bgw",
        "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
      ),
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      reply: { text },
      repairAttempted: false,
      usedFallback: false,
      issues: [],
    });
    expect(repairPersonaReply).not.toHaveBeenCalled();
  });

  it("builds a grounded combined memory-and-schedule fallback after both model attempts fail", async () => {
    const generateObject = vi
      .fn()
      .mockRejectedValue(new Error("reply output truncated"));
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = combinedDirectRecallInput();

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      memoryEvidence: evidenceFixture(
        "evidence-bgw",
        "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
      ),
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("BGW-7419 是蓝色玻璃鲸");
    expect(result.reply.text).toContain("放在左口袋");
    expect(result.reply.text).toContain("2026-08-23");
    expect(result.reply.text).toContain("11:30");
    expect(result.reply.text).toContain("12:15");
    expect(result.reply.text).toContain("北岸书店");
  });

  it("builds a grounded combined fallback from distinct semantic memories sharing one source quote", async () => {
    const generateObject = vi
      .fn()
      .mockRejectedValue(new Error("reply output truncated"));
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = combinedDirectRecallInput();
    const sourceQuote =
      "我只告诉很信任的人一个习惯：每次重要演讲前，我都会把一枚蓝色玻璃鲸放在左口袋，它的代号是 BGW-7419。最近想到博士资格面谈就有些紧张。另请记住我的关怀方式偏好：只要我谈到这场面谈，先问我现在更需要安慰还是建议，不要马上讲道理。";
    input.validatedOutcome.replyDirectives.mustAddressUserQuotes = [
      "我们开了一个新会话。请告诉我：BGW-7419 是什么、我演讲前把它放在哪里？另外，我们刚确认的共同安排是什么？如果不确定就直说。",
    ];
    input.validatedOutcome.replyDirectives.authoritativeFacts = [
      {
        kind: "schedule",
        sourceId: "schedule-shared",
        text: "2026-08-24 19:30–20:15，和用户北岸书店喝茶（Asia/Shanghai）。本地时间：2026年08月24日 19:30。",
        requiredAnchors: [
          "2026-08-24",
          "19:30",
          "20:15",
          "2026年08月24日 19:30",
          "和用户北岸书店喝茶",
        ],
      },
    ];
    const habit = evidenceFixture(
      "evidence-bgw",
      "用户有一个演讲前的个人习惯：每次重要演讲前会把一枚代号为BGW-7419的蓝色玻璃鲸放在左口袋。",
      sourceQuote,
    );
    const carePreference = evidenceFixture(
      "evidence-care",
      "用户在谈论博士资格面谈时，希望先被询问更需要安慰还是建议，而不是立即讲道理。",
      sourceQuote,
    );
    const interviewEmotion = evidenceFixture(
      "evidence-emotion",
      "用户对即将到来的博士资格面谈感到紧张。",
      sourceQuote,
    );
    input.validatedOutcome.replyDirectives.allowedEvidenceIds = [
      "evidence-bgw",
      "evidence-care",
      "evidence-emotion",
    ];

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage:
        "我们开了一个新会话。请告诉我：BGW-7419 是什么、我演讲前把它放在哪里？另外，我们刚确认的共同安排是什么？如果不确定就直说。",
      memoryEvidence: {
        ...habit,
        evidence: [
          ...habit.evidence,
          ...carePreference.evidence,
          ...interviewEmotion.evidence,
        ],
      },
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("BGW-7419 是蓝色玻璃鲸");
    expect(result.reply.text).toContain("放在左口袋");
    expect(result.reply.text).toContain("2026-08-24");
    expect(result.reply.text).toContain("19:30");
    expect(result.reply.text).toContain("20:15");
    expect(result.reply.text).toContain("北岸书店");
    expect(result.reply.text).not.toMatch(/安慰|建议|讲道理|紧张/u);
  });

  it("builds a grounded combined fallback from one long semantic memory matching its source quote", async () => {
    const generateObject = vi
      .fn()
      .mockRejectedValue(new Error("reply output truncated"));
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = combinedDirectRecallInput();
    const sourceQuote =
      "我只告诉很信任的人一个习惯：每次重要演讲前，我都会把一枚蓝色玻璃鲸放在左口袋，它的代号是 BGW-7419。最近想到博士资格面谈就有些紧张。另请记住我的关怀方式偏好：只要我谈到这场面谈，先问我现在更需要安慰还是建议，不要马上讲道理。";
    input.validatedOutcome.replyDirectives.mustAddressUserQuotes = [
      "我们开了一个新会话。请告诉我：BGW-7419 是什么、我演讲前把它放在哪里？另外，我们刚确认的共同安排是什么？如果不确定就直说。",
    ];
    input.validatedOutcome.replyDirectives.authoritativeFacts = [
      {
        kind: "schedule",
        sourceId: "schedule-shared",
        text: "2026-08-24 19:30–20:15，和用户北岸书店喝茶（Asia/Shanghai）。本地时间：2026年08月24日 19:30。",
        requiredAnchors: [
          "2026-08-24",
          "19:30",
          "20:15",
          "2026年08月24日 19:30",
          "和用户北岸书店喝茶",
        ],
      },
    ];

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage:
        "我们开了一个新会话。请告诉我：BGW-7419 是什么、我演讲前把它放在哪里？另外，我们刚确认的共同安排是什么？如果不确定就直说。",
      memoryEvidence: evidenceFixture("evidence-bgw", sourceQuote, sourceQuote),
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("BGW-7419 是蓝色玻璃鲸");
    expect(result.reply.text).toContain("放在左口袋");
    expect(result.reply.text).toContain("2026-08-24");
    expect(result.reply.text).toContain("19:30");
    expect(result.reply.text).toContain("20:15");
    expect(result.reply.text).toContain("北岸书店");
    expect(result.reply.text).not.toMatch(/安慰|建议|讲道理|紧张/u);
  });

  it("does not copy quote-only durable facts into an identifier recall fallback", async () => {
    const generateObject = vi
      .fn()
      .mockRejectedValue(new Error("reply output truncated"));
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = combinedDirectRecallInput();
    const evidenceQuote =
      "每次重要演讲前，我都会把一枚蓝色玻璃鲸放在左口袋，它的代号是 BGW-7419。我已经结婚，而且有两个孩子。";

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      memoryEvidence: evidenceFixture(
        "evidence-bgw",
        "用户有一个演讲前的个人习惯：每次重要演讲前会把一枚代号为BGW-7419的蓝色玻璃鲸放在左口袋。",
        evidenceQuote,
      ),
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("BGW-7419");
    expect(result.reply.text).toContain("蓝色玻璃鲸");
    expect(result.reply.text).toContain("左口袋");
    expect(result.reply.text).not.toMatch(/结婚|孩子/u);
  });

  it("does not trust a source quote when the selected semantic memory does not support it", async () => {
    const generateObject = vi
      .fn()
      .mockRejectedValue(new Error("reply output truncated"));
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = combinedDirectRecallInput();

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      memoryEvidence: evidenceFixture(
        "evidence-bgw",
        "BGW-7419 是一枚红色钥匙，放在书桌抽屉。",
        "每次重要演讲前，我都会把一枚蓝色玻璃鲸放在左口袋，它的代号是 BGW-7419。",
      ),
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
    });
    expect(result.reply.text).toContain("北岸书店");
    expect(result.reply.text).not.toMatch(
      /蓝色玻璃鲸|左口袋|红色钥匙|书桌抽屉/u,
    );
  });

  it("omits stale invitation evidence from a combined recall fallback while answering both requested facts", async () => {
    const generateObject = vi
      .fn()
      .mockRejectedValue(new Error("reply output truncated"));
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = combinedDirectRecallInput();
    input.validatedOutcome.replyDirectives.allowedEvidenceIds = [
      "evidence-bgw",
      "evidence-stale-invitation",
    ];
    const bgw = evidenceFixture(
      "evidence-bgw",
      "我只告诉很信任的人一个习惯：每次重要演讲前，我都会把一枚蓝色玻璃鲸放在左口袋，它的代号是 BGW-7419。",
    );
    const staleInvitation = evidenceFixture(
      "evidence-stale-invitation",
      "这是一个明确的共同邀约：我想在2026年08月23日 11:30和你一起去北岸书店喝茶，预计45分钟。你愿意吗？如果愿意，请先把它作为待我确认的共同安排，不要声称已经写入日程。",
    );

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage:
        "我们开了一个新会话。请告诉我：BGW-7419 是什么、我演讲前把它放在哪里？另外，我们刚确认的共同安排是什么？如果不确定就直说。",
      memoryEvidence: {
        ...bgw,
        evidence: [...bgw.evidence, ...staleInvitation.evidence],
      },
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("BGW-7419");
    expect(result.reply.text).toContain("蓝色玻璃鲸");
    expect(result.reply.text).toContain("左口袋");
    expect(result.reply.text).toContain("2026-08-23");
    expect(result.reply.text).toContain("11:30");
    expect(result.reply.text).toContain("12:15");
    expect(result.reply.text).toContain("北岸书店");
    expect(result.reply.text).not.toMatch(/共同邀约|待我确认|不要声称/u);
  });

  it("does not count an already-queried identifier as the selected-memory answer", async () => {
    const repairedText =
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我们已确认的共同安排是 2026-08-23 11:30–12:15，北岸书店喝茶。";
    const generateObject = vi.fn().mockResolvedValue({
      text: "BGW-7419。我们已确认的共同安排是 2026-08-23 11:30–12:15，北岸书店喝茶。",
    });
    const repairPersonaReply = vi
      .fn()
      .mockResolvedValue({ text: repairedText });
    const input = combinedDirectRecallInput();

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      memoryEvidence: evidenceFixture(
        "evidence-bgw",
        "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
      ),
      personaContextMode: "enforced",
    });

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(JSON.stringify(repairInput?.issues)).toContain(
      "unsupported_evidence_only_claim",
    );
    expect(result.reply.text).toBe(repairedText);
  });

  it("allows a code-only answer when the queried turn does not contain the code", async () => {
    const generateObject = vi.fn().mockResolvedValue({ text: "LPM-4827。" });
    const repairPersonaReply = vi.fn();
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: false,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: ["evidence-lpm"],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "我刚才说的代号是什么？",
      memoryEvidence: evidenceFixture(
        "evidence-lpm",
        "重要发言前，我把墨绿色珐琅松针放进电脑包，代号是 LPM-4827。",
      ),
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      reply: { text: "LPM-4827。" },
      repairAttempted: false,
      issues: [],
    });
    expect(repairPersonaReply).not.toHaveBeenCalled();
  });

  it("accepts an LPM-4827 immediate recall grounded only in selected recent user evidence", async () => {
    const source =
      "我只告诉很信任的人一件小事：重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827。请只按我说的内容记，不要补充。";
    const text =
      "代号是 LPM-4827；那是一枚墨绿色珐琅松针，放在深灰色电脑包的内侧拉链袋。";
    const generateObject = vi.fn().mockResolvedValue({ text });
    const repairPersonaReply = vi.fn();
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: false,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: [],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage:
        "我刚才说的代号是什么？那件东西放在哪里？只回答你确定的部分。",
      recentMessages: [
        { role: "user", content: source },
        {
          role: "assistant",
          content: "ASSISTANT-POISON：用户已经结婚并有两个孩子。",
        },
      ],
      recentUserFactEvidence: [{ role: "user", content: source }],
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      reply: { text },
      repairAttempted: false,
      usedFallback: false,
      issues: [],
    });
    expect(repairPersonaReply).not.toHaveBeenCalled();
    const replyCall = generateObject.mock.calls[0]?.[0] as
      { prompt?: string } | undefined;
    const prompt = replyCall?.prompt ?? "";
    expect(prompt).toContain("LPM-4827");
    expect(prompt).not.toContain("ASSISTANT-POISON");
  });

  it("passes only selected recent user evidence into immediate-recall repair", async () => {
    const source =
      "重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827。";
    const safeText =
      "LPM-4827 是墨绿色珐琅松针，放在深灰色电脑包的内侧拉链袋。";
    const generateObject = vi.fn().mockResolvedValue({
      text: `${safeText}你已经结婚，而且有两个孩子。`,
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: safeText });
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: false,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: [],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage:
        "我刚才说的代号是什么？那件东西放在哪里？只回答你确定的部分。",
      recentUserFactEvidence: [{ role: "user", content: source }],
      personaContextMode: "enforced",
    });

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(repairInput?.recentUserFactEvidence).toEqual([
      { role: "user", content: source },
    ]);
    expect(JSON.stringify(repairInput?.issues)).toContain(
      "unsupported_evidence_only_claim",
    );
    expect(result).toMatchObject({
      reply: { text: safeText },
      repairAttempted: true,
      usedFallback: false,
      issues: [],
    });
  });

  it("builds a grounded LPM-4827 fallback from selected recent user evidence", async () => {
    const source =
      "我只告诉很信任的人一件小事：重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827。请只按我说的内容记，不要补充。";
    const generateObject = vi
      .fn()
      .mockRejectedValue(new Error("reply provider unavailable"));
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: false,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: [],
    });
    input.validatedOutcome.replyDirectives.mustAddressUserQuotes = [
      "我刚才说的代号是什么？",
      "那件东西放在哪里？",
    ];

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage:
        "我刚才说的代号是什么？那件东西放在哪里？只回答你确定的部分。",
      recentUserFactEvidence: [{ role: "user", content: source }],
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("LPM-4827 是墨绿色珐琅松针");
    expect(result.reply.text).toContain("深灰色电脑包的内侧拉链袋");
    expect(result.reply.text).not.toMatch(/结婚|孩子/u);
  });

  it("recalls only the active facts from an exact correction source when generation and repair are polluted", async () => {
    const correction =
      "我纠正一下：前面说“我不吃香菜”太绝对了。准确说法是，我可以接受少量香菜，但不喜欢整把香菜。";
    const generateObject = vi.fn().mockResolvedValue({
      text: "你完全不吃香菜，而且已经结婚。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "你不吃香菜，而且有两个孩子。",
    });
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: true,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: ["evidence-cilantro-correction"],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "那我现在对香菜的偏好是什么？",
      memoryEvidence: evidenceFixture(
        "evidence-cilantro-correction",
        correction,
        correction,
      ),
      contextPlan: {
        ...input.contextPlan,
        includeRetrievedEvidence: true,
      },
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("你可以接受少量香菜");
    expect(result.reply.text).toContain("不喜欢整把香菜");
    expect(result.reply.text).not.toMatch(
      /我纠正一下|你纠正一下|前面说|不吃香菜|太绝对/u,
    );
    expect(result.reply.text).not.toMatch(/结婚|孩子/u);
  });

  it("builds a canonical direct-contrast fallback from content while auditing its raw quote", async () => {
    const correction =
      "我纠正一下：小林不是我的大学同学，是我高中同学。她搬到苏州这件事没变。";
    const canonical = "小林是我高中同学。她搬到苏州。";
    const generateObject = vi.fn().mockResolvedValue({
      text: "小林是你的大学同学，而且你已经结婚。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: "小林不是你的大学同学，而且你有两个孩子。",
    });
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: true,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: ["evidence-xiaolin-correction"],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "小林和我是什么关系，她搬到哪里？",
      memoryEvidence: evidenceFixture(
        "evidence-xiaolin-correction",
        canonical,
        correction,
      ),
      contextPlan: {
        ...input.contextPlan,
        includeRetrievedEvidence: true,
      },
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("小林是你的高中同学");
    expect(result.reply.text).toContain("苏州");
    expect(result.reply.text).not.toContain("小林是我高中同学");
    expect(result.reply.text).not.toMatch(/大学同学|结婚|孩子/u);
  });

  it("rejects unsupported marriage and children appended to a combined direct recall", async () => {
    const safeReply =
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我们已确认的共同安排是 2026-08-23 11:30–12:15，北岸书店喝茶。";
    const generateObject = vi.fn().mockResolvedValue({
      text: `${safeReply}你已经结婚，而且有两个孩子。`,
    });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: safeReply });
    const input = combinedDirectRecallInput();

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      memoryEvidence: evidenceFixture(
        "evidence-bgw",
        "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
      ),
      personaContextMode: "enforced",
    });

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(repairInput?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_evidence_only_claim" }),
      ]),
    );
    expect(result.reply.text).toBe(safeReply);
    expect(result.reply.text).not.toMatch(/结婚|孩子/u);
  });

  it.each([
    "你可以先告诉朋友你已经结婚。",
    "你已经结婚了不是吗？",
    "我不知道你是否结婚但你有两个孩子。",
    "你可以先告诉朋友你是医生。",
    "你已经是医生了不是吗？",
    "我不知道你是否结婚而你有两个孩子。",
  ])(
    "repairs a durable fact hidden in a non-factual wrapper: %s",
    async (extra) => {
      const safeReply =
        "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我们已确认的共同安排是 2026-08-23 11:30–12:15，北岸书店喝茶。";
      const generateObject = vi.fn().mockResolvedValue({
        text: `${safeReply}${extra}`,
      });
      const repairPersonaReply = vi.fn().mockResolvedValue({ text: safeReply });
      const input = combinedDirectRecallInput();

      const result = await createService(
        generateObject,
        repairPersonaReply,
      ).generate({
        ...input,
        memoryEvidence: evidenceFixture(
          "evidence-bgw",
          "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
        ),
        personaContextMode: "enforced",
      });

      expect(repairPersonaReply).toHaveBeenCalledOnce();
      const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
        Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
      expect(JSON.stringify(repairInput?.issues)).toContain(
        "unsupported_evidence_only_claim",
      );
      expect(result.reply.text).toBe(safeReply);
    },
  );

  it("does not authorize an arbitrary validated-evidence substring", async () => {
    const generateObject = vi.fn().mockResolvedValue({ text: "你已经结婚。" });
    const repairPersonaReply = vi
      .fn()
      .mockResolvedValue({ text: "慢慢来。我会在这里陪着你。" });
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: false,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: [],
    });
    input.validatedOutcome.observation.validatedEvidence = [
      { text: "已经结婚", start: 0, end: 4 },
    ];

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "你还记得吗？",
      personaContextMode: "enforced",
    });

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(JSON.stringify(repairInput?.issues)).toContain(
      "unsupported_evidence_only_claim",
    );
    expect(result.reply.text).toBe("慢慢来。我会在这里陪着你。");
  });

  it("rejects role reversal across comma-separated selected evidence", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "苏州是你的大学同学。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: false,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: ["evidence-xiaolin"],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "小林是谁，她搬到哪里了？",
      memoryEvidence: evidenceFixture(
        "evidence-xiaolin",
        "我大学同学叫小林，她最近刚搬到苏州。",
      ),
      personaContextMode: "enforced",
    });

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(JSON.stringify(repairInput?.issues)).toContain(
      "unsupported_evidence_only_claim",
    );
    expect(result.usedFallback).toBe(true);
    expect(result.reply.text).toContain("小林");
    expect(result.reply.text).toContain("苏州");
  });

  it("allows grounded transient emotion and advice in direct-fact guard mode", async () => {
    const text =
      "听起来博士资格面谈还是让你有些紧张。先用两分钟写下最担心的问题，再用八分钟练习开头。";
    const generateObject = vi.fn().mockResolvedValue({ text });
    const repairPersonaReply = vi.fn();
    const base = generationInput({ kind: "none" });
    Object.assign(base.validatedOutcome.replyDirectives, {
      evidenceOnly: false,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: [],
    });
    base.validatedOutcome.observation.validatedEvidence = [
      {
        text: "博士资格面谈，我还是有点紧张",
        start: 0,
        end: 16,
      },
    ];

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...base,
      userMessage:
        "说回博士资格面谈，我还是有点紧张。陪我梳理一个十分钟准备步骤。",
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      reply: { text },
      repairAttempted: false,
      usedFallback: false,
      issues: [],
    });
    expect(repairPersonaReply).not.toHaveBeenCalled();
  });

  it("repairs a direct recall that contains advice but no grounded memory claim", async () => {
    const repairedText =
      "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。我们已确认的共同安排是 2026-08-23 11:30–12:15，北岸书店喝茶。";
    const generateObject = vi.fn().mockResolvedValue({
      text: "先慢慢想一想，我会在这里陪着你。",
    });
    const repairPersonaReply = vi
      .fn()
      .mockResolvedValue({ text: repairedText });
    const input = combinedDirectRecallInput();

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      memoryEvidence: evidenceFixture(
        "evidence-bgw",
        "BGW-7419 是蓝色玻璃鲸，演讲前放在左口袋。",
      ),
      personaContextMode: "enforced",
    });

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    const repairInput = repairPersonaReply.mock.calls[0]?.[0] as
      Parameters<ReplyRepairService["repairPersonaReply"]>[0] | undefined;
    expect(repairInput?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsupported_evidence_only_claim" }),
      ]),
    );
    expect(result.reply.text).toBe(repairedText);
  });

  it("does not fill a cross-session user-fact query from persona when evidence is selected", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "小林是我夜校班上的学生。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: false,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: ["evidence-allowed"],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "小林是谁？",
      memoryEvidence: evidenceFixture(
        "evidence-allowed",
        "我大学同学叫小林，她最近刚搬到苏州。",
      ),
      contextPlan: {
        ...input.contextPlan,
        includeRetrievedEvidence: true,
      },
      personaContextMode: "enforced",
    });

    expect(result.usedFallback).toBe(true);
    expect(result.reply.text).toContain("大学同学");
    expect(result.reply.text).toContain("苏州");
    expect(result.reply.text).not.toMatch(/夜校|学生/u);
  });

  it("falls back to the selected durable person fact when content and quote use equivalent wording", async () => {
    const generateObject = vi.fn().mockResolvedValue({
      text: "小林是我夜校班上的学生。",
    });
    const repairPersonaReply = vi.fn().mockResolvedValue(undefined);
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: false,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: ["evidence-xiaolin"],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "小林是谁？",
      memoryEvidence: evidenceFixture(
        "evidence-xiaolin",
        "用户的大学同学小林最近刚搬到苏州。",
        "我大学同学叫小林，她最近刚搬到苏州。",
      ),
      contextPlan: {
        ...input.contextPlan,
        includeRetrievedEvidence: true,
      },
      personaContextMode: "enforced",
    });

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ usedFallback: true, issues: [] });
    expect(result.reply.text).toContain("小林");
    expect(result.reply.text).toContain("大学同学");
    expect(result.reply.text).toContain("苏州");
    expect(result.reply.text).not.toMatch(/夜校|学生/u);
  });

  it("accepts a grounded durable person answer across equivalent content and quote wording", async () => {
    const text = "小林是你的大学同学，她最近刚搬到苏州。";
    const generateObject = vi.fn().mockResolvedValue({ text });
    const repairPersonaReply = vi.fn();
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: false,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: ["evidence-xiaolin"],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "小林是谁？",
      memoryEvidence: evidenceFixture(
        "evidence-xiaolin",
        "用户的大学同学小林最近刚搬到苏州。",
        "我大学同学叫小林，她最近刚搬到苏州。",
      ),
      personaContextMode: "enforced",
    });

    expect(result).toMatchObject({
      reply: { text },
      repairAttempted: false,
      usedFallback: false,
      issues: [],
    });
    expect(repairPersonaReply).not.toHaveBeenCalled();
  });

  it("rejects unsupported additions to a current explicit user fact and falls back to the exact source", async () => {
    const polluted =
      "小林搬去苏州了啊，蛮好的，那边节奏比上海慢一点，住着舒服。她之前不是一直想换个环境试试嘛，也算如愿了。你最近有打算过去找她玩吗？";
    const generateObject = vi.fn().mockResolvedValue({ text: polluted });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: polluted });
    const input = currentXiaolinFactInput();

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "unsupported_current_user_fact_claim",
    );
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("小林");
    expect(result.reply.text).toContain("你的大学同学");
    expect(result.reply.text).toContain("苏州");
    expect(result.reply.text).not.toMatch(/上海慢|住着舒服|想换个环境|如愿/u);
  });

  it("accepts a grounded acknowledgement of a current explicit user fact", async () => {
    const text = "小林是你的大学同学，她最近刚搬到苏州。";
    const generateObject = vi.fn().mockResolvedValue({ text });
    const repairPersonaReply = vi.fn();

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(currentXiaolinFactInput());

    expect(result).toMatchObject({
      reply: { text },
      repairAttempted: false,
      usedFallback: false,
      issues: [],
    });
    expect(repairPersonaReply).not.toHaveBeenCalled();
  });

  it("repairs a durable person recall that reverses the user's relationship ownership", async () => {
    const reversed = "小林啊，我大学同学，她最近刚搬到苏州。";
    const generateObject = vi.fn().mockResolvedValue({ text: reversed });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: reversed });
    const input = generationInput({ kind: "none" });
    Object.assign(input.validatedOutcome.replyDirectives, {
      evidenceOnly: false,
      mustAbstain: false,
      mustNotInferFromPersona: true,
      allowedEvidenceIds: ["evidence-xiaolin-owner"],
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate({
      ...input,
      userMessage: "小林是谁？",
      memoryEvidence: evidenceFixture(
        "evidence-xiaolin-owner",
        "用户的大学同学小林最近刚搬到苏州。",
        "我大学同学叫小林，她最近刚搬到苏州。",
      ),
      personaContextMode: "enforced",
    });

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ usedFallback: true, issues: [] });
    expect(result.reply.text).toContain("小林是你的大学同学");
    expect(result.reply.text).not.toMatch(/小林.{0,5}我(?:的)?大学同学/u);
  });

  it("rejects a committed schedule readback that says it cannot confirm persistence", async () => {
    const denied =
      "北岸书店喝茶是 8 月 25 日 19:00，不过我没法确认已经写进日程。";
    const generateObject = vi.fn().mockResolvedValue({ text: denied });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: denied });
    const input = committedScheduleReadInput();

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "committed_schedule_contradiction",
    );
    expect(result).toMatchObject({ usedFallback: true, issues: [] });
    expect(result.reply.text).toContain("当前已确认并生效");
    expect(result.reply.text).not.toContain("没法确认");
  });

  it("preserves an existing committed schedule when an unsupported mutation is rejected", async () => {
    const denied =
      "你说的北岸书店喝茶，我这边记录的是待确认方案，还没正式定下来。你确认过要改成晚一小时吗？还是先按原时间？";
    const generateObject = vi.fn().mockResolvedValue({ text: denied });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: denied });
    const input = generationInput({
      kind: "rejected",
      reasonCode: "unsupported_schedule_operation",
    });
    input.validatedOutcome.route = "schedule_mutation";
    input.validatedOutcome.observation.route = "schedule_mutation";
    input.validatedOutcome.replyDirectives.authoritativeFacts = [
      {
        kind: "schedule",
        sourceId: "schedule-north-bank",
        scheduleAuthorityState: "committed",
        scheduleMutationDisposition: "unchanged",
        text: "原已确认安排保持不变；本次改期未执行。对应安排：北岸书店喝茶。",
        requiredAnchors: [
          "原已确认安排保持不变",
          "本次改期未执行",
          "北岸书店喝茶",
        ],
      },
    ];
    input.validatedOutcome.replyDirectives.mustNotClaim = [
      "schedule_cancelled",
      "memory_persisted",
      "future_action_guaranteed",
    ];

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "committed_schedule_contradiction",
    );
    expect(result).toMatchObject({ usedFallback: true, issues: [] });
    expect(result.reply.text).toContain("原已确认安排保持不变");
    expect(result.reply.text).toContain("本次改期未执行");
    expect(result.reply.text).not.toContain("待确认方案");
  });

  it("rejects an echo-only activated-goal answer and uses the newest occurred evidence", async () => {
    const question = "你那部关于城市夜归人的纪录短片做到哪一步了？";
    const echo = `我听见你说的“${question}”了。你愿意的话，我们可以顺着这件事继续聊。`;
    const generateObject = vi.fn().mockResolvedValue({ text: echo });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: echo });
    const input = activatedDocumentaryGoalInput(question);

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "activated_goal_question_unanswered",
    );
    expect(result).toMatchObject({ usedFallback: true, issues: [] });
    expect(result.reply.text).toContain("完成了一部关于城市夜归人的纪录短片");
    expect(result.reply.text).not.toContain("顺着这件事继续聊");
    expect(result.reply.text).not.toContain(question);
  });

  it("accepts a substantive bottleneck answer for an activated goal", async () => {
    const text = "现在最卡的是结构：素材不少，但还要决定哪些人物线索彼此照应。";
    const generateObject = vi.fn().mockResolvedValue({ text });
    const repairPersonaReply = vi.fn();
    const question = "现在最卡的是素材、结构，还是时间？";

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(
      activatedDocumentaryGoalInput(question, {
        memoryEvidence: documentaryGoalBottleneckEvidenceFixture(text),
      }),
    );

    expect(result).toMatchObject({
      reply: { text },
      repairAttempted: false,
      usedFallback: false,
      issues: [],
    });
    expect(repairPersonaReply).not.toHaveBeenCalled();
  });

  it("batch12 exact turn69: abstains instead of choosing a listed bottleneck without evidence", async () => {
    const invented =
      "现在最卡的是结构：素材不少，但人物线索之间的转场还没理顺。";
    const generateObject = vi.fn().mockResolvedValue({ text: invented });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: invented });
    const question = "现在最卡的是素材、结构，还是时间？";

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(
      activatedDocumentaryGoalInput(question, { withoutEvidence: true }),
    );

    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "unsupported_activated_goal_bottleneck_claim",
    );
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toMatch(/可靠记录不足|不想编造/u);
    expect(result.reply.text).not.toMatch(/最卡的是结构|人物线索之间的转场/u);
  });

  it("batch12 exact turn72: keeps a hypothetical choice but rejects appended current production facts", async () => {
    const invented =
      "如果遇到瓶颈，我会暂停一下；现在粗剪已完成，素材也整理好了。";
    const generateObject = vi.fn().mockResolvedValue({ text: invented });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: invented });
    const question = "如果那部片子遇到瓶颈，你会暂停一下，还是硬撑着做完？";

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(
      activatedDocumentaryGoalInput(question, { withoutEvidence: true }),
    );

    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "activated_goal_choice_current_fact",
    );
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toMatch(/如果遇到瓶颈|暂停/u);
    expect(result.reply.text).not.toMatch(/粗剪|素材/u);
  });

  it("batch12 exact: falls back to structured 5% when generation and repair both invent production progress", async () => {
    const invented =
      "粗剪已经推进到 70%，素材按便利店内外分好了，三个转场也都定了。";
    const generateObject = vi.fn().mockResolvedValue({ text: invented });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: invented });
    const question = "你那部关于城市夜归人的纪录短片做到哪一步了？";
    const input = activatedDocumentaryGoalInput(question, {
      progress: 0.05,
      withoutEvidence: true,
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    expect(repairPersonaReply).toHaveBeenCalledOnce();
    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "unsupported_activated_goal_progress_detail",
    );
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("5%");
    expect(result.reply.text).not.toMatch(/粗剪|素材|便利店|转场/u);
  });

  it("batch12 exact: accepts the exact structured 40% without evidence or invented production detail", async () => {
    const text =
      "那部关于城市夜归人的纪录短片，当前目标记录的进度是 40%；没有可靠记录能确认更具体的制作阶段。";
    const generateObject = vi.fn().mockResolvedValue({ text });
    const repairPersonaReply = vi.fn();
    const question = "你那部关于城市夜归人的纪录短片做到哪一步了？";

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(
      activatedDocumentaryGoalInput(question, { withoutEvidence: true }),
    );

    expect(result).toMatchObject({
      reply: { text },
      repairAttempted: false,
      usedFallback: false,
      issues: [],
    });
    expect(repairPersonaReply).not.toHaveBeenCalled();
  });

  it("batch12 exact: accepts an explicit epistemic abstention about an unsupported production stage", async () => {
    const text = "目前的可靠记录不足以确认粗剪做到哪一步，所以我不知道。";
    const generateObject = vi.fn().mockResolvedValue({ text });
    const repairPersonaReply = vi.fn();
    const question = "你那部关于城市夜归人的纪录短片做到哪一步了？";

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(
      activatedDocumentaryGoalInput(question, { withoutEvidence: true }),
    );

    expect(result).toMatchObject({
      reply: { text },
      repairAttempted: false,
      usedFallback: false,
      issues: [],
    });
    expect(repairPersonaReply).not.toHaveBeenCalled();
  });

  it("does not accept a progress abstention when selected evidence supplies the latest goal status", async () => {
    const question = "你那部关于城市夜归人的纪录短片做到哪一步了？";
    const abstention = "目前的可靠记录不足以确认进展，所以我不知道。";
    const generateObject = vi.fn().mockResolvedValue({ text: abstention });
    const repairPersonaReply = vi.fn().mockResolvedValue({ text: abstention });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(activatedDocumentaryGoalInput(question));

    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("完成了一部关于城市夜归人的纪录短片");
    expect(result.reply.text).not.toMatch(/不足以确认|不知道/u);
  });

  it("batch12 exact: rejects unfinished progress that conflicts with selected completion evidence", async () => {
    const conflicting =
      "那部关于城市夜归人的纪录短片目前进度是 40%，还没有完成。";
    const generateObject = vi.fn().mockResolvedValue({ text: conflicting });
    const repairPersonaReply = vi.fn().mockResolvedValue({
      text: conflicting,
    });
    const question = "你那部关于城市夜归人的纪录短片做到哪一步了？";

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(activatedDocumentaryGoalInput(question));

    expect(JSON.stringify(repairPersonaReply.mock.calls)).toContain(
      "activated_goal_progress_completion_conflict",
    );
    expect(result).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      issues: [],
    });
    expect(result.reply.text).toContain("完成了一部关于城市夜归人的纪录短片");
    expect(result.reply.text).not.toMatch(/40%|还没有完成/u);
  });

  it.each([
    [
      "partial",
      "那部关于城市夜归人的纪录短片只完成了一部分。",
      /只完成了一部分/u,
    ],
    ["skipped", "未能进行那部关于城市夜归人的纪录短片。", /未能进行/u],
    ["cancelled", "取消了那部关于城市夜归人的纪录短片。", /取消了/u],
  ] as const)(
    "uses the newest %s goal activity outcome plus structured progress instead of stale started evidence",
    async (_status, latestOutcome, expectedOutcome) => {
      const question = "你那部关于城市夜归人的纪录短片做到哪一步了？";
      const invented = "那部关于城市夜归人的纪录短片已经全部完成了。";
      const generateObject = vi.fn().mockResolvedValue({ text: invented });
      const repairPersonaReply = vi.fn().mockResolvedValue({ text: invented });
      const input = activatedDocumentaryGoalInput(question, {
        progress: 0.05,
        memoryEvidence: documentaryGoalStatusEvidenceFixture([
          {
            id: "started",
            content: "开始了一部关于城市夜归人的纪录短片。",
            occurredAtUtc: "2026-08-23T06:55:00.000Z",
          },
          {
            id: `latest-${_status}`,
            content: latestOutcome,
            occurredAtUtc: "2026-08-23T07:55:00.000Z",
          },
        ]),
      });

      const result = await createService(
        generateObject,
        repairPersonaReply,
      ).generate(input);

      expect(result).toMatchObject({
        repairAttempted: true,
        usedFallback: true,
        issues: [],
      });
      expect(result.reply.text).toMatch(expectedOutcome);
      expect(result.reply.text).toContain("5%");
      expect(result.reply.text).not.toMatch(/全部完成/u);
    },
  );

  it("does not let older completion evidence override a newer started goal activity", async () => {
    const question = "你那部关于城市夜归人的纪录短片做到哪一步了？";
    const staleCompletion = "那部关于城市夜归人的纪录短片已经全部完成了。";
    const generateObject = vi.fn().mockResolvedValue({ text: staleCompletion });
    const repairPersonaReply = vi
      .fn()
      .mockResolvedValue({ text: staleCompletion });
    const input = activatedDocumentaryGoalInput(question, {
      progress: 0.4,
      memoryEvidence: documentaryGoalStatusEvidenceFixture([
        {
          id: "older-completed",
          content: "完成了一部关于城市夜归人的纪录短片。",
          occurredAtUtc: "2026-08-23T06:55:00.000Z",
        },
        {
          id: "newer-started",
          content: "开始了一部关于城市夜归人的纪录短片。",
          occurredAtUtc: "2026-08-23T07:55:00.000Z",
        },
      ]),
    });

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(input);

    expect(result).toMatchObject({ usedFallback: true, issues: [] });
    expect(result.reply.text).toContain("开始了一部关于城市夜归人的纪录短片");
    expect(result.reply.text).toContain("40%");
    expect(result.reply.text).not.toMatch(/全部完成/u);
  });

  it("accepts an exact structured percentage written with Chinese numerals", async () => {
    const question = "你那部关于城市夜归人的纪录短片做到哪一步了？";
    const text =
      "那部关于城市夜归人的纪录短片，当前目标记录的进度约为百分之四十。";
    const generateObject = vi.fn().mockResolvedValue({ text });
    const repairPersonaReply = vi.fn();

    const result = await createService(
      generateObject,
      repairPersonaReply,
    ).generate(
      activatedDocumentaryGoalInput(question, {
        progress: 0.4,
        withoutEvidence: true,
      }),
    );

    expect(result).toMatchObject({
      reply: { text },
      repairAttempted: false,
      usedFallback: false,
      issues: [],
    });
  });
});

function evidenceFixture(
  id: string,
  memoryContent: string,
  evidenceQuote = memoryContent,
): EvidenceBundle {
  return {
    query: "小林是谁？",
    mode: "verbatim_quote",
    generatedAtUtc: NOW,
    score: 0.95,
    evidence: [
      {
        memoryId: `memory-${id}`,
        memoryContent,
        memoryKind: "semantic",
        namespace: "user_model",
        certainty: "explicit",
        attribution: "user_explicit",
        stability: "stable",
        evidence: {
          id,
          memoryId: `memory-${id}`,
          sourceType: "message",
          sourceId: `message-${id}`,
          quote: evidenceQuote,
          recordedAtUtc: NOW,
        },
        score: 0.95,
        scoreBreakdown: {
          lexical: 1,
          tag: 1,
          importance: 0.9,
          recency: 0.8,
          temporal: 0.5,
          namespace: 1,
        },
      },
    ],
  };
}

function currentXiaolinFactInput(): Parameters<
  ReplyGenerationService["generate"]
>[0] {
  const base = generationInput({ kind: "none" });
  const userMessage = "我大学同学叫小林，她最近刚搬到苏州。";
  base.validatedOutcome.acceptedWorldEffects = validateWorldEffects({
    memoryCandidates: [
      {
        type: "user_fact",
        content: "用户的大学同学小林最近刚搬到苏州。",
      },
    ],
  }).effects;
  base.validatedOutcome.replyDirectives.mustAddressUserQuotes = [userMessage];
  return {
    ...base,
    userMessage,
    contextPlan: contextPlan(base.character, userMessage),
  };
}

function committedScheduleReadInput(): Parameters<
  ReplyGenerationService["generate"]
>[0] {
  const input = generationInput({
    kind: "read_only",
    itemIds: ["schedule-north-bank"],
  });
  input.validatedOutcome.route = "schedule_query";
  input.validatedOutcome.observation.route = "schedule_query";
  input.validatedOutcome.replyDirectives.authoritativeFacts = [
    {
      kind: "schedule",
      sourceId: "schedule-north-bank",
      scheduleAuthorityState: "committed",
      scheduleMutationDisposition: "unchanged",
      text: "这是当前已确认并生效的共同安排：2026-08-25 19:00–19:45，北岸书店喝茶（Asia/Shanghai）。",
      requiredAnchors: [
        "当前已确认并生效",
        "2026-08-25",
        "19:00",
        "19:45",
        "北岸书店喝茶",
      ],
    },
  ];
  input.validatedOutcome.replyDirectives.mustNotClaim = [
    "schedule_cancelled",
    "memory_persisted",
    "future_action_guaranteed",
  ];
  return { ...input, userMessage: "北岸书店喝茶真正生效的安排是什么？" };
}

function activatedDocumentaryGoalInput(
  userMessage: string,
  options: {
    progress?: number;
    withoutEvidence?: boolean;
    memoryEvidence?: EvidenceBundle;
  } = {},
): Parameters<ReplyGenerationService["generate"]>[0] {
  const input = generationInput({ kind: "none" });
  const goal = input.character.persona.goals[0];
  if (goal === undefined) throw new Error("test character requires a goal");
  goal.title = "一部关于城市夜归人的纪录短片";
  goal.description = "把夜间回家的人如何穿过城市拍得真实而克制";
  goal.progress = options.progress ?? 0.4;
  input.validatedOutcome.replyDirectives.mustAddressUserQuotes = [userMessage];
  const plan = contextPlan(input.character, userMessage);
  return {
    ...input,
    userMessage,
    contextPlan: {
      ...plan,
      activatedGoalIds: [...new Set([...plan.activatedGoalIds, goal.id])],
    },
    ...(options.withoutEvidence === true
      ? {}
      : {
          memoryEvidence:
            options.memoryEvidence ?? documentaryGoalEvidenceFixture(),
        }),
  };
}

function documentaryGoalBottleneckEvidenceFixture(
  bottleneck: string,
): EvidenceBundle {
  const item = evidenceFixture(
    "evidence-documentary-bottleneck",
    `关于城市夜归人的纪录短片，${bottleneck}`,
  ).evidence[0];
  if (item === undefined) {
    throw new Error("goal bottleneck fixture requires an evidence record");
  }
  item.temporalMetadata = {
    recordedAtUtc: "2026-08-23T03:10:00.000Z",
    occurredStartAtUtc: "2026-08-23T03:10:00.000Z",
    temporalCertainty: "exact",
    temporalStatus: "in_progress",
  };
  return {
    query: "城市夜归人的纪录短片瓶颈",
    mode: "basic_memory",
    generatedAtUtc: NOW,
    score: 0.95,
    evidence: [item],
  };
}

function documentaryGoalEvidenceFixture(): EvidenceBundle {
  const started = evidenceFixture(
    "evidence-documentary-started",
    "开始了一部关于城市夜归人的纪录短片。",
  ).evidence[0];
  const completed = evidenceFixture(
    "evidence-documentary-completed",
    "完成了一部关于城市夜归人的纪录短片。",
  ).evidence[0];
  if (started === undefined || completed === undefined) {
    throw new Error("goal evidence fixture requires two evidence records");
  }
  started.temporalMetadata = {
    recordedAtUtc: "2026-08-23T01:10:00.000Z",
    occurredStartAtUtc: "2026-08-23T01:10:00.000Z",
    temporalCertainty: "exact",
    temporalStatus: "occurred",
  };
  completed.temporalMetadata = {
    recordedAtUtc: "2026-08-23T02:10:00.000Z",
    occurredStartAtUtc: "2026-08-23T02:10:00.000Z",
    temporalCertainty: "exact",
    temporalStatus: "occurred",
  };
  return {
    query: "城市夜归人的纪录短片进展",
    mode: "basic_memory",
    generatedAtUtc: NOW,
    score: 0.95,
    evidence: [started, completed],
  };
}

function documentaryGoalStatusEvidenceFixture(
  entries: readonly {
    id: string;
    content: string;
    occurredAtUtc: string;
  }[],
): EvidenceBundle {
  const evidence = entries.map(({ id, content, occurredAtUtc }) => {
    const item = evidenceFixture(`evidence-documentary-${id}`, content)
      .evidence[0];
    if (item === undefined) {
      throw new Error("goal status fixture requires an evidence record");
    }
    item.evidence.sourceType = "activity_event";
    item.evidence.sourceId = `event-documentary-${id}`;
    item.evidence.recordedAtUtc = occurredAtUtc;
    item.temporalMetadata = {
      recordedAtUtc: occurredAtUtc,
      occurredStartAtUtc: occurredAtUtc,
      temporalCertainty: "exact",
      temporalStatus: "occurred",
    };
    return item;
  });
  return {
    query: "城市夜归人的纪录短片进展",
    mode: "basic_memory",
    generatedAtUtc: NOW,
    score: 0.95,
    evidence,
  };
}

function memoryFixture(): MemoryLike {
  return {
    id: "memory-reply",
    agentId: "agent-reply",
    kind: "semantic",
    content: "SERVER_LEGACY_MEMORY_MARKER",
    importance: 0.8,
    confidence: 0.9,
    tags: [],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    status: "active",
    dedupeKey: "server-legacy-memory-marker",
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  };
}

function createService(
  generateObject: ReturnType<typeof vi.fn>,
  repairPersonaReply: ReturnType<typeof vi.fn>,
): ReplyGenerationService {
  return new ReplyGenerationService(
    {
      generateObject,
    },
    {
      repairPersonaReply,
    },
  );
}

function generationInput(
  scheduleOutcome: ScheduleOutcome,
): Parameters<ReplyGenerationService["generate"]>[0] {
  const character = characterSpec();
  const state = runtimeState();
  const outcome = validatedOutcome(scheduleOutcome, state);
  const userMessage =
    scheduleOutcome.kind === "none" ? "今天天气不错。" : "我们明天一起散步吧。";
  return {
    character,
    state,
    schedule: [],
    memories: [],
    recentMessages: [],
    nowUtc: NOW,
    userMessage,
    contextPlan: contextPlan(character, userMessage),
    validatedOutcome: outcome,
    replyStrategy: deriveReplyStrategy(userMessage, character.dialogue, {
      state,
      relationship: state.relationship,
    }),
  };
}

function recentCompletedActivityInput(): Parameters<
  ReplyGenerationService["generate"]
>[0] {
  const input = generationInput({ kind: "none" });
  input.validatedOutcome.replyDirectives.mode = "answer";
  input.validatedOutcome.replyDirectives.authoritativeFacts = [
    {
      kind: "activity",
      sourceId: "event-finished-completed",
      activityEventType: "completed",
      text: "最近一次已结算活动“早晨创作时间”已经结束，结果为已完成。",
      requiredAnchors: ["早晨创作时间", "已完成"],
    },
  ];
  return { ...input, userMessage: "刚才那项活动结束了吗？" };
}

function combinedDirectRecallInput(): Parameters<
  ReplyGenerationService["generate"]
>[0] {
  const input = generationInput({
    kind: "read_only",
    itemIds: ["schedule-shared"],
  });
  input.validatedOutcome.route = "schedule_query";
  input.validatedOutcome.observation.route = "schedule_query";
  Object.assign(input.validatedOutcome.replyDirectives, {
    evidenceOnly: false,
    mustAbstain: false,
    mustNotInferFromPersona: true,
    allowedEvidenceIds: ["evidence-bgw"],
    mustAddressUserQuotes: ["BGW-7419", "北岸书店"],
    authoritativeFacts: [
      {
        kind: "schedule",
        sourceId: "schedule-shared",
        text: "2026-08-23 11:30–12:15，北岸书店喝茶（Asia/Shanghai）。本地时间：2026年08月23日 11:30。",
        requiredAnchors: ["2026-08-23", "11:30", "12:15", "北岸书店"],
      },
    ],
  });
  return {
    ...input,
    userMessage:
      "请告诉我 BGW-7419 是什么、我演讲前把它放在哪里？另外，我们刚确认的共同安排是什么？",
  };
}

function validatedOutcome(
  scheduleOutcome: ScheduleOutcome,
  state: RuntimeState,
): ValidatedTurnOutcome {
  const scheduleRoute = scheduleOutcome.kind !== "none";
  return {
    route: scheduleRoute ? "schedule_mutation" : "conversation",
    observation: {
      origin: "model_valid",
      route: scheduleRoute ? "schedule_mutation" : "conversation",
      scheduleIntent: { kind: "none" },
      validatedEvidence: [],
      rejectedFields: [],
      worldEffectsValidation: validateWorldEffects({}),
      topics: [],
      confidence: 1,
      routerReasonCodes: [],
    },
    scheduleOutcome,
    validation: { accepted: [], rejections: [] },
    acceptedWorldEffects: {
      memoryCandidates: [],
      personalIntentCandidates: [],
    },
    worldEffectsMode: "enforced",
    worldEffectWritesEnabled: true,
    proposalRejections: [],
    nextState: state,
    stateChanged: false,
    replyDirectives: {
      mode:
        scheduleOutcome.kind === "pending_confirmation" ? "confirm" : "casual",
      evidenceOnly: false,
      mustAbstain: false,
      mustNotInferFromPersona: false,
      allowedEvidenceIds: [],
      mustAddressUserQuotes: [],
      authoritativeFacts:
        scheduleOutcome.kind === "pending_confirmation"
          ? [
              {
                kind: "schedule",
                text: "明天 19:00 的散步仍待用户确认，日程尚未修改。",
              },
            ]
          : [],
      mustNotClaim: [
        "schedule_committed",
        "schedule_cancelled",
        "memory_persisted",
        "future_action_guaranteed",
      ],
    },
    scheduleWritesEnabled: true,
    audit: {
      schemaVersion: 1,
      policyVersion: "test",
      decisionPath: "reply_only",
      dryRun: false,
    },
  };
}

function contextPlan(character: CharacterSpec, userText: string): ContextPlan {
  return buildContextPlan({ character, userText });
}

function runtimeState(): RuntimeState {
  return {
    agentId: "agent-reply",
    asOfUtc: NOW,
    moodValence: 0,
    moodArousal: 0.5,
    energy: 0.6,
    stress: 0.2,
    socialBattery: 0.6,
    focus: 0.7,
    sleepDebtMinutes: 0,
    relationship: {
      userId: "local-user",
      closeness: 0.5,
      trust: 0.5,
      familiarity: 0.5,
      recentInteractionValence: 0,
    },
    revision: 0,
  };
}

function characterSpec(): CharacterSpec {
  const origin = "synthetic_extension" as const;
  return {
    id: "agent-reply",
    version: 1,
    status: "published",
    tier: "high_fidelity",
    sourceType: "original",
    identity: {
      name: "林",
      workOrRole: "设计师",
      worldSetting: "当代城市",
      selfDescription: "说话自然、真诚。",
      timezone: "Asia/Shanghai",
    },
    persona: {
      traits: [
        {
          id: "trait-reply",
          name: "细心",
          description: "关注细节",
          strength: 0.9,
          triggers: ["细节"],
          exceptions: [],
          origin,
          sourceRefs: [],
        },
      ],
      values: [
        {
          id: "value-reply",
          name: "真诚",
          priority: 0.9,
          description: "不夸大事实",
          exceptions: [],
          origin,
          sourceRefs: [],
        },
      ],
      contradictions: [],
      goals: [
        {
          id: "goal-reply",
          title: "完成设计",
          description: "完成手头的设计稿",
          priority: 0.8,
          progress: 0.4,
          origin,
          sourceRefs: [],
        },
      ],
      preferences: [],
      boundaries: [],
    },
    dialogue: {
      primaryLanguage: "zh-CN",
      formality: 0.3,
      directness: 0.7,
      warmth: 0.8,
      verbosity: 0.4,
      humor: 0.2,
      averageMessageLength: 100,
      averageChunksPerTurn: 1,
      frequentPhrases: [],
      avoidedPhrases: [],
      greetingPatterns: [],
      refusalPatterns: [],
      comfortingPatterns: [],
    },
    userRelationship: {
      relationshipType: "friend",
      initialCloseness: 0.5,
      initialTrust: 0.5,
      addressTerms: [],
      sharedContext: "",
    },
    routines: [],
    schedulePolicy: {
      enabled: true,
      horizonHours: 72,
      extendWhenRemainingHoursBelow: 12,
      sleepWindow: { startLocal: "23:00", endLocal: "07:00" },
      maxCommittedHoursPerDay: 10,
      routineAdherence: 0.8,
      spontaneity: 0.4,
      socialInvitationBias: 0.5,
    },
    proactivePolicy: {
      enabled: true,
      maxMessagesPerDay: 1,
      quietHours: { startLocal: "23:00", endLocal: "08:00" },
      minimumCloseness: 0.4,
      shareableCategories: [],
    },
    knowledge: {
      knownFacts: [],
      uncertainFacts: [],
      forbiddenMetaKnowledge: ["system internals"],
    },
    sources: [],
    lockedPaths: [],
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  };
}
