import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./connection.js";
import { runMigrations } from "./migrations.js";

const NOW = "2026-09-11T04:00:00.000Z";
const migration = "034_achievement_wax_versions.sql";
describe("achievement wax migration", () => {
  it("backfills published v1 images, preserving active v1 jobs and their frozen profiles without scheduling a redraw", () => {
    const database = openDatabase(":memory:");
    try {
      database.exec(
        "CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at_utc TEXT NOT NULL)",
      );
      const directory = fileURLToPath(
        new URL("./migrations/", import.meta.url),
      );
      for (const name of readdirSync(directory)
        .filter((file) => file.endsWith(".sql") && file < migration)
        .sort()) {
        database.exec(readFileSync(join(directory, name), "utf8"));
        database
          .prepare("INSERT INTO schema_migrations VALUES(?,?)")
          .run(name, NOW);
      }
      database
        .prepare(
          "INSERT INTO achievement_visual_profiles VALUES('agent-test',?,?)",
        )
        .run('{"name":"original","role":"botanist"}', NOW);
      for (const [id, status, hasImage] of [
        ["old-ready", "ready", true],
        ["old-generating", "generating", false],
        ["old-failed", "failed", true],
      ] as const) {
        database
          .prepare(
            `INSERT INTO achievement_unlocks(id,definition_key,scope_key,agent_id,title,description,category,badge_key,
          unlocked_at_utc,recorded_at_utc,evidence_kind,evidence_id)
          SELECT ?,key,?,'agent-test',title,description,category,badge_key,?,?,'test','test' FROM achievement_definitions WHERE key='relationship.90'`,
          )
          .run(id, id, NOW, NOW);
        database
          .prepare(
            `UPDATE achievement_badge_jobs SET status=?,attempts=1,claim_token=?,storage_key=?,thumbnail_storage_key=?,sha256=? WHERE achievement_id=?`,
          )
          .run(
            status,
            status === "generating" ? "lease-before-migration" : null,
            hasImage ? `${id}/primary.webp` : null,
            hasImage ? `${id}/thumb.webp` : null,
            hasImage ? id.padEnd(64, "a") : null,
            id,
          );
      }
      const jobs = database
        .prepare("SELECT * FROM achievement_badge_jobs ORDER BY achievement_id")
        .all();
      const profiles = database
        .prepare("SELECT * FROM achievement_visual_profiles")
        .all();
      expect(runMigrations(database)).toEqual([migration]);
      expect(
        database
          .prepare(
            "SELECT * FROM achievement_badge_jobs ORDER BY achievement_id",
          )
          .all(),
      ).toEqual(jobs);
      expect(
        database.prepare("SELECT * FROM achievement_visual_profiles").all(),
      ).toEqual(profiles);
      expect(
        database
          .prepare(
            "SELECT achievement_id,visual_version FROM achievement_badge_versions ORDER BY achievement_id",
          )
          .all(),
      ).toEqual([
        { achievement_id: "old-failed", visual_version: 1 },
        { achievement_id: "old-ready", visual_version: 1 },
      ]);
      expect(runMigrations(database)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
