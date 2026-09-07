import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildConversationContextPlan } from "@personasim/features";
import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";
import { RetrievalRunRepository } from "../repositories/retrieval-run-repository.js";
import { FakeClock } from "../runtime/clock.js";
import { ContinuityIndexService } from "./continuity-index-service.js";
import { ContinuityMemoryRepository } from "./continuity-memory-repository.js";
import { ContinuityRepository } from "./continuity-repository.js";
import { DateDigestService } from "./date-digest-service.js";
import { MemoryLifecycleService } from "./memory-lifecycle-service.js";
import { MemoryRecallService } from "./memory-recall-service.js";
import { validateMergeAndPersistMemories } from "./memory-service.js";

const NOW = "2026-09-07T00:00:00.000Z";
const LATER = "2026-09-07T00:01:00.000Z";
const PROBE = "2026-09-08T00:00:00.000Z";
describe("source-verified current fact corrections", () => {
  let directory: string;
  let database: Database;
  let store: DatabaseStore;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "chatplus-current-facts-"));
    database = openDatabase(join(directory, "memory.db"));
    runMigrations(database);
    store = new DatabaseStore(database);
    database
      .prepare(
        "INSERT INTO characters(id,current_version,status,tier,name,source_type,created_at_utc,updated_at_utc) VALUES ('a',1,'published','daily','A','original',?,?)",
      )
      .run(NOW, NOW);
    database
      .prepare(
        "INSERT INTO sessions(id,agent_id,title,created_at_utc,updated_at_utc) VALUES ('s','a','S',?,?)",
      )
      .run(NOW, NOW);
  });
  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function remember(id: string, content: string, nowUtc = NOW) {
    return store.transaction(() => {
      store.insertMessage({
        id,
        agentId: "a",
        sessionId: "s",
        role: "user",
        messageKind: "user",
        content,
        createdAtUtc: nowUtc,
        metadata: {},
      });
      const memories = validateMergeAndPersistMemories({
        store,
        agentId: "a",
        candidates: [],
        nowUtc,
        authoritativeMessageId: id,
        maxCandidates: 8,
      });
      new MemoryLifecycleService(
        new ContinuityMemoryRepository(store),
        new FakeClock(nowUtc),
      ).reconcileNewMemories(
        "a",
        memories.map((memory) => memory.id),
      );
      return memories;
    });
  }
  function service() {
    return new MemoryRecallService(store, undefined, {
      continuityIndex: new ContinuityIndexService(
        new ContinuityRepository(store),
        new FakeClock(PROBE),
      ),
      dateDigests: new DateDigestService(new ContinuityMemoryRepository(store)),
    });
  }
  function recall(query: string, sessionId = "s") {
    return service().preparePreviewRecording({
      agentId: "a",
      sessionId,
      query,
      nowUtc: PROBE,
      timezone: "Asia/Shanghai",
      requireDurableEvidence: true,
      contextPlan: buildConversationContextPlan({
        agentId: "a",
        sessionId,
        originalQuery: query,
        recentMessages: [],
      }),
    });
  }

  it("keeps corrected names and IDs through distraction, a new session and reopening SQLite", () => {
    const initial = remember(
      "first",
      "同事叫林乔。妹妹叫沈禾。项目编号是 BGW-4729。",
    );
    expect(initial).toHaveLength(3);
    const colleague = initial.find((memory) =>
      memory.content.includes("同事"),
    )!;
    const validity = new MemoryValidityRepository(store);
    expect(
      validity.registerDependencies({
        agentId: "a",
        derivedType: "autobiography_entry",
        derivedId: "old-name-view",
        sources: [validity.readSource("a", "memory", colleague.id)!],
        nowUtc: NOW,
      }),
    ).toBe(true);
    const before = validity.currentRevision("a");
    const changed = remember(
      "correction",
      "同事叫林桥，不是林乔。项目编号是 BGW-7429，不是 BGW-4729。",
      LATER,
    );
    expect(changed).toHaveLength(2);
    expect(
      validity.isDerivedCurrent("a", "autobiography_entry", "old-name-view"),
    ).toBe(false);
    expect(validity.currentRevision("a")).toBeGreaterThan(before);
    expect(
      database
        .prepare("SELECT status FROM memories WHERE id = ?")
        .get(colleague.id),
    ).toEqual({ status: "superseded" });
    for (let index = 0; index < 10; index++)
      remember(
        `distraction-${index}`,
        `今天散步经过第 ${index + 1} 条街，天气不错。`,
        `2026-09-07T00:${String(index + 2).padStart(2, "0")}:00.000Z`,
      );
    database
      .prepare(
        "INSERT INTO sessions(id,agent_id,title,created_at_utc,updated_at_utc) VALUES ('fresh','a','Fresh',?,?)",
      )
      .run(PROBE, PROBE);
    database.close();
    database = openDatabase(join(directory, "memory.db"));
    expect(runMigrations(database)).toEqual([]);
    store = new DatabaseStore(database);
    const prepared = recall("项目编号是什么，妹妹姓名和同事叫什么？", "fresh");
    expect(prepared.preview.result.abstained).toBe(false);
    if (prepared.preview.result.abstained) throw new Error("Missing facts");
    expect(
      prepared.preview.result.evidenceBundle.evidence
        .map((item) => item.currentFact?.value)
        .sort(),
    ).toEqual(["BGW-7429", "林桥", "沈禾"].sort());
    expect(
      prepared.preview.result.evidenceBundle.evidence
        .map((item) => item.memoryContent)
        .join(" "),
    ).not.toMatch(/林乔|BGW-4729|纠正|原因/);
    const runs = new RetrievalRunRepository(database);
    const recorded = runs.create(prepared.retrievalRun);
    const replay = runs.getReplayInput(recorded.id)!;
    expect(service().replay(replay)).toEqual(prepared.preview.result);
    expect(
      database.prepare("SELECT COUNT(*) AS total FROM llm_calls").get(),
    ).toEqual({ total: 0 });
  });

  it("reads already stored corrections with null claim slots without mutating the originals", () => {
    const first = remember("legacy-wrong", "同事叫林乔。妹妹叫沈禾。");
    const corrected = remember(
      "legacy-correct",
      "同事叫林桥，不是林乔。",
      LATER,
    );
    for (const memory of [...first, ...corrected]) {
      const source = database
        .prepare("SELECT content FROM messages WHERE id = ?")
        .get(memory.sourceMessageIds[0]!) as { content: string };
      database
        .prepare(
          "UPDATE memories SET claim_subject_key = NULL, claim_disposition = NULL, status = 'active', superseded_by_id = NULL, content = ?, memory_json = json_remove(json_set(memory_json, '$.status','active','$.content',?), '$.claim', '$.supersededById') WHERE id = ?",
        )
        .run(source.content, source.content, memory.id);
    }
    const before = database
      .prepare("SELECT id,content,memory_json FROM memories ORDER BY id")
      .all();
    const result = recall("同事叫什么，妹妹叫什么？").preview.result;
    expect(result.abstained).toBe(false);
    if (result.abstained) throw new Error("Missing legacy facts");
    expect(
      result.evidenceBundle.evidence
        .map((item) => item.currentFact?.value)
        .sort(),
    ).toEqual(["林桥", "沈禾"].sort());
    expect(
      database
        .prepare("SELECT id,content,memory_json FROM memories ORDER BY id")
        .all(),
    ).toEqual(before);
  });

  it("keeps legal beverage history distinct from the current projection", () => {
    const initial = remember("coffee", "我平时喝咖啡。");
    const later = remember("tea", "以前喝咖啡，现在喝茶。", LATER);
    expect(later[0]?.claim?.revisionIntent).toBe("temporal_update");
    expect(
      database
        .prepare("SELECT status,content FROM memories WHERE id = ?")
        .get(initial[0]!.id),
    ).toEqual({ status: "superseded", content: "用户日常饮品：咖啡。" });
    const current = recall("我现在喝什么？").preview.result;
    expect(current.abstained).toBe(false);
    if (current.abstained) throw new Error("Missing current drink");
    expect(current.evidenceBundle.evidence[0]?.currentFact?.value).toBe("茶");
    const history = recall("我以前喝什么？").preview.result;
    expect(history.abstained).toBe(false);
    if (history.abstained) throw new Error("Missing drink history");
    expect(history.evidenceBundle.evidence[0]?.currentFact).toBeUndefined();
    expect(history.evidenceBundle.evidence[0]?.evidence.quote).toContain(
      "以前喝咖啡",
    );
  });

  it("accepts a complete later answer without a negation or a reason", () => {
    const first = remember("number-old", "项目编号是 BGW-4729。妹妹叫沈禾。");
    remember("number-new", "项目编号是 BGW-7429。", LATER);
    const result = recall("项目编号是什么，妹妹叫什么？").preview.result;
    expect(result.abstained).toBe(false);
    if (result.abstained)
      throw new Error("Direct supplied answer was not retained");
    expect(
      result.evidenceBundle.evidence
        .map((item) => item.currentFact?.value)
        .sort(),
    ).toEqual(["BGW-7429", "沈禾"].sort());
    expect(
      database
        .prepare("SELECT status FROM memories WHERE id = ?")
        .get(first.find((memory) => memory.content.includes("项目"))!.id),
    ).toEqual({ status: "superseded" });
  });

  it("follows legal chained temporal history for an earliest drink query and replays it", () => {
    remember("earliest-coffee", "我平时喝咖啡。");
    remember("then-tea", "以前喝咖啡，现在喝茶。", LATER);
    remember("now-water", "以前喝茶，现在喝水。", "2026-09-07T00:02:00.000Z");
    const prepared = recall("最初喝什么？");
    const result = prepared.preview.result;
    expect(result.abstained, JSON.stringify(prepared.preview)).toBe(false);
    if (result.abstained) throw new Error("Earliest temporal fact missing");
    expect(result.evidenceBundle.evidence[0]?.memoryContent).toBe(
      "用户日常饮品：咖啡。",
    );
    expect(result.evidenceBundle.evidence[0]?.currentFact).toBeUndefined();
    expect(
      result.evidenceBundle.evidence[0]?.temporalMetadata?.occurredEndAtUtc,
    ).toBe(LATER);
    const runs = new RetrievalRunRepository(database);
    const recorded = runs.create(prepared.retrievalRun);
    expect(service().replay(runs.getReplayInput(recorded.id)!)).toEqual(result);
    const current = recall("我现在喝什么？").preview.result;
    expect(current.abstained).toBe(false);
    if (!current.abstained)
      expect(current.evidenceBundle.evidence[0]?.currentFact?.value).toBe("水");
    expect(
      database
        .prepare(
          "SELECT status FROM memories WHERE content = '用户日常饮品：咖啡。'",
        )
        .get(),
    ).toEqual({ status: "superseded" });
  });

  it("does not present a retracted drink as the earliest true value", () => {
    remember("wrong-coffee", "我平时喝咖啡。");
    remember("correct-tea", "更正：我平时喝茶。", LATER);
    remember("later-water", "以前喝茶，现在喝水。", "2026-09-07T00:02:00.000Z");
    const result = recall("我最初喝什么？").preview.result;
    expect(result.abstained).toBe(false);
    if (result.abstained)
      throw new Error("Earliest legal temporal fact missing");
    expect(result.evidenceBundle.evidence[0]?.memoryContent).toBe(
      "用户日常饮品：茶。",
    );
    expect(
      result.evidenceBundle.evidence
        .map((item) => item.memoryContent)
        .join(" "),
    ).not.toContain("咖啡");
  });

  it("does not let a foreign author or unsupported quote supply a current fact", () => {
    const memories = remember("valid", "同事叫林桥。");
    database
      .prepare("UPDATE messages SET role = 'assistant' WHERE id = 'valid'")
      .run();
    expect(recall("同事叫什么？").preview.result.abstained).toBe(true);
    database
      .prepare(
        "UPDATE messages SET role = 'user', content = '我没有告诉过你同事姓名。' WHERE id = 'valid'",
      )
      .run();
    expect(recall("同事叫什么？").preview.result.abstained).toBe(true);
    expect(memories).toHaveLength(1);
  });

  it("keeps known independent facts when another requested slot cannot be recovered", () => {
    remember("one-known", "妹妹叫沈禾。");
    const result = recall("妹妹叫什么，项目编号是什么？").preview.result;
    expect(result.abstained).toBe(false);
    if (result.abstained)
      throw new Error("Known independent fact was discarded");
    expect(result.evidenceBundle.factCoverage).toEqual([
      { entity: "妹妹", attribute: "name", covered: true },
      { entity: "项目", attribute: "identifier", covered: false },
    ]);
    expect(
      result.evidenceBundle.evidence.map((item) => item.currentFact?.value),
    ).toEqual(["沈禾"]);
  });

  it("retries the one known target after 'you remembered wrong' without asking for the answer again", () => {
    remember("correct-name", "同事叫林桥，不是林乔。");
    const contextPlan = buildConversationContextPlan({
      agentId: "a",
      sessionId: "s",
      originalQuery: "你记错了。",
      recentMessages: [
        {
          id: "query-name",
          agentId: "a",
          sessionId: "s",
          role: "user",
          text: "同事叫什么？",
        },
        {
          id: "wrong-answer",
          agentId: "a",
          sessionId: "s",
          role: "assistant",
          text: "林乔。",
        },
      ],
    });
    const result = service().recall({
      agentId: "a",
      query: "你记错了。",
      contextPlan,
      nowUtc: PROBE,
      requireDurableEvidence: true,
    });
    expect(result.abstained).toBe(false);
    if (result.abstained)
      throw new Error("Known correction target was not retried");
    expect(result.evidenceBundle.evidence[0]?.currentFact?.value).toBe("林桥");
    const ambiguous = buildConversationContextPlan({
      agentId: "a",
      sessionId: "s",
      originalQuery: "你记错了。",
      recentMessages: [
        {
          id: "query-both",
          agentId: "a",
          sessionId: "s",
          role: "user",
          text: "同事和妹妹的姓名分别是什么？",
        },
      ],
    });
    expect(ambiguous.factQueryNeeds).toEqual([]);
  });
});
