import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DailyLifeContextSchema,
  PressureEpisodeSchema,
  type PressureEpisode,
} from "@personasim/contracts";
import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { LifeRepository } from "../repositories/life-repository.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";
import qwen from "../test-fixtures/qwen-fresh-regressions.json";
import { PressureEvidenceCorrectionService } from "./pressure-evidence-correction-service.js";

const START = "2026-09-07T00:00:00.000Z";
const NOW = "2026-09-07T04:00:00.000Z";
describe("pressure evidence correction on a real database", () => {
  let db: Database;
  let store: DatabaseStore;
  let repo: LifeRepository;
  let correction: PressureEvidenceCorrectionService;
  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    db.prepare(
      `INSERT INTO characters(id,current_version,status,tier,name,source_type,created_at_utc,updated_at_utc)
      VALUES ('agent-1',1,'published','daily','角色','original',?,?)`,
    ).run(START, START);
    db.prepare(
      "INSERT INTO sessions(id,agent_id,title,created_at_utc,updated_at_utc) VALUES ('session-1','agent-1','测试',?,?)",
    ).run(START, START);
    store = new DatabaseStore(db);
    repo = new LifeRepository(db);
    correction = new PressureEvidenceCorrectionService(store);
  });
  afterEach(() => db.close());

  function message(id: string, content: string, hour = 0) {
    db.prepare(
      `INSERT INTO messages(id,session_id,agent_id,role,content,message_kind,created_at_utc)
      VALUES (?,'session-1','agent-1','assistant',?,'assistant_reply',?)`,
    ).run(id, content, START.replace("T00", `T0${hour}`));
  }
  function episode(overrides: Partial<PressureEpisode> = {}): PressureEpisode {
    return PressureEpisodeSchema.parse({
      id: "pressure-1",
      agentId: "agent-1",
      sessionId: "session-1",
      subject: "character",
      pressureKind: "work",
      triggerSummary: "这时你的疲惫是合理的生理反应",
      status: "open",
      initialPressure: 0.72,
      currentPressure: 0.72,
      initialClarity: 0.45,
      currentClarity: 0.45,
      initialFeltUnderstood: 0.2,
      currentFeltUnderstood: 0.2,
      interventionIds: [],
      outcomeIds: [],
      sourceMessageIds: ["bad"],
      latestEvidenceMessageId: "bad",
      effectiveLocalDate: "2026-09-07",
      effectivePeriod: "morning",
      temporalPrecision: "period",
      recordedAtUtc: START,
      updatedAtUtc: START,
      idempotencyKey: "pressure-source-1",
      schemaVersion: 1,
      ...overrides,
    });
  }
  function correct() {
    return correction.correct({
      agentId: "agent-1",
      pressureEpisodeId: "pressure-1",
      sourceMessageIds: ["bad"],
      reason: "listener fatigue was attributed to the character",
      nowUtc: NOW,
    });
  }

  it("retains the original record and message while excluding the invalid current projection and daily reference", () => {
    message("bad", qwen.pressure.assistantText);
    const before = episode();
    repo.insertPressure(before);
    const context = DailyLifeContextSchema.parse({
      id: "day-1",
      agentId: "agent-1",
      localDate: "2026-09-07",
      timezone: "Asia/Shanghai",
      status: "active",
      currentPeriod: "morning",
      availability: "interruptible",
      availabilityConfidence: "observed",
      todayFocus: ["休息"],
      intentIds: ["intent-1"],
      activeThreadIds: [],
      currentPressureEpisodeIds: [before.id],
      recentOutcomeIds: [],
      revision: 1,
      schemaVersion: 1,
      createdAtUtc: START,
      updatedAtUtc: START,
    });
    repo.insertDailyContext(context);
    expect(correct()).toMatchObject({
      changed: true,
      projection: "invalidated",
      dependencies: { dailyContextIds: ["day-1"] },
    });
    expect(repo.listOpenPressures("agent-1")).toEqual([]);
    expect(repo.listPressures("agent-1")).toEqual([]);
    expect(repo.findPressure("agent-1", before.id)).toBeUndefined();
    expect(
      repo.findPressure("agent-1", before.id, { includeInvalidated: true }),
    ).toEqual(before);
    expect(
      repo.findDailyContext("agent-1", "2026-09-07")?.currentPressureEpisodeIds,
    ).toEqual([]);
    repo.updateDailyContext({ ...context, updatedAtUtc: NOW });
    expect(
      repo.findDailyContext("agent-1", "2026-09-07")?.currentPressureEpisodeIds,
    ).toEqual([]);
    expect(() => repo.updatePressure(before)).toThrow(/invalidated/u);
    expect(() => repo.insertPressure(before)).toThrow(/invalidated/u);
    expect(() =>
      repo.insertPressure({
        ...before,
        id: "replayed-pressure",
        idempotencyKey: "replayed-pressure-key",
      }),
    ).toThrow(/invalidated/u);
    expect(correct().changed).toBe(false);
    expect(
      db
        .prepare("SELECT COUNT(*) AS count FROM pressure_evidence_corrections")
        .get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT content FROM messages WHERE id = 'bad'").get(),
    ).toEqual({ content: qwen.pressure.assistantText });
  });

  it("replays valid absolute scales and feedback without carrying an invalid middle contribution", () => {
    message("good-1", "我的压力是 6/10。", 0);
    message("bad", qwen.pressure.assistantText, 1);
    message("good-2", "我的压力是 4/10。", 2);
    message("good-3", "你的陪伴让我觉得被听见。", 3);
    const first = episode({
      sourceMessageIds: ["good-1"],
      latestEvidenceMessageId: "good-1",
      triggerSummary: "我的压力是 6/10",
      initialPressure: 0.6,
      currentPressure: 0.6,
    });
    repo.insertPressure(first);
    const bad = {
      ...first,
      currentPressure: 0.9,
      sourceMessageIds: ["good-1", "bad"],
      latestEvidenceMessageId: "bad",
      updatedAtUtc: START.replace("T00", "T01"),
    };
    repo.updatePressure(bad);
    const good = {
      ...bad,
      currentPressure: 0.4,
      sourceMessageIds: [...bad.sourceMessageIds, "good-2"],
      latestEvidenceMessageId: "good-2",
      updatedAtUtc: START.replace("T00", "T02"),
    };
    repo.updatePressure(good);
    repo.updatePressure({
      ...good,
      currentFeltUnderstood: 0.4,
      sourceMessageIds: [...good.sourceMessageIds, "good-3"],
      latestEvidenceMessageId: "good-3",
      updatedAtUtc: START.replace("T00", "T03"),
    });
    const validity = new MemoryValidityRepository(store);
    for (const [index, sourceId] of ["good-1", "good-3"].entries()) {
      store.insertDomainEvent({
        agentId: "agent-1",
        streamType: "pressure_episode",
        streamId: "pressure-1",
        streamVersion: index + 1,
        eventType: "life.pressure_updated_from_character_evidence",
        recordedAtUtc: START,
        payload: { after: { latestEvidenceMessageId: sourceId } },
        causationId: sourceId,
        idempotencyKey: `pressure-${sourceId}`,
      });
      const eventId = (
        db
          .prepare("SELECT id FROM domain_events WHERE idempotency_key = ?")
          .get(`pressure-${sourceId}`) as { id: string }
      ).id;
      validity.registerDependencies({
        agentId: "agent-1",
        derivedType: "test_summary",
        derivedId: sourceId,
        sources: [validity.readSource("agent-1", "domain_event", eventId)!],
        nowUtc: START,
      });
    }
    expect(correct()).toMatchObject({
      projection: "active",
      retainedSourceMessageIds: ["good-1", "good-2", "good-3"],
    });
    expect(repo.findPressure("agent-1", first.id)).toMatchObject({
      initialPressure: 0.6,
      currentPressure: 0.4,
      sourceMessageIds: ["good-1", "good-2", "good-3"],
    });
    expect(
      repo.findPressure("agent-1", first.id)?.currentFeltUnderstood,
    ).toBeCloseTo(0.4);
    expect(validity.isDerivedCurrent("agent-1", "test_summary", "good-1")).toBe(
      true,
    );
    expect(validity.isDerivedCurrent("agent-1", "test_summary", "good-3")).toBe(
      false,
    );
    const audit = db
      .prepare("SELECT before_json FROM pressure_evidence_corrections")
      .get() as { before_json: string };
    expect(
      PressureEpisodeSchema.parse(JSON.parse(audit.before_json))
        .sourceMessageIds,
    ).toContain("bad");
    expect(() => repo.updatePressure(good)).toThrow(/invalidated/u);
  });

  it("reconstructs a legacy mixed-source row from the retained real self report", () => {
    message("bad", qwen.pressure.assistantText);
    message("good", "我最近压力是 3/10，清晰度是 7/10。", 1);
    message("valid-action", "我今天提交了申请。", 2);
    repo.insertPressure(
      episode({
        sourceMessageIds: ["bad", "good", "valid-action"],
        latestEvidenceMessageId: "good",
        currentPressure: 0.95,
      }),
    );
    db.prepare("DELETE FROM pressure_contribution_journal").run();
    expect(correct()).toMatchObject({
      projection: "active",
      retainedSourceMessageIds: ["good", "valid-action"],
    });
    expect(repo.listOpenPressures("agent-1")[0]).toMatchObject({
      sourceMessageIds: ["good", "valid-action"],
      currentPressure: 0.3,
      currentClarity: 0.7,
      metricOrigin: "explicit_self_report",
    });
    expect(repo.listOpenPressures("agent-1")[0]?.triggerSummary).not.toContain(
      "你的疲惫",
    );
  });

  it("does not regrant a retained journal source whose stored message has changed", () => {
    message("good", "我的压力是 6/10。");
    message("bad", qwen.pressure.assistantText, 1);
    const first = episode({
      sourceMessageIds: ["good"],
      latestEvidenceMessageId: "good",
    });
    repo.insertPressure(first);
    repo.updatePressure({
      ...first,
      sourceMessageIds: ["good", "bad"],
      latestEvidenceMessageId: "bad",
    });
    db.prepare(
      "UPDATE messages SET content = '我的压力是 8/10。' WHERE id = 'good'",
    ).run();
    expect(correct().projection).toBe("invalidated");
  });

  it("invalidates only actual pressure-event dependencies and blocks reindex regrant, leaving same-message facts current", () => {
    message("bad", qwen.pressure.assistantText);
    repo.insertPressure(episode());
    store.insertDomainEvent({
      agentId: "agent-1",
      streamType: "pressure_episode",
      streamId: "pressure-1",
      streamVersion: 1,
      eventType: "life.pressure_disclosed_by_character",
      recordedAtUtc: START,
      payload: { pressure: 0.72 },
      causationId: "bad",
      idempotencyKey: "old-pressure-event",
    });
    const event = db
      .prepare(
        "SELECT id FROM domain_events WHERE idempotency_key = 'old-pressure-event'",
      )
      .get() as { id: string };
    const validity = new MemoryValidityRepository(store);
    const eventSource = validity.readSource(
      "agent-1",
      "domain_event",
      event.id,
    )!;
    const messageSource = validity.readSource("agent-1", "message", "bad")!;
    expect(
      validity.registerDependencies({
        agentId: "agent-1",
        derivedType: "test_pressure_summary",
        derivedId: "pressure-summary",
        sources: [eventSource],
        nowUtc: START,
      }),
    ).toBe(true);
    expect(
      validity.registerDependencies({
        agentId: "agent-1",
        derivedType: "test_other_fact",
        derivedId: "independent-fact",
        sources: [messageSource],
        nowUtc: START,
      }),
    ).toBe(true);
    const result = correct();
    expect(result.dependencies.derivedArtifacts).toEqual([
      { derivedType: "test_pressure_summary", derivedId: "pressure-summary" },
    ]);
    expect(
      validity.isDerivedCurrent(
        "agent-1",
        "test_pressure_summary",
        "pressure-summary",
      ),
    ).toBe(false);
    expect(
      validity.isDerivedCurrent(
        "agent-1",
        "test_other_fact",
        "independent-fact",
      ),
    ).toBe(true);
    expect(validity.readSource("agent-1", "message", "bad")).toEqual(
      messageSource,
    );
    expect(
      validity.readSource("agent-1", "domain_event", event.id),
    ).toBeUndefined();
    expect(
      validity.registerDependencies({
        agentId: "agent-1",
        derivedType: "test_pressure_summary",
        derivedId: "rebuilt-summary",
        sources: [eventSource],
        nowUtc: NOW,
      }),
    ).toBe(false);
  });
});
