import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { openDatabase } from "./connection.js";

describe("029 LLM configuration revision audit migration", () => {
  it("keeps historical calls unknown and accepts only positive recorded revisions", () => {
    const database = openDatabase(":memory:");
    try {
      for (const migration of [
        "001_initial.sql",
        "015_llm_provider_profiles.sql",
        "016_llm_reasoning_config.sql",
      ])
        database.exec(
          readFileSync(
            new URL(`./migrations/${migration}`, import.meta.url),
            "utf8",
          ),
        );
      database
        .prepare(
          "INSERT INTO llm_calls(id,purpose,provider,provider_profile,model,input_tokens,output_tokens,latency_ms,success,created_at_utc) VALUES('old-call','chat_turn','fixture','fixture','personasim-fixture-v1',1,1,1,1,'2026-09-09T00:00:00.000Z')",
        )
        .run();
      database.exec(
        readFileSync(
          new URL("./migrations/029_llm_settings.sql", import.meta.url),
          "utf8",
        ),
      );
      expect(
        database
          .prepare("SELECT config_revision FROM llm_calls WHERE id='old-call'")
          .get(),
      ).toEqual({ config_revision: null });
      for (const invalid of [0, -1])
        expect(() =>
          database
            .prepare(
              "UPDATE llm_calls SET config_revision=? WHERE id='old-call'",
            )
            .run(invalid),
        ).toThrow(/CHECK constraint/);
      database
        .prepare("UPDATE llm_calls SET config_revision=2 WHERE id='old-call'")
        .run();
      expect(
        database
          .prepare(
            "SELECT provider,provider_profile,model,config_revision FROM llm_calls WHERE id='old-call'",
          )
          .get(),
      ).toEqual({
        provider: "fixture",
        provider_profile: "fixture",
        model: "personasim-fixture-v1",
        config_revision: 2,
      });
    } finally {
      database.close();
    }
  });
});
