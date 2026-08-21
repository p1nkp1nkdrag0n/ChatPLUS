import { EventCardSchema, type EventCard } from "@personasim/contracts";
import { resolveTemporalQuery } from "@personasim/features";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { ContinuityRepository } from "./continuity-repository.js";
import { temporalAnchorsFromEventCards } from "./continuity-index-service.js";
import type { MemoryRecallService } from "./memory-recall-service.js";

const SHANGHAI_NOW = "2026-08-21T04:00:00.000Z";

describe("continuity memory recall hierarchy", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
  });

  it("prefers EventCards, selects at most three sources, records relationship score, and replays exactly", async () => {
    const harness = await createHarness({
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const sessionId = app.personasim.conversations.createSession(
      harness.agentId,
      "Hierarchy event cards",
    ).id;
    const cards: EventCard[] = [];

    for (let index = 0; index < 4; index += 1) {
      const messageId = `message-shared-trail-${index}`;
      const content = `Shared trail memory ${index} was a joyful experience.`;
      insertUserMessage(app, {
        id: messageId,
        sessionId,
        agentId: harness.agentId,
        content,
        createdAtUtc: `2026-08-20T0${index + 1}:00:00.000Z`,
      });
      cards.push(
        sharedEventCard({
          id: `event-card-shared-trail-${index}`,
          agentId: harness.agentId,
          messageId,
          title: `Shared trail memory ${index}`,
          summary: content,
          occurredAtUtc: `2026-08-20T0${index + 1}:00:00.000Z`,
        }),
      );
    }
    expect(
      new ContinuityRepository(app.personasim.store).upsertEventCards(cards),
    ).toBe(4);

    const preview = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: "shared trail memory",
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });

    expect(preview.strategy.name).toBe("continuity_hierarchy_v1");
    expect(preview.result).toMatchObject({
      mode: "event_card",
      abstained: false,
    });
    if (preview.result.abstained) throw new Error("Expected EventCard recall");
    expect(preview.result.evidenceBundle.evidence).toHaveLength(3);
    expect(preview.result.selectedMemoryIds).toHaveLength(3);

    const run = latestRun(app, harness.agentId);
    expect(run.inputSnapshot.hierarchy).toMatchObject({
      finalTier: "event_card",
    });
    const state = app.personasim.store.getRuntimeState(harness.agentId);
    if (state === undefined) throw new Error("Expected runtime state");
    const expectedRelationshipScore = roundScore(
      state.relationship.closeness * 0.35 +
        state.relationship.trust * 0.4 +
        state.relationship.familiarity * 0.25,
    );
    expect(run.candidates).toHaveLength(4);
    expect(
      run.candidates.every(
        (candidate) =>
          candidate.relationshipScore === expectedRelationshipScore,
      ),
    ).toBe(true);
    expect(
      run.candidates.filter((candidate) => candidate.decision === "selected"),
    ).toHaveLength(3);
    expectReplayExact(app.personasim.memoryRecalls, app, run.id);
  });

  it("falls back to Verbatim and then none without using basic memories", async () => {
    const harness = await createHarness({
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const sessionId = app.personasim.conversations.createSession(
      harness.agentId,
      "Hierarchy verbatim",
    ).id;
    insertUserMessage(app, {
      id: "message-saffron-constellation",
      sessionId,
      agentId: harness.agentId,
      content:
        "The saffron constellation phrase exists only in this verbatim message.",
      createdAtUtc: "2026-08-20T08:00:00.000Z",
    });

    const verbatim = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: "saffron constellation",
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    expect(verbatim.result).toMatchObject({
      mode: "verbatim_quote",
      abstained: false,
    });
    if (verbatim.result.abstained) throw new Error("Expected verbatim recall");
    expect(verbatim.result.evidenceBundle.evidence[0]).toMatchObject({
      evidence: {
        sourceType: "message",
        sourceId: "message-saffron-constellation",
      },
    });
    expect(verbatim.result.mode).not.toBe("basic_memory");

    const none = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: "zyxwv utterly absent evidence",
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    expect(none.result).toMatchObject({ mode: "none", abstained: true });
    expect(none.result).not.toHaveProperty("evidenceBundle");
    expect(
      latestRun(app, harness.agentId).inputSnapshot.hierarchy,
    ).toMatchObject({
      finalTier: "none",
    });
  });

  it("recalls a completion preference instead of rejecting it as a missing temporal anchor", async () => {
    const harness = await createHarness({
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const sessionId = app.personasim.conversations.createSession(
      harness.agentId,
      "Cross-session preference recall",
    ).id;
    insertUserMessage(app, {
      id: "message-riverside-preference",
      sessionId,
      agentId: harness.agentId,
      content:
        "\u6211\u4e0d\u53c2\u52a0\u5e86\u529f\u5bb4\uff1b\u4efb\u52a1\u5b8c\u6210\u540e\uff0c\u6211\u66f4\u559c\u6b22\u53bb\u5b89\u9759\u7684\u6cb3\u8fb9\u6563\u6b65\u590d\u76d8\u3002",
      createdAtUtc: "2026-08-20T08:00:00.000Z",
    });
    insertUserMessage(app, {
      id: "message-riverside-question",
      sessionId,
      agentId: harness.agentId,
      content:
        "\u6211\u4e0d\u559c\u6b22\u54ea\u4e00\u79cd\u5e86\u529f\u65b9\u5f0f\uff1f\u4efb\u52a1\u5b8c\u6210\u540e\u6211\u66f4\u559c\u6b22\u53bb\u54ea\u91cc\u3001\u505a\u4ec0\u4e48\uff1f",
      createdAtUtc: "2026-08-21T03:00:00.000Z",
    });

    const preview = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query:
        "\u6211\u4e0d\u559c\u6b22\u54ea\u4e00\u79cd\u5e86\u529f\u65b9\u5f0f\uff1f\u4efb\u52a1\u5b8c\u6210\u540e\u6211\u66f4\u559c\u6b22\u53bb\u54ea\u91cc\u3001\u505a\u4ec0\u4e48\uff1f",
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });

    expect(preview.result).toMatchObject({
      mode: "verbatim_quote",
      abstained: false,
    });
    if (preview.result.abstained) throw new Error("Expected preference recall");
    expect(preview.result.evidenceBundle.evidence[0]).toMatchObject({
      evidence: {
        sourceType: "message",
        sourceId: "message-riverside-preference",
      },
    });
    expect(
      preview.result.evidenceBundle.evidence.some(
        (item) => item.evidence.sourceId === "message-riverside-question",
      ),
    ).toBe(false);
    expect(
      latestRun(app, harness.agentId).inputSnapshot.hierarchy
        ?.temporalResolution,
    ).toEqual({ kind: "none" });
  });

  it("uses the verified local range and keeps EventCard before Verbatim before DateDigest", async () => {
    const harness = await createHarness({
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    insertActivity(app, {
      id: "activity-inside-yesterday",
      agentId: harness.agentId,
      occurredAtUtc: "2026-08-20T02:00:00.000Z",
      summary: "Inside the verified local yesterday range.",
    });
    insertActivity(app, {
      id: "activity-outside-yesterday",
      agentId: harness.agentId,
      occurredAtUtc: "2026-08-20T18:00:00.000Z",
      summary: "Outside the verified local yesterday range.",
    });

    const digest = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: "yesterday",
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    expect(digest.result).toMatchObject({
      mode: "date_digest",
      abstained: false,
    });
    if (digest.result.abstained) throw new Error("Expected DateDigest recall");
    expect(
      digest.result.evidenceBundle.evidence.map(
        (item) => item.evidence.sourceId,
      ),
    ).toEqual(["activity-inside-yesterday"]);
    expect(
      digest.result.evidenceBundle.evidence.some(
        (item) => item.evidence.sourceId === "activity-outside-yesterday",
      ),
    ).toBe(false);
    const digestRun = latestRun(app, harness.agentId);
    expect(digestRun.inputSnapshot.hierarchy).toMatchObject({
      finalTier: "date_digest",
      temporalResolution: {
        kind: "resolved",
        expression: "yesterday",
        fromUtc: "2026-08-19T16:00:00.000Z",
        toUtc: "2026-08-20T16:00:00.000Z",
      },
    });
    expectReplayExact(app.personasim.memoryRecalls, app, digestRun.id);

    const sessionId = app.personasim.conversations.createSession(
      harness.agentId,
      "Temporal hierarchy",
    ).id;
    insertUserMessage(app, {
      id: "message-yesterday-saffron",
      sessionId,
      agentId: harness.agentId,
      content: "Yesterday saffron trail note from the user.",
      createdAtUtc: "2026-08-20T03:00:00.000Z",
    });
    const verbatim = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: "saffron yesterday",
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    expect(verbatim.result).toMatchObject({
      mode: "verbatim_quote",
      abstained: false,
    });

    const card = sharedEventCard({
      id: "event-card-yesterday-saffron",
      agentId: harness.agentId,
      messageId: "message-yesterday-saffron",
      title: "Yesterday saffron trail",
      summary: "Yesterday saffron trail was a shared experience.",
      occurredAtUtc: "2026-08-20T03:00:00.000Z",
    });
    new ContinuityRepository(app.personasim.store).upsertEventCards([card]);
    const eventCard = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: "saffron yesterday",
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    expect(eventCard.result).toMatchObject({
      mode: "event_card",
      abstained: false,
    });
  });

  it("resolves yesterday across the New York DST transition without crossing the local day", async () => {
    const nowUtc = "2026-03-09T16:00:00.000Z";
    const harness = await createHarness({
      nowUtc,
      timezone: "America/New_York",
    });
    app = harness.app;
    insertActivity(app, {
      id: "activity-dst-inside",
      agentId: harness.agentId,
      occurredAtUtc: "2026-03-08T06:00:00.000Z",
      summary: "Inside the 23 hour DST day.",
    });
    insertActivity(app, {
      id: "activity-dst-outside",
      agentId: harness.agentId,
      occurredAtUtc: "2026-03-09T04:30:00.000Z",
      summary: "Outside after the DST local day.",
    });

    const preview = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: "yesterday",
      nowUtc,
      timezone: "America/New_York",
    });
    expect(preview.result).toMatchObject({
      mode: "date_digest",
      abstained: false,
    });
    const run = latestRun(app, harness.agentId);
    expect(run.inputSnapshot.hierarchy?.temporalResolution).toEqual({
      kind: "resolved",
      expression: "yesterday",
      fromUtc: "2026-03-08T05:00:00.000Z",
      toUtc: "2026-03-09T04:00:00.000Z",
    });
    if (preview.result.abstained) throw new Error("Expected DST digest");
    expect(
      preview.result.evidenceBundle.evidence.map(
        (item) => item.evidence.sourceId,
      ),
    ).toEqual(["activity-dst-inside"]);
  });

  it("uses only reliable occurred EventCards as named anchors and preserves ambiguity", () => {
    const occurred = sharedEventCard({
      id: "event-card-trip-occurred",
      agentId: "agent-anchor",
      messageId: "message-anchor",
      title: "trip",
      summary: "The trip occurred.",
      occurredAtUtc: "2026-08-20T04:00:00.000Z",
    });
    const planned = sharedEventCard({
      id: "event-card-trip-planned",
      agentId: "agent-anchor",
      messageId: "message-anchor",
      title: "trip",
      summary: "The trip is planned.",
      plannedAtUtc: "2026-08-22T04:00:00.000Z",
    });
    const approximate = EventCardSchema.parse({
      ...occurred,
      id: "event-card-trip-approximate",
      dedupeKey: "event-card-trip-approximate",
      temporalMetadata: {
        ...occurred.temporalMetadata,
        temporalCertainty: "approximate",
      },
    });

    const anchors = temporalAnchorsFromEventCards(
      [occurred, planned, approximate],
      "after trip",
    );
    expect(anchors).toEqual([
      {
        id: occurred.id,
        label: "trip",
        startAtUtc: "2026-08-20T04:00:00.000Z",
        certainty: "exact",
      },
    ]);
    expect(
      resolveTemporalQuery({
        text: "after trip",
        nowUtc: SHANGHAI_NOW,
        timezone: "Asia/Shanghai",
        anchors,
      }),
    ).toMatchObject({
      kind: "resolved",
      expression: "after_anchor",
      anchorId: occurred.id,
    });

    const secondOccurred = EventCardSchema.parse({
      ...occurred,
      id: "event-card-trip-occurred-2",
      dedupeKey: "event-card-trip-occurred-2",
      temporalMetadata: {
        ...occurred.temporalMetadata,
        occurredStartAtUtc: "2026-08-19T04:00:00.000Z",
      },
    });
    expect(
      resolveTemporalQuery({
        text: "after trip",
        nowUtc: SHANGHAI_NOW,
        timezone: "Asia/Shanghai",
        anchors: temporalAnchorsFromEventCards(
          [occurred, secondOccurred],
          "after trip",
        ),
      }),
    ).toEqual({ kind: "ambiguous", reasonCode: "ambiguous_anchor" });
    expect(
      resolveTemporalQuery({
        text: "after trip",
        nowUtc: SHANGHAI_NOW,
        timezone: "Asia/Shanghai",
        anchors: temporalAnchorsFromEventCards([planned], "after trip"),
      }),
    ).toEqual({ kind: "ambiguous", reasonCode: "anchor_not_found" });
  });
});

