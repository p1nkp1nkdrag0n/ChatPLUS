import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { FakeClock } from "./runtime/clock.js";

const START_UTC = "2026-09-01T01:00:00.000Z";

describe("fuzzy life runtime routing", () => {
  let app: PersonaSimApp;

  beforeEach(async () => {
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "fuzzy-life-runtime-test",
        databasePath: ":memory:",
        clockMode: "fake",
        seedDemo: false,
        developerRoutes: true,
        lifePlanningMode: "fuzzy",
        scheduleNegotiationMode: "legacy",
        selfInitiatedPlanningMode: "off",
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      database: openDatabase(":memory:"),
      clock: new FakeClock(START_UTC),
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it("publishes and activates fuzzy life without creating exact schedule rows", async () => {
    const draft = app.personasim.characters.createDemoCharacter();
    expect(draft.schedulePolicy.enabled).toBe(false);
    const published = await app.inject({
      method: "POST",
      url: `/api/characters/${draft.id}/publish`,
    });

    expect(published.statusCode).toBe(200);
    const publishedBody = published.json<{
      character: { schedulePolicy: { enabled: boolean } };
      schedule: unknown[];
      lifeContext: { authority: string };
    }>();
    expect(publishedBody.character.schedulePolicy.enabled).toBe(false);
    expect(publishedBody.schedule).toEqual([]);
    expect(publishedBody.lifeContext.authority).toBe(
      "server_persisted_fuzzy_life",
    );
    expect(app.personasim.store.listSchedule(draft.id)).toEqual([]);
    expect(
      app.personasim.store.database
        .prepare(
          "SELECT COUNT(*) AS count FROM daily_life_contexts WHERE agent_id = ?",
        )
        .get(draft.id),
    ).toEqual({ count: 1 });

    const activated = await app.inject({
      method: "POST",
      url: `/api/agents/${draft.id}/activate`,
    });
    expect(activated.statusCode).toBe(200);
    const snapshot = activated.json<{
      capabilities: {
        fuzzyLife: boolean;
        legacyExactSchedule: boolean;
        schedule: boolean;
      };
      schedule: unknown[];
      currentActivity?: unknown;
      lifeContext: { semantics: { characterTimePrecision: string } };
    }>();
    expect(snapshot.capabilities).toMatchObject({
      fuzzyLife: true,
      legacyExactSchedule: false,
      schedule: false,
    });
    expect(snapshot.schedule).toEqual([]);
    expect(snapshot.currentActivity).toBeUndefined();
    expect(snapshot.lifeContext.semantics.characterTimePrecision).toBe(
      "day_or_period",
    );

    const schedule = await app.inject({
      method: "GET",
      url: `/api/agents/${draft.id}/schedule`,
    });
    expect(schedule.statusCode).toBe(200);
    expect(schedule.json()).toMatchObject({
      dataModel: "fuzzy_life",
      items: [],
      retired: true,
      replacement: "fuzzy_life_context",
      lifeContext: { authority: "server_persisted_fuzzy_life" },
    });

    const rejectedEffect = await app.inject({
      method: "POST",
      url: `/api/agents/${draft.id}/schedule/effects`,
      payload: { effects: [] },
    });
    expect(rejectedEffect.statusCode).toBe(410);
    expect(rejectedEffect.json()).toMatchObject({
      error: { code: "exact_schedule_retired" },
    });
  });

  it("seeds the demo into a daily fuzzy context rather than a 72-hour plan", async () => {
    await app.close();
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "fuzzy-life-seed-test",
        databasePath: ":memory:",
        clockMode: "fake",
        seedDemo: true,
        developerRoutes: true,
        lifePlanningMode: "fuzzy",
        scheduleNegotiationMode: "legacy",
        selfInitiatedPlanningMode: "off",
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      database: openDatabase(":memory:"),
      clock: new FakeClock(START_UTC),
      seedDemo: true,
      startScheduler: false,
      logger: false,
    });

    expect(app.personasim.store.countCharacters()).toBe(1);
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM schedule_items")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM daily_life_contexts")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("refuses to settle migrated exact rows inside a fuzzy runtime", async () => {
    const draft = app.personasim.characters.createDemoCharacter();
    const publishedResponse = await app.inject({
      method: "POST",
      url: `/api/characters/${draft.id}/publish`,
    });
    expect(publishedResponse.statusCode).toBe(200);

    const store = app.personasim.store;
    const published = store.getCharacterSpec(draft.id);
    if (published === undefined) throw new Error("Missing published character");
    const migrated = {
      ...published,
      schedulePolicy: { ...published.schedulePolicy, enabled: true },
    };
    // Simulate data written by an older exact-schedule build. The runtime
    // mode, rather than a stale persisted flag, must be authoritative.
    store.replaceVersion(migrated);
    store.updateCharacterHead(migrated);
    store.insertScheduleItem({
      id: "migrated-planned-schedule",
      agentId: draft.id,
      title: "旧版待结算安排",
      description: "迁移前遗留的精确时间行。",
      category: "work",
      startAtUtc: "2026-09-01T02:00:00.000Z",
      endAtUtc: "2026-09-01T03:00:00.000Z",
      timezone: "Asia/Shanghai",
      status: "planned",
      rigidity: "committed",
      priority: 0.8,
      source: "initial_plan",
      adherenceProbability: 1,
      narrativeImportance: 0.8,
      shareable: true,
      stateEffects: { energy: -0.1 },
      revision: 0,
      createdAtUtc: START_UTC,
      updatedAtUtc: START_UTC,
    });

    const result = await app.personasim.settlements.settle(draft.id, {
      toUtc: "2026-09-01T04:00:00.000Z",
    });

    expect(result.alreadySettled).toBe(true);
    expect(result.activityEvents).toEqual([]);
    expect(result.updatedScheduleItems).toEqual([]);
    expect(store.getScheduleItem("migrated-planned-schedule")?.status).toBe(
      "planned",
    );
    expect(store.listActivityEvents(draft.id)).toEqual([]);
  });

  it("keeps migrated exact schedules and their lineage out of the fuzzy timeline", async () => {
    const draft = app.personasim.characters.createDemoCharacter();
    const published = await app.inject({
      method: "POST",
      url: `/api/characters/${draft.id}/publish`,
    });
    expect(published.statusCode).toBe(200);

    const store = app.personasim.store;
    const legacyScheduleId = "legacy-schedule-hidden";
    const exactTitle = "周六 20:00 的精确旧日程";
    store.insertScheduleItem({
      id: legacyScheduleId,
      agentId: draft.id,
      title: exactTitle,
      description: "迁移前数据库中遗留的精确时间安排。",
      category: "social",
      startAtUtc: "2026-09-01T12:00:00.000Z",
      endAtUtc: "2026-09-01T13:00:00.000Z",
      timezone: "Asia/Shanghai",
      status: "completed",
      rigidity: "committed",
      priority: 0.8,
      source: "user_invitation",
      adherenceProbability: 1,
      narrativeImportance: 0.8,
      shareable: true,
      stateEffects: {},
      revision: 1,
      createdAtUtc: START_UTC,
      updatedAtUtc: START_UTC,
    });
    store.insertActivityEvent({
      id: "real-activity-from-legacy-schedule",
      agentId: draft.id,
      scheduleItemId: legacyScheduleId,
      eventType: "completed",
      occurredAtUtc: "2026-09-01T13:00:00.000Z",
      summary: `${exactTitle}已经真实发生，双方都轻松了一些。`,
      outcomeFacts: [`完成了${exactTitle}`],
      stateDelta: {},
      origin: "deterministic",
      effectTrace: { exactTitle, scheduleItemId: legacyScheduleId },
      idempotencyKey: "legacy-activity-once",
    });
    expect(
      store.insertDomainEvent({
        agentId: draft.id,
        streamType: "schedule",
        streamId: legacyScheduleId,
        streamVersion: 1,
        eventType: "schedule.command_committed",
        recordedAtUtc: START_UTC,
        payload: { scheduleItemId: legacyScheduleId, summary: exactTitle },
        idempotencyKey: "legacy-schedule-domain-once",
      }),
    ).toBe(true);
    expect(
      store.insertDomainEvent({
        agentId: draft.id,
        streamType: "life",
        streamId: "decision-1",
        streamVersion: 1,
        eventType: "life.delegated_decision_recorded",
        recordedAtUtc: "2026-09-01T14:00:00.000Z",
        payload: { summary: "角色和用户共同作出了一个生活选择。" },
        idempotencyKey: "life-decision-domain-once",
      }),
    ).toBe(true);

    const listSchedule = vi.spyOn(store, "listSchedule");

    const timelineResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${draft.id}/timeline?limit=100`,
    });
    expect(timelineResponse.statusCode).toBe(200);
    expect(listSchedule).not.toHaveBeenCalled();
    const timeline = timelineResponse.json<{
      events: Array<Record<string, unknown>>;
      activityEvents: Array<Record<string, unknown>>;
      scheduleItems: unknown[];
      domainEvents: Array<{ eventType: string }>;
    }>();

    expect(timeline.scheduleItems).toEqual([]);
    expect(timeline.domainEvents.map((event) => event.eventType)).not.toContain(
      "schedule.command_committed",
    );
    expect(timeline.domainEvents.map((event) => event.eventType)).toContain(
      "life.delegated_decision_recorded",
    );
    expect(
      timeline.activityEvents.find(
        (event) => event["id"] === "real-activity-from-legacy-schedule",
      ),
    ).not.toHaveProperty("scheduleItemId");
    const actualActivity = timeline.events.find(
      (event) => event["id"] === "real-activity-from-legacy-schedule",
    );
    expect(actualActivity).toMatchObject({
      summary: "一项生活活动已经真实完成。",
      activityEventId: "real-activity-from-legacy-schedule",
      provenance: "life_simulation",
    });
    expect(actualActivity).not.toHaveProperty("title");
    expect(actualActivity).not.toHaveProperty("scheduleItemId");
    expect(actualActivity).not.toHaveProperty("source");
    expect(JSON.stringify(timeline)).not.toContain(exactTitle);
  });
});
