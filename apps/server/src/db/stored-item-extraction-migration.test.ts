import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./connection.js";
import { runMigrations } from "./migrations.js";

describe("stored item extraction repair", () => {
  it("quarantines the old false projection and invalidates its dependencies once", () => {
    const database = openDatabase(":memory:");
    const directory = new URL("./migrations/", import.meta.url);
    try {
      database.exec(
        "CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)",
      );
      for (const name of readdirSync(directory)
        .filter((name) => /^\d+_.+\.sql$/u.test(name) && name < "027_")
        .sort()) {
        database.exec(readFileSync(new URL(name, directory), "utf8"));
        database
          .prepare("INSERT INTO schema_migrations VALUES (?, ?)")
          .run(name, "2026-09-07T00:00:00.000Z");
      }
      database.exec(`
        INSERT INTO characters(id,current_version,status,tier,name,source_type,created_at_utc,updated_at_utc)
          VALUES ('a',1,'published','daily','A','original','2026-09-07T00:00:00.000Z','2026-09-07T00:00:00.000Z');
        INSERT INTO memories(id,agent_id,type,content,tags_json,importance,confidence,created_at_utc,status,claim_subject_key,claim_disposition,memory_json)
          VALUES ('bad','a','semantic','用户的也现在存放在：也还在用那本笔记。','[]',0.8,1,'2026-09-07T00:00:00.000Z','active','user_fact:item:也:storage','affirmed','{"status":"active"}'),
          ('good','a','semantic','用户的护照现在存放在：笔记还在用，护照还在抽屉里。','[]',0.8,1,'2026-09-07T00:00:00.000Z','active','user_fact:item:护照:storage','affirmed','{"status":"active"}');
        INSERT INTO memory_derived_validity VALUES ('a','autobiography_entry','derived-bad','active','complete_source_v1','2026-09-07T00:00:00.000Z');
        INSERT INTO memory_derivation_dependencies VALUES ('a','autobiography_entry','derived-bad','memory','bad','${"0".repeat(64)}','2026-09-07T00:00:00.000Z');
      `);
      const revision = () =>
        (
          database
            .prepare(
              "SELECT revision FROM agent_memory_revisions WHERE agent_id = 'a'",
            )
            .get() as { revision: number }
        ).revision;
      const before = revision();
      expect(runMigrations(database)).toContain(
        "027_stored_item_extraction_repair.sql",
      );
      expect(
        database.prepare("SELECT id, status FROM memories ORDER BY id").all(),
      ).toEqual([
        { id: "bad", status: "needs_review" },
        { id: "good", status: "active" },
      ]);
      expect(
        database.prepare("SELECT state FROM memory_derived_validity").get(),
      ).toEqual({ state: "needs_review" });
      expect(revision()).toBe(before + 1);
      expect(
        database.prepare("SELECT content FROM memories WHERE id = 'bad'").get(),
      ).toEqual({ content: "用户的也现在存放在：也还在用那本笔记。" });
      expect(runMigrations(database)).toEqual([]);
      expect(revision()).toBe(before + 1);
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
    }
  });
});

