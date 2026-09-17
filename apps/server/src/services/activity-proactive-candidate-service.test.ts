import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DailyLifeIntent, LifeOutcome } from "@personasim/contracts";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { buildOriginalDraft, initialRuntimeState } from "../domain/defaults.js";
import { characterSpecSchema, type CharacterSpec } from "../domain/schemas.js";
import { LifeRepository } from "../repositories/life-repository.js";
import { FakeClock } from "../runtime/clock.js";
import { persistFuzzyLifeActivityCandidate } from "./activity-proactive-candidate-service.js";
import { FuzzyLifeService } from "./fuzzy-life-service.js";
import { ProactiveGenerationRepository } from "./proactive-generation-repository.js";
import { buildDeterministicLifeOutcome } from "./fuzzy-life-planning.js";

const NOW = "2026-09-02T04:00:00.000Z";
const CREATED = "2026-09-01T04:00:00.000Z";

describe("activity proactive candidate persistence", () => {
  let database: Database;
  let store: DatabaseStore;
  let spec: CharacterSpec;
  let life: FuzzyLifeService;
  let intent: DailyLifeIntent;
  let outcome: LifeOutcome;
  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    store = new DatabaseStore(database);
    const draft = buildOriginalDraft({
      name: "生活分享角色",
      worldSetting: "当代城市",
      workOrRole: "插画师",
      coreTraits: ["温和", "独立"],
      coreContradiction: "稳定与变化",
      mainGoal: "完成一幅画",
      initialRelationship: "朋友",
      dialogueStyle: "自然简洁",
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    });
    spec = characterSpecSchema.parse({
      ...draft,
      id: "proactive-life",
      version: 1,
      status: "published",
      createdAtUtc: CREATED,
      updatedAtUtc: CREATED,
      proactivePolicy: {
        ...draft.proactivePolicy,
        enabled: true,
        minimumCloseness: 0,
        shareableCategories: [
          "work",
          "study",
          "creative",
          "health",
          "rest",
          "social",
          "leisure",
          "self_reflection",
          "other",
        ],
      },
    });
    store.insertCharacter(spec);
    store.insertInitialState(initialRuntimeState(spec.id, CREATED, spec), NOW);
    life = new FuzzyLifeService(
      store,
      new LifeRepository(database),
      new FakeClock(CREATED),
    );
    intent = {
      ...life.ensureToday(spec.id).intents[0]!,
      shareable: true,
      importance: 0.2,
    };
    outcome = buildDeterministicLifeOutcome({
      agentId: spec.id,
      intent,
      evidenceId: "evidence-completed",
      effectiveLocalDate: "2026-09-01",
      recordedAtUtc: NOW,
      outcomeKind: "completed",
    });
  });
  afterEach(() => database.close());

  const candidates = (database: Database) =>
    database
      .prepare("SELECT * FROM proactive_candidates ORDER BY rowid")
      .all() as Array<{
      id: string;
      trigger_event_id: string;
      draft_message: string | null;
      summary: string;
      earliest_at_utc: string;
      cooldown_key: string;
    }>;

  it("projects only evidenced completed facts without exact schedules or drafts", () => {
    expect(
      persistFuzzyLifeActivityCandidate({
        store,
        spec,
        intent,
        outcome,
        nowUtc: NOW,
      }),
    ).toBe(true);
    const candidate = candidates(database)[0]!;
    expect(candidate.draft_message).toBeNull();
    expect(candidate.summary).toContain("2026-09-01（当天）");
    expect(candidate.summary).toContain(outcome.summary);
    const event = store.listActivityEvents(spec.id)[0]!;
    expect(event.id).toBe(candidate.trigger_event_id);
    expect(event.scheduleItemId).toBeUndefined();
    expect(event.effectTrace).toMatchObject({
      lifeOutcomeId: outcome.id,
      sourceEvidenceIds: outcome.sourceEvidenceIds,
      temporalPrecision: "day",
      occurredAtIsAuditTimestamp: true,
    });
    expect(event.outcomeFacts).toEqual(outcome.outcomeFacts);
    expect(store.listSchedule(spec.id)).toEqual([]);
  });

  it.each(["expired", "suppressed", "merged", "sent"])(
    "does not recreate a %s source, including renamed topics",
    (status) => {
      const input = { store, spec, intent, outcome, nowUtc: NOW };
      persistFuzzyLifeActivityCandidate(input);
      database
        .prepare("UPDATE proactive_candidates SET status = ?")
        .run(status);
      expect(
        persistFuzzyLifeActivityCandidate({
          ...input,
          intent: { ...intent, title: "标题更新" },
        }),
      ).toBe(false);
      expect(candidates(database)).toHaveLength(1);
    },
  );

  it("allows a fresh recurring event after cooldown without rewriting earlier source facts", () => {
    persistFuzzyLifeActivityCandidate({
      store,
      spec,
      intent,
      outcome,
      nowUtc: NOW,
    });
    const second = {
      ...outcome,
      id: "another-outcome",
      summary: "这次画了不同的风景。",
      effectiveLocalDate: "2026-09-02",
      recordedAtUtc: "2026-09-03T04:00:00.000Z",
    };
    expect(
      persistFuzzyLifeActivityCandidate({
        store,
        spec,
        intent,
        outcome: second,
        nowUtc: second.recordedAtUtc,
      }),
    ).toBe(true);
    const rows = candidates(database);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.trigger_event_id).not.toBe(rows[1]!.trigger_event_id);
    expect(rows[0]!.summary).toContain(outcome.summary);
    expect(rows[1]!.summary).toContain(second.summary);
    expect(Date.parse(rows[1]!.earliest_at_utc)).toBe(
      Date.parse("2026-09-03T04:00:00.000Z"),
    );
  });

  it("rejects partial, skipped, cancelled, deferred, stale and evidence-free outcomes", () => {
    for (const outcomeKind of [
      "partial",
      "skipped",
      "cancelled",
      "deferred",
    ] as const) {
      expect(
        persistFuzzyLifeActivityCandidate({
          store,
          spec,
          intent,
          outcome: { ...outcome, outcomeKind },
          nowUtc: NOW,
        }),
      ).toBe(false);
    }
    for (const change of [
      { effectiveLocalDate: "2026-08-25" },
      { sourceEvidenceIds: [] },
    ]) {
      expect(
        persistFuzzyLifeActivityCandidate({
          store,
          spec,
          intent,
          outcome: { ...outcome, ...change },
          nowUtc: NOW,
        }),
      ).toBe(false);
    }
    expect(candidates(database)).toEqual([]);
    expect(store.listActivityEvents(spec.id)).toEqual([]);
  });

  it("checks topic cooldown against actual send time even if delivery was delayed", () => {
    persistFuzzyLifeActivityCandidate({
      store,
      spec,
      intent,
      outcome,
      nowUtc: NOW,
    });
    const secondAt = "2026-09-03T05:00:00.000Z";
    persistFuzzyLifeActivityCandidate({
      store,
      spec,
      intent,
      outcome: {
        ...outcome,
        id: "next-outcome",
        effectiveLocalDate: "2026-09-02",
        recordedAtUtc: secondAt,
      },
      nowUtc: secondAt,
    });
    const rows = candidates(database);
    const sentAt = "2026-09-02T09:00:00.000Z";
    database
      .prepare(
        "INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc) VALUES (?, ?, ?, ?, ?)",
      )
      .run("topic-session", spec.id, "chat", NOW, NOW);
    database
      .prepare(
        `INSERT INTO messages(id, session_id, agent_id, role, content,
      message_kind, trigger_event_id, created_at_utc) VALUES (?, ?, ?, 'assistant', ?, 'assistant_proactive', ?, ?)`,
      )
      .run(
        "topic-message",
        "topic-session",
        spec.id,
        "分享",
        rows[0]!.trigger_event_id,
        sentAt,
      );
    database
      .prepare(
        "UPDATE proactive_candidates SET status = 'sent', sent_message_id = ? WHERE id = ?",
      )
      .run("topic-message", rows[0]!.id);
    const repository = new ProactiveGenerationRepository(database);
    const subject = repository.getSubject({
      kind: "activity_candidate",
      id: rows[1]!.id,
    })!;
    expect(subject.earliestAtUtc).toBe("2026-09-03T09:00:00.000Z");
    expect(
      repository.findNextDueSubject(spec.id, "2026-09-03T05:00:00.000Z"),
    ).toBeUndefined();
    expect(
      repository.findNextDueSubject(spec.id, "2026-09-03T09:00:00.000Z")?.id,
    ).toBe(rows[1]!.id);
  });

  it("connects daily life settlement to material creation and remains idempotent", () => {
    expect(candidates(database)).toEqual([]);
    const result = life.advance(spec.id, NOW);
    expect(result.createdOutcomeIds.length).toBeGreaterThan(0);
    const rows = candidates(database);
    expect(rows.length).toBeGreaterThan(0);
    for (const event of store.listActivityEvents(spec.id)) {
      expect(event.eventType).toBe("completed");
      expect(event.effectTrace?.["source"]).toBe("fuzzy_life_outcome");
    }
    life.advance(spec.id, NOW);
    expect(candidates(database)).toEqual(rows);
  });
});
