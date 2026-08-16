import type { ServerResponse } from "node:http";

import {
  ActivateAgentResponseSchema,
  CharacterMutationResponseSchema,
  CreateSessionResponseSchema,
  GetSettingsResponseSchema,
  HealthResponseSchema,
  ListCharactersResponseSchema,
  ListMessagesResponseSchema,
  ListSessionsResponseSchema,
  MemoriesResponseSchema,
  PublishCharacterResponseSchema,
  SendMessageResponseSchema,
  ServerSentEventSchema,
  TimelineResponseSchema,
  UpdateSettingsResponseSchema,
  type ServerSentEvent,
} from "@personasim/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { FakeClock } from "./runtime/clock.js";

const START_UTC = "2026-08-16T02:00:00.000Z";

describe("shared API transport contracts", () => {
  let app: PersonaSimApp;
  let clock: FakeClock;

  beforeEach(async () => {
    clock = new FakeClock(START_UTC);
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "api-contract-test",
        databasePath: ":memory:",
        clockMode: "fake",
        seedDemo: false,
        developerRoutes: true,
        scheduleNegotiationMode: "legacy",
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      database: openDatabase(":memory:"),
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("parses every core route response returned by Fastify inject", async () => {
    parseResponse(
      await app.inject({ method: "GET", url: "/api/health" }),
      200,
      HealthResponseSchema,
    );

    const { agentId, published } = await createPublishedAgent(app);

    const listed = parseResponse(
      await app.inject({ method: "GET", url: "/api/characters" }),
      200,
      ListCharactersResponseSchema,
    );
    expect(listed.characters).toEqual(listed.items);
    expect(listed.items.some((character) => character.id === agentId)).toBe(
      true,
    );

    expect(published.character.id).toBe(agentId);
    expect(published.schedule.length).toBeGreaterThan(0);

    const activated = parseResponse(
      await app.inject({
        method: "POST",
        url: `/api/agents/${agentId}/activate`,
      }),
      200,
      ActivateAgentResponseSchema,
    );
    expect(activated.agentId).toBe(agentId);

    const createdSession = parseResponse(
      await app.inject({
        method: "POST",
        url: `/api/agents/${agentId}/sessions`,
        payload: { title: "契约测试会话" },
      }),
      201,
      CreateSessionResponseSchema,
    );
    const sessionId = createdSession.session.id;

    const sessions = parseResponse(
      await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/sessions`,
      }),
      200,
      ListSessionsResponseSchema,
    );
    expect(sessions.sessions.map((session) => session.id)).toContain(sessionId);

    const emptyMessages = parseResponse(
      await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/messages`,
      }),
      200,
      ListMessagesResponseSchema,
    );
    expect(emptyMessages.messages).toEqual([]);

    const sent = parseResponse(
      await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/messages`,
        payload: {
          agentId,
          clientMessageId: "api-contract-message-1",
          text: "今晚和我一起去参加晚会吧，我们可以把自习调整到之后。",
        },
      }),
      201,
      SendMessageResponseSchema,
    );
    expect(sent.assistantMessage.agentId).toBe(agentId);

    const messages = parseResponse(
      await app.inject({
        method: "GET",
        url: `/api/sessions/${sessionId}/messages?limit=100`,
      }),
      200,
      ListMessagesResponseSchema,
    );
    expect(messages.messages).toHaveLength(2);

    parseResponse(
      await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/timeline?limit=100`,
      }),
      200,
      TimelineResponseSchema,
    );

    const memories = parseResponse(
      await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/memories`,
      }),
      200,
      MemoriesResponseSchema,
    );
    expect(memories.memories.length).toBeGreaterThan(0);

    parseResponse(
      await app.inject({ method: "GET", url: "/api/settings" }),
      200,
      GetSettingsResponseSchema,
    );
    const updatedSettings = parseResponse(
      await app.inject({
        method: "PATCH",
        url: "/api/settings",
        payload: { locale: "zh-CN", compactTimeline: true },
      }),
      200,
      UpdateSettingsResponseSchema,
    );
    expect(updatedSettings.settings).toMatchObject({
      locale: "zh-CN",
      compactTimeline: true,
    });
    parseResponse(
      await app.inject({ method: "GET", url: "/api/settings" }),
      200,
      GetSettingsResponseSchema,
    );
  });

  it("parses every production SSE event variant emitted by real services", async () => {
    const { agentId } = await createPublishedAgent(app);
    const session = parseResponse(
      await app.inject({
        method: "POST",
        url: `/api/agents/${agentId}/sessions`,
        payload: {},
      }),
      201,
      CreateSessionResponseSchema,
    ).session;

    const chunks: string[] = [];
    const response = createSseResponse(chunks);
    const unsubscribe = app.personasim.sse.subscribe(agentId, response);

    try {
      parseResponse(
        await app.inject({
          method: "POST",
          url: `/api/sessions/${session.id}/messages`,
          payload: {
            agentId,
            clientMessageId: "api-contract-sse-message-1",
            text: "今晚和我一起去参加晚会吧，我们把自习挪到之后。",
          },
        }),
        201,
        SendMessageResponseSchema,
      );

      clock.advance({ hours: 24 });
      const activation = parseResponse(
        await app.inject({
          method: "POST",
          url: `/api/agents/${agentId}/activate`,
        }),
        200,
        ActivateAgentResponseSchema,
      );
      expect(activation.settlement?.activityEvents.length).toBeGreaterThan(0);

      const events = parseSseEvents(chunks);
      expect(new Set(events.map((event) => event.type))).toEqual(
        new Set([
          "message.created",
          "schedule.updated",
          "state.updated",
          "settlement.completed",
          "activity.created",
        ]),
      );
    } finally {
      unsubscribe();
    }
  });
});

type InjectResponse = {
  statusCode: number;
  body: string;
};

function parseResponse<T>(
  response: InjectResponse,
  expectedStatus: number,
  schema: ZodType<T>,
): T {
  expect(response.statusCode).toBe(expectedStatus);
  const body: unknown = JSON.parse(response.body);
  return schema.parse(body);
}

async function createPublishedAgent(app: PersonaSimApp): Promise<{
  agentId: string;
  published: ReturnType<typeof PublishCharacterResponseSchema.parse>;
}> {
  const generated = parseResponse(
    await app.inject({
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
    }),
    201,
    CharacterMutationResponseSchema,
  );
  const published = parseResponse(
    await app.inject({
      method: "POST",
      url: `/api/characters/${generated.character.id}/publish`,
      payload: { expectedVersion: generated.character.version },
    }),
    200,
    PublishCharacterResponseSchema,
  );
  return { agentId: published.character.id, published };
}

function createSseResponse(chunks: string[]): ServerResponse {
  const response = {
    destroyed: false,
    writableEnded: false,
    write(chunk: string | Uint8Array): boolean {
      chunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
      );
      return true;
    },
    end(): void {
      this.writableEnded = true;
    },
  };
  return response as unknown as ServerResponse;
}

function parseSseEvents(chunks: string[]): ServerSentEvent[] {
  const events: ServerSentEvent[] = [];
  for (const frame of chunks.flatMap((chunk) => chunk.split("\n\n"))) {
    const dataLine = frame
      .split("\n")
      .find((line) => line.startsWith("data: "));
    if (dataLine === undefined) continue;
    const candidate: unknown = JSON.parse(dataLine.slice("data: ".length));
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("type" in candidate)
    ) {
      continue;
    }
    events.push(ServerSentEventSchema.parse(candidate));
  }
  return events;
}
