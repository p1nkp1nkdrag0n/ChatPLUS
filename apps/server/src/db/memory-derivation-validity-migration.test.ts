import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./connection.js";
import { runMigrations } from "./migrations.js";

describe("023 memory derivation validity migration", () => {
  it("marks unvalidated old projections for review, preserves originals, and remains restart-safe", () => {
    const database = openDatabase(":memory:");
    const directory = new URL("./migrations/", import.meta.url);
    try {
      database.exec(
        "CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)",
      );
      for (const name of readdirSync(directory)
        .filter((name) => /^\d+[_-].+\.sql$/u.test(name) && name < "023_")
        .sort()) {
        database.exec(readFileSync(new URL(name, directory), "utf8"));
        database
          .prepare("INSERT INTO schema_migrations VALUES (?, ?)")
          .run(name, "2026-09-06T00:00:00.000Z");
      }
      database.exec(`
        INSERT INTO characters(id,current_version,status,tier,name,source_type,created_at_utc,updated_at_utc)
          VALUES ('a',1,'published','daily','A','original','2026-09-06T00:00:00.000Z','2026-09-06T00:00:00.000Z');
        INSERT INTO sessions(id,agent_id,title,created_at_utc,updated_at_utc)
          VALUES ('s','a','S','2026-09-06T00:00:00.000Z','2026-09-06T00:00:00.000Z');
        INSERT INTO messages(id,session_id,agent_id,role,content,message_kind,metadata_json,created_at_utc)
          VALUES ('m','s','a','user','我没有辞职，只是考虑过。','user','{}','2026-09-06T00:00:00.000Z');
        INSERT INTO conversation_checkpoints(id,agent_id,session_id,from_message_id,through_message_id,source_hash,source_revision,source_message_count,source_token_estimate,status,created_at_utc,updated_at_utc)
          VALUES ('c','a','s','m','m','${"0".repeat(64)}',1,1,10,'committed','2026-09-06T00:00:00.000Z','2026-09-06T00:00:00.000Z');
        INSERT INTO autobiography_snapshots(id,agent_id,source_checkpoint_id,revision,summary_first_person,important_experiences_json,relationship_changes_json,active_goals_json,unresolved_threads_json,commitments_json,source_evidence_ids_json,from_utc,through_utc,snapshot_json,created_at_utc)
          VALUES ('snapshot','a','c',1,'用户已经辞职。','["用户已经辞职。"]','[]','[]','[]','[]','["e"]','2026-09-06T00:00:00.000Z','2026-09-06T00:00:00.000Z','{"summaryFirstPerson":"用户已经辞职。"}','2026-09-06T00:00:00.000Z');
        INSERT INTO autobiography_entries(id,snapshot_id,agent_id,entry_kind,ordinal,content,temporal_status,source_evidence_ids_json,evidence_json,created_at_utc)
          VALUES ('entry','snapshot','a','important_experience',0,'用户已经辞职。','unknown','["e"]','[]','2026-09-06T00:00:00.000Z');
        INSERT INTO event_cards(id,agent_id,card_kind,source_kind,source_id,dedupe_key,title,summary,tags_json,tags_text,namespace,certainty,attribution,temporal_status,recorded_at_utc,importance,status,source_evidence_ids_json,evidence_json,card_json,created_at_utc,updated_at_utc)
          VALUES ('card','a','conversation','autobiography_entry','entry','card','用户已经辞职。','用户已经辞职。','[]','','user_model','inferred','mixed','unknown','2026-09-06T00:00:00.000Z',0.7,'active','["e"]','[]','{"summary":"用户已经辞职。","status":"active"}','2026-09-06T00:00:00.000Z','2026-09-06T00:00:00.000Z');
      `);
      const history = database
        .prepare("SELECT snapshot_json FROM autobiography_snapshots")
        .get();
      expect(runMigrations(database)).toContain(
        "023_memory_derivation_validity.sql",
      );
      expect(runMigrations(database)).toEqual([]);
      expect(
        database
          .prepare(
            "SELECT derived_type, state, validator_version FROM memory_derived_validity ORDER BY derived_type",
          )
          .all(),
      ).toEqual([
        {
          derived_type: "autobiography_entry",
          state: "needs_review",
          validator_version: "legacy_unverified",
        },
        {
          derived_type: "event_card",
          state: "needs_review",
          validator_version: "legacy_unverified",
        },
      ]);
      expect(
        database.prepare("SELECT content FROM messages WHERE id = 'm'").get(),
      ).toEqual({ content: "我没有辞职，只是考虑过。" });
      expect(
        database
          .prepare("SELECT snapshot_json FROM autobiography_snapshots")
          .get(),
      ).toEqual(history);
      expect(
        database.prepare("SELECT summary, status FROM event_cards").get(),
      ).toEqual({ summary: "用户已经辞职。", status: "superseded" });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(() =>
        database.prepare("DELETE FROM characters WHERE id = 'a'").run(),
      ).not.toThrow();
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});
