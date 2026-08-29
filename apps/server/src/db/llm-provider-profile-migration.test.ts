import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { openDatabase } from "./connection.js";

describe("015 LLM provider profile migration", () => {
  it("backfills legacy and fixture calls without guessing a named profile", () => {
    const database = openDatabase(":memory:");
    try {
      database.exec(migrationSql("001_initial.sql"));
      const insert = database.prepare(
        `INSERT INTO llm_calls(
          id, purpose, provider, model, input_tokens, output_tokens,
          latency_ms, success, created_at_utc
        ) VALUES (?, 'chat_turn', ?, ?, 10, 5, 20, 1, ?)`,
      );
      insert.run(
        "llmcall-fixture",
        "fixture",
        "personasim-fixture-v1",
        "2026-08-29T00:00:00.000Z",
      );
      insert.run(
        "llmcall-legacy",
        "openai-compatible",
        "deepseek-v4-flash",
        "2026-08-29T00:01:00.000Z",
      );

      database.exec(migrationSql("015_llm_provider_profiles.sql"));

      expect(
        database
          .prepare(
            "SELECT id, provider_profile AS providerProfile FROM llm_calls ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "llmcall-fixture", providerProfile: "fixture" },
        { id: "llmcall-legacy", providerProfile: "legacy" },
      ]);
    } finally {
      database.close();
    }
  });
});

function migrationSql(name: string): string {
  return readFileSync(new URL(`./migrations/${name}`, import.meta.url), "utf8");
}
