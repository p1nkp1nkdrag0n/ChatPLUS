import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";
import type { GenerateObjectInput, LlmService } from "./llm-service.js";

const START_UTC = "2026-08-16T02:00:00.000Z";

describe("openai-compatible reply-first conversation path", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("keeps valid reply text while discarding malformed action-shaped extras", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          reply: {
            text: "我听见了。对我来说，这件事值得慢一点聊。",
            toneTags: ["温和", 42, "", "x".repeat(65)],
            scheduleEffects: [{ operation: "destroy_everything" }],
          },
          scheduleEffects: "not-an-array",
          memoryCandidates: [{ malformed: true }],
          unknownProviderField: { nested: true },
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "lightweight");
    calls.length = 0;
    const beforeState = app.personasim.store.getRuntimeState(character.id);
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "reply-first-1",
      "最近总觉得有些事情没想明白。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toBe(
      "我听见了。\n对我来说，这件事值得慢一点聊。",
    );
    expect(body.assistantMessage.metadata.deliveryMode).toBe("sequential");
    expect(body.assistantMessage.metadata.chunks).toEqual([
      "我听见了。",
      "对我来说，这件事值得慢一点聊。",
    ]);
    expect(body.assistantMessage.metadata.toneTags).toEqual(["温和"]);
    expect(body.assistantMessage.metadata.repairAttempted).toBe(false);
    expect(body.scheduleChanges).toEqual([]);
    expect(body.decision.reasonCode).toBe("persona_chat_reply");
    expect(body.state).toMatchObject({
      ...beforeState,
      revision: (beforeState?.revision ?? 0) + 1,
      relationship: {
        ...beforeState?.relationship,
        lastInteractionAtUtc: START_UTC,
      },
    });
    expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);
    expect(calls[0]?.maxOutputTokens).toBe(2_000);
    expect(
      calls[0]?.schema.safeParse({
        text: "有效回复",
        scheduleEffects: [{ operation: "invalid" }],
      }).success,
    ).toBe(false);
    expect(
      calls[0]?.schema.safeParse({
        replyDecision: {
          text: "Valid reply.",
        },
        worldEffects: {},
        scheduleEffects: [{ operation: "invalid" }],
      }).success,
    ).toBe(true);
  });

  it("keeps a one-sentence short answer in one block", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          text: "可以，这个方向没问题。",
          deliveryMode: "single_block",
          chunks: ["这段错误的分块不应该覆盖正文。"],
          toneTags: ["直接"],
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "lightweight");
    calls.length = 0;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "delivery-single",
      "请用一句话回答：这个方向可以吗？",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toBe("可以，这个方向没问题。");
    expect(body.assistantMessage.metadata.deliveryMode).toBe("single_block");
    expect(body.assistantMessage.metadata.chunks).toEqual([
      "可以，这个方向没问题。",
    ]);
    expect(body.assistantMessage.metadata.repairAttempted).toBe(false);
  });

  it("calibrates a low-formality multi-beat comfort reply into chat bubbles", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          text: "先别逼自己马上振作。你已经撑了很久。今晚先让我陪你慢慢缓一缓。",
          deliveryMode: "single_block",
          toneTags: ["温柔", "安慰"],
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "lightweight");
    calls.length = 0;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "delivery-persona-calibration",
      "我今天真的有点难受。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.metadata.deliveryMode).toBe("sequential");
    expect(body.assistantMessage.metadata.chunks).toEqual([
      "先别逼自己马上振作。",
      "你已经撑了很久。",
      "今晚先让我陪你慢慢缓一缓。",
    ]);
    expect(body.assistantMessage.content).toBe(
      "先别逼自己马上振作。\n你已经撑了很久。\n今晚先让我陪你慢慢缓一缓。",
    );
  });

  it("honors sequential delivery and falls back to deterministic sentence chunks", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          text: "我刚看到你的消息。这个想法挺有意思。你再说说细节？",
          deliveryMode: "sequential",
          chunks: ["与正文不一致，但不应该导致回复失败。"],
          toneTags: ["自然", "好奇"],
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "lightweight");
    calls.length = 0;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "delivery-sequential",
      "我有个新想法。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.metadata.deliveryMode).toBe("sequential");
    expect(body.assistantMessage.metadata.chunks).toEqual([
      "我刚看到你的消息。",
      "这个想法挺有意思。",
      "你再说说细节？",
    ]);
    expect(body.assistantMessage.content).toBe(
      "我刚看到你的消息。\n这个想法挺有意思。\n你再说说细节？",
    );
    expect(body.assistantMessage.metadata.repairAttempted).toBe(false);
    expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);
  });

  it("persists faithful model-authored sequential chunks", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          text: "你等等。让我想一下。好，我大概有答案了。",
          deliveryMode: "sequential",
          chunks: ["你等等。", "让我想一下。", "好，我大概有答案了。"],
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "lightweight");
    calls.length = 0;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "delivery-faithful",
      "你想到答案了吗？",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.metadata.deliveryMode).toBe("sequential");
    expect(body.assistantMessage.metadata.chunks).toEqual([
      "你等等。",
      "让我想一下。",
      "好，我大概有答案了。",
    ]);
    expect(body.assistantMessage.content).toBe(
      "你等等。\n让我想一下。\n好，我大概有答案了。",
    );
    expect(body.assistantMessage.metadata.repairAttempted).toBe(false);
  });

  it("does not erase ordinary spaces when checking model chunks", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          text: "Hello world.",
          deliveryMode: "sequential",
          chunks: ["Hello", "world."],
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "lightweight");
    calls.length = 0;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "delivery-space-fidelity",
      "Say it in English.",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toBe("Hello world.");
    expect(body.assistantMessage.metadata.chunks).toEqual(["Hello world."]);
    expect(body.assistantMessage.metadata.deliveryMode).toBe("single_block");
    expect(body.assistantMessage.metadata.repairAttempted).toBe(false);
  });

  it("packs many sequential sentences without gluing words or losing line separators", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const sentences = Array.from(
      { length: 13 },
      (_, index) => `Sentence ${index + 1}.`,
    );
    const completeText = `${sentences.slice(0, 6).join(" ")}\n${sentences
      .slice(6)
      .join(" ")}`;
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          text: completeText,
          deliveryMode: "sequential",
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "lightweight");
    calls.length = 0;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "delivery-pack-fidelity",
      "Tell me the sequence.",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.metadata.deliveryMode).toBe("sequential");
    expect(
      (body.assistantMessage.metadata.chunks as string[]).length,
    ).toBeLessThanOrEqual(12);
    expect(body.assistantMessage.content).toContain("Sentence 6.\nSentence 7.");
    expect(body.assistantMessage.content.replace(/\n/gu, " ")).toBe(
      completeText.replace(/\n/gu, " "),
    );
  });

  it("keeps a deep structured answer in one coherent block", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          text: "1. 先确认目标。\n2. 再验证最小链路。\n3. 最后逐步扩展。",
          deliveryMode: "single_block",
          chunks: { malformed: true },
          toneTags: ["认真"],
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "lightweight");
    calls.length = 0;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "delivery-complex",
      "请从零开始完整设计这个系统，并详细分析失败原因和逐步改进方案。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.metadata.deliveryMode).toBe("single_block");
    expect(body.assistantMessage.metadata.chunks).toEqual([
      "1. 先确认目标。\n2. 再验证最小链路。\n3. 最后逐步扩展。",
    ]);
    expect(body.assistantMessage.metadata.repairAttempted).toBe(false);
  });

  it("passes a larger soft budget and explicit strategy for a deep request", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          text: "我会把问题拆成目标、约束、最小验证和迭代边界四部分，再逐一展开。",
          deliveryMode: "single_block",
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "lightweight", {
      verbosity: 1,
      averageMessageLength: 800,
      averageChunksPerTurn: 1,
    });
    calls.length = 0;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "deep-budget",
      "请从零开始给出一套完整设计，详细分析目标、架构、主要取舍、失败风险和逐步实施方案。",
    );

    expect(response.statusCode).toBe(201);
    const chatCall = calls.find((input) => input.purpose === "chat_turn");
    expect(chatCall?.maxOutputTokens).toBeGreaterThan(2_000);
    expect(chatCall?.prompt).toContain('"complexity":"deep"');
    expect(chatCall?.prompt).toContain("softTargetCharacters");
    expect(chatCall?.prompt).toContain("guidance, not a quota");
    expect(chatCall?.prompt).toContain(
      '"deliveryPreference":"prefer_single_block"',
    );
  });

  it("does not mistake ordinary in-character actions for schedule mutations", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          text: "我已经取消关注他了，不想再把精力浪费在无意义的争论上。",
          toneTags: ["克制", "直接"],
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "high_fidelity");
    calls.length = 0;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "reply-first-ordinary-action",
      "那个人后来怎么样了？",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toContain("已经取消关注他了");
    expect(body.assistantMessage.metadata.repairAttempted).toBe(false);
    expect(body.scheduleChanges).toEqual([]);
    expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);
  });

  it("repairs only an explicit uncommitted schedule claim", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          text: "我已经修改了今晚的日程。",
          toneTags: ["肯定"],
        };
      }
      if (input.purpose === "repair_chat_turn") {
        return {
          text: "如果你愿意，我们可以聊聊今晚怎么安排；我还没有替你改动任何计划。",
          toneTags: ["坦诚"],
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "lightweight");
    calls.length = 0;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "reply-first-schedule-claim",
      "帮我把今晚的事情安排一下。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toContain("还没有替你改动任何计划");
    expect(body.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(body.scheduleChanges).toEqual([]);
    expect(calls.map((input) => input.purpose)).toEqual([
      "chat_turn",
      "repair_chat_turn",
    ]);
  });

  it("repairs a persona-guard violation using the role, user text, and concrete issues", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          text: "作为一个AI语言模型，我没有自己的生活。",
          toneTags: ["meta"],
        };
      }
      if (input.purpose === "repair_chat_turn") {
        return {
          text: "我是林夏。最近大半心思都放在毕业作品上，你想先听哪一部分？",
          toneTags: ["自然", "坦诚"],
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "high_fidelity");
    calls.length = 0;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "reply-first-guard",
      "请以你自己的身份介绍一下自己。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toContain("我是林夏");
    expect(body.assistantMessage.content).not.toContain("AI语言模型");
    expect(body.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(body.scheduleChanges).toEqual([]);
    expect(calls.map((input) => input.purpose)).toEqual([
      "chat_turn",
      "repair_chat_turn",
    ]);
    const repairCall = calls[1];
    expect(repairCall?.maxRetries).toBe(0);
    expect(repairCall?.maxOutputTokens).toBe(2_000);
    expect(repairCall?.prompt).toContain("林夏");
    expect(repairCall?.prompt).toContain("请以你自己的身份介绍一下自己。");
    expect(repairCall?.prompt).toContain("AI_META_DISCLOSURE");
  });

  it("uses a neutral conversational fallback after both model attempts fail", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (
        input.purpose === "chat_turn" ||
        input.purpose === "repair_chat_turn"
      ) {
        throw new Error("simulated provider failure");
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "high_fidelity");
    calls.length = 0;
    const stateBefore = app.personasim.store.getRuntimeState(character.id);
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "reply-first-fallback",
      "你现在有什么想说的吗？",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).not.toMatch(/日程|安排|时间/u);
    expect(body.assistantMessage.content).toContain("认真听");
    expect(body.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(body.decision.reasonCode).toBe("persona_chat_fallback");
    expect(body.scheduleChanges).toEqual([]);
    expect(body.state).toMatchObject({
      ...stateBefore,
      revision: (stateBefore?.revision ?? 0) + 1,
      relationship: {
        ...stateBefore?.relationship,
        familiarity: (stateBefore?.relationship.familiarity ?? 0) + 0.001,
        lastInteractionAtUtc: START_UTC,
      },
    });
    expect(calls.map((input) => input.purpose)).toEqual([
      "chat_turn",
      "repair_chat_turn",
    ]);
  });

  it("replays a legacy assistant message without chunk metadata", async () => {
    const created = await createRealProviderTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, fixtureFor);
    const character = await createAndPublish(app, "lightweight");
    calls.length = 0;
    const sessionId = await createSession(app, character.id);
    const userMessageId = "message-legacy-user";
    const legacyContent = "这是旧版本保存的一条完整回复。";
    app.personasim.store.insertMessage({
      id: userMessageId,
      sessionId,
      agentId: character.id,
      role: "user",
      content: "旧消息",
      messageKind: "user",
      clientMessageId: "legacy-replay",
      metadata: {},
      createdAtUtc: START_UTC,
    });
    app.personasim.store.insertMessage({
      id: "message-legacy-assistant",
      sessionId,
      agentId: character.id,
      role: "assistant",
      content: legacyContent,
      messageKind: "assistant_reply",
      inReplyToMessageId: userMessageId,
      metadata: {
        reasonCode: "legacy_reply",
        reasonSummary: "旧版本消息。",
        toneTags: [],
      },
      createdAtUtc: START_UTC,
    });

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "legacy-replay",
      "旧消息",
    );

    expect(response.statusCode).toBe(200);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.idempotentReplay).toBe(true);
    expect(body.decision.chunks).toEqual([legacyContent]);
    expect(body.decision.deliveryMode).toBe("single_block");
    expect(calls).toEqual([]);
  });

  it("rejects legacy flat world-effect output at the live schema boundary", async () => {
    const created = await createRealProviderTestApp("enforced");
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const legacyFlat = {
      text: "Legacy flat reply must be rejected.",
      stateDelta: { energy: -0.15 },
    };
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        calls.push(input);
        if (input.purpose === "chat_turn") {
          return Promise.resolve(legacyFlat as never);
        }
        if (input.purpose === "repair_chat_turn") {
          return Promise.resolve({
            text: "I rewrote that response through the canonical repair path.",
          } as never);
        }
        return Promise.resolve(fixtureFor(input) as never);
      },
    );
    const character = await createAndPublish(app, "high_fidelity");
    calls.length = 0;
    const before = app.personasim.store.getRuntimeState(character.id)!;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "strict-envelope-flat-reject",
      "Please respond while applying a small energy effect.",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toContain("canonical repair path");
    expect(body.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(body.state.energy).toBeCloseTo(before.energy);
    const chatCall = calls.find((input) => input.purpose === "chat_turn");
    expect(chatCall?.schema.safeParse(legacyFlat).success).toBe(false);
    expect(calls.map((input) => input.purpose)).toEqual([
      "chat_turn",
      "repair_chat_turn",
    ]);
  });

  it("commits only the interaction baseline while shadowing model effects", async () => {
    const created = await createRealProviderTestApp("shadow");
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          replyDecision: {
            text: "I can feel this conversation taking a little energy.",
          },
          worldEffects: {
            stateDelta: { energy: -0.1 },
            relationshipDelta: { familiarity: 0.02 },
          },
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "high_fidelity");
    calls.length = 0;
    const before = app.personasim.store.getRuntimeState(character.id)!;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "world-effects-shadow-characterization",
      "Stay with me for a moment.",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.state).toMatchObject({
      ...before,
      energy: before.energy,
      revision: before.revision + 1,
      relationship: {
        ...before.relationship,
        familiarity: before.relationship.familiarity + 0.001,
        lastInteractionAtUtc: START_UTC,
      },
    });
    const audit = app.personasim.store
      .listDomainEvents(character.id, 100)
      .find(
        (event) =>
          event.eventType === "conversation.world_effects_shadow_evaluated",
      );
    expect(audit?.payload).toMatchObject({
      mode: "shadow",
      accepted: { stateDelta: true, relationshipDelta: true },
      interactionStatus: "committed",
      llmProposalStatus: "shadow",
      applied: {
        stateDelta: {},
        relationshipDelta: { familiarity: 0.001 },
      },
      wouldApply: {
        after: {
          energy: before.energy - 0.1,
          relationship: {
            familiarity: before.relationship.familiarity + 0.012,
          },
        },
      },
    });
  });

  it("advances relationship time and baseline on an effect-free turn", async () => {
    const created = await createRealProviderTestApp("enforced");
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          replyDecision: { text: "I am glad you stopped by." },
          worldEffects: {},
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "high_fidelity");
    calls.length = 0;
    const before = app.personasim.store.getRuntimeState(character.id)!;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "relationship-time-characterization",
      "Hi, I just wanted to say hello.",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.state.revision).toBe(before.revision + 1);
    expect(body.state.relationship).toMatchObject({
      ...before.relationship,
      familiarity: before.relationship.familiarity + 0.001,
      lastInteractionAtUtc: START_UTC,
    });
    const audit = app.personasim.store
      .listDomainEvents(character.id, 100)
      .find(
        (event) => event.eventType === "conversation.world_effects_committed",
      );
    expect(audit?.payload).toMatchObject({
      mode: "enforced",
      source: { relationshipBaseline: "server_interaction_baseline" },
      relationship: {
        baselineDelta: { familiarity: 0.001 },
        dailyUsageApplied: { familiarity: 0.001 },
      },
    });
  });

  it("commits valid world effects while rejecting malformed siblings", async () => {
    const created = await createRealProviderTestApp("enforced");
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          replyDecision: {
            text: "That sounds worth exploring.",
            deliveryMode: "single_block",
          },
          worldEffects: {
            stateDelta: { energy: -1, stress: 0.1 },
            relationshipDelta: { closeness: 1, trust: 0.2 },
            personalIntentCandidates: [
              {
                activity: "photograph the riverside night view",
                category: "leisure",
                durationHint: "60 minutes",
                timingHint: "tonight",
                basisKind: "chat",
                evidenceQuotes: ["The riverside night view is beautiful"],
                reasonCode: "chat_grounded_interest",
                reasonSummary: "The user expressed a grounded interest.",
              },
              {
                activity: "model-owned exact time",
                basisKind: "chat",
                evidenceQuotes: ["The riverside night view is beautiful"],
                reasonCode: "invalid_exact_time",
                reasonSummary: "This candidate must be rejected.",
                earliestAtUtc: "2026-08-16T12:00:00.000Z",
              },
            ],
          },
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "high_fidelity");
    calls.length = 0;
    const before = app.personasim.store.getRuntimeState(character.id)!;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "world-effects-commit",
      "The riverside night view is beautiful; I would love to photograph it tonight.",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toBe("That sounds worth exploring.");
    expect(body.state.energy).toBeCloseTo(before.energy - 0.2, 8);
    expect(body.state.stress).toBeCloseTo(before.stress + 0.1, 8);
    expect(body.state.relationship.closeness).toBeGreaterThan(
      before.relationship.closeness,
    );
    expect(body.state.relationship.closeness).toBeLessThanOrEqual(
      before.relationship.closeness + 0.1,
    );
    const intentCount = app.personasim.store.database
      .prepare(
        "SELECT COUNT(*) AS count FROM personal_intentions WHERE agent_id = ?",
      )
      .get(character.id) as { count: number };
    expect(intentCount.count).toBe(1);
    const rejection = app.personasim.store.database
      .prepare(
        "SELECT reason_code FROM rejected_proposals WHERE agent_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(character.id) as { reason_code: string } | undefined;
    expect(rejection?.reason_code).toBe("server_owned_effect_field");
    const audit = app.personasim.store
      .listDomainEvents(character.id, 100)
      .find(
        (event) => event.eventType === "conversation.world_effects_committed",
      );
    expect(audit?.payload).toMatchObject({
      mode: "enforced",
      proposed: {
        stateDelta: { energy: -1, stress: 0.1 },
        relationshipDelta: { closeness: 1, trust: 0.2 },
      },
      acceptedDelta: {
        stateDelta: { energy: -0.2, stress: 0.1 },
        relationshipDelta: { closeness: 0.08, trust: 0.08 },
      },
      accepted: {
        stateDelta: true,
        relationshipDelta: true,
        personalIntentCandidateCount: 1,
      },
      before: {
        revision: before.revision,
        energy: before.energy,
        stress: before.stress,
      },
      after: {
        revision: before.revision + 1,
        energy: before.energy - 0.2,
        stress: before.stress + 0.1,
      },
      limitsApplied: ["state_delta", "relationship_delta"],
      rejections: [
        {
          effect: "personal_intent_candidate",
          reasonCode: "server_owned_effect_field",
          reasonSummary: "Personal-intent field earliestAtUtc is server-owned.",
        },
      ],
      rejectionCodes: ["server_owned_effect_field"],
    });
    const applied = (
      audit?.payload as
        | {
            applied?: {
              stateDelta?: Record<string, number>;
              relationshipDelta?: Record<string, number>;
            };
          }
        | undefined
    )?.applied;
    expect(applied?.stateDelta?.["energy"]).toBeCloseTo(-0.2, 8);
    expect(applied?.stateDelta?.["stress"]).toBeCloseTo(0.1, 8);
    const appliedRelationshipDelta = applied?.relationshipDelta;
    expect(appliedRelationshipDelta?.["closeness"]).toBeCloseTo(0.04, 8);
    expect(appliedRelationshipDelta?.["trust"]).toBeCloseTo(0.03, 8);
    expect(appliedRelationshipDelta?.["familiarity"]).toBeCloseTo(0.001, 8);
    expect(audit?.payload).not.toHaveProperty("proposedDelta");
    expect(audit?.payload).not.toHaveProperty("beforeChangedFields");
    expect(audit?.payload).not.toHaveProperty("afterChangedFields");
  });

  it("reads the exact committed post-state into the next prompt after a file-database restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "personasim-state-restart-"));
    const databasePath = join(directory, "post-state.sqlite");
    const clock = new FakeClock(START_UTC);

    try {
      const created = await createRealProviderTestApp("enforced", {
        databasePath,
        clock,
      });
      app = created.app;
      const firstCalls: Array<GenerateObjectInput<unknown>> = [];
      mockLlm(app.personasim.llm, firstCalls, (input) => {
        if (input.purpose === "chat_turn") {
          return {
            replyDecision: { text: "I need a little quieter time now." },
            worldEffects: {
              stateDelta: { energy: -0.12, stress: 0.06, focus: -0.04 },
            },
          };
        }
        return fixtureFor(input);
      });
      const character = await createAndPublish(app, "high_fidelity");
      const sessionId = await createSession(app, character.id);
      firstCalls.length = 0;
      clock.advance({ minutes: 17 });
      const before = app.personasim.store.getRuntimeState(character.id)!;

      const committed = await sendMessage(
        app,
        sessionId,
        character.id,
        "post-state-before-restart",
        "How are you feeling right now?",
      );

      expect(committed.statusCode).toBe(201);
      const committedState = app.personasim.store.getRuntimeState(
        character.id,
      )!;
      expect(committedState).toMatchObject({
        energy: before.energy - 0.12,
        stress: before.stress + 0.06,
        focus: before.focus - 0.04,
        asOfUtc: clock.nowUtc(),
        revision: before.revision + 1,
      });

      await app.close();
      app = undefined;

      const reopened = await createRealProviderTestApp("enforced", {
        databasePath,
        clock,
      });
      app = reopened.app;
      expect(app.personasim.store.getRuntimeState(character.id)).toEqual(
        committedState,
      );
      const reopenedCalls: Array<GenerateObjectInput<unknown>> = [];
      mockLlm(app.personasim.llm, reopenedCalls, (input) => {
        if (input.purpose === "chat_turn") {
          return {
            replyDecision: { text: "I am carrying that state forward." },
            worldEffects: {},
          };
        }
        return fixtureFor(input);
      });

      const nextTurn = await sendMessage(
        app,
        sessionId,
        character.id,
        "post-state-after-restart",
        "And now?",
      );

      expect(nextTurn.statusCode).toBe(201);
      const chatCall = reopenedCalls.find(
        (input) => input.purpose === "chat_turn",
      );
      expect(chatCall).toBeDefined();
      const promptState = promptJsonSegment(
        chatCall?.prompt ?? "",
        "RUNTIME_STATE_JSON",
      );
      expect(promptState).toMatchObject({
        asOfUtc: committedState.asOfUtc,
        revision: committedState.revision,
        moodValence: committedState.moodValence,
        moodArousal: committedState.moodArousal,
        energy: committedState.energy,
        stress: committedState.stress,
        socialBattery: committedState.socialBattery,
        focus: committedState.focus,
        sleepDebtMinutes: committedState.sleepDebtMinutes,
      });
      expect(
        promptJsonSegment(chatCall?.prompt ?? "", "RELATIONSHIP_JSON"),
      ).toEqual({
        closeness: committedState.relationship.closeness,
        trust: committedState.relationship.trust,
        familiarity: committedState.relationship.familiarity,
        recentInteractionValence:
          committedState.relationship.recentInteractionValence,
        lastInteractionAtUtc: committedState.relationship.lastInteractionAtUtc,
      });
    } finally {
      if (app !== undefined) {
        await app.close();
        app = undefined;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not reapply state, relationship, revision, or audit on a client-message replay", async () => {
    const created = await createRealProviderTestApp("enforced");
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          replyDecision: { text: "That helped me feel more grounded." },
          worldEffects: {
            stateDelta: { energy: -0.11, stress: 0.04 },
            relationshipDelta: {
              closeness: 0.02,
              trust: 0.01,
              recentInteractionValence: 0.2,
            },
          },
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "high_fidelity");
    const sessionId = await createSession(app, character.id);
    calls.length = 0;
    const clientMessageId = "world-effects-idempotent-replay";
    const text = "I am glad we talked this through together.";
    const before = app.personasim.store.getRuntimeState(character.id)!;

    const first = await sendMessage(
      app,
      sessionId,
      character.id,
      clientMessageId,
      text,
    );

    expect(first.statusCode).toBe(201);
    const firstBody = jsonBody<ChatTurnResult>(first);
    const afterFirst = app.personasim.store.getRuntimeState(character.id)!;
    expect(afterFirst.revision).toBe(before.revision + 1);
    expect(afterFirst.energy).toBeCloseTo(before.energy - 0.11, 8);
    expect(afterFirst.relationship).not.toEqual(before.relationship);
    const auditCountAfterFirst = worldEffectAuditCount(
      app,
      character.id,
      clientMessageId,
    );
    expect(auditCountAfterFirst).toBe(1);

    const replay = await sendMessage(
      app,
      sessionId,
      character.id,
      clientMessageId,
      text,
    );

    expect(replay.statusCode).toBe(200);
    const replayBody = jsonBody<ChatTurnResult>(replay);
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.state).toEqual(firstBody.state);
    expect(app.personasim.store.getRuntimeState(character.id)).toEqual(
      afterFirst,
    );
    expect(replayBody.state.revision).toBe(afterFirst.revision);
    expect(replayBody.state.relationship).toEqual(afterFirst.relationship);
    expect(worldEffectAuditCount(app, character.id, clientMessageId)).toBe(
      auditCountAfterFirst,
    );
    expect(calls.filter((input) => input.purpose === "chat_turn")).toHaveLength(
      1,
    );
  });

  it("preserves validated effects when reply repair succeeds", async () => {
    const created = await createRealProviderTestApp("enforced");
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          replyDecision: { text: "As an AI language model, I have no life." },
          worldEffects: { stateDelta: { energy: -0.1 } },
        };
      }
      if (input.purpose === "repair_chat_turn") {
        return { text: "I am here, and I want to answer as myself." };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "high_fidelity");
    calls.length = 0;
    const before = app.personasim.store.getRuntimeState(character.id)!;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "world-effects-repair",
      "Please answer in your own voice.",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toContain("answer as myself");
    expect(body.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(body.state.energy).toBeCloseTo(before.energy - 0.1, 8);
    expect(calls.map((input) => input.purpose)).toEqual([
      "chat_turn",
      "repair_chat_turn",
    ]);
  });

  it("repairs a parse-invalid reply while preserving independently valid effects", async () => {
    const created = await createRealProviderTestApp("enforced");
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const rawTurn = {
      replyDecision: { text: { invalid: true } },
      worldEffects: {
        stateDelta: { energy: -0.12 },
        scheduleMutationBundle: { owner: "model" },
      },
      scheduleMutationBundle: { owner: "model" },
    };
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") return rawTurn;
      if (input.purpose === "repair_chat_turn") {
        return { text: "I needed to rephrase that, but I am still here." };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "high_fidelity");
    calls.length = 0;
    const before = app.personasim.store.getRuntimeState(character.id)!;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "world-effects-invalid-reply",
      "Please cancel dinner tomorrow, then try that answer again.",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toContain("still here");
    expect(body.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(body.state.energy).toBeCloseTo(before.energy - 0.12, 8);
    expect(body.scheduleChanges).toEqual([]);
    const chatCall = calls.find((input) => input.purpose === "chat_turn");
    expect(chatCall?.schema.safeParse(rawTurn).success).toBe(true);
    expect(calls.map((input) => input.purpose)).toEqual([
      "chat_turn",
      "repair_chat_turn",
    ]);
  });

  it("audits an ungrounded personal intent without aborting the reply", async () => {
    const created = await createRealProviderTestApp("enforced");
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          replyDecision: { text: "That is an interesting thought." },
          worldEffects: {
            personalIntentCandidates: [
              {
                activity: "photograph the riverside",
                category: "leisure",
                durationHint: "60 minutes",
                timingHint: "tonight",
                basisKind: "chat",
                evidenceQuotes: ["This quote was never said"],
                reasonCode: "chat_grounded_interest",
                reasonSummary: "The model proposed a chat-derived interest.",
              },
            ],
          },
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "high_fidelity");
    calls.length = 0;
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "world-effects-ungrounded-intent",
      "The riverside is calm today.",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toBe(
      "That is an interesting thought.",
    );
    const counts = app.personasim.store.database
      .prepare(
        "SELECT (SELECT COUNT(*) FROM messages WHERE session_id = ?) AS messages, (SELECT COUNT(*) FROM personal_intentions WHERE agent_id = ?) AS intents",
      )
      .get(sessionId, character.id) as { messages: number; intents: number };
    expect(counts).toEqual({ messages: 2, intents: 0 });
    const rejection = app.personasim.store.database
      .prepare(
        "SELECT reason_code FROM rejected_proposals WHERE agent_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(character.id) as { reason_code: string } | undefined;
    expect(rejection?.reason_code).toBe("ungrounded_evidence_quote");
  });

  it("rolls back the entire turn when world-effect audit persistence fails", async () => {
    const created = await createRealProviderTestApp("enforced");
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "chat_turn") {
        return {
          replyDecision: { text: "I will keep that in mind." },
          worldEffects: {
            stateDelta: { energy: -0.1 },
            personalIntentCandidates: [
              {
                activity: "photograph the riverside night view",
                category: "leisure",
                durationHint: "60 minutes",
                timingHint: "tonight",
                basisKind: "chat",
                evidenceQuotes: ["The riverside night view is beautiful"],
                reasonCode: "chat_grounded_interest",
                reasonSummary: "The user expressed a grounded interest.",
              },
            ],
          },
        };
      }
      return fixtureFor(input);
    });
    const character = await createAndPublish(app, "high_fidelity");
    calls.length = 0;
    const before = app.personasim.store.getRuntimeState(character.id)!;
    const sessionId = await createSession(app, character.id);
    const insertDomainEvent = app.personasim.store.insertDomainEvent.bind(
      app.personasim.store,
    );
    vi.spyOn(app.personasim.store, "insertDomainEvent").mockImplementation(
      (event) =>
        event.eventType === "conversation.world_effects_committed"
          ? false
          : insertDomainEvent(event),
    );

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "world-effects-rollback",
      "The riverside night view is beautiful; I would love to photograph it tonight.",
    );

    expect(response.statusCode).toBe(500);
    expect(app.personasim.store.getRuntimeState(character.id)).toEqual(before);
    const messageCount = app.personasim.store.database
      .prepare("SELECT COUNT(*) AS count FROM messages WHERE session_id = ?")
      .get(sessionId) as { count: number };
    const intentCount = app.personasim.store.database
      .prepare(
        "SELECT COUNT(*) AS count FROM personal_intentions WHERE agent_id = ?",
      )
      .get(character.id) as { count: number };
    expect(messageCount.count).toBe(0);
    expect(intentCount.count).toBe(0);
  });
});

