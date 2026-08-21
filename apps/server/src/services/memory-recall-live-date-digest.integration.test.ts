import type { EvidenceBundle } from "@personasim/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";

const NOW = "2026-08-21T04:00:00.000Z";

describe("live DateDigest recall", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it("injects exactly one EvidenceBundle through the composed enforced chat path", async () => {
    app = await createApp();
    const agentId = await createAndPublish(app);
    expect(
      app.personasim.store.insertActivityEvent({
        id: "activity-live-date-digest",
        agentId,
        eventType: "completed",
        occurredAtUtc: "2026-08-20T02:00:00.000Z",
        summary: "A verified walk in the requested local day.",
        outcomeFacts: ["Completed the verified walk"],
        stateDelta: {},
        origin: "deterministic",
        idempotencyKey: "activity:live-date-digest",
      }),
    ).toBe(true);
    const llmCalls = vi.spyOn(app.personasim.llm, "generateObject");
    const session = app.personasim.conversations.createSession(
      agentId,
      "Live hierarchy prompt",
    );

    const turn = await app.personasim.conversations.chat(session.id, {
      agentId,
      clientMessageId: "live-date-digest",
      text: "yesterday",
    });

    expect(turn.memoryRecall).toMatchObject({
      rolloutMode: "enforced",
      recallMode: "date_digest",
      promptStrategy: "evidence_selected",
    });
    const call = llmCalls.mock.calls.findLast(
      ([input]) => input.purpose === "chat_turn",
    );
    if (call === undefined) throw new Error("Expected a chat_turn call");
    const prompt = call[0].prompt;
    const context = referenceContext(prompt);
    expect(context.relevantMemories).toEqual([]);
    expect(context.memoryEvidence?.mode).toBe("date_digest");
    expect(
      context.memoryEvidence?.evidence.map((item) => item.evidence.sourceId),
    ).toEqual(["activity-live-date-digest"]);
    expect(context.memoryEvidence?.evidence).toHaveLength(1);
    expect(prompt.match(/"memoryEvidence"/gu)).toHaveLength(1);
    expect(prompt).not.toContain("Verified date-range digest");

    const run = app.personasim.retrievalRuns.listByAgent(agentId, 1)[0];
    expect(run?.inputSnapshot.hierarchy).toMatchObject({
      finalTier: "date_digest",
    });
    expect(run?.result).toEqual(
      run === undefined
        ? undefined
        : app.personasim.memoryRecalls.replay(run.inputSnapshot),
    );
  });
});

async function createApp(): Promise<PersonaSimApp> {
  const config = readConfig({
    nodeEnv: "test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    chatEffectsMode: "off",
    scheduleNegotiationMode: "legacy",
    liveWorldEffectsMode: "off",
    memoryRecallMode: "enforced",
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
    clock: new FakeClock(NOW),
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
}

async function createAndPublish(app: PersonaSimApp): Promise<string> {
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "Live Recall Agent",
      worldSetting: "Contemporary city life",
      workOrRole: "Illustrator",
      coreTraits: ["careful", "warm", "direct"],
      centralContradiction: "Values focus and close relationships",
      primaryGoal: "Finish a portfolio",
      relationshipToUser: "Trusted friend",
      dialogueStyle: "Natural and concise",
      tier: "high_fidelity",
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
  return draft.character.id;
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
