import { seededUnit } from "@personasim/features";
import {
  ActivateAgentResponseSchema,
  PublishCharacterResponseSchema,
} from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { openDatabase } from "./db/connection.js";
import { runMigrations } from "./db/migrations.js";
import { buildImportedDraft, buildOriginalDraft } from "./domain/defaults.js";
import {
  scheduleItemSchema,
  type AgentTurnDecision,
  type CharacterSpec,
  type ImportedCharacterInput,
  type OriginalCharacterInput,
  type ScheduleItem,
} from "./domain/schemas.js";
import { FakeClock } from "./runtime/clock.js";
import type { ChatTurnResult } from "./services/conversation-service.js";

const START_UTC = "2026-08-16T02:00:00.000Z";
const LONG_MEMORY_TEXT =
  "我希望你记住，我们每周六下午都会一起复盘本周最重要的进展，而且会提前整理好需要讨论的问题。";

describe("PersonaSim server integration", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("runs ordered SQLite migrations idempotently with required pragmas", () => {
    const database = openDatabase(":memory:");
    try {
      expect(runMigrations(database)).toEqual([
        "001_initial.sql",
        "002_memory_projection.sql",
        "003_rejected_proposals.sql",
        "004_schedule_negotiations.sql",
        "005_personal_intentions.sql",
        "006_schedule_self_initiated.sql",
        "007_memory_evidence.sql",
        "008_memory_semantics.sql",
        "009_proactive_claim.sql",
        "010_runtime_sleep_debt.sql",
        "011_long_term_continuity.sql",
        "012_followup_care_proactive_generation.sql",
        "013_calendar_retrieval_runs.sql",
        "014_retrieval_run_date_digest.sql",
        "015_llm_provider_profiles.sql",
        "016_llm_reasoning_config.sql",
        "017_fuzzy_life_decisions.sql",
        "018_temporal_correspondence.sql",
        "019_correspondence_key_metadata.sql",
        "020_keepsakes.sql",
        "021_correspondence_reply_recovery.sql",
      ]);
      expect(runMigrations(database)).toEqual([]);
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String((row as { name: string }).name));
      expect(tables).toEqual(
        expect.arrayContaining([
          "characters",
          "character_versions",
          "messages",
          "runtime_states",
          "schedule_items",
          "personal_intentions",
          "memory_evidence",
          "activity_events",
          "settlements",
          "domain_events",
          "schedule_negotiations",
          "llm_calls",
          "message_archive",
          "conversation_checkpoints",
          "autobiography_snapshots",
          "autobiography_entries",
          "event_cards",
          "memory_conflicts",
          "memory_merge_history",
          "follow_up_intents",
          "care_cues",
          "proactive_generation_runs",
          "calendar_entries",
          "retrieval_runs",
          "keepsakes",
          "keepsake_assets",
          "keepsake_generation_runs",
          "keepsake_sources",
          "keepsake_letter_links",
          "character_visual_profiles",
          "daily_life_contexts",
          "daily_life_intents",
          "life_threads",
          "life_outcomes",
          "dilemma_episodes",
          "pressure_episodes",
          "support_interventions",
          "decision_records",
          "action_records",
          "outcome_records",
          "reflection_records",
          "relationship_milestones",
          "correspondence_threads",
          "letters",
          "letter_generation_snapshots",
          "letter_generation_runs",
          "temporal_tasks",
          "correspondence_key_metadata",
        ]),
      );
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.pragma("busy_timeout", { simple: true })).toBe(5_000);
      expect(
        database
          .prepare("PRAGMA table_info(llm_calls)")
          .all()
          .map((row) => String((row as { name: string }).name)),
      ).toContain("provider_profile");
    } finally {
      database.close();
    }
  });

  it("generates, publishes and returns a validated 72-hour schedule over HTTP", async () => {
    ({ app } = await createTestApp());
    const character = await createAndPublish(app, "daily");

    const detail = await app.inject({
      method: "GET",
      url: `/api/characters/${character.id}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(
      jsonBody<{ character: { status: string } }>(detail).character.status,
    ).toBe("published");

    const scheduleResponse = await app.inject({
      method: "GET",
      url: `/api/agents/${character.id}/schedule`,
    });
    expect(scheduleResponse.statusCode).toBe(200);
    const schedule = jsonBody<{ items: ScheduleItem[] }>(
      scheduleResponse,
    ).items;
    expect(schedule.length).toBeGreaterThan(5);
    expect(schedule.some((item) => item.category === "sleep")).toBe(true);
    expect(schedule.some((item) => item.category === "meal")).toBe(true);
    expect(
      schedule.every(
        (item) =>
          Date.parse(item.startAtUtc) >= Date.parse(START_UTC) &&
          Date.parse(item.endAtUtc) <= Date.parse(START_UTC) + 72 * 3_600_000,
      ),
    ).toBe(true);
  });

  it("uses runtime sleep and meal baselines when deterministic planning falls back for noncanonical routines", async () => {
    ({ app } = await createTestApp());
    const planCalls: string[] = [];
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        if (input.purpose === "plan_schedule") {
          planCalls.push(input.purpose);
          return Promise.reject(new Error("force deterministic fallback"));
        }
        if (input.fixture === undefined) {
          throw new Error(`Expected a fixture for ${input.purpose}`);
        }
        return Promise.resolve(input.fixture);
      },
    );

    const generatedResponse = await app.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: {
        name: "林夏",
        worldSetting: "当代城市生活",
        workOrRole: "独立剪辑师",
        coreTraits: ["认真", "有主见", "温暖"],
        centralContradiction: "既重视工作，也想照顾好自己",
        primaryGoal: "完成纪录片剪辑",
        relationshipToUser: "熟悉的朋友",
        dialogueStyle: "自然、简洁",
        tier: "daily",
        timezone: "Asia/Shanghai",
      },
    });
    expect(generatedResponse.statusCode).toBe(201);
    const draft = jsonBody<{ character: CharacterSpec }>(
      generatedResponse,
    ).character;
    const noncanonicalSpec = structuredClone(draft);
    noncanonicalSpec.routines = [
      {
        id: "model-routine-work",
        title: "上午专注剪辑",
        category: "工作",
        recurrence: "daily",
        preferredStartLocal: "09:00",
        preferredDurationMinutes: 180,
        rigidity: "committed",
        priority: 0.9,
      },
    ];

    const updatedResponse = await app.inject({
      method: "PATCH",
      url: `/api/characters/${draft.id}`,
      payload: { spec: noncanonicalSpec, expectedVersion: draft.version },
    });
    expect(updatedResponse.statusCode).toBe(200);
    const updated = jsonBody<{ character: CharacterSpec }>(
      updatedResponse,
    ).character;

    const publishedResponse = await app.inject({
      method: "POST",
      url: `/api/characters/${updated.id}/publish`,
      payload: { expectedVersion: updated.version },
    });
    expect(publishedResponse.statusCode).toBe(200);
    expect(planCalls).toEqual(["plan_schedule"]);

    const schedule = app.personasim.store.listSchedule(updated.id);
    expect(schedule.some((item) => item.category === "sleep")).toBe(true);
    expect(schedule.some((item) => item.category === "meal")).toBe(true);
    expect(app.personasim.store.getCharacterSpec(updated.id)?.routines).toEqual(
      noncanonicalSpec.routines,
    );
  });

  it("commits an invitation reply and schedule effects atomically and replays by client id", async () => {
    ({ app } = await createTestApp());
    const character = await createAndPublish(app, "high_fidelity");
    const sessionResponse = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/sessions`,
      payload: {},
    });
    const sessionId = jsonBody<{ session: { id: string } }>(sessionResponse)
      .session.id;
    const payload = {
      agentId: character.id,
      clientMessageId: "invite-turn-1",
      text: "今晚要不要和我一起去参加晚会？",
    };

    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload,
    });
    expect(first.statusCode).toBe(201);
    const firstBody = jsonBody<ChatTurnResult>(first);
    expect(firstBody.scheduleChanges).toHaveLength(2);
    expect(firstBody.assistantMessage.content).toContain("一起去");

    const stored = app.personasim.store.listSchedule(character.id);
    expect(
      stored.some(
        (item) => item.category === "study" && item.status === "cancelled",
      ),
    ).toBe(true);
    expect(
      stored.some(
        (item) => item.category === "social" && item.status === "planned",
      ),
    ).toBe(true);
    expect(app.personasim.store.listMessages(sessionId)).toHaveLength(2);

    const replay = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(jsonBody<ChatTurnResult>(replay).idempotentReplay).toBe(true);
    expect(app.personasim.store.listMessages(sessionId)).toHaveLength(2);
  });

  it("keeps lightweight simulation static except for interaction time", async () => {
    const created = await createTestApp();
    app = created.app;
    const character = await createAndPublish(app, "lightweight");
    const beforeState = app.personasim.store.getRuntimeState(character.id)!;
    const beforeCursor = app.personasim.store.getCursor(character.id)!;
    created.clock.advance({ hours: 12 });

    const activation = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    const activationBody = jsonBody<ActivationBody>(activation);
    expect(activationBody.capabilities?.offlineSettlement).toBe(false);
    expect(app.personasim.store.getCursor(character.id)).toEqual(beforeCursor);

    const sessionId = await createSession(app, character.id);
    const turn = await sendMessage(
      app,
      sessionId,
      character.id,
      "light-static-1",
      LONG_MEMORY_TEXT,
    );
    expect(turn.statusCode).toBe(201);
    expect(app.personasim.store.getRuntimeState(character.id)).toMatchObject({
      ...beforeState,
      asOfUtc: created.clock.nowUtc(),
      revision: beforeState.revision + 1,
      relationship: {
        ...beforeState.relationship,
        familiarity: beforeState.relationship.familiarity,
        lastInteractionAtUtc: created.clock.nowUtc(),
      },
    });
    expect(app.personasim.store.listSchedule(character.id)).toHaveLength(0);
    const memories = app.personasim.store.database
      .prepare("SELECT COUNT(*) AS count FROM memories WHERE agent_id = ?")
      .get(character.id) as { count: number };
    expect(memories.count).toBe(0);
  });

  it("validates, sources and merges daily conversation memories while bounding relationship change", async () => {
    ({ app } = await createTestApp("enforced"));
    const character = await createAndPublish(app, "daily");
    const before = app.personasim.store.getRuntimeState(character.id)!;
    const sessionId = await createSession(app, character.id);

    expect(
      (
        await sendMessage(
          app,
          sessionId,
          character.id,
          "memory-1",
          LONG_MEMORY_TEXT,
        )
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await sendMessage(
          app,
          sessionId,
          character.id,
          "memory-2",
          LONG_MEMORY_TEXT,
        )
      ).statusCode,
    ).toBe(201);

    const rows = app.personasim.store.database
      .prepare("SELECT memory_json FROM memories WHERE agent_id = ?")
      .all(character.id) as Array<{ memory_json: string }>;
    expect(rows).toHaveLength(1);
    const memory = jsonText<{ sourceMessageIds: string[]; origin: string }>(
      rows[0]!.memory_json,
    );
    expect(memory.sourceMessageIds).toHaveLength(2);
    expect(memory.origin).toBe("runtime_simulation");
    const sourceCount = app.personasim.store.database
      .prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE agent_id = ? AND role = 'user' AND id IN (?, ?)`,
      )
      .get(
        character.id,
        memory.sourceMessageIds[0],
        memory.sourceMessageIds[1],
      ) as { count: number };
    expect(sourceCount.count).toBe(2);
    const after = app.personasim.store.getRuntimeState(character.id)!;
    expect(after.moodValence).toBeGreaterThan(before.moodValence);
    expect(after.relationship.closeness).toBeGreaterThan(
      before.relationship.closeness,
    );
    expect(
      after.relationship.closeness - before.relationship.closeness,
    ).toBeLessThanOrEqual(0.01);
  });

  it("uses the high-fidelity persona guard and invokes repair at most once", async () => {
    ({ app } = await createTestApp());
    const character = await createAndPublish(app, "high_fidelity");
    const sessionId = await createSession(app, character.id);
    const badDecision: AgentTurnDecision = {
      reply: {
        text: "作为一个AI语言模型，我已经修改了日程。",
        chunks: ["作为一个AI语言模型，我已经修改了日程。"],
        toneTags: ["meta"],
      },
      scheduleEffects: [],
      memoryCandidates: [],
      reasonCode: "ordinary_conversation",
      reasonSummary: "测试人格守卫。",
    };
    const purposes: string[] = [];
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        purposes.push(input.purpose);
        return Promise.resolve(badDecision);
      },
    );

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "persona-guard-1",
      "请介绍你自己",
    );
    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).not.toContain("AI语言模型");
    expect(body.assistantMessage.content).toContain("确认一下时间安排");
    expect(body.assistantMessage.metadata.repairAttempted).toBe(true);
    expect(
      purposes.filter((purpose) => purpose === "repair_chat_turn"),
    ).toHaveLength(1);
    expect(purposes).toEqual(["chat_turn", "repair_chat_turn"]);
  });

  it("settles activation once and never rewinds completed state when the clock moves backward", async () => {
    const created = await createTestApp();
    app = created.app;
    const character = await createAndPublish(app, "daily");
    created.clock.advance({ hours: 14 });

    const first = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(first.statusCode).toBe(200);
    expect(() =>
      ActivateAgentResponseSchema.parse(jsonBody<unknown>(first)),
    ).not.toThrow();
    expect(jsonBody<ActivationBody>(first).settlement.alreadySettled).toBe(
      false,
    );
    const eventCount = app.personasim.store.listActivityEvents(
      character.id,
      500,
    ).length;
    const cursorAfterFirst = app.personasim.store.getCursor(character.id)!;

    const duplicate = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(jsonBody<ActivationBody>(duplicate).settlement.alreadySettled).toBe(
      true,
    );
    expect(
      app.personasim.store.listActivityEvents(character.id, 500),
    ).toHaveLength(eventCount);

    created.clock.advance({ hours: -2 });
    const backward = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(jsonBody<ActivationBody>(backward).settlement.alreadySettled).toBe(
      true,
    );
    expect(app.personasim.store.getCursor(character.id)?.lastSettledAtUtc).toBe(
      cursorAfterFirst.lastSettledAtUtc,
    );
    expect(
      app.personasim.store.listActivityEvents(character.id, 500),
    ).toHaveLength(eventCount);
  });

  it("does not plan or advance an unpublished draft when it has an active connection", async () => {
    const created = await createTestApp();
    app = created.app;
    const generated = await app.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: {
        name: "草稿角色",
        worldSetting: "当代城市生活",
        workOrRole: "学生",
        coreTraits: ["认真", "独立", "温和"],
        centralContradiction: "计划与变化之间的冲突",
        primaryGoal: "完成阶段目标",
        relationshipToUser: "朋友",
        dialogueStyle: "简洁自然",
        tier: "high_fidelity",
        timezone: "Asia/Shanghai",
      },
    });
    const draft = jsonBody<{ character: CharacterSpec }>(generated).character;
    const cursorBefore = structuredClone(
      app.personasim.store.getCursor(draft.id),
    );
    const stateBefore = structuredClone(
      app.personasim.store.getRuntimeState(draft.id),
    );
    created.clock.advance({ hours: 8 });

    const activation = await app.inject({
      method: "POST",
      url: `/api/agents/${draft.id}/activate`,
    });
    expect(activation.statusCode).toBe(200);
    expect(jsonBody<ActivationBody>(activation).settlement.alreadySettled).toBe(
      true,
    );
    expect(app.personasim.store.listSchedule(draft.id)).toHaveLength(0);
    expect(app.personasim.store.getCursor(draft.id)).toEqual(cursorBefore);
    expect(app.personasim.store.getRuntimeState(draft.id)).toEqual(stateBefore);
  });

  it("starts an activity that begins exactly at the initial settlement cursor", async () => {
    const created = await createTestApp();
    app = created.app;
    const character = await createAndPublish(app, "daily");
    app.personasim.store.database
      .prepare("DELETE FROM schedule_items WHERE agent_id = ?")
      .run(character.id);
    const boundaryItem = scheduleItemSchema.parse({
      id: "boundary-activity",
      agentId: character.id,
      title: "即时记录",
      description: "用于验证闭区间起点。",
      category: "other",
      startAtUtc: START_UTC,
      endAtUtc: "2026-08-16T03:00:00.000Z",
      timezone: "Asia/Shanghai",
      status: "planned",
      rigidity: "flexible",
      priority: 0.5,
      source: "manual",
      adherenceProbability: 1,
      narrativeImportance: 0.2,
      shareable: false,
      stateEffects: {},
      revision: 0,
      createdAtUtc: START_UTC,
      updatedAtUtc: START_UTC,
    });
    app.personasim.store.insertScheduleItem(boundaryItem);
    created.clock.advance({ minutes: 30 });

    const activation = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(activation.statusCode).toBe(200);
    expect(app.personasim.store.getScheduleItem(boundaryItem.id)?.status).toBe(
      "in_progress",
    );
    expect(
      app.personasim.store.getRuntimeState(character.id)?.currentActivityId,
    ).toBe(boundaryItem.id);
    expect(
      app.personasim.store
        .listActivityEvents(character.id)
        .some(
          (event) =>
            event.scheduleItemId === boundaryItem.id &&
            event.eventType === "started",
        ),
    ).toBe(true);
  });

  it("commits a shared-activity relationship cause with the settlement trace", async () => {
    const created = await createTestApp();
    app = created.app;
    const character = await createAndPublish(app, "high_fidelity");
    app.personasim.store.database
      .prepare("DELETE FROM schedule_items WHERE agent_id = ?")
      .run(character.id);
    const startAtUtc = "2026-08-16T03:00:00.000Z";
    let itemId = "shared-settlement-0";
    for (let index = 0; index < 100; index += 1) {
      const candidate = `shared-settlement-${index}`;
      if (seededUnit(`${character.id}${candidate}${startAtUtc}`) < 0.9) {
        itemId = candidate;
        break;
      }
    }
    const shared = scheduleItemSchema.parse({
      id: itemId,
      agentId: character.id,
      title: "一起散步",
      description: "用户直接邀请后确认的共同活动。",
      category: "social",
      startAtUtc,
      endAtUtc: "2026-08-16T04:00:00.000Z",
      timezone: "Asia/Shanghai",
      status: "planned",
      rigidity: "fixed",
      priority: 0.8,
      source: "user_invitation",
      adherenceProbability: 1,
      narrativeImportance: 0.6,
      shareable: true,
      stateEffects: { moodValence: 0.08, energy: -0.04 },
      revision: 0,
      createdAtUtc: START_UTC,
      updatedAtUtc: START_UTC,
    });
    app.personasim.store.insertScheduleItem(shared);
    const before = app.personasim.store.getRuntimeState(character.id)!;
    created.clock.setUtc("2026-08-16T04:30:00.000Z");

    const activation = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });

    expect(activation.statusCode).toBe(200);
    const after = app.personasim.store.getRuntimeState(character.id)!;
    expect(after.revision).toBe(before.revision + 1);
    expect(after.relationship).toMatchObject({
      closeness: before.relationship.closeness + 0.006,
      trust: before.relationship.trust + 0.003,
      familiarity: before.relationship.familiarity + 0.002,
      lastInteractionAtUtc: shared.endAtUtc,
    });
    const completed = app.personasim.store
      .listActivityEvents(character.id, 100)
      .find(
        (event) =>
          event.scheduleItemId === shared.id && event.eventType === "completed",
      );
    expect(completed?.effectTrace).toMatchObject({
      reasonCode: "seeded_probability_completed",
      stateRevisionBefore: before.revision,
      stateRevisionAfter: before.revision + 1,
      relationshipSource: "shared_activity_outcome",
      relationship: {
        baselineDelta: { familiarity: 0 },
        appliedProposalDelta: {
          closeness: 0.006,
          trust: 0.003,
          familiarity: 0.002,
        },
      },
      relationshipDailyUsageApplied: {
        closeness: 0.006,
        trust: 0.003,
        familiarity: 0.002,
      },
    });
    expect(typeof completed?.effectTrace?.["outcomeProbability"]).toBe(
      "number",
    );
    expect(completed?.effectTrace?.["outcomeRoll"]).toBeCloseTo(
      seededUnit(`${character.id}${shared.id}${shared.startAtUtc}`),
      12,
    );
    const audit = app.personasim.store
      .listDomainEvents(character.id, 100)
      .find((event) => event.eventType === "simulation.settled");
    expect(audit?.payload).toMatchObject({
      source: "activity_settlement",
      stateRevisionBefore: before.revision,
      stateRevisionAfter: before.revision + 1,
    });
    const auditChanges = (
      audit?.payload as { changes?: Array<Record<string, unknown>> } | undefined
    )?.changes;
    const completedChange = auditChanges?.find(
      (change) => change["activityEventId"] === completed?.id,
    );
    expect(completedChange?.["source"]).toBe("activity_settlement");
    const completedEffectTrace = completedChange?.["effectTrace"] as
      Record<string, unknown> | undefined;
    expect(completedEffectTrace).toMatchObject({
      relationshipSource: "shared_activity_outcome",
      reasonCode: "seeded_probability_completed",
    });
    expect(typeof completedEffectTrace?.["outcomeProbability"]).toBe("number");
    expect(typeof completedEffectTrace?.["outcomeRoll"]).toBe("number");

    const replay = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(jsonBody<ActivationBody>(replay).settlement.alreadySettled).toBe(
      true,
    );
    expect(app.personasim.store.getRuntimeState(character.id)).toEqual(after);
  });

  it("rolls back settlement state, events, and cursor when the final audit fails", async () => {
    const created = await createTestApp();
    app = created.app;
    const character = await createAndPublish(app, "daily");
    app.personasim.store.database
      .prepare("DELETE FROM schedule_items WHERE agent_id = ?")
      .run(character.id);
    const scheduled = scheduleItemSchema.parse({
      id: "settlement-rollback-item",
      agentId: character.id,
      title: "事务结算活动",
      description: "用于验证最终领域事件失败时整体回滚。",
      category: "study",
      startAtUtc: "2026-08-16T03:00:00.000Z",
      endAtUtc: "2026-08-16T04:00:00.000Z",
      timezone: "Asia/Shanghai",
      status: "planned",
      rigidity: "fixed",
      priority: 0.8,
      source: "manual",
      adherenceProbability: 1,
      narrativeImportance: 0.4,
      shareable: false,
      stateEffects: { energy: -0.05 },
      revision: 0,
      createdAtUtc: START_UTC,
      updatedAtUtc: START_UTC,
    });
    app.personasim.store.insertScheduleItem(scheduled);
    const beforeState = app.personasim.store.getRuntimeState(character.id)!;
    const beforeCursor = app.personasim.store.getCursor(character.id)!;
    const insertDomainEvent = app.personasim.store.insertDomainEvent.bind(
      app.personasim.store,
    );
    const auditSpy = vi
      .spyOn(app.personasim.store, "insertDomainEvent")
      .mockImplementation((input) =>
        input.eventType === "simulation.settled"
          ? false
          : insertDomainEvent(input),
      );
    created.clock.setUtc("2026-08-16T04:30:00.000Z");

    const failed = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });

    expect(failed.statusCode).toBe(500);
    expect(app.personasim.store.getRuntimeState(character.id)).toEqual(
      beforeState,
    );
    expect(app.personasim.store.getCursor(character.id)).toEqual(beforeCursor);
    expect(app.personasim.store.getScheduleItem(scheduled.id)?.status).toBe(
      "planned",
    );
    expect(app.personasim.store.listActivityEvents(character.id)).toEqual([]);
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM settlements WHERE agent_id = ?")
        .get(character.id),
    ).toEqual({ count: 0 });

    auditSpy.mockRestore();
    const retry = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(retry.statusCode).toBe(200);
    expect(app.personasim.store.getScheduleItem(scheduled.id)?.status).toBe(
      "completed",
    );
  });

  it("keeps proactive messages disabled for high-fidelity characters", async () => {
    const created = await createTestApp();
    app = created.app;
    const character = await createAndPublish(app, "high_fidelity");
    const startAtUtc = "2026-08-16T06:00:00.000Z";
    let id = "shareable-trip-0";
    for (let index = 0; index < 100; index += 1) {
      const candidateId = `shareable-trip-${index}`;
      if (seededUnit(`${character.id}${candidateId}${startAtUtc}`) < 0.5) {
        id = candidateId;
        break;
      }
    }
    const nowUtc = created.clock.nowUtc();
    const shareable = scheduleItemSchema.parse({
      id,
      agentId: character.id,
      title: "短途旅行",
      description: "去附近的旧城区走走。",
      category: "travel",
      startAtUtc,
      endAtUtc: "2026-08-16T07:00:00.000Z",
      timezone: "Asia/Shanghai",
      status: "planned",
      rigidity: "fixed",
      priority: 0.9,
      source: "manual",
      adherenceProbability: 1,
      narrativeImportance: 0.95,
      shareable: true,
      stateEffects: { moodValence: 0.12, energy: -0.08 },
      revision: 0,
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    });
    app.personasim.store.insertScheduleItem(shareable);
    await createSession(app, character.id);
    created.clock.setUtc("2026-08-16T07:30:00.000Z");

    const activation = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(activation.statusCode).toBe(200);
    const activationBody = jsonBody<ActivationBody>(activation);
    expect(activationBody.capabilities?.proactiveDialogue).toBe(false);
    expect(activationBody.proactiveMessage).toBeUndefined();
    const candidates = app.personasim.store.database
      .prepare(
        "SELECT COUNT(*) AS count FROM proactive_candidates WHERE agent_id = ?",
      )
      .get(character.id) as { count: number };
    expect(candidates.count).toBe(0);
    const proactiveMessages = app.personasim.store.database
      .prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE agent_id = ? AND message_kind = 'assistant_proactive'",
      )
      .get(character.id) as { count: number };
    expect(proactiveMessages.count).toBe(0);
    const proactiveCalls = app.personasim.store.database
      .prepare(
        "SELECT COUNT(*) AS count FROM llm_calls WHERE agent_id = ? AND purpose = 'compose_proactive_message'",
      )
      .get(character.id) as { count: number };
    expect(proactiveCalls.count).toBe(0);

    await expect(
      app.personasim.proactiveDelivery.deliverNext(character.id),
    ).resolves.toEqual({
      status: "not_claimed",
      reasonCode: "tier_not_supported",
    });

    const repeated = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(jsonBody<ActivationBody>(repeated).proactiveMessage).toBeUndefined();
  });

  it("supports health, normalized errors and JSON character import without exposing secrets", async () => {
    ({ app } = await createTestApp());
    expect(
      (await app.inject({ method: "GET", url: "/api/health" })).statusCode,
    ).toBe(200);

    const imported = await app.inject({
      method: "POST",
      url: "/api/characters/import",
      payload: {
        name: "顾言",
        workTitle: "示例作品",
        storyStage: "第一幕结束后",
        tier: "lightweight",
        timezone: "Asia/Shanghai",
        sourceText:
          "顾言在雨夜拒绝了不合理的请求，并明确表示会保护同行者。".repeat(3),
        sourceTitle: "sample.md",
      },
    });
    expect(imported.statusCode).toBe(201);
    expect(
      jsonBody<{ character: { sourceType: string } }>(imported).character
        .sourceType,
    ).toBe("imported_character");

    const settings = await app.inject({ method: "GET", url: "/api/settings" });
    expect(settings.body).not.toContain("apiKey");
    expect(settings.body).not.toContain("authorization");
    expect(
      jsonBody<{
        runtime: {
          correspondenceMode: string;
          correspondenceExecution: string;
          keepsakeMode: string;
        };
      }>(settings).runtime,
    ).toMatchObject({
      correspondenceMode: "off",
      correspondenceExecution: "lazy",
      keepsakeMode: "off",
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: {},
    });
    expect(invalid.statusCode).toBe(400);
    const invalidBody = jsonBody<{
      error: { code: string; message: string; requestId: string };
    }>(invalid);
    expect(invalidBody.error.code).toBe("validation_error");
    expect(invalidBody.error.message.length).toBeGreaterThan(0);
    expect(invalidBody.error.requestId.length).toBeGreaterThan(0);
  });

  it("accepts original form values at every guaranteed CharacterSpec boundary", async () => {
    ({ app } = await createTestApp());
    const input = {
      name: "N".repeat(120),
      worldSetting: "W".repeat(4_000),
      workOrRole: "R".repeat(240),
      coreTraits: ["A".repeat(120), "B".repeat(120), "C".repeat(120)],
      coreContradiction: "C".repeat(500),
      mainGoal: "G".repeat(160),
      initialRelationship: "L".repeat(120),
      dialogueStyle: "D".repeat(500),
      tier: "daily",
      timezone: "Asia/Shanghai",
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: input,
    });

    expect(response.statusCode).toBe(201);
    const character = jsonBody<{ character: CharacterSpec }>(
      response,
    ).character;
    expect(character.identity).toMatchObject({
      name: input.name,
      worldSetting: input.worldSetting,
      workOrRole: input.workOrRole,
    });
    expect(character.persona.contradictions[0]?.sideA).toBe(
      input.coreContradiction,
    );
    expect(character.persona.goals[0]?.title).toBe(input.mainGoal);
    expect(character.userRelationship.relationshipType).toBe(
      input.initialRelationship,
    );
    expect(character.knowledge.knownFacts).toContain(
      `作者指定语言风格：${input.dialogueStyle}`,
    );
  });

  it("keeps a valid 500 KiB boundary import within a bounded live-model prompt", async () => {
    ({ app } = await createTestApp());
    let capturedPrompt = "";
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        capturedPrompt = input.prompt;
        if (input.fixture === undefined) {
          throw new Error("Expected an import fixture");
        }
        return Promise.resolve(input.fixture);
      },
    );
    const evidence = "CHARACTER_BOUNDARY_EVIDENCE";
    const sourceText = `${"A".repeat(256_000)}${evidence}${"B".repeat(
      512_000 - 256_000 - evidence.length,
    )}`;
    const input = {
      characterName: "N".repeat(120),
      workTitle: "W".repeat(200),
      storyStage: "S".repeat(240),
      tier: "daily",
      timezone: "Asia/Shanghai",
      sourceText,
      sourceFormat: "md",
      fileName: `${"f".repeat(197)}.md`,
    };
    const response = await app.inject({
      method: "POST",
      url: "/api/characters/import",
      payload: input,
    });

    expect(response.statusCode).toBe(201);
    expect(capturedPrompt.length).toBeLessThan(70_000);
    expect(capturedPrompt).toContain(evidence);
    const character = jsonBody<{ character: CharacterSpec }>(
      response,
    ).character;
    expect(character.identity.name).toBe(input.characterName);
    expect(character.sources[0]).toMatchObject({
      label: input.fileName,
      workTitle: input.workTitle,
      locator: input.storyStage,
    });
  });

  it("accepts a legal 500 KiB source after JSON escaping expands the request beyond 600 KB", async () => {
    ({ app } = await createTestApp());
    const llm = vi.spyOn(app.personasim.llm, "generateObject");
    const sourceText = '"'.repeat(512_000);
    const input = {
      characterName: "转义边界角色",
      workTitle: "转义边界作品",
      storyStage: "开场",
      tier: "daily",
      timezone: "Asia/Shanghai",
      sourceText,
      sourceFormat: "pasted_text",
    };

    expect(Buffer.byteLength(sourceText, "utf8")).toBe(512_000);
    expect(Buffer.byteLength(JSON.stringify(input), "utf8")).toBeGreaterThan(
      600_000,
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/characters/import",
      payload: input,
    });

    expect(response.statusCode).toBe(201);
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it("rejects form values above server-guaranteed boundaries before calling the LLM", async () => {
    ({ app } = await createTestApp());
    const llm = vi.spyOn(app.personasim.llm, "generateObject");
    const original = {
      name: "边界角色",
      worldSetting: "边界世界",
      workOrRole: "边界职业",
      coreTraits: ["谨慎", "坦率", "坚定"],
      coreContradiction: "责任与自由",
      mainGoal: "完成目标",
      initialRelationship: "初识",
      dialogueStyle: "简洁",
      tier: "daily",
      timezone: "Asia/Shanghai",
    };
    const invalidOriginals: Array<Record<string, unknown>> = [
      { ...original, coreContradiction: "C".repeat(501) },
      { ...original, mainGoal: "G".repeat(161) },
      { ...original, initialRelationship: "R".repeat(121) },
      { ...original, dialogueStyle: "D".repeat(501) },
    ];
    const imported = {
      characterName: "边界角色",
      workTitle: "边界作品",
      storyStage: "开场",
      tier: "daily",
      timezone: "Asia/Shanghai",
      sourceText: "边界角色在开场做出了明确选择。",
      sourceFormat: "pasted_text",
    };
    const invalidImports: Array<Record<string, unknown>> = [
      { ...imported, workTitle: "W".repeat(201) },
      { ...imported, storyStage: "S".repeat(241) },
      {
        ...imported,
        sourceFormat: "md",
        fileName: `${"f".repeat(198)}.md`,
      },
      { ...imported, sourceText: '"'.repeat(512_001) },
    ];

    for (const payload of invalidOriginals) {
      const response = await app.inject({
        method: "POST",
        url: "/api/characters/generate",
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(jsonBody<{ error: { code: string } }>(response).error.code).toBe(
        "validation_error",
      );
    }
    for (const payload of invalidImports) {
      const response = await app.inject({
        method: "POST",
        url: "/api/characters/import",
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(jsonBody<{ error: { code: string } }>(response).error.code).toBe(
        "validation_error",
      );
    }
    expect(llm).not.toHaveBeenCalled();
  });

  it("restores authoritative form fields and rejects model-invented source references", async () => {
    ({ app } = await createTestApp());
    const originalInput: OriginalCharacterInput = {
      name: "权威姓名",
      worldSetting: "权威世界",
      workOrRole: "权威职业",
      coreTraits: ["谨慎", "坦率", "坚定"],
      coreContradiction: "责任与自由之间的冲突",
      mainGoal: "完成权威目标",
      initialRelationship: "初识",
      dialogueStyle: "简洁",
      tier: "daily",
      timezone: "Asia/Shanghai",
    };
    const importedInput: ImportedCharacterInput = {
      characterName: "正典姓名",
      workTitle: "权威作品",
      storyStage: "第二章结束",
      tier: "lightweight",
      timezone: "Asia/Tokyo",
      sourceText: "正典姓名在第二章结束时选择保护同伴。".repeat(5),
      sourceFormat: "md",
      fileName: "canon.md",
    };
    const maliciousOriginal = buildOriginalDraft(originalInput);
    maliciousOriginal.identity.name = "模型改名";
    maliciousOriginal.identity.timezone = "UTC";
    maliciousOriginal.tier = "high_fidelity";
    maliciousOriginal.persona.traits[0]!.name = "模型替换特质";
    maliciousOriginal.persona.traits[0]!.description =
      "这段模型生成的可观察描述应被保留。";
    maliciousOriginal.persona.traits[0]!.sourceRefs = ["invented-source"];
    maliciousOriginal.persona.contradictions[0]!.sideA = "模型替换矛盾";
    maliciousOriginal.persona.goals[0]!.title = "模型替换目标";
    maliciousOriginal.persona.values[0]!.description = "模型替换目标";
    maliciousOriginal.userRelationship.relationshipType = "模型替换关系";
    maliciousOriginal.knowledge.knownFacts = [];
    maliciousOriginal.persona.traits.push({
      ...structuredClone(maliciousOriginal.persona.traits[0]!),
      id: "model-added-trait",
      name: "模型新增伪用户特质",
      origin: "user_spec",
      sourceRefs: ["invented-source"],
    });
    maliciousOriginal.persona.values.push({
      ...structuredClone(maliciousOriginal.persona.values[0]!),
      id: "model-added-value",
      name: "模型新增伪用户价值",
      origin: "user_spec",
      sourceRefs: ["invented-source"],
    });
    maliciousOriginal.persona.contradictions.push({
      ...structuredClone(maliciousOriginal.persona.contradictions[0]!),
      id: "model-added-contradiction",
      sideA: "模型新增伪用户矛盾",
      origin: "user_spec",
    });
    maliciousOriginal.persona.goals.push({
      ...structuredClone(maliciousOriginal.persona.goals[0]!),
      id: "model-added-goal",
      title: "模型新增伪用户目标",
      origin: "user_spec",
      sourceRefs: ["invented-source"],
    });
    maliciousOriginal.persona.preferences.push({
      ...structuredClone(maliciousOriginal.persona.preferences[0]!),
      id: "model-added-preference",
      subject: "模型新增伪用户偏好",
      origin: "user_spec",
      sourceRefs: ["invented-source"],
    });
    const maliciousImported = buildImportedDraft(importedInput);
    maliciousImported.identity.name = "错误角色";
    maliciousImported.identity.worldSetting = "错误作品";
    maliciousImported.tier = "high_fidelity";
    maliciousImported.persona.traits[0]!.description =
      "这段导入抽取描述应被保留。";
    maliciousImported.persona.traits[0]!.sourceRefs = ["invented-source"];
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        if (input.purpose === "compile_character") {
          return Promise.resolve({
            draft: maliciousOriginal,
            reasonCode: "fixture_character_compilation",
            reasonSummary: "恶意覆盖测试。",
          });
        }
        return Promise.resolve({
          draft: maliciousImported,
          reasonCode: "fixture_character_import",
          reasonSummary: "恶意导入覆盖测试。",
        });
      },
    );

    const generatedResponse = await app.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: originalInput,
    });
    expect(generatedResponse.statusCode).toBe(201);
    const generated = jsonBody<{ character: CharacterSpec }>(
      generatedResponse,
    ).character;
    expect(generated.identity).toMatchObject({
      name: originalInput.name,
      timezone: originalInput.timezone,
      workOrRole: originalInput.workOrRole,
      worldSetting: originalInput.worldSetting,
    });
    expect(generated.tier).toBe("daily");
    expect(
      generated.persona.traits.slice(0, 3).map((trait) => trait.name),
    ).toEqual(originalInput.coreTraits);
    expect(
      generated.persona.traits
        .slice(0, 3)
        .every(
          (trait) =>
            trait.origin === "user_spec" &&
            trait.sourceRefs.length === 1 &&
            trait.sourceRefs[0] === "original-form",
        ),
    ).toBe(true);
    expect(generated.persona.traits[0]?.description).toBe(
      "这段模型生成的可观察描述应被保留。",
    );
    expect(generated.persona.contradictions[0]?.sideA).toBe(
      originalInput.coreContradiction,
    );
    expect(generated.persona.contradictions[0]?.origin).toBe("user_spec");
    expect(generated.persona.goals[0]?.title).toBe(originalInput.mainGoal);
    expect(generated.persona.goals[0]).toMatchObject({
      origin: "user_spec",
      sourceRefs: ["original-form"],
    });
    expect(generated.persona.values[0]?.description).toBe(
      originalInput.mainGoal,
    );
    expect(generated.persona.values[0]).toMatchObject({
      origin: "user_spec",
      sourceRefs: ["original-form"],
    });
    expect(generated.userRelationship.relationshipType).toBe(
      originalInput.initialRelationship,
    );
    expect(generated.knowledge.knownFacts).toContain(
      `作者指定语言风格：${originalInput.dialogueStyle}`,
    );
    expect(generated.sources).toContainEqual(
      expect.objectContaining({
        id: "original-form",
        sourceType: "user_spec",
      }),
    );
    expect(
      generated.persona.traits.find((rule) => rule.id === "model-added-trait"),
    ).toMatchObject({
      origin: "model_inference",
      sourceRefs: ["original-form"],
    });
    expect(
      generated.persona.values.find((rule) => rule.id === "model-added-value"),
    ).toMatchObject({
      origin: "model_inference",
      sourceRefs: ["original-form"],
    });
    expect(
      generated.persona.contradictions.find(
        (rule) => rule.id === "model-added-contradiction",
      )?.origin,
    ).toBe("model_inference");
    expect(
      generated.persona.goals.find((rule) => rule.id === "model-added-goal"),
    ).toMatchObject({
      origin: "model_inference",
      sourceRefs: ["original-form"],
    });
    expect(
      generated.persona.preferences.find(
        (rule) => rule.id === "model-added-preference",
      ),
    ).toMatchObject({
      origin: "model_inference",
      sourceRefs: ["original-form"],
    });
    expectSourceRefsResolve(generated);

    const invalidDraft = structuredClone(generated);
    invalidDraft.persona.traits[0]!.sourceRefs = ["unknown-source"];
    const invalidUpdate = await app.inject({
      method: "PATCH",
      url: `/api/characters/${generated.id}`,
      payload: { spec: invalidDraft, expectedVersion: generated.version },
    });
    expect(invalidUpdate.statusCode).toBe(422);
    expect(
      jsonBody<{ error: { code: string } }>(invalidUpdate).error.code,
    ).toBe("invalid_source_ref");

    const importedResponse = await app.inject({
      method: "POST",
      url: "/api/characters/import",
      payload: importedInput,
    });
    expect(importedResponse.statusCode).toBe(201);
    const imported = jsonBody<{ character: CharacterSpec }>(
      importedResponse,
    ).character;
    expect(imported.identity.name).toBe(importedInput.characterName);
    expect(imported.identity.timezone).toBe(importedInput.timezone);
    expect(imported.identity.worldSetting).toContain(importedInput.workTitle);
    expect(imported.identity.worldSetting).toContain(importedInput.storyStage);
    expect(imported.tier).toBe("lightweight");
    expect(imported.persona.traits[0]?.description).toBe(
      "这段导入抽取描述应被保留。",
    );
    expect(imported.sources[0]).toMatchObject({
      workTitle: importedInput.workTitle,
      locator: importedInput.storyStage,
    });
    expect(imported.sources[0]?.checksum).toMatch(/^[a-f0-9]{64}$/);
    expectSourceRefsResolve(imported);
    expect(app.personasim.store.listCharacterSources(imported.id)).toHaveLength(
      1,
    );
  });

  it("rolls back imported character initialization when source persistence fails", async () => {
    ({ app } = await createTestApp());
    app.personasim.store.database.exec(
      `CREATE TRIGGER reject_character_source
       BEFORE INSERT ON character_sources
       BEGIN
         SELECT RAISE(ABORT, 'source rejected');
       END`,
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/characters/import",
      payload: {
        characterName: "事务角色",
        workTitle: "事务作品",
        storyStage: "开场",
        tier: "daily",
        timezone: "Asia/Shanghai",
        sourceText: "事务角色在开场做出了明确选择。".repeat(5),
        sourceFormat: "pasted_text",
      },
    });
    expect(response.statusCode).toBe(500);
    expect(app.personasim.store.countCharacters()).toBe(0);
    const sources = app.personasim.store.database
      .prepare("SELECT COUNT(*) AS count FROM character_sources")
      .get() as { count: number };
    expect(sources.count).toBe(0);
  });

  it("disposes the composed kernel and database when app construction fails", async () => {
    const database = openDatabase(":memory:");
    runMigrations(database);
    database.exec(
      `CREATE TRIGGER reject_seed_character
       BEFORE INSERT ON characters
       BEGIN
         SELECT RAISE(ABORT, 'seed rejected');
       END`,
    );
    const config = readConfig({
      nodeEnv: "test",
      profile: "test",
      databasePath: ":memory:",
      clockMode: "fake",
      seedDemo: true,
      developerRoutes: true,
      lifePlanningMode: "legacy_exact",
      scheduleNegotiationMode: "legacy",
      llm: {
        provider: "fixture",
        baseUrl: "https://example.invalid",
        model: "personasim-fixture-v1",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
    });

    await expect(
      buildApp({
        config,
        database,
        clock: new FakeClock(START_UTC),
        seedDemo: true,
        startScheduler: false,
        logger: false,
      }),
    ).rejects.toThrow("seed rejected");
    expect(database.open).toBe(false);
  });
});

async function createTestApp(
  liveWorldEffectsMode?: "off" | "shadow" | "enforced",
): Promise<{
  app: PersonaSimApp;
  clock: FakeClock;
}> {
  const clock = new FakeClock(START_UTC);
  const config = readConfig({
    nodeEnv: "test",
    profile: "test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    lifePlanningMode: "legacy_exact",
    scheduleNegotiationMode: "legacy",
    ...(liveWorldEffectsMode === undefined ? {} : { liveWorldEffectsMode }),
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
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
  return { app, clock };
}

async function createAndPublish(
  app: PersonaSimApp,
  tier: "lightweight" | "daily" | "high_fidelity",
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
      tier,
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
  return PublishCharacterResponseSchema.parse(jsonBody<unknown>(published))
    .character;
}

type ActivationBody = {
  settlement: { alreadySettled: boolean };
  proactiveMessage?: { messageKind: string };
  capabilities?: {
    offlineSettlement: boolean;
    proactiveDialogue: boolean;
  };
};

function jsonBody<T>(response: { body: string }): T {
  const parsed: unknown = JSON.parse(response.body);
  return parsed as T;
}

function jsonText<T>(value: string): T {
  const parsed: unknown = JSON.parse(value);
  return parsed as T;
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

function expectSourceRefsResolve(spec: CharacterSpec): void {
  const sourceIds = new Set(spec.sources.map((source) => source.id));
  const rules = [
    ...spec.persona.traits,
    ...spec.persona.values,
    ...spec.persona.goals,
    ...spec.persona.preferences,
  ];
  for (const rule of rules) {
    expect(rule.sourceRefs.every((sourceId) => sourceIds.has(sourceId))).toBe(
      true,
    );
  }
}
