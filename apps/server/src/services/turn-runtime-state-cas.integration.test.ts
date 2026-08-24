import type { TurnObservationProposal } from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import type { RuntimeState } from "../domain/schemas.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";
import type { GenerateObjectInput } from "./llm-service.js";

const NOW_UTC = "2026-08-16T02:00:00.000Z";

describe("split turn runtime-state concurrency", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app !== undefined) await app.close();
    app = undefined;
  });

  it("rejects a stale prepared state and rolls back the entire split turn", async () => {
    const harness = await createHarness();
    app = harness.app;
    const sessionId = app.personasim.conversations.createSession(
      harness.agentId,
    ).id;
    const initialState = requiredState(app, harness.agentId);
    let concurrentState: RuntimeState | undefined;
    const runtimeStateCas = vi.spyOn(
      app.personasim.store,
      "compareAndSetRuntimeState",
    );

    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        if (input.purpose === "turn_understanding") {
          return Promise.resolve(
            observation({ worldEffects: { stateDelta: { stress: 0.05 } } }),
          );
        }
        if (input.purpose === "reply_generation") {
          const current = requiredState(app!, harness.agentId);
          concurrentState = {
            ...current,
            energy: Math.max(0, current.energy - 0.05),
            revision: current.revision + 1,
          };
          app!.personasim.store.updateRuntimeState(concurrentState);
          return Promise.resolve({ text: "好，我们就轻松聊聊。" });
        }
        return fixtureResponse(input);
      },
    );

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "runtime-cas-stale-turn",
      "今天有点紧张，就随便聊聊。",
    );

    expect(response.statusCode).toBe(409);
    expect(jsonBody<{ error: { code: string } }>(response).error.code).toBe(
      "runtime_state_revision_conflict",
    );
    expect(runtimeStateCas).toHaveBeenCalledWith(
      expect.objectContaining({ revision: initialState.revision + 1 }),
      initialState.revision,
    );
    expect(concurrentState).toBeDefined();
    expect(requiredState(app, harness.agentId)).toEqual(concurrentState);
    expect(requiredState(app, harness.agentId)).not.toMatchObject({
      stress: initialState.stress + 0.05,
    });
    expect(app.personasim.store.listMessages(sessionId)).toEqual([]);
    expect(eventsFor(app, harness.agentId, "runtime-cas-stale-turn")).toEqual(
      [],
    );
  });

  it("uses unique conversation stream versions without bumping no-op state", async () => {
    const harness = await createHarness();
    app = harness.app;
    const sessionId = app.personasim.conversations.createSession(
      harness.agentId,
    ).id;
    const initialRevision = requiredState(app, harness.agentId).revision;

    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        if (input.purpose === "turn_understanding") {
          return Promise.resolve(observation({ worldEffects: {} }));
        }
        if (input.purpose === "reply_generation") {
          return Promise.resolve({ text: "好，我在听。" });
        }
        return fixtureResponse(input);
      },
    );

    const first = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "runtime-stream-first",
      "今天就随便聊聊。",
    );
    const second = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "runtime-stream-second",
      "再聊一会儿吧。",
    );

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(requiredState(app, harness.agentId).revision).toBe(initialRevision);
    expect(
      ["runtime-stream-first", "runtime-stream-second"].map((clientId) =>
        Number(
          eventsFor(app!, harness.agentId, clientId).find(
            (event) => event.eventType === "conversation.turn_committed",
          )?.streamVersion,
        ),
      ),
    ).toEqual([1, 2]);
    for (const [streamType, eventType] of [
      ["memory_recall", "memory.recall_evaluated"],
      ["turn_understanding", "conversation.turn_understanding_resolved"],
      ["world_effects", "conversation.world_effects_committed"],
    ] as const) {
      expect(
        app.personasim.store
          .listDomainEvents(harness.agentId, 500)
          .filter(
            (event) =>
              event.streamType === streamType &&
              event.streamId === sessionId &&
              event.eventType === eventType,
          )
          .sort(
            (left, right) =>
              Number(left.streamVersion) - Number(right.streamVersion),
          )
          .map((event) => event.streamVersion),
      ).toEqual([1, 2]);
    }
  });

  it("sequences legacy shadow audits and turn commits in one conversation stream", async () => {
    const harness = await createHarness("shadow");
    app = harness.app;
    const sessionId = app.personasim.conversations.createSession(
      harness.agentId,
    ).id;

    const first = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "runtime-stream-shadow-first",
      "今天就随便聊聊。",
    );
    const second = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "runtime-stream-shadow-second",
      "再聊一会儿吧。",
    );

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(
      app.personasim.store
        .listDomainEvents(harness.agentId, 500)
        .filter(
          (event) =>
            event.streamType === "conversation" && event.streamId === sessionId,
        )
        .sort(
          (left, right) =>
            Number(left.streamVersion) - Number(right.streamVersion),
        )
        .map((event) => [event.streamVersion, event.eventType]),
    ).toEqual([
      [1, "conversation.turn_pipeline_shadow_compared"],
      [2, "conversation.turn_committed"],
      [3, "conversation.turn_pipeline_shadow_compared"],
      [4, "conversation.turn_committed"],
    ]);
  });

  it("replays an enforced split command exactly once and rejects changed-content reuse", async () => {
    const harness = await createHarness();
    app = harness.app;
    const sessionId = app.personasim.conversations.createSession(
      harness.agentId,
    ).id;
    const generateObject = vi
      .spyOn(app.personasim.llm, "generateObject")
      .mockImplementation((input) => {
        if (input.purpose === "turn_understanding") {
          return Promise.resolve(observation({ worldEffects: {} }));
        }
        if (input.purpose === "reply_generation") {
          return Promise.resolve({ text: "好，我在听。" });
        }
        return fixtureResponse(input);
      });
    const clientMessageId = "split-idempotent-command";
    const text = "今天就随便聊聊。";

    const first = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      text,
    );
    const callsAfterFirst = generateObject.mock.calls.length;
    const replay = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      text,
    );
    const changed = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      "换一段不同的内容。",
    );

    expect(first.statusCode).toBe(201);
    const firstBody = jsonBody<ChatTurnResult>(first);
    expect(firstBody.idempotentReplay).toBe(false);
    expect(firstBody.assistantMessage.metadata["totalChatLatencyMs"]).toEqual(
      expect.any(Number),
    );
    const committedPayload = eventsFor(
      app,
      harness.agentId,
      clientMessageId,
    ).find((event) => event.eventType === "conversation.turn_committed")
      ?.payload as Record<string, unknown> | undefined;
    expect(committedPayload?.["totalChatLatencyMs"]).toEqual(
      expect.any(Number),
    );
    expect(replay.statusCode).toBe(200);
    expect(jsonBody<ChatTurnResult>(replay)).toMatchObject({
      idempotentReplay: true,
      userMessage: {
        id: firstBody.userMessage.id,
      },
      assistantMessage: {
        id: firstBody.assistantMessage.id,
      },
    });
    expect(generateObject).toHaveBeenCalledTimes(callsAfterFirst);
    expect(changed.statusCode).toBe(409);
    expect(jsonBody<{ error: { code: string } }>(changed).error.code).toBe(
      "idempotency_key_reused",
    );
    expect(app.personasim.store.listMessages(sessionId)).toHaveLength(2);
    expect(
      eventsFor(app, harness.agentId, clientMessageId).filter(
        (event) => event.eventType === "conversation.turn_committed",
      ),
    ).toHaveLength(1);
  });

  it("sequences legacy world-effect shadow audits independently of runtime revisions", async () => {
    const harness = await createHarness("legacy", "shadow", "legacy");
    app = harness.app;
    const sessionId = app.personasim.conversations.createSession(
      harness.agentId,
    ).id;
    Object.defineProperty(app.personasim.llm, "providerName", {
      value: "openai-compatible",
    });
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        if (input.purpose === "chat_turn") {
          return Promise.resolve({
            replyDecision: { text: "好，我在听。" },
            worldEffects: {},
          });
        }
        return fixtureResponse(input);
      },
    );

    const first = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "legacy-world-shadow-first",
      "今天就随便聊聊。",
    );
    const second = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "legacy-world-shadow-second",
      "再聊一会儿吧。",
    );

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(
      app.personasim.store
        .listDomainEvents(harness.agentId, 500)
        .filter(
          (event) =>
            event.streamType === "world_effects" &&
            event.streamId === sessionId,
        )
        .sort(
          (left, right) =>
            Number(left.streamVersion) - Number(right.streamVersion),
        )
        .map((event) => event.streamVersion),
    ).toEqual([1, 2]);
  });
});

