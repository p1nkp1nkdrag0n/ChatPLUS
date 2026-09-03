import type { LlmProvider } from "@personasim/providers";
import { seededUnit } from "@personasim/features";
import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { scheduleItemSchema } from "../domain/schemas.js";
import { FakeClock } from "../runtime/clock.js";

const START_UTC = "2026-08-16T02:00:00.000Z";
const INITIAL_HORIZON_END_UTC = "2026-08-19T02:00:00.000Z";

describe("live-model prompt contracts", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("requests the complete strict schedule envelope for the exact missing range", async () => {
    const created = await createTestApp();
    app = created.app;
    const llm = vi.spyOn(app.personasim.llm, "generateObject");
    const character = await createAndPublish(app, "daily");

    const compileCall = llm.mock.calls.find(
      ([input]) => input.purpose === "compile_character",
    )?.[0];
    expect(compileCall?.maxOutputTokens).toBe(32_000);
    expect(compileCall?.maxOutputTokens).toBeLessThanOrEqual(64_000);

    llm.mockClear();
    created.clock.advance({ hours: 60 });
    const expectedTargetEndUtc = "2026-08-21T14:00:00.000Z";
    await app.personasim.schedules.ensure72Hours(character.id);

    const planCall = llm.mock.calls.find(
      ([input]) => input.purpose === "plan_schedule",
    )?.[0];
    expect(planCall).toBeDefined();
    expect(planCall?.prompt).toContain(
      `"horizonStartAtUtc":"${INITIAL_HORIZON_END_UTC}"`,
    );
    expect(planCall?.prompt).toContain(
      `"horizonEndAtUtc":"${expectedTargetEndUtc}"`,
    );
    expect(planCall?.prompt).toContain('"reasonCode":"schedule_plan"');
    expect(planCall?.prompt).toContain('"reasonSummary"');
    expect(planCall?.prompt).toContain('"items":ScheduleItemDraft[]');
    expect(planCall?.prompt).toContain(
      "Copy horizonStartAtUtc and horizonEndAtUtc exactly as shown",
    );
    expect(planCall?.fixture).toMatchObject({
      horizonStartAtUtc: INITIAL_HORIZON_END_UTC,
      horizonEndAtUtc: expectedTargetEndUtc,
    });
    expect(planCall?.schema.safeParse(planCall.fixture).success).toBe(true);
  });

  it("passes per-call output budgets through LlmService and budgets imports", async () => {
    const created = await createTestApp();
    app = created.app;
    const provider = (
      app.personasim.llm as unknown as { provider: LlmProvider }
    ).provider;
    const providerCall = vi.spyOn(provider, "generateObject");

    await app.personasim.llm.generateObject({
      purpose: "plan_schedule",
      system: "test",
      prompt: "test",
      schema: z.unknown(),
      maxOutputTokens: 12_345,
    });
    expect(providerCall).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 12_345 }),
    );

    const llm = vi.spyOn(app.personasim.llm, "generateObject");
    const imported = await app.inject({
      method: "POST",
      url: "/api/characters/import",
      payload: {
        characterName: "沈澄",
        workTitle: "潮汐来信",
        storyStage: "第一章结束",
        tier: "daily",
        timezone: "Asia/Shanghai",
        sourceText: "沈澄在第一章结束时选择留下，继续调查港口的旧事。",
        sourceFormat: "pasted_text",
      },
    });
    expect(imported.statusCode).toBe(201);
    const importCall = llm.mock.calls.find(
      ([input]) => input.purpose === "import_character",
    )?.[0];
    expect(importCall?.maxOutputTokens).toBe(32_000);
    expect(importCall?.maxOutputTokens).toBeLessThanOrEqual(64_000);
  });

  it("sends completed event ids with activities and requires verbatim echoes", async () => {
    const created = await createTestApp();
    app = created.app;
    const character = await createAndPublish(app, "high_fidelity");
    const startAtUtc = "2026-08-16T06:00:00.000Z";
    let itemId = "prompt-trip-0";
    for (let index = 0; index < 100; index += 1) {
      const candidateId = `prompt-trip-${index}`;
      if (seededUnit(`${character.id}${candidateId}${startAtUtc}`) < 0.5) {
        itemId = candidateId;
        break;
      }
    }
    app.personasim.store.insertScheduleItem(
      scheduleItemSchema.parse({
        id: itemId,
        agentId: character.id,
        title: "海边短途旅行",
        description: "沿着旧海堤散步。",
        category: "travel",
        startAtUtc,
        endAtUtc: "2026-08-16T07:00:00.000Z",
        timezone: "Asia/Shanghai",
        status: "planned",
        rigidity: "fixed",
        priority: 0.9,
        source: "manual",
        adherenceProbability: 1,
        narrativeImportance: 0.95,
        shareable: true,
        stateEffects: { moodValence: 0.12, energy: -0.08 },
        revision: 0,
        createdAtUtc: START_UTC,
        updatedAtUtc: START_UTC,
      }),
    );
    const llm = vi.spyOn(app.personasim.llm, "generateObject");
    created.clock.setUtc("2026-08-16T07:30:00.000Z");
    const activation = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(activation.statusCode).toBe(200);

    const completedEvent = app.personasim.store
      .listActivityEvents(character.id)
      .find(
        (event) =>
          event.scheduleItemId === itemId && event.eventType === "completed",
      );
    expect(completedEvent).toBeDefined();
    const enrichmentCall = llm.mock.calls.find(
      ([input]) => input.purpose === "enrich_activity",
    )?.[0];
    expect(enrichmentCall).toBeDefined();
    expect(enrichmentCall?.prompt).toContain(
      `"eventId":"${completedEvent?.id}"`,
    );
    expect(enrichmentCall?.prompt).toContain(
      `"scheduleItem":{"id":"${itemId}"`,
    );
    expect(enrichmentCall?.prompt).toContain(
      "copy each input eventId verbatim",
    );
    expect(enrichmentCall?.fixture).toMatchObject({
      events: [expect.objectContaining({ eventId: completedEvent?.id })],
    });
  });
});

async function createTestApp(): Promise<{
  app: PersonaSimApp;
  clock: FakeClock;
}> {
  const clock = new FakeClock(START_UTC);
  const config = readConfig({
    nodeEnv: "test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    lifePlanningMode: "legacy_exact",
    llm: {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
  });
  const app = await buildApp({
    config,
    database: openDatabase(":memory:"),
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
  return { app, clock };
}

async function createAndPublish(
  app: PersonaSimApp,
  tier: "daily" | "high_fidelity",
): Promise<{ id: string; version: number }> {
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "林夏",
      worldSetting: "当代城市生活",
      workOrRole: "研究生与独立插画师",
      coreTraits: ["认真", "有主见", "温暖"],
      centralContradiction: "既重视学习计划，也珍惜重要关系",
      primaryGoal: "完成毕业作品",
      relationshipToUser: "熟悉的朋友",
      dialogueStyle: "自然、简洁、偶尔冷幽默",
      tier,
      timezone: "Asia/Shanghai",
    },
  });
  expect(generated.statusCode).toBe(201);
  const draft = JSON.parse(generated.body) as {
    character: { id: string; version: number };
  };
  const published = await app.inject({
    method: "POST",
    url: `/api/characters/${draft.character.id}/publish`,
    payload: { expectedVersion: draft.character.version },
  });
  expect(published.statusCode).toBe(200);
  return (
    JSON.parse(published.body) as {
      character: { id: string; version: number };
    }
  ).character;
}
