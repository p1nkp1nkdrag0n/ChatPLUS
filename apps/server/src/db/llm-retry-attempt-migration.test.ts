import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";

describe("016_llm_retry_attempt_telemetry migration", () => {
  it("upgrades a database that already applied provider usage telemetry", () => {
    const database = openDatabase(":memory:");
    try {
      database.exec(migrationSql("001_initial.sql"));
      database
        .prepare(
          `INSERT INTO llm_calls(
            id, purpose, provider, model, input_tokens, output_tokens,
            latency_ms, success, created_at_utc
          ) VALUES (?, 'chat_turn', 'fixture', 'fixture-v1', 0, 0, 0, ?, ?)`,
        )
        .run("llmcall-success", 1, "2026-08-23T00:00:00.000Z");
      database
        .prepare(
          `INSERT INTO llm_calls(
            id, purpose, provider, model, input_tokens, output_tokens,
            latency_ms, success, error_code, created_at_utc
          ) VALUES (?, 'chat_turn', 'fixture', 'fixture-v1', 0, 0, 0, 0, ?, ?)`,
        )
        .run("llmcall-failure", "legacy_failure", "2026-08-23T00:00:01.000Z");
      database.exec(migrationSql("015_llm_provider_usage.sql"));

      database.exec(migrationSql("016_llm_retry_attempt_telemetry.sql"));
      database.exec(migrationSql("017_llm_attempt_usage_coverage.sql"));

      expect(
        database
          .prepare(
            `SELECT id, attempt_count AS attemptCount,
              failed_attempt_count AS failedAttemptCount,
              provider_input_usage_attempt_count AS providerInputUsageAttemptCount,
              provider_output_usage_attempt_count AS providerOutputUsageAttemptCount,
              attempt_telemetry_source AS attemptTelemetrySource
             FROM llm_calls ORDER BY id`,
          )
          .all(),
      ).toEqual([
        {
          id: "llmcall-failure",
          attemptCount: 1,
          failedAttemptCount: 1,
          providerInputUsageAttemptCount: 0,
          providerOutputUsageAttemptCount: 0,
          attemptTelemetrySource: "inferred",
        },
        {
          id: "llmcall-success",
          attemptCount: 1,
          failedAttemptCount: 0,
          providerInputUsageAttemptCount: 0,
          providerOutputUsageAttemptCount: 0,
          attemptTelemetrySource: "inferred",
        },
      ]);

      database
        .prepare(
          `UPDATE llm_calls
           SET attempt_count = 2, failed_attempt_count = 1
           WHERE id = ?`,
        )
        .run("llmcall-success");
      expect(() =>
        database
          .prepare(
            `UPDATE llm_calls
             SET attempt_count = 1, failed_attempt_count = 2
             WHERE id = ?`,
          )
          .run("llmcall-success"),
      ).toThrow();

      database
        .prepare(
          `INSERT INTO llm_calls(
            id, purpose, provider, model, input_tokens, output_tokens,
            latency_ms, success, error_code, created_at_utc
          ) VALUES (?, 'chat_turn', 'fixture', 'fixture-v1', 0, 0, 0, 0, ?, ?)`,
        )
        .run(
          "llmcall-legacy-after-017",
          "legacy_failure",
          "2026-08-23T00:00:02.000Z",
        );
      expect(
        database
          .prepare(
            `SELECT attempt_count AS attemptCount,
              failed_attempt_count AS failedAttemptCount,
              attempt_telemetry_source AS attemptTelemetrySource
             FROM llm_calls WHERE id = ?`,
          )
          .get("llmcall-legacy-after-017"),
      ).toEqual({
        attemptCount: 1,
        failedAttemptCount: 1,
        attemptTelemetrySource: "inferred",
      });

      expect(() =>
        database
          .prepare(
            `INSERT INTO llm_calls(
              id, purpose, provider, model, input_tokens, output_tokens,
              latency_ms, success, created_at_utc, attempt_count,
              failed_attempt_count, attempt_telemetry_source
            ) VALUES (?, 'chat_turn', 'fixture', 'fixture-v1', 0, 0, 0, 1,
              ?, 1, 1, 'exact')`,
          )
          .run("llmcall-invalid-exact", "2026-08-23T00:00:03.000Z"),
      ).toThrow(/invalid exact llm attempt telemetry/u);
    } finally {
      database.close();
    }
  });
});

function migrationSql(name: string): string {
  return readFileSync(new URL("./migrations/" + name, import.meta.url), "utf8");
}
