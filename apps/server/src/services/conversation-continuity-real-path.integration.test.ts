import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig, type ServerConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";

const START_UTC = "2026-08-21T04:00:00.000Z";

describe("conversation continuity real path", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
  });

  it("persists a grounded follow-up and care cue, then resolves it from the user's explicit outcome", async () => {
    const created = await createContinuityApp();
    app = created.app;
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    const first = await sendMessage(
      app,
      sessionId,
      character.id,
      "continuity-defense-source",
      "\u6211\u660e\u5929\u7b54\u8fa9\uff0c\u6709\u70b9\u7d27\u5f20\u3002",
    );

    expect(first.statusCode).toBe(201);
    const firstTurn = jsonBody<ChatTurnBody>(first);
    const followUp = app.personasim.store.database
      .prepare(
        "SELECT id, subject_type, context_summary, source_message_id, status " +
          "FROM follow_up_intents WHERE agent_id = ?",
      )
      .get(character.id) as FollowUpRow | undefined;
    const careCue = app.personasim.store.database
      .prepare(
        "SELECT id, context_summary, source_message_id, status, mention_count " +
          "FROM care_cues WHERE agent_id = ?",
      )
      .get(character.id) as CareCueRow | undefined;

    expect(followUp).toMatchObject({
      subject_type: "user_event",
      source_message_id: firstTurn.userMessage.id,
      status: "pending",
    });
    expect(followUp?.context_summary).toContain("\u7b54\u8fa9");
    expect(careCue).toMatchObject({
      source_message_id: firstTurn.userMessage.id,
      status: "active",
      mention_count: 0,
    });
    expect(careCue?.context_summary).toContain("\u7b54\u8fa9");
    const evidenceSource = app.personasim.store.database
      .prepare("SELECT role, content FROM messages WHERE id = ?")
      .get(firstTurn.userMessage.id) as
      { role: string; content: string } | undefined;
    expect(evidenceSource).toEqual({
      role: "user",
      content:
        "\u6211\u660e\u5929\u7b54\u8fa9\uff0c\u6709\u70b9\u7d27\u5f20\u3002",
    });
    expect(evidenceSource?.content).toContain("\u660e\u5929\u7b54\u8fa9");
    if (followUp === undefined) throw new Error("Expected a follow-up");

    created.clock.setUtc("2026-08-22T12:00:00.000Z");
    const outcome = await sendMessage(
      app,
      sessionId,
      character.id,
      "continuity-defense-outcome",
      "\u7b54\u8fa9\u8fc7\u4e86\uff0c\u603b\u7b97\u7ed3\u675f\u4e86\u3002",
    );

    expect(outcome.statusCode).toBe(201);
    const outcomeTurn = jsonBody<ChatTurnBody>(outcome);
    expect(
      app.personasim.store.database
        .prepare(
          "SELECT status, resolution_message_id " +
            "FROM follow_up_intents WHERE id = ?",
        )
        .get(followUp.id),
    ).toEqual({
      status: "resolved",
      resolution_message_id: outcomeTurn.userMessage.id,
    });
    expect(messageCount(app, character.id, "assistant_proactive")).toBe(0);
  });
  it("materializes a minimal care cue and an accepted explicit reminder through the real chat commit path", async () => {
    const created = await createContinuityApp({
      llm: {
        provider: "openai-compatible",
        baseUrl: "https://example.invalid",
        apiKey: "test-api-key",
        model: "test-live-model",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
    });
    app = created.app;
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        if (input.purpose === "chat_turn") {
          return Promise.resolve({
            replyDecision: {
              text: "可以，明天中午12:10我会问你答辩结束了吗。",
            },
            worldEffects: {
              continuityEffects: {
                followUpCandidates: [],
                followUpTransitions: [],
                careCueCandidates: [
                  {
                    cueType: "support_offer",
                    evidenceQuotes: ["答辩结束了吗"],
                  },
                ],
              },
            },
          } as never);
        }
        if (input.fixture !== undefined) {
          return Promise.resolve(input.fixture as never);
        }
        return Promise.reject(new Error(`No fixture for ${input.purpose}`));
      },
    );
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "continuity-explicit-reminder",
      "明天中午12:10能问我答辩结束了吗？",
    );

    expect(response.statusCode).toBe(201);
    const followUp = app.personasim.store.database
      .prepare(
        "SELECT earliest_at_utc, expires_at_utc, source_message_id, status " +
          "FROM follow_up_intents WHERE agent_id = ?",
      )
      .get(character.id) as
      | {
          earliest_at_utc: string;
          expires_at_utc: string;
          source_message_id: string;
          status: string;
        }
      | undefined;
    const careCue = app.personasim.store.database
      .prepare(
        "SELECT context_summary, source_message_id, status FROM care_cues " +
          "WHERE agent_id = ?",
      )
      .get(character.id) as
      | {
          context_summary: string;
          source_message_id: string;
          status: string;
        }
      | undefined;
    const turn = jsonBody<ChatTurnBody>(response);

    expect(followUp).toEqual({
      earliest_at_utc: "2026-08-22T04:10:00.000Z",
      expires_at_utc: "2026-08-25T04:10:00.000Z",
      source_message_id: turn.userMessage.id,
      status: "pending",
    });
    expect(careCue).toMatchObject({
      context_summary: "答辩结束了吗",
      source_message_id: turn.userMessage.id,
      status: "active",
    });
  });

  it("does not treat a care boundary as reminder cancellation and materializes explicit care", async () => {
    const created = await createContinuityApp({
      llm: {
        provider: "openai-compatible",
        baseUrl: "https://example.invalid",
        apiKey: "test-api-key",
        model: "test-live-model",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
    });
    app = created.app;
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        if (input.purpose === "chat_turn") {
          return Promise.resolve({
            replyDecision: {
              text: "\u53ef\u4ee5\uff0c\u660e\u5929\u4e0b\u534815:00\u6211\u4f1a\u95ee\u4f60\u8fd4\u5de5\u540e\u7f13\u8fc7\u6765\u4e86\u5417\uff0c\u5148\u95ee\u662f\u5426\u9700\u8981\u6682\u505c\u5341\u5206\u949f\uff0c\u4e0d\u8bb2\u5927\u9053\u7406\u3002",
            },
            worldEffects: {
              continuityEffects: {
                followUpCandidates: [],
                followUpTransitions: [],
                careCueCandidates: [],
              },
            },
          } as never);
        }
        if (input.fixture !== undefined) {
          return Promise.resolve(input.fixture as never);
        }
        return Promise.reject(new Error(`No fixture for ${input.purpose}`));
      },
    );
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    const response = await sendMessage(
      app,
      sessionId,
      character.id,
      "continuity-explicit-care-boundary",
      "\u660e\u5929\uff088\u670822\u65e5\uff09\u4e0b\u534815:00\u8bf7\u4e3b\u52a8\u95ee\u6211\u201c\u8fd4\u5de5\u540e\u7f13\u8fc7\u6765\u4e86\u5417\u201d\uff1b\u5982\u679c\u4ecd\u7136\u6cae\u4e27\uff0c\u5148\u95ee\u6211\u201c\u9700\u8981\u6682\u505c\u5341\u5206\u949f\u5417\u201d\uff0c\u4e0d\u8981\u8bb2\u5927\u9053\u7406\u3002\u8bf7\u8bb0\u4f4f\u8fd9\u79cd\u5173\u6000\u65b9\u5f0f\u3002",
    );

    expect(response.statusCode).toBe(201);
    const followUp = app.personasim.store.database
      .prepare(
        "SELECT earliest_at_utc, expires_at_utc, status FROM follow_up_intents WHERE agent_id = ?",
      )
      .get(character.id);
    const careCue = app.personasim.store.database
      .prepare(
        "SELECT earliest_at_utc, expires_at_utc, status, mention_guidance FROM care_cues WHERE agent_id = ?",
      )
      .get(character.id);

    expect(followUp).toEqual({
      earliest_at_utc: "2026-08-22T07:00:00.000Z",
      expires_at_utc: "2026-08-25T07:00:00.000Z",
      status: "pending",
    });
    expect(careCue).toEqual({
      earliest_at_utc: "2026-08-22T07:00:00.000Z",
      expires_at_utc: "2026-09-05T07:00:00.000Z",
      status: "active",
      mention_guidance:
        "\u5728\u540e\u7eed\u76f8\u5173\u8bed\u5883\u4e2d\uff0c\u5148\u6309\u7528\u6237\u6307\u5b9a\u7684\u65b9\u5f0f\u5173\u5fc3\uff0c\u4e0d\u8981\u7acb\u523b\u8bb2\u9053\u7406\u3002",
    });
  });

  it("injects at most two CareCues only into a related prompt and never sends one by itself", async () => {
    const created = await createContinuityApp();
    app = created.app;
    const chatCalls = vi.spyOn(app.personasim.llm, "generateObject");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    for (const [clientMessageId, text] of [
      [
        "cue-defense",
        "\u6211\u660e\u5929\u7b54\u8fa9\uff0c\u6709\u70b9\u7d27\u5f20\u3002",
      ],
      [
        "cue-interview",
        "\u6211\u660e\u5929\u9762\u8bd5\uff0c\u5e0c\u671b\u522b\u592a\u7d27\u5f20\u3002",
      ],
      [
        "cue-portfolio",
        "\u6211\u660e\u5929\u4f5c\u54c1\u96c6\u8981\u4ea4\uff0c\u8fd8\u5728\u6536\u5c3e\u3002",
      ],
    ] as const) {
      const response = await sendMessage(
        app,
        sessionId,
        character.id,
        clientMessageId,
        text,
      );
      expect(response.statusCode).toBe(201);
    }
    expect(activeCareCueCount(app, character.id)).toBe(3);
    created.clock.setUtc("2026-08-22T13:00:00.000Z");

    const unrelated = await sendMessage(
      app,
      sessionId,
      character.id,
      "cue-unrelated",
      "I want to watch a light movie tonight.",
    );
    expect(unrelated.statusCode).toBe(201);
    expect(latestChatTurnPrompt(chatCalls.mock.calls)).not.toContain(
      "FOLLOWUP_CONTEXT_JSON\n",
    );

    const related = await sendMessage(
      app,
      sessionId,
      character.id,
      "cue-related",
      "\u7b54\u8fa9\u3001\u9762\u8bd5 \u4f5c\u54c1\u96c6",
    );
    expect(related.statusCode).toBe(201);
    const relatedBody = jsonBody<ChatTurnBody>(related);
    const relatedContext = latestCareCueContext(chatCalls.mock.calls);
    expect(relatedContext.careCues).toHaveLength(2);
    expect(
      relatedContext.careCues.every(
        (cue) =>
          cue.contextSummary.includes("\u7b54\u8fa9") ||
          cue.contextSummary.includes("\u9762\u8bd5") ||
          cue.contextSummary.includes("\u4f5c\u54c1\u96c6"),
      ),
    ).toBe(true);
    expect(
      relatedBody.assistantMessage.metadata.continuityPromptCueIds,
    ).toEqual(relatedContext.careCues.map((cue) => cue.id));
    expect(messageCount(app, character.id, "assistant_proactive")).toBe(0);
    expect(activeCareCueCount(app, character.id)).toBe(3);
  });

  it("crosses the enforced autobiography checkpoint boundary with archive-backed fixture evidence", async () => {
    const created = await createContinuityApp({
      autobiographyMode: "enforced",
      conversationRetention: {
        fullVerbatimHours: 1,
        softTokenLimit: 256,
        hardTokenLimit: 4_096,
        minimumTailTokens: 1,
        minimumRecentTurns: 1,
      },
    });
    app = created.app;
    const llmCalls = vi.spyOn(app.personasim.llm, "generateObject");
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const archivedText =
      "I want this preparation process remembered. " +
      "Reviewing the material clarified what matters to me. ".repeat(90);

    const archived = await sendMessage(
      app,
      sessionId,
      character.id,
      "checkpoint-archive-source",
      archivedText,
    );
    expect(archived.statusCode).toBe(201);
    const archivedTurn = jsonBody<ChatTurnBody>(archived);

    created.clock.setUtc("2026-08-21T06:00:00.000Z");
    const boundary = await sendMessage(
      app,
      sessionId,
      character.id,
      "checkpoint-boundary",
      "Now I want to change topics and talk about a movie.",
    );
    expect(boundary.statusCode).toBe(201);
    expect(
      llmCalls.mock.calls.filter(
        ([input]) => input.purpose === "checkpoint_autobiography",
      ),
    ).toHaveLength(1);

    const checkpoint = app.personasim.store.database
      .prepare(
        "SELECT id, from_message_id, through_message_id, source_message_count, " +
          "autobiography_snapshot_id, status " +
          "FROM conversation_checkpoints WHERE session_id = ?",
      )
      .get(sessionId) as CheckpointRow | undefined;
    expect(checkpoint).toMatchObject({
      from_message_id: archivedTurn.userMessage.id,
      through_message_id: archivedTurn.assistantMessage.id,
      source_message_count: 2,
      status: "committed",
    });
    expect(checkpoint?.autobiography_snapshot_id).toBeTruthy();
    if (checkpoint?.autobiography_snapshot_id == null) {
      throw new Error("Expected a committed autobiography snapshot");
    }

    const entry = app.personasim.store.database
      .prepare(
        "SELECT source_evidence_ids_json, evidence_json " +
          "FROM autobiography_entries WHERE snapshot_id = ?",
      )
      .get(checkpoint.autobiography_snapshot_id) as
      | {
          source_evidence_ids_json: string;
          evidence_json: string;
        }
      | undefined;
    expect(entry).toBeDefined();
    const evidence = JSON.parse(entry?.evidence_json ?? "[]") as Array<{
      id: string;
      sourceType: string;
      sourceId: string;
      quote?: string;
    }>;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      sourceType: "message_archive",
      sourceId: archivedTurn.userMessage.id,
      quote: archivedText.slice(0, 2_000),
    });
    expect(evidence[0]?.id).not.toBe("evidence-checkpoint-fixture");
    expect(JSON.parse(entry?.source_evidence_ids_json ?? "[]")).toEqual([
      evidence[0]?.id,
    ]);
  });
});

