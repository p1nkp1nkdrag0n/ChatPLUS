import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { TURN_DECISION_SERVICE_TOKEN } from "../composition/service-tokens.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";

const START_UTC = "2026-08-16T02:00:00.000Z";

describe("fixture world-effects modes", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it("keeps deterministic fixture scheduling in off mode without requesting or applying world effects", async () => {
    app = await createTestApp("off");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const before = app.personasim.store.getRuntimeState(character.id)!;
    const generate = vi.spyOn(app.personasim.llm, "generateObject");

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-effects-off",
      "今晚学校有新生晚会，你要一起去吗？",
    );

    expect(response.statusCode, response.body).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges.length).toBeGreaterThan(0);
    const after = app.personasim.store.getRuntimeState(character.id)!;
    expect(after).toMatchObject({
      moodValence: before.moodValence,
      moodArousal: before.moodArousal,
      energy: before.energy,
      stress: before.stress,
      socialBattery: before.socialBattery,
      focus: before.focus,
      relationship: {
        closeness: before.relationship.closeness,
        trust: before.relationship.trust,
        recentInteractionValence: before.relationship.recentInteractionValence,
        lastInteractionAtUtc: START_UTC,
      },
    });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.relationship.familiarity).toBeCloseTo(
      before.relationship.familiarity + 0.001,
      8,
    );

    const chatCall = generate.mock.calls.find(
      ([input]) => input.purpose === "chat_turn",
    )?.[0];
    expect(chatCall?.fixture).toMatchObject({ worldEffects: {} });
    const audit = app.personasim.store
      .listDomainEvents(character.id, 100)
      .find(
        (event) => event.eventType === "conversation.world_effects_committed",
      );
    expect(audit?.payload).toMatchObject({
      mode: "off",
      llmProposalStatus: "off",
      proposed: {},
      accepted: { stateDelta: false, relationshipDelta: false },
      applied: {
        stateDelta: {},
      },
      source: {
        relationshipBaseline: "server_interaction_baseline",
        semanticProposal: "none",
      },
    });
    expect(
      typeof nestedValue(
        audit?.payload,
        "applied",
        "relationshipDelta",
        "familiarity",
      ),
    ).toBe("number");
  });

  it("validates fixture effects in shadow mode but leaves authoritative state unchanged", async () => {
    app = await createTestApp("shadow");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const before = app.personasim.store.getRuntimeState(character.id)!;

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-effects-shadow",
      "今天过得怎么样？",
    );

    expect(response.statusCode, response.body).toBe(201);
    const after = app.personasim.store.getRuntimeState(character.id)!;
    expect(after).toMatchObject({
      moodValence: before.moodValence,
      moodArousal: before.moodArousal,
      energy: before.energy,
      stress: before.stress,
      socialBattery: before.socialBattery,
      focus: before.focus,
      relationship: {
        closeness: before.relationship.closeness,
        trust: before.relationship.trust,
        recentInteractionValence: before.relationship.recentInteractionValence,
        lastInteractionAtUtc: START_UTC,
      },
    });
    expect(after.revision).toBe(before.revision + 1);
    expect(after.relationship.familiarity).toBeCloseTo(
      before.relationship.familiarity + 0.001,
      8,
    );
    const audit = app.personasim.store
      .listDomainEvents(character.id, 100)
      .find(
        (event) =>
          event.eventType === "conversation.world_effects_shadow_evaluated",
      );
    expect(audit?.payload).toMatchObject({
      mode: "shadow",
      accepted: {
        stateDelta: true,
        relationshipDelta: true,
      },
      applied: {
        stateDelta: {},
      },
      rejectionCodes: [],
    });
    for (const path of [
      ["applied", "relationshipDelta", "familiarity"],
      ["wouldApply", "applied", "stateDelta", "moodValence"],
      ["wouldApply", "applied", "stateDelta", "socialBattery"],
      ["wouldApply", "applied", "relationshipDelta", "closeness"],
      ["wouldApply", "applied", "relationshipDelta", "familiarity"],
      [
        "wouldApply",
        "applied",
        "relationshipDelta",
        "recentInteractionValence",
      ],
    ] as const) {
      expect(typeof nestedValue(audit?.payload, ...path)).toBe("number");
    }
  });

  it("keeps validated fixture effects when reply repair succeeds", async () => {
    app = await createTestApp("enforced");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const before = app.personasim.store.getRuntimeState(character.id)!;
    forceInspectionFailures(app, 1);
    mockFixtureRepair(app, {
      reply: {
        text: "我刚把手头的事放下，现在可以认真听你说。",
        chunks: ["我刚把手头的事放下，现在可以认真听你说。"],
        toneTags: ["自然"],
      },
      scheduleEffects: [],
      stateDelta: { moodValence: -0.5 },
      memoryCandidates: [],
      reasonCode: "fixture_reply_repaired",
      reasonSummary: "修复了不符合角色设定的回复。",
    });

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-effects-repair",
      "你现在感觉怎么样？",
    );

    expect(response.statusCode, response.body).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toContain("认真听你说");
    expect(body.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(body.state.moodValence).toBeCloseTo(before.moodValence + 0.015, 8);
    expect(body.state.moodValence).not.toBeCloseTo(before.moodValence - 0.2, 8);
    expect(body.state.relationship.closeness).toBeGreaterThan(
      before.relationship.closeness,
    );
    expect(committedAudit(app, character.id)?.payload).toMatchObject({
      mode: "enforced",
      accepted: { stateDelta: true, relationshipDelta: true },
    });
  });

  it("keeps validated fixture effects when repair still fails and the reply falls back", async () => {
    app = await createTestApp("enforced");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const before = app.personasim.store.getRuntimeState(character.id)!;
    forceInspectionFailures(app, 2);
    mockFixtureRepair(app, {
      reply: {
        text: "As an AI language model, I still have no life.",
        chunks: ["As an AI language model, I still have no life."],
        toneTags: ["meta"],
      },
      scheduleEffects: [],
      stateDelta: { moodValence: -0.5 },
      memoryCandidates: [],
      reasonCode: "fixture_reply_still_invalid",
      reasonSummary: "这次修复仍然不符合角色设定。",
    });

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-effects-fallback",
      "你愿意说说现在的状态吗？",
    );

    expect(response.statusCode, response.body).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(body.assistantMessage.content).not.toContain("language model");
    expect(body.state.moodValence).toBeCloseTo(before.moodValence + 0.015, 8);
    expect(body.state.moodValence).not.toBeCloseTo(before.moodValence - 0.2, 8);
    expect(committedAudit(app, character.id)?.payload).toMatchObject({
      mode: "enforced",
      accepted: { stateDelta: true },
    });
  });

  it("runs the fixture through enforced two-phase schedule negotiation and commits exactly once", async () => {
    app = await createTestApp("enforced", "enforced");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    const offered = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-enforced-offer",
      "后天下午三点一起去北岸书店喝茶怎么样？",
    );
    expect(offered.statusCode, offered.body).toBe(201);
    const offeredBody = jsonBody<ChatTurnResult>(offered);
    expect(offeredBody.scheduleChanges).toEqual([]);
    expect(
      offeredBody.assistantMessage.metadata["scheduleActionAudit"],
    ).toEqual({ origin: "fixture", kind: "accept_user_offer" });
    expect(
      app.personasim.store.getActiveScheduleNegotiation(sessionId),
    ).toMatchObject({ status: "awaiting_confirmation", offerVersion: 1 });
    expect(
      app.personasim.store
        .listSchedule(character.id)
        .filter((item) => item.source === "user_invitation"),
    ).toEqual([]);

    const confirmed = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-enforced-confirm",
      "确认",
    );
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    const confirmedBody = jsonBody<ChatTurnResult>(confirmed);
    expect(confirmedBody.scheduleChanges).toHaveLength(1);
    expect(confirmedBody.scheduleChanges[0]).toMatchObject({
      category: "social",
      source: "user_invitation",
    });
    expect(
      confirmedBody.assistantMessage.metadata["scheduleActionAudit"],
    ).toEqual({ origin: "fixture", kind: "accept_pending_offer" });
    expect(
      app.personasim.store
        .listSchedule(character.id)
        .filter((item) => item.source === "user_invitation"),
    ).toHaveLength(1);

    const replay = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-enforced-confirm",
      "确认",
    );
    expect(replay.statusCode, replay.body).toBe(200);
    expect(jsonBody<ChatTurnResult>(replay).idempotentReplay).toBe(true);
    expect(
      app.personasim.store
        .listSchedule(character.id)
        .filter((item) => item.source === "user_invitation"),
    ).toHaveLength(1);
  });

  it("keeps a fixture month-day invitation on the explicit future date", async () => {
    app = await createTestApp(
      "enforced",
      "enforced",
      "2026-09-27T08:30:00.000Z",
    );
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    const offered = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-month-day-offer",
      "9月30日下午3点一起去北岸书店喝茶怎么样？",
    );
    expect(offered.statusCode, offered.body).toBe(201);
    expect(jsonBody<ChatTurnResult>(offered).scheduleChanges).toEqual([]);
    expect(
      app.personasim.store.getActiveScheduleNegotiation(sessionId),
    ).toMatchObject({ status: "awaiting_confirmation", offerVersion: 1 });

    const confirmed = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-month-day-confirm",
      "确认",
    );
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    expect(jsonBody<ChatTurnResult>(confirmed).scheduleChanges).toEqual([
      expect.objectContaining({
        startAtUtc: "2026-09-30T07:00:00.000Z",
        endAtUtc: "2026-09-30T08:30:00.000Z",
        timezone: "Asia/Shanghai",
        category: "social",
        source: "user_invitation",
      }),
    ]);
  });

  it("persists short explicit user facts as grounded structured memories without memorizing a follow-up question", async () => {
    app = await createTestApp("enforced");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    const fact = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-short-user-fact",
      "小林是我大学同学。",
    );
    expect(fact.statusCode, fact.body).toBe(201);

    const memory = app.personasim.store.database
      .prepare(
        `SELECT id, type, namespace, certainty, attribution, stability,
          claim_subject_key, claim_disposition, status
         FROM memories WHERE agent_id = ?`,
      )
      .get(character.id) as Record<string, unknown> | undefined;
    expect(memory).toMatchObject({
      type: "semantic",
      namespace: "user_model",
      certainty: "explicit",
      attribution: "user_explicit",
      stability: "stable",
      claim_subject_key: "user_fact:relationship:小林",
      claim_disposition: "affirmed",
      status: "active",
    });
    const evidence = app.personasim.store.database
      .prepare(
        `SELECT source_type, source_id FROM memory_evidence
         WHERE memory_id = ?`,
      )
      .get(memory?.["id"]);
    expect(evidence).toMatchObject({
      source_type: "message",
      source_id: jsonBody<ChatTurnResult>(fact).userMessage.id,
    });

    const countBeforeQuestion = app.personasim.store.database
      .prepare("SELECT COUNT(*) AS count FROM memories WHERE agent_id = ?")
      .get(character.id) as { count: number };
    const question = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-user-fact-question",
      "小林和我是什么关系？",
    );
    expect(question.statusCode, question.body).toBe(201);
    const countAfterQuestion = app.personasim.store.database
      .prepare("SELECT COUNT(*) AS count FROM memories WHERE agent_id = ?")
      .get(character.id) as { count: number };
    expect(countAfterQuestion.count).toBe(countBeforeQuestion.count);

    for (const [clientMessageId, text] of [
      [
        "fixture-long-hypothesis",
        "假设我养了一只叫豆包的狗，它每天都喜欢蓝色飞盘，这只是一个很长的举例，不是现实事实。",
      ],
      [
        "fixture-long-quote",
        "同事说‘你一直最爱浓咖啡而且每天都喝’，但那只是他随口讲的，别当成我的事实。",
      ],
    ] as const) {
      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        clientMessageId,
        text,
      );
      expect(response.statusCode, response.body).toBe(201);
    }
    const countAfterUnsafeStatements = app.personasim.store.database
      .prepare("SELECT COUNT(*) AS count FROM memories WHERE agent_id = ?")
      .get(character.id) as { count: number };
    expect(countAfterUnsafeStatements.count).toBe(countBeforeQuestion.count);
  });

  it("persists an explicit unfinished plan with message evidence", async () => {
    app = await createTestApp("enforced");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-explicit-plan",
      "我打算明天完成汇报，现在还没做。",
    );
    expect(response.statusCode, response.body).toBe(201);
    const memory = app.personasim.store.database
      .prepare(
        `SELECT claim_subject_key, claim_disposition, temporal_status
         FROM memories WHERE agent_id = ?`,
      )
      .get(character.id);
    expect(memory).toMatchObject({
      claim_subject_key: "user_task:report",
      claim_disposition: "affirmed",
      temporal_status: "planned",
    });
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM memory_evidence")
        .get(),
    ).toMatchObject({ count: 1 });
  });

  it("persists the fixture river inspiration as a grounded chat intent for autonomous planning", async () => {
    app = await createTestApp("enforced");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "fixture-riverside-intent",
      "河边夜景最近很好看，那种灯光也许适合你的片子。",
    );
    expect(response.statusCode, response.body).toBe(201);
    const userMessageId = jsonBody<ChatTurnResult>(response).userMessage.id;
    const intentRow = app.personasim.store.database
      .prepare(
        `SELECT record_json
         FROM personal_intentions
         WHERE agent_id = ? AND basis_kind = 'chat'`,
      )
      .get(character.id) as { record_json: string } | undefined;
    const intent =
      intentRow === undefined
        ? undefined
        : (JSON.parse(intentRow.record_json) as Record<string, unknown>);
    expect(intent).toMatchObject({
      activity: "河边夜景拍摄",
      category: "travel",
      basisKind: "chat",
      status: "pending",
    });
    expect(intent?.["evidenceMessageIds"]).toEqual([userMessageId]);
    expect(intent?.["earliestAtUtc"]).toBe("2026-08-17T10:00:00.000Z");
    expect(intent?.["latestAtUtc"]).toBe("2026-08-17T15:00:00.000Z");
  });
});

