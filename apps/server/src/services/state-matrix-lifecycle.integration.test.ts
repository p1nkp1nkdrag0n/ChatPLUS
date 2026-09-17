import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import type { RuntimeState, RuntimeStateDelta } from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import {
  injectInternalChat,
  internalChatJson,
} from "../test-fixtures/internal-chat-response.js";
import type { ChatTurnResult } from "./conversation-service.js";
import type { GenerateObjectInput } from "./llm-service.js";

const START_UTC = "2026-09-17T02:00:00.000Z";
const STATE_FIELDS = [
  "moodValence",
  "moodArousal",
  "energy",
  "stress",
  "socialBattery",
  "focus",
] as const;
const JOINT_DELTA = {
  moodValence: 0.12,
  moodArousal: 0.1,
  energy: -0.16,
  stress: -0.1,
} satisfies RuntimeStateDelta;

// These tests control the model proposal and exercise real HTTP, persistence,
// prompt assembly, and fuzzy-life advancement. They do not establish that a
// model's psychological explanation or choice of numeric delta is valid.
describe("default fuzzy six-dimensional state lifecycle", () => {
  let app: PersonaSimApp | undefined;
  let directory: string | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
    if (directory !== undefined) {
      const target = resolve(directory);
      const allowedRoot = resolve(tmpdir()) + sep;
      if (!target.startsWith(allowedRoot))
        throw new Error("State lifecycle fixture escaped its temporary root");
      rmSync(target, { recursive: true, force: true });
      directory = undefined;
    }
  });

  it("persists one joint proposal without cascading into unrequested dimensions, then reads it without repeating the delta", async () => {
    const clock = new FakeClock(START_UTC);
    const harness = await createHarness(clock);
    app = harness.app;
    const { agentId, sessionId } = await createCharacterSession(app);
    const initial = app.personasim.store.getRuntimeState(agentId)!;
    harness.calls.length = 0;
    harness.propose(JOINT_DELTA);

    const first = await send(app, agentId, sessionId, "joint-event");
    expect(promptState(harness.calls[0]!)).toMatchObject(dimensions(initial));
    expect(first.state.moodValence).toBeCloseTo(initial.moodValence + 0.12, 12);
    expect(first.state.moodArousal).toBeCloseTo(initial.moodArousal + 0.1, 12);
    expect(first.state.energy).toBeCloseTo(initial.energy - 0.16, 12);
    expect(first.state.stress).toBeCloseTo(initial.stress - 0.1, 12);
    expect(first.state.focus).toBe(initial.focus);
    expect(first.state.socialBattery).toBe(initial.socialBattery);
    expect(app.personasim.store.getRuntimeState(agentId)).toEqual(first.state);
    const event = committedEvents(app, agentId).find(
      (item) => item.correlationId === "joint-event",
    );
    expect(event?.causationId).toBe(first.userMessage.id);
    expect(event?.payload).toMatchObject({
      mode: "enforced",
      acceptedDelta: { stateDelta: JOINT_DELTA },
      before: dimensions(initial),
      after: dimensions(first.state),
    });

    harness.propose();
    clock.advance({ minutes: 1 });
    const next = await send(app, agentId, sessionId, "after-joint-event");
    expect(promptState(harness.calls[1]!)).toMatchObject({
      ...dimensions(first.state),
      asOfUtc: first.state.asOfUtc,
      revision: first.state.revision,
    });
    expect(dimensions(next.state)).toEqual(dimensions(first.state));
    expect(committedEvents(app, agentId).at(-1)?.payload).toMatchObject({
      applied: { stateDelta: {} },
    });
    expect(harness.calls.map((call) => call.purpose)).toEqual([
      "chat_turn",
      "chat_turn",
    ]);
  });

  it("reads the exact committed mixed state after a file-database restart", async () => {
    directory = mkdtempSync(join(tmpdir(), "personasim-state-matrix-"));
    const databasePath = join(directory, "state.sqlite");
    const clock = new FakeClock(START_UTC);
    const firstHarness = await createHarness(clock, databasePath);
    app = firstHarness.app;
    const { agentId, sessionId } = await createCharacterSession(app);
    firstHarness.propose(JOINT_DELTA);
    clock.advance({ minutes: 17 });
    const first = await send(app, agentId, sessionId, "before-restart");
    await app.close();
    app = undefined;

    const reopened = await createHarness(clock, databasePath);
    app = reopened.app;
    expect(app.personasim.store.getRuntimeState(agentId)).toEqual(first.state);
    const next = await send(app, agentId, sessionId, "after-restart");
    expect(promptState(reopened.calls[0]!)).toMatchObject({
      ...dimensions(first.state),
      asOfUtc: first.state.asOfUtc,
      revision: first.state.revision,
    });
    expect(promptState(reopened.calls[0]!)).not.toHaveProperty(
      "sleepDebtMinutes",
    );
    expect(dimensions(next.state)).toEqual(dimensions(first.state));
    expect(reopened.calls.map((call) => call.purpose)).toEqual(["chat_turn"]);
  });

  it("does not generate or apply an event twice when the client message is replayed", async () => {
    const harness = await createHarness(new FakeClock(START_UTC));
    app = harness.app;
    const { agentId, sessionId } = await createCharacterSession(app);
    harness.calls.length = 0;
    harness.propose(JOINT_DELTA);
    const first = await send(app, agentId, sessionId, "replayed-event");
    const eventsBefore = committedEvents(app, agentId);
    const messagesBefore = app.personasim.store.listMessages(sessionId);

    const replay = await send(app, agentId, sessionId, "replayed-event", {
      status: 200,
    });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.assistantMessage.id).toBe(first.assistantMessage.id);
    expect(replay.state).toEqual(first.state);
    expect(app.personasim.store.getRuntimeState(agentId)).toEqual(first.state);
    expect(committedEvents(app, agentId)).toEqual(eventsBefore);
    expect(app.personasim.store.listMessages(sessionId)).toEqual(
      messagesBefore,
    );
    expect(harness.calls.map((call) => call.purpose)).toEqual(["chat_turn"]);
  });

  it.each([24, 7 * 24])(
    "currently retains six-dimensional values after %s idle hours and refreshes the whole snapshot timestamp on a no-delta turn",
    async (hours) => {
      const clock = new FakeClock(START_UTC);
      const harness = await createHarness(clock);
      app = harness.app;
      const { agentId, sessionId } = await createCharacterSession(app);
      harness.calls.length = 0;
      harness.propose(JOINT_DELTA);
      const first = await send(app, agentId, sessionId, "before-idle");
      harness.propose();
      clock.advance({ hours });

      // Characterizes today's lifecycle, not a desired recovery curve:
      // the ordinary HTTP turn advances fuzzy life before assembling its prompt.
      const next = await send(app, agentId, sessionId, "after-idle");
      const admittedState = promptState(harness.calls[1]!);
      expect(admittedState).toMatchObject({
        ...dimensions(first.state),
        asOfUtc: first.state.asOfUtc,
        revision: first.state.revision,
      });
      expect(dimensions(next.state)).toEqual(dimensions(first.state));
      expect(next.state.asOfUtc).toBe(clock.nowUtc());
      expect(next.state.asOfUtc).not.toBe(first.state.asOfUtc);
      expect(next.state.revision).toBe(first.state.revision + 1);
      expect(committedEvents(app, agentId).at(-1)?.payload).toMatchObject({
        applied: { stateDelta: {} },
      });
      expect(
        app.personasim.store
          .listDomainEvents(agentId, 100)
          .some((event) => event.eventType === "simulation.settled"),
      ).toBe(false);
      expect(harness.calls.map((call) => call.purpose)).toEqual([
        "chat_turn",
        "chat_turn",
      ]);
    },
  );

  it("keeps the user's fatigue separate from supplied character state when no character delta is proposed", async () => {
    const harness = await createHarness(new FakeClock(START_UTC));
    app = harness.app;
    const { agentId, sessionId } = await createCharacterSession(app);
    const initial = app.personasim.store.getRuntimeState(agentId)!;
    harness.calls.length = 0;
    const userText = "我今天很累，刚忙完自己的工作，想和你安静地聊一会儿。";
    const result = await send(app, agentId, sessionId, "user-fatigue", {
      text: userText,
    });
    const call = harness.calls[0]!;

    expect(promptJson(call.prompt, "CURRENT_USER_MESSAGE_JSON")).toEqual({
      content: userText,
    });
    expect(promptState(call)).toMatchObject(dimensions(initial));
    expect(call.system).toContain(
      "The user having just finished work does not mean the character did.",
    );
    expect(call.system).toContain(
      "Values are signed changes caused by this turn",
    );
    expect(dimensions(result.state)).toEqual(dimensions(initial));
    expect(harness.calls.map((item) => item.purpose)).toEqual(["chat_turn"]);
    // A supplied no-delta response verifies the transport and deterministic
    // behavior only. It does not prove the model will infer attribution well,
    // or that an ungrounded numeric proposal would be rejected by the server.
  });
});

