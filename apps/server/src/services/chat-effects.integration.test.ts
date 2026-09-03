import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";
import type { GenerateObjectInput, LlmService } from "./llm-service.js";

const START_UTC = "2026-08-16T02:00:00.000Z"; // 10:00 Asia/Shanghai

const INVITATION_TEXT = "今晚要不要一起去参加学校的晚会？可以把学习挪到明天。";

describe("live chat schedule-effect proposals", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it("commits valid effects, rejects invalid ones individually and keeps the reply", async () => {
    app = (await createEffectsTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      expect(input.prompt).toContain("SCHEDULE_EFFECTS_CONTRACT");
      expect(input.prompt).toContain("晚间自习");
      return {
        text: "好呀，我愿意一起去。学习的事我来重新安排。",
        toneTags: ["自然"],
        scheduleEffects: [
          {
            operation: "move",
            itemTitle: "晚间自习",
            newStart: "明天 15:45",
            justificationQuote: "可以把学习挪到明天",
          },
          {
            operation: "cancel",
            itemId: "schedule_does-not-exist",
            justificationQuote: "可以把学习挪到明天",
          },
          {
            operation: "create",
            justificationQuote: "一起去参加学校的晚会",
            item: {
              title: "和用户参加晚会",
              category: "social",
              startAt: "随缘",
              durationMinutes: 60,
            },
          },
        ],
      };
    });

    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "effects-partial-1",
      INVITATION_TEXT,
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toBe(
      "好呀，我愿意一起去。\n学习的事我来重新安排。",
    );
    expect(body.scheduleChanges).toHaveLength(1);
    expect(body.scheduleChanges[0]).toMatchObject({
      title: "晚间自习",
      status: "planned",
      source: "runtime_replan",
      startAtUtc: "2026-08-17T07:45:00.000Z",
    });
    expect(body.assistantMessage.metadata.decisionPath).toBe("partial");
    expect(body.assistantMessage.metadata.rejectedProposalCount).toBe(2);
    expect(body.assistantMessage.metadata.repairAttempted).toBe(false);
    // No repair call: the reply itself was valid.
    expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);

    const rejections = app.personasim.store.listRejectedProposals(
      character.id,
      10,
    );
    expect(rejections).toHaveLength(2);
    expect(rejections.map((item) => item.reasonCode).sort()).toEqual([
      "unparseable_time",
      "unresolved_item",
    ]);
    for (const rejection of rejections) {
      expect(rejection.purpose).toBe("chat_turn");
      expect(rejection.correlationId).toBe("effects-partial-1");
      expect(rejection.raw).toBeTruthy();
    }
  });

  it("keeps the reply when every proposal is ungrounded", async () => {
    app = (await createEffectsTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      expect(input.prompt).toContain("SCHEDULE_EFFECTS_CONTRACT");
      return {
        text: "我今晚已经有安排了，不过谢谢你想着我。",
        scheduleEffects: [
          {
            operation: "cancel",
            itemTitle: "晚间自习",
            justificationQuote: "用户要求取消本周全部计划",
          },
        ],
      };
    });

    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "effects-ungrounded-1",
      INVITATION_TEXT,
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toBe(
      "我今晚已经有安排了，不过谢谢你想着我。",
    );
    expect(body.scheduleChanges).toEqual([]);
    expect(body.assistantMessage.metadata.decisionPath).toBe(
      "effects_rejected",
    );
    expect(calls.map((input) => input.purpose)).toEqual(["chat_turn"]);
    expect(
      app.personasim.store.listRejectedProposals(character.id, 10),
    ).toHaveLength(1);
  });

  it("keeps the reply-only contract for turns without schedule intent", async () => {
    app = (await createEffectsTestApp()).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      expect(input.prompt).not.toContain("SCHEDULE_EFFECTS_CONTRACT");
      return {
        text: "今天按部就班，写了一会儿稿子。你呢？",
        scheduleEffects: [
          {
            operation: "cancel",
            itemTitle: "晚间自习",
            justificationQuote: "今天按部就班",
          },
        ],
      };
    });

    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "reply-only-1",
      "今天过得怎么样？",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([]);
    expect(body.assistantMessage.metadata.decisionPath).toBe("reply_only");
    const chatCall = calls.find((input) => input.purpose === "chat_turn");
    expect(chatCall).toBeDefined();
    // The strict boundary rejects legacy flat output while the canonical
    // envelope keeps action-shaped proposals independently untrusted.
    expect(
      chatCall?.schema.safeParse({
        text: "有效回复",
        scheduleEffects: [{ operation: "cancel" }],
      }).success,
    ).toBe(false);
    expect(
      chatCall?.schema.safeParse({
        replyDecision: { text: "valid reply" },
        worldEffects: {},
        scheduleEffects: [{ operation: "cancel" }],
      }).success,
    ).toBe(true);
    expect(
      app.personasim.store.listRejectedProposals(character.id, 10),
    ).toEqual([]);
  });

  it("falls back to the reply-only path when CHAT_EFFECTS_MODE=off", async () => {
    app = (await createEffectsTestApp({ chatEffectsMode: "off" })).app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls, (input) => {
      expect(input.prompt).not.toContain("SCHEDULE_EFFECTS_CONTRACT");
      return { text: "谢谢你的邀请，我看看安排再答复你。" };
    });

    const character = await createAndPublishHighFidelity(app);
    const sessionId = await createSession(app, character.id);
    calls.length = 0;

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "effects-off-1",
      INVITATION_TEXT,
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([]);
    expect(body.assistantMessage.metadata.decisionPath).toBe("reply_only");
  });
});

function mockLlm(
  llm: LlmService,
  calls: Array<GenerateObjectInput<unknown>>,
  responder: (input: GenerateObjectInput<unknown>) => unknown,
): void {
  vi.spyOn(llm, "generateObject").mockImplementation((input) => {
    calls.push(input);
    if (input.purpose !== "chat_turn") {
      if (input.fixture === undefined) {
        return Promise.reject(
          new Error(`No fixture for purpose ${input.purpose}`),
        );
      }
      return Promise.resolve(input.fixture as never);
    }
    return Promise.resolve(
      canonicalChatEnvelopeFixture(responder(input)) as never,
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

async function createEffectsTestApp(
  overrides: { chatEffectsMode?: "off" | "gated" } = {},
): Promise<{ app: PersonaSimApp; clock: FakeClock }> {
  const clock = new FakeClock(START_UTC);
  const config = readConfig({
    nodeEnv: "test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    lifePlanningMode: "legacy_exact",
    chatEffectsMode: overrides.chatEffectsMode ?? "gated",
    scheduleNegotiationMode: "legacy",
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

async function createAndPublishHighFidelity(
  app: PersonaSimApp,
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
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    },
  });
  expect(generated.statusCode).toBe(201);
  const draft = jsonBody<{ character: { id: string; version: number } }>(
    generated,
  ).character;
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
