import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PersonalIntentSchema,
  type CharacterSpec,
  type PersonalIntent,
} from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import {
  PERSONAL_INTENT_SERVICE_TOKEN,
  SELF_PLANNING_SERVICE_TOKEN,
} from "../composition/service-tokens.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";

const NOW_UTC = "2026-06-15T08:00:00.000Z";

const activeApps = new Set<PersonaSimApp>();
const temporaryDirectories: string[] = [];

describe("production CharacterSpec personal-intent seeding", () => {
  afterEach(async () => {
    for (const app of [...activeApps]) await closeTrackedApp(app);
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("grounds a bounded deterministic spec batch before planning and dedupes it across restart", async () => {
    const directory = mkdtempSync(join(tmpdir(), "personasim-spec-intents-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "spec-intents.sqlite");
    const clock = new FakeClock(NOW_UTC);
    const first = await openTrackedApp(databasePath, clock);
    const character = await createAndPublish(first);
    const planner = first.personasim.kernel.registry.resolve(
      SELF_PLANNING_SERVICE_TOKEN,
    );
    const firstPlanning = vi.spyOn(planner, "ensureSelfInitiatedPlans");

    const activation = await first.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });

    expect(activation.statusCode).toBe(200);
    expect(firstPlanning).toHaveBeenCalledTimes(1);
    const plannerIntents = firstPlanning.mock.calls[0]?.[0].intents ?? [];
    expect(plannerIntents).toHaveLength(2);
    expect(plannerIntents.map((intent) => intent.basisKind).sort()).toEqual([
      "goal",
      "routine",
    ]);

    const seeded = readIntents(first, character.id);
    expect(seeded).toHaveLength(2);
    expect(
      seeded.map((intent) => [intent.basisKind, intent.basisRefIds]),
    ).toEqual([
      ["goal", ["goal-1"]],
      ["routine", ["routine-6"]],
    ]);
    expect(
      seeded.every(
        (intent) =>
          intent.sessionId === undefined &&
          intent.evidenceMessageIds.length === 0 &&
          intent.specVersion === character.version,
      ),
    ).toBe(true);
    const [consumedByActivation] = seeded.filter(
      (intent) => intent.status === "consumed",
    );
    expect(consumedByActivation).toBeDefined();
    expect(
      seeded.filter((intent) => intent.status === "consumed"),
    ).toHaveLength(1);
    const selfInitiated = first.personasim.store
      .listSchedule(character.id)
      .filter((item) => item.source === "self_initiated");
    expect(selfInitiated).toHaveLength(1);
    expect(selfInitiated[0]?.sourceIntentId).toBe(consumedByActivation?.id);
    expect(tableCount(first, "sessions", character.id)).toBe(0);
    expect(tableCount(first, "messages", character.id)).toBe(0);
    expect(specIntentCommandCount(first, character.id)).toBe(2);

    const intentLifecycle = first.personasim.kernel.registry.resolve(
      PERSONAL_INTENT_SERVICE_TOKEN,
    );
    await first.personasim.actors.runExclusive(character.id, () => {
      for (const intent of readIntents(first, character.id)) {
        if (intent.status !== "pending" && intent.status !== "planned") {
          continue;
        }
        const transition = intentLifecycle.markConsumed({
          agentId: character.id,
          intentId: intent.id,
          idempotencyKey: `test:spec-intent:${intent.id}:consume`,
        });
        expect(transition.intent.status).toBe("consumed");
      }
    });

    const consumed = readIntents(first, character.id);
    expect(consumed.every((intent) => intent.status === "consumed")).toBe(true);
    const stableIds = consumed.map((intent) => intent.id).sort();
    const commandCountBeforeRestart = specIntentCommandCount(
      first,
      character.id,
    );
    await closeTrackedApp(first);

    const restarted = await openTrackedApp(databasePath, clock);
    const restartedPlanner = restarted.personasim.kernel.registry.resolve(
      SELF_PLANNING_SERVICE_TOKEN,
    );
    const restartedPlanning = vi.spyOn(
      restartedPlanner,
      "ensureSelfInitiatedPlans",
    );
    const replayedActivation = await restarted.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });

    expect(replayedActivation.statusCode).toBe(200);
    expect(restartedPlanning).toHaveBeenCalledTimes(1);
    expect(restartedPlanning.mock.calls[0]?.[0].intents).toEqual([]);
    const replayed = readIntents(restarted, character.id);
    expect(replayed).toHaveLength(2);
    expect(replayed.map((intent) => intent.id).sort()).toEqual(stableIds);
    expect(replayed.every((intent) => intent.status === "consumed")).toBe(true);
    expect(specIntentCommandCount(restarted, character.id)).toBe(
      commandCountBeforeRestart,
    );
    expect(tableCount(restarted, "sessions", character.id)).toBe(0);
    expect(tableCount(restarted, "messages", character.id)).toBe(0);
  });

  it("extracts the primary work activity from a Sunday-evening goal with a sleep constraint", async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "personasim-mixed-goal-intent-"),
    );
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "mixed-goal-intent.sqlite");
    const app = await openTrackedApp(
      databasePath,
      new FakeClock("2026-08-21T12:00:00.000Z"),
    );
    const character = await createAndPublish(app, {
      mainGoal:
        "在周日晚上完成社区纪录片放映前的最终声音校对，同时保证充足睡眠",
      timezone: "Asia/Shanghai",
    });

    const activation = await app.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });

    expect(activation.statusCode).toBe(200);
    const goalIntent = readIntents(app, character.id).find(
      (intent) => intent.basisKind === "goal",
    );
    expect(goalIntent).toMatchObject({
      activity: "社区纪录片放映前的最终声音校对",
      category: "work",
      desiredDurationMinutes: 90,
      earliestAtUtc: "2026-08-23T10:00:00.000Z",
      latestAtUtc: "2026-08-23T15:00:00.000Z",
    });
  });
});

