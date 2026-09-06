import { describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";
import { runMigrations } from "./migrations.js";

const NOW = "2026-09-20T12:00:00.000Z";

describe("020 keepsake migration", () => {
  it("keeps the correspondence queue and accepts the isolated keepsake kind", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      database
        .prepare(
          `INSERT INTO characters(
             id, current_version, status, tier, name, source_type,
             created_at_utc, updated_at_utc
           ) VALUES ('agent-1', 1, 'published', 'high_fidelity', 'A',
                     'original', ?, ?)`,
        )
        .run(NOW, NOW);
      database
        .prepare(
          `INSERT INTO temporal_tasks(
             id, agent_id, kind, entity_id, due_at_utc, priority, status,
             attempt, max_attempts, idempotency_key, payload_json,
             created_at_utc, updated_at_utc
           ) VALUES ('task-1', 'agent-1', 'keepsake.generate', 'keepsake-1', ?,
                     30, 'pending', 0, 3, 'keepsake-task-1', '{}', ?, ?)`,
        )
        .run(NOW, NOW, NOW);
      expect(
        database
          .prepare("SELECT kind FROM temporal_tasks WHERE id = 'task-1'")
          .get(),
      ).toEqual({ kind: "keepsake.generate" });
      expect(() =>
        database
          .prepare(
            `UPDATE temporal_tasks SET kind = 'letter.return_arrival'
             WHERE id = 'task-1'`,
          )
          .run(),
      ).toThrow(/identity is immutable/u);
    } finally {
      database.close();
    }
  });

  it("enforces story immutability and one main asset per keepsake", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const names = [
        "keepsakes",
        "keepsake_assets",
        "keepsake_generation_runs",
        "keepsake_sources",
        "character_visual_profiles",
        "keepsake_letter_links",
      ];
      const present = database
        .prepare(
          `SELECT name FROM sqlite_master
           WHERE type = 'table' AND name IN (${names.map(() => "?").join(",")})`,
        )
        .all(...names) as Array<{ name: string }>;
      expect(new Set(present.map((row) => row.name))).toEqual(new Set(names));
      expect(runMigrations(database)).toEqual([]);
    } finally {
      database.close();
    }
  });
});
