import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";
import type { GenerateObjectInput } from "./llm-service.js";
import { WorldEffectService } from "./world-effect-service.js";
import { TurnDecisionService } from "./turn-decision-service.js";

const T6 = "工作倒没有出大事，就是改了一天东西，回家以后脑子还是停不下来。";
const T9 = "以后聊工作时，请先听我说，不要急着给建议。";
const T14 = "我有个朋友说“以后少追问我”，那是他跟别人说的，不是在替我提要求。";
const BAD_HISTORY =
  "你之前一直记得先听我说不急着给建议，那份是你主动给的，跟这事是两码事。";
const GOOD_QUOTE = "明白，是你朋友对另一个人说的，不是你在修改我们的相处方式。";
const BAD_ADVICE =
  "改了一天东西回家脑子还转，这个我熟，版式改到一定程度，闭上眼都是字在挪位置。\n嗯，我觉得这种情况硬让脑子停下来反而没用，不如给它找个出口，随手画两笔那种，或者干脆把没改完的点记下来，写出来的东西脑子就愿意放下了。\n看情况吧，有时候洗澡或者出门走一圈也行，别躺着硬熬就行。";

describe("final conversational semantic boundaries through normal HTTP routes", () => {
  let app: PersonaSimApp;
  let agentId: string;
  let sessionId: string;
  let calls: Array<GenerateObjectInput<unknown>>;
  let replies: unknown[];
  let repairedText: string;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app !== undefined) await app.close();
  });

  async function setup() {
    calls = [];
    replies = [];
    repairedText = GOOD_QUOTE;
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        databasePath: ":memory:",
        clockMode: "fake",
        seedDemo: false,
        developerRoutes: true,
        lifePlanningMode: "fuzzy",
        selfInitiatedPlanningMode: "off",
        companionContextMode: "enforced",
        personaRuntimeMode: "enforced",
        liveWorldEffectsMode: "enforced",
        autobiographyMode: "off",
        memoryRecallMode: "enforced",
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
        if (input.purpose === "chat_turn")
          return Promise.resolve(
            (replies.shift() ?? {
              replyDecision: { text: "嗯，听见了。" },
              worldEffects: {},
            }) as never,
          );
        if (input.purpose === "repair_chat_turn")
          return Promise.resolve({
            text: repairedText,
            chunks: [BAD_HISTORY],
            deliveryMode: "single_block",
          } as never);
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
    calls.length = 0;
  }

  async function send(text: string, clientMessageId = `turn-${calls.length}`) {
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { agentId, text, clientMessageId },
    });
    const body = response.json<ChatTurnResult>();
    expect(response.statusCode, response.body.slice(0, 500)).toBe(
      body.idempotentReplay ? 200 : 201,
    );
    return body;
  }

  const envelope = (text: string, continuityEffects?: unknown) => ({
    replyDecision: {
      text,
      deliveryMode: "sequential",
      chunks: text.split("\n"),
    },
    worldEffects: continuityEffects === undefined ? {} : { continuityEffects },
  });

  it("I01/X03/X04 repairs the actual reversed claim using source evidence and never exposes stale chunks", async () => {
    await setup();
    replies.push(envelope("你聊工作时，我会先听你说。"));
    const request = await send(T9, "preference");
    replies.push(envelope(`${GOOD_QUOTE}\n${BAD_HISTORY}`));
    const result = await send(T14, "history");
    expect(result.assistantMessage.content).toBe(GOOD_QUOTE);
    expect(result.assistantMessage.metadata.chunks).toEqual([GOOD_QUOTE]);
    expect(
      calls.filter((call) => call.purpose === "repair_chat_turn"),
    ).toHaveLength(1);
    const repair = calls.find((call) => call.purpose === "repair_chat_turn")!;
    expect(repair.prompt).toContain(request.userMessage.id);
    expect(repair.prompt).toContain(T9);
    expect(repair.prompt).toContain("REQUEST_PROMOTED_TO_HISTORY");
    expect(result.assistantMessage.metadata.semanticReplyGuard).toMatchObject({
      repairCalls: 1,
      finalIssues: [],
    });
    const durableCounts = () =>
      app.personasim.store.database
        .prepare(
          "SELECT (SELECT count(*) FROM persona_adaptations) AS adaptations, (SELECT count(*) FROM follow_up_intents) AS followups",
        )
        .get();
    expect(durableCounts()).toEqual({ adaptations: 1, followups: 0 });
    const counts = calls.length;
    const beforeMessages = app.personasim.store.listMessages(sessionId).length;
    const replay = await send(T14, "history");
    expect(replay.assistantMessage.id).toBe(result.assistantMessage.id);
    expect(calls).toHaveLength(counts);
    expect(app.personasim.store.listMessages(sessionId)).toHaveLength(
      beforeMessages,
    );
    expect(durableCounts()).toEqual({ adaptations: 1, followups: 0 });
  });

  it("projects a legacy incorrect assistant sentence out of the next actual generation prompt while preserving the raw message", async () => {
    await setup();
    replies.push(envelope("你聊工作时，我会先听你说。"));
    await send(T9);
    app.personasim.store.insertMessage({
      id: "legacy-misattribution",
      agentId,
      sessionId,
      role: "assistant",
      messageKind: "assistant_reply",
      content: `${GOOD_QUOTE}\n${BAD_HISTORY}`,
      createdAtUtc: "2026-09-07T00:00:00.000Z",
      metadata: {},
    });
    replies.push(envelope(GOOD_QUOTE));
    await send(T14);
    const generation = calls
      .filter((call) => call.purpose === "chat_turn")
      .at(-1)!;
    expect(generation.prompt).not.toContain(BAD_HISTORY);
    expect(generation.prompt).toContain(GOOD_QUOTE);
    expect(
      app.personasim.store.database
        .prepare(
          "SELECT content FROM messages WHERE id = 'legacy-misattribution'",
        )
        .get(),
    ).toEqual({ content: `${GOOD_QUOTE}\n${BAD_HISTORY}` });
  });

  it("does not let final semantic repair rewrite a deterministic consent presentation", async () => {
    await setup();
    // Bind the real implementation to the real service inside the spy.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const finalize = TurnDecisionService.prototype.finalizeSemanticReply;
    let authoritativeText = "";
    let allowModelRepair: boolean | undefined;
    vi.spyOn(
      TurnDecisionService.prototype,
      "finalizeSemanticReply",
    ).mockImplementationOnce(async function (this: TurnDecisionService, input) {
          allowModelRepair = input.allowModelRepair;
          authoritativeText = input.decision.reply.text;
      return finalize.call(this, {
        ...input,
        decision: {
          ...input.decision,
          reply: {
            ...input.decision.reply,
            text: `${authoritativeText}\n${BAD_HISTORY}`,
            chunks: [authoritativeText, BAD_HISTORY],
          },
        },
      });
    });
    replies.push(envelope("这仍需要姨妈本人确认。"));
    const result = await send("姨妈也许愿意让我单独看修复稿。");
    expect(allowModelRepair).toBe(false);
    expect(authoritativeText).toContain("确认");
    expect(result.assistantMessage.content).toBe(authoritativeText);
    expect(result.assistantMessage.metadata.semanticReplyGuard).toMatchObject({
      repairCalls: 0,
      finalIssues: [],
    });
    expect(
      calls.filter((call) => call.purpose === "repair_chat_turn"),
    ).toHaveLength(0);
  });

  it("I03 rejects invented repeated fulfillment even when the direction is correct", async () => {
    await setup();
    replies.push(envelope("你聊工作时，我会先听你说。"));
    await send(T9);
    replies.push(envelope("这些年我一直先听你说，不急着给建议。"));
    repairedText = "你希望聊工作时我先听你说。";
    const result = await send("我们之前约定的相处方式是什么？");
    expect(result.assistantMessage.content).toBe(repairedText);
    expect(
      calls.filter((call) => call.purpose === "repair_chat_turn"),
    ).toHaveLength(1);
  });

  it("A01/X01 controls the original pre-preference T6 advice and rejects a follow-up from the removed advice", async () => {
    await setup();
    const before = app.personasim.store.database
      .prepare("SELECT count(*) AS n FROM persona_adaptations")
      .get() as { n: number };
    expect(before.n).toBe(0);
    replies.push(
      envelope(BAD_ADVICE, {
        followUpCandidates: [
          {
            subjectType: "user_event",
            contextSummary: T6,
            expectedOutcomeDescription: "用户尝试画画和清单后反馈结果",
            timingHint: "明天",
            evidenceQuotes: [T6],
          },
        ],
      }),
    );
    repairedText =
      "改了一天，回到家脑子还在接着上班，确实很耗人。没有出大事，也不代表今天就轻松。";
    const result = await send(T6);
    expect(result.assistantMessage.content.replace(/\s/gu, "")).toBe(
      repairedText.replace(/\s/gu, ""),
    );
    expect(result.assistantMessage.metadata.semanticReplyGuard).toMatchObject({
      repairCalls: 1,
      finalIssues: [],
      finalAdvice: { actionCount: 0 },
    });
    expect(
      calls.find((call) => call.purpose === "repair_chat_turn")?.prompt,
    ).toContain("ADVICE_NOT_REQUESTED_NOW");
    expect(
      app.personasim.store.database
        .prepare("SELECT count(*) AS n FROM follow_up_intents")
        .get(),
    ).toEqual({ n: 0 });
    const rejected = app.personasim.store.database
      .prepare(
        "SELECT reason_code FROM rejected_proposals WHERE purpose = 'continuity_turn'",
      )
      .all();
    expect(rejected.length).toBeGreaterThan(0);
  });

  it.each([
    "我现在想具体想一想了，请帮我分析一下：怎样区分真正做错了，和只是被反复修改弄得烦。",
    "不用先听我说，直接给我建议：我该怎样跟同事确认修改范围？",
    "不是让你先听我说，是请你帮我分析：哪些要求值得当场问清楚？",
  ])("A02-A04 preserves explicitly requested help: %s", async (text) => {
    await setup();
    replies.push(envelope("你聊工作时，我会先听你说。"));
    await send(T9);
    const responseText =
      "先列清单，再联系同事确认范围，最后发一条消息留存确认结果。";
    replies.push(envelope(responseText));
    const result = await send(text);
    expect(result.assistantMessage.content).toBe(responseText);
    expect(
      calls.filter((call) => call.purpose === "repair_chat_turn"),
    ).toHaveLength(0);
    expect(
      app.personasim.store.database
        .prepare("SELECT status, revision FROM persona_adaptations")
        .get(),
    ).toMatchObject({ status: "accepted", revision: 1 });
  });

  it("shares one repair allowance with late world rewrites and checks the final visible surfaces", async () => {
    await setup();
    replies.push(envelope("你聊工作时，我会先听你说。"));
    await send(T9);
    // The original method is deliberately invoked with its receiver below.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const resolve = WorldEffectService.prototype.resolve;
    vi.spyOn(WorldEffectService.prototype, "resolve").mockImplementationOnce(
      async function (this: WorldEffectService, input) {
        const world = await resolve.call(this, input);
        return {
          ...world,
          decision: {
            ...world.decision,
            reply: {
              ...world.decision.reply,
              text: `${GOOD_QUOTE}\n${BAD_HISTORY}`,
              chunks: [GOOD_QUOTE, BAD_HISTORY],
            },
          },
        };
      },
    );
    replies.push(envelope(BAD_HISTORY));
    const result = await send(T14);
    expect(
      calls.filter((call) => call.purpose === "repair_chat_turn"),
    ).toHaveLength(1);
    expect(result.assistantMessage.content).toBe(GOOD_QUOTE);
    expect(result.assistantMessage.metadata.chunks).toEqual([GOOD_QUOTE]);
    expect(result.assistantMessage.metadata.semanticReplyGuard).toMatchObject({
      repairCalls: 1,
      finalIssues: [],
    });
  });
});
