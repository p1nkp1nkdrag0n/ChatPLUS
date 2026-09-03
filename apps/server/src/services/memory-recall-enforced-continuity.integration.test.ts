import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import { companionLongRunV3FixtureBehavior } from "../scenarios/companion-long-run-v3-fixture.js";
import { companionLongRunV3Manifest } from "../scenarios/companion-long-run-v3-manifest.js";

const NOW = "2026-09-01T01:00:00.000Z";

describe("enforced durable continuity recall", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app !== undefined) await app.close();
    app = undefined;
  });

  it("uses active durable corrected facts for every reviewed current-fact probe", async () => {
    const harness = await createHarness();
    app = harness.app;
    const generate = vi.spyOn(app.personasim.llm, "generateObject");

    for (const candidateNumber of [12, 13, 14, 15, 16, 17]) {
      await expectSuccessfulTurn(harness, candidateNumber);
    }

    for (const candidateNumber of [20, 22, 24, 98]) {
      const response = await expectSuccessfulTurn(harness, candidateNumber);
      expect(response.assistantMessage.content, `T${candidateNumber}`).toBe(
        reviewedReply(candidateNumber),
      );
      assertLatestDurableRecall(
        harness.app,
        harness.agentId,
        `T${candidateNumber}`,
      );
      if (candidateNumber === 22) {
        const result = latestRun(harness.app, harness.agentId).result;
        expect(result.selectedMemoryIds).toHaveLength(2);
        expect(result.selectedEvidenceIds).toHaveLength(2);
        expect(selectedMemoryContents(harness.app, harness.agentId)).toEqual(
          expect.arrayContaining([
            "许宁是用户最好的朋友。",
            "许宁准备去重庆进修。",
          ]),
        );
        if (result.abstained) throw new Error("Expected linked friend facts");
        expect(
          result.evidenceBundle.evidence.every(
            (item) =>
              item.evidence.sourceId ===
              messageIdForTurn(harness.app, harness.agentId, 15),
          ),
        ).toBe(true);
        assertLatestRecallReplays(harness.app, harness.agentId);
      }
    }

    const notebookRun = latestRun(harness.app, harness.agentId);
    expect(notebookRun.result.abstained).toBe(false);
    if (notebookRun.result.abstained) {
      throw new Error("Expected the corrected notebook fact");
    }
    const notebookEvidence = notebookRun.result.evidenceBundle.evidence[0];
    expect(notebookEvidence?.memoryContent).toContain("藏青色");
    expect(notebookEvidence?.evidence.sourceType).toBe("message");
    expect(notebookEvidence?.evidence.sourceId).toBe(
      messageIdForTurn(harness.app, harness.agentId, 14),
    );
    expect(latestChatPrompt(generate.mock.calls)).toContain(
      '"mode":"basic_memory"',
    );
    expect(latestChatPrompt(generate.mock.calls)).toContain("藏青色");

    await expectSuccessfulTurn(harness, 99);
    const destinationResponse = await expectSuccessfulTurn(harness, 101);
    expect(destinationResponse.assistantMessage.content).toBe(
      "许宁现在准备去成都进修。",
    );
    assertLatestDurableRecall(harness.app, harness.agentId, "T101");

    const destinationRun = latestRun(harness.app, harness.agentId);
    expect(destinationRun.result.abstained).toBe(false);
    if (destinationRun.result.abstained) {
      throw new Error("Expected the corrected destination fact");
    }
    expect(destinationRun.result.evidenceBundle.evidence[0]).toMatchObject({
      memoryContent: "许宁准备去成都进修。",
      evidence: {
        sourceType: "message",
        sourceId: messageIdForTurn(harness.app, harness.agentId, 99),
      },
    });
    expect(selectedMemoryContents(harness.app, harness.agentId)).toContain(
      "许宁准备去成都进修。",
    );
    expect(selectedMemoryContents(harness.app, harness.agentId)).not.toEqual(
      expect.arrayContaining([expect.stringContaining("重庆")]),
    );
    expect(
      destinationRun.result.evidenceBundle.evidence.every(
        (item) => !item.memoryContent.includes("重庆"),
      ),
    ).toBe(true);

    const lifecycleRows = harness.app.personasim.store.database
      .prepare(
        `SELECT content, status, superseded_by_id AS supersededById
         FROM memories
         WHERE agent_id = ? AND claim_subject_key IN (?, ?)
         ORDER BY created_at_utc, id`,
      )
      .all(
        harness.agentId,
        "user_fact:item:notes:storage",
        "user_fact:person:许宁:destination",
      ) as Array<{
      content: string;
      status: string;
      supersededById: string | null;
    }>;
    const oldNotebook = lifecycleRows.find((row) =>
      row.content.includes("绿色"),
    );
    const currentNotebook = lifecycleRows.find((row) =>
      row.content.includes("藏青色"),
    );
    const oldDestination = lifecycleRows.find((row) =>
      row.content.includes("重庆"),
    );
    const currentDestination = lifecycleRows.find((row) =>
      row.content.includes("成都"),
    );
    expect(oldNotebook?.status).toBe("superseded");
    expect(oldNotebook?.supersededById).toEqual(expect.any(String));
    expect(currentNotebook).toMatchObject({
      status: "active",
      supersededById: null,
    });
    expect(oldDestination?.status).toBe("superseded");
    expect(oldDestination?.supersededById).toEqual(expect.any(String));
    expect(currentDestination).toMatchObject({
      status: "active",
      supersededById: null,
    });
  });

  it("persists and recalls cross-session stop boundaries and relationship repair", async () => {
    const harness = await createHarness();
    app = harness.app;

    harness.clock.setUtc("2026-09-25T01:00:00.000Z");
    for (const candidateNumber of [85, 87, 90]) {
      await expectSuccessfulTurn(harness, candidateNumber);
    }
    harness.clock.setUtc("2026-09-27T01:00:00.000Z");
    harness.sessionId = harness.app.personasim.conversations.createSession(
      harness.agentId,
      "Boundary recall session",
    ).id;

    const boundary = await expectSuccessfulTurn(harness, 92);
    expect(boundary.assistantMessage.content).toBe(
      "你要求暂时停止讨论工作选择。",
    );
    assertLatestDurableRecall(harness.app, harness.agentId, "T92");
    expect(selectedMemoryContents(harness.app, harness.agentId)).toContain(
      "用户明确要求停止讨论工作选择。",
    );

    for (const candidateNumber of [94, 95, 96]) {
      await expectSuccessfulTurn(harness, candidateNumber);
    }
    harness.clock.setUtc("2026-09-28T01:00:00.000Z");
    const repair = await expectSuccessfulTurn(harness, 97);
    expect(repair.assistantMessage.content).toBe(reviewedReply(97));
    assertLatestDurableRecall(harness.app, harness.agentId, "T97");
    expect(
      latestRun(harness.app, harness.agentId).result.selectedMemoryIds,
    ).toHaveLength(2);
    expect(selectedMemoryContents(harness.app, harness.agentId)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^关系分歧/u),
        expect.stringMatching(/^关系修复/u),
      ]),
    );
    assertSelectedEvidenceUsesUserMessages(harness.app, harness.agentId);
    assertConflictRepairEvidenceSources(harness.app, harness.agentId);
    assertLatestRecallReplays(harness.app, harness.agentId);

    const relationshipRows = harness.app.personasim.store.database
      .prepare(
        `SELECT type, namespace, attribution, claim_subject_key AS claimSubjectKey,
           tags_json AS tagsJson
         FROM memories
         WHERE agent_id = ? AND status = 'active'
           AND superseded_by_id IS NULL AND merged_into_id IS NULL
           AND tags_json LIKE '%relationship event%'
         ORDER BY created_at_utc, id`,
      )
      .all(harness.agentId) as Array<{
      type: string;
      namespace: string;
      attribution: string;
      claimSubjectKey: string | null;
      tagsJson: string;
    }>;
    // Equivalent boundary/repair restatements may be lifecycle-merged, but
    // each typed facet must remain represented by an active durable record.
    expect(relationshipRows.length).toBeGreaterThanOrEqual(4);
    expect(
      relationshipRows.every((row) => {
        const tags = JSON.parse(row.tagsJson) as unknown;
        return (
          row.type === "relationship" &&
          row.namespace === "shared_relationship" &&
          row.attribution === "mixed" &&
          row.claimSubjectKey?.startsWith("relationship:") === true &&
          Array.isArray(tags) &&
          tags.some(
            (tag: unknown) =>
              typeof tag === "string" && tag.startsWith("episode "),
          )
        );
      }),
    ).toBe(true);
    const activeTags = relationshipRows.flatMap((row) => {
      const tags = JSON.parse(row.tagsJson) as unknown;
      return Array.isArray(tags)
        ? tags.filter((tag): tag is string => typeof tag === "string")
        : [];
    });
    expect(activeTags).toEqual(
      expect.arrayContaining([
        "relationship boundary",
        "relationship conflict",
        "relationship repair",
        "relationship causal correction",
      ]),
    );

    harness.clock.setUtc("2026-09-30T01:00:00.000Z");
    for (const candidateNumber of [107]) {
      const response = await expectSuccessfulTurn(harness, candidateNumber);
      expect(response.assistantMessage.content, `T${candidateNumber}`).toBe(
        reviewedReply(candidateNumber),
      );
      assertLatestDurableRecall(
        harness.app,
        harness.agentId,
        `T${candidateNumber}`,
      );
      expect(selectedMemoryContents(harness.app, harness.agentId)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^关系分歧/u),
          expect.stringMatching(/^关系修复/u),
        ]),
      );
      expect(
        latestRun(harness.app, harness.agentId).result.selectedMemoryIds,
      ).toHaveLength(2);
      assertSelectedRelationshipMemoriesUseUserEvidence(
        harness.app,
        harness.agentId,
      );
      assertConflictRepairEvidenceSources(harness.app, harness.agentId);
      assertLatestRecallReplays(harness.app, harness.agentId);
    }
  });

  it("fails closed instead of selecting an archive-only synthetic memory", async () => {
    const harness = await createHarness();
    app = harness.app;
    await sendText(
      harness,
      "archive-only-source",
      "The saffron constellation phrase exists only in this old message.",
    );

    const preview = harness.app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: harness.sessionId,
      query: "saffron constellation",
      nowUtc: NOW,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });

    expect(preview.result).toMatchObject({
      mode: "none",
      abstained: true,
      selectedMemoryIds: [],
    });
    expect(preview.result).not.toHaveProperty("evidenceBundle");
    expect(
      latestRun(harness.app, harness.agentId).inputSnapshot.hierarchy,
    ).toMatchObject({ finalTier: "none" });
  });

  it("does not relax mixed relationship memory without user-authored message evidence", async () => {
    const harness = await createHarness();
    app = harness.app;
    harness.clock.setUtc("2026-09-25T01:00:00.000Z");
    await expectSuccessfulTurn(harness, 85);

    const relationshipRows = harness.app.personasim.store.database
      .prepare(
        `SELECT id FROM memories
         WHERE agent_id = ? AND status = 'active'
           AND tags_json LIKE '%relationship%'`,
      )
      .all(harness.agentId) as Array<{ id: string }>;
    expect(relationshipRows).toHaveLength(1);
    const memoryId = relationshipRows[0]?.id;
    if (memoryId === undefined) throw new Error("Expected relationship memory");
    harness.app.personasim.store.database
      .prepare(
        `UPDATE memories
         SET namespace = 'shared_relationship', attribution = 'mixed'
         WHERE id = ?`,
      )
      .run(memoryId);
    const source = harness.app.personasim.store.database
      .prepare(
        `SELECT source_id AS sourceId FROM memory_evidence
         WHERE memory_id = ? AND source_type = 'message'`,
      )
      .get(memoryId) as { sourceId: string } | undefined;
    if (source === undefined) throw new Error("Expected message evidence");
    harness.app.personasim.store.database
      .prepare("UPDATE messages SET role = 'assistant' WHERE id = ?")
      .run(source.sourceId);

    const preview = harness.app.personasim.memoryRecalls.preview({
      agentId: harness.agentId,
      sessionId: harness.sessionId,
      query: manifestText(107),
      nowUtc: harness.clock.nowUtc(),
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
    });
    expect(preview.result).toMatchObject({
      mode: "none",
      abstained: true,
      selectedMemoryIds: [],
      abstentionReason: "no_durable_memory_evidence",
    });
  });
});

