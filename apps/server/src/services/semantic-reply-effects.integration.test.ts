import { injectInternalChat } from "../test-fixtures/internal-chat-response.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import qwenRegressions from "../test-fixtures/qwen-fresh-regressions.json";
import type { GenerateObjectInput } from "./llm-service.js";

const REQUEST = "以后聊工作时，请先听我说，不要急着给建议。";
const USER_EVENT = "明天下午我有面试。";
const USER_TURN = USER_EVENT;
const BAD_HISTORY =
  "你之前一直记得先听我说不急着给建议，那份是你主动给的，跟这事是两码事。";
const REPAIRED = "知道了，明天下午有面试，希望顺利。";

describe("semantic reply effects through actual HTTP submission", () => {
  let app: PersonaSimApp;
  let agentId: string;
  let sessionId: string;
  let envelopes: unknown[];
  let calls: Array<GenerateObjectInput<unknown>>;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app !== undefined) await app.close();
  });

  async function setup() {
    envelopes = [];
    calls = [];
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
          return Promise.resolve(envelopes.shift() as never);
        if (input.purpose === "repair_chat_turn")
          return Promise.resolve({
            text: REPAIRED,
            deliveryMode: "single_block",
          } as never);
        if (input.fixture !== undefined) return Promise.resolve(input.fixture);
        throw new Error(`Unexpected model purpose: ${input.purpose}`);
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
    envelopes.push({
      replyDecision: { text: "聊工作时，我会先听你说。" },
      worldEffects: {},
    });
    await send(REQUEST, "request");
  }

  async function send(text: string, clientMessageId: string) {
    const response = await injectInternalChat(app, sessionId, {
      agentId,
      text,
      clientMessageId,
    });
    const body = response.internalTurn!;
    expect(response.statusCode, response.body.slice(0, 800)).toBe(
      body.idempotentReplay ? 200 : 201,
    );
    return body;
  }

  it("keeps the full Qwen T8 analysis but rejects its user-fatigue pressure candidate through the provider route", async () => {
    await setup();
    envelopes.push({
      replyDecision: { text: qwenRegressions.pressure.assistantText },
      worldEffects: {},
    });
    const result = await send(
      qwenRegressions.pressure.userText,
      "qwen-t8-full",
    );
    expect(result.assistantMessage.content).toBe(
      qwenRegressions.pressure.assistantText,
    );
    const db = app.personasim.store.database;
    expect(
      db.prepare("SELECT count(*) AS n FROM pressure_episodes").get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT count(*) AS n FROM domain_events WHERE event_type='life.pressure_disclosed_by_character'",
        )
        .get(),
    ).toEqual({ n: 0 });
    expect(
      db
        .prepare(
          "SELECT payload_json FROM domain_events WHERE event_type='life.pressure_candidate_rejected'",
        )
        .all(),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          payload_json: expect.stringContaining(
            "experiencer_not_speaker",
          ) as unknown,
        }),
      ]),
    );
    const counts = {
      calls: calls.length,
      events: db.prepare("SELECT count(*) AS n FROM domain_events").get(),
    };
    const replay = await send(
      qwenRegressions.pressure.userText,
      "qwen-t8-full",
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(calls).toHaveLength(counts.calls);
    expect(db.prepare("SELECT count(*) AS n FROM domain_events").get()).toEqual(
      counts.events,
    );
  });

  it.each([true, false])(
    "persists a character feeling only with independent pre-turn state (authorized: %s)",
    async (authorized) => {
      await setup();
      const state = app.personasim.store.getRuntimeState(agentId)!;
      app.personasim.store.updateRuntimeState({
        ...state,
        stress: authorized ? 0.75 : 0.1,
        energy: authorized ? 0.3 : 0.9,
      });
      envelopes.push({
        replyDecision: { text: "我最近压力很大，累得不行。" },
        worldEffects: {},
      });
      const result = await send("你最近怎么样？", "character-state");
      const db = app.personasim.store.database;
      const rows = db
        .prepare("SELECT subject, episode_json FROM pressure_episodes")
        .all() as Array<{ subject: string; episode_json: string }>;
      expect(rows).toHaveLength(authorized ? 1 : 0);
      if (authorized)
        expect(JSON.parse(rows[0]!.episode_json)).toMatchObject({
          subject: "character",
          metricOrigin: "algorithm_initial",
          sourceMessageIds: [result.assistantMessage.id],
        });
      else
        expect(
          db
            .prepare(
              "SELECT count(*) AS n FROM domain_events WHERE event_type='life.pressure_candidate_rejected'",
            )
            .get(),
        ).toMatchObject({ n: 2 });
      envelopes.push({
        replyDecision: { text: "这阵子确实不容易。" },
        worldEffects: {},
      });
      const user = await send("我最近压力很大。", "user-state");
      expect(
        db
          .prepare(
            "SELECT source_message_ids_json FROM pressure_episodes WHERE subject='user'",
          )
          .all(),
      ).toEqual([
        expect.objectContaining({
          source_message_ids_json: JSON.stringify([user.userMessage.id]),
        }),
      ]);
    },
  );

  it.each([qwenRegressions.advice.assistantText, "你可以折一只千纸鹤。"])(
    "repairs scoped or unresolved advice once, preserves final surfaces, and does not repeat the model on replay: %s",
    async (bad) => {
      await setup();
      envelopes.push({ replyDecision: { text: bad }, worldEffects: {} });
      const text = "今天我只想吐槽一句，不用替我解决。";
      const result = await send(text, "qwen-advice");
      expect(
        calls.filter((call) => call.purpose === "repair_chat_turn"),
      ).toHaveLength(1);
      expect(result.assistantMessage.metadata.semanticReplyGuard).toMatchObject(
        { repairCalls: 1, finalIssues: [] },
      );
      expect(result.decision.chunks.join("\n")).toBe(
        result.assistantMessage.content,
      );
      expect(result.assistantMessage.content).not.toBe(bad);
      const n = calls.length;
      expect((await send(text, "qwen-advice")).idempotentReplay).toBe(true);
      expect(calls).toHaveLength(n);
    },
  );

  it.each([true, false])(
    "X02 keeps independently grounded user facts and an event follow-up while rejecting an interaction memory (visible error: %s)",
    async (visibleError) => {
      await setup();
      envelopes.push({
        replyDecision: {
          text: visibleError ? `${REPAIRED}\n${BAD_HISTORY}` : REPAIRED,
        },
        worldEffects: {
          memoryCandidates: [
            {
              type: "user_fact",
              content: USER_EVENT,
              importance: 0.7,
              confidence: 0.95,
            },
            {
              type: "relationship",
              content: BAD_HISTORY,
              importance: 0.8,
              confidence: 0.8,
            },
          ],
          continuityEffects: {
            followUpCandidates: [
              {
                subjectType: "user_event",
                contextSummary: USER_EVENT,
                expectedOutcomeDescription: "询问面试进行得怎么样",
                timingHint: "明天下午",
                evidenceQuotes: [USER_EVENT],
              },
            ],
          },
        },
      });
      const result = await send(USER_TURN, "mixed-effects");
      expect(result.assistantMessage.content.replace(/\s/gu, "")).toBe(
        REPAIRED.replace(/\s/gu, ""),
      );
      expect(result.assistantMessage.metadata.semanticReplyGuard).toMatchObject(
        { repairCalls: visibleError ? 1 : 0, finalIssues: [] },
      );
      expect(
        calls.filter((call) => call.purpose === "repair_chat_turn"),
      ).toHaveLength(visibleError ? 1 : 0);

      const database = app.personasim.store.database;
      const memories = database
        .prepare(
          "SELECT content, source_message_id AS sourceMessageId FROM memories WHERE agent_id = ?",
        )
        .all(agentId) as Array<{ content: string; sourceMessageId: string }>;
      expect(
        memories.some(
          (memory) =>
            memory.sourceMessageId === result.userMessage.id &&
            memory.content.includes(USER_EVENT),
        ),
        JSON.stringify(memories),
      ).toBe(true);
      expect(
        memories.some((memory) => memory.content.includes(BAD_HISTORY)),
      ).toBe(false);
      const rejected = database
        .prepare(
          "SELECT reason_code AS code, raw_json AS raw FROM rejected_proposals WHERE correlation_id = ?",
        )
        .all("mixed-effects") as Array<{ code: string; raw: string }>;
      expect(
        rejected.some(
          (row) =>
            row.code === "unsupported_interaction_memory" &&
            row.raw.includes(BAD_HISTORY),
        ),
      ).toBe(true);
      const followUps = database
        .prepare(
          "SELECT source_message_id AS sourceMessageId, status, context_summary AS context, expected_outcome_description AS expectation FROM follow_up_intents WHERE agent_id = ?",
        )
        .all(agentId) as Array<{
        sourceMessageId: string;
        status: string;
        context: string;
        expectation: string;
      }>;
      expect(followUps).toHaveLength(1);
      expect(followUps[0]).toMatchObject({
        sourceMessageId: result.userMessage.id,
        status: "pending",
        context: USER_EVENT,
      });
      expect(followUps[0]?.expectation).toContain("不预设执行或成功");
      expect(followUps[0]?.expectation).toContain(USER_EVENT);

      const beforeCalls = calls.length;
      const replay = await send(USER_TURN, "mixed-effects");
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.assistantMessage.id).toBe(result.assistantMessage.id);
      expect(calls).toHaveLength(beforeCalls);
      expect(
        database
          .prepare(
            "SELECT count(*) AS n FROM follow_up_intents WHERE agent_id = ?",
          )
          .get(agentId),
      ).toEqual({ n: 1 });
      expect(
        database
          .prepare("SELECT count(*) AS n FROM memories WHERE agent_id = ?")
          .get(agentId),
      ).toEqual({ n: memories.length });
    },
  );
});
