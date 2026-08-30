import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase, type Database } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";

const START_UTC = "2026-09-01T01:00:00.000Z";

describe("fuzzy life runtime", () => {
  let app: PersonaSimApp | undefined;
  let database: Database | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    if (database?.open) database.close();
    app = undefined;
    database = undefined;
  });

  it("retires exact schedules and persists evidenced decision causality", async () => {
    database = openDatabase(":memory:");
    const config = readConfig({
      nodeEnv: "test",
      profile: "fuzzy-life-test",
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
    });
    app = await buildApp({
      config,
      database,
      clock: new FakeClock(START_UTC),
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });

    const generated = await app.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: {
        name: "顾澜",
        worldSetting: "当代上海",
        workOrRole: "纪录片剪辑师兼夜校讲师",
        coreTraits: ["温和", "直接", "观察细致"],
        centralContradiction: "重视稳定，也想完成自己的纪录片",
        primaryGoal: "完成第一部长片",
        relationshipToUser: "熟悉的朋友",
        dialogueStyle: "自然、具体、尊重真实感受",
        tier: "high_fidelity",
        timezone: "Asia/Shanghai",
      },
    });
    expect(generated.statusCode).toBe(201);
    const character = body<{ character: { id: string; version: number } }>(
      generated,
    ).character;

    const published = await app.inject({
      method: "POST",
      url: `/api/characters/${character.id}/publish`,
      payload: { expectedVersion: character.version },
    });
    expect(published.statusCode).toBe(200);
    expect(body<{ schedule: unknown[] }>(published).schedule).toEqual([]);
    expect(count(database, "schedule_items")).toBe(0);
    expect(count(database, "daily_life_contexts")).toBe(1);
    expect(count(database, "daily_life_intents")).toBeGreaterThan(0);

    const snapshot = await app.inject({
      method: "GET",
      url: `/api/agents/${character.id}/state`,
    });
    expect(snapshot.statusCode).toBe(200);
    expect(body<{ schedule: unknown[] }>(snapshot).schedule).toEqual([]);
    expect(
      body<{ capabilities: { schedule: boolean } }>(snapshot).capabilities
        .schedule,
    ).toBe(false);

    const schedule = await app.inject({
      method: "GET",
      url: `/api/agents/${character.id}/schedule`,
    });
    expect(schedule.statusCode).toBe(200);
    expect(
      body<{ items: unknown[]; retired: boolean }>(schedule),
    ).toMatchObject({
      items: [],
      retired: true,
    });

    const sessionResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/sessions`,
      payload: {},
    });
    const sessionId = body<{ session: { id: string } }>(sessionResponse).session
      .id;

    const delegated = await send(
      app,
      sessionId,
      character.id,
      "decision-1",
      "我要不要辞职？你直接替我做最后决定。",
    );
    expect(delegated.statusCode).toBe(201);
    expect(
      body<{ assistantMessage: { content: string } }>(delegated)
        .assistantMessage.content,
    ).toContain("我的决定：");
    expect(count(database, "decision_records")).toBe(1);
    expect(count(database, "action_records")).toBe(0);
    expect(count(database, "outcome_records")).toBe(0);

    await send(
      app,
      sessionId,
      character.id,
      "intention-only-1",
      "我已经决定辞职，但还没行动，也没有提交任何申请。",
    );
    expect(count(database, "action_records")).toBe(0);

    await send(
      app,
      sessionId,
      character.id,
      "action-1",
      "我听你的，今天已经提交了辞职申请。",
    );
    expect(count(database, "action_records")).toBe(1);
    expect(count(database, "outcome_records")).toBe(0);

    await send(
      app,
      sessionId,
      character.id,
      "action-restatement-1",
      "邮件已经发出，但对方还没有给最终反馈。现在只有行动，没有结果。",
    );
    expect(count(database, "action_records")).toBe(1);
    expect(count(database, "outcome_records")).toBe(0);

    await send(
      app,
      sessionId,
      character.id,
      "outcome-1",
      "后来公司同意了，现在我轻松多了。回头看这个选择，我很庆幸。",
    );
    expect(count(database, "outcome_records")).toBe(1);
    expect(count(database, "reflection_records")).toBe(1);
    expect(count(database, "dilemma_episodes")).toBe(1);
    expect(count(database, "relationship_milestones")).toBeGreaterThanOrEqual(
      2,
    );

    await send(
      app,
      sessionId,
      character.id,
      "pressure-1",
      "最近工作的事让我很焦虑，脑子一直很乱。",
    );
    const before = latestPressure(database);
    expect(before.currentPressure).toBe(0.72);
    await send(
      app,
      sessionId,
      character.id,
      "pressure-2",
      "跟你聊完我好多了，也清楚多了，谢谢你听我说。",
    );
    const after = latestPressure(database);
    expect(after.currentPressure).toBeLessThan(before.currentPressure);
    expect(after.currentClarity).toBeGreaterThan(before.currentClarity);
    expect(after.currentFeltUnderstood).toBeGreaterThan(
      before.currentFeltUnderstood,
    );
    expect(count(database, "pressure_episodes")).toBe(1);
  });
});

function send(
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

function count(database: Database, table: string): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as {
    count: number;
  };
  return row.count;
}

function latestPressure(database: Database): {
  currentPressure: number;
  currentClarity: number;
  currentFeltUnderstood: number;
} {
  const row = database
    .prepare(
      `SELECT current_pressure AS currentPressure,
              current_clarity AS currentClarity,
              current_felt_understood AS currentFeltUnderstood
       FROM pressure_episodes ORDER BY updated_at_utc DESC, rowid DESC LIMIT 1`,
    )
    .get();
  if (row === undefined) throw new Error("Expected a pressure episode");
  return row as {
    currentPressure: number;
    currentClarity: number;
    currentFeltUnderstood: number;
  };
}

function body<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
