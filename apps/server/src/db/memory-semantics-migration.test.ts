import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";

const CREATED_AT_UTC = "2026-08-20T03:00:00.000Z";

describe("008_memory_semantics migration", () => {
  it("promotes only user-message memories to verified user evidence", () => {
    const database = openDatabase(":memory:");
    try {
      database.exec(migrationSql("001_initial.sql"));
      database
        .prepare(
          `INSERT INTO characters(
            id, current_version, status, tier, name, source_type,
            created_at_utc, updated_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "agent-memory-backfill",
          1,
          "published",
          "daily",
          "Memory Backfill",
          "original",
          CREATED_AT_UTC,
          CREATED_AT_UTC,
        );
      database
        .prepare(
          `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "session-memory-backfill",
          "agent-memory-backfill",
          "Backfill",
          CREATED_AT_UTC,
          CREATED_AT_UTC,
        );
      const insertMessage = database.prepare(
        `INSERT INTO messages(
          id, session_id, agent_id, role, content, message_kind, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      insertMessage.run(
        "message-user",
        "session-memory-backfill",
        "agent-memory-backfill",
        "user",
        "The user stated a durable preference.",
        "user",
        CREATED_AT_UTC,
      );
      insertMessage.run(
        "message-assistant",
        "session-memory-backfill",
        "agent-memory-backfill",
        "assistant",
        "The character inferred a possible preference.",
        "assistant_reply",
        CREATED_AT_UTC,
      );
      insertMessage.run(
        "message-system",
        "session-memory-backfill",
        "agent-memory-backfill",
        "system",
        "A system-generated context note.",
        "system_notice",
        CREATED_AT_UTC,
      );
      const insertMemory = database.prepare(
        `INSERT INTO memories(
          id, agent_id, type, content, tags_json, importance, confidence,
          source_message_id, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const [memoryId, messageId] of [
        ["memory-user", "message-user"],
        ["memory-assistant", "message-assistant"],
        ["memory-system", "message-system"],
      ] as const) {
        insertMemory.run(
          memoryId,
          "agent-memory-backfill",
          "semantic",
          memoryId,
          "[]",
          0.5,
          0.6,
          messageId,
          CREATED_AT_UTC,
        );
      }

      database.exec(migrationSql("008_memory_semantics.sql"));

      const rows = database
        .prepare(
          `SELECT id, namespace, certainty, attribution, status,
             mentioned_at_utc AS mentionedAtUtc,
             temporal_certainty AS temporalCertainty,
             temporal_status AS temporalStatus
           FROM memories ORDER BY id`,
        )
        .all() as Array<Record<string, unknown>>;
      expect(rows).toEqual([
        {
          id: "memory-assistant",
          namespace: "character_self",
          certainty: "inferred",
          attribution: "character_decision",
          status: "needs_review",
          mentionedAtUtc: CREATED_AT_UTC,
          temporalCertainty: "exact",
          temporalStatus: "unknown",
        },
        {
          id: "memory-system",
          namespace: "runtime_simulation",
          certainty: "uncertain",
          attribution: "model_inference",
          status: "needs_review",
          mentionedAtUtc: CREATED_AT_UTC,
          temporalCertainty: "exact",
          temporalStatus: "unknown",
        },
        {
          id: "memory-user",
          namespace: "user_model",
          certainty: "explicit",
          attribution: "user_explicit",
          status: "active",
          mentionedAtUtc: CREATED_AT_UTC,
          temporalCertainty: "exact",
          temporalStatus: "unknown",
        },
      ]);
      const verified = database
        .prepare(
          `SELECT memories.id FROM memories
           JOIN messages ON messages.id = memories.source_message_id
           WHERE memories.attribution = 'user_explicit'
              OR memories.namespace = 'user_model'`,
        )
        .all() as Array<{ id: string }>;
      expect(verified).toEqual([{ id: "memory-user" }]);
    } finally {
      database.close();
    }
  });

  it("uses authoritative message and activity timestamps", () => {
    const database = openDatabase(":memory:");
    const messageAtUtc = "2026-08-19T23:00:00.000Z";
    const activityAtUtc = "2026-08-20T01:00:00.000Z";
    try {
      database.exec(migrationSql("001_initial.sql"));
      database
        .prepare(
          `INSERT INTO characters(
            id, current_version, status, tier, name, source_type,
            created_at_utc, updated_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "agent-source-time",
          1,
          "published",
          "daily",
          "Source Time",
          "original",
          CREATED_AT_UTC,
          CREATED_AT_UTC,
        );
      database
        .prepare(
          `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "session-source-time",
          "agent-source-time",
          "Source Time",
          CREATED_AT_UTC,
          CREATED_AT_UTC,
        );
      database
        .prepare(
          `INSERT INTO messages(
            id, session_id, agent_id, role, content, message_kind, created_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "message-source-time",
          "session-source-time",
          "agent-source-time",
          "user",
          "A durable fact.",
          "user",
          messageAtUtc,
        );
      database
        .prepare(
          `INSERT INTO activity_events(
            id, agent_id, schedule_item_id, event_type, occurred_at_utc,
            summary, outcome_facts_json, state_delta_json, origin,
            idempotency_key, event_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "activity-source-time",
          "agent-source-time",
          null,
          "completed",
          activityAtUtc,
          "An activity occurred.",
          "[]",
          "{}",
          "deterministic",
          "activity-source-time",
          "{}",
        );
      const insertMemory = database.prepare(
        `INSERT INTO memories(
          id, agent_id, type, content, tags_json, importance, confidence,
          source_message_id, source_event_id, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertMemory.run(
        "memory-source-message",
        "agent-source-time",
        "semantic",
        "Message-backed",
        "[]",
        0.5,
        0.6,
        "message-source-time",
        null,
        CREATED_AT_UTC,
      );
      insertMemory.run(
        "memory-source-activity",
        "agent-source-time",
        "episodic",
        "Activity-backed",
        "[]",
        0.5,
        0.6,
        null,
        "activity-source-time",
        CREATED_AT_UTC,
      );

      database.exec(migrationSql("008_memory_semantics.sql"));

      expect(
        database
          .prepare(
            `SELECT id, mentioned_at_utc AS mentionedAtUtc,
               occurred_start_at_utc AS occurredStartAtUtc
             FROM memories ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "memory-source-activity",
          mentionedAtUtc: null,
          occurredStartAtUtc: activityAtUtc,
        },
        {
          id: "memory-source-message",
          mentionedAtUtc: messageAtUtc,
          occurredStartAtUtc: null,
        },
      ]);
    } finally {
      database.close();
    }
  });
});

function migrationSql(name: string): string {
  return readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
}
