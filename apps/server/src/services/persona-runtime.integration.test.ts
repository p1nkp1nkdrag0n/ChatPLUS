import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CharacterSpecSchema, type CharacterSpec } from "@personasim/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { buildOriginalDraft } from "../domain/defaults.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";
import { PersonaRuntimeRepository } from "../repositories/persona-runtime-repository.js";
import { PersonaRuntimeService } from "./persona-runtime-service.js";

const NOW = "2026-09-06T12:00:00.000Z";
const LATER = "2026-09-07T12:00:00.000Z";
const PREF = "我谈工作烦恼时，先听我说，不急着建议。";

describe("scoped persona runtime persistence and revision fences", () => {
  let directory: string;
  let database: Database;
  let store: DatabaseStore;
  let validity: MemoryValidityRepository;
  let service: PersonaRuntimeService;
  let spec: CharacterSpec;
  let sessionId: string;

  function reopen() {
    database = openDatabase(join(directory, "persona.db"));
    runMigrations(database);
    store = new DatabaseStore(database);
    validity = new MemoryValidityRepository(store);
    service = new PersonaRuntimeService(store, validity);
  }
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "personasim-scoped-persona-"));
    reopen();
    spec = CharacterSpecSchema.parse({
      ...buildOriginalDraft(
        {
          name: "阿澄",
          worldSetting: "当代城市",
          workOrRole: "书店店员",
          coreTraits: ["愿意倾听"],
          initialRelationship: "邻居",
          dialogueStyle: "轻松自然",
          tier: "daily",
          timezone: "Asia/Shanghai",
        },
        "companion_character_v2",
      ),
      id: "agent_persona",
      version: 1,
      status: "published",
      createdAtUtc: NOW,
      updatedAtUtc: NOW,
    });
    store.insertCharacter(spec);
    sessionId = store.createSession(spec.id, "Persona practice", NOW).id;
  });
  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function message(
    id: string,
    text = PREF,
    role: "user" | "assistant" = "user",
    nowUtc = NOW,
  ) {
    store.insertMessage({
      id,
      sessionId,
      agentId: spec.id,
      role,
      content: text,
      messageKind: role === "user" ? "user" : "assistant_reply",
      metadata: {},
      createdAtUtc: nowUtc,
    });
  }
  function capture(id: string, nowUtc = NOW) {
    return service.captureExplicitPractice({
      baseSpec: spec,
      sourceMessageId: id,
      nowUtc,
      mode: "enforced",
    });
  }
  function snapshot(topicText = "工作又遇到麻烦了", nowUtc = LATER) {
    return service.snapshot({ baseSpec: spec, nowUtc, topicText });
  }

  it("keeps empty snapshots read-only and requires a user-authored enduring request", () => {
    const before = database
      .prepare("SELECT count(*) AS count FROM persona_runtime_heads")
      .get();
    expect(snapshot().revision).toBe(0);
    expect(
      database
        .prepare("SELECT count(*) AS count FROM persona_runtime_heads")
        .get(),
    ).toEqual(before);
    message("assistant", PREF, "assistant");
    message("ordinary", "今天一起喝了咖啡，很开心。");
    expect(capture("assistant").acceptedAdaptationIds).toEqual([]);
    expect(capture("ordinary").revision).toBe(0);
    expect(snapshot().persona).toEqual(spec.persona);
  });

  it("captures a local practice once, keeps original personality, and survives a new session and DB reopen", () => {
    message("preference");
    const result = capture("preference");
    expect(result.revision).toBe(1);
    expect(result.acceptedAdaptationIds).toHaveLength(1);
    expect(snapshot().relationshipPractices[0]?.proposal.scope.topic).toBe(
      "工作烦恼",
    );
    expect(snapshot("今天有点家庭烦恼").relationshipPractices).toEqual([]);
    expect(
      service.snapshot({
        baseSpec: spec,
        nowUtc: LATER,
        topicText: "工作",
        userId: "someone_else",
      }).relationshipPractices,
    ).toEqual([]);
    const same = capture("preference");
    expect(same.revision).toBe(1);
    expect(same.acceptedAdaptationIds).toEqual([]);
    expect(store.getCharacterSpec(spec.id)).toEqual(spec);
    database.close();
    reopen();
    sessionId = store.createSession(spec.id, "New session", LATER).id;
    message("again", PREF, "user", LATER);
    expect(capture("again", LATER).revision).toBe(1);
    expect(snapshot().relationshipPractices).toHaveLength(1);
    expect(snapshot().persona.traits).toEqual(spec.persona.traits);
  });

  it("records shadow observations without creating memory or changing the authoritative revision", () => {
    message("shadow");
    const shadow = service.captureExplicitPractice({
      baseSpec: spec,
      sourceMessageId: "shadow",
      nowUtc: NOW,
      mode: "shadow",
    });
    expect(shadow.capturedObservationIds).toHaveLength(1);
    expect(shadow.revision).toBe(0);
    expect(validity.currentRevision(spec.id)).toBe(0);
    expect(snapshot().relationshipPractices).toEqual([]);
    expect(capture("shadow").revision).toBe(1);
  });

  it("immediately excludes corrected memory sources while retaining the recorded historical projection", () => {
    message("source");
    capture("source");
    const before = service.snapshotAsOf({
      baseSpec: spec,
      nowUtc: NOW,
      topicText: "工作",
    });
    const adaptation = snapshot().relationshipPractices[0]!;
    const memoryId = adaptation.sources.find(
      (source) => source.sourceType === "memory",
    )!.sourceId;
    database
      .prepare(
        "UPDATE memories SET status = 'superseded', lifecycle_updated_at_utc = ? WHERE id = ?",
      )
      .run(LATER, memoryId);
    expect(snapshot().relationshipPractices).toEqual([]);
    expect(snapshot().suppressedMemoryIds).toContain(memoryId);
    service.reconcileSources({ agentId: spec.id, nowUtc: LATER });
    expect(snapshot().revision).toBe(2);
    expect(
      service.snapshotAsOf({ baseSpec: spec, nowUtc: NOW, topicText: "工作" }),
    ).toEqual(before);
    expect(
      service.snapshotAsOf({ baseSpec: spec, nowUtc: LATER, topicText: "工作" })
        .relationshipPractices,
    ).toEqual([]);
  });

  it("withdraws overlapping topic practices, does not revive them in a new session, and preserves as-of history", () => {
    message("listen");
    capture("listen");
    const history = service.snapshotAsOf({
      baseSpec: spec,
      nowUtc: NOW,
      topicText: "工作",
    });
    message("withdraw", "以后聊工作不用总先听，直接给我建议。", "user", LATER);
    expect(capture("withdraw", LATER).revision).toBe(2);
    expect(snapshot().relationshipPractices).toEqual([]);
    expect(snapshot().suppressedMemoryIds).toHaveLength(1);
    expect(capture("withdraw", LATER).revision).toBe(2);
    database.close();
    reopen();
    sessionId = store.createSession(spec.id, "After withdrawal", LATER).id;
    message("new_chat", "工作又有点烦。", "user", LATER);
    expect(capture("new_chat", LATER).revision).toBe(2);
    expect(snapshot().relationshipPractices).toEqual([]);
    expect(
      service.snapshotAsOf({ baseSpec: spec, nowUtc: NOW, topicText: "工作" }),
    ).toEqual(history);
  });

  it("excludes a source corrected before a delayed arrival without needing a later persona reconciliation", () => {
    message("delayed_source");
    capture("delayed_source");
    const before = service.snapshotAsOf({
      baseSpec: spec,
      nowUtc: NOW,
      topicText: "工作",
    });
    const adaptation = snapshot().relationshipPractices[0]!;
    const memoryId = adaptation.sources.find(
      (source) => source.sourceType === "memory",
    )!.sourceId;
    database
      .prepare(
        "UPDATE memories SET status = 'superseded', lifecycle_updated_at_utc = ? WHERE id = ?",
      )
      .run(LATER, memoryId);
    const delayedAt = "2026-09-08T12:00:00.000Z";
    const atArrival = service.snapshotAsOf({
      baseSpec: spec,
      nowUtc: delayedAt,
      topicText: "工作",
    });
    expect(atArrival.revision).toBe(1);
    expect(atArrival.relationshipPractices).toEqual([]);
    expect(atArrival.memoryRevision).toBeGreaterThan(before.memoryRevision);
    expect(snapshot().relationshipPractices).toEqual([]);
    expect(
      service.snapshotAsOf({ baseSpec: spec, nowUtc: NOW, topicText: "工作" }),
    ).toEqual(before);
    // A later source mutation must not move the original invalidation past arrival.
    database
      .prepare(
        "UPDATE memories SET content = content || 'changed again', lifecycle_updated_at_utc = ? WHERE id = ?",
      )
      .run("2026-09-09T12:00:00.000Z", memoryId);
    expect(
      service.snapshotAsOf({
        baseSpec: spec,
        nowUtc: delayedAt,
        topicText: "工作",
      }),
    ).toEqual(atArrival);
    database.close();
    reopen();
    expect(
      service.snapshotAsOf({ baseSpec: spec, nowUtc: NOW, topicText: "工作" }),
    ).toEqual(before);
    expect(
      service.snapshotAsOf({
        baseSpec: spec,
        nowUtc: delayedAt,
        topicText: "工作",
      }),
    ).toEqual(atArrival);
  });

  it("rejects future author baselines and rechecks author relationship edits", () => {
    message("relationship_edit");
    capture("relationship_edit");
    const future = CharacterSpecSchema.parse({
      ...spec,
      version: 2,
      createdAtUtc: LATER,
      updatedAtUtc: LATER,
      userRelationship: {
        ...spec.userRelationship,
        sharedContext: "作者重新设定了关系相处约定。",
      },
    });
    expect(() =>
      service.snapshotAsOf({ baseSpec: future, nowUtc: NOW }),
    ).toThrow(/base_as_of_conflict/u);
    store.insertCharacterVersion(future);
    store.updateCharacterHead(future);
    service.reconcileBase({ baseSpec: future, nowUtc: LATER });
    expect(
      service.snapshot({ baseSpec: future, nowUtc: LATER, topicText: "工作" })
        .relationshipPractices,
    ).toEqual([]);
    expect(
      new PersonaRuntimeRepository(store).listAdaptations(spec.id)[0]?.status,
    ).toBe("needs_review");
    expect(
      service.snapshotAsOf({ baseSpec: spec, nowUtc: NOW, topicText: "工作" })
        .relationshipPractices,
    ).toHaveLength(1);
  });

  it("fails revision and provenance conflicts atomically", () => {
    message("conflict");
    expect(() =>
      service.captureExplicitPractice({
        baseSpec: spec,
        sourceMessageId: "conflict",
        nowUtc: NOW,
        mode: "enforced",
        expectedRevision: 1,
      }),
    ).toThrow(/revision_conflict/u);
    expect(() =>
      service.captureExplicitPractice({
        baseSpec: spec,
        sourceMessageId: "conflict",
        nowUtc: NOW,
        mode: "enforced",
        expectedMemoryRevision: 1,
      }),
    ).toThrow(/memory_revision_conflict/u);
    const faulty = new PersonaRuntimeService(store, {
      currentRevision: (id) => validity.currentRevision(id),
      readSource: (...args) => validity.readSource(...args),
      isSourceCurrent: (...args) => validity.isSourceCurrent(...args),
      isDerivedCurrent: (...args) => validity.isDerivedCurrent(...args),
      registerDependencies: () => false,
    });
    expect(() =>
      faulty.captureExplicitPractice({
        baseSpec: spec,
        sourceMessageId: "conflict",
        nowUtc: NOW,
        mode: "enforced",
      }),
    ).toThrow(/evidence_changed/u);
    expect(snapshot().revision).toBe(0);
    expect(
      database.prepare("SELECT count(*) AS count FROM memories").get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT count(*) AS count FROM persona_observations")
        .get(),
    ).toEqual({ count: 0 });
  });

  it("withdraws one facet without leaking its full source through the remaining practice", () => {
    message("two_facets", "我谈工作烦恼时，先听我说，不急着建议，也不要追问。");
    expect(capture("two_facets").acceptedAdaptationIds).toHaveLength(2);
    message(
      "one_withdrawal",
      "以后聊工作不用总先听，直接给我建议。",
      "user",
      LATER,
    );
    capture("one_withdrawal", LATER);
    expect(
      snapshot().relationshipPractices.map((item) => item.proposal.facet),
    ).toEqual(["follow_up_questions"]);
    expect(snapshot().suppressedMemoryIds).toHaveLength(1);
  });

  it("preserves compatible author edits and marks practice-context changes for review", () => {
    message("author");
    capture("author");
    const original = spec;
    spec = CharacterSpecSchema.parse({
      ...spec,
      version: 2,
      identity: { ...spec.identity, worldSetting: "另一条街上的书店" },
      updatedAtUtc: LATER,
    });
    store.insertCharacterVersion(spec);
    store.updateCharacterHead(spec);
    expect(snapshot().relationshipPractices).toEqual([]);
    service.reconcileBase({ baseSpec: spec, nowUtc: LATER });
    expect(snapshot().relationshipPractices).toHaveLength(1);
    expect(snapshot().revision).toBe(2);
    spec = CharacterSpecSchema.parse({
      ...spec,
      version: 3,
      dialogue: { ...spec.dialogue, verbosity: 0.91 },
    });
    store.insertCharacterVersion(spec);
    store.updateCharacterHead(spec);
    service.reconcileBase({
      baseSpec: spec,
      nowUtc: "2026-09-08T12:00:00.000Z",
    });
    expect(snapshot().relationshipPractices).toEqual([]);
    expect(
      new PersonaRuntimeRepository(store).listAdaptations(spec.id)[0]?.status,
    ).toBe("needs_review");
    expect(store.getCharacterSpec(spec.id, 1)).toEqual(original);
    const event = database
      .prepare("SELECT id FROM persona_revision_events LIMIT 1")
      .get() as { id: string };
    expect(() =>
      database
        .prepare("DELETE FROM persona_revision_events WHERE id = ?")
        .run(event.id),
    ).toThrow(/immutable/iu);
  });
});
