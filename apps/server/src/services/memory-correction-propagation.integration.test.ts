import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import {
  readMemoryEvidence,
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
