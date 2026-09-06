import {
  LifeThreadSchema,
  type CharacterSpec,
  type LifeOutcome,
  type LifeThread,
} from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  let fixtureReply: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    fixtureReply = undefined;
    vi.restoreAllMocks();
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
      fixtureTurnBehavior: { semanticReply: () => fixtureReply },
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

  async function chat(
    character: CharacterSpec,
    text: string,
    clientMessageId: string,
    reply?: string,
  ) {
    fixtureReply = reply;
    const created = await app!.inject({
      method: "POST",
      url: `/api/agents/${character.id}/sessions`,
      payload: {},
    });
    const sessionId = created.json<{ session: { id: string } }>().session.id;
    const response = await app!.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: { agentId: character.id, text, clientMessageId },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<{
      userMessage: { id: string };
      assistantMessage: { id: string };
    }>();
  }

  async function republish(
    character: CharacterSpec,
    edit: (spec: CharacterSpec) => void,
  ) {
    const candidate = structuredClone(
      app!.personasim.store.getCharacterSpec(character.id)!,
    );
    edit(candidate);
    const updated = await app!.inject({
      method: "PATCH",
      url: `/api/characters/${character.id}/draft`,
      payload: { spec: candidate, expectedVersion: candidate.version },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    const draft = updated.json<{ character: CharacterSpec }>().character;
    const published = await app!.inject({
      method: "POST",
      url: `/api/characters/${character.id}/publish`,
      payload: { expectedVersion: draft.version },
    });
    expect(published.statusCode, published.body).toBe(200);
  }

  it("commits explicit goal pause and resume through chat without inventing an action or result", async () => {
    const character = await setup();
    const initial = repository.listActiveThreads(character.id)[0]!;
    const pausedTurn = await chat(
      character,
      "请暂停你的完成漫画目标。",
      "pause-goal",
      "我同意暂停我的完成漫画目标。",
    );
    const paused = repository.findThreadById(initial.id)!;
    expect(paused).toMatchObject({
      status: "paused",
      currentStage: "明确暂停",
      pauseSourceMessageId: pausedTurn.userMessage.id,
    });
    expect(repository.listRecentActions(character.id)).toEqual([]);
    expect(paused.sourceMessageIds).toEqual([
      pausedTurn.userMessage.id,
      pausedTurn.assistantMessage.id,
    ]);
    clock.advance({ days: 2 });
    app!.personasim.life.advance(character.id);
    const held = app!.personasim.life.ensureToday(character.id);
    expect(repository.findThreadById(initial.id)).toEqual(paused);
    expect(
      held.intents.some((intent) => intent.threadIds.includes(initial.id)),
    ).toBe(false);
    expect(
      repository
        .listRecentLifeOutcomes(character.id, 64)
        .filter((outcome) => outcome.threadIds.includes(initial.id))
        .every((outcome) => outcome.outcomeKind === "deferred"),
    ).toBe(true);

    await chat(
      character,
      "你已经为完成漫画画了第一页。",
      "effort-during-pause",
    );
    expect(repository.findThreadById(initial.id)).toEqual(paused);
    const resumedTurn = await chat(
      character,
      "请恢复你的完成漫画目标。",
      "resume-goal",
      "我同意恢复我的完成漫画目标。",
    );
    const resumed = repository.findThreadById(initial.id)!;
    expect(resumed).toMatchObject({
      status: "active",
      currentStage: "当前关注",
    });
    expect(resumed.pauseSourceMessageId).toBeUndefined();
    expect(resumed.sourceMessageIds).toContain(resumedTurn.userMessage.id);
    expect(resumed.sourceMessageIds).toContain(resumedTurn.assistantMessage.id);
    expect(resumed.progressNote).toContain("尚未据此宣称有实际进展");
    expect(repository.listRecentActions(character.id)).toEqual([]);
    await chat(character, "你已经为完成漫画画了第一页。", "actual-role-effort");
    const actual = repository.findThreadById(initial.id)!;
    expect(actual).toMatchObject({
      status: "active",
      currentStage: "近期有投入",
    });
    expect(actual.progressNote).toBe("你已经为完成漫画画了第一页");
    clock.advance({ days: 1 });
    expect(
      app!.personasim.life
        .ensureToday(character.id)
        .intents.some((intent) => intent.threadIds.includes(initial.id)),
    ).toBe(true);
  });

  it.each([
    "我已经恢复完成漫画这个目标了。",
    "如果我请恢复你的完成漫画目标，你会怎么做？",
    "不要恢复你的完成漫画目标。",
    "请翻译“恢复你的完成漫画目标”。",
    "请恢复你的完成漫画目标了吗？",
    "我已经为完成漫画画了第一页。",
    "我不赞同恢复你的完成漫画目标。",
    "恢复你的完成漫画目标似乎不妥。",
  ])(
    "does not turn an unrelated, negated, hypothetical or quoted statement into goal control: %s",
    async (text) => {
      const character = await setup();
      const initial = repository.listActiveThreads(character.id)[0]!;
      await chat(
        character,
        "请暂停你的完成漫画目标。",
        "pause-before-rejected",
        "我同意暂停我的完成漫画目标。",
      );
      const paused = repository.findThreadById(initial.id)!;
      await chat(
        character,
        text,
        "rejected-control",
        "我同意恢复我的完成漫画目标。",
      );
      expect(repository.findThreadById(initial.id)).toEqual(paused);
    },
  );

  it.each([
    {
      status: "active",
      request: "请暂停你的完成漫画目标。",
      reply: "我不同意暂停我的完成漫画目标。",
    },
    {
      status: "active",
      request: "请暂停你的完成漫画目标。",
      reply: "好，我听到你的想法了。",
    },
    {
      status: "active",
      request: "请暂停你的完成漫画目标。",
      reply: "如果之后更忙，我同意暂停我的完成漫画目标。",
    },
    {
      status: "active",
      request: "请暂停你的完成漫画目标。",
      reply: "你说的句子是：我同意暂停我的完成漫画目标。",
    },
    {
      status: "active",
      request: "请暂停你的完成漫画目标。",
      reply: "我同意暂停我的学习吉他目标。",
    },
    {
      status: "paused",
      request: "请恢复你的完成漫画目标。",
      reply: "我不同意恢复我的完成漫画目标。",
    },
    {
      status: "paused",
      request: "请恢复你的完成漫画目标。",
      reply: "我同意恢复我的完成漫画目标吗？",
    },
    {
      status: "paused",
      request: "请恢复你的完成漫画目标。",
      reply: "请翻译“我同意恢复我的完成漫画目标”。",
    },
  ] as const)(
    "requires the character to accept the same goal control: $reply",
    async ({ status, request, reply }) => {
      const character = await setup();
      const initial = repository.listActiveThreads(character.id)[0]!;
      if (status === "paused")
        repository.updateThread(
          { ...initial, status, revision: initial.revision + 1 },
          initial.revision,
        );
      const before = repository.findThreadById(initial.id)!;
      await chat(character, request, "unaccepted-control", reply);
      expect(repository.findThreadById(initial.id)).toEqual(before);
    },
  );

  it("recovers a simulation-paused thread from a committed user report about the character's actual effort", async () => {
    const character = await setup();
    const initial = repository.listActiveThreads(character.id)[0]!;
    repository.updateThread(
      {
        ...initial,
        status: "paused",
        currentStage: "近期暂缓",
        revision: initial.revision + 1,
      },
      initial.revision,
    );
    await chat(character, "我已经为完成漫画画了第一页。", "user-own-work");
    expect(repository.findThreadById(initial.id)?.status).toBe("paused");
    const reported = await chat(
      character,
      "你已经为完成漫画画了第一页。",
      "reported-character-work",
    );
    expect(repository.findThreadById(initial.id)).toMatchObject({
      status: "active",
      currentStage: "近期有投入",
      sourceMessageIds: [reported.userMessage.id],
    });
  });

  it("keeps author revisions bound to their own goal content and never revives removed history", async () => {
    const character = await setup();
    const initial = repository.listActiveThreads(character.id)[0]!;
    const originalGoals = structuredClone(character.persona.goals);
    await republish(character, (spec) => {
      spec.identity.selfDescription = "平时喜欢和邻居聊聊日常。";
    });
    app!.personasim.life.ensureToday(character.id);
    expect(repository.findThreadById(initial.id)).toEqual(initial);
    expect(repository.listEvidenceDrivenGoalThreads(character.id)).toHaveLength(
      1,
    );

    await republish(character, (spec) => {
      spec.persona.goals[0] = {
        ...spec.persona.goals[0]!,
        title: "学习吉他",
        description: "学习吉他",
      };
    });
    clock.advance({ days: 1 });
    const changed = app!.personasim.life.ensureToday(character.id);
    const replacement = changed.threads[0]!;
    expect(replacement.title).toBe("学习吉他");
    expect(replacement.id).not.toBe(initial.id);
    const retired = repository.findThreadById(initial.id)!;
    expect(retired.status).toBe("abandoned");
    expect(retired.title).toBe("完成漫画");
    expect(
      changed.intents
        .filter((intent) => intent.sourceKind === "goal")
        .map((intent) => intent.threadIds),
    ).toEqual([[replacement.id]]);
    app!.personasim.life.advance(character.id);
    expect(repository.findThreadById(initial.id)).toEqual(retired);

    await republish(character, (spec) => {
      spec.persona.goals = [];
    });
    expect(app!.personasim.life.ensureToday(character.id).threads).toEqual([]);
    expect(repository.findThreadById(replacement.id)?.status).toBe("abandoned");
    await republish(character, (spec) => {
      spec.persona.goals = originalGoals;
    });
    expect(app!.personasim.life.ensureToday(character.id).threads).toEqual([]);
    expect(repository.listEvidenceDrivenGoalThreads(character.id)).toHaveLength(
      2,
    );
  });

  it("rolls back goal control and its evidence when the enclosing chat commit fails", async () => {
    const character = await setup();
    const initial = repository.listActiveThreads(character.id)[0]!;
    const created = await app!.inject({
      method: "POST",
      url: `/api/agents/${character.id}/sessions`,
      payload: {},
    });
    const sessionId = created.json<{ session: { id: string } }>().session.id;
    const originalRecord = app!.personasim.life.recordConversationTurn.bind(
      app!.personasim.life,
    );
    fixtureReply = "我同意暂停我的完成漫画目标。";
    vi.spyOn(app!.personasim.life, "recordConversationTurn").mockImplementation(
      (input) => {
        originalRecord(input);
        throw new Error("injected failure after goal control");
      },
    );
    const failed = await app!.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: {
        agentId: character.id,
        text: "请暂停你的完成漫画目标。",
        clientMessageId: "rollback-goal-control",
      },
    });
    expect(failed.statusCode).toBe(500);
    expect(repository.findThreadById(initial.id)).toEqual(initial);
    expect(app!.personasim.store.listMessagesForContext(sessionId)).toEqual([]);
    expect(
      database
        .prepare(
          "SELECT count(*) AS count FROM domain_events WHERE event_type = 'life.thread_controlled'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

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