async function createContinuityApp(
  overrides: Partial<ServerConfig> = {},
): Promise<{ app: PersonaSimApp; clock: FakeClock }> {
  const clock = new FakeClock(START_UTC);
  const config = readConfig({
    nodeEnv: "test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    scheduleNegotiationMode: "legacy",
    liveWorldEffectsMode: "enforced",
    autobiographyMode: "off",
    llm: {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
    ...overrides,
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
): Promise<{ id: string; version: number }> {
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "Lin Xia",
      worldSetting: "Contemporary city life",
      workOrRole: "Graduate student and independent illustrator",
      coreTraits: ["serious", "independent", "warm"],
      centralContradiction:
        "Balances creative plans with important relationships",
      primaryGoal: "Complete the graduation portfolio",
      relationshipToUser: "A familiar friend",
      dialogueStyle: "Natural, concise, and occasionally dry",
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    },
  });
  expect(generated.statusCode).toBe(201);
  const draft = jsonBody<{ character: { id: string; version: number } }>(
    generated,
  ).character;
  const published = await app.inject({
    method: "POST",
    url: "/api/characters/" + draft.id + "/publish",
    payload: { expectedVersion: draft.version },
  });
  expect(published.statusCode).toBe(200);
  return jsonBody<{ character: { id: string; version: number } }>(published)
    .character;
}

