import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";

describe("015_llm_provider_usage migration", () => {
  it("backfills legacy audits as estimated and accepts bounded provider usage", () => {
    const database = openDatabase(":memory:");
    try {
      database.exec(migrationSql("001_initial.sql"));
      database
        .prepare(
          `INSERT INTO llm_calls(
            id, purpose, provider, model, input_tokens, output_tokens,
            latency_ms, success, created_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "llmcall-legacy",
          "chat_turn",
          "fixture",
          "personasim-fixture-v1",
          12,
          4,
          8,
          1,
          "2026-08-23T00:00:00.000Z",
        );

      database.exec(migrationSql("015_llm_provider_usage.sql"));

      expect(
        database
          .prepare(
            `SELECT provider_input_tokens AS providerInputTokens,
              provider_output_tokens AS providerOutputTokens,
              usage_source AS usageSource
             FROM llm_calls WHERE id = ?`,
          )
          .get("llmcall-legacy"),
      ).toEqual({
        providerInputTokens: null,
        providerOutputTokens: null,
        usageSource: "estimated",
      });

      database
        .prepare(
          `UPDATE llm_calls SET
            provider_input_tokens = ?, provider_output_tokens = ?,
            usage_source = 'provider'
           WHERE id = ?`,
        )
        .run(31, 7, "llmcall-legacy");
      expect(
        database
          .prepare(
            `SELECT input_tokens AS inputTokens, output_tokens AS outputTokens,
              provider_input_tokens AS providerInputTokens,
              provider_output_tokens AS providerOutputTokens,
              usage_source AS usageSource
             FROM llm_calls WHERE id = ?`,
          )
          .get("llmcall-legacy"),
      ).toEqual({
        inputTokens: 12,
        outputTokens: 4,
        providerInputTokens: 31,
        providerOutputTokens: 7,
        usageSource: "provider",
      });
    } finally {
      database.close();
    }
  });

  it("rejects negative provider usage and unknown sources", () => {
    const database = openDatabase(":memory:");
    try {
      database.exec(migrationSql("001_initial.sql"));
      database.exec(migrationSql("015_llm_provider_usage.sql"));
      database
        .prepare(
          `INSERT INTO llm_calls(
            id, purpose, provider, model, input_tokens, output_tokens,
            latency_ms, success, created_at_utc
          ) VALUES (?, ?, ?, ?, 0, 0, 0, 1, ?)`,
        )
        .run(
          "llmcall-constraints",
          "chat_turn",
          "fixture",
          "personasim-fixture-v1",
          "2026-08-23T00:00:00.000Z",
        );

      expect(() =>
        database
          .prepare(
            "UPDATE llm_calls SET provider_input_tokens = -1 WHERE id = ?",
          )
          .run("llmcall-constraints"),
      ).toThrow();
      expect(() =>
        database
          .prepare("UPDATE llm_calls SET usage_source = 'raw' WHERE id = ?")
          .run("llmcall-constraints"),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            "UPDATE llm_calls SET usage_source = 'provider' WHERE id = ?",
          )
          .run("llmcall-constraints"),
      ).toThrow();
      expect(() =>
        database
          .prepare(
            `UPDATE llm_calls SET provider_input_tokens = 1,
              usage_source = 'estimated' WHERE id = ?`,
          )
          .run("llmcall-constraints"),
      ).toThrow();
    } finally {
      database.close();
    }
  });
});

function migrationSql(name: string): string {
  return readFileSync(new URL("./migrations/" + name, import.meta.url), "utf8");
}