function mockLlm(
  llm: LlmService,
  calls: Array<GenerateObjectInput<unknown>>,
  responder: (input: GenerateObjectInput<unknown>) => unknown,
): void {
  vi.spyOn(llm, "generateObject").mockImplementation((input) => {
    calls.push(input);
    const output = responder(input);
    return Promise.resolve(
      input.purpose === "chat_turn"
        ? (canonicalChatEnvelopeFixture(output) as never)
        : output,
    );
  });
}

function canonicalChatEnvelopeFixture(output: unknown): unknown {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return { replyDecision: output, worldEffects: {} };
  }
  const record = output as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, "replyDecision")) {
    return output;
  }
  const replyDecision: Record<string, unknown> = {};
  for (const key of [
    "text",
    "toneTags",
    "deliveryMode",
    "chunks",
    "scheduleAction",
  ] as const) {
    if (record[key] !== undefined) replyDecision[key] = record[key];
  }
  const nestedReply =
    record["reply"] === undefined ? replyDecision : record["reply"];
  const worldEffects =
    typeof record["worldEffects"] === "object" &&
    record["worldEffects"] !== null &&
    !Array.isArray(record["worldEffects"])
      ? record["worldEffects"]
      : {};
  return {
    replyDecision: nestedReply,
    worldEffects,
    ...(record["scheduleEffects"] === undefined
      ? {}
      : { scheduleEffects: record["scheduleEffects"] }),
  };
}

