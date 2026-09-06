import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventCardSchema, type Memory } from "@personasim/contracts";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";
import { FakeClock } from "../runtime/clock.js";
import {
  AutobiographyService,
  type VerifiedContinuityEvidence,
} from "./autobiography-service.js";
import { checkpointSourceHash } from "./checkpoint-service.js";
import { ContinuityIndexService } from "./continuity-index-service.js";
import { ContinuityMemoryRepository } from "./continuity-memory-repository.js";
import { ContinuityRepository } from "./continuity-repository.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { MemoryRecallService } from "./memory-recall-service.js";
import { DateDigestService } from "./date-digest-service.js";
import { ConversationContextService } from "./conversation-context-service.js";
import type { ConversationContinuityService } from "./conversation-continuity-service.js";
import type { CalendarService } from "./calendar-service.js";
import {
  readMemoryEvidence,
  readRecallCandidateRecords,
  readStableExplicitUserMemoryScan,
  validateMergeAndPersistMemories,
} from "./memory-service.js";

const AGENT = "agent-validity";
const SESSION = "session-validity";
const NOW = "2026-09-06T10:00:00.000Z";
const LATER = "2026-09-06T10:01:00.000Z";

describe("memory correction derivation validity", () => {
  let database: Database;
  let store: DatabaseStore;
  let repository: ContinuityRepository;
  let validity: MemoryValidityRepository;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    store = new DatabaseStore(database);
    repository = new ContinuityRepository(store);
    validity = new MemoryValidityRepository(store);
    database
      .prepare(
        `INSERT INTO characters(id,current_version,status,tier,name,source_type,created_at_utc,updated_at_utc)
      VALUES (?,1,'published','daily','Continuity','original',?,?)`,
      )
      .run(AGENT, NOW, NOW);
    database
      .prepare(
        "INSERT INTO sessions(id,agent_id,title,created_at_utc,updated_at_utc) VALUES (?,?,'Continuity',?,?)",
      )
      .run(SESSION, AGENT, NOW, NOW);
  });
  afterEach(() => database.close());

  function remember(id: string, text: string, nowUtc = NOW): Memory[] {
    store.insertMessage({
      id,
      sessionId: SESSION,
      agentId: AGENT,
      role: "user",
      messageKind: "user",
      content: text,
      metadata: {},
      createdAtUtc: nowUtc,
    });
    return validateMergeAndPersistMemories({
      store,
      agentId: AGENT,
      nowUtc,
      authoritativeMessageId: id,
      maxCandidates: 4,
      candidates: [],
    });
  }

  it("invalidates memory-derived artifacts when the root message changes", () => {
    const memories = remember("source-edited", "我计划每周四晚上画画。");
    const { prepared } = deriveSnapshot(memories);
    const entry = prepared.bundle.entries[0]!;
    expect(
      validity
        .dependencies(AGENT, "autobiography_entry", entry.id)
        .map((source) => source.sourceType),
    ).toEqual(["memory", "message"]);
    store.transaction(() => {
      database
        .prepare("UPDATE messages SET content = ? WHERE id = ?")
        .run("这只是朋友的安排，不是我的。", "source-edited");
      expect(
        validity.isDerivedCurrent(AGENT, "autobiography_entry", entry.id),
      ).toBe(false);
      expect(
        repository.searchEventCards({ agentId: AGENT, query: "画画" }),
      ).toEqual([]);
    });
    expect(repository.getLatestAutobiography(AGENT)?.entries ?? []).toEqual([]);
    expect(
      repository.getLatestAutobiography(AGENT, { includeInvalidated: true })
        ?.entries,
    ).toHaveLength(1);
  });

  function deriveSnapshot(memories: Memory[], messageReports = false) {
    const checkpointId = `checkpoint-validity-${(repository.getLatestAutobiography(AGENT, { includeInvalidated: true })?.snapshot.revision ?? 0) + 1}`;
    const messages = repository.listArchivedMessages(SESSION);
    repository.beginCheckpoint({
      id: checkpointId,
      agentId: AGENT,
      sessionId: SESSION,
      fromMessageId: messages[0]!.id,
      throughMessageId: messages.at(-1)!.id,
      sourceHash: checkpointSourceHash(messages),
      sourceRevision: repository.getSessionRevision(SESSION)!.revision,
      sourceMessageCount: messages.length,
      sourceTokenEstimate: 100,
      status: "pending",
      createdAtUtc: NOW,
      updatedAtUtc: NOW,
    });
    const evidence: VerifiedContinuityEvidence[] = memories.map((memory) => {
      const root = readMemoryEvidence(store, [memory.id])[0]!;
      return {
        id: root.id,
        sourceType: messageReports ? "message_archive" : "memory_evidence",
        sourceId: messageReports ? root.sourceId : root.id,
        quote: root.quote!,
        text: messageReports ? root.quote! : memory.content,
        reliability: "reported",
        temporalStatus: messageReports ? "unknown" : "planned",
        recordedAtUtc: NOW,
      };
    });
    const contents = memories.map((memory, index) =>
      messageReports
        ? `对方在对话中说过：「${evidence[index]!.text}」`
        : memory.content,
    );
    const service = new AutobiographyService(repository);
    const prepared = service.prepareRevision({
      agentId: AGENT,
      checkpointId,
      sourceMessages: messages,
      proposal: {
        summaryFirstPerson: contents.join("\n"),
        entries: memories.map((_, index) => ({
          entryKind: "active_goal",
          content: contents[index]!,
          temporalStatus: messageReports ? "unknown" : "planned",
          evidence: [
            {
              id: evidence[index]!.id,
              sourceType: evidence[index]!.sourceType,
              sourceId: evidence[index]!.sourceId,
              quote: evidence[index]!.quote!,
              reliability: evidence[index]!.reliability,
              temporalStatus: messageReports ? "unknown" : "planned",
              recordedAtUtc: NOW,
            },
          ],
        })),
      },
      evidenceCatalog: evidence,
      nowUtc: NOW,
    });
    if (!prepared.accepted) throw new Error(JSON.stringify(prepared.issues));
    expect(store.transaction(() => service.persistPrepared(prepared))).toBe(
      true,
    );
    const cards = prepared.bundle.entries.map((entry) =>
      EventCardSchema.parse({
        id: `card-${entry.id}`,
        agentId: AGENT,
        cardKind: "goal",
        sourceKind: "autobiography_entry",
        sourceId: entry.id,
        dedupeKey: `card-${entry.id}`,
        title: entry.content,
        summary: entry.content,
        tags: ["weekly_plan"],
        namespace: "user_model",
        certainty: "explicit",
        attribution: "user_explicit",
        temporalMetadata: {
          recordedAtUtc: NOW,
          temporalCertainty: "unknown",
          temporalStatus: "planned",
        },
        importance: 0.8,
        evidence: entry.evidence,
        sourceEvidenceIds: entry.sourceEvidenceIds,
        status: "active",
        indexVersion: 1,
        createdAtUtc: NOW,
        updatedAtUtc: NOW,
      }),
    );
    expect(repository.upsertEventCards(cards)).toBe(memories.length);
    repository.commitCheckpoint({
      checkpointId,
      autobiographySnapshotId: prepared.bundle.snapshot.id,
      artifact: { eventCards: cards },
      committedAtUtc: NOW,
    });
    return { prepared, cards };
  }

  it("excludes naturally expired memory roots before current projection search limits without rewriting history", () => {
    const memories = remember(
      "source-expiring",
      "我计划每周四晚上画画。我计划每周六上午游泳。",
    );
    const painting = memories.find((memory) =>
      memory.content.includes("画画"),
    )!;
    const swimming = memories.find((memory) =>
      memory.content.includes("游泳"),
    )!;
    database
      .prepare("UPDATE memories SET valid_until_utc = ? WHERE id = ?")
      .run(LATER, painting.id);
    const { prepared } = deriveSnapshot(memories);
    const clock = new FakeClock(NOW);
    const index = new ContinuityIndexService(repository, clock);
    const autobiography = new AutobiographyService(repository);
    const memoryRevision = validity.currentRevision(AGENT);
    expect(autobiography.latest(AGENT, clock.nowUtc())?.entries).toHaveLength(
      2,
    );
    expect(
      index.searchEventCards({ agentId: AGENT, query: "画画" }),
    ).toHaveLength(1);

    // Time alone changes validity: no source/status mutation or revision bump.
    clock.setUtc(LATER);
    expect(validity.currentRevision(AGENT)).toBe(memoryRevision);
    expect(
      autobiography
        .latest(AGENT, clock.nowUtc())
        ?.entries.map((entry) => entry.content),
    ).toEqual([swimming.content]);
    expect(index.searchEventCards({ agentId: AGENT, query: "画画" })).toEqual(
      [],
    );
    expect(
      index
        .searchEventCards({ agentId: AGENT, query: "计划", limit: 1 })
        .map((card) => card.summary),
    ).toEqual([swimming.content]);
    expect(
      index.scanExplicitFactEventCards({
        agentId: AGENT,
        searchTerms: ["计划"],
        scanLimit: 1,
      }),
    ).toMatchObject({
      cards: [{ summary: swimming.content }],
      truncated: false,
    });
    expect(
      repository.getLatestAutobiography(AGENT, {
        includeInvalidated: true,
        nowUtc: LATER,
      })?.snapshot,
    ).toEqual(prepared.bundle.snapshot);
    expect(autobiography.isCurrent(prepared, LATER)).toBe(false);
    index.rebuildAgent(AGENT);
    expect(index.searchEventCards({ agentId: AGENT, query: "画画" })).toEqual(
      [],
    );
    expect(
      repository.getLatestAutobiography(AGENT, { includeInvalidated: true })
        ?.entries,
    ).toHaveLength(2);
    expect(
      database
        .prepare("SELECT status FROM memories WHERE id = ?")
        .get(painting.id),
    ).toEqual({ status: "active" });
  });

  it("excludes suppressed stable facts before the explicit-memory safety scan limit", () => {
    const memories = remember(
      "source-stable-facts",
      "小雨是我的大学同学，现在住在上海。",
    );
    const relation = memories.find((memory) =>
      memory.content.includes("大学同学"),
    )!;
    const location = memories.find((memory) =>
      memory.content.includes("上海"),
    )!;
    expect(
      readStableExplicitUserMemoryScan(store, AGENT, NOW, {
        searchTerms: ["小雨"],
        scanLimit: 1,
      }).truncated,
    ).toBe(true);
    expect(
      readStableExplicitUserMemoryScan(store, AGENT, NOW, {
        searchTerms: ["小雨"],
        scanLimit: 1,
        suppressedMemoryIds: [relation.id],
      }),
    ).toMatchObject({ memories: [{ id: location.id }], truncated: false });
    const index = new ContinuityIndexService(repository, new FakeClock(NOW));
    expect(
      index.searchVerbatim({ agentId: AGENT, query: "小雨" }),
    ).toHaveLength(1);
    expect(
      index.searchVerbatim({
        agentId: AGENT,
        query: "小雨",
        suppressedMemoryIds: [relation.id],
      }),
    ).toEqual([]);
    const recall = new MemoryRecallService(store, undefined, {
      continuityIndex: index,
      dateDigests: new DateDigestService(new ContinuityMemoryRepository(store)),
    });
    const query = { query: "小雨的大学同学关系和上海居住地", minimumScore: 0 };
    expect(
      recall.preview({
        agentId: AGENT,
        query,
        nowUtc: NOW,
        timezone: "Asia/Shanghai",
      }).result.abstained,
    ).toBe(false);
    // Both structured fallback and archive fallback must respect this turn's
    // exclusions; the original shared utterance still exists for history.
    expect(
      recall.preview({
        agentId: AGENT,
        query,
        nowUtc: NOW,
        timezone: "Asia/Shanghai",
        suppressedMemoryIds: memories.map((memory) => memory.id),
      }).result,
    ).toMatchObject({
      abstained: true,
      selectedMemoryIds: [],
      selectedEvidenceIds: [],
    });
    expect(repository.listArchivedMessages(SESSION)).toHaveLength(1);
  });

  it("omits turn-suppressed memory dependencies while preserving independent facts from the same source", () => {
    const memories = remember(
      "source-suppressed",
      "我计划每周四晚上画画。我计划每周六上午游泳。",
    );
    const painting = memories.find((memory) =>
      memory.content.includes("画画"),
    )!;
    const swimming = memories.find((memory) =>
      memory.content.includes("游泳"),
    )!;
    deriveSnapshot(memories);
    const memoryRevision = validity.currentRevision(AGENT);
    const suppressedMemoryIds = [painting.id];
    const index = new ContinuityIndexService(repository, new FakeClock(NOW));
    const autobiography = new AutobiographyService(repository);
    expect(
      autobiography
        .latest(AGENT, NOW, suppressedMemoryIds)
        ?.entries.map((entry) => entry.content),
    ).toEqual([swimming.content]);
    expect(
      index
        .searchEventCards({
          agentId: AGENT,
          query: "计划",
          limit: 1,
          suppressedMemoryIds,
        })
        .map((card) => card.summary),
    ).toEqual([swimming.content]);
    expect(
      index.scanExplicitFactEventCards({
        agentId: AGENT,
        searchTerms: ["计划"],
        scanLimit: 1,
        suppressedMemoryIds,
      }),
    ).toMatchObject({
      cards: [{ summary: swimming.content }],
      truncated: false,
    });
    expect(
      readRecallCandidateRecords(store, AGENT, NOW, {
        candidateLimit: 1,
        query: "计划",
        suppressedMemoryIds,
      }).map((memory) => memory.id),
    ).toEqual([swimming.id]);

    // A whole utterance reports both facts, so suppressing one excludes that
    // entire derived report without discarding the independent swimming fact.
    store.insertMessage({
      id: "receipt-source-suppressed",
      sessionId: SESSION,
      agentId: AGENT,
      role: "assistant",
      messageKind: "assistant_reply",
      content: "收到。",
      metadata: {},
      createdAtUtc: NOW,
    });
    deriveSnapshot(memories, true);
    const afterSnapshotRevision = validity.currentRevision(AGENT);
    expect(
      autobiography.latest(AGENT, NOW, suppressedMemoryIds),
    ).toBeUndefined();
    expect(
      index.searchEventCards({
        agentId: AGENT,
        query: "画画",
        suppressedMemoryIds,
      }),
    ).toEqual([]);
    expect(
      index
        .searchEventCards({
          agentId: AGENT,
          query: "游泳",
          suppressedMemoryIds,
        })
        .map((card) => card.summary),
    ).toEqual([swimming.content]);
    expect(autobiography.latest(AGENT, NOW)?.entries).toHaveLength(2);
    expect(
      repository.getLatestAutobiography(AGENT, { includeInvalidated: true })
        ?.entries,
    ).toHaveLength(2);
    expect(afterSnapshotRevision).toBe(memoryRevision);
    expect(
      validity.readSource(AGENT, "memory", painting.id, NOW),
    ).toBeDefined();
  });

  it.each(["legacy", "shadow", "enforced"] as const)(
    "filters current date evidence and shared message roots with %s recall mode",
    (memoryRecallMode) => {
      const yesterday = "2026-09-05T10:00:00.000Z";
      // Seed previously persisted occurrence projections; this exercises current
      // reading independently of the memory extraction/writing policy.
      const insertFact = (
        id: string,
        sourceId: string,
        content: string,
        expiresAtUtc: string | null = null,
      ) => {
        if (
          database
            .prepare("SELECT id FROM messages WHERE id = ?")
            .get(sourceId) === undefined
        ) {
          store.insertMessage({
            id: sourceId,
            sessionId: SESSION,
            agentId: AGENT,
            role: "user",
            messageKind: "user",
            content,
            metadata: {},
            createdAtUtc: yesterday,
          });
        }
        database
          .prepare(
            `INSERT INTO memories(
          id, agent_id, type, content, tags_json, importance, confidence,
          source_message_id, created_at_utc, memory_json, namespace, certainty,
          attribution, stability, status, temporal_status, occurred_start_at_utc,
          recorded_at_utc, temporal_certainty, valid_until_utc
        ) VALUES (?, ?, 'episodic', ?, '[]', 0.7, 1, ?, ?, '{}', 'user_model',
          'explicit', 'user_explicit', 'one_off', 'active', 'occurred', ?, ?, 'exact', ?)`,
          )
          .run(
            id,
            AGENT,
            content,
            sourceId,
            yesterday,
            yesterday,
            yesterday,
            expiresAtUtc,
          );
        database
          .prepare(
            `INSERT INTO memory_evidence(
          id, memory_id, source_type, source_id, quote, recorded_at_utc, evidence_json
        ) VALUES (?, ?, 'message', ?, ?, ?, '{}')`,
          )
          .run(`evidence-${id}`, id, sourceId, content, yesterday);
      };
      insertFact(
        "digest-withdrawn",
        "digest-shared-message",
        "我昨天尝了红茶，也把陶杯带回家。",
      );
      insertFact(
        "digest-shared-other",
        "digest-shared-message",
        "用户昨天把陶杯带回家。",
      );
      insertFact(
        "digest-independent",
        "digest-independent-message",
        "用户昨天归还了图书。",
      );
      insertFact(
        "digest-expired",
        "digest-expired-message",
        "用户昨天领了票。",
        NOW,
      );
      const dates = new DateDigestService(
        new ContinuityMemoryRepository(store),
      );
      const baseQuery = {
        agentId: AGENT,
        text: "yesterday",
        nowUtc: NOW,
        timezone: "Asia/Shanghai",
      };
      expect(dates.query(baseQuery).digest?.items).toHaveLength(3);
      const dateQuery = vi.spyOn(dates, "query");
      const context = new ConversationContextService(
        {
          preparePrompt: () => ({ cueIds: [], careCues: [] }),
        } as unknown as ConversationContinuityService,
        new AutobiographyService(repository),
        { selectPromptContext: () => [] } as unknown as CalendarService,
        dates,
        new ContinuityIndexService(repository, new FakeClock(NOW)),
        "enforced",
        memoryRecallMode,
      ).prepare({
        agentId: AGENT,
        userText: "yesterday",
        nowUtc: NOW,
        timezone: "Asia/Shanghai",
        suppressedMemoryIds: ["digest-withdrawn"],
      });
      const digest = (
        dateQuery.mock.results[0]!.value as ReturnType<
          DateDigestService["query"]
        >
      ).digest;
      expect(digest).toMatchObject({
        items: [
          {
            sourceId: "digest-independent",
            sourceEvidenceIds: ["evidence-digest-independent"],
          },
        ],
        sourceEvidenceIds: ["evidence-digest-independent"],
      });
      expect(digest?.items).toHaveLength(1);
      const rendered = context.additionalPromptSegments
        .map((segment) => segment.render({}))
        .join("\n");
      expect(rendered).not.toMatch(
        /(?:红茶|陶杯|领了票|digest-withdrawn|digest-shared-other|digest-expired)/u,
      );
      if (memoryRecallMode === "enforced")
        expect(rendered).not.toContain("图书");
      else expect(rendered).toContain("图书");
      expect(repository.listArchivedMessages(SESSION)).toHaveLength(3);
      expect(
        database
          .prepare("SELECT COUNT(*) AS count FROM memories WHERE agent_id = ?")
          .get(AGENT),
      ).toEqual({ count: 4 });
    },
  );

  it("invalidates only the corrected fact and its projections while retaining shared-source history", () => {
    const originals = remember(
      "message-original",
      "我计划每周四晚上画画。我计划每周六上午游泳。",
    );
    const painting = originals.find((memory) =>
      memory.claim?.subjectKey.endsWith("画画"),
    )!;
    const swimming = originals.find((memory) =>
      memory.claim?.subjectKey.endsWith("游泳"),
    )!;
    expect(painting).toBeDefined();
    expect(swimming).toBeDefined();
    const { prepared, cards } = deriveSnapshot([painting, swimming]);
    const originalJson = database
      .prepare("SELECT snapshot_json FROM autobiography_snapshots")
      .get();
    const source = validity.readSource(AGENT, "memory", painting.id)!;
    const revision = validity.currentRevision(AGENT);
    expect(
      validity.registerDependencies({
        agentId: AGENT,
        derivedType: "persona_adaptation",
        derivedId: "adaptation-1",
        sources: [
          source,
          validity.readSource(AGENT, "message", "message-original")!,
        ],
        nowUtc: NOW,
      }),
    ).toBe(true);

    const lifecycle = new MemoryLifecycleService(
      new ContinuityMemoryRepository(store),
      new FakeClock(LATER),
    );
    let correctionId = "";
    store.transaction(() => {
      correctionId = remember(
        "message-correction",
        "画画的时间改到每周二晚上，不是周四。",
        LATER,
      )[0]!.id;
      lifecycle.reconcileNewMemories(AGENT, [correctionId]);
      expect(
        repository.searchEventCards({ agentId: AGENT, query: "画画" }),
      ).toEqual([]);
      expect(
        validity.isDerivedCurrent(AGENT, "persona_adaptation", "adaptation-1"),
      ).toBe(false);
    });
    expect(validity.currentRevision(AGENT)).toBeGreaterThan(revision);
    expect(validity.isSourceCurrent(AGENT, source)).toBe(false);
    const reloaded = new ContinuityRepository(store);
    expect(
      reloaded
        .getLatestAutobiography(AGENT)
        ?.entries.map((entry) => entry.content),
    ).toEqual([swimming.content]);
    expect(
      reloaded.getLatestAutobiography(AGENT)?.snapshot.activeGoals,
    ).toEqual([swimming.content]);
    expect(
      database
        .prepare("SELECT snapshot_json FROM autobiography_snapshots")
        .get(),
    ).toEqual(originalJson);
    expect(
      reloaded.getLatestAutobiography(AGENT, { includeInvalidated: true })
        ?.entries,
    ).toHaveLength(2);
    expect(reloaded.listArchivedMessages(SESSION)).toHaveLength(2);
    expect(
      new ContinuityMemoryRepository(store).getLifecycleMemory(painting.id)
        ?.memory,
    ).toMatchObject({ status: "superseded", supersededById: correctionId });
    expect(validity.readSource(AGENT, "memory", swimming.id)).toBeDefined();
    expect(
      validity.isDerivedCurrent(
        AGENT,
        "autobiography_entry",
        prepared.bundle.entries[0]!.id,
      ),
    ).toBe(false);
    expect(repository.upsertEventCards(cards)).toBe(1);
    new ContinuityIndexService(reloaded, new FakeClock(LATER)).rebuildAgent(
      AGENT,
    );
    expect(
      reloaded
        .searchEventCards({ agentId: AGENT, query: "画画" })
        .filter((card) => card.summary === painting.content),
    ).toEqual([]);
    const settledRevision = validity.currentRevision(AGENT);
    expect(
      lifecycle
        .reconcileNewMemories(AGENT, [correctionId])
        .every((result) => result.replayed),
    ).toBe(true);
    expect(validity.currentRevision(AGENT)).toBe(settledRevision);
  });

  it("binds whole-message checkpoint reports and prevents corrected text reappearing in a later snapshot", () => {
    const originals = remember("message-original", "我计划每周四晚上画画。");
    const first = deriveSnapshot(originals, true);
    expect(
      validity
        .dependencies(
          AGENT,
          "autobiography_entry",
          first.prepared.bundle.entries[0]!.id,
        )
        .map((source) => source.sourceType),
    ).toEqual(["memory", "message"]);
    const correction = remember(
      "message-correction",
      "画画的时间改到每周二晚上，不是周四。",
      LATER,
    );
    new MemoryLifecycleService(
      new ContinuityMemoryRepository(store),
      new FakeClock(LATER),
    ).reconcileNewMemories(
      AGENT,
      correction.map((memory) => memory.id),
    );
    expect(repository.getLatestAutobiography(AGENT)).toBeUndefined();
    const next = deriveSnapshot(originals, true);
    expect(next.prepared.bundle.snapshot.revision).toBe(2);
    expect(next.prepared.bundle.entries[0]?.content).toContain(
      "【已纠正来源索引】",
    );
    expect(next.prepared.bundle.entries[0]?.content).not.toContain("周四");
    expect(next.prepared.bundle.entries[0]?.temporalStatus).toBe("unknown");
    expect(
      repository.getLatestAutobiography(AGENT)?.snapshot.summaryFirstPerson,
    ).not.toContain("周四");
  });

  it("rejects artifact writes with missing sources and never grants validity to an unregistered object", () => {
    expect(
      validity.isDerivedCurrent(AGENT, "persona_adaptation", "unknown"),
    ).toBe(false);
    const originals = remember("message-original", "我计划每周四晚上画画。");
    const { cards } = deriveSnapshot(originals);
    const forged = {
      ...cards[0]!,
      id: "forged-card",
      dedupeKey: "forged-card",
      evidence: [
        { ...cards[0]!.evidence[0]!, sourceId: "missing-memory-evidence" },
      ],
    };
    expect(repository.upsertEventCards([forged])).toBe(0);
    expect(
      database
        .prepare("SELECT id FROM event_cards WHERE id = 'forged-card'")
        .get(),
    ).toBeUndefined();
  });

  it("rolls back correction, invalidation and revision together on a failed turn", () => {
    const originals = remember("message-original", "我计划每周四晚上画画。");
    const { prepared } = deriveSnapshot(originals);
    const revision = validity.currentRevision(AGENT);
    expect(() =>
      store.transaction(() => {
        const corrected = remember(
          "message-correction",
          "画画的时间改到每周二晚上，不是周四。",
          LATER,
        );
        new MemoryLifecycleService(
          new ContinuityMemoryRepository(store),
          new FakeClock(LATER),
        ).reconcileNewMemories(
          AGENT,
          corrected.map((memory) => memory.id),
        );
        throw new Error("simulated turn audit failure");
      }),
    ).toThrow("simulated turn audit failure");
    expect(validity.currentRevision(AGENT)).toBe(revision);
    expect(repository.listArchivedMessages(SESSION)).toHaveLength(1);
    expect(repository.getLatestAutobiography(AGENT)?.snapshot).toEqual(
      prepared.bundle.snapshot,
    );
    expect(
      repository.searchEventCards({ agentId: AGENT, query: "画画" }),
    ).toHaveLength(1);
  });

  it("fences prepared revisions and source registrations against changed memory and cross-agent references", () => {
    const originals = remember("message-original", "我计划每周四晚上画画。");
    const { prepared } = deriveSnapshot(originals);
    const source = validity.readSource(AGENT, "memory", originals[0]!.id)!;
    expect(
      validity.readSource("another-agent", "memory", originals[0]!.id),
    ).toBeUndefined();
    const corrected = remember(
      "message-correction",
      "画画的时间改到每周二晚上，不是周四。",
      LATER,
    );
    new MemoryLifecycleService(
      new ContinuityMemoryRepository(store),
      new FakeClock(LATER),
    ).reconcileNewMemories(
      AGENT,
      corrected.map((memory) => memory.id),
    );
    expect(new AutobiographyService(repository).isCurrent(prepared)).toBe(
      false,
    );
    expect(
      validity.registerDependencies({
        agentId: AGENT,
        derivedType: "persona_adaptation",
        derivedId: "stale",
        sources: [source],
        nowUtc: LATER,
      }),
    ).toBe(false);
    expect(repository.getLatestAutobiography(AGENT)).toBeUndefined();
    expect(
      repository.getLatestAutobiography(AGENT, { includeInvalidated: true })
        ?.snapshot.revision,
    ).toBe(1);
  });
});
