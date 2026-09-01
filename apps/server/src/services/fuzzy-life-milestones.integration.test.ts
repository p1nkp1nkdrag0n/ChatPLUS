import { afterEach, describe, expect, it } from "vitest";

import type { LifeThread } from "@personasim/contracts";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase, type Database } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";

const START_UTC = "2026-09-01T01:00:00.000Z";

describe("time-based fuzzy-life milestones", () => {
  let app: PersonaSimApp | undefined;
  let database: Database | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    if (database?.open) database.close();
    app = undefined;
    database = undefined;
  });

  it("advances only by local calendar days and stays idempotent on replay or rollback", async () => {
    database = openDatabase(":memory:");
    const clock = new FakeClock(START_UTC);
    app = await buildMilestoneApp(database, clock);
    const character = await createPublishedCharacter(app);

    const initial = readThread(database);
    const milestoneIds = initial.timelinePlan!.milestones.map(
      (milestone) => milestone.id,
    );
    expect(initial).toMatchObject({
      currentStage: "确认起点",
      currentMilestoneId: milestoneIds[0],
      timelinePlan: {
        sourceGoalId: "goal-1",
        sourceCharacterVersion: 1,
        origin: "character_spec",
        timeBasis: { mode: "realtime", timezone: "Asia/Shanghai" },
      },
      startedLocalDate: "2026-09-01",
      lastAdvancedLocalDate: "2026-09-01",
      revision: 1,
      schemaVersion: 2,
    });
    expect(initial.progressNote).not.toContain("%");

    clock.advance({ days: 13 });
    app.personasim.life.advance(character.id, clock.nowUtc());
    expect(readThread(database).revision).toBe(1);

    clock.advance({ days: 1 });
    app.personasim.life.advance(character.id, clock.nowUtc());
    expect(readThread(database)).toMatchObject({
      currentStage: "形成节奏",
      currentMilestoneId: milestoneIds[1],
      revision: 2,
    });

    clock.advance({ days: 36 });
    app.personasim.life.advance(character.id, clock.nowUtc());
    const advanced = readThread(database);
    expect(advanced).toMatchObject({
      currentStage: "处理阻力",
      currentMilestoneId: milestoneIds[2],
      lastAdvancedLocalDate: "2026-10-16",
      revision: 3,
    });
    expect(eventCount(database, "life.thread_milestone_reached")).toBe(2);

    app.personasim.life.advance(character.id, clock.nowUtc());
    expect(readThread(database).revision).toBe(3);
    expect(eventCount(database, "life.thread_milestone_reached")).toBe(2);

    clock.setUtc("2026-09-21T01:00:00.000Z");
    app.personasim.life.ensureToday(character.id, clock.nowUtc());
    expect(readThread(database)).toMatchObject({
      currentStage: "处理阻力",
      currentMilestoneId: milestoneIds[2],
      revision: 3,
    });
    expect(eventCount(database, "life.thread_milestone_reached")).toBe(2);
    expect(tableCount(database, "decision_records")).toBe(0);
    expect(tableCount(database, "relationship_milestones")).toBe(0);
    expect(tableCount(database, "pressure_episodes")).toBe(0);
  });

  it("upgrades a legacy thread atomically with continuous event versions", async () => {
    database = openDatabase(":memory:");
    const clock = new FakeClock(START_UTC);
    app = await buildMilestoneApp(database, clock);
    const character = await createPublishedCharacter(app);
    const initial = readThread(database);
    const legacy = { ...initial } as Record<string, unknown>;
    delete legacy["timelinePlan"];
    delete legacy["currentMilestoneId"];
    legacy["currentStage"] = "持续推进中";
    legacy["progressNote"] = "旧版本线程";
    legacy["nextStepHint"] = "继续推进";
    legacy["revision"] = 1;
    legacy["schemaVersion"] = 1;
    database
      .prepare(
        `UPDATE life_threads
         SET current_stage = ?, progress_note = ?, next_step_hint = ?,
             revision = 1, schema_version = 1, thread_json = ?
         WHERE id = ?`,
      )
      .run(
        legacy["currentStage"],
        legacy["progressNote"],
        legacy["nextStepHint"],
        JSON.stringify(legacy),
        initial.id,
      );

    clock.advance({ days: 50 });
    app.personasim.life.ensureToday(character.id, clock.nowUtc());

    const upgraded = readThread(database);
    expect(upgraded).toMatchObject({
      revision: 4,
      schemaVersion: 2,
      currentStage: "处理阻力",
    });
    expect(upgraded.timelinePlan?.planSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(lifeThreadEventVersions(database, initial.id).slice(-3)).toEqual([
      2, 3, 4,
    ]);
    expect(eventCount(database, "life.thread_timeline_attached")).toBe(1);
    expect(eventCount(database, "life.thread_milestone_reached")).toBe(2);

    app.personasim.life.ensureToday(character.id, clock.nowUtc());
    expect(readThread(database).revision).toBe(4);
    expect(lifeThreadEventVersions(database, initial.id).slice(-3)).toEqual([
      2, 3, 4,
    ]);
  });

  it("keeps an existing thread on its frozen plan after the goal leaves the head", async () => {
    database = openDatabase(":memory:");
    const clock = new FakeClock(START_UTC);
    app = await buildMilestoneApp(database, clock);
    const character = await createPublishedCharacter(app);
    const originalThread = readThread(database);
    const originalPlanHash = originalThread.timelinePlan!.planSha256;
    const head = app.personasim.store.getCharacterSpec(character.id)!;
    const draft = structuredClone(head);
    for (const key of [
      "id",
      "version",
      "status",
      "createdAtUtc",
      "updatedAtUtc",
    ] as const) {
      Reflect.deleteProperty(draft, key);
    }
    draft.persona = {
      ...draft.persona,
      goals: [
        {
          ...draft.persona.goals[0]!,
          id: "replacement-goal",
          title: "整理一套新的课程",
          description: "为夜校整理新的剪辑课程。",
        },
      ],
    };
    const updated = app.personasim.characters.updateDraft(character.id, {
      spec: draft,
      expectedVersion: head.version,
    });
    app.personasim.characters.publish(character.id, updated.version);

    clock.advance({ days: 50 });
    app.personasim.life.ensureToday(character.id, clock.nowUtc());

    const advancedOriginal = readThreadById(database, originalThread.id);
    expect(advancedOriginal).toMatchObject({
      currentStage: "处理阻力",
      revision: 3,
      timelinePlan: {
        sourceGoalId: "goal-1",
        sourceCharacterVersion: 1,
        planSha256: originalPlanHash,
        timeBasis: { timezone: "Asia/Shanghai" },
      },
    });
  });

  it("rejects an implicit story-clock rebase after life simulation starts", async () => {
    database = openDatabase(":memory:");
    const clock = new FakeClock(START_UTC);
    app = await buildMilestoneApp(database, clock);
    const character = await createPublishedCharacter(app);
    const head = app.personasim.store.getCharacterSpec(character.id)!;
    const draft = structuredClone(head);
    for (const key of [
      "id",
      "version",
      "status",
      "createdAtUtc",
      "updatedAtUtc",
    ] as const) {
      Reflect.deleteProperty(draft, key);
    }
    draft.identity = { ...draft.identity, timezone: "Pacific/Honolulu" };

    expect(() =>
      app!.personasim.characters.updateDraft(character.id, {
        spec: draft,
        expectedVersion: head.version,
      }),
    ).toThrow(/story-time anchors cannot be changed/u);
  });
});

