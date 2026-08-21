import {
  MemoryCandidateSchema,
  MemoryRecallPreviewResponseSchema,
  MemorySchema,
  SendMessageResponseSchema,
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
          memoryContent: "The user prefers jasmine tea.",
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

async function createTestApp(developerRoutes = true): Promise<{
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
    memoryRecallMode: "legacy",
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
  return { result, call };
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
