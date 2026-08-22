import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { EvidenceBundle } from "@personasim/contracts";
import type { PromptAssemblyTrace } from "@personasim/features";
import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import { FixtureLlmProvider } from "@personasim/providers";
import type { ChatTurnResult } from "./conversation-service.js";
import { calculateLlmPromptTokenBudget } from "./llm-prompt-headroom.js";
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
const REQUIRED_SEGMENT_IDS = [
  "01_app_policy",
  "02_character_identity",
  "03_core_persona",
  "05_boundaries",
  "10_current_time",
  "15_reply_strategy",
  "16_user_message",
  "17_output_contract",
] as const;

type ChatObservation = {
  day: number;
  trace: PromptAssemblyTrace;
  providerInputLength: number;
  selectedEvidenceCount: number;
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
    const chatCalls: Array<GenerateObjectInput<unknown>> = [];
    let chatTurn = 0;
    // checkpoint_autobiography carries no inline fixture; delegate it to the
    // canonical fixture provider so the committed checkpoint is realistic.
    const fixtureDelegate = new FixtureLlmProvider();
    mockLlm(app.personasim.llm, (input) => {
      if (input.purpose === "chat_turn") {
        chatTurn += 1;
        chatCalls.push(input);
        return {
          replyDecision: {
            text: "我记下来了，这一天也过得挺充实。",
            toneTags: ["warm"],
            deliveryMode: "single_block",
            scheduleAction: { kind: "none" },
          },
          worldEffects: deterministicWorldEffects(chatTurn),
        };
      }
      if (input.fixture !== undefined) return input.fixture;
      return fixtureDelegate.generateObject(input);
    });

    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const observations: ChatObservation[] = [];
    const promptTokenBudget = calculateLlmPromptTokenBudget(
      app.personasim.llm.capabilities,
    );
    let firstTurnUserMessageId: string | undefined;

    for (let day = 1; day <= DAYS; day += 1) {
      clock.setUtc(isoDayOffset(START_UTC, day, 9));
      const activation = await app.inject({
        method: "POST",
        url: `/api/agents/${character.id}/activate`,
      });
      expect(activation.statusCode).toBe(200);

      const stateBeforeTurn = app.personasim.store.getRuntimeState(
        character.id,
      );
      expect(stateBeforeTurn).toBeDefined();
      const callsBefore = chatCalls.length;
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
      expect(chatCalls).toHaveLength(callsBefore + 1);
      const body = jsonBody<ChatTurnResult>(response);
      const persistedTurn = app.personasim.store.findTurnByClientMessageId(
        sessionId,
        `default-run-day-${day}`,
      );
      expect(persistedTurn?.assistantMessage).toBeDefined();
      const responseTrace = promptTrace(body.assistantMessage.metadata);
      const persistedTrace = promptTrace(
        persistedTurn?.assistantMessage?.metadata ?? {},
      );
      expect(persistedTrace).toEqual(responseTrace);
      expectRequiredSegments(persistedTrace);
      expect(persistedTrace.estimatedInputTokens).toBeGreaterThan(0);
      expect(persistedTrace.estimatedInputTokens).toBeLessThanOrEqual(
        promptTokenBudget,
      );

      const chatCall = chatCalls.at(-1);
      expect(chatCall).toBeDefined();
      if (chatCall === undefined) throw new Error("Missing chat provider call");
      if (stateBeforeTurn === undefined) {
        throw new Error("Missing runtime state before chat turn");
      }
      const selectedEvidenceCount =
        body.memoryRecall?.selectedEvidenceIds.length ?? 0;
      observations.push({
        day,
        trace: persistedTrace,
        providerInputLength: chatCall.system.length + chatCall.prompt.length,
        selectedEvidenceCount,
      });

      if (day === 1) {
        firstTurnUserMessageId = body.userMessage.id;
        expect(body.state.stress).toBeCloseTo(stateBeforeTurn.stress + 0.05, 8);
        expect(body.state.relationship.trust).toBeCloseTo(
          stateBeforeTurn.relationship.trust + 0.02,
          8,
        );
      } else {
        expect(body.memoryRecall).toMatchObject({
          rolloutMode: "enforced",
          abstained: false,
          promptStrategy: "evidence_selected",
        });
        expect(selectedEvidenceCount).toBeGreaterThan(0);
        const reference = referenceContext(chatCall.prompt);
        expect(reference.memoryEvidence?.evidence.length).toBeGreaterThan(0);
        expect(
          reference.memoryEvidence?.evidence.some((item) =>
            item.memoryContent.toLocaleLowerCase().includes("jasmine tea"),
          ),
        ).toBe(true);
        expectTraceSegment(persistedTrace, "13_retrieved_evidence");
      }

      if (day === 2) {
        const continuity = followUpContext(chatCall.prompt);
        expect(continuity.careCues.length).toBeGreaterThan(0);
        expect(continuity.careCues[0]?.contextSummary).toMatch(
          /thesis defense/iu,
        );
        expectTraceSegment(persistedTrace, "07z_followup_context");
      }
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

    expect(firstTurnUserMessageId).toBeDefined();
    expect(
      countRows(
        store,
        `SELECT COUNT(*) AS count FROM memory_evidence AS evidence
         JOIN memories AS memory ON memory.id = evidence.memory_id
         WHERE memory.agent_id = ? AND memory.content LIKE '%jasmine tea%'`,
        character.id,
      ),
    ).toBeGreaterThanOrEqual(1);
    const careCue = store.database
      .prepare(
        "SELECT source_message_id, context_summary FROM care_cues WHERE agent_id = ? ORDER BY rowid LIMIT 1",
      )
      .get(character.id) as
      { source_message_id: string; context_summary: string } | undefined;
    expect(careCue?.source_message_id).toBe(firstTurnUserMessageId);
    expect(careCue?.context_summary).toMatch(/thesis defense/iu);

    const firstEffectAudit = store.database
      .prepare(
        `SELECT payload_json FROM domain_events
         WHERE agent_id = ? AND event_type = 'conversation.world_effects_committed'
           AND correlation_id = 'default-run-day-1'`,
      )
      .get(character.id) as { payload_json: string } | undefined;
    expect(firstEffectAudit).toBeDefined();
    expect(JSON.parse(firstEffectAudit?.payload_json ?? "{}")).toMatchObject({
      mode: "enforced",
      accepted: {
        stateDelta: true,
        relationshipDelta: true,
        memoryCandidateCount: 1,
      },
    });
    expect(
      observations.filter((item) => item.selectedEvidenceCount > 0),
    ).toHaveLength(DAYS - 1);
    expect(
      observations.some((item) =>
        item.trace.segments.some(
          (segment) => segment.id === "06_autobiography" && segment.included,
        ),
      ),
    ).toBe(true);

    const maxTraceTokens = Math.max(
      ...observations.map((item) => item.trace.estimatedInputTokens),
    );
    const maxProviderInputLength = Math.max(
      ...observations.map((item) => item.providerInputLength),
    );
    const midRun = observations[DAYS - 11]!.trace.estimatedInputTokens;
    const finalRun = observations[DAYS - 1]!.trace.estimatedInputTokens;
    expect(maxTraceTokens).toBeLessThanOrEqual(promptTokenBudget);
    expect(maxProviderInputLength).toBeLessThan(100_000);
    // Steady state: the final assembled prompt must not grow with total history.
    expect(finalRun).toBeLessThan(midRun * 1.5 + 2_500);

    const restartSnapshot = durableRestartSnapshot(store, character.id);
    for (const rows of Object.values(restartSnapshot)) {
      expect(rows.length).toBeGreaterThan(0);
    }
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
      durableRestartSnapshot(restarted.personasim.store, character.id),
    ).toEqual(restartSnapshot);
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
    scheduleNegotiationMode: "enforced",
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

async function createAndPublish(app: PersonaSimApp): Promise<{ id: string }> {
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
  const continuityAnchor =
    day === 1
      ? "I prefer jasmine tea. My thesis defense is tomorrow and I feel nervous. "
      : "Do you remember that I prefer jasmine tea? My thesis defense preparation is still on my mind. ";
  const filler =
    `Day ${day}: the seminar ran long, the coffee shop was crowded at noon, ` +
    `and I sketched another page of the thesis outline by the window. `;
  return continuityAnchor + filler.repeat(8);
}

function deterministicWorldEffects(turn: number): Record<string, unknown> {
  if (turn > 1) {
    return {
      continuityEffects: {
        followUpCandidates: [],
        followUpTransitions: [],
        careCueCandidates: [],
      },
    };
  }
  return {
    stateDelta: { stress: 0.05 },
    relationshipDelta: { trust: 0.02 },
    memoryCandidates: [
      {
        type: "user_preference",
        content: "The user prefers jasmine tea.",
        tags: ["jasmine", "tea"],
        importance: 0.9,
        confidence: 1,
      },
    ],
    continuityEffects: {
      followUpCandidates: [],
      followUpTransitions: [],
      careCueCandidates: [
        {
          cueType: "support_offer",
          contextSummary: "Thesis defense nerves",
          mentionGuidance:
            "Ask gently about the thesis defense without pressuring the user.",
          evidenceQuotes: ["My thesis defense is tomorrow"],
        },
      ],
    },
  };
}

function promptTrace(metadata: Record<string, unknown>): PromptAssemblyTrace {
  const trace = metadata["promptSegmentTrace"];
  if (typeof trace !== "object" || trace === null || Array.isArray(trace)) {
    throw new Error(
      "Persisted assistant message is missing promptSegmentTrace",
    );
  }
  return trace as unknown as PromptAssemblyTrace;
}

function expectRequiredSegments(trace: PromptAssemblyTrace): void {
  for (const id of REQUIRED_SEGMENT_IDS) {
    const segment = trace.segments.find((item) => item.id === id);
    expect(segment).toMatchObject({ id, required: true, included: true });
  }
  expect(
    trace.segments
      .filter((segment) => segment.required)
      .every((segment) => segment.included),
  ).toBe(true);
}

function expectTraceSegment(trace: PromptAssemblyTrace, id: string): void {
  expect(trace.segments.find((segment) => segment.id === id)).toMatchObject({
    id,
    included: true,
  });
}

function referenceContext(prompt: string): {
  memoryEvidence?: EvidenceBundle;
} {
  return labeledPromptJson(prompt, "REFERENCE_CONTEXT_JSON");
}

function followUpContext(prompt: string): {
  careCues: Array<{ contextSummary: string }>;
} {
  return labeledPromptJson(prompt, "FOLLOWUP_CONTEXT_JSON");
}

function labeledPromptJson<T>(prompt: string, label: string): T {
  const lines = prompt.split("\n");
  const marker = lines.indexOf(label);
  const value = lines[marker + 1];
  if (marker < 0 || value === undefined) {
    throw new Error(`Prompt label ${label} was not found`);
  }
  return JSON.parse(value) as T;
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

function isoDayOffset(baseUtc: string, days: number, hour: number): string {
  const date = new Date(`${baseUtc}`);
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString().replace(/\.\d{3}Z$/, ".000Z");
}

function durableRestartSnapshot(
  store: PersonaSimApp["personasim"]["store"],
  agentId: string,
): Record<string, string[]> {
  const stableRows = (sql: string): string[] =>
    (
      store.database.prepare(sql).all(agentId) as Array<Record<string, unknown>>
    ).map((row) => JSON.stringify(row));

  return {
    messages: stableRows(
      `SELECT id, role, message_kind AS messageKind,
         COALESCE(client_message_id, '') AS clientMessageId
       FROM messages WHERE agent_id = ? ORDER BY id`,
    ),
    conversationCheckpoints: stableRows(
      `SELECT id, status, source_hash AS sourceHash,
         source_message_count AS sourceMessageCount,
         COALESCE(autobiography_snapshot_id, '') AS autobiographySnapshotId
       FROM conversation_checkpoints WHERE agent_id = ? ORDER BY id`,
    ),
    autobiographySnapshots: stableRows(
      `SELECT id, source_checkpoint_id AS sourceCheckpointId, revision
       FROM autobiography_snapshots WHERE agent_id = ? ORDER BY id`,
    ),
    autobiographyEntries: stableRows(
      `SELECT id, snapshot_id AS snapshotId, entry_kind AS entryKind, ordinal,
         source_evidence_ids_json AS sourceEvidenceIdsJson
       FROM autobiography_entries WHERE agent_id = ? ORDER BY id`,
    ),
    eventCards: stableRows(
      `SELECT id, dedupe_key AS dedupeKey, source_kind AS sourceKind,
         source_id AS sourceId, status
       FROM event_cards WHERE agent_id = ? ORDER BY id`,
    ),
    memories: stableRows(
      `SELECT id, type, content, COALESCE(source_message_id, '') AS sourceMessageId,
         status, COALESCE(claim_disposition, '') AS claimDisposition
       FROM memories WHERE agent_id = ? ORDER BY id`,
    ),
    memoryEvidence: stableRows(
      `SELECT evidence.id, evidence.memory_id AS memoryId,
         evidence.source_type AS sourceType, evidence.source_id AS sourceId
       FROM memory_evidence AS evidence
       JOIN memories AS memory ON memory.id = evidence.memory_id
       WHERE memory.agent_id = ? ORDER BY evidence.id`,
    ),
    careCues: stableRows(
      `SELECT id, source_message_id AS sourceMessageId, status,
         max_mentions AS maxMentions, mention_count AS mentionCount
       FROM care_cues WHERE agent_id = ? ORDER BY id`,
    ),
    retrievalRuns: stableRows(
      `SELECT id, COALESCE(source_message_id, '') AS sourceMessageId,
         selected_count AS selectedCount
       FROM retrieval_runs WHERE agent_id = ? ORDER BY id`,
    ),
    domainEvents: stableRows(
      `SELECT id, event_type AS eventType, idempotency_key AS idempotencyKey,
         COALESCE(correlation_id, '') AS correlationId
       FROM domain_events WHERE agent_id = ? ORDER BY id`,
    ),
  };
}
function countRows(
  store: PersonaSimApp["personasim"]["store"],
  sql: string,
  agentId: string,
): number {
  const row = store.database.prepare(`${sql} `.trim()).get(agentId) as {
    count: number;
  };
  return Number(row.count);
}
