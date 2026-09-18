import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { openDatabase, type Database } from "./connection.js";
import { runMigrations } from "./migrations.js";

const DISPATCHED = "2026-09-03T12:00:00.000Z";
const ARRIVAL = "2026-09-08T12:00:00.000Z";
const HASH = "a".repeat(64);
const METHODS = [
  ["standard", "fixed_5d_v1", ARRIVAL],
  ["express", "fixed_2d_v1", "2026-09-05T12:00:00.000Z"],
  ["priority", "fixed_1d_v1", "2026-09-04T12:00:00.000Z"],
] as const;

describe("042 email correspondence migration", () => {
  it("upgrades 041 without changing physical mail, ciphertext, related rows, indexes, triggers or foreign keys", () => {
    const database = openDatabase(":memory:");
    try {
      applyThrough041(database);
      seedPhysicalCorrespondence(database);
      const letters = allRows(database, "letters");
      const relatedTables = [
        "correspondence_threads",
        "letter_generation_snapshots",
        "letter_generation_runs",
        "temporal_tasks",
        "achievement_unlocks",
      ] as const;
      const related = relatedTables.map((table) => allRows(database, table));
      const schemaObjects = database
        .prepare(
          "SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY type, name",
        )
        .all();
      const foreignKeys = database
        .prepare("PRAGMA foreign_key_list(letters)")
        .all();

      expect(runMigrations(database)).toContain("042_email_correspondence.sql");
      expect(allRows(database, "letters")).toEqual(letters);
      relatedTables.forEach((table, index) => {
        expect(allRows(database, table), table).toEqual(related[index]);
      });
      expect(
        database
          .prepare(
            "SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY type, name",
          )
          .all(),
      ).toEqual(schemaObjects);
      expect(
        database.prepare("PRAGMA foreign_key_list(letters)").all(),
      ).toEqual(foreignKeys);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(runMigrations(database)).toEqual([]);

      expect(() =>
        database
          .prepare(
            "UPDATE letters SET body='changed' WHERE id='incoming-express'",
          )
          .run(),
      ).toThrow(/immutable/iu);
      expect(() =>
        database
          .prepare(
            "UPDATE letters SET encrypted_ciphertext='changed' WHERE id='encrypted-reply'",
          )
          .run(),
      ).toThrow(/immutable/iu);
      expect(() =>
        database
          .prepare("DELETE FROM letters WHERE id='incoming-priority'")
          .run(),
      ).toThrow(/durable letters/iu);
      expect(() =>
        database
          .prepare(
            "UPDATE letters SET status='draft' WHERE id='encrypted-reply'",
          )
          .run(),
      ).toThrow(/invalid letter status transition/iu);
      expect(() =>
        insertDraft(
          database,
          "duplicate-create-request",
          "standard",
          "create-standard",
        ),
      ).toThrow(/UNIQUE constraint/iu);
      expect(() =>
        database
          .prepare(
            "INSERT INTO letters(id,thread_id,agent_id,direction,status,created_at_utc,updated_at_utc) VALUES ('wrong-agent','thread-existing','missing-agent','user_to_agent','draft',?,?)",
          )
          .run(DISPATCHED, DISPATCHED),
      ).toThrow(/agent must match/iu);
    } finally {
      database.close();
    }
  });

  it("permits zero transit only for email and retains sent, received and opened achievement hooks", () => {
    const database = openDatabase(":memory:");
    try {
      applyThrough041(database);
      seedPhysicalCorrespondence(database);
      runMigrations(database);
      insertDraft(database, "email", "email", "create-email");
      sealDraft(database, "email", "fixed_0d_v1", DISPATCHED);
      expect(
        database
          .prepare(
            "SELECT delivery_method,dispatched_at_utc,arrival_due_at_utc FROM letters WHERE id='email'",
          )
          .get(),
      ).toEqual({
        delivery_method: "email",
        dispatched_at_utc: DISPATCHED,
        arrival_due_at_utc: DISPATCHED,
      });

      for (const [method, policy] of METHODS) {
        insertDraft(
          database,
          `invalid-zero-${method}`,
          method,
          `zero-${method}`,
        );
        expect(() =>
          sealDraft(database, `invalid-zero-${method}`, policy, DISPATCHED),
        ).toThrow(/CHECK constraint/iu);
      }
      insertDraft(database, "invalid-email-delay", "email", "delayed-email");
      expect(() =>
        sealDraft(database, "invalid-email-delay", "fixed_0d_v1", ARRIVAL),
      ).toThrow(/CHECK constraint/iu);
      expect(() =>
        sealDraft(database, "invalid-email-delay", "fixed_5d_v1", ARRIVAL),
      ).toThrow(/CHECK constraint/iu);

      database
        .prepare(
          "UPDATE letters SET status='delivered_unread', delivered_effective_at_utc=arrival_due_at_utc, processed_at_utc=arrival_due_at_utc, updated_at_utc=arrival_due_at_utc WHERE id='encrypted-reply'",
        )
        .run();
      database
        .prepare(
          "UPDATE letters SET status='read', opened_at_utc=arrival_due_at_utc WHERE id='encrypted-reply'",
        )
        .run();
      expect(
        database
          .prepare(
            "SELECT definition_key,evidence_id FROM achievement_unlocks WHERE definition_key LIKE 'first.letter.%' ORDER BY definition_key",
          )
          .all(),
      ).toEqual([
        {
          definition_key: "first.letter.opened",
          evidence_id: "encrypted-reply",
        },
        {
          definition_key: "first.letter.received",
          evidence_id: "encrypted-reply",
        },
        { definition_key: "first.letter.sent", evidence_id: "email" },
      ]);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});

function applyThrough041(database: Database): void {
  database.exec(
    "CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)",
  );
  // Build the old schema only. Upgrade assertions below exercise the real
  // migration runner, including its transaction and foreign-key restoration.
  database.pragma("foreign_keys = OFF");
  try {
    for (const name of readdirSync(new URL("./migrations", import.meta.url))
      .filter((name) => /^\d+[_-].+\.sql$/u.test(name) && name < "042_")
      .sort()) {
      database.exec(
        readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8"),
      );
      database
        .prepare(
          "INSERT INTO schema_migrations(name,applied_at_utc) VALUES (?,?)",
        )
        .run(name, DISPATCHED);
    }
  } finally {
    database.pragma("foreign_keys = ON");
  }
}

function seedPhysicalCorrespondence(database: Database): void {
  database
    .prepare(
      "INSERT INTO characters(id,current_version,status,tier,name,source_type,created_at_utc,updated_at_utc) VALUES ('agent-1',1,'published','daily','Letters','original',?,?)",
    )
    .run(DISPATCHED, DISPATCHED);
  database
    .prepare(
      "INSERT INTO correspondence_threads(id,agent_id,status,created_at_utc,updated_at_utc) VALUES ('thread-existing','agent-1','open',?,?)",
    )
    .run(DISPATCHED, DISPATCHED);
  METHODS.forEach(([method, policy, arrival], index) => {
    database
      .prepare(
        `INSERT INTO letters(
      rowid,id,thread_id,agent_id,create_request_id,create_request_hash,seal_request_id,
      direction,status,delivery_method,body,content_hash,transit_policy_version,
      transit_timezone,dispatched_at_utc,arrival_due_at_utc,effective_author_time_utc,
      delivered_effective_at_utc,processed_at_utc,read_at_utc,created_at_utc,updated_at_utc)
      VALUES (? ,?,'thread-existing','agent-1',?,?,?,'user_to_agent','read',?,?,?,?,
      'Asia/Shanghai',?,?,?,?,?,?,?,?)`,
      )
      .run(
        42 + index,
        `incoming-${method}`,
        `create-${method}`,
        HASH,
        `seal-${method}`,
        method,
        `旧${method}信件内容`,
        HASH,
        policy,
        DISPATCHED,
        arrival,
        DISPATCHED,
        arrival,
        arrival,
        arrival,
        DISPATCHED,
        arrival,
      );
  });
  database
    .prepare(
      `INSERT INTO letters(
    rowid,id,thread_id,agent_id,reply_to_letter_id,direction,status,delivery_method,
    content_hash,encrypted_ciphertext,encrypted_iv,encrypted_auth_tag,
    encrypted_key_version,encrypted_aad_hash,encrypted_created_at_utc,
    transit_policy_version,transit_timezone,dispatched_at_utc,arrival_due_at_utc,
    effective_author_time_utc,created_at_utc,updated_at_utc)
    VALUES (99,'encrypted-reply','thread-existing','agent-1','incoming-standard',
    'agent_to_user','in_transit','priority',?,'ciphertext-preserved','iv-preserved',
    'tag-preserved',1,?,?,'fixed_1d_v1','Asia/Shanghai',?,'2026-09-09T12:00:00.000Z',?,?,?)`,
    )
    .run(HASH, HASH, ARRIVAL, ARRIVAL, ARRIVAL, ARRIVAL, ARRIVAL);
  database
    .prepare(
      "UPDATE correspondence_threads SET root_letter_id='incoming-standard', latest_letter_id='encrypted-reply'",
    )
    .run();
  database
    .prepare(
      `INSERT INTO letter_generation_snapshots(id,incoming_letter_id,agent_id,
    effective_at_utc,character_version,state_revision,context_json,evidence_ids_json,
    context_hash,created_at_utc)
    VALUES ('snapshot','incoming-standard','agent-1',?,1,0,'{}','[]',?,?)`,
    )
    .run(ARRIVAL, HASH, ARRIVAL);
  database
    .prepare(
      `INSERT INTO letter_generation_runs(id,incoming_letter_id,snapshot_id,
    agent_id,reply_letter_id,generation_epoch,status,attempt,provider,model,created_at_utc,
    updated_at_utc,committed_at_utc)
    VALUES ('run','incoming-standard','snapshot','agent-1','encrypted-reply',0,
    'committed',1,'fixture','fixture',?,?,?)`,
    )
    .run(ARRIVAL, ARRIVAL, ARRIVAL);
  database
    .prepare(
      `INSERT INTO temporal_tasks(id,agent_id,kind,entity_id,due_at_utc,
    priority,status,idempotency_key,created_at_utc,updated_at_utc)
    VALUES ('return-arrival','agent-1','letter.return_arrival','encrypted-reply',
    '2026-09-09T12:00:00.000Z',10,'pending','return-arrival:encrypted-reply',?,?)`,
    )
    .run(ARRIVAL, ARRIVAL);
}

function insertDraft(
  database: Database,
  id: string,
  method: string,
  requestId: string,
): void {
  database
    .prepare(
      `INSERT INTO letters(id,thread_id,agent_id,create_request_id,
    create_request_hash,direction,status,delivery_method,body,created_at_utc,updated_at_utc)
    VALUES (?,'thread-existing','agent-1',?,?,'user_to_agent','draft',?,'新信件',?,?)`,
    )
    .run(id, requestId, HASH, method, DISPATCHED, DISPATCHED);
}

function sealDraft(
  database: Database,
  id: string,
  policy: string,
  arrival: string,
): void {
  database
    .prepare(
      `UPDATE letters SET status='sealed',content_hash=?,
    transit_policy_version=?,transit_timezone='Asia/Shanghai',dispatched_at_utc=?,
    arrival_due_at_utc=?,effective_author_time_utc=? WHERE id=?`,
    )
    .run(HASH, policy, DISPATCHED, arrival, DISPATCHED, id);
}

function allRows(database: Database, table: string): unknown[] {
  // All callers use fixed table names from this test, never runtime input.
  return database.prepare(`SELECT rowid, * FROM ${table} ORDER BY rowid`).all();
}
