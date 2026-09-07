import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EventCardSchema,
  MemoryCandidateSchema,
  MemoryEvidenceSchema,
  MemorySchema,
  SendMessageResponseSchema,
  type EventCard,
  type MemoryCandidate,
  type Memory,
} from "@personasim/contracts";
import { resolveTemporalQuery } from "@personasim/features";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { ContinuityRepository } from "./continuity-repository.js";
import { temporalAnchorsFromEventCards } from "./continuity-index-service.js";
import type { MemoryRecallService } from "./memory-recall-service.js";
import { validateMergeAndPersistMemories } from "./memory-service.js";
import { ScheduleNegotiationService } from "./schedule-negotiation-service.js";

const SHANGHAI_NOW = "2026-08-21T04:00:00.000Z";
const EXPLICIT_FACT_SOURCE_AT = "2026-09-04T10:00:00.000Z";
const EXPLICIT_FACT_RECALL_AT = "2026-10-12T10:00:00.000Z";
const EXPLICIT_FACT_QUERY =
  "周末去暗房前，替我核对两件旧事：我喝茶的习惯，和那只铁盒的标签。只答事实，不解释它们象征什么。";
const EXPLICIT_FACT_SOURCE_TEXT =
  "行。我先把下周要带的东西说清楚：底片装在钴蓝色铁盒里，盖子上写着“1998/潮声”。暗房那边如果要点喝的，我喝红茶不加糖，别替我点甜的。";
const TEA_FACT = "用户喝不加糖的红茶，不喜欢被替点甜的。";
const BOX_FACT =
  "用户下周带来底片，装在钴蓝色铁盒里，盖子上写着“1998 / 潮声”。";
const EXPLICIT_FACT_REPLY = "饮品记录：红茶（不加糖）；铁盒标签：1998 / 潮声。";
const EXPLICIT_FACT_REFUSAL = "现有可靠事实不足以完整核对这两项。";
const ADVERSARIAL_EXPLICIT_FACT_REPLY =
  "你喝不加糖的红茶。\n铁盒标签稍后再说。";
const ADVERSARIAL_PARTIAL_FACT_REPLY = "你喝不加糖的红茶；木盒标签我不知道。";

type StoredEvidenceRow = {
  id: string;
  memoryId: string;
  sourceType: string;
  sourceId: string;
  quote: string | null;
  contextSummary: string | null;
  recordedAtUtc: string;
  evidenceJson: string;
};