function mockFixtureRepair(app: PersonaSimApp, repair: unknown): void {
  vi.spyOn(app.personasim.llm, "generateObject").mockImplementation((input) => {
    if (input.purpose === "chat_turn") {
      return Promise.resolve({
        replyDecision: {
          text: "Provider continuity carrier.",
          chunks: ["Provider continuity carrier."],
          toneTags: ["neutral"],
        },
        worldEffects: {},
      } as never);
    }
    if (input.purpose === "repair_chat_turn") {
      return Promise.resolve(repair as never);
    }
    if (input.fixture !== undefined) return Promise.resolve(input.fixture);
    throw new Error(`Unexpected fixture purpose: ${input.purpose}`);
  });
}

function forceInspectionFailures(app: PersonaSimApp, count: number): void {
  const decisions = app.personasim.kernel.registry.resolve(
    TURN_DECISION_SERVICE_TOKEN,
  );
  const inspect = decisions.inspect.bind(decisions);
  let remaining = count;
  vi.spyOn(decisions, "inspect").mockImplementation((input) => {
    const result = inspect(input);
    if (remaining <= 0) return result;
    remaining -= 1;
    return {
      ...result,
      issues: [{ code: "TEST_FORCED_REPLY_REPAIR" }],
    };
  });
}

function committedAudit(app: PersonaSimApp, agentId: string) {
  return app.personasim.store
    .listDomainEvents(agentId, 100)
    .find(
      (event) => event.eventType === "conversation.world_effects_committed",
    );
}

async function createTestApp(
  liveWorldEffectsMode: "off" | "shadow" | "enforced",
  scheduleNegotiationMode: "legacy" | "enforced" = "legacy",
  startAtUtc = START_UTC,
): Promise<PersonaSimApp> {
  const clock = new FakeClock(startAtUtc);
  const config = readConfig({
    nodeEnv: "test",
    profile: "fixture-world-effects-mode-test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    chatEffectsMode: "gated",
    scheduleNegotiationMode,
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode,
    memoryRecallMode: "legacy",
    autobiographyMode: "off",
    llm: {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
  });
  return buildApp({
    config,
    database: openDatabase(":memory:"),
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
}

async function createAndPublish(
  app: PersonaSimApp,
): Promise<{ id: string; version: number }> {
  const generated = await app.inject({
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

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
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