async function openTrackedApp(
  databasePath: string,
  clock: FakeClock,
): Promise<PersonaSimApp> {
  const config = readConfig({
    nodeEnv: "test",
    profile: "test",
    databasePath,
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    scheduleNegotiationMode: "legacy",
    selfInitiatedPlanningMode: "enforced",
    liveWorldEffectsMode: "off",
    memoryRecallMode: "legacy",
    autobiographyMode: "off",
    proactiveCommitMode: "atomic",
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
    database: openDatabase(databasePath),
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
  activeApps.add(app);
  return app;
}

async function closeTrackedApp(app: PersonaSimApp): Promise<void> {
  if (!activeApps.delete(app)) return;
  await app.close();
}

async function createAndPublish(
  app: PersonaSimApp,
  options: {
    mainGoal?: string;
    timezone?: string;
  } = {},
): Promise<CharacterSpec> {
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "Spec Intent Agent",
      worldSetting: "A contemporary city",
      workOrRole: "Photographer",
      coreTraits: ["Curious", "Disciplined", "Warm"],
      coreContradiction: "Balances structure with creative exploration",
      mainGoal: options.mainGoal ?? "Complete a photography portfolio",
      initialRelationship: "Trusted friend",
      dialogueStyle: "Natural and concise",
      tier: "daily",
      timezone: options.timezone ?? "UTC",
    },
  });
  expect(generated.statusCode).toBe(201);
  const draft = jsonBody<{ character: CharacterSpec }>(generated).character;
  const published = await app.inject({
    method: "POST",
    url: `/api/characters/${draft.id}/publish`,
    payload: { expectedVersion: draft.version },
  });
  expect(published.statusCode).toBe(200);
  return jsonBody<{ character: CharacterSpec }>(published).character;
}

function readIntents(app: PersonaSimApp, agentId: string): PersonalIntent[] {
  return app.personasim.store.database
    .prepare(
      `SELECT record_json FROM personal_intentions
       WHERE agent_id = ?
       ORDER BY basis_kind`,
    )
    .all(agentId)
    .map((row) =>
      PersonalIntentSchema.parse(
        JSON.parse((row as { record_json: string }).record_json),
      ),
    );
}

function specIntentCommandCount(app: PersonaSimApp, agentId: string): number {
  const row = app.personasim.store.database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM domain_events
       WHERE agent_id = ?
         AND event_type IN (
           'personal_intent.created',
           'personal_intent.merged'
         )`,
    )
    .get(agentId) as { count: number };
  return Number(row.count);
}

function tableCount(
  app: PersonaSimApp,
  table: "messages" | "sessions",
  agentId: string,
): number {
  const row = app.personasim.store.database
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE agent_id = ?`)
    .get(agentId) as { count: number };
  return Number(row.count);
}

function jsonBody<T>(response: { json(): unknown }): T {
  return response.json() as T;
}