type Harness = {
  app: PersonaSimApp;
  agentId: string;
  sessionId: string;
  clock: FakeClock;
};

async function createHarness(): Promise<Harness> {
  const clock = new FakeClock(NOW);
  const config = readConfig({
    nodeEnv: "test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    chatEffectsMode: "off",
    lifePlanningMode: "fuzzy",
    scheduleNegotiationMode: "legacy",
    liveWorldEffectsMode: "enforced",
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
    fixtureTurnBehavior: companionLongRunV3FixtureBehavior,
  });
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "顾澜",
      worldSetting: "2026 年的上海",
      workOrRole: "纪录片剪辑师兼社区夜校讲师",
      coreTraits: ["温和直接", "观察细致", "尊重边界"],
      centralContradiction: "创作完整性与现实压力",
      primaryGoal: "完成纪录片《夜航》",
      relationshipToUser: "朋友",
      dialogueStyle: "自然简洁",
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    },
  });
  expect(generated.statusCode, generated.body).toBe(201);
  const draft = jsonBody<{ character: { id: string; version: number } }>(
    generated,
  ).character;
  const published = await app.inject({
    method: "POST",
    url: `/api/characters/${draft.id}/publish`,
    payload: { expectedVersion: draft.version },
  });
  expect(published.statusCode, published.body).toBe(200);
  return {
    app,
    agentId: draft.id,
    clock,
    sessionId: app.personasim.conversations.createSession(
      draft.id,
      "Durable recall session",
    ).id,
  };
}