function fixtureFor(input: GenerateObjectInput<unknown>): unknown {
  if (input.fixture !== undefined) return input.fixture;
  throw new Error(`No fixture for ${input.purpose}`);
}

async function createRealProviderTestApp(
  liveWorldEffectsMode: "off" | "shadow" | "enforced" = "off",
  options: { databasePath?: string; clock?: FakeClock } = {},
): Promise<{
  app: PersonaSimApp;
  clock: FakeClock;
}> {
  const clock = options.clock ?? new FakeClock(START_UTC);
  const databasePath = options.databasePath ?? ":memory:";
  const config = readConfig({
    nodeEnv: "test",
    databasePath,
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    scheduleNegotiationMode: "legacy",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode,
    llm: {
      provider: "openai-compatible",
      baseUrl: "https://example.invalid",
      apiKey: "test-api-key",
      model: "test-live-model",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
  });
  const app = await buildApp({
    config,
    database: openDatabase(databasePath),
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
  return { app, clock };
}

async function createAndPublish(
  app: PersonaSimApp,
  tier: "lightweight" | "high_fidelity",
  dialoguePatch?: {
    verbosity?: number;
    averageMessageLength?: number;
    averageChunksPerTurn?: number;
  },
): Promise<{ id: string; version: number }> {
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "林夏",
      worldSetting: "当代城市生活",
      workOrRole: "研究生与独立插画师",
      coreTraits: ["认真", "有主见", "温暖"],
      centralContradiction: "既重视创作计划，也珍惜重要关系",
      primaryGoal: "完成毕业作品",
      relationshipToUser: "熟悉的朋友",
      dialogueStyle: "自然、简洁、偶尔冷幽默",
      tier,
      timezone: "Asia/Shanghai",
    },
  });
  expect(generated.statusCode).toBe(201);
  let draft = jsonBody<{ character: { id: string; version: number } }>(
    generated,
  ).character;
  if (dialoguePatch !== undefined) {
    const updated = await app.inject({
      method: "PATCH",
      url: `/api/characters/${draft.id}`,
      payload: {
        patch: { dialogue: dialoguePatch },
        expectedVersion: draft.version,
      },
    });
    expect(updated.statusCode).toBe(200);
    draft = jsonBody<{ character: { id: string; version: number } }>(
      updated,
    ).character;
  }
  const published = await app.inject({
    method: "POST",
    url: `/api/characters/${draft.id}/publish`,
    payload: { expectedVersion: draft.version },
  });
  expect(published.statusCode).toBe(200);
  return jsonBody<{ character: { id: string; version: number } }>(published)
    .character;
}

async function createSession(
  app: PersonaSimApp,
  agentId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/sessions`,
    payload: {},
  });
  expect(response.statusCode).toBe(201);
  return jsonBody<{ session: { id: string } }>(response).session.id;
}

function sendMessage(
  app: PersonaSimApp,
  sessionId: string,
  agentId: string,
  clientMessageId: string,
  text: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/messages`,
    payload: { agentId, clientMessageId, text },
  });
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

function promptJsonSegment(
  prompt: string,
  label: string,
): Record<string, unknown> {
  const lines = prompt.split("\n");
  const index = lines.indexOf(label);
  expect(index).toBeGreaterThanOrEqual(0);
  return JSON.parse(lines[index + 1] ?? "{}") as Record<string, unknown>;
}

function worldEffectAuditCount(
  currentApp: PersonaSimApp,
  agentId: string,
  correlationId: string,
): number {
  const row = currentApp.personasim.store.database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM domain_events
       WHERE agent_id = ?
         AND event_type = 'conversation.world_effects_committed'
         AND correlation_id = ?`,
    )
    .get(agentId, correlationId) as { count: number };
  return Number(row.count);
}
