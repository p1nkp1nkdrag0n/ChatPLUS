import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";

describe("character generation strategy", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
  });

  it("keeps the full author brief auditable and operationalizes year-only story time", async () => {
    const clock = new FakeClock("2026-09-01T01:00:00.000Z");
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "character-strategy-test",
        databasePath: ":memory:",
        clockMode: "fake",
        seedDemo: false,
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      database: openDatabase(":memory:"),
      clock,
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
    const brief =
      "时代背景为1951年的苏联明斯克。公开场合保持克制，私下更柔软；战争经历使她重视可核验的事实。".repeat(
        80,
      );
    const generated = await app.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: {
        name: "卓娅",
        worldSetting: "战后重建时期的明斯克",
        workOrRole: "档案员",
        coreTraits: ["冷静", "克制", "有责任感"],
        coreContradiction: "害怕再次失去，却不愿把恐惧转嫁给亲近的人",
        mainGoal: "参与城市档案重建",
        initialRelationship: "共同生活两年的师生",
        dialogueStyle: "通常使用俄语，并在每个消息单元后附中文翻译。",
        characterBrief: brief,
        storyAnchorYear: 1951,
        storyEra: "1951 年战后明斯克",
        tier: "high_fidelity",
        timezone: "Europe/Minsk",
      },
    });
    expect(generated.statusCode).toBe(201);
    const character = generated.json<{
      character: { id: string; identity: Record<string, unknown> };
    }>().character;
    expect(character.identity).toMatchObject({
      temporalFrame: {
        mode: "anchored_story",
        eraLabel: "1951 年战后明斯克",
        storyAnchorLocalDate: "1951-09-01",
        anchorPrecision: "year",
        systemAnchorUtc: "2026-09-01T01:00:00.000Z",
      },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/characters/${character.id}`,
    });
    const sources = detail.json<{
      sources: Array<{
        sourceType: string;
        contentExcerpt: string;
        sourceHash: string;
      }>;
    }>().sources;
    expect(sources[0]).toMatchObject({
      sourceType: "original_character_brief",
      contentExcerpt: brief,
      sourceHash: createHash("sha256").update(brief).digest("hex"),
    });
  });
});
