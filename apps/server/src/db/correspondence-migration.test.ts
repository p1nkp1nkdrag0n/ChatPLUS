import { readFileSync, readdirSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openDatabase, type Database } from "./connection.js";
import { runMigrations } from "./migrations.js";

const NOW = "2026-09-03T12:00:00.000Z";
const HASH = "a".repeat(64);

describe("018-021 temporal correspondence migrations", () => {
  it("applies on an empty database and remains idempotent", () => {
    const database = openDatabase(":memory:");
    try {
      expect(runMigrations(database)).toContain(
        "021_correspondence_reply_recovery.sql",
      );
      expect(runMigrations(database)).toEqual([]);
      expect(schemaObjects(database, "table")).toEqual(
        expect.arrayContaining([
          "correspondence_threads",
          "letters",
          "letter_generation_snapshots",
          "letter_generation_runs",
          "temporal_tasks",
          "correspondence_key_metadata",
          "correspondence_reply_retry_requests",
        ]),
      );
      expect(schemaObjects(database, "trigger")).toEqual(
        expect.arrayContaining([
          "letters_immutable_after_draft",
          "letters_valid_status_transition",
          "letter_generation_snapshots_immutable",
          "correspondence_key_metadata_immutable",
        ]),
      );
      expect(schemaObjects(database, "index")).toEqual(
        expect.arrayContaining([
          "correspondence_threads_one_open_agent_idx",
          "letter_generation_runs_one_commit_idx",
          "temporal_tasks_due_idx",
          "temporal_tasks_entity_kind_status_idx",
          "temporal_tasks_one_active_reply_generation_idx",
        ]),
      );
    } finally {
      database.close();
    }
  });

  it("upgrades a populated 001-017 database without replacing old data", () => {
    const database = openDatabase(":memory:");
    try {
      applyThrough017(database);
      database
        .prepare(
          `INSERT INTO characters(
             id, current_version, status, tier, name, source_type,
             created_at_utc, updated_at_utc
           ) VALUES ('agent-existing', 1, 'published', 'daily', 'Existing',
             'original', ?, ?)`,
        )
        .run(NOW, NOW);

      expect(runMigrations(database).slice(0, 4)).toEqual([
        "018_temporal_correspondence.sql",
        "019_correspondence_key_metadata.sql",
        "020_keepsakes.sql",
        "021_correspondence_reply_recovery.sql",
      ]);
      expect(
        database
          .prepare("SELECT name FROM characters WHERE id = 'agent-existing'")
          .get(),
      ).toEqual({ name: "Existing" });
      expect(runMigrations(database)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("enforces encrypted replies, immutable sealed content and task keys", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      seedAgent(database);
      database
        .prepare(
          `INSERT INTO correspondence_threads(
             id, agent_id, status, created_at_utc, updated_at_utc
           ) VALUES ('thread-1', 'agent-1', 'open', ?, ?)`,
        )
        .run(NOW, NOW);
      database
        .prepare(
          `INSERT INTO letters(
             id, thread_id, agent_id, direction, status, body, content_hash,
             transit_policy_version, dispatched_at_utc, arrival_due_at_utc,
             effective_author_time_utc, transit_timezone,
             created_at_utc, updated_at_utc
           ) VALUES (
             'letter-incoming', 'thread-1', 'agent-1', 'user_to_agent',
             'in_transit', 'hello', ?, 'fixed_5d_v1', ?, ?, ?,
             'Asia/Shanghai', ?, ?
           )`,
        )
        .run(HASH, NOW, "2026-09-08T12:00:00.000Z", NOW, NOW, NOW);

      expect(() =>
        database
          .prepare("UPDATE letters SET body = 'tampered' WHERE id = ?")
          .run("letter-incoming"),
      ).toThrow(/immutable/iu);
      database
        .prepare(
          `UPDATE letters
           SET status = 'delivered_unread', delivered_effective_at_utc = ?,
               processed_at_utc = ?, updated_at_utc = ?
           WHERE id = 'letter-incoming'`,
        )
        .run(
          "2026-09-08T12:00:00.000Z",
          "2026-09-09T12:00:00.000Z",
          "2026-09-09T12:00:00.000Z",
        );
      expect(() =>
        database
          .prepare(
            "UPDATE letters SET processed_at_utc = ? WHERE id = 'letter-incoming'",
          )
          .run("2026-09-10T12:00:00.000Z"),
      ).toThrow(/immutable/iu);
      expect(() =>
        database
          .prepare(
            `UPDATE letters SET status = 'read', read_at_utc = ?, updated_at_utc = ?
             WHERE id = 'letter-incoming'`,
          )
          .run("2026-09-09T12:01:00.000Z", "2026-09-09T12:01:00.000Z"),
      ).toThrow(/CHECK constraint/iu);
      database
        .prepare(
          `UPDATE letters SET status = 'read', read_at_utc = ?, updated_at_utc = ?
           WHERE id = 'letter-incoming'`,
        )
        .run("2026-09-08T12:00:00.000Z", "2026-09-09T12:01:00.000Z");
      expect(
        database
          .prepare(
            "SELECT read_at_utc FROM letters WHERE id = 'letter-incoming'",
          )
          .get(),
      ).toEqual({ read_at_utc: "2026-09-08T12:00:00.000Z" });
      expect(() =>
        database
          .prepare("UPDATE letters SET read_at_utc = NULL WHERE id = ?")
          .run("letter-incoming"),
      ).toThrow(/immutable/iu);
      expect(() =>
        database
          .prepare(
            `INSERT INTO letters(
               id, thread_id, agent_id, reply_to_letter_id, direction, status,
               body, content_hash, transit_policy_version, dispatched_at_utc,
               arrival_due_at_utc, effective_author_time_utc, transit_timezone,
               created_at_utc, updated_at_utc
             ) VALUES (
               'reply-plaintext', 'thread-1', 'agent-1', 'letter-incoming',
               'agent_to_user', 'in_transit', 'must not persist', ?,
               'fixed_5d_v1', ?, ?, ?, 'Asia/Shanghai', ?, ?
             )`,
          )
          .run(HASH, NOW, "2026-09-13T12:00:00.000Z", NOW, NOW, NOW),
      ).toThrow();

      insertTask(database, "task-1");
      expect(() => insertTask(database, "task-2")).toThrow(/UNIQUE/iu);
    } finally {
      database.close();
    }
  });

  it("allows only one active reply-generation task per incoming letter", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      seedAgent(database);
      insertGenerationTask(database, "generation-initial", "pending", 0);
      expect(() =>
        insertGenerationTask(database, "generation-retry-1", "pending", 1),
      ).toThrow(/UNIQUE/iu);

      database
        .prepare(
          `UPDATE temporal_tasks SET status = 'dead_letter', updated_at_utc = ?
           WHERE id = 'generation-initial'`,
        )
        .run(NOW);
      insertGenerationTask(database, "generation-retry-1", "pending", 1);
      database
        .prepare(
          `UPDATE temporal_tasks SET status = 'dead_letter', updated_at_utc = ?
           WHERE id = 'generation-retry-1'`,
        )
        .run(NOW);
      expect(() =>
        insertGenerationTask(database, "generation-retry-2", "pending", 2),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });
});

function applyThrough017(database: Database): void {
  database.exec(
    `CREATE TABLE schema_migrations(
       name TEXT PRIMARY KEY,
       applied_at_utc TEXT NOT NULL
     )`,
  );
  const names = readdirSync(new URL("./migrations", import.meta.url))
    .filter((name) => /^\d+[_-].+\.sql$/.test(name) && name < "018_")
    .sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    database.transaction(() => {
      database.exec(
        readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8"),
      );
      database
        .prepare(
          "INSERT INTO schema_migrations(name, applied_at_utc) VALUES (?, ?)",
        )
        .run(name, NOW);
    })();
  }
}

function seedAgent(database: Database): void {
  database
    .prepare(
      `INSERT INTO characters(
         id, current_version, status, tier, name, source_type,
         created_at_utc, updated_at_utc
       ) VALUES ('agent-1', 1, 'published', 'daily', 'Letters', 'original', ?, ?)`,
    )
    .run(NOW, NOW);
}

function insertTask(database: Database, id: string): void {
  database
    .prepare(
      `INSERT INTO temporal_tasks(
         id, agent_id, kind, entity_id, due_at_utc, priority, status,
         idempotency_key, created_at_utc, updated_at_utc
       ) VALUES (?, 'agent-1', 'letter.outbound_arrival', 'letter-incoming',
         ?, 10, 'pending', 'letter-arrival:letter-incoming', ?, ?)`,
    )
    .run(id, NOW, NOW, NOW);
}

function insertGenerationTask(
  database: Database,
  id: string,
  status: "pending" | "dead_letter",
  generationEpoch: number,
): void {
  database
    .prepare(
      `INSERT INTO temporal_tasks(
         id, agent_id, kind, entity_id, due_at_utc, priority, status,
         idempotency_key, payload_json, created_at_utc, updated_at_utc
       ) VALUES (?, 'agent-1', ?, 'letter-generation', ?, 20, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      generationEpoch === 0
        ? "letter.reply_generation"
        : "letter.generation_retry",
      NOW,
      status,
      `letter-generation:epoch-${generationEpoch}`,
      JSON.stringify({
        incomingLetterId: "letter-generation",
        snapshotId: "snapshot-generation",
        generationEpoch,
      }),
      NOW,
      NOW,
    );
}

function schemaObjects(database: Database, type: string): string[] {
  return (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
      .all(type) as Array<{ name: string }>
  ).map((row) => row.name);
}
