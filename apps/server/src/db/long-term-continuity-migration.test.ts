import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";
import { runMigrations } from "./migrations.js";

const NOW = "2026-08-21T12:00:00.000Z";
const PRE_CONTINUITY_MIGRATIONS = [
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
] as const;

describe("011_long_term_continuity migration", () => {
  it("is discovered by the ordered migration runner", () => {
    const database = openDatabase(":memory:");
    try {
      expect(runMigrations(database)).toContain("011_long_term_continuity.sql");
      expect(runMigrations(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("backfills visible messages and maintains revision and FTS projections", () => {
    const database = openDatabase(":memory:");
    try {
      for (const name of PRE_CONTINUITY_MIGRATIONS) {
        database.exec(migrationSql(name));
      }
      seedPreContinuityData(database);
      database.exec(migrationSql("011_long_term_continuity.sql"));

      expect(sessionRevision(database)).toBe(2);
      expect(archiveIds(database)).toEqual([
        "message-assistant",
        "message-user",
      ]);
      expect(archiveSearch(database, "originaltoken")).toEqual([
        "message-user",
      ]);

      insertMessage(database, {
        id: "message-proactive",
        role: "assistant",
        content: "A proactive visible message.",
        messageKind: "assistant_proactive",
      });
      expect(sessionRevision(database)).toBe(3);
      expect(archiveIds(database)).toContain("message-proactive");

      insertMessage(database, {
        id: "message-system-late",
        role: "system",
        content: "Internal runtime context.",
        messageKind: "system_notice",
      });
      expect(sessionRevision(database)).toBe(3);
      expect(archiveIds(database)).not.toContain("message-system-late");

      database
        .prepare("UPDATE messages SET content = ? WHERE id = ?")
        .run("replacementtoken durable user fact.", "message-user");
      expect(sessionRevision(database)).toBe(4);
      expect(archiveSearch(database, "originaltoken")).toEqual([]);
      expect(archiveSearch(database, "replacementtoken")).toEqual([
        "message-user",
      ]);

      expect(
        database
          .prepare(
            "SELECT status, json_extract(memory_json, '$.status') AS jsonStatus FROM memories WHERE id = ?",
          )
          .get("memory-forgotten"),
      ).toEqual({ status: "archived", jsonStatus: "archived" });
      expect(
        database
          .prepare(
            "SELECT last_reinforced_at_utc AS reinforcedAt, lifecycle_updated_at_utc AS lifecycleAt FROM memories WHERE id = ?",
          )
          .get("memory-forgotten"),
      ).toEqual({ reinforcedAt: NOW, lifecycleAt: NOW });
    } finally {
      database.close();
    }
  });

  it("persists checkpoint artifacts, evidence chains, cards, and memory ledgers", () => {
    const database = openDatabase(":memory:");
    try {
      for (const name of PRE_CONTINUITY_MIGRATIONS) {
        database.exec(migrationSql(name));
      }
      seedPreContinuityData(database);
      database.exec(migrationSql("011_long_term_continuity.sql"));

      database
        .prepare(
          `INSERT INTO conversation_checkpoints(
            id, agent_id, session_id, from_message_id, through_message_id,
            source_hash, source_revision, source_message_count,
            source_token_estimate, status, created_at_utc, updated_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "checkpoint-1",
          "agent-continuity",
          "session-continuity",
          "message-user",
          "message-assistant",
          "a".repeat(64),
          2,
          2,
          24,
          "pending",
          NOW,
          NOW,
        );

      expect(() =>
        database
          .prepare(
            `INSERT INTO conversation_checkpoints(
              id, agent_id, session_id, from_message_id, through_message_id,
              source_hash, source_revision, source_message_count,
              source_token_estimate, status, created_at_utc, updated_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            "checkpoint-2",
            "agent-continuity",
            "session-continuity",
            "message-user",
            "message-assistant",
            "b".repeat(64),
            2,
            2,
            24,
            "pending",
            NOW,
            NOW,
          ),
      ).toThrow();

      database
        .prepare(
          `INSERT INTO autobiography_snapshots(
            id, agent_id, source_checkpoint_id, revision,
            summary_first_person, important_experiences_json,
            relationship_changes_json, active_goals_json,
            unresolved_threads_json, commitments_json,
            source_evidence_ids_json, from_utc, through_utc,
            snapshot_json, created_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "autobiography-1",
          "agent-continuity",
          "checkpoint-1",
          1,
          "I remember a durable user fact.",
          '["I heard a durable user fact."]',
          "[]",
          "[]",
          "[]",
          "[]",
          '["message-user"]',
          NOW,
          NOW,
          '{"revision":1}',
          NOW,
        );
      database
        .prepare(
          `INSERT INTO autobiography_entries(
            id, snapshot_id, agent_id, entry_kind, ordinal, content,
            temporal_status, source_evidence_ids_json, evidence_json,
            created_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "autobiography-entry-1",
          "autobiography-1",
          "agent-continuity",
          "important_experience",
          0,
          "I heard a durable user fact.",
          "unknown",
          '["message-user"]',
          '[{"sourceType":"message_archive","sourceId":"message-user"}]',
          NOW,
        );
      database
        .prepare(
          `UPDATE conversation_checkpoints
           SET status = 'committed', autobiography_snapshot_id = ?,
             artifact_json = ?, committed_at_utc = ?, updated_at_utc = ?
           WHERE id = ?`,
        )
        .run(
          "autobiography-1",
          '{"eventCards":["card-1"]}',
          NOW,
          NOW,
          "checkpoint-1",
        );

      database
        .prepare(
          `INSERT INTO event_cards(
            id, agent_id, session_id, checkpoint_id, card_kind, source_kind,
            source_id, dedupe_key, title, summary, tags_json, tags_text,
            namespace, certainty, attribution, temporal_status,
            occurred_start_at_utc, recorded_at_utc, importance, status,
            source_evidence_ids_json, evidence_json, card_json, index_version,
            created_at_utc, updated_at_utc
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?
          )`,
        )
        .run(
          "card-1",
          "agent-continuity",
          "session-continuity",
          "checkpoint-1",
          "user_event",
          "checkpoint",
          "checkpoint-1",
          "checkpoint:1:user-event",
          "Durable fact",
          "The user reported a durable event.",
          '["durable"]',
          "durable",
          "user_model",
          "explicit",
          "user_explicit",
          "occurred",
          NOW,
          NOW,
          0.8,
          "active",
          '["message-user"]',
          '[{"sourceType":"message_archive","sourceId":"message-user"}]',
          '{"id":"card-1"}',
          1,
          NOW,
          NOW,
        );
      expect(cardSearch(database, "durable")).toEqual(["card-1"]);

      database
        .prepare(
          `INSERT INTO memories(
            id, agent_id, type, content, tags_json, importance, confidence,
            created_at_utc, memory_json, status, claim_subject_key,
            claim_disposition, last_reinforced_at_utc,
            lifecycle_updated_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "memory-new",
          "agent-continuity",
          "semantic",
          "The user cancelled the goal.",
          "[]",
          0.8,
          1,
          NOW,
          '{"id":"memory-new","status":"active"}',
          "active",
          "user_goal:test",
          "cancelled",
          NOW,
          NOW,
        );
      database
        .prepare(
          `INSERT INTO memory_conflicts(
            id, agent_id, subject_key, left_memory_id, right_memory_id,
            status, resolution, winner_memory_id, reason_code,
            reason_summary, evidence_json, idempotency_key,
            created_at_utc, resolved_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "conflict-1",
          "agent-continuity",
          "user_goal:test",
          "memory-forgotten",
          "memory-new",
          "resolved",
          "superseded",
          "memory-new",
          "later_explicit_claim",
          "The later explicit claim wins.",
          "[]",
          "conflict:user_goal:test",
          NOW,
          NOW,
        );
      database
        .prepare(
          `INSERT INTO memory_merge_history(
            id, agent_id, target_memory_id, source_memory_id, subject_key,
            reason_code, reason_summary, source_snapshot_json,
            target_before_json, target_after_json, evidence_json,
            idempotency_key, merged_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "merge-1",
          "agent-continuity",
          "memory-new",
          null,
          "user_goal:test",
          "claim_reinforced",
          "A later candidate reinforced the target.",
          "{}",
          "{}",
          "{}",
          "[]",
          "merge:memory-new:1",
          NOW,
        );

      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM memory_conflicts")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM memory_merge_history")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM messages").get(),
      ).toEqual({ count: 3 });
    } finally {
      database.close();
    }
  });
});

function seedPreContinuityData(
  database: ReturnType<typeof openDatabase>,
): void {
  database
    .prepare(
      `INSERT INTO characters(
        id, current_version, status, tier, name, source_type,
        created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-continuity",
      1,
      "published",
      "daily",
      "Continuity",
      "original",
      NOW,
      NOW,
    );
  database
    .prepare(
      `INSERT INTO sessions(
        id, agent_id, title, created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run("session-continuity", "agent-continuity", "Continuity", NOW, NOW);
  insertMessage(database, {
    id: "message-user",
    role: "user",
    content: "originaltoken durable user fact.",
    messageKind: "user",
  });
  insertMessage(database, {
    id: "message-assistant",
    role: "assistant",
    content: "A grounded assistant reply.",
    messageKind: "assistant_reply",
  });
  insertMessage(database, {
    id: "message-system",
    role: "system",
    content: "Internal runtime context.",
    messageKind: "system_notice",
  });
  database
    .prepare(
      `INSERT INTO memories(
        id, agent_id, type, content, tags_json, importance, confidence,
        created_at_utc, memory_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "memory-forgotten",
      "agent-continuity",
      "semantic",
      "A legacy forgotten memory.",
      "[]",
      0.5,
      0.7,
      NOW,
      '{"id":"memory-forgotten","status":"forgotten"}',
      "forgotten",
    );
}

function insertMessage(
  database: ReturnType<typeof openDatabase>,
  input: {
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    messageKind:
      "user" | "assistant_reply" | "assistant_proactive" | "system_notice";
  },
): void {
  database
    .prepare(
      `INSERT INTO messages(
        id, session_id, agent_id, role, content, message_kind,
        created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      "session-continuity",
      "agent-continuity",
      input.role,
      input.content,
      input.messageKind,
      NOW,
    );
}

function sessionRevision(database: ReturnType<typeof openDatabase>): number {
  return (
    database
      .prepare("SELECT message_revision AS revision FROM sessions WHERE id = ?")
      .get("session-continuity") as { revision: number }
  ).revision;
}

function archiveIds(database: ReturnType<typeof openDatabase>): string[] {
  return (
    database
      .prepare("SELECT id FROM message_archive ORDER BY id")
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
}

function archiveSearch(
  database: ReturnType<typeof openDatabase>,
  query: string,
): string[] {
  return (
    database
      .prepare(
        `SELECT message_archive.id
         FROM message_archive_fts
         JOIN message_archive
           ON message_archive.rowid = message_archive_fts.rowid
         WHERE message_archive_fts MATCH ?
         ORDER BY message_archive.id`,
      )
      .all(query) as Array<{ id: string }>
  ).map((row) => row.id);
}

function cardSearch(
  database: ReturnType<typeof openDatabase>,
  query: string,
): string[] {
  return (
    database
      .prepare(
        `SELECT event_cards.id
         FROM event_cards_fts
         JOIN event_cards ON event_cards.rowid = event_cards_fts.rowid
         WHERE event_cards_fts MATCH ?
         ORDER BY event_cards.id`,
      )
      .all(query) as Array<{ id: string }>
  ).map((row) => row.id);
}

function migrationSql(name: string): string {
  return readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
}
