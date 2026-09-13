import {
  FuzzyLifePromptContextSchema,
  type CharacterSpec,
  type FuzzyLifePromptContext,
} from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";

const NOW = "2026-09-06T04:00:00.000Z";

function lifeSnapshot(): FuzzyLifePromptContext {
  return FuzzyLifePromptContextSchema.parse({
    authority: "server_persisted_fuzzy_life",
    semantics: {
      intentionsAreNotOccurrences: true,
      decisionsAreNotActions: true,
      actionsAreNotOutcomes: true,
      characterTimePrecision: "day_or_period",
      characterLifeOwner: "character",
      lifeThreadStagesAdvanceByCharacterLocalDate: false,
      lifeThreadStageIsNotDailyOutcome: true,
      lifeThreadStageIsNotProofOfExternalSuccess: true,
    },
    today: {
      subject: "character",
      localDate: "2026-09-06",
      currentPeriod: "afternoon",
      availability: "free",
      intentions: [],
    },
    ongoingThreads: [
      {
        subject: "character",
        title: "城市速写",
        currentStage: "当前关注",
        progressNote: "才画了一页，还未完成",
      },
      {
        subject: "character",
        title: "吉他练习",
        currentStage: "当前关注",
        progressNote: "只练了十分钟",
      },
    ],
    verifiedRecentOutcomes: [
      {
        subject: "character",
        effectiveLocalDate: "2026-09-05",
        outcomeKind: "partial",
        summary: "城市速写才画了一页，还没有完成",
      },
      {
        subject: "character",
        effectiveLocalDate: "2026-09-05",
        outcomeKind: "partial",
        summary: "吉他练习了十分钟",
      },
    ],
    unresolvedDilemmas: [],
    recentDecisionDilemmas: [],
    activePressure: [],
    relationshipMilestones: [],
    evidencedSupport: [],
    recentDecisions: [],
    canonicalCausalFacts: [],
    evidencedActions: [],
    evidencedConsequences: [],
    reflections: [],
  });
}

describe("requested life projects through HTTP generation and repair", () => {
  let app: PersonaSimApp;
  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  async function setup() {
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        databasePath: ":memory:",
        seedDemo: false,
        lifePlanningMode: "fuzzy",
        memoryRecallMode: "enforced",
        autobiographyMode: "off",
        companionContextMode: "enforced",
        personaRuntimeMode: "enforced",
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
        coreTraits: ["愿意倾听"],
        initialRelationship: "邻居",
        dialogueStyle: "自然简洁",
        tier: "high_fidelity",
        timezone: "Asia/Shanghai",
      },
    });
    expect(generated.statusCode, generated.body).toBe(201);
    const draft = generated.json<{ character: CharacterSpec }>().character;
    const published = await app.inject({
      method: "POST",
      url: `/api/characters/${draft.id}/publish`,
      payload: { expectedVersion: draft.version },
    });
    expect(published.statusCode, published.body).toBe(200);
    const session = await app.inject({
      method: "POST",
      url: `/api/agents/${draft.id}/sessions`,
      payload: {},
    });
    expect(session.statusCode, session.body).toBe(201);
    return {
      agentId: draft.id,
      sessionId: session.json<{ session: { id: string } }>().session.id,
    };
  }

  it.each([
    "今天过得怎么样？",
    "最近还好吗？",
    "最近忙什么呢？",
    "城市速写呢？",
  ])(
    "retains persisted life in the actual generation prompt for %s",
    async (text) => {
      const { agentId, sessionId } = await setup();
      const full = lifeSnapshot();
      vi.spyOn(app.personasim.life, "promptContext").mockReturnValue(full);
      const generate = vi.spyOn(app.personasim.llm, "generateObject");
      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/messages`,
        payload: { agentId, clientMessageId: "natural-life-query", text },
      });
      expect(response.statusCode, response.body).toBe(201);
      const prompt = generate.mock.calls.find(
        ([input]) => input.purpose === "chat_turn",
      )?.[0].prompt;
      expect(prompt).toContain("LIFE_CONTEXT_JSON\n");
      expect(prompt).toContain("城市速写");
      expect(prompt).toContain("还没有完成");
      if (text === "城市速写呢？") expect(prompt).not.toContain("吉他练习");
    },
  );

  it.each(["fixture", "persona"] as const)(
    "keeps selected evidence in %s repair while validating the full causal snapshot",
    async (path) => {
      const { agentId, sessionId } = await setup();
      const full = lifeSnapshot();
      vi.spyOn(
        app.personasim.kernel.services.life,
        "promptContext",
      ).mockReturnValue(full);
      const decisions = app.personasim.kernel.services.turnDecisions;
      const decide = vi.spyOn(decisions, "decide");
      const inspect = vi.spyOn(decisions, "inspect");
      const repairs = app.personasim.kernel.services.replyRepairs;
      const repairFixture = vi.spyOn(repairs, "repairFixtureDecision");
      const repairPersona = vi.spyOn(repairs, "repairPersonaReply");
      if (path === "persona")
        Object.defineProperty(
          app.personasim.llm.captureDefault(),
          "providerName",
          {
            value: "openai-compatible",
            configurable: true,
          },
        );
      const originalGenerate = app.personasim.llm.generateObject.bind(
        app.personasim.llm,
      );
      const generate = vi
        .spyOn(app.personasim.llm, "generateObject")
        .mockImplementation((input) => {
          if (input.purpose === "chat_turn")
            return Promise.resolve({ invalid: true } as never);
          if (path === "persona" && input.purpose === "repair_chat_turn")
            return Promise.resolve({
              text: "才画了一页，还没完成。我准备慢慢把桥边的树画好。",
            } as never);
          return originalGenerate(input);
        });
      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/messages`,
        payload: {
          agentId,
          clientMessageId: `project-${path}`,
          text: "城市速写画得怎么样了？",
        },
      });
      expect(response.statusCode, response.body).toBe(201);
      const selected = decide.mock.calls[0]?.[0].lifeContext;
      expect(selected?.ongoingThreads.map((item) => item.title)).toEqual([
        "城市速写",
      ]);
      expect(selected?.verifiedRecentOutcomes[0]?.summary).toContain(
        "还没有完成",
      );
      expect(decide.mock.calls[0]?.[0].causalContext).toBe(full);
      expect(inspect).toHaveBeenCalled();
      for (const [input] of inspect.mock.calls)
        expect(input.causalContext).toBe(full);
      const repair = path === "fixture" ? repairFixture : repairPersona;
      expect(repair).toHaveBeenCalledOnce();
      expect(repair.mock.calls[0]?.[0].lifeContext).toBe(selected);
      const initialPrompt = generate.mock.calls.find(
        ([input]) => input.purpose === "chat_turn",
      )?.[0].prompt;
      expect(initialPrompt).toContain("LIFE_CONTEXT_JSON\n");
      expect(initialPrompt).toContain("还没有完成");
      expect(initialPrompt).not.toContain("吉他练习");
      const repairedPrompt = generate.mock.calls.find(
        ([input]) => input.purpose === "repair_chat_turn",
      )?.[0].prompt;
      expect(repairedPrompt).toContain(JSON.stringify(selected));
      expect(repairedPrompt).not.toContain("吉他练习");
      expect(full.ongoingThreads).toHaveLength(2);
    },
  );
});
