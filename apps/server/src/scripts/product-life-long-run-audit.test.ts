import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { auditProductLifeDatabase } from "./product-life-long-run-audit.js";

const NOW = "2026-09-05T08:00:00.000Z";
const AGENT = "audit-agent";

describe("product life database audit", () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
  });
  afterEach(() => database.close());

  it("treats absent behavior as not reached and works on a query-only migrated database", () => {
    database.pragma("query_only = ON");
    const before = database.prepare("SELECT total_changes() AS count").get();
    const evidence = auditProductLifeDatabase(database, AGENT);

    expect(evidence.counts.messages).toBe(0);
    expect(evidence.state).toBeNull();
    expect(
      Object.values(evidence.checks).every(
        (check) => check.passed === null && check.status === "not_reached",
      ),
    ).toBe(true);
    expect(database.prepare("SELECT total_changes() AS count").get()).toEqual(
      before,
    );
    expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence);
  });

  it("counts real-schema archive projections and a complete user chain without claiming character coverage", () => {
    seedAgent(database, AGENT);
    seedChain(database);
    insert(database, "runtime_states", {
      agent_id: AGENT,
      revision: 3,
      updated_at_utc: NOW,
      state_json: JSON.stringify({
        energy: 0.5,
        relationship: { trust: 0.7 },
        privateText: "DO_NOT_EXPORT_STATE_TEXT",
      }),
    });
    database.pragma("query_only = ON");

    const evidence = auditProductLifeDatabase(database, AGENT);

    expect(evidence.counts).toMatchObject({
      messages: 1,
      message_archive: 1,
      dilemma_episodes: 1,
      decision_records: 1,
      action_records: 1,
      outcome_records: 1,
      reflection_records: 1,
    });
    expect(evidence.checks.user_complete_causal_chain).toMatchObject({
      passed: true,
      checked: 1,
    });
    expect(evidence.checks.character_complete_causal_chain?.status).toBe(
      "not_reached",
    );
    expect(evidence.checks.archive_references?.passed).toBe(true);
    expect(
      evidence.subjects.find((row) => row.subject === "user")?.samples[0],
    ).toEqual({
      dilemmaId: "dilemma",
      decisionId: "decision",
      actionIds: ["action"],
      outcomeIds: ["outcome"],
      reflectionIds: ["reflection"],
    });
    expect(evidence.messages.withClientMessageId).toBe(1);
    expect(evidence.state?.numericValues).toEqual({
      energy: 0.5,
      "relationship.trust": 0.7,
    });
    expect(JSON.stringify(evidence)).not.toContain("DO_NOT_EXPORT");
  });

  it("detects missing and other-agent message references without exporting message contents", () => {
    seedAgent(database, AGENT);
    seedAgent(database, "other-agent");
    seedChain(database);
    database
      .prepare(
        "UPDATE action_records SET source_evidence_ids_json = ? WHERE id = ?",
      )
      .run(
        JSON.stringify(["message-other-agent", "missing-message"]),
        "action",
      );
    database.pragma("query_only = ON");

    const evidence = auditProductLifeDatabase(database, AGENT);

    expect(evidence.counts.messages).toBe(1);
    expect(evidence.checks.action_references).toMatchObject({
      passed: false,
      invalidCount: 2,
    });
    expect(
      evidence.checks.action_references?.details.map(
        (detail) => detail.referenceId,
      ),
    ).toEqual(["message-other-agent", "missing-message"]);
    expect(evidence.checks.user_complete_causal_chain?.passed).toBe(false);
    expect(JSON.stringify(evidence)).not.toContain(
      "DO_NOT_EXPORT_MESSAGE_BODY",
    );
  });

  it("does not call an action-only decision a complete chain and caps failure samples", () => {
    seedAgent(database, AGENT);
    seedChain(database);
    database.prepare("DELETE FROM reflection_records").run();
    database
      .prepare(
        "UPDATE action_records SET source_evidence_ids_json = ? WHERE id = ?",
      )
      .run(
        JSON.stringify(
          Array.from({ length: 25 }, (_, index) => `missing-${index}`),
        ),
        "action",
      );
    database.pragma("query_only = ON");

    const evidence = auditProductLifeDatabase(database, AGENT);

    expect(evidence.checks.user_complete_causal_chain?.passed).toBeNull();
    expect(evidence.checks.reflection_references?.status).toBe("not_reached");
    expect(evidence.checks.action_references?.invalidCount).toBe(25);
    expect(evidence.checks.action_references?.details).toHaveLength(20);
  });

  it.each([false, true])(
    "verifies autobiography evidence against the actual archive (missing=%s)",
    (missing) => {
      seedAgent(database, AGENT);
      seedAutobiography(
        database,
        missing ? "missing-source" : `message-${AGENT}`,
      );
      database.pragma("query_only = ON");

      const evidence = auditProductLifeDatabase(database, AGENT);

      expect(evidence.counts).toMatchObject({
        conversation_checkpoints: 1,
        autobiography_snapshots: 1,
        autobiography_entries: 1,
      });
      expect(evidence.continuity).toMatchObject({
        checkpointStatuses: { committed: 1 },
        latestAutobiographyRevision: 1,
      });
      expect(evidence.checks.checkpoint_references?.passed).toBe(true);
      expect(evidence.checks.autobiography_snapshot_references?.passed).toBe(
        true,
      );
      expect(evidence.checks.autobiography_evidence_references?.passed).toBe(
        !missing,
      );
      expect(JSON.stringify(evidence)).not.toContain("DO_NOT_EXPORT");
    },
  );
});

