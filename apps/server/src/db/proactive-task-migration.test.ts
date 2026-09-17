import { describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";
import { runMigrations } from "./migrations.js";
import { CorrespondenceRepository } from "../repositories/correspondence-repository.js";

describe("proactive queue migration", () => {
  it("preserves existing task identities, claims, and foreign-key references when widening the queue", () => {
    const database = openDatabase(":memory:");
    try {
      runMigrations(database);
      const nowUtc = "2026-09-03T04:00:00.000Z";
      database
        .prepare(
          `INSERT INTO characters(id, current_version, status, tier, name, source_type, created_at_utc, updated_at_utc)
         VALUES ('migration-proactive-agent', 1, 'published', 'high_fidelity', 'Migration', 'original', ?, ?)`,
        )
        .run(nowUtc, nowUtc);
      const repository = new CorrespondenceRepository(database);
      const task = repository.createTemporalTask({
        agentId: "migration-proactive-agent",
        entityId: "migration-letter",
        kind: "letter.reply_generation",
        dueAtUtc: nowUtc,
        priority: 1,
        idempotencyKey: "migration:existing-letter-task",
        createdAtUtc: nowUtc,
        payload: { snapshotId: "preserved-snapshot" },
      });
      const claimed = repository.claimDueTask({
        taskId: task.id,
        nowUtc,
        claimToken: "migration-existing-claim",
        leaseExpiresAtUtc: "2026-09-03T04:30:00.000Z",
      });
      database.exec(
        "CREATE TABLE existing_task_reference(task_id TEXT REFERENCES temporal_tasks(id) ON DELETE RESTRICT)",
      );
      database
        .prepare("INSERT INTO existing_task_reference VALUES (?)")
        .run(task.id);
      // Recreate the migration boundary after seeding an existing durable queue.
      database.exec("DROP TABLE proactive_task_evaluations");
      database
        .prepare("DELETE FROM schema_migrations WHERE name = ?")
        .run("040_proactive_temporal_tasks.sql");
      expect(runMigrations(database)).toEqual([
        "040_proactive_temporal_tasks.sql",
      ]);
      expect(repository.getTask(task.id)).toEqual(claimed);
      expect(
        database.prepare("SELECT task_id FROM existing_task_reference").get(),
      ).toEqual({ task_id: task.id });
      expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(() =>
        database
          .prepare(
            "UPDATE temporal_tasks SET kind = 'proactive.activity_review' WHERE id = ?",
          )
          .run(task.id),
      ).toThrow("identity is immutable");
    } finally {
      database.close();
    }
  });
});