async function createHarness(
  turnPipelineMode: "legacy" | "shadow" | "enforced" = "enforced",
  liveWorldEffectsMode: "off" | "shadow" | "enforced" = "enforced",
  scheduleNegotiationMode: "legacy" | "shadow" | "enforced" = "enforced",
): Promise<{
  app: PersonaSimApp;
  agentId: string;
}> {
  const config = readConfig({
    nodeEnv: "test",
    profile: "turn-runtime-state-cas",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    turnPipelineMode,
    personaContextMode: "enforced",
    memoryRecallMode: "enforced",
    scheduleNegotiationMode,
    liveWorldEffectsMode,
    llm: {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
  });
  const app = await buildApp({
    config,
    database: openDatabase(":memory:"),
    clock: new FakeClock(NOW_UTC),
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
  const draft = app.personasim.characters.createDemoCharacter();
  const character = app.personasim.characters.publish(draft.id, draft.version);
  await app.personasim.schedules.ensure72Hours(character.id, true);
  return { app, agentId: character.id };
}

function observation(input: {
  worldEffects: TurnObservationProposal["worldEffects"];
}): TurnObservationProposal {
  return {
    schemaVersion: 1,
    route: "conversation",
    dialogueActs: ["inform"],
    topics: [],
    scheduleIntent: { kind: "none" },
    worldEffects: input.worldEffects,
    salientUserQuotes: [],
    uncertainty: [],
    confidence: 0.95,
  };
}

function fixtureResponse(input: GenerateObjectInput<unknown>): never {
  if (input.fixture !== undefined) return input.fixture as never;
  throw new Error(`No test response for ${input.purpose}`);
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

function requiredState(app: PersonaSimApp, agentId: string): RuntimeState {
  const state = app.personasim.store.getRuntimeState(agentId);
  if (state === undefined) throw new Error("Expected runtime state");
  return state;
}

function eventsFor(
  app: PersonaSimApp,
  agentId: string,
  clientMessageId: string,
): Array<Record<string, unknown>> {
  return app.personasim.store
    .listDomainEvents(agentId, 500)
    .filter((event) => event.correlationId === clientMessageId);
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
