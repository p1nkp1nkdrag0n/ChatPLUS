import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";

// Complete immutable model-io + final text from cc-qwen-fix-b-20260907-01 T6.
const RAW_T6 =
  "这种状态挺常见的，白天专注太久，节奏惯性会带到晚上。脑子停不下来时不用硬逼自己切断，试着换个低强度的动作缓冲一下，比如把灯光调暗或者听点白噪音，让思维慢慢降速。";
const USER_T6 =
  "工作倒没有出大事，就是改了一天东西，回家以后脑子还是停不下来。";
const REPAIRED = "听起来这一天挺耗神的，我在听。";

describe("Qwen B trial advice through the shared HTTP repair budget", () => {
  let app: PersonaSimApp | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });

  it.each([
    { explicitBan: false, repairStillBad: false },
    { explicitBan: true, repairStillBad: false },
    { explicitBan: true, repairStillBad: true },
  ])(
    "requires an explicit current ban for bounded T6 repair and replays without calls: %o",
    async ({ explicitBan, repairStillBad }) => {
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
            baseUrl: "https://fixture.invalid",
            apiKey: "fixture-never-dispatched",
            model: "stub",
            timeoutMs: 1_000,
            maxRetries: 0,
          },
        }),
        clock: new FakeClock("2026-09-07T00:15:00.000Z"),
        seedDemo: false,
        startScheduler: false,
        logger: false,
      });
      const calls: string[] = [];
      vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
        (input) => {
          calls.push(input.purpose);
          if (input.purpose === "chat_turn")
            return Promise.resolve({
              replyDecision: { text: RAW_T6 },
              worldEffects: {},
            });
          if (input.purpose === "repair_chat_turn")
            return Promise.resolve({
              text: repairStillBad ? RAW_T6 : REPAIRED,
              deliveryMode: "single_block",
            });
          if (input.fixture !== undefined)
            return Promise.resolve(input.fixture);
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
      const character = generated.json<{
        character: { id: string; version: number };
      }>().character;
      const published = await app.inject({
        method: "POST",
        url: `/api/characters/${character.id}/publish`,
        payload: { expectedVersion: character.version },
      });
      expect(published.statusCode, published.body).toBe(200);
      const session = await app.inject({
        method: "POST",
        url: `/api/agents/${character.id}/sessions`,
        payload: {},
      });
      expect(session.statusCode, session.body).toBe(201);
      const sessionId = session.json<{ session: { id: string } }>().session.id;
      const request = {
        method: "POST" as const,
        url: `/api/sessions/${sessionId}/messages`,
        payload: {
          agentId: character.id,
          text: explicitBan ? `${USER_T6}这轮不用建议，先听我说。` : USER_T6,
          clientMessageId: "qwen-b-t6",
        },
      };
      const turnSpy = vi.spyOn(app.personasim.conversations, "chat");
      const response = await app.inject(request);
      expect(response.statusCode, response.body).toBe(201);
      expect(
        response.json<ChatTurnResult>().assistantMessage.metadata,
      ).not.toHaveProperty("semanticReplyGuard");
      const result = await (turnSpy.mock.results[0]!
        .value as Promise<ChatTurnResult>);
      expect(
        calls.filter((purpose) => purpose === "repair_chat_turn"),
      ).toHaveLength(explicitBan ? 1 : 0);
      expect(result.assistantMessage.metadata.semanticReplyGuard).toMatchObject(
        {
          repairCalls: explicitBan ? 1 : 0,
          initialDiagnosis: explicitBan ? "confirmed" : "uncertain",
          initialAdvice: {
            diagnosis: explicitBan ? "confirmed" : "uncertain",
            coverage: { status: "unresolved" },
          },
          initialIssues: explicitBan
            ? (expect.arrayContaining([
                expect.objectContaining({
                  code: "ADVICE_ACTION_UNRESOLVED",
                  text: "把灯光调暗",
                }),
                expect.objectContaining({
                  code: "ADVICE_ACTION_UNRESOLVED",
                  text: "听点白噪音",
                }),
              ]) as unknown)
            : [],
          finalIssues: [],
          finalAdvice: {
            policy: "none_now",
            passed: explicitBan,
            diagnosis: explicitBan ? "none" : "uncertain",
          },
        },
      );
      expect(result.decision.chunks.join("\n")).toBe(
        result.assistantMessage.content,
      );
      if (explicitBan) {
        expect(result.assistantMessage.content).not.toContain("把灯光调暗");
        expect(result.assistantMessage.content).not.toContain("听点白噪音");
        if (!repairStillBad)
          expect(result.assistantMessage.content).toBe(REPAIRED);
      } else
        expect(result.assistantMessage.content.replace(/\s/gu, "")).toBe(
          RAW_T6.replace(/\s/gu, ""),
        );

      const beforeReplayCalls = calls.length;
      const database = app.personasim.store.database;
      const counts = () => ({
        messages: database.prepare("SELECT count(*) AS n FROM messages").get(),
        events: database
          .prepare("SELECT count(*) AS n FROM domain_events")
          .get(),
      });
      const beforeReplay = counts();
      const replayResponse = await app.inject(request);
      expect(replayResponse.statusCode, replayResponse.body).toBe(200);
      const replay = replayResponse.json<ChatTurnResult>();
      expect(replay.idempotentReplay).toBe(true);
      expect(replay.assistantMessage.id).toBe(result.assistantMessage.id);
      expect(calls).toHaveLength(beforeReplayCalls);
      expect(counts()).toEqual(beforeReplay);
    },
  );
});
