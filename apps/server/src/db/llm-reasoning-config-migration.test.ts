import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";

describe("016 LLM reasoning config migration", () => {
  it("adds nullable reasoning metadata without inventing values for old calls", () => {
    const database = openDatabase(":memory:");
    try {
      database.exec(migrationSql("001_initial.sql"));
      database.exec(migrationSql("015_llm_provider_profiles.sql"));
      database
        .prepare(
          `INSERT INTO llm_calls(
            id, purpose, provider, provider_profile, model, input_tokens,
            output_tokens, latency_ms, success, created_at_utc
          ) VALUES (?, 'chat_turn', 'openai-compatible', 'legacy', ?, 10, 5, 20, 1, ?)`,
        )
        .run("llmcall-legacy", "deepseek-v4-flash", "2026-08-29T00:00:00.000Z");

      database.exec(migrationSql("016_llm_reasoning_config.sql"));

      expect(
        database
          .prepare(
            `SELECT reasoning_effort AS reasoningEffort,
              reasoning_request_format AS reasoningRequestFormat
             FROM llm_calls WHERE id = ?`,
          )
          .get("llmcall-legacy"),
      ).toEqual({ reasoningEffort: null, reasoningRequestFormat: null });
    } finally {
      database.close();
    }
  });
});

function migrationSql(name: string): string {
  return readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
}