function insert(
  database: Database,
  table: string,
  values: Record<string, string | number | null>,
): void {
  const fields = Object.keys(values);
  database
    .prepare(
      `INSERT INTO ${table} (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
    )
    .run(...Object.values(values));
}

function seedAgent(database: Database, agentId: string): void {
  insert(database, "characters", {
    id: agentId,
    current_version: 1,
    status: "published",
    tier: "high_fidelity",
    name: "Audit fixture",
    source_type: "original",
    created_at_utc: NOW,
    updated_at_utc: NOW,
  });
  insert(database, "sessions", {
    id: `session-${agentId}`,
    agent_id: agentId,
    title: "Audit",
    created_at_utc: NOW,
    updated_at_utc: NOW,
  });
  insert(database, "messages", {
    id: `message-${agentId}`,
    agent_id: agentId,
    session_id: `session-${agentId}`,
    role: "user",
    message_kind: "user",
    client_message_id: "client-id",
    content: "DO_NOT_EXPORT_MESSAGE_BODY",
    created_at_utc: NOW,
  });
}

function seedChain(database: Database): void {
  const common = {
    agent_id: AGENT,
    session_id: `session-${AGENT}`,
    effective_local_date: "2026-09-05",
    temporal_precision: "day",
    recorded_at_utc: NOW,
    schema_version: 1,
  };
  const sources = JSON.stringify([`message-${AGENT}`]);
  insert(database, "dilemma_episodes", {
    ...common,
    id: "dilemma",
    subject: "user",
    title: "Choice",
    summary: "Test choice",
    domain: "creative",
    options_json: '[{"id":"option-a"},{"id":"option-b"}]',
    status: "closed",
    closure_kind: "decision",
    closure_summary: "Subject chose",
    closing_decision_id: "decision",
    source_message_ids_json: sources,
    updated_at_utc: NOW,
    idempotency_key: "dilemma-key",
    episode_json: "{}",
  });
  insert(database, "decision_records", {
    ...common,
    id: "decision",
    dilemma_id: "dilemma",
    subject: "user",
    support_mode: "deliberate",
    authority: "subject",
    decided_by: "user",
    selected_option_id: "option-a",
    selection_summary: "A",
    reasoning_summary: "Chosen by subject",
    support_intervention_ids_json: "[]",
    source_message_ids_json: sources,
    confidence: 0.8,
    status: "current",
    idempotency_key: "decision-key",
    decision_json: "{}",
  });
  insert(database, "action_records", {
    ...common,
    id: "action",
    decision_id: "decision",
    subject: "user",
    performed_by: "user",
    action_kind: "completed",
    summary: "Action reported",
    source_evidence_ids_json: sources,
    idempotency_key: "action-key",
    action_json: "{}",
  });
  insert(database, "outcome_records", {
    ...common,
    id: "outcome",
    decision_id: "decision",
    action_ids_json: '["action"]',
    cause_kind: "action",
    valence: "mixed",
    summary: "Outcome reported",
    consequence_facts_json: '["reported"]',
    source_evidence_ids_json: sources,
    confidence: 0.8,
    status: "observed",
    idempotency_key: "outcome-key",
    outcome_json: "{}",
  });
  insert(database, "reflection_records", {
    ...common,
    id: "reflection",
    subject: "user",
    reflected_by: "user",
    decision_id: "decision",
    outcome_id: "outcome",
    summary: "A lesson",
    lessons_json: '["lesson"]',
    stance_toward_decision: "mixed",
    changed_interpretation: 0,
    source_message_ids_json: sources,
    idempotency_key: "reflection-key",
    reflection_json: "{}",
  });
}

function seedAutobiography(database: Database, sourceId: string): void {
  insert(database, "conversation_checkpoints", {
    id: "checkpoint",
    agent_id: AGENT,
    session_id: `session-${AGENT}`,
    from_message_id: `message-${AGENT}`,
    through_message_id: `message-${AGENT}`,
    source_hash: "0".repeat(64),
    source_revision: 1,
    source_message_count: 1,
    source_token_estimate: 20,
    autobiography_snapshot_id: "snapshot",
    status: "committed",
    created_at_utc: NOW,
    updated_at_utc: NOW,
    committed_at_utc: NOW,
  });
  insert(database, "autobiography_snapshots", {
    id: "snapshot",
    agent_id: AGENT,
    source_checkpoint_id: "checkpoint",
    revision: 1,
    summary_first_person: "DO_NOT_EXPORT_AUTOBIOGRAPHY_TEXT",
    important_experiences_json: "[]",
    relationship_changes_json: "[]",
    active_goals_json: "[]",
    unresolved_threads_json: "[]",
    commitments_json: "[]",
    source_evidence_ids_json: '["evidence-id"]',
    from_utc: NOW,
    through_utc: NOW,
    snapshot_json: "{}",
    created_at_utc: NOW,
  });
  insert(database, "autobiography_entries", {
    id: "entry",
    snapshot_id: "snapshot",
    agent_id: AGENT,
    entry_kind: "important_experience",
    ordinal: 0,
    content: "DO_NOT_EXPORT_ENTRY_TEXT",
    temporal_status: "occurred",
    source_evidence_ids_json: '["evidence-id"]',
    evidence_json: JSON.stringify([
      {
        id: "evidence-id",
        sourceType: "message_archive",
        sourceId,
        quote: "DO_NOT_EXPORT_EVIDENCE_QUOTE",
      },
    ]),
    created_at_utc: NOW,
  });
}
