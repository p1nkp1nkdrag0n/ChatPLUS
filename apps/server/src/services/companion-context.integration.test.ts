import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";
import type { ConversationContextPlan } from "@personasim/contracts";
import { CONVERSATION_CONTEXT_SERVICE_TOKEN } from "../composition/service-tokens.js";

const NOW = "2026-09-06T04:00:00.000Z";
describe("companion context pipeline", () => {
  let app: PersonaSimApp;
  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  it.each(["off", "shadow", "enforced"] as const)(
    "uses original turns and records %s without changing authorization",
    async (mode) => {
      app = await buildApp({
        config: readConfig({
          nodeEnv: "test",
          databasePath: ":memory:",
          seedDemo: false,
          lifePlanningMode: "fuzzy",
          memoryRecallMode: "enforced",
          autobiographyMode: "off",
          companionContextMode: mode,
          personaRuntimeMode: "off",
          llm: {
            provider: "fixture",
            baseUrl: "https://example.invalid",
            model: "fixture",
            timeoutMs: 1_000,
            maxRetries: 0,
          },
        }),
        database: openDatabase(":memory:"),
        clock: new FakeClock(NOW),
        startScheduler: false,
        logger: false,
      });
      const generated = await app.inject({
        method: "POST",
        url: "/api/characters/generate",
        payload: {
          name: "林夏",
          worldSetting: "当代城市",
          workOrRole: "书店店员",
          coreTraits: ["认真", "有主见", "温暖"],
          coreContradiction: "想多见朋友，也喜欢独处",
          mainGoal: "读完一本书",
          initialRelationship: "邻居",
          dialogueStyle: "自然简洁",
          tier: "high_fidelity",
          timezone: "Asia/Shanghai",
        },
      });
      expect(generated.statusCode, generated.body).toBe(201);
      const { character } = generated.json<{
        character: { id: string; version: number };
      }>();
      const published = await app.inject({
        method: "POST",
        url: `/api/characters/${character.id}/publish`,
        payload: { expectedVersion: character.version },
      });
      expect(published.statusCode, published.body).toBe(200);
      const created = await app.inject({
        method: "POST",
        url: `/api/agents/${character.id}/sessions`,
        payload: {},
      });
      const sessionId = created.json<{ session: { id: string } }>().session.id;
      const send = (text: string, clientMessageId: string) =>
        app.inject({
          method: "POST",
          url: `/api/sessions/${sessionId}/messages`,
          payload: { agentId: character.id, text, clientMessageId },
        });
      await send("同事小林临时取消了约定，我今天只想说说。", "context-first");
      const generate = vi.spyOn(app.personasim.llm, "generateObject");
      const response = await send(
        "她今天又那样了，为什么我总是把事情弄糟。",
        "context-next",
      );
      expect(response.statusCode, response.body).toBe(201);
      const result = response.json<ChatTurnResult>();
      const diagnostic = result.assistantMessage.metadata[
        "companionContext"
      ] as { mode: string; plan: ConversationContextPlan } | undefined;
      if (mode === "off") expect(diagnostic).toBeUndefined();
      else {
        expect(diagnostic?.mode).toBe(mode);
        expect(diagnostic?.plan.expandedQueries).toEqual([
          "同事小林临时取消了约定，我今天只想说说。",
        ]);
        expect(diagnostic?.plan.originalQuery).toBe(result.userMessage.content);
        expect(diagnostic?.plan.adviceRequested).toBe(false);
      }
      const chat = generate.mock.calls.find(
        ([input]) => input.purpose === "chat_turn",
      )?.[0];
      expect(chat).toBeDefined();
      expect(chat?.prompt.includes("conversationIntent")).toBe(
        mode === "enforced",
      );
      expect(chat?.prompt.includes("MEMORY_USE_JSON")).toBe(
        mode === "enforced",
      );
      const before = generate.mock.calls.length;
      const replay = await send(result.userMessage.content, "context-next");
      expect(replay.json<ChatTurnResult>().idempotentReplay).toBe(true);
      expect(generate.mock.calls.length).toBe(before);
      expect(
        replay.json<ChatTurnResult>().assistantMessage.metadata[
          "companionContext"
        ],
      ).toEqual(diagnostic);
      if (mode === "enforced") {
        const contexts = app.personasim.kernel.registry.resolve(
          CONVERSATION_CONTEXT_SERVICE_TOKEN,
        );
        const reconcile = vi
          .spyOn(contexts, "reconcileMemories")
          .mockImplementation(() => {
            throw new Error("injected correction failure");
          });
        const messagesBefore =
          app.personasim.store.listMessagesForContext(sessionId);
        const failed = await send(
          "更正一下，我现在住在杭州。",
          "correction-failure",
        );
        expect(failed.statusCode).toBe(500);
        expect(app.personasim.store.listMessagesForContext(sessionId)).toEqual(
          messagesBefore,
        );
        expect(
          app.personasim.store.findTurnByClientMessageId(
            sessionId,
            "correction-failure",
          ),
        ).toBeUndefined();
        reconcile.mockRestore();
      }
    },
  );
});
