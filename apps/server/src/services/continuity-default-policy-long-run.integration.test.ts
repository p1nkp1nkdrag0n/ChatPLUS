import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import { FixtureLlmProvider } from "@personasim/providers";
import type { GenerateObjectInput, LlmService } from "./llm-service.js";

const START_UTC = "2026-08-01T09:00:00.000Z";
const DAYS = 30;
// Mirrors the shipped config defaults (.env.example): 24h verbatim, 8k soft,
// 12k hard, 3k tail, 12 recent turns. Passed explicitly so ambient env vars
// cannot silently shrink the run.
const DEFAULT_RETENTION = {
  fullVerbatimHours: 24,
  softTokenLimit: 8_000,
  hardTokenLimit: 12_000,
  minimumTailTokens: 3_000,
  minimumRecentTurns: 12,
};

type ChatObservation = {
  day: number;
  promptLength: number;
};

const activeApps = new Set<PersonaSimApp>();
const temporaryDirectories: string[] = [];

describe("P1 default-policy 30-day continuity long run", () => {
  afterEach(async () => {
    for (const app of [...activeApps]) await app.close();
    activeApps.clear();
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps prompts bounded, raw messages intact, and continuity indexes growing with evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "personasim-default-run-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "default-policy.sqlite");
    const clock = new FakeClock(START_UTC);

    const app = await openTrackedApp(databasePath, clock);
    const chatPrompts: string[] = [];
    // checkpoint_autobiography carries no inline fixture; delegate it to the
    // canonical fixture provider so the committed checkpoint is realistic.
    const fixtureDelegate = new FixtureLlmProvider();
    mockLlm(app.personasim.llm, (input) => {
      if (input.purpose === "chat_turn") {
        chatPrompts.push(input.prompt);
        return {
          replyDecision: {
            text: "我记下来了，这一天也过得挺充实。",
            toneTags: ["warm"],
            deliveryMode: "single_block",
          },
          worldEffects: {},
        };
      }
      if (input.fixture !== undefined) return input.fixture;
      return fixtureDelegate.generateObject(input);
    });

    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const observations: ChatObservation[] = [];

    for (let day = 1; day <= DAYS; day += 1) {
      clock.setUtc(isoDayOffset(START_UTC, day, 9));
      const activation = await app.inject({
        method: "POST",
        url: `/api/agents/${character.id}/activate`,
      });
      expect(activation.statusCode).toBe(200);

      const promptsBefore = chatPrompts.length;
      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/messages`,
        payload: {
          agentId: character.id,
          clientMessageId: `default-run-day-${day}`,
          text: dailyUserText(day),
        },
      });
      expect(response.statusCode).toBe(201);
      expect(chatPrompts).toHaveLength(promptsBefore + 1);
      observations.push({
        day,
        promptLength: chatPrompts[chatPrompts.length - 1]!.length,
      });
    }

    const store = app.personasim.store;
    const userMessages = countRows(
      store,
      "SELECT COUNT(*) AS count FROM messages WHERE agent_id = ? AND role = 'user'",
      character.id,
    );
    const assistantReplies = countRows(
      store,
      "SELECT COUNT(*) AS count FROM messages WHERE agent_id = ? AND message_kind = 'assistant_reply'",
      character.id,
    );
    expect(userMessages).toBe(DAYS);
    expect(assistantReplies).toBe(DAYS);

    const committedCheckpoints = countRows(
      store,
      "SELECT COUNT(*) AS count FROM conversation_checkpoints WHERE session_id = ? AND status = 'committed'",
      sessionId,
    );
    expect(committedCheckpoints).toBeGreaterThanOrEqual(1);

    const autobiographyEntries = store.database
      .prepare(
        "SELECT source_evidence_ids_json FROM autobiography_entries WHERE agent_id = ?",
      )
      .all(character.id) as Array<{ source_evidence_ids_json: string }>;
    expect(autobiographyEntries.length).toBeGreaterThanOrEqual(1);
    for (const entry of autobiographyEntries) {
      expect(JSON.parse(entry.source_evidence_ids_json)).not.toEqual([]);
    }

    expect(
      countRows(
        store,
        "SELECT COUNT(*) AS count FROM event_cards WHERE agent_id = ?",
        character.id,
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      countRows(
        store,
        "SELECT COUNT(*) AS count FROM retrieval_runs WHERE agent_id = ?",
        character.id,
      ),
    ).toBeGreaterThanOrEqual(1);

    const maxLength = Math.max(...observations.map((item) => item.promptLength));
    const midRun = observations[DAYS - 11]!.promptLength;
    const finalRun = observations[DAYS - 1]!.promptLength;
    expect(maxLength).toBeLessThan(80_000);
    // Steady state: the final prompt must not keep growing with total history.
    expect(finalRun).toBeLessThan(midRun * 1.5 + 10_000);

    await app.close();
    activeApps.delete(app);
    const restarted = await openTrackedApp(databasePath, clock);
    const drained = await restarted.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(drained.statusCode).toBe(200);
    expect(
      JSON.parse(drained.body) as { settlement: { alreadySettled: boolean } },
    ).toMatchObject({ settlement: { alreadySettled: true } });
    expect(
      countRows(
        restarted.personasim.store,
        "SELECT COUNT(*) AS count FROM messages WHERE agent_id = ? AND role = 'user'",
        character.id,
      ),
    ).toBe(DAYS);
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
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "enforced",
    conversationRetention: DEFAULT_RETENTION,
    llm: {
      provider: "openai-compatible",
      baseUrl: "https://example.invalid",
      apiKey: "default-run-test-key",
      model: "default-run-test-model",
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

function mockLlm(
  llm: LlmService,
  responder: (input: GenerateObjectInput<unknown>) => unknown,
): void {
  vi.spyOn(llm, "generateObject").mockImplementation((input) =>
    Promise.resolve(responder(input)),
  );
}

async function createAndPublish(
  app: PersonaSimApp,
): Promise<{ id: string }> {
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "Default Run Companion",
      worldSetting: "A quiet university town",
      workOrRole: "Graduate student and part-time barista",
      coreTraits: ["Steady", "Thoughtful", "Dry humor"],
      coreContradiction: "Craves focus yet keeps saying yes to friends",
      mainGoal: "Finish the thesis draft",
      initialRelationship: "Close friend",
      dialogueStyle: "Natural, concise, and observant",
      tier: "high_fidelity",
      timezone: "UTC",
    },
  });
  expect(generated.statusCode).toBe(201);
  const draft = (
    JSON.parse(generated.body) as { character: { id: string; version: number } }
  ).character;
  const published = await app.inject({
    method: "POST",
    url: `/api/characters/${draft.id}/publish`,
    payload: { expectedVersion: draft.version },
  });
  expect(published.statusCode).toBe(200);
  return {
    id: (JSON.parse(published.body) as { character: { id: string } }).character
      .id,
  };
}

async function createSession(
  app: PersonaSimApp,
  agentId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/sessions`,
    payload: { title: "Default policy long run" },
  });
  expect(response.statusCode).toBe(201);
  return (JSON.parse(response.body) as { session: { id: string } }).session.id;
}

function dailyUserText(day: number): string {
  const filler =
    `Day ${day}: the seminar ran long, the coffee shop was crowded at noon, ` +
    `and I sketched another page of the thesis outline by the window. `;
  return filler.repeat(8);
}

function isoDayOffset(baseUtc: string, days: number, hour: number): string {
  const date = new Date(`${baseUtc}`);
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function countRows(
  store: PersonaSimApp["personasim"]["store"],
  sql: string,
  agentId: string,
): number {
  const row = store.database
    .prepare(`${sql} `.trim())
    .get(agentId) as { count: number };
  return Number(row.count);
}
