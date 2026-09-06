import {
  LifeThreadSchema,
  type CharacterSpec,
  type LifeOutcome,
  type LifeThread,
} from "@personasim/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase, type Database } from "../db/connection.js";
import { LifeRepository } from "../repositories/life-repository.js";
import { FakeClock } from "../runtime/clock.js";
import { projectGoalThreadOutcome } from "./fuzzy-life-planning.js";

const START = "2026-09-01T01:00:00.000Z";

describe("evidence-driven character life threads", () => {
  let app: PersonaSimApp | undefined;
  let database: Database;
  let clock: FakeClock;
  let repository: LifeRepository;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function setup(): Promise<CharacterSpec> {
    database = openDatabase(":memory:");
    clock = new FakeClock(START);
    repository = new LifeRepository(database);
    app = await buildApp({
      database,
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
      config: readConfig({
        nodeEnv: "test",
        profile: "life-v2",
        databasePath: ":memory:",
        clockMode: "fake",
        seedDemo: false,
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
    });
    const generated = await app.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: {
        name: "阿澄",
        worldSetting: "当代城市",
        workOrRole: "插画师",
        coreTraits: ["细心"],
        mainGoal: "完成漫画",
        initialRelationship: "邻居",
        dialogueStyle: "自然",
        tier: "daily",
        timezone: "Asia/Shanghai",
      },
    });
    expect(generated.statusCode).toBe(201);
    const character = generated.json<{ character: CharacterSpec }>().character;
    const published = await app.inject({
      method: "POST",
      url: `/api/characters/${character.id}/publish`,
      payload: { expectedVersion: character.version },
    });
    expect(published.statusCode).toBe(200);
    app.personasim.life.ensureToday(character.id);
    return character;
  }

  it("does not advance a new thread merely from elapsed calendar days", async () => {
    const character = await setup();
    const initial = repository.listActiveThreads(character.id)[0]!;
    expect(initial.progressionPolicy).toBe("evidence_driven_v2");
    expect(initial.timelinePlan).toBeUndefined();
    expect(initial.currentStage).toBe("当前关注");
    clock.advance({ days: 200 });
    app!.personasim.life.ensureToday(character.id);
    expect(repository.findThreadById(initial.id)).toEqual(initial);
    expect(
      app!.personasim.life.promptContext(character.id).semantics
        .lifeThreadStagesAdvanceByCharacterLocalDate,
    ).toBe(false);
  });

  it("applies a committed simulation outcome once without claiming the goal is complete", async () => {
    const character = await setup();
    const initial = repository.listActiveThreads(character.id)[0]!;
    clock.advance({ days: 1 });
    app!.personasim.life.advance(character.id);
    const outcome = repository
      .listRecentLifeOutcomes(character.id, 16)
      .find((item) => item.threadIds.includes(initial.id))!;
    const updated = repository.findThreadById(initial.id)!;
    expect(outcome.origin).toBe("simulation");
    expect(updated.progressNote).toBe(outcome.summary);
    expect(updated.status).not.toBe("resolved");
    expect(updated.revision).toBe(2);
    app!.personasim.life.advance(character.id);
    expect(repository.findThreadById(initial.id)).toEqual(updated);
    const row = database
      .prepare(
        "SELECT COUNT(*) AS count FROM domain_events WHERE event_type = 'life.thread_observation_applied'",
      )
      .get() as { count: number };
    expect(row.count).toBe(1);
  });

  it.each(["paused", "abandoned", "resolved"] as const)(
    "does not recreate a %s thread or schedule its baseline goal again",
    async (status) => {
      const character = await setup();
      const initial = repository.listActiveThreads(character.id)[0]!;
      const stopped = LifeThreadSchema.parse({
        ...initial,
        status,
        ...(status === "paused"
          ? {}
          : { closedLocalDate: initial.startedLocalDate }),
        revision: initial.revision + 1,
      });
      repository.updateThread(stopped, initial.revision);
      clock.advance({ days: 2 });
      const snapshot = app!.personasim.life.ensureToday(character.id);
      expect(
        repository.findThreadByIdempotencyKey(initial.idempotencyKey),
      ).toEqual(stopped);
      expect(
        snapshot.intents.some((intent) => intent.goalRefIds.includes("goal-1")),
      ).toBe(false);
      expect(snapshot.context.theme).toBeUndefined();
      const row = database
        .prepare(
          "SELECT COUNT(*) AS count FROM life_threads WHERE agent_id = ?",
        )
        .get(character.id) as { count: number };
      expect(row.count).toBe(1);
    },
  );

  it("pauses and resumes only from associated evidence, while terminal threads remain closed", async () => {
    const character = await setup();
    const initial = repository.listActiveThreads(character.id)[0]!;
    const outcome: LifeOutcome = {
      id: "outcome-1",
      agentId: character.id,
      intentId: "intent-1",
      outcomeKind: "deferred",
      summary: "今天暂缓了原先的打算。",
      outcomeFacts: ["今天暂缓了原先的打算。"],
      origin: "simulation",
      threadIds: [initial.id],
      sourceEvidenceIds: ["event-1"],
      importance: 0.5,
      effectiveLocalDate: "2026-09-01",
      temporalPrecision: "day",
      recordedAtUtc: START,
      idempotencyKey: "outcome-1",
      schemaVersion: 1,
    };
    const paused = projectGoalThreadOutcome(initial, outcome, START)!;
    expect(paused.status).toBe("paused");
    const resumed = projectGoalThreadOutcome(
      paused,
      {
        ...outcome,
        id: "outcome-2",
        outcomeKind: "partial",
        summary: "后来重新投入了一小部分。",
      },
      START,
    )!;
    expect(resumed).toMatchObject({
      status: "active",
      currentStage: "近期有投入",
      revision: 3,
    });
    expect(
      projectGoalThreadOutcome(
        initial,
        { ...outcome, agentId: "other-agent" },
        START,
      ),
    ).toBeUndefined();
    expect(
      projectGoalThreadOutcome(initial, { ...outcome, threadIds: [] }, START),
    ).toBeUndefined();
    expect(
      projectGoalThreadOutcome(
        initial,
        { ...outcome, sourceEvidenceIds: [] },
        START,
      ),
    ).toBeUndefined();
    const abandoned: LifeThread = {
      ...initial,
      status: "abandoned",
      closedLocalDate: initial.startedLocalDate,
    };
    expect(projectGoalThreadOutcome(abandoned, outcome, START)).toBeUndefined();
  });
});
