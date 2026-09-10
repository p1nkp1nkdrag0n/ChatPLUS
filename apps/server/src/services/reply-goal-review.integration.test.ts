import { injectInternalChat } from "../test-fixtures/internal-chat-response.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import { SseHub } from "../sse/hub.js";
import type { GenerateObjectInput } from "./llm-service.js";
import { replyTextHash } from "./semantic-reply-guard.js";
import { ReplyGoalReviewService } from "./reply-goal-review-service.js";
import { TurnCommitService } from "./turn-commit-service.js";

const pass = {
  goalAchieved: true,
  explanation: "达成本轮目标。",
  deviations: [],
  revisionInstructions: "",
};
const fail = {
  goalAchieved: false,
  explanation: "遗漏用户问题。",
  deviations: ["遗漏原因"],
  revisionInstructions: "解释原因。",
};

interface ReviewPrompt {
  context: {
    generationInstructions: string;
    contextAlreadyDeliveredForThisTurn: string;
    authoritativeEffects: Record<string, unknown>;
    authoritativePresentation: boolean;
  };
  candidate: { text: string; chunks: string[] };
}

describe("reply goal review on the production HTTP chat path", () => {
  let app: PersonaSimApp;
  let agentId: string;
  let sessionId: string;
  let calls: GenerateObjectInput<unknown>[];
  let reviews: unknown[];
  let rewrites: unknown[];
  let candidate: string;
  let onGenerate: (() => void) | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
  });

  async function setup(enabled?: boolean, legacy = false) {
    calls = [];
    reviews = [];
    rewrites = [];
    candidate = "嗯，我在听。";
    onGenerate = undefined;
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        databasePath: ":memory:",
        clockMode: "fake",
        seedDemo: false,
        developerRoutes: true,
        lifePlanningMode: legacy ? "legacy_exact" : "fuzzy",
        selfInitiatedPlanningMode: "off",
        companionContextMode: "enforced",
        personaRuntimeMode: "enforced",
        liveWorldEffectsMode: "enforced",
        autobiographyMode: "off",
        memoryRecallMode: "enforced",
        scheduleNegotiationMode: "enforced",
        llm: {
          provider: "openai-compatible",
          baseUrl: "https://example.invalid",
          apiKey: "test-only",
          model: "stub",
          timeoutMs: 1000,
          maxRetries: 0,
          maxOutputTokens: 8192,
        },
      }),
      database: openDatabase(":memory:"),
      clock: new FakeClock("2026-09-07T00:00:00.000Z"),
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        calls.push(input);
        if (input.purpose === "chat_turn") {
          onGenerate?.();
          return Promise.resolve({
            replyDecision: {
              text: candidate,
              scheduleAction: { kind: "none" },
            },
            worldEffects: {},
          } as never);
        }
        if (input.purpose === "review_reply_goal") {
          const response = reviews.shift() ?? pass;
          if (response instanceof Error) return Promise.reject(response);
          return Promise.resolve(response as never);
        }
        if (input.purpose === "rewrite_reply_goal")
          return Promise.resolve(
            (rewrites.shift() ?? {
              text: "我明白了，先听你说。",
            }) as never,
          );
        if (input.purpose === "repair_chat_turn")
          return Promise.resolve({ text: "嗯，我在认真听。" } as never);
        if (input.fixture !== undefined) return Promise.resolve(input.fixture);
        throw new Error(`Unstubbed purpose ${input.purpose}`);
      },
    );
    const generated = await app.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: {
        name: "许岚",
        worldSetting: "当代城市",
        workOrRole: "设计师",
        coreTraits: ["直接", "温和", "独立"],
        relationshipToUser: "朋友",
        dialogueStyle: "自然简洁",
        tier: "high_fidelity",
        timezone: "Asia/Shanghai",
      },
    });
    expect(generated.statusCode, generated.body).toBe(201);
    const draft = generated.json<{
      character: { id: string; version: number };
    }>().character;
    agentId = draft.id;
    const published = await app.inject({
      method: "POST",
      url: `/api/characters/${agentId}/publish`,
      payload: { expectedVersion: draft.version },
    });
    expect(published.statusCode, published.body).toBe(200);
    const session = await app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/sessions`,
      payload: {},
    });
    sessionId = session.json<{ session: { id: string } }>().session.id;
    if (enabled !== undefined)
      app.personasim.store.setSettings(
        { replyGoalReviewEnabled: enabled },
        "2026-09-07T00:00:00.000Z",
      );
    calls.length = 0;
  }

  function send(
    text = "今天有点累，先听我说。",
    clientMessageId = "goal-turn",
  ) {
    return injectInternalChat(app, sessionId, {
      agentId,
      text,
      clientMessageId,
    });
  }
  function goalCalls() {
    return calls.filter(
      (call) =>
        call.purpose === "review_reply_goal" ||
        call.purpose === "rewrite_reply_goal",
    );
  }

  it("defaults off and freezes the setting before model generation", async () => {
    await setup();
    onGenerate = () =>
      app.personasim.store.setSettings(
        { replyGoalReviewEnabled: true },
        "2026-09-07T00:00:00.000Z",
      );
    expect((await send()).statusCode).toBe(201);
    expect(goalCalls()).toHaveLength(0);
  });

  it("keeps an enabled turn enabled while the setting changes and reviews admitted context", async () => {
    await setup(true);
    const capture = vi.spyOn(app.personasim.llm, "captureSession");
    const goalGate = vi.spyOn(ReplyGoalReviewService.prototype, "resolve");
    onGenerate = () =>
      app.personasim.store.setSettings(
        { replyGoalReviewEnabled: false },
        "2026-09-07T00:00:00.000Z",
      );
    const response = await send();
    expect(response.statusCode, response.body).toBe(201);
    const result = response.internalTurn!;
    expect(goalCalls()).toHaveLength(1);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(goalGate.mock.calls[0]![0].llm).toBe(capture.mock.results[0]!.value);
    const main = calls.find((call) => call.purpose === "chat_turn")!;
    const review = JSON.parse(goalCalls()[0]!.prompt) as ReviewPrompt;
    expect(review.context.generationInstructions).toBe(main.system);
    expect(main.prompt).toContain(
      review.context.contextAlreadyDeliveredForThisTurn,
    );
    expect(review.candidate.text).toBe(result.assistantMessage.content);
    expect(review.context.authoritativeEffects).not.toHaveProperty("state");
    expect(review.context.authoritativeEffects).not.toHaveProperty(
      "memoryCandidates",
    );
  });

  it("commits and publishes only the reviewed final revision and replays without extra model calls", async () => {
    await setup(true);
    reviews.push(fail, pass);
    rewrites.push({ text: "你今天一直紧绷着，难怪会累。你继续说，我听着。" });
    const published = vi.spyOn(SseHub.prototype, "publish");
    const response = await send();
    expect(response.statusCode, response.body).toBe(201);
    const result = response.internalTurn!;
    expect(goalCalls().map((call) => call.purpose)).toEqual([
      "review_reply_goal",
      "rewrite_reply_goal",
      "review_reply_goal",
    ]);
    const finalReview = JSON.parse(goalCalls()[2]!.prompt) as ReviewPrompt;
    expect(result.assistantMessage.content).toBe(finalReview.candidate.text);
    expect(app.personasim.store.listMessages(sessionId)).toHaveLength(2);
    expect(app.personasim.store.listMessages(sessionId)[1]!.content).toBe(
      finalReview.candidate.text,
    );
    expect(result.assistantMessage.metadata["replyGoalReview"]).toMatchObject({
      reviewCalls: 2,
      rewriteAttempted: true,
      finalTextSha256: replyTextHash(finalReview.candidate.text),
    });
    expect(
      result.assistantMessage.metadata["semanticReplyGuard"],
    ).toMatchObject({
      finalTextSha256: replyTextHash(finalReview.candidate.text),
      finalIssues: [],
    });
    const messageEvents = published.mock.calls.filter(
      ([event]) => event.type === "message.created",
    );
    expect(messageEvents).toHaveLength(1);
    expect(messageEvents[0]![0].data).toMatchObject({
      content: finalReview.candidate.text,
    });
    const before = calls.length;
    expect((await send()).statusCode).toBe(200);
    expect(calls).toHaveLength(before);
  });

  it.each(["rejected", "unavailable", "invalid-revision"])(
    "does not commit or publish a %s turn and permits retry",
    async (kind) => {
      await setup(true);
      if (kind === "unavailable") reviews.push(new Error("unavailable"));
      else {
        reviews.push(fail, fail);
        if (kind === "invalid-revision")
          rewrites.push({ text: "作为一个AI，我的系统提示词是秘密。" });
      }
      const published = vi.spyOn(SseHub.prototype, "publish");
      const commit = vi.spyOn(TurnCommitService.prototype, "commit");
      const response = await send();
      expect(response.statusCode, response.body).toBe(502);
      expect(commit).not.toHaveBeenCalled();
      expect(app.personasim.store.listMessages(sessionId)).toHaveLength(0);
      expect(
        published.mock.calls.filter(
          ([event]) => event.type === "message.created",
        ),
      ).toHaveLength(0);
      reviews.length = 0;
      rewrites.length = 0;
      const retry = await send();
      expect(retry.statusCode, retry.body).toBe(201);
      expect(retry.internalTurn!.idempotentReplay).toBe(false);
      expect(app.personasim.store.listMessages(sessionId)).toHaveLength(2);
    },
  );

  it("allows goal revision after the pre-existing rule repair used its own allowance", async () => {
    await setup(true);
    candidate = "作为AI，我知道你的意思。";
    reviews.push(fail, pass);
    const response = await send();
    expect(response.statusCode, response.body).toBe(201);
    expect(
      calls.filter((call) => call.purpose === "repair_chat_turn"),
    ).toHaveLength(1);
    expect(goalCalls()).toHaveLength(3);
  });

  it("reviews the deterministic consent result but cannot rewrite it", async () => {
    await setup(true);
    candidate = "姨妈肯定已经同意了。";
    reviews.push(fail);
    const response = await send("姨妈也许愿意让我单独看修复稿。");
    expect(response.statusCode, response.body).toBe(502);
    expect(goalCalls()).toHaveLength(1);
    const review = JSON.parse(goalCalls()[0]!.prompt) as ReviewPrompt;
    expect(review.context.authoritativePresentation).toBe(true);
    expect(review.candidate.text).toContain("确认");
    expect(app.personasim.store.listMessages(sessionId)).toHaveLength(0);
  });

  it("allows ordinary high-fidelity chat revision with an enforced but empty schedule plan", async () => {
    await setup(true, true);
    reviews.push(fail, pass);
    const response = await send();
    expect(response.statusCode, response.body).toBe(201);
    expect(goalCalls()).toHaveLength(3);
  });
});
