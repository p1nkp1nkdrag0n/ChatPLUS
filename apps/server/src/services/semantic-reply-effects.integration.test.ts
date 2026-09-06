import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";
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
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { agentId, text, clientMessageId },
    });
    const body = response.json<ChatTurnResult>();
    expect(response.statusCode, response.body.slice(0, 800)).toBe(
      body.idempotentReplay ? 200 : 201,
    );
    return body;
  }

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
