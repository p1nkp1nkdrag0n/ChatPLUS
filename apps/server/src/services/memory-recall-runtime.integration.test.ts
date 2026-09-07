import {
  MemoryCandidateSchema,
  MemoryEvidenceSchema,
  MemoryRecallPreviewResponseSchema,
  MemorySchema,
  SendMessageResponseSchema,
  type Memory,
  type MemoryCandidate,
  type EvidenceBundle,
} from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import {
  RETRIEVAL_RUN_STAGE_NAMES,
  RetrievalRunRepository,
  type RetrievalRun,
} from "../repositories/retrieval-run-repository.js";
import { FakeClock } from "../runtime/clock.js";
import { ConversationService } from "./conversation-service.js";
import type { GenerateObjectInput, LlmService } from "./llm-service.js";
import { validateMergeAndPersistMemories } from "./memory-service.js";

const NOW = "2026-08-21T04:00:00.000Z";
const QUERY = "What tea do I prefer? jasmine tea";
const BASIC_QUERY = "project codename \u7ffc";

describe("memory recall runtime integration", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it("records a complete inspection run for developer recall preview", async () => {
    const created = await createTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls);
    const character = await createAndPublish(app);
    const seeded = seedRecallMemories(app, character.id);

    const beforeMemoryCount = Number(
      (
        app.personasim.store.database
          .prepare("SELECT COUNT(*) AS count FROM memories WHERE agent_id = ?")
          .get(character.id) as { count: number }
      ).count,
    );
    const beforeEventCount = app.personasim.store.listDomainEvents(
      character.id,
      500,
    ).length;

    const response = await app.inject({
      method: "POST",
      url: `/api/developer/agents/${character.id}/memory-recall-preview`,
      payload: { message: QUERY },
    });

    expect(response.statusCode).toBe(200);
    const preview = MemoryRecallPreviewResponseSchema.parse(
      JSON.parse(response.body),
    );
    expect(preview.agentId).toBe(character.id);
    expect(preview.strategy).toMatchObject({
      name: "continuity_hierarchy_v1",
      minimumScore: 0.42,
      maxEvidence: 3,
      candidateLimit: 200,
    });
    expect(preview.timing.evaluatedAtUtc).toBe(NOW);
    expect(preview.timing.durationMs).toBeGreaterThanOrEqual(0);
    expect(preview.result.abstained).toBe(false);
    expect(preview.result.mode).toBe("verbatim_quote");
    const selectedMemoryId = preview.result.selectedMemoryIds[0];
    if (selectedMemoryId === undefined) {
      throw new Error("Expected a selected verbatim memory");
    }
    expect(selectedMemoryId).not.toBe(seeded.teaMemoryId);
    expect(selectedMemoryId).not.toBe(seeded.unverifiedMemoryId);
    expect(preview.selectedItems).toEqual([
      expect.objectContaining({
        memoryId: selectedMemoryId,
        memoryContent: "I prefer jasmine tea.",
      }),
    ]);
    expect(preview.evidence).toEqual([
      expect.objectContaining({
        memoryId: selectedMemoryId,
        sourceType: "message",
        sourceId: seeded.teaMessageId,
      }),
    ]);
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM memories WHERE agent_id = ?")
        .get(character.id),
    ).toEqual({ count: beforeMemoryCount });
    expect(
      app.personasim.store.listDomainEvents(character.id, 500),
    ).toHaveLength(beforeEventCount);

    const listResponse = await app.inject({
      method: "GET",
      url: `/api/developer/agents/${character.id}/retrieval-runs`,
    });
    expect(listResponse.statusCode).toBe(200);
    const [run] = jsonBody<{ runs: RetrievalRun[] }>(listResponse).runs;
    expect(run).toBeDefined();
    if (run === undefined) throw new Error("Retrieval run was not recorded");
    expect(run.stages.map((stage) => stage.name)).toEqual(
      RETRIEVAL_RUN_STAGE_NAMES,
    );
    expect(run.candidates).toHaveLength(run.inputSnapshot.memories.length);
    expect(run.candidates).toContainEqual(
      expect.objectContaining({
        memoryId: selectedMemoryId,
        decision: "selected",
        selectionRank: 1,
        reasonCode: "top_ranked",
      }),
    );
    expect(
      run.candidates.some(
        (candidate) =>
          candidate.memoryId === seeded.teaMemoryId ||
          candidate.memoryId === seeded.unverifiedMemoryId,
      ),
    ).toBe(false);
    expect(run.inputSnapshot).toMatchObject({
      strategyVersion: "continuity_hierarchy_v1",
      hierarchy: { finalTier: "verbatim_quote" },
    });
    expect(run.configSnapshot).toMatchObject({
      strategy: {
        name: "continuity_hierarchy_v1",
        minimumScore: 0.42,
      },
      scoreWeights: {
        lexical: 0.4,
        tag: 0.15,
      },
    });
    expect(run.renderedPromptFragment).toContain('"memoryEvidence"');
    expect(run.evidenceBundle).toEqual(
      run.result.abstained ? undefined : run.result.evidenceBundle,
    );

    const detailResponse = await app.inject({
      method: "GET",
      url: `/api/developer/retrieval-runs/${run.id}`,
    });
    expect(detailResponse.statusCode).toBe(200);
    expect(jsonBody<{ run: RetrievalRun }>(detailResponse).run).toEqual(run);

    const replayResponse = await app.inject({
      method: "GET",
      url: `/api/developer/retrieval-runs/${run.id}/replay`,
    });
    expect(replayResponse.statusCode).toBe(200);
    const replay = jsonBody<{
      runId: string;
      input: RetrievalRun["inputSnapshot"];
      result: RetrievalRun["result"];
      matchesRecordedResult: boolean;
    }>(replayResponse);
    expect(replay).toMatchObject({
      runId: run.id,
      result: run.result,
      matchesRecordedResult: true,
    });
    expect(
      replay.input.memories.every(
        (memory) =>
          memory.sourceMessageIds.length === 0 &&
          memory.sourceActivityEventIds.length === 0,
      ),
    ).toBe(true);
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM retrieval_runs")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("keeps legacy and shadow prompts equal and enforces selected evidence", async () => {
    const created = await createTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls);
    const character = await createAndPublish(app);
    const seeded = seedRecallMemories(app, character.id);
    calls.length = 0;
    const retrievalRuns = new RetrievalRunRepository(
      app.personasim.store.database,
    );

    const legacy = await runTurn(app, calls, character.id, "legacy");
    expect(retrievalRuns.listByAgent(character.id)).toHaveLength(0);
    const shadow = await runTurn(app, calls, character.id, "shadow");
    expect(retrievalRuns.listByAgent(character.id)).toHaveLength(1);
    const enforced = await runTurn(app, calls, character.id, "enforced");
    const recordedRuns = retrievalRuns.listByAgent(character.id);
    expect(recordedRuns).toHaveLength(2);
    expect(new Set(recordedRuns.map((run) => run.id))).toHaveProperty(
      "size",
      2,
    );
    expect(recordedRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: shadow.sessionId,
          sourceMessageId: shadow.result.userMessage.id,
        }),
        expect.objectContaining({
          sessionId: enforced.sessionId,
          sourceMessageId: enforced.result.userMessage.id,
        }),
      ]),
    );
    for (const run of recordedRuns) {
      expect(run.result.abstained).toBe(false);
      expect(run.result.selectedMemoryIds).toEqual([seeded.teaMemoryId]);
      expect(run.evidenceBundle).toEqual(
        run.result.abstained ? undefined : run.result.evidenceBundle,
      );
      expect(run.stages).toHaveLength(RETRIEVAL_RUN_STAGE_NAMES.length);
    }

    expect(relevantMemories(legacy.call.prompt)).toEqual(
      relevantMemories(shadow.call.prompt),
    );
    expect(
      relevantMemories(legacy.call.prompt).map((memory) => memory.content),
    ).toContain("The user prefers jasmine tea with honey.");
    expect(referenceContext(legacy.call.prompt).memoryEvidence).toBeUndefined();
    expect(referenceContext(shadow.call.prompt).memoryEvidence).toBeUndefined();
    expect(legacy.result.memoryRecall).toBeUndefined();

    expect(shadow.result.memoryRecall).toMatchObject({
      rolloutMode: "shadow",
      promptStrategy: "legacy_active",
      selectedMemoryIds: [seeded.teaMemoryId],
    });
    expect(shadow.result.assistantMessage.metadata.memoryRecall).toEqual(
      shadow.result.memoryRecall,
    );

    expect(enforced.result.memoryRecall).toMatchObject({
      rolloutMode: "enforced",
      promptStrategy: "evidence_selected",
      promptMemoryIds: [seeded.teaMemoryId],
      selectedMemoryIds: [seeded.teaMemoryId],
    });
    const enforcedContext = referenceContext(enforced.call.prompt);
    expect(enforcedContext.relevantMemories).toEqual([]);
    expect(enforcedContext.memoryEvidence).toMatchObject({
      query: QUERY,
      mode: "verbatim_quote",
      evidence: [
        {
          memoryId: seeded.teaMemoryId,
          memoryContent: "用户在对话中说过：「I prefer jasmine tea.」",
          evidence: {
            sourceType: "message",
            sourceId: seeded.teaMessageId,
            quote: "I prefer jasmine tea.",
          },
        },
      ],
    });
    expect(enforcedContext.memoryEvidence?.evidence).toHaveLength(1);
    expect(enforced.call.prompt).not.toContain(
      "The user prefers jasmine tea with honey.",
    );
    expect(enforced.result.memoryRecall?.selectedEvidenceIds).toHaveLength(1);

    expect(() => SendMessageResponseSchema.parse(legacy.result)).not.toThrow();
    expect(() => SendMessageResponseSchema.parse(shadow.result)).not.toThrow();
    expect(() =>
      SendMessageResponseSchema.parse(enforced.result),
    ).not.toThrow();

    const recallEvents = app.personasim.store
      .listDomainEvents(character.id, 500)
      .filter((event) => event.eventType === "memory.recall_evaluated");
    expect(recallEvents).toHaveLength(2);
    expect(recallEvents.map((event) => event.payload)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rolloutMode: "shadow" }),
        expect.objectContaining({ rolloutMode: "enforced" }),
      ]),
    );
  });

  it.each(["shadow", "enforced"] as const)(
    "rolls back messages and the retrieval run when a later %s commit step fails",
    async (mode) => {
      const created = await createTestApp(true, mode);
      app = created.app;
      const calls: Array<GenerateObjectInput<unknown>> = [];
      mockLlm(app.personasim.llm, calls);
      const character = await createAndPublish(app);
      seedRecallMemories(app, character.id);
      calls.length = 0;
      const session = app.personasim.conversations.createSession(
        character.id,
        `${mode} rollback`,
      );
      const clientMessageId = `recall-${mode}-rollback`;
      const insertDomainEvent = app.personasim.store.insertDomainEvent.bind(
        app.personasim.store,
      );
      vi.spyOn(app.personasim.store, "insertDomainEvent").mockImplementation(
        (event) =>
          event.eventType === "conversation.turn_committed"
            ? false
            : insertDomainEvent(event),
      );

      const response = await app.inject({
        method: "POST",
        url: `/api/sessions/${session.id}/messages`,
        payload: {
          agentId: character.id,
          clientMessageId,
          text: QUERY,
        },
      });

      expect(response.statusCode).toBe(500);
      expect(
        app.personasim.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM messages WHERE session_id = ?",
          )
          .get(session.id),
      ).toEqual({ count: 0 });
      expect(
        app.personasim.store.database
          .prepare(
            "SELECT COUNT(*) AS count FROM retrieval_runs WHERE agent_id = ?",
          )
          .get(character.id),
      ).toEqual({ count: 0 });
      expect(
        app.personasim.store.findTurnByClientMessageId(
          session.id,
          clientMessageId,
        ),
      ).toBeUndefined();
    },
  );

  it("rejects a prepared retrieval run owned by another agent", async () => {
    const created = await createTestApp(true, "enforced");
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls);
    const character = await createAndPublish(app);
    const otherCharacter = await createAndPublish(app);
    seedRecallMemories(app, character.id);
    calls.length = 0;
    const session = app.personasim.conversations.createSession(
      character.id,
      "mismatched retrieval owner",
    );
    const preparePreviewRecording =
      app.personasim.memoryRecalls.preparePreviewRecording.bind(
        app.personasim.memoryRecalls,
      );
    vi.spyOn(
      app.personasim.memoryRecalls,
      "preparePreviewRecording",
    ).mockImplementation((input) => {
      const prepared = preparePreviewRecording(input);
      return {
        ...prepared,
        retrievalRun: {
          ...prepared.retrievalRun,
          agentId: otherCharacter.id,
          inputSnapshot: {
            ...prepared.retrievalRun.inputSnapshot,
            agentId: otherCharacter.id,
            memories: prepared.retrievalRun.inputSnapshot.memories.map(
              (memory) => ({ ...memory, agentId: otherCharacter.id }),
            ),
          },
        },
      };
    });

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: {
        agentId: character.id,
        clientMessageId: "recall-mismatched-owner",
        text: QUERY,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(app.personasim.store.listMessages(session.id)).toHaveLength(0);
    const retrievalRuns = new RetrievalRunRepository(
      app.personasim.store.database,
    );
    expect(retrievalRuns.listByAgent(character.id)).toHaveLength(0);
    expect(retrievalRuns.listByAgent(otherCharacter.id)).toHaveLength(0);
  });

  it("keeps one retrieval run across an idempotent client-message replay", async () => {
    const created = await createTestApp(true, "enforced");
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls);
    const character = await createAndPublish(app);
    const seeded = seedRecallMemories(app, character.id);
    calls.length = 0;
    const session = app.personasim.conversations.createSession(
      character.id,
      "enforced replay",
    );
    const command = {
      agentId: character.id,
      clientMessageId: "recall-enforced-idempotent",
      text: QUERY,
    };

    const first = await app.personasim.conversations.chat(session.id, command);
    const replay = await app.personasim.conversations.chat(session.id, command);

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.userMessage.id).toBe(first.userMessage.id);
    const runs = new RetrievalRunRepository(
      app.personasim.store.database,
    ).listByAgent(character.id);
    expect(runs).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        sourceMessageId: first.userMessage.id,
      }),
    ]);
    expect(runs[0]?.result).toMatchObject({
      abstained: false,
      selectedMemoryIds: [seeded.teaMemoryId],
    });
    expect(runs[0]?.result.selectedEvidenceIds).toHaveLength(1);
    expect(runs[0]?.result.selectedMemoryIds).not.toContain(
      seeded.unverifiedMemoryId,
    );
    expect(runs[0]?.inputSnapshot.evidence).toHaveLength(2);
    expect(
      runs[0]?.result.selectedEvidenceIds.every((evidenceId) =>
        runs[0]?.inputSnapshot.evidence.some(
          (evidence) => evidence.id === evidenceId,
        ),
      ),
    ).toBe(true);
    expect(calls.filter((call) => call.purpose === "chat_turn")).toHaveLength(
      1,
    );
  });

  it("injects no long-term evidence when enforced recall abstains", async () => {
    const created = await createTestApp();
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls);
    const character = await createAndPublish(app);
    seedRecallMemories(app, character.id);
    calls.length = 0;

    const enforced = await runTurn(
      app,
      calls,
      character.id,
      "enforced",
      "When is the project deadline?",
    );

    expect(enforced.result.memoryRecall).toMatchObject({
      rolloutMode: "enforced",
      recallMode: "none",
      abstained: true,
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    const context = referenceContext(enforced.call.prompt);
    expect(context.relevantMemories).toEqual([]);
    expect(context.memoryEvidence).toBeUndefined();
  });

  it("uses a bounded query-aware basic-memory tier through composed HTTP chat", async () => {
    const created = await createTestApp(true, "enforced");
    app = created.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockLlm(app.personasim.llm, calls);
    const character = await createAndPublish(app);
    const targetMemoryId = seedBasicMemoryPool(app, character.id);
    calls.length = 0;

    const previewResponse = await app.inject({
      method: "POST",
      url: `/api/developer/agents/${character.id}/memory-recall-preview`,
      payload: { message: BASIC_QUERY },
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = MemoryRecallPreviewResponseSchema.parse(
      JSON.parse(previewResponse.body),
    );
    expect(preview.candidateCount).toBe(200);
    expect(preview.candidateCount).toBeLessThanOrEqual(
      preview.strategy.candidateLimit,
    );
    expect(preview.result).toMatchObject({
      abstained: false,
      mode: "basic_memory",
      selectedMemoryIds: [targetMemoryId],
    });

    const retrievalRuns = new RetrievalRunRepository(
      app.personasim.store.database,
    );
    const [previewRun] = retrievalRuns.listByAgent(character.id);
    if (previewRun === undefined) throw new Error("Preview run was not stored");
    expect(previewRun.inputSnapshot.memories.length).toBeLessThanOrEqual(
      previewRun.inputSnapshot.candidateLimit,
    );
    expect(previewRun.inputSnapshot.hierarchy).toMatchObject({
      finalTier: "basic_memory",
    });
    const replayResponse = await app.inject({
      method: "GET",
      url: `/api/developer/retrieval-runs/${previewRun.id}/replay`,
    });
    expect(replayResponse.statusCode).toBe(200);
    expect(
      jsonBody<{ matchesRecordedResult: boolean }>(replayResponse),
    ).toMatchObject({ matchesRecordedResult: true });

    const session = app.personasim.conversations.createSession(
      character.id,
      "Composed recall",
    );
    const callStart = calls.length;
    const chatResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: {
        agentId: character.id,
        clientMessageId: "composed-basic-recall",
        text: BASIC_QUERY,
      },
    });
    expect(chatResponse.statusCode).toBe(201);
    const chat = SendMessageResponseSchema.parse(JSON.parse(chatResponse.body));
    expect(chat.memoryRecall).toMatchObject({
      rolloutMode: "enforced",
      recallMode: "basic_memory",
      promptMemoryIds: [targetMemoryId],
      selectedMemoryIds: [targetMemoryId],
    });
    const chatCall = calls
      .slice(callStart)
      .find((item) => item.purpose === "chat_turn");
    if (chatCall === undefined) {
      throw new Error("HTTP chat call was not captured");
    }
    expect(referenceContext(chatCall.prompt).memoryEvidence).toMatchObject({
      mode: "basic_memory",
      evidence: [expect.objectContaining({ memoryId: targetMemoryId })],
    });

    const runs = retrievalRuns.listByAgent(character.id);
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run.inputSnapshot.memories.length).toBeLessThanOrEqual(
        run.inputSnapshot.candidateLimit,
      );
    }
  });

  it("does not register retrieval inspector routes when developer routes are disabled", async () => {
    const created = await createTestApp(false);
    app = created.app;

    expect(
      app.hasRoute({
        method: "GET",
        url: "/api/developer/retrieval-runs/:id",
      }),
    ).toBe(false);
    expect(
      app.hasRoute({
        method: "GET",
        url: "/api/developer/retrieval-runs/:id/replay",
      }),
    ).toBe(false);
  });
});

