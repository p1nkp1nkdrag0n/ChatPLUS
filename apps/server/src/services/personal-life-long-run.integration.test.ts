import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EventCard } from "@personasim/contracts";
import {
  activitySeed,
  calculateActivityCompletionProbability,
  seededUnit,
} from "@personasim/features";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase, type Database } from "../db/connection.js";
import type { DatabaseStore, StoredActivityEvent } from "../db/store.js";
import { scheduleItemSchema, type ScheduleItem } from "../domain/schemas.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";
import type { GenerateObjectInput, LlmService } from "./llm-service.js";

const START_UTC = "2026-03-07T21:00:00.000Z";
const SETTLEMENT_UTC = "2026-03-09T02:00:00.000Z";
const TIMEZONE = "America/New_York";
const SLEEP_ID = "schedule-long-run-dst-sleep";
const ADJUSTED_SLEEP_START_UTC = "2026-03-08T03:00:00.000Z";
const CLIENT_MESSAGE_ID = "long-run-riverside-intent";
const USER_TEXT = "I recently noticed the riverside night view is beautiful.";

type TimelineResponse = {
  events: Array<{
    id: string;
    type: string;
    scheduleItemId?: string;
    source?: string;
    sourceIntentId?: string;
    correlationId?: string;
    causationId?: string;
  }>;
  activityEvents: StoredActivityEvent[];
  scheduleItems: ScheduleItem[];
  domainEvents: Array<Record<string, unknown>>;
};

type PersistedMemory = {
  id: string;
  namespace?: string;
  sourceActivityEventIds: string[];
  temporalMetadata?: { temporalStatus?: string };
};

type DurableCounts = {
  personalIntents: number;
  selfInitiatedScheduleItems: number;
  activityEvents: number;
  eventCards: number;
  memories: number;
  memoryEvidence: number;
  proactiveCandidates: number;
  proactiveMessages: number;
};

const activeApps = new Set<PersonaSimApp>();
const temporaryDirectories: string[] = [];

