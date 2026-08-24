import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import {
  scheduleItemSchema,
  type CharacterSpec,
  type ScheduleItem,
} from "../domain/schemas.js";
import { FakeClock } from "../runtime/clock.js";

const START_UTC = "2026-08-24T00:00:00.000Z";
const HORIZON_END_UTC = "2026-08-27T00:00:00.000Z";

describe("schedule planning failure containment", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  it("keeps a valid model schedule unchanged", async () => {
    app = await createTestApp();
    const draft = await generateCharacter(app);
    const originalGenerateObject = app.personasim.llm.generateObject.bind(
      app.personasim.llm,
    );
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      async (input) => {
        if (input.purpose !== "plan_schedule") {
          return originalGenerateObject(input);
        }
        expect(input.maxRetries).toBe(0);
        expect(input.maxOutputTokens).toBe(8_192);
        const fixture = structuredClone(
          input.fixture as {
            items: Array<Record<string, unknown>>;
            [key: string]: unknown;
          },
        );
        fixture.items[0] = {
          ...fixture.items[0],
          title: "模型确认的睡眠",
        };
        return fixture;
      },
    );

    const published = await publishCharacter(app, draft);

    expect(published.statusCode).toBe(200);
    const body = jsonBody<{
      character: CharacterSpec;
      schedule: ScheduleItem[];
    }>(published);
    expect(body.character.status).toBe("published");
    expect(body.schedule.some((item) => item.title === "模型确认的睡眠")).toBe(
      true,
    );
    const initialized = scheduleEvent(app, draft.id, "schedule.initialized");
    expect(initialized?.payload).toMatchObject({
      fallbackUsed: false,
      fallbackReasonCodes: [],
    });
  });

  it.each([
    {
      label: "invalid structured output",
      behavior: "reject" as const,
      code: "INVALID_STRUCTURED_OUTPUT",
      reason: "llm_invalid_structured_output",
    },
    {
      label: "provider timeout",
      behavior: "reject" as const,
      code: "TIMEOUT",
      reason: "llm_timeout",
    },
    {
      label: "schema-invalid return",
      behavior: "invalid_schema" as const,
      code: "",
      reason: "llm_plan_schema_invalid",
    },
  ])(
    "publishes a usable character with a deterministic schedule after $label",
    async ({ behavior, code, reason }) => {
      app = await createTestApp();
      const draft = await generateCharacter(app);
      const originalGenerateObject = app.personasim.llm.generateObject.bind(
        app.personasim.llm,
      );
      vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
        async (input) => {
          if (input.purpose !== "plan_schedule") {
            return originalGenerateObject(input);
          }
          if (behavior === "invalid_schema") {
            return { untrusted: "not-a-schedule-plan" };
          }
          throw Object.assign(new Error("safe test failure"), { code });
        },
      );

      const published = await publishCharacter(app, draft);

      expect(published.statusCode).toBe(200);
      const body = jsonBody<{
        character: CharacterSpec;
        schedule: ScheduleItem[];
      }>(published);
      expect(body.character.status).toBe("published");
      expect(body.schedule.length).toBeGreaterThan(0);
      expect(body.schedule.some((item) => item.category === "sleep")).toBe(
        true,
      );
      expect(
        body.schedule.every((item) =>
          ["initial_plan", "routine"].includes(item.source),
        ),
      ).toBe(true);
      const initialized = scheduleEvent(app, draft.id, "schedule.initialized");
      expect(initialized?.payload).toMatchObject({
        fallbackUsed: true,
        fallbackReasonCodes: [reason],
      });
      expect(
        scheduleEvent(app, draft.id, "schedule.planning_degraded"),
      ).toBeUndefined();
    },
  );

  it("degrades to an audited empty plan without mutating schedule or cursor", async () => {
    app = await createTestApp();
    const draft = await generateCharacter(app);
    const blocker = scheduleItemSchema.parse({
      id: "schedule-blocker-72h",
      agentId: draft.id,
      title: "预存的不可变时间块",
      description: "用于证明降级不会伪造新日程。",
      category: "other",
      startAtUtc: START_UTC,
      endAtUtc: HORIZON_END_UTC,
      timezone: "Asia/Shanghai",
      status: "planned",
      rigidity: "fixed",
      priority: 1,
      source: "manual",
      adherenceProbability: 1,
      narrativeImportance: 0,
      shareable: false,
      stateEffects: {},
      revision: 0,
      createdAtUtc: START_UTC,
      updatedAtUtc: START_UTC,
    });
    app.personasim.store.insertScheduleItem(blocker);
    const cursorBefore = app.personasim.store.getCursor(draft.id);
    vi.spyOn(app.personasim.llm, "generateObject").mockRejectedValue(
      Object.assign(new Error("safe test failure"), {
        code: "INVALID_STRUCTURED_OUTPUT",
      }),
    );

    const published = await publishCharacter(app, draft);

    expect(published.statusCode).toBe(200);
    const body = jsonBody<{
      character: CharacterSpec;
      schedule: ScheduleItem[];
    }>(published);
    expect(body.character.status).toBe("published");
    expect(body.schedule).toEqual([]);
    expect(app.personasim.store.listSchedule(draft.id)).toEqual([blocker]);
    expect(app.personasim.store.getCursor(draft.id)).toEqual(cursorBefore);
    expect(
      scheduleEvent(app, draft.id, "schedule.initialized"),
    ).toBeUndefined();
    expect(scheduleEvent(app, draft.id, "schedule.extended")).toBeUndefined();
    const degraded = scheduleEvent(app, draft.id, "schedule.planning_degraded");
    expect(degraded?.payload).toMatchObject({
      fallbackReasonCodes: [
        "llm_invalid_structured_output",
        "deterministic_plan_rejected",
      ],
      issueCodes: ["empty_plan"],
      createdCount: 0,
      cursorRevision: cursorBefore?.revision,
    });
    expect(degraded?.payload).not.toHaveProperty("modelOutput");
    expect(degraded?.payload).not.toHaveProperty("errorMessage");
  });
});