describe("continuity memory recall hierarchy", () => {
  let app: PersonaSimApp | undefined;
  let temporaryDirectory: string | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
    if (temporaryDirectory !== undefined) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
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
      insertUserMessage(harness.app, {
        id: messageId,
        sessionId,
        agentId: harness.agentId,
        content,
        createdAtUtc: `2026-08-20T0${index + 1}:00:00.000Z`,
      });
      cards.push(
        sharedEventCard(app, {
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
      requireDurableEvidence: true,
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

  it("fails closed when a persisted EventCard points to a missing evidence source", async () => {
    const harness = await createHarness({
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const sourceSession = app.personasim.conversations.createSession(
      harness.agentId,
      "Original EventCard evidence",
    );
    insertUserMessage(app, {
      id: "message-original-source",
      sessionId: sourceSession.id,
      agentId: harness.agentId,
      content: "The missing-source lantern walk was a shared experience.",
      createdAtUtc: "2026-08-20T01:00:00.000Z",
    });
    const card = sharedEventCard(app, {
      id: "event-card-missing-source",
      agentId: harness.agentId,
      messageId: "message-original-source",
      title: "Missing-source lantern walk",
      summary: "The missing-source lantern walk was a shared experience.",
      occurredAtUtc: "2026-08-20T01:00:00.000Z",
    });
    const continuity = new ContinuityRepository(app.personasim.store);
    expect(continuity.upsertEventCards([card])).toBe(1);
    // Simulate a preexisting corrupt projection after a valid write. New writes
    // reject missing sources; recall must also distrust corrupt stored evidence.
    const corruptCard = EventCardSchema.parse({
      ...card,
      evidence: card.evidence.map((evidence) => ({
        ...evidence,
        sourceId: "message-missing-source",
      })),
    });
    app.personasim.store.database
      .prepare(
        "UPDATE event_cards SET evidence_json = ?, card_json = ? WHERE id = ?",
      )
      .run(
        JSON.stringify(corruptCard.evidence),
        JSON.stringify(corruptCard),
        card.id,
      );
    expect(
      continuity.searchEventCards({
        agentId: harness.agentId,
        query: "missing-source lantern walk",
      }),
    ).toEqual([expect.objectContaining({ id: card.id })]);

    const preview = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: "missing-source lantern walk",
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });

    expect(preview.result).toMatchObject({
      mode: "none",
      abstained: true,
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    expect(
      latestRun(app, harness.agentId).inputSnapshot.hierarchy,
    ).toMatchObject({ finalTier: "none" });
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

  it("does not let a newer generic Verbatim hit mask an exact rare-code basic memory", async () => {
    const harness = await createHarness({
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const sessionId = app.personasim.conversations.createSession(
      harness.agentId,
      "Rare code recall",
    ).id;
    insertUserMessage(app, {
      id: "message-generic-bookstore-plan",
      sessionId,
      agentId: harness.agentId,
      content: "我们刚确认的共同安排是在北岸书店喝茶，之后再一起讨论细节。",
      createdAtUtc: "2026-08-21T03:30:00.000Z",
    });

    const sourceId = "source-rare-code-fact";
    const memoryContent =
      "重要演讲仪式的代号 BGW-7419 对应蓝色玻璃鲸，并放在左口袋。";
    app.personasim.store.insertCharacterSource({
      id: sourceId,
      characterId: harness.agentId,
      sourceType: "test_fixture",
      title: "Rare code fact",
      contentExcerpt: memoryContent,
      sourceHash: "hash-rare-code-fact",
      createdAtUtc: "2026-08-20T08:00:00.000Z",
    });
    const [basicMemory] = validateMergeAndPersistMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        MemoryCandidateSchema.parse({
          kind: "episodic",
          content: memoryContent,
          importance: 0.2,
          confidence: 1,
          tags: ["BGW-7419", "演讲仪式"],
          sourceMessageIds: [],
          sourceActivityEventIds: [],
          origin: "runtime_simulation",
          namespace: "character_self",
          certainty: "inferred",
          attribution: "model_inference",
          stability: "stable",
          evidence: [
            {
              sourceType: "character_source",
              sourceId,
              contextSummary: memoryContent,
              recordedAtUtc: "2026-08-20T08:00:00.000Z",
            },
          ],
          reasonCode: "character_source",
          reasonSummary: "Grounded by the character source fixture.",
        }),
      ],
      nowUtc: "2026-08-20T08:00:00.000Z",
      maxCandidates: 1,
    });
    if (basicMemory === undefined) {
      throw new Error("Expected the rare-code basic memory to persist");
    }

    const preview = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query:
        "请告诉我 BGW-7419 是什么、演讲前放在哪里？另外，我们刚确认的共同安排是什么？",
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });

    expect(preview.result).toMatchObject({
      mode: "basic_memory",
      abstained: false,
      selectedMemoryIds: [basicMemory.id],
    });
    if (preview.result.abstained) {
      throw new Error("Expected exact rare-code recall");
    }
    expect(preview.result.evidenceBundle.evidence[0]).toMatchObject({
      memoryId: basicMemory.id,
      evidence: {
        sourceType: "character_source",
        sourceId,
      },
    });
    expect(
      preview.result.evidenceBundle.evidence[0]?.score,
    ).toBeGreaterThanOrEqual(0.42);

    const run = latestRun(app, harness.agentId);
    expect(run.inputSnapshot.hierarchy?.finalTier).toBe("basic_memory");
    expect(run.inputSnapshot.hierarchy?.candidateTiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tier: "verbatim_quote" }),
        expect.objectContaining({
          memoryId: basicMemory.id,
          tier: "basic_memory",
        }),
      ]),
    );
    expectReplayExact(app.personasim.memoryRecalls, app, run.id);
  });

  it("recalls every explicitly requested fact after 38 days and a restart, but never returns a partial checklist", async () => {
    temporaryDirectory = mkdtempSync(
      join(tmpdir(), "chatplus-explicit-fact-recall-"),
    );
    const databasePath = join(temporaryDirectory, "instance.sqlite");
    const harness = await createHarness({
      nowUtc: EXPLICIT_FACT_SOURCE_AT,
      timezone: "Asia/Shanghai",
      databasePath,
      explicitFactReplies: true,
    });
    app = harness.app;
    const sourceSession = app.personasim.conversations.createSession(
      harness.agentId,
      "Explicit fact sources",
    );
    const sharedSourceMessageId = "message-explicit-fact-source";
    insertUserMessage(app, {
      id: sharedSourceMessageId,
      sessionId: sourceSession.id,
      agentId: harness.agentId,
      content: EXPLICIT_FACT_SOURCE_TEXT,
      createdAtUtc: EXPLICIT_FACT_SOURCE_AT,
    });
    const targets = seedLegacyRecallFixtureMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        MemoryCandidateSchema.parse({
          ...explicitUserFact(
            BOX_FACT,
            ["user fact", "底片", "潮痕", "下周约定"],
            0.6,
            EXPLICIT_FACT_SOURCE_AT,
          ),
          evidence: [
            {
              sourceType: "message",
              sourceId: sharedSourceMessageId,
              quote: "盖子上写着“1998/潮声”",
            },
          ],
        }),
        MemoryCandidateSchema.parse({
          ...explicitUserFact(
            TEA_FACT,
            ["user preference", "饮品", "偏好"],
            0.4,
            EXPLICIT_FACT_SOURCE_AT,
          ),
          evidence: [
            {
              sourceType: "message",
              sourceId: sharedSourceMessageId,
              quote: "我喝红茶不加糖",
            },
          ],
        }),
      ],
      nowUtc: EXPLICIT_FACT_SOURCE_AT,
      maxCandidates: 4,
      authoritativeMessageId: sharedSourceMessageId,
    });
    const boxMemory = targets.find((memory) => memory.content === BOX_FACT);
    const teaMemory = targets.find((memory) => memory.content === TEA_FACT);
    expect(boxMemory?.claim).toBeUndefined();
    expect(teaMemory?.claim).toBeUndefined();
    if (boxMemory === undefined || teaMemory === undefined) {
      throw new Error("Expected both explicit fact memories to persist");
    }

    const boundarySourceMessageId = "message-explicit-fact-boundary";
    insertUserMessage(app, {
      id: boundarySourceMessageId,
      sessionId: sourceSession.id,
      agentId: harness.agentId,
      content:
        "还有，别把我不爱甜茶写成什么人格象征。我只是喝不加糖的红茶，这个事实到这里就够了。",
      createdAtUtc: "2026-10-11T08:00:00.000Z",
    });
    const [boundaryMemory] = seedLegacyRecallFixtureMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        explicitUserFact(
          "用户明确要求：'喝不加糖的红茶'只是事实记录，不要解读为人格象征或引申分析。",
          ["user preference", "用户偏好", "边界", "记录方式"],
          0.95,
          "2026-10-11T08:00:00.000Z",
        ),
      ],
      nowUtc: "2026-10-11T08:00:00.000Z",
      maxCandidates: 2,
      authoritativeMessageId: boundarySourceMessageId,
    });
    if (boundaryMemory === undefined) {
      throw new Error("Expected the boundary decoy to persist");
    }

    const contextSourceMessageId = "message-explicit-fact-context-decoy";
    insertUserMessage(app, {
      id: contextSourceMessageId,
      sessionId: sourceSession.id,
      agentId: harness.agentId,
      content: "我周末去暗房前会核对灯具清单，只记录事实。",
      createdAtUtc: "2026-10-11T09:00:00.000Z",
    });
    const [contextMemory] = seedLegacyRecallFixtureMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        explicitUserFact(
          "用户周末去暗房前会核对灯具清单，只记录事实。",
          ["user fact", "周末", "暗房", "核对"],
          1,
          "2026-10-11T09:00:00.000Z",
        ),
      ],
      nowUtc: "2026-10-11T09:00:00.000Z",
      maxCandidates: 2,
      authoritativeMessageId: contextSourceMessageId,
    });
    if (contextMemory === undefined) {
      throw new Error("Expected the context decoy to persist");
    }
    const queryEchoSourceId = "message-explicit-fact-query-echo";
    insertUserMessage(app, {
      id: queryEchoSourceId,
      sessionId: sourceSession.id,
      agentId: harness.agentId,
      content: EXPLICIT_FACT_QUERY,
      createdAtUtc: "2026-10-11T09:30:00.000Z",
    });
    const [queryEchoMemory] = seedLegacyRecallFixtureMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        explicitUserFact(
          EXPLICIT_FACT_QUERY,
          ["user fact", "核对", "暗房"],
          1,
          "2026-10-11T09:30:00.000Z",
          "user_fact:query_echo_decoy",
        ),
      ],
      nowUtc: "2026-10-11T09:30:00.000Z",
      maxCandidates: 2,
      authoritativeMessageId: queryEchoSourceId,
    });
    if (queryEchoMemory === undefined) {
      throw new Error("Expected the query-echo decoy to persist");
    }
    expect(
      new ContinuityRepository(app.personasim.store).upsertEventCards([
        sharedEventCard(app, {
          id: "event-card-explicit-fact-context-decoy",
          agentId: harness.agentId,
          messageId: contextSourceMessageId,
          title: "周末暗房核对",
          summary: "用户周末去暗房前会核对灯具清单，只记录事实。",
          occurredAtUtc: "2026-10-11T09:00:00.000Z",
        }),
      ]),
    ).toBe(1);
    expect(
      Date.parse(EXPLICIT_FACT_RECALL_AT) - Date.parse(EXPLICIT_FACT_SOURCE_AT),
    ).toBeGreaterThan(30 * 24 * 60 * 60 * 1_000);
    await app.close();
    app = undefined;
    app = await openHarnessApp({
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      databasePath,
      adversarialOpenAiCompatibleDecisionPath: true,
    });
    expect(app.personasim.llm.providerName).toBe("openai-compatible");
    const publish = vi.spyOn(app.personasim.sse, "publish");
    await app.personasim.settlements.settleAndExtend(harness.agentId);
    const recallSession = app.personasim.conversations.createSession(
      harness.agentId,
      "Explicit fact recall after restart",
    );
    const careCue = app.personasim.followUps.createCareCue({
      agentId: harness.agentId,
      sourceMessageId: sharedSourceMessageId,
      timezone: "Asia/Shanghai",
      ttlDays: 30,
      maxMentions: 1,
      candidate: {
        contextSummary: "用户准备核对铁盒标签 1998 潮声。",
        mentionGuidance: "只在铁盒标签话题中提起。",
        evidenceQuotes: ["盖子上写着“1998/潮声”"],
        reasonCode: "explicit_fact_context",
        reasonSummary: "铁盒标签话题可在相关对话中自然提起。",
      },
    });
    expect(careCue).toMatchObject({
      accepted: true,
      careCue: { status: "active", mentionCount: 0, maxMentions: 1 },
    });
    if (!careCue.accepted) throw new Error("Expected an accepted care cue");
    expect(
      app.personasim.followUps.selectCareCues({
        agentId: harness.agentId,
        userText: EXPLICIT_FACT_QUERY,
      }),
    ).toEqual([
      expect.objectContaining({ id: careCue.careCue.id, mentionCount: 0 }),
    ]);
    const beforeGuardState = app.personasim.store.getRuntimeState(
      harness.agentId,
    );
    const beforeGuardWrites = explicitFactSideEffectSnapshot(
      app,
      harness.agentId,
    );
    const requestPayload = {
      agentId: harness.agentId,
      clientMessageId: "explicit-fact-recall-after-restart",
      text: EXPLICIT_FACT_QUERY,
    };
    const modelCallCountBeforeGuard = vi.mocked(app.personasim.llm)
      .generateObject.mock.calls.length;
    publish.mockClear();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${recallSession.id}/messages`,
      payload: requestPayload,
    });
    expect(response.statusCode).toBe(201);
    const exchange = SendMessageResponseSchema.parse(JSON.parse(response.body));
    expect(exchange.memoryRecall).toMatchObject({
      rolloutMode: "enforced",
      recallMode: "basic_memory",
      abstained: false,
    });
    expect(new Set(exchange.memoryRecall?.selectedMemoryIds)).toEqual(
      new Set([boxMemory.id, teaMemory.id]),
    );
    expect(new Set(exchange.memoryRecall?.promptMemoryIds)).toEqual(
      new Set([boxMemory.id, teaMemory.id]),
    );
    expect(exchange.assistantMessage.content).toBe(EXPLICIT_FACT_REPLY);
    expect(exchange.assistantMessage.content).not.toMatch(
      /(?:人格|性格|象征|引申|意味着)/u,
    );
    expect(exchange.assistantMessage.content).not.toContain("稍后再说");
    expect(exchange.assistantMessage.metadata).toMatchObject({
      chunks: [EXPLICIT_FACT_REPLY],
      deliveryMode: "single_block",
      reasonCode: "explicit_fact_reply_guard_selected",
      decisionPath: "effects_rejected",
      explicitFactReplyGuard: {
        policyVersion: "explicit_fact_checklist_v1",
        outcome: "selected",
        reasonCode: "explicit_fact_reply_guard_selected",
        expectedFacetCount: 2,
        serverGuardApplied: true,
        modelReplyContentChanged: true,
        modelSideEffectsBlocked: true,
        modelRepairAttempted: false,
        modelGenerationFallbackUsed: false,
        contentDerivedSemanticsSkipped: true,
      },
      continuityPromptCueIds: [careCue.careCue.id],
    });
    const guardMetadata = exchange.assistantMessage.metadata[
      "explicitFactReplyGuard"
    ] as {
      selectedMemoryIds: string[];
      selectedEvidenceIds: string[];
      finalTextSha256: string;
    };
    expect(new Set(guardMetadata.selectedMemoryIds)).toEqual(
      new Set([boxMemory.id, teaMemory.id]),
    );
    expect(guardMetadata.selectedEvidenceIds).toHaveLength(2);
    expect(guardMetadata.finalTextSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(guardMetadata.finalTextSha256).toBe(
      createHash("sha256")
        .update(exchange.assistantMessage.content, "utf8")
        .digest("hex"),
    );
    const turnAudit = latestEventPayload(
      app,
      harness.agentId,
      "conversation.turn_committed",
    );
    expect(turnAudit).toMatchObject({
      assistantMessageId: exchange.assistantMessage.id,
      reasonCode: "explicit_fact_reply_guard_selected",
    });
    expect(turnAudit["explicitFactReplyGuard"]).toEqual(guardMetadata);
    expect(exchange.decision).toMatchObject({
      reasonCode: "explicit_fact_reply_guard_selected",
      deliveryMode: "single_block",
      chunks: [EXPLICIT_FACT_REPLY],
    });
    expect(exchange.scheduleChanges).toEqual([]);
    const guardedModelCalls = vi
      .mocked(app.personasim.llm)
      .generateObject.mock.calls.slice(modelCallCountBeforeGuard)
      .map(([request]) => request);
    expect(guardedModelCalls).toHaveLength(1);
    expect(guardedModelCalls[0]).toMatchObject({ purpose: "chat_turn" });
    expect(guardedModelCalls[0]?.fixture).toBeUndefined();
    expect(guardedModelCalls[0]?.prompt).toContain(TEA_FACT);
    expect(guardedModelCalls[0]?.prompt).toContain(BOX_FACT);
    const publishedEvents = publish.mock.calls.map(([event]) => event);
    const publishedMessages = publishedEvents.filter(
      (event) => event.type === "message.created",
    );
    expect(publishedMessages).toHaveLength(1);
    expect(publishedMessages[0]?.data).toMatchObject({
      content: EXPLICIT_FACT_REPLY,
      metadata: {
        chunks: [EXPLICIT_FACT_REPLY],
        deliveryMode: "single_block",
      },
    });
    expect(JSON.stringify(publishedMessages)).not.toContain("稍后再说");
    expect(
      publishedEvents.some((event) => event.type === "schedule.updated"),
    ).toBe(false);
    const publishCountAfterFirst = publish.mock.calls.length;
    expect(explicitFactSideEffectSnapshot(app, harness.agentId)).toEqual(
      beforeGuardWrites,
    );
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT status, mention_count AS mentionCount,
                  last_mentioned_message_id AS lastMentionedMessageId
           FROM care_cues WHERE id = ?`,
        )
        .get(careCue.careCue.id),
    ).toEqual({
      status: "active",
      mentionCount: 0,
      lastMentionedMessageId: null,
    });
    const afterGuardState = app.personasim.store.getRuntimeState(
      harness.agentId,
    );
    expect(afterGuardState).toMatchObject({
      moodValence: beforeGuardState?.moodValence,
      moodArousal: beforeGuardState?.moodArousal,
      energy: beforeGuardState?.energy,
      stress: beforeGuardState?.stress,
      socialBattery: beforeGuardState?.socialBattery,
      focus: beforeGuardState?.focus,
    });
    expect(afterGuardState?.relationship.trust).toBe(
      beforeGuardState?.relationship.trust,
    );
    const worldAudit = latestEventPayload(
      app,
      harness.agentId,
      "conversation.world_effects_committed",
    );
    expect(worldAudit).toMatchObject({
      llmProposalStatus: "blocked",
      proposed: {
        stateDelta: { stress: -0.2 },
        relationshipDelta: { trust: 0.2 },
      },
      accepted: {
        stateDelta: false,
        relationshipDelta: false,
        memoryCandidateCount: 0,
        personalIntentCandidateCount: 0,
      },
    });
    expect(worldAudit["rejectionCodes"]).toContain(
      "explicit_fact_reply_guard_blocked",
    );
    expect(
      (worldAudit["rejections"] as Array<{ reasonCode?: string }>).filter(
        (rejection) =>
          rejection.reasonCode === "explicit_fact_reply_guard_blocked",
      ),
    ).toHaveLength(4);
    expect(chatTurnModelCallCount(app)).toBe(1);

    const durableCountsAfterFirst = explicitFactReplaySnapshot(
      app,
      harness.agentId,
    );
    const replayResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${recallSession.id}/messages`,
      payload: requestPayload,
    });
    expect(replayResponse.statusCode).toBe(200);
    const replayExchange = SendMessageResponseSchema.parse(
      JSON.parse(replayResponse.body),
    );
    expect(replayExchange.idempotentReplay).toBe(true);
    expect(replayExchange.assistantMessage).toEqual(exchange.assistantMessage);
    expect(replayExchange.memoryRecall).toEqual(exchange.memoryRecall);
    expect(replayExchange.decision).toEqual(exchange.decision);
    expect(explicitFactReplaySnapshot(app, harness.agentId)).toEqual(
      durableCountsAfterFirst,
    );
    expect(chatTurnModelCallCount(app)).toBe(1);
    expect(publish).toHaveBeenCalledTimes(publishCountAfterFirst);
    const idempotencyConflict = await app.inject({
      method: "POST",
      url: `/api/sessions/${recallSession.id}/messages`,
      payload: { ...requestPayload, text: `${EXPLICIT_FACT_QUERY}不同文本` },
    });
    expect(idempotencyConflict.statusCode).toBe(409);
    expect(
      (JSON.parse(idempotencyConflict.body) as { error: { code: string } })
        .error.code,
    ).toBe("idempotency_key_reused");
    expect(explicitFactReplaySnapshot(app, harness.agentId)).toEqual(
      durableCountsAfterFirst,
    );
    expect(chatTurnModelCallCount(app)).toBe(1);
    expect(publish).toHaveBeenCalledTimes(publishCountAfterFirst);

    const successfulRun = latestRun(app, harness.agentId);
    expect(successfulRun.inputSnapshot.query.query).toBe(EXPLICIT_FACT_QUERY);
    expect(successfulRun.inputSnapshot.minimumScore).toBe(0.2);
    expect(successfulRun.inputSnapshot.hierarchy).toMatchObject({
      finalTier: "basic_memory",
      selectorAudit: {
        policy: "explicit_fact_checklist_v1",
        expectedFacetCount: 2,
        outcome: "selected",
        scanLimit: 500,
        scanTruncated: false,
        attempts: [
          { tier: "event_card", outcome: "incomplete" },
          {
            tier: "basic_memory",
            outcome: "selected",
            facets: [
              { index: 0, kind: "beverage_preference", outcome: "selected" },
              { index: 1, kind: "entity_inscription", outcome: "selected" },
            ],
          },
        ],
      },
    });
    expect(successfulRun.configSnapshot).toMatchObject({
      strategy: {
        selectorPolicyVersion: "explicit_fact_checklist_v1",
      },
    });
    expect(
      successfulRun.stages.find((stage) => stage.name === "selection")
        ?.snapshot,
    ).toMatchObject({
      selector: {
        policy: "explicit_fact_checklist_v1",
        outcome: "selected",
      },
    });
    expect(successfulRun.result.selectedMemoryIds).toHaveLength(2);
    expect(successfulRun.result.selectedEvidenceIds).toHaveLength(2);
    expect(
      successfulRun.inputSnapshot.memories.map((memory) => memory.content),
    ).toEqual(expect.arrayContaining([TEA_FACT, BOX_FACT]));
    expect(successfulRun.inputSnapshot.memories).toHaveLength(2);
    expect(
      successfulRun.inputSnapshot.evidence.every(
        (evidence) =>
          evidence.sourceType === "message" &&
          evidence.sourceId === sharedSourceMessageId,
      ),
    ).toBe(true);
    expect(successfulRun.renderedPromptFragment).toContain(TEA_FACT);
    expect(successfulRun.renderedPromptFragment).toContain(BOX_FACT);
    expect(successfulRun.renderedPromptFragment).not.toContain(
      boundaryMemory.content,
    );
    expect(successfulRun.renderedPromptFragment).not.toContain(
      contextMemory.content,
    );
    expect(successfulRun.result.selectedMemoryIds).not.toContain(
      queryEchoMemory.id,
    );
    expectReplayExact(app.personasim.memoryRecalls, app, successfulRun.id);

    const friendTeaSourceId = "message-friend-green-tea";
    insertUserMessage(app, {
      id: friendTeaSourceId,
      sessionId: sourceSession.id,
      agentId: harness.agentId,
      content: "我的朋友喝不加糖的绿茶。",
      createdAtUtc: "2026-10-11T09:40:00.000Z",
    });
    const friendTeaMemory = seedLegacyRecallFixtureMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        explicitUserFact(
          "用户喝不加糖的绿茶。",
          ["user preference", "绿茶"],
          0.98,
          "2026-10-11T09:40:00.000Z",
          "user_preference:friend_green_tea_decoy",
        ),
      ],
      nowUtc: "2026-10-11T09:40:00.000Z",
      maxCandidates: 2,
      authoritativeMessageId: friendTeaSourceId,
    }).find((memory) => memory.content === "用户喝不加糖的绿茶。");
    if (friendTeaMemory === undefined) {
      throw new Error("Expected the friend-owned tea decoy to persist");
    }
    const friendOwnedTea = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: "替我核对两件旧事：我喝绿茶的习惯，和那只铁盒的标签。只答事实。",
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(friendOwnedTea.result).toMatchObject({
      abstained: true,
      abstentionReason: "requested_fact_facets_incomplete",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    expect(friendOwnedTea.result.selectedMemoryIds).not.toContain(
      friendTeaMemory.id,
    );

    const continuingCoffeeSourceId = "message-continuing-coffee-preference";
    insertUserMessage(app, {
      id: continuingCoffeeSourceId,
      sessionId: sourceSession.id,
      agentId: harness.agentId,
      content: "我还是喝不加糖的咖啡。",
      createdAtUtc: "2026-10-11T09:45:00.000Z",
    });
    const continuingCoffeeMemory = seedLegacyRecallFixtureMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        explicitUserFact(
          "用户还是喝不加糖的咖啡。",
          ["user preference", "咖啡"],
          0.75,
          "2026-10-11T09:45:00.000Z",
          "user_preference:continuing_unsweetened_coffee",
        ),
      ],
      nowUtc: "2026-10-11T09:45:00.000Z",
      maxCandidates: 2,
      authoritativeMessageId: continuingCoffeeSourceId,
    }).find((memory) => memory.content === "用户还是喝不加糖的咖啡。");
    if (continuingCoffeeMemory === undefined) {
      throw new Error("Expected the continuing coffee fact to persist");
    }
    const continuingCoffee = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: "替我核对两件旧事：我喝咖啡的习惯，和那只铁盒的标签。只答事实。",
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(continuingCoffee.result).toMatchObject({
      mode: "basic_memory",
      abstained: false,
    });
    expect(new Set(continuingCoffee.result.selectedMemoryIds)).toEqual(
      new Set([boxMemory.id, continuingCoffeeMemory.id]),
    );
    const genericBeverageConflict = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: "替我核对两件旧事：我的饮品偏好，和那只铁盒的标签。只答事实。",
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(genericBeverageConflict.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_facets_conflicted",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    expectReplayExact(
      app.personasim.memoryRecalls,
      app,
      latestRun(app, harness.agentId).id,
    );

    const beforeIncompleteWrites = explicitFactSideEffectSnapshot(
      app,
      harness.agentId,
    );
    const incompleteHttpResponse = await app.inject({
      method: "POST",
      url: `/api/sessions/${recallSession.id}/messages`,
      payload: {
        agentId: harness.agentId,
        clientMessageId: "explicit-fact-recall-incomplete-http",
        text: "替我核对两件旧事：我喝茶的习惯，和那只木盒的标签。只答事实。",
      },
    });
    expect(incompleteHttpResponse.statusCode).toBe(201);
    const incompleteExchange = SendMessageResponseSchema.parse(
      JSON.parse(incompleteHttpResponse.body),
    );
    expect(incompleteExchange.memoryRecall).toMatchObject({
      abstained: true,
      abstentionReason: "requested_fact_facets_incomplete",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    expect(incompleteExchange.assistantMessage.content).toBe(
      EXPLICIT_FACT_REFUSAL,
    );
    expect(incompleteExchange.assistantMessage.content).not.toContain(
      "不加糖的红茶",
    );
    expect(incompleteExchange.assistantMessage.content).not.toContain(
      "木盒标签",
    );
    expect(incompleteExchange.assistantMessage.metadata).toMatchObject({
      chunks: [EXPLICIT_FACT_REFUSAL],
      deliveryMode: "single_block",
      reasonCode: "explicit_fact_reply_guard_abstained",
      explicitFactReplyGuard: {
        outcome: "abstained",
        reasonCode: "requested_fact_facets_incomplete",
        expectedFacetCount: 2,
        selectedMemoryIds: [],
        selectedEvidenceIds: [],
        serverGuardApplied: true,
        modelReplyContentChanged: true,
        modelGenerationFallbackUsed: false,
        contentDerivedSemanticsSkipped: true,
      },
    });
    expect(explicitFactSideEffectSnapshot(app, harness.agentId)).toEqual(
      beforeIncompleteWrites,
    );
    expect(chatTurnModelCallCount(app)).toBe(2);

    for (const incompleteQuery of [
      "替我核对两件旧事：我喝茶的习惯，和那只木盒的标签。只答事实。",
      "替我核对两件旧事：我喝可可的习惯，和那只铁盒的标签。只答事实。",
    ]) {
      const incomplete = app.personasim.memoryRecalls.preview({
        agentId: harness.agentId,
        sessionId: recallSession.id,
        query: incompleteQuery,
        nowUtc: EXPLICIT_FACT_RECALL_AT,
        timezone: "Asia/Shanghai",
        requireDurableEvidence: true,
      });
      expect(incomplete.result).toMatchObject({
        mode: "none",
        abstained: true,
        selectedMemoryIds: [],
        selectedEvidenceIds: [],
        abstentionReason: "requested_fact_facets_incomplete",
      });
      expect(incomplete.result).not.toHaveProperty("evidenceBundle");
      const incompleteRun = latestRun(app, harness.agentId);
      expect(incompleteRun.inputSnapshot.hierarchy).toMatchObject({
        finalTier: "none",
        abstentionReason: "requested_fact_facets_incomplete",
      });
      expectReplayExact(app.personasim.memoryRecalls, app, incompleteRun.id);
    }

    const insufficientCapacity = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
      maxEvidence: 1,
    });
    expect(insufficientCapacity.result).toMatchObject({
      mode: "none",
      abstained: true,
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
      abstentionReason: "requested_fact_evidence_capacity_insufficient",
    });
    expectReplayExact(
      app.personasim.memoryRecalls,
      app,
      latestRun(app, harness.agentId).id,
    );

    const callerThreshold = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: { query: EXPLICIT_FACT_QUERY, minimumScore: 0.42 },
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(callerThreshold.result).toMatchObject({
      mode: "none",
      abstained: true,
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
      abstentionReason: "requested_fact_below_caller_threshold",
    });
    const callerThresholdRun = latestRun(app, harness.agentId);
    expect(callerThresholdRun.inputSnapshot.minimumScore).toBe(0.42);
    expectReplayExact(app.personasim.memoryRecalls, app, callerThresholdRun.id);

    const explicitTimeRange = {
      fromUtc: "2026-10-11T00:00:00.000Z",
      toUtc: "2026-10-12T00:00:00.000Z",
      statuses: ["occurred" as const],
    };
    const timeConstrained = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: { query: EXPLICIT_FACT_QUERY, timeRange: explicitTimeRange },
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(timeConstrained.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_facets_incomplete",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    const timeConstrainedRun = latestRun(app, harness.agentId);
    expect(timeConstrainedRun.inputSnapshot.query.timeRange).toEqual(
      explicitTimeRange,
    );
    expectReplayExact(app.personasim.memoryRecalls, app, timeConstrainedRun.id);

    const milkTeaMismatch = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: "替我核对两件旧事：我喝奶茶的习惯，和那只铁盒的标签。只答事实。",
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(milkTeaMismatch.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_facets_incomplete",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });

    const evidenceRow = app.personasim.store.database
      .prepare(
        `SELECT id, memory_id AS memoryId, source_type AS sourceType,
          source_id AS sourceId, quote, context_summary AS contextSummary,
          recorded_at_utc AS recordedAtUtc, evidence_json AS evidenceJson
         FROM memory_evidence WHERE memory_id = ?`,
      )
      .get(boxMemory.id) as StoredEvidenceRow | undefined;
    if (evidenceRow === undefined) {
      throw new Error("Expected stored evidence for the box fact");
    }
    const replaceBoxEvidence = (input: {
      sourceId: string;
      quote?: string;
      recordedAtUtc: string;
    }): void => {
      const storedEvidence = MemoryEvidenceSchema.parse(
        JSON.parse(evidenceRow.evidenceJson),
      );
      const nextEvidence: Record<string, unknown> = {
        ...storedEvidence,
        sourceId: input.sourceId,
        recordedAtUtc: input.recordedAtUtc,
      };
      if (input.quote !== undefined) nextEvidence["quote"] = input.quote;
      else delete nextEvidence["quote"];
      const evidenceJson = JSON.stringify(nextEvidence);
      app?.personasim.store.database
        .prepare(
          `UPDATE memory_evidence
           SET source_id = ?, quote = ?, context_summary = NULL,
             recorded_at_utc = ?, evidence_json = ?
           WHERE id = ?`,
        )
        .run(
          input.sourceId,
          input.quote ?? null,
          input.recordedAtUtc,
          evidenceJson,
          evidenceRow.id,
        );
    };
    const restoreBoxEvidence = (): void => {
      app?.personasim.store.database
        .prepare(
          `UPDATE memory_evidence
           SET source_id = ?, quote = ?, context_summary = ?,
             recorded_at_utc = ?, evidence_json = ?
           WHERE id = ?`,
        )
        .run(
          evidenceRow.sourceId,
          evidenceRow.quote,
          evidenceRow.contextSummary,
          evidenceRow.recordedAtUtc,
          evidenceRow.evidenceJson,
          evidenceRow.id,
        );
    };

    replaceBoxEvidence({
      sourceId: evidenceRow.sourceId,
      quote: "盖子上写着“1998/潮声”",
      recordedAtUtc: evidenceRow.recordedAtUtc,
    });
    const legacyPartialEvidence = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(legacyPartialEvidence.result.abstained).toBe(false);
    const legacyPartialRun = latestRun(app, harness.agentId);
    expect(
      legacyPartialRun.inputSnapshot.evidence.find(
        (evidence) => evidence.memoryId === boxMemory.id,
      )?.quote,
    ).toBe(EXPLICIT_FACT_SOURCE_TEXT);
    expectReplayExact(app.personasim.memoryRecalls, app, legacyPartialRun.id);

    replaceBoxEvidence({
      sourceId: evidenceRow.sourceId,
      recordedAtUtc: evidenceRow.recordedAtUtc,
    });
    const legacyMissingQuote = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(legacyMissingQuote.result.abstained).toBe(false);
    const legacyMissingQuoteRun = latestRun(app, harness.agentId);
    expect(
      legacyMissingQuoteRun.inputSnapshot.evidence.find(
        (evidence) => evidence.memoryId === boxMemory.id,
      )?.quote,
    ).toBe(EXPLICIT_FACT_SOURCE_TEXT);
    expectReplayExact(
      app.personasim.memoryRecalls,
      app,
      legacyMissingQuoteRun.id,
    );
    restoreBoxEvidence();

    replaceBoxEvidence({
      sourceId: evidenceRow.sourceId,
      quote: "我的钴蓝色铁盒标签写着“伪造值”。",
      recordedAtUtc: evidenceRow.recordedAtUtc,
    });
    const ungroundedQuote = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(ungroundedQuote.result).toMatchObject({
      abstained: true,
      abstentionReason: "requested_fact_facets_incomplete",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    const ungroundedRun = latestRun(app, harness.agentId);
    const serializedUngroundedRun = JSON.stringify({
      inputSnapshot: ungroundedRun.inputSnapshot,
      stages: ungroundedRun.stages,
      candidates: ungroundedRun.candidates,
      configSnapshot: ungroundedRun.configSnapshot,
      renderedPromptFragment: ungroundedRun.renderedPromptFragment,
    });
    expect(serializedUngroundedRun).not.toContain("伪造值");
    expect(serializedUngroundedRun).toContain(
      "fact_evidence_quote_not_grounded",
    );
    expectReplayExact(app.personasim.memoryRecalls, app, ungroundedRun.id);

    const groundedButInvalidBoxEvidence = [
      {
        id: "message-conflicting-box-label",
        quote: "我的钴蓝色铁盒标签写着“2001 / 风声”。",
        reason: "requested_fact_facets_conflicted",
      },
      {
        id: "message-unresolved-box-label",
        quote: "我不知道铁盒标签写着什么，现在还没定。",
      },
      {
        id: "message-other-object-label",
        quote: "铁盒在桌上，画册的标签写着“A-7”。",
      },
      {
        id: "message-coordinated-other-object-label",
        quote: "铁盒和画册的标签写着“A-7”。",
      },
      {
        id: "message-external-other-object-label",
        quote: "铁盒在桌上，外面那本画册标签写着“A-7”。",
      },
      {
        id: "message-missing-box-label",
        quote: "铁盒标签已经掉了。",
      },
      {
        id: "message-ambiguous-box-label-choice",
        quote: "铁盒标签写着“A”还是“B”。",
      },
      {
        id: "message-negated-box-label-excerpt",
        sourceContent:
          "我说“铁盒标签写着 1998 / 潮声”是错的，正确标签是 2001 / 风声。",
        quote: "铁盒标签写着 1998 / 潮声",
      },
      {
        id: "message-denied-box-label",
        sourceContent:
          "我否认下面这句话。我的钴蓝色铁盒标签写着“1998 / 潮声”。",
        quote: "我的钴蓝色铁盒标签写着“1998 / 潮声”",
      },
      {
        id: "message-example-box-label",
        sourceContent:
          "以下只是示例，不是事实。我的钴蓝色铁盒标签写着“1998 / 潮声”。",
        quote: "我的钴蓝色铁盒标签写着“1998 / 潮声”",
      },
      {
        id: "message-hypothetical-box-label",
        sourceContent:
          "先看一个假设：如果我的钴蓝色铁盒标签写着“1998 / 潮声”，就把它留着。",
        quote: "我的钴蓝色铁盒标签写着“1998 / 潮声”",
      },
      {
        id: "message-quoted-example-box-label",
        sourceContent: "引用内容如下：“我的钴蓝色铁盒标签写着“1998 / 潮声””。",
        quote: "我的钴蓝色铁盒标签写着“1998 / 潮声”",
      },
      {
        id: "message-negated-quoted-box-label",
        sourceContent: "我的钴蓝色铁盒标签写着“1998 / 潮声”不是事实。",
        quote: "我的钴蓝色铁盒标签写着“1998 / 潮声”",
      },
      {
        id: "message-friend-owned-box-label",
        quote: "我朋友的钴蓝色铁盒标签写着“1998 / 潮声”。",
      },
      {
        id: "message-named-owner-box-label",
        quote: "小李的钴蓝色铁盒标签写着“1998 / 潮声”。",
      },
      {
        id: "message-combined-named-owner-box-label",
        sourceContent:
          "我喝不加糖的红茶。小李的钴蓝色铁盒标签写着“1998 / 潮声”。",
        quote: "小李的钴蓝色铁盒标签写着“1998 / 潮声”",
      },
      {
        id: "message-quoted-ownerless-box-label",
        sourceContent: "请看：“钴蓝色铁盒标签写着 1998 / 潮声”。",
        quote: "钴蓝色铁盒标签写着 1998 / 潮声",
      },
      {
        id: "message-excerpt-box-label",
        quote: "摘录：钴蓝色铁盒标签写着 1998 / 潮声。",
      },
      {
        id: "message-source-material-box-label",
        quote: "资料里写着：钴蓝色铁盒标签写着 1998 / 潮声。",
      },
      {
        id: "message-reported-box-label",
        quote: "有人写道：钴蓝色铁盒标签写着 1998 / 潮声。",
      },
      {
        id: "message-falsehood-box-label",
        quote: "这是假话：钴蓝色铁盒标签写着 1998 / 潮声。",
      },
      {
        id: "message-counterfactual-box-label",
        quote: "这是反事实：钴蓝色铁盒标签写着 1998 / 潮声。",
      },
      {
        id: "message-please-read-quoted-box-label",
        sourceContent: "请看：“我的钴蓝色铁盒标签写着 1998 / 潮声”。",
        quote: "我的钴蓝色铁盒标签写着 1998 / 潮声",
      },
      {
        id: "message-quoted-correction-box-label",
        sourceContent:
          "引用：“旧记录。更正：我的钴蓝色铁盒标签写着 1998 / 潮声”。",
        quote: "我的钴蓝色铁盒标签写着 1998 / 潮声",
      },
      {
        id: "message-unconfirmed-box-label",
        quote: "我尚未确认我的钴蓝色铁盒标签写着 1998 / 潮声。",
      },
      {
        id: "message-example-word-box-label",
        sourceContent: "这是一个例子。我的钴蓝色铁盒标签写着 1998 / 潮声。",
        quote: "我的钴蓝色铁盒标签写着 1998 / 潮声",
      },
      {
        id: "message-fictional-tail-box-label",
        sourceContent: "我的钴蓝色铁盒标签写着“1998 / 潮声”，纯属虚构。",
        quote: "我的钴蓝色铁盒标签写着“1998 / 潮声”",
      },
    ] as const;
    for (const invalidEvidence of groundedButInvalidBoxEvidence) {
      insertUserMessage(app, {
        id: invalidEvidence.id,
        sessionId: sourceSession.id,
        agentId: harness.agentId,
        content:
          "sourceContent" in invalidEvidence
            ? invalidEvidence.sourceContent
            : invalidEvidence.quote,
        createdAtUtc: "2026-10-11T10:00:00.000Z",
      });
      replaceBoxEvidence({
        sourceId: invalidEvidence.id,
        quote: invalidEvidence.quote,
        recordedAtUtc: "2026-10-11T10:00:00.000Z",
      });
      const mismatchedValue = app.personasim.memoryRecalls.preview({
        agentId: harness.agentId,
        sessionId: recallSession.id,
        query: EXPLICIT_FACT_QUERY,
        nowUtc: EXPLICIT_FACT_RECALL_AT,
        timezone: "Asia/Shanghai",
        requireDurableEvidence: true,
      });
      expect(mismatchedValue.result, invalidEvidence.id).toMatchObject({
        abstained: true,
        abstentionReason:
          "reason" in invalidEvidence
            ? invalidEvidence.reason
            : "requested_fact_facets_incomplete",
        selectedMemoryIds: [],
        selectedEvidenceIds: [],
      });
      expect(
        JSON.stringify(latestRun(app, harness.agentId).inputSnapshot.evidence),
      ).not.toContain(invalidEvidence.quote);
    }
    restoreBoxEvidence();

    const correctedBoxSourceId = "message-corrected-box-label";
    insertUserMessage(app, {
      id: correctedBoxSourceId,
      sessionId: sourceSession.id,
      agentId: harness.agentId,
      content:
        "引用：“小李的钴蓝色铁盒标签写着 2001 / 风声”。更正：我的钴蓝色铁盒标签写着“1998 / 潮声”。",
      createdAtUtc: "2026-10-11T10:10:00.000Z",
    });
    replaceBoxEvidence({
      sourceId: correctedBoxSourceId,
      quote: "我的钴蓝色铁盒标签写着“1998 / 潮声”",
      recordedAtUtc: "2026-10-11T10:10:00.000Z",
    });
    const correctedEvidence = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(correctedEvidence.result.abstained).toBe(false);
    expectReplayExact(
      app.personasim.memoryRecalls,
      app,
      latestRun(app, harness.agentId).id,
    );
    restoreBoxEvidence();

    const originalBoxRecordedAt = app.personasim.store.database
      .prepare(
        "SELECT recorded_at_utc AS recordedAtUtc FROM memories WHERE id = ?",
      )
      .get(boxMemory.id) as { recordedAtUtc: string } | undefined;
    if (originalBoxRecordedAt === undefined) {
      throw new Error("Expected the box memory row to exist");
    }
    app.personasim.store.database
      .prepare("UPDATE memories SET recorded_at_utc = ? WHERE id = ?")
      .run("2026-10-13T10:00:00.000Z", boxMemory.id);
    const futureDerivedMemory = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(futureDerivedMemory.result).toMatchObject({
      abstained: true,
      abstentionReason: "requested_fact_facets_incomplete",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    app.personasim.store.database
      .prepare("UPDATE memories SET recorded_at_utc = ? WHERE id = ?")
      .run(originalBoxRecordedAt.recordedAtUtc, boxMemory.id);

    const reinforcingTeaSourceId = "message-reinforcing-tea-preference";
    insertUserMessage(app, {
      id: reinforcingTeaSourceId,
      sessionId: sourceSession.id,
      agentId: harness.agentId,
      content: "我喝不加糖的红茶，不喜欢甜的。",
      createdAtUtc: "2026-10-11T10:30:00.000Z",
    });
    const [reinforcingTea] = seedLegacyRecallFixtureMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        explicitUserFact(
          TEA_FACT,
          ["user fact"],
          0.7,
          "2026-10-11T10:30:00.000Z",
          "user_preference:tea_sugar_reinforcement",
        ),
      ],
      nowUtc: "2026-10-11T10:30:00.000Z",
      maxCandidates: 2,
      authoritativeMessageId: reinforcingTeaSourceId,
    });
    if (reinforcingTea === undefined) {
      throw new Error("Expected the equivalent tea fact to persist");
    }
    expect(reinforcingTea.id).not.toBe(teaMemory.id);
    const reinforced = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(reinforced.result.abstained).toBe(false);
    expect(reinforced.result.selectedMemoryIds).toContain(boxMemory.id);
    expect(
      reinforced.result.selectedMemoryIds.filter((id) =>
        [teaMemory.id, reinforcingTea.id].includes(id),
      ),
    ).toHaveLength(1);

    const conflictingTeaSourceId = "message-conflicting-tea-preference";
    insertUserMessage(app, {
      id: conflictingTeaSourceId,
      sessionId: sourceSession.id,
      agentId: harness.agentId,
      content: "我喝加糖的红茶，喜欢甜的。",
      createdAtUtc: "2026-10-11T11:00:00.000Z",
    });
    const [conflictingTea] = seedLegacyRecallFixtureMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        explicitUserFact(
          "用户喝加糖的红茶，喜欢甜的。",
          ["user preference"],
          0.99,
          "2026-10-11T11:00:00.000Z",
          "user_preference:tea_sugar_conflict",
        ),
      ],
      nowUtc: "2026-10-11T11:00:00.000Z",
      maxCandidates: 2,
      authoritativeMessageId: conflictingTeaSourceId,
    });
    if (conflictingTea === undefined) {
      throw new Error("Expected the conflicting tea fact to persist");
    }
    expect(conflictingTea.id).not.toBe(teaMemory.id);
    const conflicted = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: recallSession.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(conflicted.result).toMatchObject({
      abstained: true,
      abstentionReason: "requested_fact_facets_conflicted",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    const conflictedRun = latestRun(app, harness.agentId);
    expect(conflictedRun.inputSnapshot.hierarchy?.selectorAudit).toMatchObject({
      outcome: "conflicted",
      attempts: [
        { tier: "event_card", outcome: "incomplete" },
        {
          tier: "basic_memory",
          outcome: "conflicted",
          facets: [
            {
              index: 0,
              kind: "beverage_preference",
              outcome: "conflicted",
            },
            {
              index: 1,
              kind: "entity_inscription",
              outcome: "selected",
            },
          ],
        },
      ],
    });
    const conflictedFacet =
      conflictedRun.inputSnapshot.hierarchy?.selectorAudit?.attempts[1]
        ?.facets[0];
    expect(
      new Set(
        conflictedFacet?.candidates.flatMap((candidate) =>
          candidate.valueGroupId === undefined ? [] : [candidate.valueGroupId],
        ),
      ).size,
    ).toBeGreaterThanOrEqual(2);
    expect(
      JSON.stringify(conflictedRun.inputSnapshot.hierarchy?.selectorAudit),
    ).not.toMatch(/(?:加糖|不加糖|红茶|潮声)/u);
    expectReplayExact(app.personasim.memoryRecalls, app, conflictedRun.id);

    const conflictedWithSmallCallerLimit = app.personasim.memoryRecalls.preview(
      {
        agentId: harness.agentId,
        sessionId: recallSession.id,
        query: EXPLICIT_FACT_QUERY,
        nowUtc: EXPLICIT_FACT_RECALL_AT,
        timezone: "Asia/Shanghai",
        requireDurableEvidence: true,
        limit: 2,
      },
    );
    expect(conflictedWithSmallCallerLimit.result).toMatchObject({
      abstained: true,
      abstentionReason: "requested_fact_facets_conflicted",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    expectReplayExact(
      app.personasim.memoryRecalls,
      app,
      latestRun(app, harness.agentId).id,
    );
  });

  it("keeps an active schedule negotiation untouched during guarded fact verification", async () => {
    const harness = await createHarness({
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      adversarialOpenAiCompatibleDecisionPath: true,
      lifePlanningMode: "legacy_exact",
      chatEffectsMode: "gated",
      scheduleNegotiationMode: "enforced",
    });
    app = harness.app;
    expect(app.personasim.llm.providerName).toBe("openai-compatible");
    const sourceSession = app.personasim.conversations.createSession(
      harness.agentId,
      "Fact source before schedule negotiation",
    );
    const sourceMessageId = "message-fact-source-before-pending-offer";
    const sourceText = EXPLICIT_FACT_SOURCE_TEXT;
    insertUserMessage(app, {
      id: sourceMessageId,
      sessionId: sourceSession.id,
      agentId: harness.agentId,
      content: sourceText,
      createdAtUtc: EXPLICIT_FACT_SOURCE_AT,
    });
    const factMemories = seedLegacyRecallFixtureMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        MemoryCandidateSchema.parse({
          ...explicitUserFact(
            TEA_FACT,
            ["user preference", "饮品", "偏好"],
            0.4,
            EXPLICIT_FACT_SOURCE_AT,
          ),
          evidence: [
            {
              sourceType: "message",
              sourceId: sourceMessageId,
              quote: "我喝红茶不加糖",
            },
          ],
        }),
        MemoryCandidateSchema.parse({
          ...explicitUserFact(
            BOX_FACT,
            ["user fact", "底片", "潮痕", "下周约定"],
            0.6,
            EXPLICIT_FACT_SOURCE_AT,
          ),
          evidence: [
            {
              sourceType: "message",
              sourceId: sourceMessageId,
              quote: "盖子上写着“1998/潮声”",
            },
          ],
        }),
      ],
      nowUtc: EXPLICIT_FACT_SOURCE_AT,
      maxCandidates: 2,
      authoritativeMessageId: sourceMessageId,
    });
    const teaMemory = factMemories.find(
      (memory) => memory.content === TEA_FACT,
    );
    const boxMemory = factMemories.find(
      (memory) => memory.content === BOX_FACT,
    );
    if (teaMemory === undefined || boxMemory === undefined) {
      throw new Error("Expected both fact memories to persist");
    }
    const recallSession = app.personasim.conversations.createSession(
      harness.agentId,
      "Fact verification with a pending offer",
    );
    const pendingId = "negotiation-pending-during-fact-verification";
    const offerStartAtUtc = "2026-10-13T23:00:00.000Z";
    const pendingNegotiation = {
      id: pendingId,
      status: "awaiting_confirmation" as const,
      offerVersion: 1,
      details: {
        activity: "晨跑",
        category: "exercise",
        startAtUtc: offerStartAtUtc,
        durationMinutes: 30,
        timezone: "Asia/Shanghai",
      },
      offer: {
        operation: "create" as const,
        activity: "晨跑",
        category: "exercise",
        startAtUtc: offerStartAtUtc,
        durationMinutes: 30,
        timezone: "Asia/Shanghai",
        version: 1,
        offeredAtUtc: EXPLICIT_FACT_RECALL_AT,
        validUntilUtc: "2026-10-12T10:30:00.000Z",
        evidenceIds: [sourceMessageId],
      },
      evidenceIds: [sourceMessageId],
      createdAtUtc: EXPLICIT_FACT_RECALL_AT,
      updatedAtUtc: EXPLICIT_FACT_RECALL_AT,
    };
    const pending = app.personasim.store.upsertScheduleNegotiation({
      id: pendingId,
      agentId: harness.agentId,
      sessionId: recallSession.id,
      status: "awaiting_confirmation",
      offerVersion: 1,
      record: {
        policyVersion: 2,
        negotiation: pendingNegotiation,
      },
      createdAtUtc: EXPLICIT_FACT_RECALL_AT,
      updatedAtUtc: EXPLICIT_FACT_RECALL_AT,
    });
    expect(
      new ScheduleNegotiationService(
        app.personasim.store,
        app.personasim.schedules,
      ).getActive(recallSession.id, EXPLICIT_FACT_RECALL_AT),
    ).toMatchObject({
      stored: pending,
      state: pendingNegotiation,
      expired: false,
    });
    const scheduleBefore = app.personasim.store.listSchedule(harness.agentId);
    const commandEventCountBefore = app.personasim.store
      .listDomainEvents(harness.agentId, 100)
      .filter(
        (event) => event.eventType === "schedule.command_committed",
      ).length;
    const negotiationEventCountBefore = app.personasim.store
      .listDomainEvents(harness.agentId, 100)
      .filter(
        (event) =>
          typeof event.eventType === "string" &&
          event.eventType.startsWith("schedule.negotiation_"),
      ).length;
    const publish = vi.spyOn(app.personasim.sse, "publish");
    const modelCallsBefore = vi.mocked(app.personasim.llm).generateObject.mock
      .calls.length;

    publish.mockClear();
    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${recallSession.id}/messages`,
      payload: {
        agentId: harness.agentId,
        clientMessageId: "fact-verification-with-pending-offer",
        text: EXPLICIT_FACT_QUERY,
      },
    });

    expect(response.statusCode).toBe(201);
    const exchange = SendMessageResponseSchema.parse(JSON.parse(response.body));
    expect(exchange.memoryRecall).toMatchObject({
      rolloutMode: "enforced",
      abstained: false,
    });
    expect(new Set(exchange.memoryRecall?.selectedMemoryIds)).toEqual(
      new Set([teaMemory.id, boxMemory.id]),
    );
    expect(exchange.assistantMessage.metadata).toMatchObject({
      explicitFactReplyGuard: {
        outcome: "selected",
      },
    });
    expect(exchange.assistantMessage.content).toBe(EXPLICIT_FACT_REPLY);
    expect(exchange.assistantMessage.content).not.toContain("【待确认日程】");
    expect(exchange.assistantMessage.metadata).toMatchObject({
      deliveryMode: "single_block",
      reasonCode: "explicit_fact_reply_guard_selected",
      scheduleActionAudit: {
        origin: "model_explicit_valid",
        kind: "request_details",
      },
      explicitFactReplyGuard: {
        outcome: "selected",
        modelRepairAttempted: false,
        modelSideEffectsBlocked: true,
      },
    });
    expect(exchange.scheduleChanges).toEqual([]);
    const modelCalls = vi
      .mocked(app.personasim.llm)
      .generateObject.mock.calls.slice(modelCallsBefore)
      .map(([request]) => request);
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]).toMatchObject({ purpose: "chat_turn" });
    expect(modelCalls[0]?.prompt).not.toContain(
      "SCHEDULE_NEGOTIATION_CONTRACT",
    );
    expect(modelCalls[0]?.prompt).not.toContain(pendingId);
    expect(
      publish.mock.calls.some(([event]) => event.type === "schedule.updated"),
    ).toBe(false);
    expect(
      app.personasim.store.getActiveScheduleNegotiation(recallSession.id),
    ).toEqual(pending);
    expect(app.personasim.store.listSchedule(harness.agentId)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store
        .listDomainEvents(harness.agentId, 100)
        .filter((event) => event.eventType === "schedule.command_committed"),
    ).toHaveLength(commandEventCountBefore);
    expect(
      app.personasim.store
        .listDomainEvents(harness.agentId, 100)
        .filter(
          (event) =>
            typeof event.eventType === "string" &&
            event.eventType.startsWith("schedule.negotiation_"),
        ),
    ).toHaveLength(negotiationEventCountBefore);
  });

  it("does not apply the fact-reply guard to ordinary conversation", async () => {
    const harness = await createHarness({
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      adversarialOpenAiCompatibleDecisionPath: true,
    });
    app = harness.app;
    expect(app.personasim.llm.providerName).toBe("openai-compatible");
    const session = app.personasim.conversations.createSession(
      harness.agentId,
      "Ordinary conversation outside fact verification",
    );
    const callsBefore = vi.mocked(app.personasim.llm).generateObject.mock.calls
      .length;

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${session.id}/messages`,
      payload: {
        agentId: harness.agentId,
        clientMessageId: "ordinary-rain-conversation",
        text: "今天压力很大，只想聊聊窗外的雨。",
      },
    });

    expect(response.statusCode).toBe(201);
    const exchange = SendMessageResponseSchema.parse(JSON.parse(response.body));
    expect(exchange.assistantMessage.content).toBe(
      "你喝不加糖的红茶；\n木盒标签我不知道。",
    );
    expect(exchange.assistantMessage.metadata).toMatchObject({
      deliveryMode: "sequential",
      chunks: ["你喝不加糖的红茶；", "木盒标签我不知道。"],
    });
    expect(
      exchange.assistantMessage.metadata["explicitFactReplyGuard"],
    ).toBeUndefined();
    expect(exchange.decision.reasonCode).not.toMatch(
      /^explicit_fact_reply_guard_/u,
    );
    const ordinaryCalls = vi
      .mocked(app.personasim.llm)
      .generateObject.mock.calls.slice(callsBefore)
      .map(([request]) => request);
    expect(ordinaryCalls).toHaveLength(1);
    expect(ordinaryCalls[0]).toMatchObject({ purpose: "chat_turn" });
    expect(ordinaryCalls[0]?.fixture).toBeUndefined();
    expect(
      latestEventPayload(
        app,
        harness.agentId,
        "conversation.world_effects_committed",
      )["llmProposalStatus"],
    ).toBe("committed");
  });

  it("fails the whole checklist closed instead of strengthening a negative beverage preference", async () => {
    const harness = await createHarness({
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      adversarialOpenAiCompatibleDecisionPath: true,
    });
    app = harness.app;
    const sourceSession = app.personasim.conversations.createSession(
      harness.agentId,
      "Negative preference source",
    );
    const sourceMessageId = "message-negative-tea-and-box-label";
    const sourceText = "我不喜欢红茶，我的铁盒标签写着“1998 / 潮声”。";
    insertUserMessage(app, {
      id: sourceMessageId,
      sessionId: sourceSession.id,
      agentId: harness.agentId,
      content: sourceText,
      createdAtUtc: EXPLICIT_FACT_SOURCE_AT,
    });
    const [factMemory] = seedLegacyRecallFixtureMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        MemoryCandidateSchema.parse({
          ...explicitUserFact(
            "用户不喜欢红茶，用户的铁盒标签写着“1998 / 潮声”。",
            ["user preference", "饮品", "铁盒标签"],
            0.9,
            EXPLICIT_FACT_SOURCE_AT,
          ),
          evidence: [
            {
              sourceType: "message",
              sourceId: sourceMessageId,
              quote: sourceText,
            },
          ],
        }),
      ],
      nowUtc: EXPLICIT_FACT_SOURCE_AT,
      maxCandidates: 2,
      authoritativeMessageId: sourceMessageId,
    });
    if (factMemory === undefined) {
      throw new Error("Expected the negative preference memory to persist");
    }
    const recallSession = app.personasim.conversations.createSession(
      harness.agentId,
      "Negative preference fact verification",
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/sessions/${recallSession.id}/messages`,
      payload: {
        agentId: harness.agentId,
        clientMessageId: "negative-preference-fact-verification",
        text: EXPLICIT_FACT_QUERY,
      },
    });

    expect(response.statusCode).toBe(201);
    const exchange = SendMessageResponseSchema.parse(JSON.parse(response.body));
    expect(exchange.memoryRecall).toMatchObject({
      rolloutMode: "enforced",
      abstained: false,
      selectedMemoryIds: [factMemory.id],
    });
    expect(exchange.assistantMessage.content).toBe(EXPLICIT_FACT_REFUSAL);
    expect(exchange.assistantMessage.content).not.toMatch(/(?:红茶|潮声)/u);
    expect(exchange.assistantMessage.metadata).toMatchObject({
      deliveryMode: "single_block",
      reasonCode: "explicit_fact_reply_guard_abstained",
      explicitFactReplyGuard: {
        outcome: "abstained",
        reasonCode: "requested_fact_reply_contract_invalid",
        selectedMemoryIds: [],
        selectedEvidenceIds: [],
      },
    });
  });

  it("keeps EventCard first when one verified user source covers the complete fact checklist", async () => {
    const harness = await createHarness({
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const session = app.personasim.conversations.createSession(
      harness.agentId,
      "Complete EventCard fact source",
    );
    const messageId = "message-complete-explicit-fact-event-card";
    const source =
      "我的钴蓝色铁盒标签写着“1998/潮声”。我喝红茶不加糖，不要甜的。";
    insertUserMessage(app, {
      id: messageId,
      sessionId: session.id,
      agentId: harness.agentId,
      content: source,
      createdAtUtc: "2026-10-11T12:00:00.000Z",
    });
    expect(
      new ContinuityRepository(app.personasim.store).upsertEventCards([
        sharedEventCard(app, {
          id: "event-card-complete-explicit-facts",
          agentId: harness.agentId,
          messageId,
          title: "暗房前的两项事实",
          summary: source,
          occurredAtUtc: "2026-10-11T12:00:00.000Z",
        }),
      ]),
    ).toBe(1);
    const [consistentTeaMemory] = seedLegacyRecallFixtureMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        MemoryCandidateSchema.parse({
          ...explicitUserFact(
            TEA_FACT,
            ["user preference", "红茶"],
            0.7,
            "2026-10-11T12:00:00.000Z",
            "user_preference:event_cross_check_tea",
          ),
          evidence: [
            {
              sourceType: "message",
              sourceId: messageId,
              quote: "我喝红茶不加糖",
            },
          ],
        }),
      ],
      nowUtc: "2026-10-11T12:00:00.000Z",
      maxCandidates: 2,
      authoritativeMessageId: messageId,
    });
    if (consistentTeaMemory === undefined) {
      throw new Error("Expected the EventCard cross-check fact to persist");
    }

    const preview = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
      maxEvidence: 1,
    });

    expect(preview.result).toMatchObject({
      mode: "event_card",
      abstained: false,
      selectedMemoryIds: ["event-card-complete-explicit-facts"],
    });
    expect(preview.result.selectedEvidenceIds).toHaveLength(1);
    const run = latestRun(app, harness.agentId);
    expect(run.inputSnapshot).toMatchObject({
      maxEvidence: 1,
      hierarchy: {
        finalTier: "event_card",
        selectorAudit: {
          outcome: "selected",
          attempts: [
            {
              tier: "event_card",
              outcome: "selected",
              facets: [
                { index: 0, outcome: "selected" },
                { index: 1, outcome: "selected" },
              ],
            },
            {
              tier: "basic_memory",
              outcome: "incomplete",
            },
          ],
        },
      },
    });
    const selectedAuditMemoryIds = new Set(
      run.inputSnapshot.hierarchy?.selectorAudit?.attempts[0]?.facets.flatMap(
        (facet) =>
          facet.candidates
            .filter((candidate) => candidate.decision === "selected")
            .map((candidate) => candidate.memoryId),
      ),
    );
    expect(selectedAuditMemoryIds).toEqual(
      new Set(["event-card-complete-explicit-facts"]),
    );
    expect(run.inputSnapshot.memories).toHaveLength(1);
    expect(run.inputSnapshot.evidence).toHaveLength(1);
    expectReplayExact(app.personasim.memoryRecalls, app, run.id);

    const conflictMessageId = "message-event-card-cross-tier-conflict";
    insertUserMessage(app, {
      id: conflictMessageId,
      sessionId: session.id,
      agentId: harness.agentId,
      content: "我喝加糖的红茶，喜欢甜的。",
      createdAtUtc: "2026-10-11T12:30:00.000Z",
    });
    const [conflictingTeaMemory] = seedLegacyRecallFixtureMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        explicitUserFact(
          "用户喝加糖的红茶，喜欢甜的。",
          ["user preference", "红茶"],
          0.8,
          "2026-10-11T12:30:00.000Z",
          "user_preference:event_cross_tier_conflict",
        ),
      ],
      nowUtc: "2026-10-11T12:30:00.000Z",
      maxCandidates: 2,
      authoritativeMessageId: conflictMessageId,
    });
    if (conflictingTeaMemory === undefined) {
      throw new Error("Expected the cross-tier conflict fact to persist");
    }
    const conflicted = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(conflicted.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_facets_conflicted",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    const conflictRun = latestRun(app, harness.agentId);
    expect(conflictRun.inputSnapshot.hierarchy?.selectorAudit).toMatchObject({
      outcome: "conflicted",
      attempts: [
        {
          tier: "event_card",
          outcome: "conflicted",
          facets: [
            { index: 0, outcome: "conflicted" },
            { index: 1, outcome: "selected" },
          ],
        },
        {
          tier: "basic_memory",
          outcome: "conflicted",
          facets: [
            { index: 0, outcome: "conflicted" },
            { index: 1, outcome: "missing" },
          ],
        },
      ],
    });
    expect(
      conflictRun.inputSnapshot.hierarchy?.selectorAudit?.attempts.flatMap(
        (attempt) =>
          attempt.facets.flatMap((facet) =>
            facet.candidates.filter(
              (candidate) => candidate.decision === "selected",
            ),
          ),
      ),
    ).toEqual([]);
    expectReplayExact(app.personasim.memoryRecalls, app, conflictRun.id);
  });

  it("uses a minimal proof set while auditing redundant consistent EventCard evidence", async () => {
    const harness = await createHarness({
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const session = app.personasim.conversations.createSession(
      harness.agentId,
      "Redundant EventCard evidence",
    );
    const source = "我喝不加糖的红茶。我的钴蓝色铁盒标签写着“1998 / 潮声”。";
    const evidenceSources = Array.from({ length: 4 }, (_unused, index) => {
      const messageId = `message-redundant-event-facts-${index}`;
      insertUserMessage(harness.app, {
        id: messageId,
        sessionId: session.id,
        agentId: harness.agentId,
        content: source,
        createdAtUtc: `2026-10-11T13:0${index}:00.000Z`,
      });
      return {
        id: `event-source-redundant-facts-${index}`,
        messageId,
        quote: source,
        recordedAtUtc: `2026-10-11T13:0${index}:00.000Z`,
      };
    });
    const card = sharedEventCard(app, {
      id: "event-card-redundant-explicit-facts",
      agentId: harness.agentId,
      messageId: evidenceSources[0]!.messageId,
      title: "多次确认的两项事实",
      summary: source,
      occurredAtUtc: "2026-10-11T13:03:00.000Z",
      evidenceSources,
    });
    expect(
      new ContinuityRepository(app.personasim.store).upsertEventCards([card]),
    ).toBe(1);

    const preview = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
      maxEvidence: 1,
    });
    expect(preview.result).toMatchObject({
      mode: "event_card",
      abstained: false,
      selectedMemoryIds: [card.id],
    });
    expect(preview.result.selectedEvidenceIds).toHaveLength(1);
    const run = latestRun(app, harness.agentId);
    expect(run.inputSnapshot.evidence).toHaveLength(1);
    expect(
      run.inputSnapshot.hierarchy?.selectorAudit?.attempts[0]?.facets.map(
        (facet) =>
          facet.candidates[0]?.evidence.filter(
            (evidence) => evidence.decision === "accepted",
          ).length,
      ),
    ).toEqual([4, 4]);
    expectReplayExact(app.personasim.memoryRecalls, app, run.id);
  });

  it("requires every EventCard fact source to agree while allowing split provenance", async () => {
    const harness = await createHarness({
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const session = app.personasim.conversations.createSession(
      harness.agentId,
      "Split EventCard provenance",
    );
    const teaMessageId = "message-split-event-tea";
    const boxMessageId = "message-split-event-box";
    insertUserMessage(app, {
      id: teaMessageId,
      sessionId: session.id,
      agentId: harness.agentId,
      content: "我喝不加糖的红茶。",
      createdAtUtc: "2026-10-11T13:00:00.000Z",
    });
    insertUserMessage(app, {
      id: boxMessageId,
      sessionId: session.id,
      agentId: harness.agentId,
      content: "我的钴蓝色铁盒标签写着“1998 / 潮声”。",
      createdAtUtc: "2026-10-11T13:01:00.000Z",
    });
    const summary =
      "用户喝不加糖的红茶。用户的钴蓝色铁盒标签写着“1998 / 潮声”。";
    const splitCard = sharedEventCard(app, {
      id: "event-card-split-explicit-facts",
      agentId: harness.agentId,
      messageId: teaMessageId,
      title: "分源核对事实",
      summary,
      occurredAtUtc: "2026-10-11T13:01:00.000Z",
      evidenceSources: [
        {
          id: "event-source-split-tea",
          messageId: teaMessageId,
          quote: "我喝不加糖的红茶。",
          recordedAtUtc: "2026-10-11T13:00:00.000Z",
        },
        {
          id: "event-source-split-box",
          messageId: boxMessageId,
          quote: "我的钴蓝色铁盒标签写着“1998 / 潮声”。",
          recordedAtUtc: "2026-10-11T13:01:00.000Z",
        },
      ],
    });
    const continuity = new ContinuityRepository(app.personasim.store);
    expect(continuity.upsertEventCards([splitCard])).toBe(1);

    const split = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
      maxEvidence: 2,
    });
    expect(split.result).toMatchObject({
      mode: "event_card",
      abstained: false,
      selectedMemoryIds: [splitCard.id],
    });
    expect(split.result.selectedEvidenceIds).toHaveLength(2);
    expectReplayExact(
      app.personasim.memoryRecalls,
      app,
      latestRun(app, harness.agentId).id,
    );

    const insufficientSplitCapacity = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
      maxEvidence: 1,
    });
    expect(insufficientSplitCapacity.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_evidence_capacity_insufficient",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    expectReplayExact(
      app.personasim.memoryRecalls,
      app,
      latestRun(app, harness.agentId).id,
    );

    const compactBasicSourceId = "message-compact-basic-explicit-facts";
    const compactBasicSource =
      "我喝不加糖的红茶。我的钴蓝色铁盒盖子上写着“1998 / 潮声”。";
    insertUserMessage(app, {
      id: compactBasicSourceId,
      sessionId: session.id,
      agentId: harness.agentId,
      content: compactBasicSource,
      createdAtUtc: "2026-10-11T13:01:30.000Z",
    });
    const compactBasicMemoryId = "memory-compact-basic-explicit-facts";
    insertStableFactMemoryWithoutEvidence(app, {
      id: compactBasicMemoryId,
      agentId: harness.agentId,
      dedupeKey: "compact-basic-explicit-facts",
      content: "用户喝不加糖的红茶。用户的钴蓝色铁盒盖子上写着“1998 / 潮声”。",
      tags: ["user preference", "红茶", "铁盒", "标签"],
    });
    const compactBasicEvidence = MemoryEvidenceSchema.parse({
      id: "evidence-compact-basic-explicit-facts",
      memoryId: compactBasicMemoryId,
      sourceType: "message",
      sourceId: compactBasicSourceId,
      quote: compactBasicSource,
      recordedAtUtc: "2026-10-11T13:01:30.000Z",
    });
    app.personasim.store.database
      .prepare(
        `INSERT INTO memory_evidence(
          id, memory_id, source_type, source_id, quote, recorded_at_utc,
          evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        compactBasicEvidence.id,
        compactBasicEvidence.memoryId,
        compactBasicEvidence.sourceType,
        compactBasicEvidence.sourceId,
        compactBasicEvidence.quote,
        compactBasicEvidence.recordedAtUtc,
        JSON.stringify(compactBasicEvidence),
      );
    const blockedBasicFallback = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
      maxEvidence: 1,
    });
    expect(blockedBasicFallback.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_evidence_capacity_insufficient",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    const blockedBasicRun = latestRun(app, harness.agentId);
    expect(
      blockedBasicRun.inputSnapshot.hierarchy?.selectorAudit?.attempts.map(
        (attempt) => attempt.outcome,
      ),
    ).toEqual(["capacity_insufficient", "complete_not_selected"]);
    expectReplayExact(app.personasim.memoryRecalls, app, blockedBasicRun.id);

    const conflictingMessageId = "message-split-event-conflicting-tea";
    const cleanMessageId = "message-clean-event-facts";
    insertUserMessage(app, {
      id: conflictingMessageId,
      sessionId: session.id,
      agentId: harness.agentId,
      content: "我喝不加糖的红茶。我喝加糖的红茶。",
      createdAtUtc: "2026-10-11T13:02:00.000Z",
    });
    insertUserMessage(app, {
      id: cleanMessageId,
      sessionId: session.id,
      agentId: harness.agentId,
      content: "我喝不加糖的红茶。我的钴蓝色铁盒标签写着“1998 / 潮声”。",
      createdAtUtc: "2026-10-11T13:03:00.000Z",
    });
    const conflictingCard = sharedEventCard(app, {
      id: "event-card-conflicting-split-explicit-facts",
      agentId: harness.agentId,
      messageId: teaMessageId,
      title: "分源核对事实",
      summary,
      occurredAtUtc: "2026-10-11T13:02:00.000Z",
      evidenceSources: [
        ...splitCard.evidence.map((evidence) => ({
          id: evidence.id,
          messageId: evidence.sourceId,
          quote: evidence.quote ?? "",
          recordedAtUtc: evidence.recordedAtUtc,
        })),
        {
          id: "event-source-split-conflict",
          messageId: conflictingMessageId,
          quote: "我喝不加糖的红茶。我喝加糖的红茶。",
          recordedAtUtc: "2026-10-11T13:02:00.000Z",
        },
      ],
    });
    const cleanCard = sharedEventCard(app, {
      id: "event-card-clean-explicit-facts",
      agentId: harness.agentId,
      messageId: cleanMessageId,
      title: "一致的核对事实",
      summary,
      occurredAtUtc: "2026-10-11T13:03:00.000Z",
      evidenceSources: [
        {
          id: "event-source-clean-facts",
          messageId: cleanMessageId,
          quote: "我喝不加糖的红茶。我的钴蓝色铁盒标签写着“1998 / 潮声”。",
          recordedAtUtc: "2026-10-11T13:03:00.000Z",
        },
      ],
    });
    expect(continuity.upsertEventCards([conflictingCard, cleanCard])).toBe(2);

    const conflicted = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(conflicted.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_facets_conflicted",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    const conflictedRun = latestRun(app, harness.agentId);
    expect(
      conflictedRun.inputSnapshot.hierarchy?.selectorAudit?.attempts[0]
        ?.facets[0]?.outcome,
    ).toBe("conflicted");
    expectReplayExact(app.personasim.memoryRecalls, app, conflictedRun.id);
  });

  it("preserves stronger Event outcomes when the Basic fact scan is truncated", async () => {
    const harness = await createHarness({
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    for (let index = 0; index < 501; index += 1) {
      insertStableFactMemoryWithoutEvidence(app, {
        id: `memory-unrelated-scan-${index}`,
        agentId: harness.agentId,
        dedupeKey: `unrelated-scan:${index}`,
        content: "用户喜欢在公园散步。",
        tags: ["user preference", "散步"],
      });
    }
    const unrelatedPool = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(unrelatedPool.result).toMatchObject({
      abstained: true,
      abstentionReason: "requested_fact_facets_incomplete",
    });

    const session = app.personasim.conversations.createSession(
      harness.agentId,
      "Coupled explicit-fact scan outcomes",
    );
    const teaMessageId = "message-scan-coupling-tea";
    const boxMessageId = "message-scan-coupling-box";
    insertUserMessage(app, {
      id: teaMessageId,
      sessionId: session.id,
      agentId: harness.agentId,
      content: "我喝不加糖的红茶。",
      createdAtUtc: EXPLICIT_FACT_SOURCE_AT,
    });
    insertUserMessage(app, {
      id: boxMessageId,
      sessionId: session.id,
      agentId: harness.agentId,
      content: "我的钴蓝色铁盒标签写着“1998 / 潮声”。",
      createdAtUtc: EXPLICIT_FACT_SOURCE_AT,
    });
    const splitCard = sharedEventCard(app, {
      id: "event-card-scan-coupling-split",
      agentId: harness.agentId,
      messageId: teaMessageId,
      title: "分源保存的两项事实",
      summary: "用户喝不加糖的红茶。用户的钴蓝色铁盒标签写着“1998 / 潮声”。",
      occurredAtUtc: EXPLICIT_FACT_SOURCE_AT,
      evidenceSources: [
        {
          id: "event-source-scan-coupling-tea",
          messageId: teaMessageId,
          quote: "我喝不加糖的红茶。",
          recordedAtUtc: EXPLICIT_FACT_SOURCE_AT,
        },
        {
          id: "event-source-scan-coupling-box",
          messageId: boxMessageId,
          quote: "我的钴蓝色铁盒标签写着“1998 / 潮声”。",
          recordedAtUtc: EXPLICIT_FACT_SOURCE_AT,
        },
      ],
    });
    const continuity = new ContinuityRepository(app.personasim.store);
    expect(continuity.upsertEventCards([splitCard])).toBe(1);

    for (let index = 0; index < 501; index += 1) {
      insertStableFactMemoryWithoutEvidence(app, {
        id: `memory-explicit-fact-scan-${index}`,
        agentId: harness.agentId,
        dedupeKey: `explicit-fact-scan:${index}`,
      });
    }

    const blockedSelection = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
      maxEvidence: 2,
    });
    expect(blockedSelection.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_scan_truncated",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    const blockedSelectionRun = latestRun(app, harness.agentId);
    const blockedEventAttempt =
      blockedSelectionRun.inputSnapshot.hierarchy?.selectorAudit?.attempts[0];
    const blockedBasicAttempt =
      blockedSelectionRun.inputSnapshot.hierarchy?.selectorAudit?.attempts[1];
    expect(blockedEventAttempt).toMatchObject({
      tier: "event_card",
      outcome: "incomplete",
    });
    for (const facet of blockedEventAttempt?.facets ?? []) {
      expect(facet.outcome).toBe("selected");
      expect(
        facet.candidates.filter(
          (candidate) =>
            candidate.reasonCode ===
            "fact_candidate_rejected_due_scan_truncation",
        ),
      ).toHaveLength(1);
      expect(
        facet.candidates.filter(
          (candidate) => candidate.decision === "selected",
        ),
      ).toHaveLength(0);
    }
    expect(blockedBasicAttempt).toMatchObject({
      tier: "basic_memory",
      outcome: "scan_truncated",
      scannedCandidateCount: 500,
      scanUnit: "candidate_pool",
      scanLimit: 500,
    });
    expect(typeof blockedBasicAttempt?.scanWitnessMemoryId).toBe("string");
    const basicFrozenTiers =
      blockedSelectionRun.inputSnapshot.selectorAuditInput?.candidateTiers.filter(
        (candidate) => candidate.tier === "basic_memory",
      ) ?? [];
    expect(basicFrozenTiers).toHaveLength(501);
    expect(
      basicFrozenTiers.some(
        (candidate) =>
          candidate.memoryId === blockedBasicAttempt?.scanWitnessMemoryId,
      ),
    ).toBe(true);
    expect(
      blockedSelectionRun.inputSnapshot.memories.some(
        (memory) => memory.id === blockedBasicAttempt?.scanWitnessMemoryId,
      ),
    ).toBe(false);
    expectReplayExact(
      app.personasim.memoryRecalls,
      app,
      blockedSelectionRun.id,
    );

    const belowThreshold = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: { query: EXPLICIT_FACT_QUERY, minimumScore: 0.99 },
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
      maxEvidence: 2,
    });
    expect(belowThreshold.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_scan_truncated",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    const belowThresholdRun = latestRun(app, harness.agentId);
    expect(
      belowThresholdRun.inputSnapshot.hierarchy?.selectorAudit,
    ).toMatchObject({
      outcome: "scan_truncated",
      scanTruncated: true,
      attempts: [
        { tier: "event_card", outcome: "below_threshold" },
        { tier: "basic_memory", outcome: "scan_truncated" },
      ],
    });
    expectReplayExact(app.personasim.memoryRecalls, app, belowThresholdRun.id);

    const capacityInsufficient = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
      maxEvidence: 1,
    });

    expect(capacityInsufficient.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_scan_truncated",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    const run = latestRun(app, harness.agentId);
    expect(run.inputSnapshot.hierarchy?.selectorAudit).toMatchObject({
      outcome: "scan_truncated",
      scanLimit: 500,
      scanTruncated: true,
      attempts: [
        { tier: "event_card", outcome: "capacity_insufficient" },
        { tier: "basic_memory", outcome: "scan_truncated" },
      ],
    });
    expectReplayExact(app.personasim.memoryRecalls, app, run.id);

    const conflictingMessageId = "message-scan-coupling-conflict";
    insertUserMessage(app, {
      id: conflictingMessageId,
      sessionId: session.id,
      agentId: harness.agentId,
      content: "我喝加糖的红茶。我的钴蓝色铁盒标签写着“1998 / 潮声”。",
      createdAtUtc: EXPLICIT_FACT_SOURCE_AT,
    });
    const conflictingCard = sharedEventCard(app, {
      id: "event-card-scan-coupling-conflict",
      agentId: harness.agentId,
      messageId: conflictingMessageId,
      title: "与既有记录冲突的两项事实",
      summary: "用户喝加糖的红茶。用户的钴蓝色铁盒标签写着“1998 / 潮声”。",
      occurredAtUtc: EXPLICIT_FACT_SOURCE_AT,
      evidenceSources: [
        {
          id: "event-source-scan-coupling-conflict",
          messageId: conflictingMessageId,
          quote: "我喝加糖的红茶。我的钴蓝色铁盒标签写着“1998 / 潮声”。",
          recordedAtUtc: EXPLICIT_FACT_SOURCE_AT,
        },
      ],
    });
    expect(continuity.upsertEventCards([conflictingCard])).toBe(1);

    const conflicted = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
      maxEvidence: 1,
    });
    expect(conflicted.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_facets_conflicted",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    const conflictedRun = latestRun(app, harness.agentId);
    expect(conflictedRun.inputSnapshot.hierarchy?.selectorAudit).toMatchObject({
      outcome: "conflicted",
      scanTruncated: true,
      attempts: [
        { tier: "event_card", outcome: "conflicted" },
        { tier: "basic_memory", outcome: "scan_truncated" },
      ],
    });
    expectReplayExact(app.personasim.memoryRecalls, app, conflictedRun.id);
  });

  it("audits evidence past the preview cap and fails closed at the safety cap", async () => {
    const harness = await createHarness({
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const session = app.personasim.conversations.createSession(
      harness.agentId,
      "Explicit fact evidence safety",
    );
    const memoryId = "memory-explicit-fact-audit-evidence-cap";
    insertStableFactMemoryWithoutEvidence(app, {
      id: memoryId,
      agentId: harness.agentId,
      dedupeKey: "explicit-fact-audit-evidence-cap",
      content: "用户喝不加糖的红茶。",
      tags: ["user preference", "红茶"],
    });
    const insertEvidence = app.personasim.store.database.prepare(
      `INSERT INTO memory_evidence(
        id, memory_id, source_type, source_id, quote, recorded_at_utc,
        evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const appendEvidence = (index: number, content: string): void => {
      const suffix = index.toString().padStart(2, "0");
      const sourceId = `message-explicit-audit-${suffix}`;
      insertUserMessage(app!, {
        id: sourceId,
        sessionId: session.id,
        agentId: harness.agentId,
        content,
        createdAtUtc: EXPLICIT_FACT_SOURCE_AT,
      });
      const evidence = MemoryEvidenceSchema.parse({
        id: `evidence-explicit-audit-${suffix}`,
        memoryId,
        sourceType: "message",
        sourceId,
        quote: content,
        recordedAtUtc: EXPLICIT_FACT_SOURCE_AT,
      });
      insertEvidence.run(
        evidence.id,
        evidence.memoryId,
        evidence.sourceType,
        evidence.sourceId,
        evidence.quote,
        evidence.recordedAtUtc,
        JSON.stringify(evidence),
      );
    };
    for (let index = 0; index < 21; index += 1) {
      appendEvidence(
        index,
        index === 20 ? "我喝加糖的红茶。" : "我喝不加糖的红茶。",
      );
    }

    const preview = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(preview.result).toMatchObject({
      abstained: true,
      abstentionReason: "requested_fact_facets_conflicted",
    });
    const run = latestRun(app, harness.agentId);
    const candidate = run.inputSnapshot.hierarchy?.selectorAudit?.attempts
      .find((attempt) => attempt.tier === "basic_memory")
      ?.facets[0]?.candidates.find((item) => item.memoryId === memoryId);
    expect(candidate?.evidence).toHaveLength(20);
    expect(candidate?.evidenceOmittedCount).toBe(1);
    expect(candidate?.evidence).toContainEqual({
      evidenceId: "evidence-explicit-audit-20",
      decision: "rejected",
      reasonCode: "fact_evidence_value_conflict",
    });
    expectReplayExact(app.personasim.memoryRecalls, app, run.id);

    for (let index = 21; index < 101; index += 1) {
      appendEvidence(index, "我喝不加糖的红茶。");
    }
    const truncated = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(truncated.result).toMatchObject({
      abstained: true,
      abstentionReason: "requested_fact_scan_truncated",
    });
    const truncatedRun = latestRun(app, harness.agentId);
    expect(truncatedRun.inputSnapshot.hierarchy?.selectorAudit).toMatchObject({
      outcome: "scan_truncated",
      attempts: [
        { tier: "event_card", outcome: "incomplete" },
        { tier: "basic_memory", outcome: "scan_truncated" },
      ],
    });
    expectReplayExact(app.personasim.memoryRecalls, app, truncatedRun.id);
  });

  it("bounds diagnostic evidence across the full explicit-fact candidate pool", async () => {
    const harness = await createHarness({
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const session = app.personasim.conversations.createSession(
      harness.agentId,
      "Bounded explicit fact diagnostics",
    );
    const unsweetenedSourceIds: string[] = [];
    const sweetenedSourceIds: string[] = [];
    for (let index = 0; index < 21; index += 1) {
      const suffix = index.toString().padStart(2, "0");
      const unsweetenedSourceId = `message-diagnostic-unsweetened-${suffix}`;
      const sweetenedSourceId = `message-diagnostic-sweetened-${suffix}`;
      unsweetenedSourceIds.push(unsweetenedSourceId);
      sweetenedSourceIds.push(sweetenedSourceId);
      insertUserMessage(app, {
        id: unsweetenedSourceId,
        sessionId: session.id,
        agentId: harness.agentId,
        content: "我喝不加糖的红茶。",
        createdAtUtc: EXPLICIT_FACT_SOURCE_AT,
      });
      insertUserMessage(app, {
        id: sweetenedSourceId,
        sessionId: session.id,
        agentId: harness.agentId,
        content: "我喝加糖的红茶。",
        createdAtUtc: EXPLICIT_FACT_SOURCE_AT,
      });
    }
    const insertEvidence = app.personasim.store.database.prepare(
      `INSERT INTO memory_evidence(
        id, memory_id, source_type, source_id, quote, recorded_at_utc,
        evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    app.personasim.store.database.transaction(() => {
      for (let memoryIndex = 0; memoryIndex < 500; memoryIndex += 1) {
        const memorySuffix = memoryIndex.toString().padStart(3, "0");
        const memoryId = `memory-diagnostic-pool-${memorySuffix}`;
        const isConflict = memoryIndex === 499;
        const content = isConflict
          ? "用户喝加糖的红茶。"
          : "用户喝不加糖的红茶。";
        insertStableFactMemoryWithoutEvidence(app!, {
          id: memoryId,
          agentId: harness.agentId,
          dedupeKey: `diagnostic-pool:${memorySuffix}`,
          content,
          tags: ["user preference", "红茶"],
        });
        for (let evidenceIndex = 0; evidenceIndex < 21; evidenceIndex += 1) {
          const sourceId = isConflict
            ? sweetenedSourceIds[evidenceIndex]!
            : unsweetenedSourceIds[evidenceIndex]!;
          const evidence = MemoryEvidenceSchema.parse({
            id: `evidence-diagnostic-${memorySuffix}-${evidenceIndex
              .toString()
              .padStart(2, "0")}`,
            memoryId,
            sourceType: "message",
            sourceId,
            quote: isConflict ? "我喝加糖的红茶。" : "我喝不加糖的红茶。",
            recordedAtUtc: EXPLICIT_FACT_SOURCE_AT,
          });
          insertEvidence.run(
            evidence.id,
            evidence.memoryId,
            evidence.sourceType,
            evidence.sourceId,
            evidence.quote,
            evidence.recordedAtUtc,
            JSON.stringify(evidence),
          );
        }
      }
    })();

    const preview = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
      limit: 500,
    });
    expect(preview.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_facets_conflicted",
    });
    expect(preview.candidateCount).toBe(500);
    expect(preview.evidenceCount).toBe(500);
    const run = latestRun(app, harness.agentId);
    expect(run.inputSnapshot.memories).toHaveLength(500);
    expect(run.inputSnapshot.evidence).toHaveLength(500);
    expectReplayExact(app.personasim.memoryRecalls, app, run.id);
  });

  it("fails closed when the explicit-fact EventCard safety scan is truncated", async () => {
    const harness = await createHarness({
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const session = app.personasim.conversations.createSession(
      harness.agentId,
      "EventCard safety scan truncation",
    );
    const messageId = "message-event-card-scan-source";
    const source = "我喝不加糖的红茶。我的钴蓝色铁盒标签写着“1998 / 潮声”。";
    insertUserMessage(app, {
      id: messageId,
      sessionId: session.id,
      agentId: harness.agentId,
      content: source,
      createdAtUtc: "2026-10-11T14:00:00.000Z",
    });
    const cards = Array.from({ length: 501 }, (_unused, index) =>
      sharedEventCard(app, {
        id: `event-card-explicit-scan-${index.toString().padStart(3, "0")}`,
        agentId: harness.agentId,
        messageId,
        title: "饮品与铁盒标签",
        summary: source,
        occurredAtUtc: "2026-10-11T14:00:00.000Z",
      }),
    );
    expect(
      new ContinuityRepository(app.personasim.store).upsertEventCards(cards),
    ).toBe(501);

    const preview = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: session.id,
      query: EXPLICIT_FACT_QUERY,
      nowUtc: EXPLICIT_FACT_RECALL_AT,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(preview.result).toMatchObject({
      mode: "none",
      abstained: true,
      abstentionReason: "requested_fact_scan_truncated",
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    const run = latestRun(app, harness.agentId);
    expect(run.inputSnapshot.hierarchy?.selectorAudit).toMatchObject({
      outcome: "scan_truncated",
      scanLimit: 500,
      scanTruncated: true,
      attempts: [
        {
          tier: "event_card",
          outcome: "scan_truncated",
          scannedCandidateCount: 500,
          scanUnit: "candidate_pool",
          scanLimit: 500,
          scanWitnessMemoryId: "event-card-explicit-scan-500",
        },
      ],
    });
    const eventFrozenTiers =
      run.inputSnapshot.selectorAuditInput?.candidateTiers.filter(
        (candidate) => candidate.tier === "event_card",
      ) ?? [];
    expect(eventFrozenTiers).toHaveLength(501);
    expect(
      eventFrozenTiers.some(
        (candidate) => candidate.memoryId === "event-card-explicit-scan-500",
      ),
    ).toBe(true);
    expect(
      run.inputSnapshot.memories.some(
        (memory) => memory.id === "event-card-explicit-scan-500",
      ),
    ).toBe(false);
    expectReplayExact(app.personasim.memoryRecalls, app, run.id);
  });

  it("leaves narrative and unsupported checklists on the existing recall hierarchy", async () => {
    const harness = await createHarness({
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const session = app.personasim.conversations.createSession(
      harness.agentId,
      "Checklist scope",
    );
    const cases = [
      {
        id: "narrative-checklist",
        query:
          "我已经核对两件事实：我的喝茶习惯，和铁盒标签。现在只是告诉你进度。",
        occurredAtUtc: SHANGHAI_NOW,
      },
      {
        id: "unsupported-checklist",
        query: "替我核对两件旧事：我的护照号码，和公司的门禁码。只答事实。",
        occurredAtUtc: SHANGHAI_NOW,
      },
      {
        id: "reported-checklist",
        query:
          "昨天我对同事说，替我核对两件旧事：我的喝茶习惯，和铁盒标签。只答事实。",
        occurredAtUtc: "2026-08-20T04:00:00.000Z",
      },
      {
        id: "reported-checklist-mentioned",
        query:
          "昨天我对同事提到，替我核对两件旧事：我的喝茶习惯，和铁盒标签。只答事实。",
        occurredAtUtc: "2026-08-20T04:00:00.000Z",
      },
    ] as const;

    for (const item of cases) {
      const messageId = `message-${item.id}`;
      insertUserMessage(app, {
        id: messageId,
        sessionId: session.id,
        agentId: harness.agentId,
        content: item.query,
        createdAtUtc: SHANGHAI_NOW,
      });
      expect(
        new ContinuityRepository(app.personasim.store).upsertEventCards([
          sharedEventCard(app, {
            id: `event-card-${item.id}`,
            agentId: harness.agentId,
            messageId,
            title: item.query,
            summary: item.query,
            occurredAtUtc: item.occurredAtUtc,
          }),
        ]),
      ).toBe(1);
      const preview = app.personasim.memoryRecalls.preview({
        agentId: harness.agentId,
        sessionId: session.id,
        query: item.query,
        nowUtc: SHANGHAI_NOW,
        timezone: "Asia/Shanghai",
        requireDurableEvidence: true,
      });
      expect(preview.result, item.id).toMatchObject({
        mode: "event_card",
        abstained: false,
      });
      expect(
        latestRun(app, harness.agentId).inputSnapshot.hierarchy,
      ).toMatchObject({ finalTier: "event_card" });
    }

    for (const directRequest of [
      {
        query: "核对两件旧事：我的喝茶习惯，和铁盒标签。只答事实。",
        reason: "requested_fact_facets_incomplete",
      },
      {
        query: "替我核对两件旧事：我的喝茶习惯，和铁盒标签。再告诉我门禁码。",
        reason: "requested_fact_request_invalid",
      },
      {
        query: "替我核对两件旧事：我的喝茶习惯。",
        reason: "requested_fact_request_invalid",
      },
      {
        query: "替我核对两件旧事：我的喝茶习惯和铁盒标签。",
        reason: "requested_fact_request_invalid",
      },
    ]) {
      const preview = app.personasim.memoryRecalls.preview({
        agentId: harness.agentId,
        sessionId: session.id,
        query: directRequest.query,
        nowUtc: SHANGHAI_NOW,
        timezone: "Asia/Shanghai",
        requireDurableEvidence: true,
      });
      expect(preview.result).toMatchObject({
        mode: "none",
        abstained: true,
        abstentionReason: directRequest.reason,
        selectedMemoryIds: [],
        selectedEvidenceIds: [],
      });
    }
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

    const card = sharedEventCard(app, {
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

  it("persists bounded mixed-tier snapshots for basic success and final abstention", async () => {
    const harness = await createHarness({
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
    });
    app = harness.app;
    const sessionId = app.personasim.conversations.createSession(
      harness.agentId,
      "Mixed hierarchy snapshot",
    ).id;
    insertUserMessage(app, {
      id: "message-project-status",
      sessionId,
      agentId: harness.agentId,
      content: "Project status note from an earlier conversation.",
      createdAtUtc: "2026-08-20T08:00:00.000Z",
    });

    const sourceId = "source-project-codename";
    const memoryContent =
      "The character remembers project codename wing as confidential.";
    app.personasim.store.insertCharacterSource({
      id: sourceId,
      characterId: harness.agentId,
      sourceType: "test_fixture",
      title: "Project codename",
      contentExcerpt: memoryContent,
      sourceHash: "hash-project-codename",
      createdAtUtc: SHANGHAI_NOW,
    });
    const [basicMemory] = validateMergeAndPersistMemories({
      store: app.personasim.store,
      agentId: harness.agentId,
      candidates: [
        MemoryCandidateSchema.parse({
          kind: "episodic",
          content: memoryContent,
          importance: 0.2,
          confidence: 1,
          tags: ["project", "codename", "wing"],
          sourceMessageIds: [],
          sourceActivityEventIds: [],
          origin: "runtime_simulation",
          namespace: "character_self",
          certainty: "inferred",
          attribution: "model_inference",
          stability: "stable",
          evidence: [
            {
              sourceType: "character_source",
              sourceId,
              contextSummary: memoryContent,
              recordedAtUtc: SHANGHAI_NOW,
            },
          ],
          reasonCode: "character_source",
          reasonSummary: "Grounded by the character source fixture.",
        }),
      ],
      nowUtc: SHANGHAI_NOW,
      maxCandidates: 1,
    });
    if (basicMemory === undefined) {
      throw new Error("Expected a persisted basic memory");
    }

    const preview = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: {
        query: "project codename wing",
        minimumScore: 0.7,
      },
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
      limit: 5,
    });
    expect(preview.result).toMatchObject({
      mode: "basic_memory",
      abstained: false,
      selectedMemoryIds: [basicMemory.id],
    });

    const run = latestRun(app, harness.agentId);
    const hierarchy = run.inputSnapshot.hierarchy;
    expect(hierarchy).toMatchObject({ finalTier: "basic_memory" });
    expect(run.inputSnapshot.memories.length).toBeLessThanOrEqual(
      run.inputSnapshot.candidateLimit,
    );
    expect(hierarchy?.candidateTiers).toHaveLength(
      run.inputSnapshot.memories.length,
    );
    expect(hierarchy?.candidateTiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memoryId: basicMemory.id,
          tier: "basic_memory",
        }),
        expect.objectContaining({ tier: "verbatim_quote" }),
      ]),
    );
    expectReplayExact(app.personasim.memoryRecalls, app, run.id);

    const abstained = app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      query: {
        query: "project codename wing",
        minimumScore: 0.99,
      },
      nowUtc: SHANGHAI_NOW,
      timezone: "Asia/Shanghai",
      limit: 5,
    });
    expect(abstained.result).toMatchObject({
      mode: "none",
      abstained: true,
      selectedMemoryIds: [],
    });

    const abstainedRun = latestRun(app, harness.agentId);
    const abstainedHierarchy = abstainedRun.inputSnapshot.hierarchy;
    expect(abstainedHierarchy).toMatchObject({ finalTier: "none" });
    expect(abstainedRun.inputSnapshot.memories.length).toBeLessThanOrEqual(
      abstainedRun.inputSnapshot.candidateLimit,
    );
    expect(abstainedHierarchy?.candidateTiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memoryId: basicMemory.id,
          tier: "basic_memory",
        }),
        expect.objectContaining({ tier: "verbatim_quote" }),
      ]),
    );
    expectReplayExact(app.personasim.memoryRecalls, app, abstainedRun.id);
  });

  it("uses only reliable occurred EventCards as named anchors and preserves ambiguity", () => {
    const occurred = sharedEventCard(app, {
      id: "event-card-trip-occurred",
      agentId: "agent-anchor",
      messageId: "message-anchor",
      title: "trip",
      summary: "The trip occurred.",
      occurredAtUtc: "2026-08-20T04:00:00.000Z",
    });
    const planned = sharedEventCard(app, {
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
  databasePath?: string;
  explicitFactReplies?: boolean;
  adversarialOpenAiCompatibleDecisionPath?: boolean;
  lifePlanningMode?: "fuzzy" | "legacy_exact";
  chatEffectsMode?: "off" | "gated";
  scheduleNegotiationMode?: "legacy" | "enforced";
}): Promise<{ app: PersonaSimApp; agentId: string }> {
  const app = await openHarnessApp(input);
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

async function openHarnessApp(input: {
  nowUtc: string;
  databasePath?: string;
  explicitFactReplies?: boolean;
  adversarialOpenAiCompatibleDecisionPath?: boolean;
  lifePlanningMode?: "fuzzy" | "legacy_exact";
  chatEffectsMode?: "off" | "gated";
  scheduleNegotiationMode?: "legacy" | "enforced";
}): Promise<PersonaSimApp> {
  const databasePath = input.databasePath ?? ":memory:";
  const clock = new (await import("../runtime/clock.js")).FakeClock(
    input.nowUtc,
  );
  const config = readConfig({
    nodeEnv: "test",
    databasePath,
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    lifePlanningMode: input.lifePlanningMode ?? "fuzzy",
    chatEffectsMode: input.chatEffectsMode ?? "off",
    scheduleNegotiationMode: input.scheduleNegotiationMode ?? "legacy",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode:
      input.adversarialOpenAiCompatibleDecisionPath === true
        ? "enforced"
        : "off",
    memoryRecallMode: "enforced",
    llm:
      input.adversarialOpenAiCompatibleDecisionPath === true
        ? {
            provider: "openai-compatible",
            baseUrl: "https://example.invalid",
            apiKey: "test-api-key",
            model: "test-live-model",
            timeoutMs: 1_000,
            maxRetries: 0,
          }
        : {
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
    ...(input.explicitFactReplies === true
      ? {
          fixtureTurnBehavior: {
            semanticReply: ({
              userText,
              prompt,
            }: {
              userText: string;
              prompt: string;
            }) => {
              if (
                !/(?:核对|确认|复述).{0,24}(?:两|2)(?:件|个|项)/u.test(userText)
              ) {
                return undefined;
              }
              return prompt.includes(TEA_FACT) && prompt.includes(BOX_FACT)
                ? EXPLICIT_FACT_REPLY
                : EXPLICIT_FACT_REFUSAL;
            },
          },
        }
      : {}),
  });
  if (input.adversarialOpenAiCompatibleDecisionPath === true) {
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (request) => {
        if (request.purpose === "chat_turn") {
          const selected =
            request.prompt.includes(TEA_FACT) &&
            request.prompt.includes(BOX_FACT);
          const text = selected
            ? ADVERSARIAL_EXPLICIT_FACT_REPLY
            : ADVERSARIAL_PARTIAL_FACT_REPLY;
          return Promise.resolve({
            replyDecision: {
              text,
              deliveryMode: "sequential",
              chunks: text.split("\n"),
              scheduleAction: { kind: "request_details" },
            },
            worldEffects: {
              stateDelta: { stress: -0.2 },
              relationshipDelta: { trust: 0.2 },
              memoryCandidates: [
                {
                  type: "semantic",
                  content: "模型把旧事实核对误写成了新的解释性记忆。",
                  tags: ["unsafe-explicit-fact-effect"],
                },
              ],
              personalIntentCandidates: [
                {
                  activity: "整理暗房",
                  category: "other",
                  basisKind: "chat",
                  evidenceQuotes: ["周末去暗房前"],
                  reasonCode: "unsafe_explicit_fact_effect",
                  reasonSummary: "Should be blocked by the reply guard.",
                },
              ],
              continuityEffects: {
                followUpCandidates: [],
                followUpTransitions: [],
                careCueCandidates: [],
              },
            },
          } as never);
        }
        if (request.fixture !== undefined) {
          return Promise.resolve(request.fixture as never);
        }
        return Promise.reject(
          new Error(`No test fixture for ${request.purpose}`),
        );
      },
    );
  }
  return app;
}

function explicitFactSideEffectSnapshot(
  app: PersonaSimApp,
  agentId: string,
): Record<string, string> {
  return {
    memories: agentRowsSnapshot(app, "memories", agentId),
    personalIntentions: agentRowsSnapshot(app, "personal_intentions", agentId),
    followUps: agentRowsSnapshot(app, "follow_up_intents", agentId),
    careCues: agentRowsSnapshot(app, "care_cues", agentId),
    dilemmas: agentRowsSnapshot(app, "dilemma_episodes", agentId),
    pressures: agentRowsSnapshot(app, "pressure_episodes", agentId),
    interventions: agentRowsSnapshot(app, "support_interventions", agentId),
    decisions: agentRowsSnapshot(app, "decision_records", agentId),
    actions: agentRowsSnapshot(app, "action_records", agentId),
    outcomes: agentRowsSnapshot(app, "outcome_records", agentId),
    reflections: agentRowsSnapshot(app, "reflection_records", agentId),
    milestones: agentRowsSnapshot(app, "relationship_milestones", agentId),
  };
}

function explicitFactReplaySnapshot(
  app: PersonaSimApp,
  agentId: string,
): Record<string, number> {
  return {
    messages: agentRowCount(app, "messages", agentId),
    retrievalRuns: agentRowCount(app, "retrieval_runs", agentId),
    domainEvents: agentRowCount(app, "domain_events", agentId),
    rejectedProposals: agentRowCount(app, "rejected_proposals", agentId),
    stateRevision:
      app.personasim.store.getRuntimeState(agentId)?.revision ?? -1,
  };
}

function agentRowsSnapshot(
  app: PersonaSimApp,
  table:
    | "memories"
    | "personal_intentions"
    | "follow_up_intents"
    | "care_cues"
    | "dilemma_episodes"
    | "pressure_episodes"
    | "support_interventions"
    | "decision_records"
    | "action_records"
    | "outcome_records"
    | "reflection_records"
    | "relationship_milestones",
  agentId: string,
): string {
  return JSON.stringify(
    app.personasim.store.database
      .prepare(`SELECT * FROM ${table} WHERE agent_id = ? ORDER BY rowid`)
      .all(agentId),
  );
}

function agentRowCount(
  app: PersonaSimApp,
  table: "messages" | "retrieval_runs" | "domain_events" | "rejected_proposals",
  agentId: string,
): number {
  return (
    app.personasim.store.database
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE agent_id = ?`)
      .get(agentId) as { count: number }
  ).count;
}

function latestEventPayload(
  app: PersonaSimApp,
  agentId: string,
  eventType: string,
): Record<string, unknown> {
  const row = app.personasim.store.database
    .prepare(
      `SELECT payload_json AS payloadJson
       FROM domain_events
       WHERE agent_id = ? AND event_type = ?
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(agentId, eventType) as { payloadJson: string } | undefined;
  if (row === undefined) throw new Error(`Missing ${eventType} audit event`);
  return JSON.parse(row.payloadJson) as Record<string, unknown>;
}

function chatTurnModelCallCount(app: PersonaSimApp): number {
  const mockedLlm = vi.mocked(app.personasim.llm);
  return mockedLlm.generateObject.mock.calls.filter(
    ([request]) => request.purpose === "chat_turn",
  ).length;
}

/**
 * These isolated recall tests intentionally include old paraphrases, conflicting
 * facts, and a friend-owned fact misattributed to the user. Seed those legacy or
 * corrupt projections directly: the current write validator must reject them,
 * while recall must still defend against databases created before that validator.
 * Keep complete authoritative source text so recall cannot rely on cherry-picked
 * snippets supplied with the old candidate.
 */
function seedLegacyRecallFixtureMemories(
  input: Parameters<typeof validateMergeAndPersistMemories>[0],
): Memory[] {
  const source = input.store.database
    .prepare(
      "SELECT id, content FROM messages WHERE agent_id = ? AND id = ? AND role = 'user'",
    )
    .get(input.agentId, input.authoritativeMessageId) as
    { id: string; content: string } | undefined;
  if (source === undefined)
    throw new Error("Legacy recall fixture needs a user source");
  return input.store.database.transaction(() =>
    input.candidates.slice(0, input.maxCandidates).map((candidate, index) => {
      const id = `legacy-recall-${createHash("sha256")
        .update(
          JSON.stringify([input.agentId, source.id, candidate.content, index]),
        )
        .digest("hex")
        .slice(0, 24)}`;
      const memory = MemorySchema.parse({
        id,
        agentId: input.agentId,
        kind: candidate.kind,
        content: candidate.content,
        importance: candidate.importance,
        confidence: candidate.confidence,
        tags: candidate.tags,
        sourceMessageIds: [source.id],
        sourceActivityEventIds: [],
        origin: candidate.origin,
        namespace: candidate.namespace,
        certainty: candidate.certainty,
        attribution: candidate.attribution,
        stability: candidate.stability,
        ...(candidate.claim === undefined ? {} : { claim: candidate.claim }),
        temporalMetadata: candidate.temporalMetadata,
        status: "active",
        dedupeKey: id,
        createdAtUtc: input.nowUtc,
        updatedAtUtc: input.nowUtc,
      });
      input.store.database
        .prepare(
          `INSERT INTO memories(
          id, agent_id, type, content, tags_json, importance, confidence,
          source_message_id, created_at_utc, memory_json, namespace, certainty,
          attribution, stability, status, claim_subject_key, claim_disposition,
          mentioned_at_utc, recorded_at_utc, temporal_certainty, temporal_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          memory.id,
          memory.agentId,
          memory.kind,
          memory.content,
          JSON.stringify(memory.tags),
          memory.importance,
          memory.confidence,
          source.id,
          memory.createdAtUtc,
          JSON.stringify(memory),
          memory.namespace,
          memory.certainty,
          memory.attribution,
          memory.stability,
          memory.status,
          memory.claim?.subjectKey ?? null,
          memory.claim?.disposition ?? null,
          memory.temporalMetadata?.mentionedAtUtc ?? null,
          memory.temporalMetadata?.recordedAtUtc ?? input.nowUtc,
          memory.temporalMetadata?.temporalCertainty ?? "unknown",
          memory.temporalMetadata?.temporalStatus ?? "unknown",
        );
      const evidence = MemoryEvidenceSchema.parse({
        id: `evidence-${id}`,
        memoryId: id,
        sourceType: "message",
        sourceId: source.id,
        quote: source.content,
        recordedAtUtc: input.nowUtc,
      });
      input.store.database
        .prepare(
          `INSERT INTO memory_evidence(
          id, memory_id, source_type, source_id, quote, recorded_at_utc, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          evidence.id,
          memory.id,
          evidence.sourceType,
          source.id,
          evidence.quote,
          evidence.recordedAtUtc,
          JSON.stringify(evidence),
        );
      return memory;
    }),
  )();
}

function explicitUserFact(
  content: string,
  tags: string[],
  importance: number,
  recordedAtUtc: string,
  claimSubjectKey?: string,
): MemoryCandidate {
  return MemoryCandidateSchema.parse({
    kind: "semantic",
    content,
    importance,
    confidence: 0.95,
    tags,
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "stable",
    ...(claimSubjectKey === undefined
      ? {}
      : {
          claim: {
            subjectKey: claimSubjectKey,
            disposition: "affirmed",
            recordedAtUtc,
          },
        }),
    temporalMetadata: {
      mentionedAtUtc: recordedAtUtc,
      recordedAtUtc,
      temporalCertainty: "exact",
      temporalStatus: "unknown",
    },
    evidence: [],
    shouldWrite: true,
    forbiddenOverclaims: [],
    reasonCode: "explicit_user_fact",
    reasonSummary: "The user stated this fact directly.",
  });
}

function sharedEventCard(
  app: PersonaSimApp | undefined,
  input: {
    id: string;
    agentId: string;
    messageId: string;
    title: string;
    summary: string;
    occurredAtUtc?: string;
    plannedAtUtc?: string;
    evidenceSources?: Array<{
      id: string;
      messageId: string;
      quote: string;
      recordedAtUtc: string;
    }>;
  },
): EventCard {
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
  const evidence = input.evidenceSources?.map((source) => ({
    id: source.id,
    sourceType: "message_archive" as const,
    sourceId: source.messageId,
    quote: source.quote,
    temporalStatus: temporalMetadata.temporalStatus,
    reliability: "reported" as const,
    recordedAtUtc: source.recordedAtUtc,
  })) ?? [
    {
      id: evidenceId,
      sourceType: "message_archive" as const,
      sourceId: input.messageId,
      quote: input.summary,
      temporalStatus: temporalMetadata.temporalStatus,
      reliability: "reported" as const,
      recordedAtUtc,
    },
  ];
  const sourceId = `source-${input.id}`;
  // Use a real fixture event as the projection root. A fake memory id would now
  // be rejected before recall; adding a backing memory would also contaminate
  // the BasicMemory scan whose isolation and saturation these tests exercise.
  app?.personasim.store.database
    .prepare(
      `INSERT INTO domain_events(
      id, agent_id, stream_type, stream_id, stream_version, event_type,
      recorded_at_utc, effective_at_utc, payload_json, idempotency_key
    ) VALUES (?, ?, 'recall_fixture', ?, 1, 'RecallFixtureRecorded', ?, ?, ?, ?)`,
    )
    .run(
      sourceId,
      input.agentId,
      sourceId,
      recordedAtUtc,
      recordedAtUtc,
      JSON.stringify({ summary: input.summary, evidence }),
      sourceId,
    );
  return EventCardSchema.parse({
    id: input.id,
    agentId: input.agentId,
    cardKind: "shared_experience",
    sourceKind: "domain_event",
    sourceId,
    dedupeKey: input.id,
    title: input.title,
    summary: input.summary,
    tags: ["trip", "shared"],
    namespace: "shared_relationship",
    certainty: "explicit",
    attribution: "mixed",
    temporalMetadata,
    importance: 0.9,
    evidence,
    sourceEvidenceIds: evidence.map((item) => item.id),
    status: "active",
    indexVersion: 1,
    createdAtUtc: recordedAtUtc,
    updatedAtUtc: recordedAtUtc,
  });
}

function insertStableFactMemoryWithoutEvidence(
  app: PersonaSimApp,
  input: {
    id: string;
    agentId: string;
    dedupeKey: string;
    content?: string;
    tags?: string[];
  },
): void {
  const memory = MemorySchema.parse({
    id: input.id,
    agentId: input.agentId,
    kind: "semantic",
    content: input.content ?? "用户喝不加糖的红茶。",
    importance: 0.5,
    confidence: 0.95,
    tags: input.tags ?? ["user preference", "红茶"],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: "user_model",
    certainty: "explicit",
    attribution: "user_explicit",
    stability: "stable",
    temporalMetadata: {
      mentionedAtUtc: EXPLICIT_FACT_SOURCE_AT,
      recordedAtUtc: EXPLICIT_FACT_SOURCE_AT,
      temporalCertainty: "exact",
      temporalStatus: "unknown",
    },
    status: "active",
    dedupeKey: input.dedupeKey,
    createdAtUtc: EXPLICIT_FACT_SOURCE_AT,
    updatedAtUtc: EXPLICIT_FACT_SOURCE_AT,
  });
  app.personasim.store.database
    .prepare(
      `INSERT INTO memories(
        id, agent_id, type, content, tags_json, importance, confidence,
        created_at_utc, memory_json, namespace, certainty, attribution,
        stability, status, mentioned_at_utc, recorded_at_utc,
        temporal_certainty, temporal_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
