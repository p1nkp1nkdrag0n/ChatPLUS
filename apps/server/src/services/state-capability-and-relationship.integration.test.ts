import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";
import type { GenerateObjectInput } from "./llm-service.js";

const START_UTC = "2026-08-16T02:00:00.000Z";

describe("state capability and relationship scenarios", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
  });

  it.each([
    ["lightweight", false, 0],
    ["daily", true, 0.5],
    ["high_fidelity", true, 1],
  ] as const)(
    "applies the same proposal through the %s capability ceiling",
    async (tier, dynamicState, relationshipScale) => {
      const created = await createHarness();
      app = created.app;
      mockChat(app, () => ({
        replyDecision: { text: "我听见了，我们慢慢聊。" },
        worldEffects: {
          stateDelta: { energy: -0.1, stress: 0.1 },
          relationshipDelta: {
            closeness: 0.02,
            trust: 0.02,
            familiarity: 0.002,
            recentInteractionValence: 0.2,
            lastInteractionAtUtc: "2099-01-01T00:00:00.000Z",
          },
        },
      }));
      const character = await createAndPublish(app, tier);
      const before = app.personasim.store.getRuntimeState(character.id)!;
      const sessionId = await createSession(app, character.id);

      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        `capability-${tier}`,
        "我今天有点累，想和你安静地聊一会儿。",
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.state.energy).toBeCloseTo(
        before.energy + (dynamicState ? -0.1 : 0),
        10,
      );
      expect(body.state.stress).toBeCloseTo(
        before.stress + (dynamicState ? 0.1 : 0),
        10,
      );
      expect(body.state.relationship.closeness).toBeCloseTo(
        before.relationship.closeness + 0.02 * relationshipScale,
        10,
      );
      expect(body.state.relationship.trust).toBeCloseTo(
        before.relationship.trust + 0.02 * relationshipScale,
        10,
      );
      expect(body.state.relationship.familiarity).toBeCloseTo(
        before.relationship.familiarity + 0.003 * relationshipScale,
        10,
      );
      expect(body.state.relationship.lastInteractionAtUtc).toBe(START_UTC);
      expect(body.state.relationship.lastInteractionAtUtc).not.toBe(
        "2099-01-01T00:00:00.000Z",
      );
      expect(body.state.revision).toBe(before.revision + 1);

      const audit = worldEffectsAudit(app, character.id, `capability-${tier}`);
      expect(audit?.payload).toMatchObject({
        relationship: { capabilityScale: relationshipScale },
        rejectionCodes: ["unknown_relationship_delta_field"],
      });
    },
  );

  it.each(["daily", "high_fidelity"] as const)(
    "keeps oversized %s proposals inside server limits",
    async (tier) => {
      const created = await createHarness();
      app = created.app;
      mockChat(app, () => ({
        replyDecision: { text: "这个变化会慢慢发生。" },
        worldEffects: {
          stateDelta: { energy: -1, stress: 1 },
          relationshipDelta: {
            closeness: 1,
            trust: 1,
            familiarity: 1,
            recentInteractionValence: 1,
          },
        },
      }));
      const character = await createAndPublish(app, tier);
      const before = app.personasim.store.getRuntimeState(character.id)!;
      const sessionId = await createSession(app, character.id);

      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        `limits-${tier}`,
        "刚才那段交流对我很重要。",
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(before.energy - body.state.energy).toBeGreaterThan(0);
      expect(before.energy - body.state.energy).toBeLessThanOrEqual(0.2);
      expect(body.state.stress - before.stress).toBeGreaterThan(0);
      expect(body.state.stress - before.stress).toBeLessThanOrEqual(0.2);
      expect(
        body.state.relationship.closeness - before.relationship.closeness,
      ).toBeCloseTo(0.04, 10);
      expect(
        body.state.relationship.trust - before.relationship.trust,
      ).toBeCloseTo(0.03, 10);
      expect(
        body.state.relationship.familiarity - before.relationship.familiarity,
      ).toBeCloseTo(0.012, 10);

      const audit = worldEffectsAudit(app, character.id, `limits-${tier}`);
      const limits = nestedValue(audit?.payload, "limitsApplied");
      expect(Array.isArray(limits)).toBe(true);
      expect((limits as unknown[]).length).toBeGreaterThan(0);
    },
  );

  it("traces a bounded support, misunderstanding, and repair sequence", async () => {
    const created = await createHarness();
    app = created.app;
    const envelopes = [
      {
        replyDecision: { text: "谢谢你还记得，我确实轻松了一点。" },
        worldEffects: {
          relationshipDelta: {
            closeness: 0.02,
            trust: 0.02,
            recentInteractionValence: 0.3,
          },
        },
      },
      {
        replyDecision: { text: "你说得对，我刚才理解反了。" },
        worldEffects: {
          relationshipDelta: {
            closeness: -0.02,
            trust: -0.025,
            recentInteractionValence: -0.4,
          },
        },
      },
      {
        replyDecision: { text: "谢谢你愿意把误会说开，我们重新来。" },
        worldEffects: {
          relationshipDelta: {
            closeness: 0.015,
            trust: 0.025,
            recentInteractionValence: 0.4,
          },
        },
      },
    ];
    let index = 0;
    mockChat(app, () => envelopes[index++]!);
    const character = await createAndPublish(app, "high_fidelity");
    const sessionId = await createSession(app, character.id);
    const inputs = [
      "你前几天说剪片卡住了，我一直记着。今天还好吗？",
      "等等，你刚才把我的意思理解反了，我有点受伤。",
      "谢谢你停下来重新听我说，也把误会讲清楚了。我们和好了。",
    ];
    const states = [app.personasim.store.getRuntimeState(character.id)!];

    for (const [turnIndex, text] of inputs.entries()) {
      if (turnIndex > 0) created.clock.advance({ days: 1 });
      const correlationId = `relationship-sequence-${turnIndex + 1}`;
      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        correlationId,
        text,
      );
      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      states.push(body.state);
      const audit = worldEffectsAudit(app, character.id, correlationId);
      expect(audit?.payload).toMatchObject({
        mode: "enforced",
        proposed: {
          relationshipDelta:
            envelopes[turnIndex]!.worldEffects.relationshipDelta,
        },
      });
      expect(
        nestedValue(audit?.payload, "applied", "relationshipDelta"),
      ).toEqual(expect.any(Object));
    }

    expect(states[1]!.relationship.closeness).toBeGreaterThan(
      states[0]!.relationship.closeness,
    );
    expect(states[1]!.relationship.trust).toBeGreaterThan(
      states[0]!.relationship.trust,
    );
    expect(states[1]!.relationship.recentInteractionValence).toBeGreaterThan(
      states[0]!.relationship.recentInteractionValence,
    );
    expect(states[2]!.relationship.closeness).toBeLessThan(
      states[1]!.relationship.closeness,
    );
    expect(states[2]!.relationship.trust).toBeLessThan(
      states[1]!.relationship.trust,
    );
    expect(states[2]!.relationship.recentInteractionValence).toBeLessThan(
      states[1]!.relationship.recentInteractionValence,
    );
    expect(states[3]!.relationship.closeness).toBeGreaterThan(
      states[2]!.relationship.closeness,
    );
    expect(states[3]!.relationship.trust).toBeGreaterThan(
      states[2]!.relationship.trust,
    );
    expect(states[3]!.relationship.recentInteractionValence).toBeGreaterThan(
      states[2]!.relationship.recentInteractionValence,
    );
  });
});

