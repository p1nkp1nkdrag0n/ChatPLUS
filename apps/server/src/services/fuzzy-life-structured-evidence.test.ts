import type { ActionRecord, OutcomeRecord } from "@personasim/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import {
  hasStructuredLifeEvidence,
  readStructuredLifeEvidenceSources,
  type StructuredLifeEvidenceSources,
} from "./fuzzy-life-structured-evidence.js";

const BEFORE = "2026-09-01T07:00:00.000Z";
const RECORDED = "2026-09-01T08:00:00.000Z";
const NOW = "2026-09-05T08:00:00.000Z";
const FUTURE = "2026-09-06T08:00:00.000Z";

function action(overrides: Partial<ActionRecord> = {}): ActionRecord {
  return {
    id: "action-1",
    agentId: "agent-1",
    sessionId: "session-1",
    decisionId: "decision-1",
    subject: "character",
    performedBy: "character",
    actionKind: "initiated",
    summary: "开始落实已经选定的处理方式",
    sourceEvidenceIds: ["notice-1"],
    effectiveLocalDate: "2026-09-01",
    effectivePeriod: "afternoon",
    temporalPrecision: "period",
    recordedAtUtc: RECORDED,
    idempotencyKey: "action-1",
    schemaVersion: 1,
    ...overrides,
  };
}

function outcome(overrides: Partial<OutcomeRecord> = {}): OutcomeRecord {
  return {
    id: "outcome-1",
    agentId: "agent-1",
    sessionId: "session-1",
    decisionId: "decision-1",
    actionIds: ["action-1"],
    causeKind: "mixed",
    valence: "mixed",
    summary: "当事人更放心，合作方仍担心传播效果",
    consequenceFacts: ["当事人更放心", "合作方仍担心传播效果"],
    sourceEvidenceIds: ["notice-1"],
    confidence: 1,
    status: "observed",
    effectiveLocalDate: "2026-09-01",
    effectivePeriod: "afternoon",
    temporalPrecision: "period",
    recordedAtUtc: RECORDED,
    idempotencyKey: "outcome-1",
    schemaVersion: 1,
    ...overrides,
  };
}

function sources(
  payload: unknown = { decisionId: "decision-1", actionId: "action-1" },
): StructuredLifeEvidenceSources {
  return {
    messages: [
      {
        id: "notice-1",
        agentId: "agent-1",
        sessionId: "session-1",
        role: "system",
        kind: "system_notice",
        createdAtUtc: BEFORE,
      },
    ],
    events: [
      {
        agentId: "agent-1",
        causationId: "notice-1",
        recordedAtUtc: RECORDED,
        effectiveAtUtc: RECORDED,
        payload,
      },
    ],
  };
}

