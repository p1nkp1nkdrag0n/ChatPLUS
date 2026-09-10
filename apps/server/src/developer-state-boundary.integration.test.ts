import type { ServerResponse } from "node:http";
import {
  PublicAgentSnapshotSchema,
  PublicListMessagesResponseSchema,
  PublicPublishCharacterResponseSchema,
  PublicSendMessageResponseSchema,
  PublicServerSentEventSchema,
  PublicTimelineResponseSchema,
  PublicRelationshipArchivePageResponseSchema,
} from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { FakeClock } from "./runtime/clock.js";

const NOW = "2026-09-10T02:00:00.000Z";
const PRIVATE = "private-runtime-diagnostic";

describe("developer-only character state boundary", () => {
  let app: PersonaSimApp | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
    vi.unstubAllEnvs();
  });

  it("requires an explicit server flag rather than development NODE_ENV or a browser setting", async () => {
    vi.stubEnv("DEVELOPER_MODE", undefined);
    vi.stubEnv("NODE_ENV", "development");
    expect(readConfig().developerRoutes).toBe(false);
    vi.stubEnv("DEVELOPER_MODE", "true");
    expect(readConfig().developerRoutes).toBe(true);
    vi.stubEnv("DEVELOPER_MODE", "false");
    expect(readConfig().developerRoutes).toBe(false);
    app = await fixtureApp(false);
    const response = await app.inject({
      method: "PATCH",
      url: "/api/settings",
      payload: { developerMode: true },
    });
    expect(response.statusCode).toBe(400);
    const settings = (
      await app.inject({ method: "GET", url: "/api/settings" })
    ).json<{ runtime: { developerMode: boolean } }>();
    expect(settings.runtime.developerMode).toBe(false);
    expect(
      (await app.inject({ method: "GET", url: "/api/developer/status" }))
        .statusCode,
    ).toBe(404);
  });

  it.each([false, true])(
    "projects public HTTP and SSE identically with developer mode %s",
    async (developerMode) => {
      app = await fixtureApp(developerMode);
      const generated = await app.inject({
        method: "POST",
        url: "/api/characters/generate",
        payload: {
          name: "林夏",
          worldSetting: "当代城市生活",
          workOrRole: "插画师",
          coreTraits: ["温暖", "独立"],
          centralContradiction: "想靠近又怕打扰",
          primaryGoal: "完成画册",
          relationshipToUser: "刚认识",
          dialogueStyle: "自然简洁",
          tier: "high_fidelity",
          timezone: "Asia/Shanghai",
        },
      });
      expect(generated.statusCode, generated.body).toBe(201);
      const character = generated.json<{
        character: { id: string; version: number };
      }>().character;
      const agentId = character.id;
      const published = await app.inject({
        method: "POST",
        url: `/api/characters/${agentId}/publish`,
        payload: { expectedVersion: character.version },
      });
      expect(published.statusCode).toBe(200);
      PublicPublishCharacterResponseSchema.parse(published.json());

      const activation = await app.inject({
        method: "POST",
        url: `/api/agents/${agentId}/activate`,
      });
      expect(activation.statusCode).toBe(200);
      PublicAgentSnapshotSchema.parse(activation.json());
      assertNoPrivateState(activation.json());
      const overview = await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/overview`,
      });
      PublicAgentSnapshotSchema.parse(overview.json());
      assertNoPrivateState(overview.json());

      const session = app.personasim.conversations.createSession(agentId);
      const input = {
        agentId,
        clientMessageId: "boundary-message-1",
        text: "今天过得怎么样？",
      };
      const sentResponse = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/messages`,
        payload: input,
      });
      expect(sentResponse.statusCode).toBe(201);
      const sent = PublicSendMessageResponseSchema.parse(sentResponse.json());
      expect(sent.assistantMessage.content.length).toBeGreaterThan(0);
      assertNoPrivateState(sent);
      const stored = app.personasim.store
        .listMessages(session.id)
        .find((message) => message.id === sent.assistantMessage.id)!;
      expect(stored.metadata).toHaveProperty("decisionPath");
      app.personasim.store.database
        .prepare("UPDATE messages SET metadata_json = ? WHERE id = ?")
        .run(
          JSON.stringify({
            ...stored.metadata,
            companionContext: { state: PRIVATE },
            personaRuntime: PRIVATE,
            memoryRecall: { score: 0.9 },
            chunks: [stored.content],
            deliveryMode: "single_block",
          }),
          stored.id,
        );
      const replay = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/messages`,
        payload: input,
      });
      expect(replay.statusCode).toBe(200);
      expect(
        PublicSendMessageResponseSchema.parse(replay.json()).idempotentReplay,
      ).toBe(true);
      assertNoPrivateState(replay.json());
      const history = await app.inject({
        method: "GET",
        url: `/api/sessions/${session.id}/messages`,
      });
      PublicListMessagesResponseSchema.parse(history.json());
      assertNoPrivateState(history.json());
      expect(history.body).not.toContain(PRIVATE);
      const alternate = await app.inject({
        method: "POST",
        url: `/api/agents/${agentId}/messages`,
        payload: {
          clientMessageId: "boundary-message-2",
          text: "我们慢慢聊。",
        },
      });
      expect(alternate.statusCode).toBe(201);
      PublicSendMessageResponseSchema.parse(alternate.json());
      assertNoPrivateState(alternate.json());

      const timeline = await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/timeline`,
      });
      const journal = PublicTimelineResponseSchema.parse(timeline.json());
      expect(
        journal.events.some(
          (event) => event.type === "conversation.turn_committed",
        ),
      ).toBe(true);
      assertNoPrivateState(journal);
      for (const route of ["state", "memories", "schedule"]) {
        const response = await app.inject({
          method: "GET",
          url: `/api/agents/${agentId}/${route}`,
        });
        expect(response.statusCode).toBe(developerMode ? 200 : 404);
      }
      const developer = await app.inject({
        method: "GET",
        url: `/api/developer/agents/${agentId}/snapshot`,
      });
      expect(developer.statusCode).toBe(developerMode ? 200 : 404);
      if (developerMode) {
        expect(
          developer.json<{
            overview: { state: { relationship: Record<string, unknown> } };
          }>().overview.state.relationship,
        ).toHaveProperty("closeness");
        expect(developer.body).toContain(PRIVATE);
        expect(developer.headers["cache-control"]).toBe("no-store");
      }

      for (const [index, text] of [
        "我要不要辞职？你直接替我做最后决定。",
        "我听你的，今天已经提交了辞职申请。",
        "后来公司同意了，现在我轻松多了。回头看这个选择，我很庆幸。",
      ].entries()) {
        await app.personasim.conversations.chat(session.id, {
          agentId,
          clientMessageId: `archive-evidence-${index}`,
          text,
        });
      }
      const internalArchive =
        app.personasim.relationshipArchive.listPage(agentId);
      expect(
        internalArchive.items.some(
          (item) =>
            item.entryType === "turning_point" &&
            item.sourceType === "reflection",
        ),
      ).toBe(true);
      expect(internalArchive.items.some((item) => "significance" in item)).toBe(
        true,
      );
      app.personasim.store.insertDomainEvent({
        agentId,
        streamType: "life",
        streamId: "private-archive-stream",
        streamVersion: 1,
        eventType: "life.pressure_updated",
        recordedAtUtc: NOW,
        effectiveAtUtc: NOW,
        payload: { summary: PRIVATE },
        idempotencyKey: "private-archive-event",
      });
      const archiveResponse = await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/relationship-archive?limit=100`,
      });
      expect(archiveResponse.statusCode, archiveResponse.body).toBe(200);
      const archive = PublicRelationshipArchivePageResponseSchema.parse(
        archiveResponse.json(),
      );
      expect(
        archive.items.some((item) => item.entryType === "turning_point"),
      ).toBe(true);
      expect(archiveResponse.body).not.toContain("reflection");
      expect(archiveResponse.body).not.toContain("significance");
      expect(archiveResponse.body).not.toContain("pressure_updated");
      const hiddenReflection = internalArchive.items.find(
        (item) =>
          item.entryType === "turning_point" &&
          item.sourceType === "reflection",
      )!;
      const hiddenEntry = await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/relationship-archive?entryId=reflection:${hiddenReflection.id}`,
      });
      expect(hiddenEntry.json<{ items: unknown[] }>().items).toEqual([]);
      const recap = await app.inject({
        method: "GET",
        url: `/api/agents/${agentId}/relationship-recap?fromUtc=2026-09-01T00:00:00.000Z&toUtc=2026-09-11T00:00:00.000Z&limit=40`,
      });
      expect(recap.statusCode, recap.body).toBe(200);
      expect(recap.body).not.toContain("reflection");
      expect(recap.body).not.toContain("pressure_updated");

      const chunks: string[] = [];
      const response = {
        destroyed: false,
        writableEnded: false,
        write: (chunk: string) => {
          chunks.push(chunk);
          return true;
        },
        end: () => undefined,
      } as unknown as ServerResponse;
      const unsubscribe = app.personasim.sse.subscribe(agentId, response);
      try {
        for (const type of [
          "state.updated",
          "settlement.completed",
          "schedule.updated",
          "message.created",
          "letter.arrived",
        ]) {
          app.personasim.sse.publish({
            type,
            agentId,
            occurredAtUtc: NOW,
            data: {
              id: stored.id,
              letterId: "letter-public",
              sessionId: session.id,
              state: app.personasim.store.getRuntimeState(agentId),
              lifeContext: PRIVATE,
              metadata: { companionContext: PRIVATE },
              score: 0.9,
            },
          });
        }
        expect(chunks.join("")).not.toContain(PRIVATE);
        for (const chunk of chunks.slice(1)) {
          const line = chunk
            .split("\n")
            .find((candidate) => candidate.startsWith("data: "))!;
          const event = PublicServerSentEventSchema.parse(
            JSON.parse(line.slice(6)),
          );
          assertNoPrivateState(event);
          expect(event.data["letterId"]).toBe("letter-public");
        }
      } finally {
        unsubscribe();
      }
    },
  );

  it("filters private timeline events in SQL before limiting public history", async () => {
    app = await fixtureApp(true);
    const character = app.personasim.characters.createDemoCharacter();
    app.personasim.characters.publish(character.id);
    app.personasim.store.insertDomainEvent({
      agentId: character.id,
      streamType: "life",
      streamId: "visible-history",
      streamVersion: 1,
      eventType: "life.support_recorded",
      recordedAtUtc: "2026-09-10T02:01:00.000Z",
      payload: { summary: "一次实际发生的陪伴" },
      idempotencyKey: "visible-history",
    });
    app.personasim.store.transaction(() => {
      // More than the maximum request limit ensures that merely reading a
      // larger recent window cannot substitute for filtering before LIMIT.
      for (let index = 0; index < 550; index += 1) {
        app!.personasim.store.insertDomainEvent({
          agentId: character.id,
          streamType: "life",
          streamId: "private-history",
          streamVersion: index + 1,
          eventType: "life.pressure_updated",
          recordedAtUtc: "2026-09-10T02:02:00.000Z",
          payload: { summary: PRIVATE, pressure: 0.8 },
          idempotencyKey: `private-history-${index}`,
        });
      }
    });
    for (const limit of [2, 100]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/agents/${character.id}/timeline?limit=${limit}`,
      });
      expect(response.statusCode, response.body).toBe(200);
      const publicTimeline = PublicTimelineResponseSchema.parse(
        response.json(),
      );
      expect(publicTimeline.events).toHaveLength(Math.min(limit, 3));
      expect(publicTimeline.events[0]?.type).toBe("life.support_recorded");
      expect(response.body).not.toContain(PRIVATE);
      expect(response.body).not.toContain("life.pressure_updated");
      assertNoPrivateState(publicTimeline);
    }
    const developer = await app.inject({
      method: "GET",
      url: `/api/developer/agents/${character.id}/timeline?limit=2`,
    });
    expect(developer.statusCode, developer.body).toBe(200);
    const internal = developer.json<{ events: Array<{ type: string }> }>();
    expect(internal.events.map((event) => event.type)).toEqual([
      "life.pressure_updated",
      "life.pressure_updated",
    ]);
    expect(developer.body).toContain(PRIVATE);
  });
});

function assertNoPrivateState(value: unknown): void {
  const forbidden = new Set([
    "state",
    "stateDelta",
    "lifeContext",
    "cursor",
    "schedule",
    "scheduleChanges",
    "scheduleItems",
    "domainEvents",
    "activityEvents",
    "decision",
    "memoryRecall",
    "companionContext",
    "personaRuntime",
    "closeness",
    "trust",
    "familiarity",
    "energy",
    "moodValence",
    "currentStage",
    "score",
  ]);
  if (Array.isArray(value)) {
    value.forEach(assertNoPrivateState);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    // This is only a static capability flag, never a schedule payload.
    if (key === "schedule" && typeof child === "boolean") continue;
    expect(forbidden.has(key), `public payload must not contain ${key}`).toBe(
      false,
    );
    assertNoPrivateState(child);
  }
}

function fixtureApp(developerRoutes: boolean): Promise<PersonaSimApp> {
  return buildApp({
    config: readConfig({
      nodeEnv: "test",
      databasePath: ":memory:",
      seedDemo: false,
      developerRoutes,
      clockMode: "fake",
      lifePlanningMode: "fuzzy",
      llm: {
        provider: "fixture",
        baseUrl: "https://example.invalid",
        model: "personasim-fixture-v1",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
    }),
    clock: new FakeClock(NOW),
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
}