async function expectSuccessfulTurn(harness: Harness, candidateNumber: number) {
  return sendText(
    harness,
    `v3-${candidateNumber}`,
    manifestText(candidateNumber),
  );
}

async function sendText(
  harness: Harness,
  suffix: string,
  text: string,
): Promise<{ assistantMessage: { content: string } }> {
  const response = await harness.app.inject({
    method: "POST",
    url: `/api/sessions/${harness.sessionId}/messages`,
    payload: {
      agentId: harness.agentId,
      clientMessageId: `client-${suffix}-${harness.sessionId}`,
      text,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return jsonBody<{ assistantMessage: { content: string } }>(response);
}

function assertLatestDurableRecall(
  app: PersonaSimApp,
  agentId: string,
  label: string,
): void {
  const run = latestRun(app, agentId);
  if (run.result.abstained) {
    throw new Error(
      `${label} abstained: ${JSON.stringify({ result: run.result, candidates: run.candidates.map((candidate) => ({ memoryId: candidate.memoryId, score: candidate.score, decision: candidate.decision, reasonCode: candidate.reasonCode })) })}`,
    );
  }
  expect(run.result, label).toMatchObject({
    mode: "basic_memory",
    abstained: false,
  });
  expect(run.result.selectedMemoryIds.length).toBeGreaterThan(0);
  for (const memoryId of run.result.selectedMemoryIds) {
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT status, superseded_by_id AS supersededById,
            merged_into_id AS mergedIntoId
           FROM memories WHERE id = ? AND agent_id = ?`,
        )
        .get(memoryId, agentId),
    ).toEqual({
      status: "active",
      supersededById: null,
      mergedIntoId: null,
    });
  }
  for (const item of run.result.evidenceBundle.evidence) {
    expect(
      app.personasim.store.database
        .prepare(
          "SELECT memory_id AS memoryId FROM memory_evidence WHERE id = ?",
        )
        .get(item.evidence.id),
    ).toEqual({ memoryId: item.memoryId });
  }
}

function selectedMemoryContents(app: PersonaSimApp, agentId: string): string[] {
  const run = latestRun(app, agentId);
  if (run.result.abstained) return [];
  return run.result.selectedMemoryIds.flatMap((id) => {
    const row = app.personasim.store.database
      .prepare("SELECT content FROM memories WHERE id = ? AND agent_id = ?")
      .get(id, agentId) as { content: string } | undefined;
    return row === undefined ? [] : [row.content];
  });
}

function assertSelectedRelationshipMemoriesUseUserEvidence(
  app: PersonaSimApp,
  agentId: string,
): void {
  const run = latestRun(app, agentId);
  if (run.result.abstained) {
    throw new Error("Expected grounded shared relationship recall");
  }
  for (const item of run.result.evidenceBundle.evidence) {
    expect(item).toMatchObject({
      namespace: "shared_relationship",
      attribution: "mixed",
    });
    const memory = app.personasim.store.database
      .prepare(
        `SELECT namespace, attribution, status,
          superseded_by_id AS supersededById,
          merged_into_id AS mergedIntoId
         FROM memories WHERE id = ? AND agent_id = ?`,
      )
      .get(item.memoryId, agentId);
    expect(memory).toEqual({
      namespace: "shared_relationship",
      attribution: "mixed",
      status: "active",
      supersededById: null,
      mergedIntoId: null,
    });
    expect(item.evidence.sourceType).toBe("message");
  }
  assertSelectedEvidenceUsesUserMessages(app, agentId);
}

function assertSelectedEvidenceUsesUserMessages(
  app: PersonaSimApp,
  agentId: string,
): void {
  const run = latestRun(app, agentId);
  if (run.result.abstained) throw new Error("Expected selected user evidence");
  for (const item of run.result.evidenceBundle.evidence) {
    expect(item.evidence.sourceType).toBe("message");
    expect(
      app.personasim.store.database
        .prepare("SELECT role FROM messages WHERE id = ? AND agent_id = ?")
        .get(item.evidence.sourceId, agentId),
    ).toEqual({ role: "user" });
  }
}

function assertConflictRepairEvidenceSources(
  app: PersonaSimApp,
  agentId: string,
): void {
  const run = latestRun(app, agentId);
  if (run.result.abstained)
    throw new Error("Expected conflict/repair evidence");
  const sourceIds = new Set(
    run.result.evidenceBundle.evidence.map((item) => item.evidence.sourceId),
  );
  expect(sourceIds.has(messageIdForTurn(app, agentId, 85))).toBe(true);
  expect(
    [95, 96].some((turn) =>
      sourceIds.has(messageIdForTurn(app, agentId, turn)),
    ),
  ).toBe(true);
}

function assertLatestRecallReplays(app: PersonaSimApp, agentId: string): void {
  const run = latestRun(app, agentId);
  expect(app.personasim.memoryRecalls.replay(run.inputSnapshot)).toEqual(
    run.result,
  );
}

function latestRun(app: PersonaSimApp, agentId: string) {
  const run = app.personasim.retrievalRuns.listByAgent(agentId, 1)[0];
  if (run === undefined) throw new Error("Expected a retrieval run");
  return run;
}

function latestChatPrompt(
  calls: ReadonlyArray<
    readonly [{ purpose: string; prompt: string }, ...unknown[]]
  >,
): string {
  const call = calls.findLast(([input]) => input.purpose === "chat_turn");
  if (call === undefined) throw new Error("Expected a chat call");
  return call[0].prompt;
}

function messageIdForTurn(
  app: PersonaSimApp,
  agentId: string,
  candidateNumber: number,
): string {
  const row = app.personasim.store.database
    .prepare(
      `SELECT id FROM messages
       WHERE agent_id = ? AND role = 'user' AND content = ?
       ORDER BY created_at_utc DESC, id DESC LIMIT 1`,
    )
    .get(agentId, manifestText(candidateNumber)) as { id: string } | undefined;
  if (row === undefined)
    throw new Error(`Expected T${candidateNumber} message`);
  return row.id;
}

function manifestText(candidateNumber: number): string {
  const turn = companionLongRunV3Manifest.sharedTurns[candidateNumber - 1];
  if (turn === undefined || typeof turn.userText !== "string") {
    throw new Error(`T${candidateNumber} has no literal text`);
  }
  return turn.userText;
}

function reviewedReply(candidateNumber: number): string {
  const replies = new Map<number, string>([
    [20, "你那本采访笔记在藏青色帆布包的内层，书签是 M-417。"],
    [22, "你之前提到的朋友叫许宁，她当时准备去重庆进修。"],
    [
      24,
      "我有把握的三件事：你叫林舟；采访笔记在藏青色帆布包内层、书签是 M-417；你最好的朋友叫许宁。",
    ],
    [
      97,
      "分歧是我把我们的选择说得太像、显得自以为完全理解你；修复是尊重你叫停，并更准确地区分影响、建议、强迫和各自责任。",
    ],
    [98, "你那本采访笔记在藏青色帆布包的内层，书签是 M-417。"],
    [
      107,
      "具体积累包括：我先按你要求只听、后来陪你分析选择；你授权我作出一个决定但行动由你完成；结果出现后我们一起面对复杂感受；发生分歧后你叫停、指出责任表达的问题，我们再把边界和修复说清楚。",
    ],
  ]);
  const value = replies.get(candidateNumber);
  if (value === undefined)
    throw new Error(`Missing reply for T${candidateNumber}`);
  return value;
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