async function createHarness(clock: FakeClock, databasePath = ":memory:") {
  const config = readConfig({
    nodeEnv: "test",
    databasePath,
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    llm: {
      provider: "openai-compatible",
      baseUrl: "https://example.invalid",
      apiKey: "offline-test-key",
      model: "offline-state-matrix",
      maxRetries: 0,
      timeoutMs: 1_000,
    },
  });
  // Deliberately do not set lifePlanningMode/liveWorldEffectsMode: cover the
  // actual product defaults, not an opt-in historical scheduling path.
  expect(config.lifePlanningMode).toBe("fuzzy");
  expect(config.liveWorldEffectsMode).toBe("enforced");
  const app = await buildApp({
    config,
    database: openDatabase(databasePath),
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
  const calls: Array<GenerateObjectInput<unknown>> = [];
  let delta: RuntimeStateDelta | undefined;
  vi.spyOn(app.personasim.llm, "generateObject").mockImplementation((input) => {
    calls.push(input);
    if (input.purpose === "chat_turn")
      return Promise.resolve({
        replyDecision: {
          text: "我听见了，你慢慢说。",
          deliveryMode: "single_block",
        },
        worldEffects: delta === undefined ? {} : { stateDelta: delta },
      } as never);
    if (input.fixture !== undefined)
      return Promise.resolve(input.fixture as never);
    throw new Error(`Unexpected offline model call: ${input.purpose}`);
  });
  return {
    app,
    calls,
    propose: (next?: RuntimeStateDelta) => {
      delta = next;
    },
  };
}

async function createCharacterSession(app: PersonaSimApp) {
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "林夏",
      worldSetting: "当代城市生活",
      workOrRole: "插画师",
      coreTraits: ["认真", "温暖"],
      primaryGoal: "完成自己的插画集",
      relationshipToUser: "普通朋友",
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
  const session = await app.inject({
    method: "POST",
    url: `/api/agents/${character.id}/sessions`,
    payload: {},
  });
  expect(session.statusCode, session.body).toBe(201);
  return {
    agentId: character.id,
    sessionId: session.json<{ session: { id: string } }>().session.id,
  };
}

async function send(
  app: PersonaSimApp,
  agentId: string,
  sessionId: string,
  clientMessageId: string,
  options: { text?: string; status?: number } = {},
): Promise<ChatTurnResult> {
  const response = await injectInternalChat(app, sessionId, {
    agentId,
    clientMessageId,
    text: options.text ?? "我想和你聊几句。",
  });
  expect(response.statusCode, response.body).toBe(options.status ?? 201);
  return internalChatJson<ChatTurnResult>(response);
}

function dimensions(state: RuntimeState): Record<string, number> {
  return Object.fromEntries(STATE_FIELDS.map((field) => [field, state[field]]));
}

function promptState(call: GenerateObjectInput<unknown>) {
  return promptJson(call.prompt, "RUNTIME_STATE_JSON");
}

function promptJson(prompt: string, label: string): Record<string, unknown> {
  const lines = prompt.split("\n");
  const index = lines.indexOf(label);
  expect(
    index,
    `Missing actual prompt segment ${label}`,
  ).toBeGreaterThanOrEqual(0);
  return JSON.parse(lines[index + 1]!) as Record<string, unknown>;
}

function committedEvents(app: PersonaSimApp, agentId: string) {
  return app.personasim.store
    .listDomainEvents(agentId, 100)
    .filter(
      (event) => event.eventType === "conversation.world_effects_committed",
    );
}
