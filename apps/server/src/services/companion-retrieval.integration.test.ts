import { readFileSync } from "node:fs";

import {
  EventCardSchema,
  MemorySchema,
  type Memory,
} from "@personasim/contracts";
import {
  buildConversationContextPlan,
  selectMemoryUseForTurn,
} from "@personasim/features";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import {
  RetrievalReplayInputSchema,
  RetrievalRunRepository,
} from "../repositories/retrieval-run-repository.js";
import { FakeClock } from "../runtime/clock.js";
import { ContinuityIndexService } from "./continuity-index-service.js";
import { ContinuityMemoryRepository } from "./continuity-memory-repository.js";
import { ContinuityRepository } from "./continuity-repository.js";
import { DateDigestService } from "./date-digest-service.js";
import { MemoryRecallService } from "./memory-recall-service.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { readRecallCandidateRecords } from "./memory-service.js";

const NOW = "2026-09-06T12:00:00.000Z";
const AGENT = "agent_context_recall";
const SESSION = "session_context_recall";

describe("companion retrieval policy and frozen audit", () => {
  let database: Database;
  let store: DatabaseStore;
  let runs: RetrievalRunRepository;
  let recall: MemoryRecallService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    store = new DatabaseStore(database);
    runs = new RetrievalRunRepository(database);
    recall = new MemoryRecallService(store, runs);
    database
      .prepare(
        "INSERT INTO characters(id, current_version, status, tier, name, source_type, created_at_utc, updated_at_utc) VALUES (?, 1, 'published', 'daily', 'Context', 'original', ?, ?)",
      )
      .run(AGENT, NOW, NOW);
    database
      .prepare(
        "INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc) VALUES (?, ?, 'Context', ?, ?)",
      )
      .run(SESSION, AGENT, NOW, NOW);
  });
  afterEach(() => database.close());

  function seed(
    id: string,
    content: string,
    options: {
      quote?: string;
      importance?: number;
      stability?: Memory["stability"];
    } = {},
  ): Memory {
    const messageId = `message_${id}`;
    store.insertMessage({
      id: messageId,
      sessionId: SESSION,
      agentId: AGENT,
      role: "user",
      content: options.quote ?? content,
      messageKind: "user",
      metadata: {},
      createdAtUtc: NOW,
    });
    const memory = MemorySchema.parse({
      id,
      agentId: AGENT,
      kind: "semantic",
      content,
      tags: ["共同经历"],
      importance: options.importance ?? 0.8,
      confidence: 1,
      sourceMessageIds: [messageId],
      sourceActivityEventIds: [],
      origin: "runtime_simulation",
      namespace: "user_model",
      certainty: "explicit",
      attribution: "user_explicit",
      stability: options.stability ?? "stable",
      status: "active",
      dedupeKey: id,
      createdAtUtc: NOW,
      updatedAtUtc: NOW,
    });
    database
      .prepare(
        "INSERT INTO memories(id, agent_id, type, content, tags_json, importance, confidence, created_at_utc, memory_json, status, namespace, certainty, attribution, stability) VALUES (?, ?, 'semantic', ?, ?, ?, 1, ?, ?, 'active', 'user_model', 'explicit', 'user_explicit', ?)",
      )
      .run(
        id,
        AGENT,
        content,
        JSON.stringify(memory.tags),
        memory.importance,
        NOW,
        JSON.stringify(memory),
        memory.stability,
      );
    const evidence = {
      id: `evidence_${id}`,
      memoryId: id,
      sourceType: "message",
      sourceId: messageId,
      quote: options.quote ?? content,
      recordedAtUtc: NOW,
    };
    database
      .prepare(
        "INSERT INTO memory_evidence(id, memory_id, source_type, source_id, quote, recorded_at_utc, evidence_json) VALUES (?, ?, 'message', ?, ?, ?, ?)",
      )
      .run(
        evidence.id,
        id,
        messageId,
        evidence.quote,
        NOW,
        JSON.stringify(evidence),
      );
    return memory;
  }

  function context(query: string, sources: string[] = []) {
    return buildConversationContextPlan({
      originalQuery: query,
      agentId: AGENT,
      sessionId: SESSION,
      recentMessages: sources.map((text, index) => ({
        id: `source_${index}`,
        agentId: AGENT,
        sessionId: SESSION,
        role: "user",
        text,
      })),
    });
  }

  it("preserves selected source relevance through persisted recall, replay, and memory use", () => {
    seed("drink", "烘焙乌龙", { quote: "饮料喜好：烘焙乌龙" });
    const query = "饮料喜好";
    const preview = recall.preview({
      agentId: AGENT,
      query,
      contextPlan: context(query),
      nowUtc: NOW,
    });
    expect(preview.result.abstained).toBe(false);
    if (preview.result.abstained) return;
    expect(
      selectMemoryUseForTurn({
        plan: context(query),
        evidence: preview.result.evidenceBundle.evidence,
      }).explicitMentionEvidenceIds,
    ).toEqual(["evidence_drink"]);
    const snapshot = runs.listByAgent(AGENT)[0]!.inputSnapshot;
    expect(recall.replay(snapshot)).toEqual(preview.result);
    expect(
      preview.result.evidenceBundle.evidence[0]?.relevance?.reasons,
    ).toContain("lexical");
  });

  it.each([false, true])(
    "recalls a day-31 aging episode explicitly after restart, with hierarchy=%s",
    (hierarchy) => {
      const memory = seed("pottery", "我们去过苔藓陶艺展。", {
        importance: 0.4,
        stability: "one_off",
      });
      const repository = new ContinuityMemoryRepository(store);
      const clock = new FakeClock(NOW);
      const lifecycle = new MemoryLifecycleService(repository, clock);
      const makeRecall = () =>
        new MemoryRecallService(
          store,
          runs,
          hierarchy
            ? {
                continuityIndex: new ContinuityIndexService(
                  new ContinuityRepository(store),
                  clock,
                ),
                dateDigests: new DateDigestService(repository),
              }
            : undefined,
        );
      const query = "你还记得我们去过苔藓陶艺展吗？";
      const input = () => ({
        agentId: AGENT,
        query,
        nowUtc: clock.nowUtc(),
        timezone: "Asia/Shanghai",
        requireDurableEvidence: true,
      });
      clock.setUtc(new Date(Date.parse(NOW) + 29 * 86_400_000).toISOString());
      expect(lifecycle.maintainAgent(AGENT).transitions).toEqual([]);
      expect(makeRecall().recall(input()).selectedMemoryIds).toEqual([
        memory.id,
      ]);
      clock.setUtc(new Date(Date.parse(NOW) + 31 * 86_400_000).toISOString());
      expect(lifecycle.maintainAgent(AGENT).transitions).toEqual([
        expect.objectContaining({ memoryId: memory.id, toStatus: "aging" }),
      ]);
      const restarted = makeRecall();
      const preview = restarted.preview(input());
      expect(preview.result.selectedMemoryIds).toEqual([memory.id]);
      expect(
        restarted.replay(runs.listByAgent(AGENT)[0]!.inputSnapshot),
      ).toEqual(preview.result);
      expect(repository.getLifecycleMemory(memory.id)?.memory.status).toBe(
        "aging",
      );
      expect(
        restarted.recall({ ...input(), query: "苔藓陶艺展" }).selectedMemoryIds,
      ).toEqual([]);
      expect(
        restarted.recall({
          ...input(),
          query: "你还记得我现在去哪个苔藓陶艺展吗？",
        }).selectedMemoryIds,
      ).toEqual([]);
      expect(
        readRecallCandidateRecords(store, AGENT, clock.nowUtc(), {
          candidateLimit: 50,
          query,
          originalQuery: "今天喝什么",
        }),
      ).toEqual([]);
      expect(
        restarted.recall({ ...input(), suppressedMemoryIds: [memory.id] })
          .selectedMemoryIds,
      ).toEqual([]);
      database
        .prepare("UPDATE memories SET valid_until_utc = ? WHERE id = ?")
        .run(clock.nowUtc(), memory.id);
      expect(restarted.recall(input()).selectedMemoryIds).toEqual([]);
      database
        .prepare(
          "UPDATE memories SET valid_until_utc = NULL, status = 'archived' WHERE id = ?",
        )
        .run(memory.id);
      expect(restarted.recall(input()).selectedMemoryIds).toEqual([]);
    },
  );

  it("uses unresolved reference candidates without replacing the original query, and replays after sources change", () => {
    seed("sister", "姐姐准备搬家到苏州。");
    const query = "她又那样了";
    const plan = context(query, [
      "姐姐准备搬家到苏州。",
      "同事最近也在准备搬家。",
    ]);
    const legacy = recall.preview({ agentId: AGENT, query, nowUtc: NOW });
    expect(legacy.result.abstained).toBe(true);
    const preview = recall.preview({
      agentId: AGENT,
      query,
      contextPlan: plan,
      nowUtc: NOW,
    });
    expect(preview.query.query).toBe(query);
    expect(preview.query.contextPlan?.unresolvedReferences).toEqual([
      "她",
      "那样",
    ]);
    expect(preview.result.selectedMemoryIds).toContain("sister");
    expect(preview.strategy.name).toBe("continuity_context_v2");
    const run = runs.listByAgent(AGENT)[0]!;
    expect(run.inputSnapshot.query.contextPlan).toEqual(plan);
    expect(run.stages[0]?.snapshot).toMatchObject({
      originalQuery: query,
      expandedQueries: plan.expandedQueries,
      contextMessageIds: plan.contextMessageIds,
    });
    database
      .prepare(
        "UPDATE memories SET content = 'changed after recall' WHERE id = 'sister'",
      )
      .run();
    expect(recall.replay(run.inputSnapshot)).toEqual(preview.result);
    expect(recall.replay(runs.listByAgent(AGENT)[1]!.inputSnapshot)).toEqual(
      legacy.result,
    );
  });

  it("records at most eight complex recollection items and keeps old strategy budgets fixed at three", () => {
    for (let index = 0; index < 10; index += 1)
      seed(`recap_${index}`, `共同经历第${index}次：我们一起看了海。`);
    const query = "回顾所有共同经历的变化";
    const legacy = recall.preview({
      agentId: AGENT,
      query,
      nowUtc: NOW,
      maxEvidence: 8,
    });
    expect(legacy.result.selectedMemoryIds).toHaveLength(3);
    const preview = recall.preview({
      agentId: AGENT,
      query,
      contextPlan: context(query),
      nowUtc: NOW,
      maxEvidence: 99,
    });
    expect(preview.result.selectedMemoryIds).toHaveLength(8);
    expect(preview.selectedItems).toHaveLength(8);
    const run = runs.listByAgent(AGENT)[0]!;
    expect(
      run.candidates.filter((item) => item.decision === "selected"),
    ).toHaveLength(8);
    expect(recall.replay(run.inputSnapshot)).toEqual(preview.result);
    expect(() =>
      RetrievalReplayInputSchema.parse({
        ...run.inputSnapshot,
        strategyVersion: undefined,
        query: { query },
      }),
    ).toThrow(/budget/iu);
    expect(() =>
      recall.preview({
        agentId: AGENT,
        query: "另一个问题",
        contextPlan: context(query),
        nowUtc: NOW,
      }),
    ).toThrow(/original query/iu);
  });

  it("expands the existing durable EventCard tier to eight without using expansion as explicit fact intent", () => {
    const continuity = new ContinuityRepository(store);
    recall = new MemoryRecallService(store, runs, {
      continuityIndex: new ContinuityIndexService(
        continuity,
        new FakeClock(NOW),
      ),
      dateDigests: new DateDigestService(new ContinuityMemoryRepository(store)),
    });
    for (let index = 0; index < 9; index += 1) {
      const id = `shared_${index}`;
      const content = `共同经历第${index}次：我们一起看了海。`;
      seed(id, content);
      continuity.upsertEventCards([
        EventCardSchema.parse({
          id: `card_${id}`,
          agentId: AGENT,
          cardKind: "shared_experience",
          sourceKind: "memory",
          sourceId: id,
          dedupeKey: id,
          title: content,
          summary: content,
          tags: ["共同经历"],
          namespace: "shared_relationship",
          certainty: "explicit",
          attribution: "mixed",
          temporalMetadata: {
            occurredStartAtUtc: NOW,
            recordedAtUtc: NOW,
            temporalCertainty: "exact",
            temporalStatus: "occurred",
          },
          evidence: [
            {
              id: `card_evidence_${id}`,
              sourceType: "message_archive",
              sourceId: `message_${id}`,
              quote: content,
              temporalStatus: "occurred",
              reliability: "reported",
              recordedAtUtc: NOW,
            },
          ],
          sourceEvidenceIds: [`card_evidence_${id}`],
          importance: 0.8,
          status: "active",
          indexVersion: 1,
          createdAtUtc: NOW,
          updatedAtUtc: NOW,
        }),
      ]);
    }
    const query = "回顾所有共同经历的变化";
    const preview = recall.preview({
      agentId: AGENT,
      query,
      contextPlan: context(query),
      timezone: "Asia/Shanghai",
      nowUtc: NOW,
      requireDurableEvidence: true,
    });
    expect(preview.result.mode).toBe("event_card");
    expect(preview.result.selectedMemoryIds).toHaveLength(8);
    expect(recall.replay(runs.listByAgent(AGENT)[0]!.inputSnapshot)).toEqual(
      preview.result,
    );
    const referenceQuery = "她呢";
    recall.preview({
      agentId: AGENT,
      query: referenceQuery,
      contextPlan: context(referenceQuery, [
        "核对两件旧事：我喝茶的习惯和铁盒标签。",
      ]),
      timezone: "Asia/Shanghai",
      nowUtc: NOW,
      requireDurableEvidence: true,
    });
    expect(
      runs.listByAgent(AGENT)[0]?.inputSnapshot.hierarchy?.selectorAudit,
    ).toBeUndefined();
  });

  it("migrates old retrieval rows without changing their snapshots, order, or immutability", () => {
    // Recreate the exact legacy empty table, then write authentic v1 audit rows.
    database.exec(
      readFileSync(
        new URL(
          "../db/migrations/014_retrieval_run_date_digest.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    seed("migration_memory", "共同经历：我们一起看了海。");
    recall.preview({ agentId: AGENT, query: "共同经历", nowUtc: NOW });
    recall.preview({ agentId: AGENT, query: "不存在的线索", nowUtc: NOW });
    const before = database
      .prepare("SELECT rowid, * FROM retrieval_runs ORDER BY rowid")
      .all();
    database.transaction(() =>
      database.exec(
        readFileSync(
          new URL(
            "../db/migrations/022_retrieval_context_budget.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      ),
    )();
    expect(
      database
        .prepare("SELECT rowid, * FROM retrieval_runs ORDER BY rowid")
        .all(),
    ).toEqual(before);
    const run = runs.listByAgent(AGENT)[0]!;
    expect(recall.replay(run.inputSnapshot)).toEqual(run.result);
    expect(() =>
      database
        .prepare("UPDATE retrieval_runs SET selected_count = 0 WHERE id = ?")
        .run(run.id),
    ).toThrow(/immutable/iu);
    expect(() =>
      database.prepare("DELETE FROM retrieval_runs WHERE id = ?").run(run.id),
    ).toThrow(/immutable/iu);
  });
});
