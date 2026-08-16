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
    expect(body.state).toEqual(beforeState);
    expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);
    expect(calls[0]?.maxOutputTokens).toBe(2_000);
    expect(
      calls[0]?.schema.safeParse({
        text: "有效回复",
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
    expect(body.state).toEqual(stateBefore);
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
      "这次请求应被幂等回放。",
    );

    expect(response.statusCode).toBe(200);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.idempotentReplay).toBe(true);
    expect(body.decision.chunks).toEqual([legacyContent]);
    expect(body.decision.deliveryMode).toBe("single_block");
    expect(calls).toEqual([]);
  });
});

function mockLlm(
  llm: LlmService,
  calls: Array<GenerateObjectInput<unknown>>,
  responder: (input: GenerateObjectInput<unknown>) => unknown,
): void {
  vi.spyOn(llm, "generateObject").mockImplementation((input) => {
    calls.push(input);
    return Promise.resolve(responder(input));
  });
}

function fixtureFor(input: GenerateObjectInput<unknown>): unknown {
  if (input.fixture !== undefined) return input.fixture;
  throw new Error(`No fixture for ${input.purpose}`);
}

async function createRealProviderTestApp(): Promise<{
  app: PersonaSimApp;
  clock: FakeClock;
}> {
  const clock = new FakeClock(START_UTC);
  const config = readConfig({
    nodeEnv: "test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
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
    database: openDatabase(":memory:"),
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