async function createTestApp(): Promise<PersonaSimApp> {
  const config = readConfig({
    nodeEnv: "test",
    profile: "test",
    databasePath: ":memory:",
    clockMode: "fake",
    fakeClockStart: START_UTC,
    seedDemo: false,
    developerRoutes: true,
    scheduleNegotiationMode: "legacy",
    llm: {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
  });
  return buildApp({
    config,
    database: openDatabase(":memory:"),
    clock: new FakeClock(START_UTC),
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
}

async function generateCharacter(app: PersonaSimApp): Promise<CharacterSpec> {
  const response = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "顾澜",
      worldSetting: "2026 年的上海",
      workOrRole: "独立纪录片剪辑师与社区夜校讲师",
      coreTraits: ["观察细致", "温和直接", "尊重边界"],
      centralContradiction: "既愿意照顾重要的人，也坚持不过度替别人做决定",
      primaryGoal: "完成一部关于城市夜归人的纪录短片",
      relationshipToUser: "认识多年、彼此信任但尊重各自节奏的朋友",
      dialogueStyle: "使用简体中文，自然、温暖、克制",
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    },
  });
  expect(response.statusCode).toBe(201);
  return jsonBody<{ character: CharacterSpec }>(response).character;
}

function publishCharacter(app: PersonaSimApp, draft: CharacterSpec) {
  return app.inject({
    method: "POST",
    url: `/api/characters/${draft.id}/publish`,
    payload: { expectedVersion: draft.version },
  });
}

function scheduleEvent(
  app: PersonaSimApp,
  agentId: string,
  eventType: string,
): { payload: Record<string, unknown> } | undefined {
  const event = app.personasim.store
    .listDomainEvents(agentId, 100)
    .find((candidate) => candidate["eventType"] === eventType);
  if (!event) return undefined;
  return { payload: event["payload"] as Record<string, unknown> };
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