describe("P0 personal-life long-run acceptance", () => {
  afterEach(async () => {
    for (const app of [...activeApps]) await closeTrackedApp(app);
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("survives a DST night, a 29-hour offline interval, and restarts without duplicating causal effects", async () => {
    const directory = mkdtempSync(join(tmpdir(), "personasim-long-run-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "long-run.sqlite");
    const clock = new FakeClock(START_UTC);

    const first = await openTrackedApp(databasePath, clock);
    mockLlm(first.personasim.llm, (input) => {
      if (input.purpose === "chat_turn") return intentTurnEnvelope();
      return fixtureFor(input);
    });
    const character = await createAndPublish(first);
    const sleepId = replaceGeneratedScheduleWithDstSleep(
      first.personasim.store,
      character.id,
    );
    const sessionId = await createSession(first, character.id);
    const seededSleep = requireScheduleItem(first.personasim.store, sleepId);
    expect(minutesBetween(seededSleep.startAtUtc, seededSleep.endAtUtc)).toBe(
      540,
    );
    expect(localIso(seededSleep.startAtUtc)).toContain(
      "2026-03-07T20:00:00.000-05:00",
    );
    expect(localIso(seededSleep.endAtUtc)).toContain(
      "2026-03-08T06:00:00.000-04:00",
    );

    const chat = await sendMessage(
      first,
      sessionId,
      character.id,
      CLIENT_MESSAGE_ID,
      USER_TEXT,
    );
    expect(chat.statusCode).toBe(201);
    const chatBody = jsonBody<ChatTurnResult>(chat);
    expect(chatBody.idempotentReplay).toBe(false);
    expect(chatBody.assistantMessage.content).not.toMatch(
      /scheduled|booked|put it on/i,
    );

    const intent = readOnlyIntent(first.personasim.store, character.id);
    expect(intent).toMatchObject({
      basisKind: "chat",
      activity: "Riverside night photography",
      category: "travel",
      desiredDurationMinutes: 120,
      status: "consumed",
      evidenceMessageIds: [chatBody.userMessage.id],
    });

    const plannedState = first.personasim.store.getRuntimeState(character.id);
    expect(plannedState?.sleepDebtMinutes).toBe(0);
    const sleep = requireScheduleItem(first.personasim.store, sleepId);
    expect(sleep).toMatchObject({
      startAtUtc: ADJUSTED_SLEEP_START_UTC,
      endAtUtc: "2026-03-08T10:00:00.000Z",
      plannedSleepReductionMinutes: 120,
      revision: 1,
    });
    expect(minutesBetween(sleep.startAtUtc, sleep.endAtUtc)).toBe(420);
    expect(localIso(sleep.startAtUtc)).toContain(
      "2026-03-07T22:00:00.000-05:00",
    );
    expect(localIso(sleep.endAtUtc)).toContain("2026-03-08T06:00:00.000-04:00");

    const originallyPlanned = onlySelfInitiatedItem(
      first.personasim.store,
      character.id,
    );
    expect(originallyPlanned).toMatchObject({
      title: "Riverside night photography",
      category: "travel",
      startAtUtc: "2026-03-08T01:00:00.000Z",
      endAtUtc: "2026-03-08T03:00:00.000Z",
      timezone: TIMEZONE,
      source: "self_initiated",
      sourceIntentId: intent.id,
    });
    expect(originallyPlanned.correlationId).toMatch(/^self_plan_/u);
    expect(originallyPlanned.causationId).toBe(originallyPlanned.correlationId);
    expect(originallyPlanned.stateEffects.energy).toBeLessThan(-0.12);
    expect(originallyPlanned.stateEffects.focus).toBeLessThan(0);

    const selfPlan = stabilizeCompletedBranch(
      first.personasim.store,
      originallyPlanned,
    );
    const countsBeforeRestart = durableCounts(
      first.personasim.store.database,
      character.id,
    );
    expect(countsBeforeRestart).toEqual({
      personalIntents: 1,
      selfInitiatedScheduleItems: 1,
      activityEvents: 0,
      eventCards: 0,
      memories: 0,
      memoryEvidence: 0,
      proactiveCandidates: 0,
      proactiveMessages: 0,
    });

    await closeTrackedApp(first);
    const restarted = await openTrackedApp(databasePath, clock);

    const replay = await sendMessage(
      restarted,
      sessionId,
      character.id,
      CLIENT_MESSAGE_ID,
      USER_TEXT,
    );
    expect(replay.statusCode).toBe(200);
    expect(jsonBody<ChatTurnResult>(replay).idempotentReplay).toBe(true);
    expect(
      durableCounts(restarted.personasim.store.database, character.id),
    ).toEqual(countsBeforeRestart);

    clock.advance({ hours: 29 });
    expect(clock.nowUtc()).toBe(SETTLEMENT_UTC);
    const activation = await restarted.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(activation.statusCode).toBe(200);
    const activationBody = jsonBody<{
      settlement: {
        fromUtc: string;
        toUtc: string;
        alreadySettled: boolean;
      };
      proactiveMessage?: {
        messageKind: string;
        triggerEventId?: string;
      };
      capabilities?: {
        proactiveDialogue: boolean;
      };
    }>(activation);
    expect(activationBody.settlement).toMatchObject({
      fromUtc: START_UTC,
      toUtc: SETTLEMENT_UTC,
      alreadySettled: false,
    });
    expect(
      minutesBetween(
        activationBody.settlement.fromUtc,
        activationBody.settlement.toUtc,
      ),
    ).toBe(29 * 60);

    const completed = restarted.personasim.store
      .listActivityEvents(character.id, 100)
      .find(
        (event) =>
          event.scheduleItemId === selfPlan.id &&
          event.eventType === "completed",
      );
    expect(completed).toBeDefined();
    if (completed === undefined) {
      throw new Error("Missing the completed self-initiated activity.");
    }
    expect(completed?.stateDelta.energy).toBe(selfPlan.stateEffects.energy);
    expect(activationBody.capabilities?.proactiveDialogue).toBe(false);
    expect(activationBody.proactiveMessage).toBeUndefined();
    expect(
      restarted.personasim.store.getRuntimeState(character.id)
        ?.sleepDebtMinutes,
    ).toBe(120);
    const sleepOutcome = restarted.personasim.store
      .listActivityEvents(character.id, 100)
      .find(
        (event) =>
          event.scheduleItemId === sleep.id && event.eventType === "completed",
      );
    expect(sleepOutcome?.effectTrace).toMatchObject({
      sleepDebt: {
        debtBefore: 0,
        plannedReductionMinutes: 120,
        missedScheduledMinutes: 0,
        recoveryMinutes: 0,
        debtAfter: 120,
      },
    });

    const memory = readActivityMemory(
      restarted.personasim.store.database,
      completed?.id ?? "missing-event",
    );
    expect(memory.record).toMatchObject({
      namespace: "runtime_simulation",
      sourceActivityEventIds: [completed?.id],
      temporalMetadata: { temporalStatus: "occurred" },
    });

    const activityCard = readActivityEventCard(
      restarted.personasim.store.database,
      completed.id,
    );
    expect(activityCard.sourceKind).toBe("activity_event");
    expect(activityCard.sourceId).toBe(completed.id);
    expect(activityCard.createdAtUtc).toBe(completed.occurredAtUtc);
    expect(activityCard.updatedAtUtc).toBe(completed.occurredAtUtc);
    expect(
      activityCard.evidence.some(
        (evidence) =>
          evidence.sourceType === "activity_event" &&
          evidence.sourceId === completed.id &&
          evidence.reliability === "fact",
      ),
    ).toBe(true);
    expect(
      readIndexedCards(restarted.personasim.store.database).filter(
        (card) => card.sourceKind === "activity_event",
      ),
    ).toHaveLength(
      restarted.personasim.store.listActivityEvents(character.id, 100).length,
    );

    const recallQuery = "Completed Riverside night photography";
    const probe = restarted.personasim.memoryRecalls.preview({
      agentId: character.id,
      query: recallQuery,
      nowUtc: clock.nowUtc(),
      timezone: TIMEZONE,
    });
    expect(probe.result).toMatchObject({
      mode: "event_card",
      abstained: false,
    });
    const probeRun = latestRetrievalRun(restarted, character.id);
    expect(probeRun.result).toEqual(probe.result);

    mockLlm(restarted.personasim.llm, (input) => {
      if (input.purpose === "chat_turn") return recallTurnEnvelope();
      return fixtureFor(input);
    });
    const recall = await sendMessage(
      restarted,
      sessionId,
      character.id,
      "long-run-recall",
      recallQuery,
    );
    expect(recall.statusCode).toBe(201);
    const recallBody = jsonBody<ChatTurnResult>(recall);
    expect(recallBody.memoryRecall).toMatchObject({
      rolloutMode: "enforced",
      promptStrategy: "evidence_selected",
      recallMode: "event_card",
      abstained: false,
    });

    const sameTimestampRuns = restarted.personasim.retrievalRuns.listByAgent(
      character.id,
      2,
    );
    const chatRun = sameTimestampRuns[0];
    if (chatRun === undefined)
      throw new Error("Missing the chat RetrievalRun.");
    expect(sameTimestampRuns[1]?.id).toBe(probeRun.id);
    expect(chatRun.id).not.toBe(probeRun.id);
    expect(chatRun.createdAtUtc).toBe(SETTLEMENT_UTC);
    expect(probeRun.createdAtUtc).toBe(SETTLEMENT_UTC);
    expect(chatRun.inputSnapshot.hierarchy).toMatchObject({
      finalTier: "event_card",
    });
    if (chatRun.result.abstained) {
      throw new Error("Expected strict EventCard recall evidence.");
    }
    expect(chatRun.result.mode).toBe("event_card");
    expect(chatRun.result.selectedMemoryIds).toContain(activityCard.id);
    const selectedActivityEvidence =
      chatRun.result.evidenceBundle.evidence.find(
        (item) => item.evidence.sourceId === completed.id,
      );
    expect(selectedActivityEvidence?.evidence.sourceType).toBe(
      "activity_event",
    );
    expect(recallBody.memoryRecall?.selectedMemoryIds).toEqual(
      chatRun.result.selectedMemoryIds,
    );
    expect(recallBody.memoryRecall?.selectedEvidenceIds).toEqual(
      chatRun.result.selectedEvidenceIds,
    );
    const replayInput = restarted.personasim.retrievalRuns.getReplayInput(
      chatRun.id,
    );
    if (replayInput === undefined) {
      throw new Error("Missing frozen RetrievalRun input.");
    }
    expect(restarted.personasim.memoryRecalls.replay(replayInput)).toEqual(
      chatRun.result,
    );

    const timelineResponse = await restarted.inject({
      method: "GET",
      url: `/api/agents/${character.id}/timeline?limit=100`,
    });
    expect(timelineResponse.statusCode).toBe(200);
    const timeline = jsonBody<TimelineResponse>(timelineResponse);
    expect(
      timeline.events.find((event) => event.id === completed?.id),
    ).toMatchObject({
      type: "completed",
      scheduleItemId: selfPlan.id,
      source: "self_initiated",
      sourceIntentId: intent.id,
      correlationId: selfPlan.correlationId,
      causationId: selfPlan.causationId,
    });
    const domainEventTypes = timeline.domainEvents.map(
      (event) => event["eventType"],
    );
    expect(domainEventTypes).toEqual(
      expect.arrayContaining([
        "conversation.turn_committed",
        "personal_intent.created",
        "personal_intent.consumed",
        "self_plan.committed",
        "simulation.settled",
      ]),
    );
    expect(domainEventTypes).not.toContain("proactive.claimed");
    expect(domainEventTypes).not.toContain(
      "conversation.proactive_message_sent",
    );

    const firstRebuild = restarted.personasim.continuityIndex.rebuildAgent(
      character.id,
    );
    const stableCards = readIndexedCards(restarted.personasim.store.database);
    expect(stableCards.find((card) => card.sourceId === completed.id)).toEqual(
      activityCard,
    );
    const stableRanking = restarted.personasim.continuityIndex
      .searchEventCards({
        agentId: character.id,
        query: recallQuery,
        limit: 100,
      })
      .map((card) => card.id);

    clock.advance({ days: 30 });
    const secondRebuild = restarted.personasim.continuityIndex.rebuildAgent(
      character.id,
    );
    expect(secondRebuild.eventCardCount).toBe(firstRebuild.eventCardCount);
    expect(readIndexedCards(restarted.personasim.store.database)).toEqual(
      stableCards,
    );
    expect(
      restarted.personasim.continuityIndex
        .searchEventCards({
          agentId: character.id,
          query: recallQuery,
          limit: 100,
        })
        .map((card) => card.id),
    ).toEqual(stableRanking);
    clock.setUtc(SETTLEMENT_UTC);

    const remainingSpecIntents = restarted.personasim.store.database
      .prepare(
        `SELECT id, basis_kind AS basisKind
         FROM personal_intentions
         WHERE agent_id = ? AND status IN ('pending', 'planned')
         ORDER BY id`,
      )
      .all(character.id) as Array<{ id: string; basisKind: string }>;
    // The default fixture preference describes decision style rather than an
    // executable activity, so only the goal and routine produce spec intents.
    // Activation and the recall turn have already consumed both of them.
    expect(remainingSpecIntents).toEqual([]);
    const selfInitiatedIdsBeforeDrain = new Set(
      restarted.personasim.store
        .listSchedule(character.id)
        .filter((item) => item.source === "self_initiated")
        .map((item) => item.id),
    );
    const drainedActivation = await restarted.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(drainedActivation.statusCode).toBe(200);
    expect(
      jsonBody<{ settlement: { alreadySettled: boolean } }>(drainedActivation)
        .settlement.alreadySettled,
    ).toBe(true);
    const drainedSelfPlans = restarted.personasim.store
      .listSchedule(character.id)
      .filter(
        (item) =>
          item.source === "self_initiated" &&
          !selfInitiatedIdsBeforeDrain.has(item.id),
      );
    expect(drainedSelfPlans).toEqual([]);

    const countsAfterSettlement = durableCounts(
      restarted.personasim.store.database,
      character.id,
    );
    expect(countsAfterSettlement).toMatchObject({
      personalIntents: 3,
      selfInitiatedScheduleItems: 3,
      proactiveCandidates: 0,
      proactiveMessages: 0,
    });
    expect(
      countWhere(
        restarted.personasim.store.database,
        "llm_calls",
        "agent_id = ? AND purpose = 'compose_proactive_message'",
        character.id,
      ),
    ).toBe(0);
    expect(countsAfterSettlement.activityEvents).toBeGreaterThan(0);
    expect(countsAfterSettlement.eventCards).toBeGreaterThan(0);
    expect(countsAfterSettlement.memories).toBeGreaterThan(0);
    expect(countsAfterSettlement.memoryEvidence).toBeGreaterThan(0);

    await closeTrackedApp(restarted);
    const restartedAgain = await openTrackedApp(databasePath, clock);
    const repeatedActivation = await restartedAgain.inject({
      method: "POST",
      url: `/api/agents/${character.id}/activate`,
    });
    expect(repeatedActivation.statusCode).toBe(200);
    expect(
      jsonBody<{ settlement: { alreadySettled: boolean } }>(repeatedActivation)
        .settlement.alreadySettled,
    ).toBe(true);
    expect(
      jsonBody<{ proactiveMessage?: unknown }>(repeatedActivation),
    ).not.toHaveProperty("proactiveMessage");
    expect(
      durableCounts(restartedAgain.personasim.store.database, character.id),
    ).toEqual(countsAfterSettlement);
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
    lifePlanningMode: "legacy_exact",
    scheduleNegotiationMode: "legacy",
    selfInitiatedPlanningMode: "enforced",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "enforced",
    autobiographyMode: "off",
    llm: {
      provider: "openai-compatible",
      baseUrl: "https://example.invalid",
      apiKey: "long-run-test-key",
      model: "long-run-test-model",
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

function mockLlm(
  llm: LlmService,
  responder: (input: GenerateObjectInput<unknown>) => unknown,
): void {
  vi.spyOn(llm, "generateObject").mockImplementation((input) =>
    Promise.resolve(responder(input)),
  );
}

function fixtureFor(input: GenerateObjectInput<unknown>): unknown {
  if (input.fixture !== undefined) return input.fixture;
  throw new Error(`No fixture for ${input.purpose}`);
}

function intentTurnEnvelope(): unknown {
  return {
    replyDecision: {
      text: "That view sounds worth exploring sometime.",
      toneTags: ["curious"],
      deliveryMode: "single_block",
    },
    worldEffects: {
      personalIntentCandidates: [
        {
          activity: "Riverside night photography",
          category: "travel",
          durationHint: "120 minutes",
          timingHint: "tonight",
          basisKind: "chat",
          evidenceQuotes: ["the riverside night view is beautiful"],
          reasonCode: "chat_grounded_interest",
          reasonSummary: "The user's observation inspired a possible outing.",
        },
      ],
    },
  };
}

function recallTurnEnvelope(): unknown {
  return {
    replyDecision: {
      text: "I remember the riverside photography outing.",
      toneTags: ["reflective"],
      deliveryMode: "single_block",
    },
    worldEffects: {},
  };
}

async function createAndPublish(
  app: PersonaSimApp,
): Promise<{ id: string; version: number }> {
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "Long Run Photographer",
      worldSetting: "A contemporary riverside city",
      workOrRole: "Independent illustrator",
      coreTraits: ["Curious", "Disciplined", "Warm"],
      coreContradiction: "Values routine but sometimes explores at night",
      mainGoal: "Complete a visual portfolio",
      initialRelationship: "Close friend",
      dialogueStyle: "Natural, concise, and observant",
      tier: "high_fidelity",
      timezone: TIMEZONE,
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

function replaceGeneratedScheduleWithDstSleep(
  store: DatabaseStore,
  agentId: string,
): string {
  store.database
    .prepare("DELETE FROM schedule_items WHERE agent_id = ?")
    .run(agentId);
  let suffix = 0;
  let sleep = scheduleItemSchema.parse({
    id: SLEEP_ID,
    agentId,
    title: "DST transition sleep",
    description: "Sleep spanning the spring-forward transition.",
    category: "sleep",
    startAtUtc: "2026-03-08T01:00:00.000Z",
    endAtUtc: "2026-03-08T10:00:00.000Z",
    timezone: TIMEZONE,
    status: "planned",
    rigidity: "fixed",
    priority: 1,
    source: "initial_plan",
    adherenceProbability: 1,
    narrativeImportance: 0.2,
    shareable: false,
    stateEffects: { energy: 0.25, stress: -0.08 },
    revision: 0,
    createdAtUtc: START_UTC,
    updatedAtUtc: START_UTC,
  });
  // Fixed items have at least 0.9 completion probability; select an ID whose
  // final adjusted start produces a roll below that floor so this acceptance
  // test always exercises sleep-debt repayment rather than a valid skip.
  while (
    seededUnit(
      activitySeed(agentId, {
        ...sleep,
        startAtUtc: ADJUSTED_SLEEP_START_UTC,
      }),
    ) >= 0.9
  ) {
    suffix += 1;
    sleep = scheduleItemSchema.parse({
      ...sleep,
      id: `${SLEEP_ID}-${suffix}`,
    });
  }
  store.insertScheduleItem(sleep);
  return sleep.id;
}

async function createSession(
  app: PersonaSimApp,
  agentId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/sessions`,
    payload: { title: "Long-run DST acceptance" },
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
    url: `/api/sessions/${sessionId}/messages`,
    payload: { agentId, clientMessageId, text },
  });
}

function readOnlyIntent(
  store: DatabaseStore,
  agentId: string,
): Record<string, unknown> {
  const rows = store.database
    .prepare(
      "SELECT record_json FROM personal_intentions WHERE agent_id = ? ORDER BY created_at_utc, rowid",
    )
    .all(agentId) as Array<{ record_json: string }>;
  expect(rows).toHaveLength(1);
  return JSON.parse(rows[0]!.record_json) as Record<string, unknown>;
}

function requireScheduleItem(
  store: DatabaseStore,
  scheduleItemId: string,
): ScheduleItem {
  const item = store.getScheduleItem(scheduleItemId);
  if (!item) throw new Error(`Missing schedule item ${scheduleItemId}`);
  return item;
}

function onlySelfInitiatedItem(
  store: DatabaseStore,
  agentId: string,
): ScheduleItem {
  const items = store
    .listSchedule(agentId)
    .filter((item) => item.source === "self_initiated");
  expect(items).toHaveLength(1);
  return items[0]!;
}

function stabilizeCompletedBranch(
  store: DatabaseStore,
  item: ScheduleItem,
): ScheduleItem {
  const spec = store.getCharacterSpec(item.agentId);
  const state = store.getRuntimeState(item.agentId);
  if (!spec || !state) throw new Error("Missing settlement fixture state");
  const probability = calculateActivityCompletionProbability({
    adherenceProbability: 1,
    routineAdherence: spec.schedulePolicy.routineAdherence,
    rigidity: item.rigidity,
    energy: state.energy,
    stress: state.stress,
  });
  let suffix = 0;
  let candidate = scheduleItemSchema.parse({
    ...item,
    id: `schedule-long-run-self-${suffix}`,
    adherenceProbability: 1,
  });
  while (seededUnit(activitySeed(item.agentId, candidate)) >= probability) {
    suffix += 1;
    candidate = scheduleItemSchema.parse({
      ...candidate,
      id: `schedule-long-run-self-${suffix}`,
    });
  }

  // Settlement intentionally models imperfect adherence. Before the item has
  // any dependent events, re-key this test fixture to a deterministic completed
  // branch so the acceptance assertions exercise occurred-memory continuity
  // while proactive delivery remains product-disabled.
  store.transaction(() => {
    store.database
      .prepare("DELETE FROM schedule_items WHERE id = ?")
      .run(item.id);
    store.insertScheduleItem(candidate);
  });
  return candidate;
}

function latestRetrievalRun(app: PersonaSimApp, agentId: string) {
  const run = app.personasim.retrievalRuns.listByAgent(agentId, 1)[0];
  if (run === undefined) throw new Error("Missing the latest RetrievalRun.");
  return run;
}

function readActivityEventCard(
  database: Database,
  activityEventId: string,
): EventCard {
  const row = database
    .prepare(
      "SELECT card_json FROM event_cards WHERE source_kind = 'activity_event' AND source_id = ?",
    )
    .get(activityEventId) as { card_json: string } | undefined;
  if (row === undefined) {
    throw new Error("Missing the incrementally indexed ActivityEvent card.");
  }
  return JSON.parse(row.card_json) as EventCard;
}

function readIndexedCards(database: Database): EventCard[] {
  return (
    database
      .prepare("SELECT card_json FROM event_cards ORDER BY dedupe_key")
      .all() as Array<{ card_json: string }>
  ).map((row) => JSON.parse(row.card_json) as EventCard);
}

function readActivityMemory(
  database: Database,
  activityEventId: string,
): { record: PersistedMemory; evidenceId: string } {
  const row = database
    .prepare(
      `SELECT m.memory_json AS memoryJson, e.id AS evidenceId
       FROM memories m
       JOIN memory_evidence e ON e.memory_id = m.id
       WHERE e.source_type = 'activity_event' AND e.source_id = ?
       ORDER BY m.created_at_utc, e.id LIMIT 1`,
    )
    .get(activityEventId) as
    { memoryJson: string; evidenceId: string } | undefined;
  if (!row) throw new Error("Missing evidence-backed activity memory");
  return {
    record: JSON.parse(row.memoryJson) as PersistedMemory,
    evidenceId: row.evidenceId,
  };
}

function durableCounts(database: Database, agentId: string): DurableCounts {
  return {
    personalIntents: countWhere(
      database,
      "personal_intentions",
      "agent_id = ?",
      agentId,
    ),
    selfInitiatedScheduleItems: countWhere(
      database,
      "schedule_items",
      "agent_id = ? AND source = 'self_initiated'",
      agentId,
    ),
    activityEvents: countWhere(
      database,
      "activity_events",
      "agent_id = ?",
      agentId,
    ),
    eventCards: countWhere(database, "event_cards", "agent_id = ?", agentId),
    memories: countWhere(database, "memories", "agent_id = ?", agentId),
    memoryEvidence: countWhere(
      database,
      "memory_evidence",
      "memory_id IN (SELECT id FROM memories WHERE agent_id = ?)",
      agentId,
    ),
    proactiveCandidates: countWhere(
      database,
      "proactive_candidates",
      "agent_id = ?",
      agentId,
    ),
    proactiveMessages: countWhere(
      database,
      "messages",
      "agent_id = ? AND message_kind = 'assistant_proactive'",
      agentId,
    ),
  };
}

function countWhere(
  database: Database,
  table: string,
  where: string,
  parameter: string,
): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .get(parameter) as { count: number };
  return Number(row.count);
}

function minutesBetween(startAtUtc: string, endAtUtc: string): number {
  return (Date.parse(endAtUtc) - Date.parse(startAtUtc)) / 60_000;
}

function localIso(utc: string): string {
  return DateTime.fromISO(utc, { zone: "utc" }).setZone(TIMEZONE).toISO() ?? "";
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
