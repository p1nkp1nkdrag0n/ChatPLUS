import type {
  CharacterSpec,
  InteractionAppraisalCandidate,
  RuntimeState,
} from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import { injectInternalChat } from "../test-fixtures/internal-chat-response.js";
import { InteractionAppraisalService } from "./interaction-appraisal-service.js";
import { validateMergeAndPersistMemories } from "./memory-service.js";

const NOW = "2026-09-13T15:59:00.000Z";
const USER = "我想聊一件比较私人的事情。";
const REPLY = "我在听，也想慢一点聊。";
const CANDIDATE: InteractionAppraisalCandidate = {
  triggerQuote: USER,
  feelings: ["concern", "discomfort"],
  attitude: "ambivalent",
  publicExpression: REPLY,
  privateView: ["care_without_agreement", "prefer_a_slower_pace"],
};

describe("committed interaction appraisal", () => {
  let app: PersonaSimApp;
  let character: CharacterSpec;
  let sessionId: string;
  let stateBefore: RuntimeState;
  let candidate: unknown;
  let userText: string;
  let replyText: string;
  let relationshipDelta: unknown;
  let observedPrompts: string[];
  let clock: FakeClock;
  let finishNextDay = false;

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  async function setup(
    mode: "off" | "shadow" | "enforced" = "off",
    closeness = 0.05,
    provider: "openai-compatible" | "fixture" = "openai-compatible",
  ) {
    candidate = CANDIDATE;
    userText = USER;
    replyText = REPLY;
    relationshipDelta = undefined;
    observedPrompts = [];
    finishNextDay = false;
    clock = new FakeClock(NOW);
    app = await buildApp({
      database: openDatabase(":memory:"),
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
      ...(provider === "fixture"
        ? {
            fixtureTurnBehavior: {
              semanticReply: () => replyText,
              interactionAppraisal: ({
                replyText: actualReply,
              }: {
                replyText: string;
              }) => ({ ...CANDIDATE, publicExpression: actualReply }),
            },
          }
        : {}),
      config: readConfig({
        nodeEnv: "test",
        databasePath: ":memory:",
        seedDemo: false,
        scheduleNegotiationMode: "legacy",
        selfInitiatedPlanningMode: "off",
        lifePlanningMode: "legacy_exact",
        liveWorldEffectsMode: mode,
        autobiographyMode: "off",
        personaRuntimeMode: "off",
        companionContextMode: "off",
        memoryRecallMode: "legacy",
        llm: {
          provider,
          baseUrl: "https://example.invalid",
          apiKey: "fixture-only",
          model: "fixture-only",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
    });
    const originalGenerate = app.personasim.llm.generateObject.bind(
      app.personasim.llm,
    );
    const generate = vi
      .spyOn(app.personasim.llm, "generateObject")
      .mockImplementation((input) => {
        if (input.purpose !== "chat_turn") {
          if (input.fixture === undefined)
            throw new Error(
              `Missing deterministic fixture for ${input.purpose}`,
            );
          return Promise.resolve(input.fixture as never);
        }
        observedPrompts.push(`${input.system}\n${input.prompt}`);
        if (finishNextDay) clock.advance({ minutes: 3 });
        if (provider === "fixture") return originalGenerate(input);
        return Promise.resolve({
          replyDecision: { text: replyText, deliveryMode: "single_block" },
          worldEffects:
            relationshipDelta === undefined ? {} : { relationshipDelta },
          ...(candidate === undefined
            ? {}
            : { interactionAppraisal: candidate }),
        } as never);
      });
    const generated = await app.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: {
        name: "林夏",
        worldSetting: "当代城市",
        workOrRole: "插画师",
        coreTraits: ["有主见", "重视分寸", "温暖"],
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
    character = app.personasim.store.getCharacterSpec(draft.id)!;
    const created = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/sessions`,
      payload: {},
    });
    expect(created.statusCode, created.body).toBe(201);
    sessionId = created.json<{ session: { id: string } }>().session.id;
    const state = app.personasim.store.getRuntimeState(character.id)!;
    app.personasim.store.updateRuntimeState({
      ...state,
      energy: 0.7,
      stress: 0.2,
      socialBattery: 0.6,
      relationship: { ...state.relationship, closeness },
    });
    stateBefore = app.personasim.store.getRuntimeState(character.id)!;
    generate.mockClear();
    return generate;
  }

  function send(clientMessageId = "appraisal-turn") {
    return injectInternalChat(app, sessionId, {
      agentId: character.id,
      clientMessageId,
      text: userText,
    });
  }

  function records() {
    return new InteractionAppraisalService(app.personasim.store).listForDiary({
      agentId: character.id,
      fromUtc: "2026-09-13T00:00:00.000Z",
      toUtc: "2026-09-14T00:00:00.000Z",
    });
  }

  it.each(["off", "shadow", "enforced"] as const)(
    "uses the same chat generation and transaction in %s world-effects mode",
    async (mode) => {
      const generate = await setup(mode);
      const response = await send();
      expect(response.statusCode, response.body).toBe(201);
      expect(records()).toHaveLength(1);
      const record = records()[0]!;
      expect(record).toMatchObject({
        ...CANDIDATE,
        characterVersion: character.version,
        stateRevision: stateBefore.revision,
        closeness: 0.05,
        runtimeState: stateBefore,
        recordedAtUtc: NOW,
        sourceMessageIds: [
          response.internalTurn!.userMessage.id,
          response.internalTurn!.assistantMessage.id,
        ],
        authority: "subjective_character_reaction",
      });
      expect(record.sources.map((source) => source.content)).toEqual([
        USER,
        REPLY,
      ]);
      expect(record.privateViewText).toContain("交流的节奏慢一些");
      expect(generate.mock.calls.map(([input]) => input.purpose)).toEqual([
        "chat_turn",
      ]);
      expect(observedPrompts[0]).toContain('"closeness":0.05');
      expect(observedPrompts[0]).toContain("RUNTIME_STATE_JSON");
      expect(observedPrompts[0]).toContain(
        "Low closeness does not imply dislike",
      );
      expect(response.body).not.toContain("interactionAppraisal");
      expect(
        JSON.stringify(response.internalTurn!.assistantMessage.metadata),
      ).not.toContain("privateView");
      await send();
      expect(records()).toHaveLength(1);
      expect(
        generate.mock.calls.filter(([input]) => input.purpose === "chat_turn"),
      ).toHaveLength(1);
    },
  );

  it("allows negative feelings at high closeness without authorizing an affinity deduction", async () => {
    await setup("enforced", 0.9);
    relationshipDelta = { closeness: -0.15 };
    const response = await send();
    expect(response.statusCode, response.body).toBe(201);
    expect(records()[0]).toMatchObject({
      closeness: 0.9,
      feelings: ["concern", "discomfort"],
    });
    expect(
      app.personasim.store.getRuntimeState(character.id)!.relationship
        .closeness,
    ).toBeGreaterThanOrEqual(0.9);
  });

  it.each(["off", "enforced"] as const)(
    "supports an explicit fixture appraisal callback in %s mode",
    async (mode) => {
      const generate = await setup(mode, 0.05, "fixture");
      const response = await send();
      expect(response.statusCode, response.body).toBe(201);
      expect(records()).toHaveLength(1);
      expect(records()[0]?.publicExpression).toBe(
        response.internalTurn!.assistantMessage.content,
      );
      expect(generate.mock.calls.map(([input]) => input.purpose)).toEqual([
        "chat_turn",
      ]);
    },
  );

  it("assigns a reply completed after midnight to the user's original local sharing day", async () => {
    await setup();
    finishNextDay = true;
    const response = await send();
    expect(response.statusCode, response.body).toBe(201);
    expect(clock.nowUtc()).toBe("2026-09-13T16:02:00.000Z");
    const service = new InteractionAppraisalService(app.personasim.store);
    expect(
      service.listForDiary({
        agentId: character.id,
        fromUtc: "2026-09-12T16:00:00.000Z",
        toUtc: "2026-09-13T16:00:00.000Z",
      }),
    ).toHaveLength(1);
    expect(
      service.listForDiary({
        agentId: character.id,
        fromUtc: "2026-09-13T16:00:00.000Z",
        toUtc: "2026-09-14T16:00:00.000Z",
      }),
    ).toEqual([]);
  });

  it("allows a receptive positive reaction at low closeness without inventing offence", async () => {
    await setup("off", 0.01);
    candidate = {
      ...CANDIDATE,
      feelings: ["curiosity", "appreciation"],
      attitude: "receptive",
      privateView: ["interested_in_understanding", "appreciate_trust"],
    };
    const response = await send();
    expect(response.statusCode, response.body).toBe(201);
    expect(records()[0]).toMatchObject({
      closeness: 0.01,
      attitude: "receptive",
      feelings: ["curiosity", "appreciation"],
    });
  });

  it.each([
    undefined,
    { ...CANDIDATE, triggerQuote: "来自另一条消息的事情" },
    { ...CANDIDATE, publicExpression: "我特别喜欢，快讲更多。" },
    { ...CANDIDATE, privateView: ["他故意操控我，我昨晚一直没有睡。"] },
    { ...CANDIDATE, sourceMessageIds: ["foreign-message"], closeness: 0.9 },
  ])(
    "keeps a valid public reply when optional appraisal is absent or invalid: %#",
    async (value) => {
      const generate = await setup();
      candidate = value;
      const response = await send();
      expect(response.statusCode, response.body).toBe(201);
      expect(response.internalTurn!.assistantMessage.content).toBe(REPLY);
      expect(records()).toEqual([]);
      expect(generate.mock.calls.map(([input]) => input.purpose)).toEqual([
        "chat_turn",
      ]);
    },
  );

  it.each(["user", "assistant"] as const)(
    "excludes a reaction after its %s source is edited, even if restored",
    async (role) => {
      await setup();
      await send();
      const record = records()[0]!;
      expect(record).toBeDefined();
      const source = record.sources.find((item) => item.role === role)!;
      app.personasim.store.database
        .prepare("UPDATE messages SET content = ? WHERE id = ?")
        .run("来源已修正。", source.id);
      expect(records()).toEqual([]);
      app.personasim.store.database
        .prepare("UPDATE messages SET content = ? WHERE id = ?")
        .run(source.content, source.id);
      expect(records()).toEqual([]);
    },
  );

  it("excludes a reaction when a memory supported by the sharing source needs review", async () => {
    await setup();
    userText = "我叫小林。";
    candidate = { ...CANDIDATE, triggerQuote: userText };
    const response = await send();
    expect(records()).toHaveLength(1);
    const memories = validateMergeAndPersistMemories({
      store: app.personasim.store,
      agentId: character.id,
      authoritativeMessageId: response.internalTurn!.userMessage.id,
      nowUtc: NOW,
      candidates: [],
      maxCandidates: 4,
    });
    expect(memories.length).toBeGreaterThan(0);
    app.personasim.store.database
      .prepare("UPDATE memories SET status = 'needs_review' WHERE id = ?")
      .run(memories[0]!.id);
    expect(records()).toEqual([]);
  });

  it("rolls back reactions and their dependencies when a later chat audit fails", async () => {
    await setup();
    const insert = app.personasim.store.insertDomainEvent.bind(
      app.personasim.store,
    );
    vi.spyOn(app.personasim.store, "insertDomainEvent").mockImplementation(
      (input) => {
        if (input.eventType === "conversation.turn_committed")
          throw new Error("test late audit failure");
        return insert(input);
      },
    );
    const response = await send();
    expect(response.statusCode).toBe(500);
    expect(records()).toEqual([]);
    const rows = app.personasim.store.database
      .prepare(
        "SELECT count(*) AS count FROM memory_derived_validity WHERE derived_type = 'interaction_appraisal'",
      )
      .get() as { count: number };
    expect(rows.count).toBe(0);
  });

  it("does not accept an earlier-generation appraisal for a rewritten committed reply", async () => {
    await setup();
    candidate = undefined;
    const response = await send();
    expect(response.statusCode, response.body).toBe(201);
    const turn = response.internalTurn!;
    const record = new InteractionAppraisalService(
      app.personasim.store,
    ).recordForTurn({
      candidate: CANDIDATE,
      character,
      stateBefore,
      userMessageId: turn.userMessage.id,
      assistantMessageId: turn.assistantMessage.id,
      generatedReplyText: "我特别喜欢，快讲更多。",
      nowUtc: NOW,
    });
    expect(record).toBeUndefined();
    expect(records()).toEqual([]);
  });
});