describe("structured life evidence validation", () => {
  it("accepts an older source-backed typed action without interpreting its prose", () => {
    expect(hasStructuredLifeEvidence(action(), sources(), NOW)).toBe(true);
  });

  it("requires the exact outcome and all of its action links", () => {
    expect(
      hasStructuredLifeEvidence(
        outcome(),
        sources({
          decisionId: "decision-1",
          actionId: "action-1",
          outcomeId: "outcome-1",
        }),
        NOW,
      ),
    ).toBe(true);
    expect(
      hasStructuredLifeEvidence(
        outcome({ actionIds: ["action-1", "action-2"] }),
        sources({
          decisionId: "decision-1",
          actionIds: ["action-2", "action-1"],
          outcomeId: "outcome-1",
        }),
        NOW,
      ),
    ).toBe(true);
  });

  it.each([
    { decisionId: "another-decision", actionId: "action-1" },
    { decisionId: "decision-1", actionId: "another-action" },
    { decisionId: "decision-1", actionId: "action-1", outcomeId: "outcome-1" },
    null,
    [],
    "action-1",
  ])("does not turn a mismatched event into action evidence: %j", (payload) => {
    expect(hasStructuredLifeEvidence(action(), sources(payload), NOW)).toBe(
      false,
    );
  });

  it.each([
    {
      decisionId: "decision-1",
      actionId: "other-action",
      outcomeId: "outcome-1",
    },
    {
      decisionId: "decision-1",
      actionId: "action-1",
      outcomeId: "other-outcome",
    },
    { decisionId: "decision-1", actionIds: [], outcomeId: "outcome-1" },
    {
      decisionId: "decision-1",
      actionIds: ["action-1", "action-1"],
      outcomeId: "outcome-1",
    },
    {
      decisionId: "decision-1",
      actionIds: ["action-1"],
      actionId: "other-action",
      outcomeId: "outcome-1",
    },
  ])("rejects incomplete or contradictory outcome links: %j", (payload) => {
    expect(hasStructuredLifeEvidence(outcome(), sources(payload), NOW)).toBe(
      false,
    );
  });

  it.each([
    { role: "user" },
    { role: "assistant" },
    { kind: "assistant_reply" },
    { agentId: "other-agent" },
    { sessionId: "other-session" },
    { id: "unreferenced-notice" },
    { createdAtUtc: FUTURE },
    { createdAtUtc: "invalid-time" },
  ])("rejects wrong or nonhistorical notice identity: %j", (patch) => {
    const evidence = sources();
    expect(
      hasStructuredLifeEvidence(
        action(),
        {
          ...evidence,
          messages: [{ ...evidence.messages[0]!, ...patch }],
        },
        NOW,
      ),
    ).toBe(false);
  });

  it.each([
    { agentId: "other-agent" },
    { causationId: "other-notice" },
    { recordedAtUtc: FUTURE },
    { effectiveAtUtc: FUTURE },
    { recordedAtUtc: "2026-08-30T08:00:00.000Z" },
    { recordedAtUtc: "invalid-time" },
  ])(
    "rejects events unrelated to or later than the observation: %j",
    (patch) => {
      const evidence = sources();
      expect(
        hasStructuredLifeEvidence(
          action(),
          {
            ...evidence,
            events: [{ ...evidence.events[0]!, ...patch }],
          },
          NOW,
        ),
      ).toBe(false);
    },
  );

  it("does not accept absent sources, future records, or superseded outcomes", () => {
    expect(hasStructuredLifeEvidence(action(), undefined, NOW)).toBe(false);
    expect(
      hasStructuredLifeEvidence(action(), { messages: [], events: [] }, NOW),
    ).toBe(false);
    expect(
      hasStructuredLifeEvidence(
        action({ recordedAtUtc: FUTURE }),
        sources(),
        NOW,
      ),
    ).toBe(false);
    expect(hasStructuredLifeEvidence(action(), sources(), "invalid-time")).toBe(
      false,
    );
    expect(
      hasStructuredLifeEvidence(
        outcome({ status: "superseded", supersededByOutcomeId: "replacement" }),
        sources({
          decisionId: "decision-1",
          actionId: "action-1",
          outcomeId: "outcome-1",
        }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("structured evidence source lookup", () => {
  let database: Database | undefined;
  afterEach(() => database?.close());

  function createDatabase(): Database {
    database = openDatabase(":memory:");
    database.exec(`
      CREATE TABLE messages(id TEXT PRIMARY KEY, agent_id TEXT, session_id TEXT,
        role TEXT, message_kind TEXT, created_at_utc TEXT);
      CREATE TABLE domain_events(agent_id TEXT, causation_id TEXT,
        recorded_at_utc TEXT, effective_at_utc TEXT, payload_json TEXT);
      CREATE INDEX event_agent_time ON domain_events(agent_id, recorded_at_utc);
    `);
    return database;
  }

  function insertEvidence(
    db: Database,
    id: string,
    agentId = "agent-1",
    role = "system",
  ) {
    db.prepare(
      "INSERT INTO messages VALUES (?, ?, 'session-1', ?, 'system_notice', ?)",
    ).run(id, agentId, role, BEFORE);
    db.prepare("INSERT INTO domain_events VALUES (?, ?, ?, ?, ?)").run(
      agentId,
      id,
      RECORDED,
      RECORDED,
      JSON.stringify({ decisionId: "decision-1", actionId: "action-1" }),
    );
  }

  it("loads only requested same-agent system notices and leaves the database intact", () => {
    const db = createDatabase();
    insertEvidence(db, "notice-1");
    insertEvidence(db, "unrequested");
    insertEvidence(db, "other-agent-source", "other-agent");
    insertEvidence(db, "chat-source", "agent-1", "assistant");
    const before = db.prepare("SELECT total_changes() AS count").get();
    const result = readStructuredLifeEvidenceSources({
      database: db,
      agentId: "agent-1",
      sourceEvidenceIds: [
        "notice-1",
        "notice-1",
        "other-agent-source",
        "chat-source",
      ],
      atUtc: NOW,
    });
    expect(result.messages.map((message) => message.id)).toEqual(["notice-1"]);
    expect(result.events.every((event) => event.agentId === "agent-1")).toBe(
      true,
    );
    expect(
      result.events.some((event) => event.causationId === "unrequested"),
    ).toBe(false);
    expect(hasStructuredLifeEvidence(action(), result, NOW)).toBe(true);
    expect(
      hasStructuredLifeEvidence(
        action({ sourceEvidenceIds: ["chat-source"] }),
        result,
        NOW,
      ),
    ).toBe(false);
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
  });

  it("fails closed on malformed and future event payloads", () => {
    const db = createDatabase();
    insertEvidence(db, "notice-1");
    db.prepare("UPDATE domain_events SET payload_json = ?").run("{broken");
    expect(
      readStructuredLifeEvidenceSources({
        database: db,
        agentId: "agent-1",
        sourceEvidenceIds: ["notice-1"],
        atUtc: NOW,
      }).events,
    ).toEqual([]);
    db.prepare(
      "UPDATE domain_events SET payload_json = ?, recorded_at_utc = ?",
    ).run("{}", FUTURE);
    expect(
      readStructuredLifeEvidenceSources({
        database: db,
        agentId: "agent-1",
        sourceEvidenceIds: ["notice-1"],
        atUtc: NOW,
      }).events,
    ).toEqual([]);
  });

  it("bounds source selection and handles empty lookups without queries", () => {
    const db = createDatabase();
    const ids = Array.from(
      { length: 300 },
      (_, index) => `notice-${String(index)}`,
    );
    for (const id of ids) insertEvidence(db, id);
    const result = readStructuredLifeEvidenceSources({
      database: db,
      agentId: "agent-1",
      sourceEvidenceIds: ids,
      atUtc: NOW,
    });
    expect(result.messages).toHaveLength(256);
    expect(result.events).toHaveLength(256);
    expect(
      result.messages.every((message) =>
        ids.slice(0, 256).includes(message.id),
      ),
    ).toBe(true);
    expect(
      readStructuredLifeEvidenceSources({
        database: db,
        agentId: "agent-1",
        sourceEvidenceIds: [],
        atUtc: NOW,
      }),
    ).toEqual({ messages: [], events: [] });
  });
});