async function createTestApp(
  developerRoutes = true,
  memoryRecallMode: "legacy" | "shadow" | "enforced" = "legacy",
): Promise<{
  app: PersonaSimApp;
  clock: FakeClock;
}> {
  const clock = new FakeClock(NOW);
  const config = readConfig({
    nodeEnv: "test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes,
    chatEffectsMode: "off",
    scheduleNegotiationMode: "legacy",
    liveWorldEffectsMode: "off",
    memoryRecallMode,
    llm: {
      provider: "openai-compatible",
      baseUrl: "https://example.invalid",
      apiKey: "test-api-key",
      model: "test-live-model",
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

function mockLlm(
  llm: LlmService,
  calls: Array<GenerateObjectInput<unknown>>,
): void {
  vi.spyOn(llm, "generateObject").mockImplementation((input) => {
    calls.push(input);
    if (input.purpose === "chat_turn") {
      return Promise.resolve({ text: "Acknowledged." });
    }
    if (input.fixture !== undefined) return Promise.resolve(input.fixture);
    throw new Error(`No fixture for ${input.purpose}`);
  });
}

async function createAndPublish(
  app: PersonaSimApp,
): Promise<{ id: string; version: number }> {
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "Recall Test Agent",
      worldSetting: "Contemporary city life",
      workOrRole: "Illustrator",
      coreTraits: ["careful", "warm", "direct"],
      centralContradiction: "Values focus and close relationships",
      primaryGoal: "Finish a portfolio",
      relationshipToUser: "Trusted friend",
      dialogueStyle: "Natural and concise",
      tier: "daily",
      timezone: "Asia/Shanghai",
    },
  });
  expect(generated.statusCode).toBe(201);
  const draft = jsonBody<{ character: { id: string; version: number } }>(
    generated,
  ).character;
  const published = await app.inject({
    method: "POST",
    url: `/api/characters/${draft.id}/publish`,
    payload: { expectedVersion: draft.version },
  });
  expect(published.statusCode).toBe(200);
  return jsonBody<{ character: { id: string; version: number } }>(published)
    .character;
}

function seedRecallMemories(
  app: PersonaSimApp,
  agentId: string,
): {
  teaMessageId: string;
  teaMemoryId: string;
  unverifiedMemoryId: string;
} {
  const session = app.personasim.conversations.createSession(
    agentId,
    "Recall sources",
  );
  const teaMessageId = "message-recall-tea";
  const bicycleMessageId = "message-recall-bicycle";
  app.personasim.store.insertMessage({
    id: teaMessageId,
    sessionId: session.id,
    agentId,
    role: "user",
    content: "I prefer jasmine tea.",
    messageKind: "user",
    metadata: {},
    createdAtUtc: NOW,
  });
  app.personasim.store.insertMessage({
    id: bicycleMessageId,
    sessionId: session.id,
    agentId,
    role: "user",
    content: "I own a red bicycle.",
    messageKind: "user",
    metadata: {},
    createdAtUtc: NOW,
  });

  const [teaMemory] = validateMergeAndPersistMemories({
    store: app.personasim.store,
    agentId,
    candidates: [
      stableUserMemory("The user prefers jasmine tea.", ["tea", "jasmine"]),
    ],
    nowUtc: NOW,
    maxCandidates: 1,
    authoritativeMessageId: teaMessageId,
  });
  validateMergeAndPersistMemories({
    store: app.personasim.store,
    agentId,
    candidates: [
      stableUserMemory("The user owns a red bicycle.", ["bicycle", "red"]),
    ],
    nowUtc: NOW,
    maxCandidates: 1,
    authoritativeMessageId: bicycleMessageId,
  });
  if (teaMemory === undefined) throw new Error("Tea memory was not persisted");

  const unverifiedMemoryId = "memory-unverified-jasmine";
  insertMemoryWithoutEvidence(app, {
    id: unverifiedMemoryId,
    agentId,
    sourceMessageId: teaMessageId,
  });
  return {
    teaMessageId,
    teaMemoryId: teaMemory.id,
    unverifiedMemoryId,
  };
}

function seedBasicMemoryPool(app: PersonaSimApp, agentId: string): string {
  const target = MemorySchema.parse({
    id: "memory-basic-recall-target",
    agentId,
    kind: "semantic",
    content: "The user's project codename \u7ffc is confidential.",
    importance: 0.2,
    confidence: 1,
    tags: ["project", "codename", "\u7ffc"],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "stable",
    temporalMetadata: {
      recordedAtUtc: NOW,
      temporalCertainty: "exact",
      temporalStatus: "unknown",
    },
    status: "active",
    dedupeKey: "basic-recall-target",
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  });
  const insert = app.personasim.store.database.prepare(
    `INSERT INTO memories(
       id, agent_id, type, content, tags_json, importance, confidence,
       created_at_utc, memory_json, namespace, certainty, attribution,
       stability, status, recorded_at_utc, temporal_certainty, temporal_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const persist = (memory: Memory): void => {
    insert.run(
      memory.id,
      memory.agentId,
      memory.kind,
      memory.content,
      JSON.stringify(memory.tags),
      memory.importance,
      memory.confidence,
      memory.createdAtUtc,
      JSON.stringify(memory),
      memory.namespace,
      memory.certainty,
      memory.attribution,
      memory.stability,
      memory.status,
      memory.temporalMetadata?.recordedAtUtc,
      memory.temporalMetadata?.temporalCertainty,
      memory.temporalMetadata?.temporalStatus,
    );
  };
  persist(target);

  const evidence = MemoryEvidenceSchema.parse({
    id: "evidence-basic-recall-target",
    memoryId: target.id,
    sourceType: "manual",
    sourceId: "manual-basic-recall-fixture",
    quote: "I chose \u7ffc as my project codename.",
    contextSummary: "Explicit test fixture for authoritative recall.",
    recordedAtUtc: NOW,
  });
  app.personasim.store.database
    .prepare(
      `INSERT INTO memory_evidence(
         id, memory_id, source_type, source_id, quote,
         context_summary, recorded_at_utc, evidence_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      evidence.id,
      evidence.memoryId,
      evidence.sourceType,
      evidence.sourceId,
      evidence.quote,
      evidence.contextSummary,
      evidence.recordedAtUtc,
      JSON.stringify(evidence),
    );

  for (let index = 0; index < 250; index += 1) {
    persist(
      MemorySchema.parse({
        id: `memory-basic-recall-filler-${index}`,
        agentId,
        kind: "semantic",
        content: `Project status note ${index} about a routine weekly update.`,
        importance: 0.9,
        confidence: 1,
        tags: ["project", "filler"],
        sourceMessageIds: [],
        sourceActivityEventIds: [],
        origin: "runtime_simulation",
        namespace: "user_model",
        certainty: "inferred",
        attribution: "model_inference",
        stability: "situational",
        temporalMetadata: {
          recordedAtUtc: NOW,
          temporalCertainty: "unknown",
          temporalStatus: "unknown",
        },
        status: "active",
        dedupeKey: `basic-recall-filler-${index}`,
        createdAtUtc: NOW,
        updatedAtUtc: NOW,
      }),
    );
  }
  return target.id;
}

function stableUserMemory(content: string, tags: string[]): MemoryCandidate {
  return MemoryCandidateSchema.parse({
    kind: "semantic",
    content,
    importance: 0.9,
    confidence: 1,
    tags,
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "stable",
    temporalMetadata: {
      mentionedAtUtc: NOW,
      recordedAtUtc: NOW,
      temporalCertainty: "exact",
      temporalStatus: "unknown",
    },
    evidence: [],
    shouldWrite: true,
    forbiddenOverclaims: [],
    reasonCode: "stable_user_preference",
    reasonSummary: "The user stated this directly.",
  });
}

function insertMemoryWithoutEvidence(
  app: PersonaSimApp,
  input: { id: string; agentId: string; sourceMessageId: string },
): void {
  const memory = MemorySchema.parse({
    id: input.id,
    agentId: input.agentId,
    kind: "semantic",
    content: "The user prefers jasmine tea with honey.",
    importance: 1,
    confidence: 1,
    tags: ["tea", "jasmine", "honey"],
    sourceMessageIds: [input.sourceMessageId],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "inferred",
    attribution: "mixed",
    stability: "stable",
    temporalMetadata: {
      mentionedAtUtc: NOW,
      recordedAtUtc: NOW,
      temporalCertainty: "exact",
      temporalStatus: "unknown",
    },
    status: "active",
    dedupeKey: "unverified-jasmine-memory",
    createdAtUtc: NOW,
    updatedAtUtc: NOW,
  });
  app.personasim.store.database
    .prepare(
      [
        "INSERT INTO memories(",
        "id, agent_id, type, content, tags_json, importance, confidence,",
        "created_at_utc, memory_json, namespace, certainty, attribution,",
        "stability, status, mentioned_at_utc, recorded_at_utc,",
        "temporal_certainty, temporal_status",
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" "),
    )
    .run(
      memory.id,
      memory.agentId,
      memory.kind,
      memory.content,
      JSON.stringify(memory.tags),
      memory.importance,
      memory.confidence,
      memory.createdAtUtc,
      JSON.stringify(memory),
      memory.namespace,
      memory.certainty,
      memory.attribution,
      memory.stability,
      memory.status,
      memory.temporalMetadata?.mentionedAtUtc,
      memory.temporalMetadata?.recordedAtUtc,
      memory.temporalMetadata?.temporalCertainty,
      memory.temporalMetadata?.temporalStatus,
    );
}

async function runTurn(
  app: PersonaSimApp,
  calls: Array<GenerateObjectInput<unknown>>,
  agentId: string,
  mode: "legacy" | "shadow" | "enforced",
  query = QUERY,
): Promise<{
  result: Awaited<ReturnType<ConversationService["chat"]>>;
  call: GenerateObjectInput<unknown>;
  sessionId: string;
}> {
  const conversations = new ConversationService(
    app.personasim.store,
    app.personasim.clock,
    app.personasim.llm,
    app.personasim.schedules,
    app.personasim.settlements,
    app.personasim.sse,
    {
      chatEffectsMode: "off",
      scheduleNegotiationMode: "legacy",
      liveWorldEffectsMode: "off",
      memoryRecallMode: mode,
    },
  );
  const session = conversations.createSession(agentId, `${mode} recall`);
  const callStart = calls.length;
  const result = await conversations.chat(session.id, {
    agentId,
    clientMessageId: `recall-${mode}`,
    text: query,
  });
  const call = calls
    .slice(callStart)
    .find((item) => item.purpose === "chat_turn");
  if (call === undefined) throw new Error("Chat call was not captured");
  return { result, call, sessionId: session.id };
}

function referenceContext(prompt: string): {
  relevantMemories: Array<{ content: string }>;
  memoryEvidence?: EvidenceBundle;
} {
  const lines = prompt.split("\n");
  const marker = lines.indexOf("REFERENCE_CONTEXT_JSON");
  const contextLine = lines[marker + 1];
  if (marker < 0 || contextLine === undefined) {
    throw new Error("Reference context was not found");
  }
  return JSON.parse(contextLine) as {
    relevantMemories: Array<{ content: string }>;
    memoryEvidence?: EvidenceBundle;
  };
}

function relevantMemories(prompt: string): Array<{ content: string }> {
  return referenceContext(prompt).relevantMemories;
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