type Tier = "lightweight" | "daily" | "high_fidelity";

async function createHarness(): Promise<{
  app: PersonaSimApp;
  clock: FakeClock;
}> {
  const clock = new FakeClock(START_UTC);
  const config = readConfig({
    nodeEnv: "test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    scheduleNegotiationMode: "legacy",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode: "enforced",
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

function mockChat(
  app: PersonaSimApp,
  responder: (input: GenerateObjectInput<unknown>) => unknown,
): void {
  vi.spyOn(app.personasim.llm, "generateObject").mockImplementation((input) =>
    Promise.resolve(
      (input.purpose === "chat_turn"
        ? responder(input)
        : fixtureFor(input)) as never,
    ),
  );
}

function fixtureFor(input: GenerateObjectInput<unknown>): unknown {
  if (input.fixture !== undefined) return input.fixture;
  throw new Error(`No fixture for ${input.purpose}`);
}

async function createAndPublish(
  app: PersonaSimApp,
  tier: Tier,
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
      relationshipToUser: "熟悉、信任且尊重彼此节奏的朋友",
      dialogueStyle: "自然、简洁、偶尔冷幽默",
      tier,
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

function worldEffectsAudit(
  app: PersonaSimApp,
  agentId: string,
  correlationId: string,
) {
  return app.personasim.store
    .listDomainEvents(agentId, 100)
    .find(
      (event) =>
        event.eventType === "conversation.world_effects_committed" &&
        event.correlationId === correlationId,
    );
}

function nestedValue(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (
      typeof current !== "object" ||
      current === null ||
      Array.isArray(current)
    ) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
