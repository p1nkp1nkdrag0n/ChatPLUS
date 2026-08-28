import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { TURN_DECISION_SERVICE_TOKEN } from "../composition/service-tokens.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";
import type { GenerateObjectInput } from "./llm-service.js";

const START_UTC = "2026-08-16T02:00:00.000Z";

describe("fixture world-effects modes", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it("keeps deterministic fixture scheduling in off mode without requesting or applying world effects", async () => {
    app = await createTestApp("off");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const before = app.personasim.store.getRuntimeState(character.id)!;
    const generate = vi.spyOn(app.personasim.llm, "generateObject");

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-effects-off",
      "今晚学校有新生晚会，你要一起去吗？",
    );

    expect(response.statusCode, response.body).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges.length).toBeGreaterThan(0);
    const after = app.personasim.store.getRuntimeState(character.id)!;
    expect(after).toMatchObject({
      moodValence: before.moodValence,
      moodArousal: before.moodArousal,
      energy: before.energy,
      stress: before.stress,
      socialBattery: before.socialBattery,
      focus: before.focus,
      relationship: {
        closeness: before.relationship.closeness,
        trust: before.relationship.trust,
        recentInteractionValence: before.relationship.recentInteractionValence,
        lastInteractionAtUtc: START_UTC,
      },
    });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.relationship.familiarity).toBeCloseTo(
      before.relationship.familiarity + 0.001,
      8,
    );

    const chatCall = generate.mock.calls.find(
      ([input]) => input.purpose === "chat_turn",
    )?.[0] as GenerateObjectInput<unknown> | undefined;
    expect(chatCall?.fixture).toMatchObject({ worldEffects: {} });
    const audit = app.personasim.store
      .listDomainEvents(character.id, 100)
      .find(
        (event) => event.eventType === "conversation.world_effects_committed",
      );
    expect(audit?.payload).toMatchObject({
      mode: "off",
      llmProposalStatus: "off",
      proposed: {},
      accepted: { stateDelta: false, relationshipDelta: false },
      applied: {
        stateDelta: {},
        relationshipDelta: { familiarity: expect.any(Number) },
      },
      source: {
        relationshipBaseline: "server_interaction_baseline",
        semanticProposal: "none",
      },
    });
  });

  it("validates fixture effects in shadow mode but leaves authoritative state unchanged", async () => {
    app = await createTestApp("shadow");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const before = app.personasim.store.getRuntimeState(character.id)!;

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-effects-shadow",
      "今天过得怎么样？",
    );

    expect(response.statusCode, response.body).toBe(201);
    const after = app.personasim.store.getRuntimeState(character.id)!;
    expect(after).toMatchObject({
      moodValence: before.moodValence,
      moodArousal: before.moodArousal,
      energy: before.energy,
      stress: before.stress,
      socialBattery: before.socialBattery,
      focus: before.focus,
      relationship: {
        closeness: before.relationship.closeness,
        trust: before.relationship.trust,
        recentInteractionValence: before.relationship.recentInteractionValence,
        lastInteractionAtUtc: START_UTC,
      },
    });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.relationship.familiarity).toBeCloseTo(
      before.relationship.familiarity + 0.001,
      8,
    );
    const audit = app.personasim.store
      .listDomainEvents(character.id, 100)
      .find(
        (event) =>
          event.eventType === "conversation.world_effects_shadow_evaluated",
      );
    expect(audit?.payload).toMatchObject({
      mode: "shadow",
      accepted: {
        stateDelta: true,
        relationshipDelta: true,
      },
      applied: {
        stateDelta: {},
        relationshipDelta: { familiarity: expect.any(Number) },
      },
      wouldApply: {
        applied: {
          stateDelta: {
            moodValence: expect.any(Number),
            socialBattery: expect.any(Number),
          },
          relationshipDelta: {
            closeness: expect.any(Number),
            familiarity: expect.any(Number),
            recentInteractionValence: expect.any(Number),
          },
        },
      },
      rejectionCodes: [],
    });
  });

  it("keeps validated fixture effects when reply repair succeeds", async () => {
    app = await createTestApp("enforced");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const before = app.personasim.store.getRuntimeState(character.id)!;
    forceInspectionFailures(app, 1);
    mockFixtureRepair(app, {
      reply: {
        text: "我刚把手头的事放下，现在可以认真听你说。",
        chunks: ["我刚把手头的事放下，现在可以认真听你说。"],
        toneTags: ["自然"],
      },
      scheduleEffects: [],
      stateDelta: { moodValence: -0.5 },
      memoryCandidates: [],
      reasonCode: "fixture_reply_repaired",
      reasonSummary: "修复了不符合角色设定的回复。",
    });

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-effects-repair",
      "你现在感觉怎么样？",
    );

    expect(response.statusCode, response.body).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toContain("认真听你说");
    expect(body.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(body.state.moodValence).toBeCloseTo(before.moodValence + 0.015, 8);
    expect(body.state.moodValence).not.toBeCloseTo(before.moodValence - 0.2, 8);
    expect(body.state.relationship.closeness).toBeGreaterThan(
      before.relationship.closeness,
    );
    expect(committedAudit(app, character.id)?.payload).toMatchObject({
      mode: "enforced",
      accepted: { stateDelta: true, relationshipDelta: true },
    });
  });

  it("keeps validated fixture effects when repair still fails and the reply falls back", async () => {
    app = await createTestApp("enforced");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const before = app.personasim.store.getRuntimeState(character.id)!;
    forceInspectionFailures(app, 2);
    mockFixtureRepair(app, {
      reply: {
        text: "As an AI language model, I still have no life.",
        chunks: ["As an AI language model, I still have no life."],
        toneTags: ["meta"],
      },
      scheduleEffects: [],
      stateDelta: { moodValence: -0.5 },
      memoryCandidates: [],
      reasonCode: "fixture_reply_still_invalid",
      reasonSummary: "这次修复仍然不符合角色设定。",
    });

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-effects-fallback",
      "你愿意说说现在的状态吗？",
    );

    expect(response.statusCode, response.body).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(body.assistantMessage.content).not.toContain("language model");
    expect(body.state.moodValence).toBeCloseTo(before.moodValence + 0.015, 8);
    expect(body.state.moodValence).not.toBeCloseTo(before.moodValence - 0.2, 8);
    expect(committedAudit(app, character.id)?.payload).toMatchObject({
      mode: "enforced",
      accepted: { stateDelta: true },
    });
  });
});