async function createHarness(input: {
  nowUtc: string;
  timezone: string;
}): Promise<{ app: PersonaSimApp; agentId: string }> {
  const clock = new (await import("../runtime/clock.js")).FakeClock(
    input.nowUtc,
  );
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
  const app = await buildApp({
    config,
    database: openDatabase(":memory:"),
    clock,
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "Hierarchy Agent",
      worldSetting: "Contemporary city life",
      workOrRole: "Illustrator",
      coreTraits: ["careful", "warm", "direct"],
      centralContradiction: "Values focus and close relationships",
      primaryGoal: "Finish a portfolio",
      relationshipToUser: "Trusted friend",
      dialogueStyle: "Natural and concise",
      tier: "high_fidelity",
      timezone: input.timezone,
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
  return { app, agentId: draft.id };
}

function sharedEventCard(input: {
  id: string;
  agentId: string;
  messageId: string;
  title: string;
  summary: string;
  occurredAtUtc?: string;
  plannedAtUtc?: string;
}): EventCard {
  const evidenceId = `evidence-${input.id}`;
  const recordedAtUtc =
    input.occurredAtUtc ?? input.plannedAtUtc ?? SHANGHAI_NOW;
  const temporalMetadata =
    input.occurredAtUtc === undefined
      ? {
          plannedStartAtUtc: input.plannedAtUtc,
          recordedAtUtc,
          temporalCertainty: "exact" as const,
          temporalStatus: "planned" as const,
        }
      : {
          occurredStartAtUtc: input.occurredAtUtc,
          recordedAtUtc,
          temporalCertainty: "exact" as const,
          temporalStatus: "occurred" as const,
        };
  return EventCardSchema.parse({
    id: input.id,
    agentId: input.agentId,
    cardKind: "shared_experience",
    sourceKind: "memory",
    sourceId: `source-${input.id}`,
    dedupeKey: input.id,
    title: input.title,
    summary: input.summary,
    tags: ["trip", "shared"],
    namespace: "shared_relationship",
    certainty: "explicit",
    attribution: "mixed",
    temporalMetadata,
    importance: 0.9,
    evidence: [
      {
        id: evidenceId,
        sourceType: "message_archive",
        sourceId: input.messageId,
        quote: input.summary,
        temporalStatus: temporalMetadata.temporalStatus,
        reliability: "reported",
        recordedAtUtc,
      },
    ],
    sourceEvidenceIds: [evidenceId],
    status: "active",
    indexVersion: 1,
    createdAtUtc: recordedAtUtc,
    updatedAtUtc: recordedAtUtc,
  });
}

function insertUserMessage(
  app: PersonaSimApp,
  input: {
    id: string;
    sessionId: string;
    agentId: string;
    content: string;
    createdAtUtc: string;
  },
): void {
  app.personasim.store.insertMessage({
    ...input,
    role: "user",
    messageKind: "user",
    metadata: {},
  });
}

function insertActivity(
  app: PersonaSimApp,
  input: {
    id: string;
    agentId: string;
    occurredAtUtc: string;
    summary: string;
  },
): void {
  expect(
    app.personasim.store.insertActivityEvent({
      ...input,
      eventType: "completed",
      outcomeFacts: [input.summary],
      stateDelta: {},
      origin: "deterministic",
      idempotencyKey: `activity:${input.id}`,
    }),
  ).toBe(true);
}

function latestRun(app: PersonaSimApp, agentId: string) {
  const run = app.personasim.retrievalRuns.listByAgent(agentId, 1)[0];
  if (run === undefined) throw new Error("Expected a RetrievalRun");
  return run;
}

function expectReplayExact(
  service: MemoryRecallService,
  app: PersonaSimApp,
  runId: string,
): void {
  const run = app.personasim.retrievalRuns.findById(runId);
  const input = app.personasim.retrievalRuns.getReplayInput(runId);
  if (run === undefined || input === undefined) {
    throw new Error("Expected frozen replay data");
  }
  expect(service.replay(input)).toEqual(run.result);
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