async function buildMilestoneApp(
  database: Database,
  clock: FakeClock,
): Promise<PersonaSimApp> {
  return buildApp({
    config: readConfig({
      nodeEnv: "test",
      profile: "milestone-test",
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
    database,
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
}

async function createPublishedCharacter(app: PersonaSimApp): Promise<{
  id: string;
  version: number;
}> {
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "顾澜",
      worldSetting: "当代上海",
      workOrRole: "纪录片剪辑师",
      coreTraits: ["温和", "直接", "观察细致"],
      centralContradiction: "重视稳定，也想完成自己的纪录片",
      primaryGoal: "完成第一部长片",
      relationshipToUser: "熟悉的朋友",
      dialogueStyle: "自然、具体、尊重真实感受",
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    },
  });
  const character = body<{ character: { id: string; version: number } }>(
    generated,
  ).character;
  await app.inject({
    method: "POST",
    url: `/api/characters/${character.id}/publish`,
    payload: { expectedVersion: character.version },
  });
  return character;
}

function readThread(database: Database): LifeThread {
  const row = database
    .prepare("SELECT thread_json FROM life_threads ORDER BY rowid LIMIT 1")
    .get() as { thread_json: string };
  return JSON.parse(row.thread_json) as LifeThread;
}

function readThreadById(database: Database, id: string): LifeThread {
  const row = database
    .prepare("SELECT thread_json FROM life_threads WHERE id = ?")
    .get(id) as { thread_json: string };
  return JSON.parse(row.thread_json) as LifeThread;
}

function eventCount(database: Database, eventType: string): number {
  const row = database
    .prepare("SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ?")
    .get(eventType) as { count: number };
  return row.count;
}

function lifeThreadEventVersions(database: Database, threadId: string) {
  return (
    database
      .prepare(
        `SELECT stream_version FROM domain_events
         WHERE stream_type = 'life_thread' AND stream_id = ?
         ORDER BY stream_version`,
      )
      .all(threadId) as Array<{ stream_version: number }>
  ).map((row) => row.stream_version);
}

function tableCount(database: Database, table: string): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as { count: number };
  return row.count;
}

function body<T>(response: { json(): unknown }): T {
  return response.json() as T;
}