async function createSession(
  app: PersonaSimApp,
  agentId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/agents/" + agentId + "/sessions",
    payload: {},
  });
  expect(response.statusCode).toBe(201);
  return jsonBody<{ session: { id: string } }>(response).session.id;
}

function sendMessage(
  app: PersonaSimApp,
  sessionId: string,
  agentId: string,
  clientMessageId: string,
  text: string,
) {
  return app.inject({
    method: "POST",
    url: "/api/sessions/" + sessionId + "/messages",
    payload: { agentId, clientMessageId, text },
  });
}

function latestChatTurnPrompt(
  calls: ReadonlyArray<
    readonly [{ purpose: string; prompt: string }, ...unknown[]]
  >,
): string {
  const call = calls.findLast(([input]) => input.purpose === "chat_turn");
  if (call === undefined) throw new Error("Expected a chat_turn LLM call");
  return call[0].prompt;
}

function latestCareCueContext(
  calls: ReadonlyArray<
    readonly [{ purpose: string; prompt: string }, ...unknown[]]
  >,
): CareCuePromptContext {
  const prompt = latestChatTurnPrompt(calls);
  const marker = "FOLLOWUP_CONTEXT_JSON\n";
  const markerIndex = prompt.lastIndexOf(marker);
  if (markerIndex < 0) throw new Error("Follow-up context segment is missing");
  const jsonLine = prompt.slice(markerIndex + marker.length).split("\n", 1)[0];
  if (jsonLine === undefined) throw new Error("Follow-up context is empty");
  return JSON.parse(jsonLine) as CareCuePromptContext;
}