function mockFixtureRepair(app: PersonaSimApp, repair: unknown): void {
  vi.spyOn(app.personasim.llm, "generateObject").mockImplementation((input) => {
    if (input.purpose === "chat_turn") {
      return Promise.resolve({
        replyDecision: {
          text: "Provider continuity carrier.",
          chunks: ["Provider continuity carrier."],
          toneTags: ["neutral"],
        },
        worldEffects: {},
      } as never);
    }
    if (input.purpose === "repair_chat_turn") {
      return Promise.resolve(repair as never);
    }
    if (input.fixture !== undefined) return Promise.resolve(input.fixture);
    throw new Error(`Unexpected fixture purpose: ${input.purpose}`);
  });
}

function forceInspectionFailures(app: PersonaSimApp, count: number): void {
  const decisions = app.personasim.kernel.registry.resolve(
    TURN_DECISION_SERVICE_TOKEN,
  );
  const inspect = decisions.inspect.bind(decisions);
  let remaining = count;
  vi.spyOn(decisions, "inspect").mockImplementation((input) => {
    const result = inspect(input);
    if (remaining <= 0) return result;
    remaining -= 1;
    return {
      ...result,
      issues: [{ code: "TEST_FORCED_REPLY_REPAIR" }],
    };
  });
}

function committedAudit(app: PersonaSimApp, agentId: string) {
  return app.personasim.store
    .listDomainEvents(agentId, 100)
    .find(
      (event) => event.eventType === "conversation.world_effects_committed",
    );
}

async function createTestApp(
  liveWorldEffectsMode: "off" | "shadow" | "enforced",
): Promise<PersonaSimApp> {
  const clock = new FakeClock(START_UTC);
  const config = readConfig({
    nodeEnv: "test",
    profile: "fixture-world-effects-mode-test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    chatEffectsMode: "gated",
    scheduleNegotiationMode: "legacy",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode,
    memoryRecallMode: "legacy",
    autobiographyMode: "off",
    llm: {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
  });
  return buildApp({
    config,
    database: openDatabase(":memory:"),
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
}

async function createAndPublish(
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
      centralContradiction: "既重视学习计划，也珍惜重要关系",
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