function messageCount(
  app: PersonaSimApp,
  agentId: string,
  messageKind: string,
): number {
  const row = app.personasim.store.database
    .prepare(
      "SELECT COUNT(*) AS count FROM messages " +
        "WHERE agent_id = ? AND message_kind = ?",
    )
    .get(agentId, messageKind) as { count: number };
  return Number(row.count);
}

function activeCareCueCount(app: PersonaSimApp, agentId: string): number {
  const row = app.personasim.store.database
    .prepare(
      "SELECT COUNT(*) AS count FROM care_cues " +
        "WHERE agent_id = ? AND status = 'active'",
    )
    .get(agentId) as { count: number };
  return Number(row.count);
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

interface ChatTurnBody {
  userMessage: { id: string; content: string };
  assistantMessage: {
    id: string;
    content: string;
    metadata: Record<string, unknown>;
  };
}

interface FollowUpRow {
  id: string;
  subject_type: string;
  context_summary: string;
  source_message_id: string;
  status: string;
}

interface CareCueRow {
  id: string;
  context_summary: string;
  source_message_id: string;
  status: string;
  mention_count: number;
}

interface CheckpointRow {
  id: string;
  from_message_id: string;
  through_message_id: string;
  source_message_count: number;
  autobiography_snapshot_id: string | null;
  status: string;
}

interface CareCuePromptContext {
  careCues: Array<{
    id: string;
    contextSummary: string;
    mentionGuidance: string;
    expiresAtUtc: string;
  }>;
}
