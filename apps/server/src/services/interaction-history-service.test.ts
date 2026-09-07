import {
  buildInteractionEvidence,
  inspectInteractionAttribution,
} from "@personasim/features";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import {
  loadInteractionEvidence,
  projectInteractionHistory,
} from "./interaction-history-service.js";

const AGENT = "interaction-character";
const SESSION = "interaction-session";
const NOW = "2026-09-07T12:00:00.000Z";
const REQUEST = "以后聊工作时，请先听我说，不要急着给建议。";
const VALID = "明白了，是他对别人说的，跟你没关系。";
const INVALID =
  "你之前一直记得先听我说不急着给建议，那份是你主动给的，跟这事是两码事。";

describe("interaction history read projection", () => {
  let database: Database;
  let store: DatabaseStore;
  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    store = new DatabaseStore(database);
    database
      .prepare(
        `INSERT INTO characters(id, current_version, status, tier, name, source_type, created_at_utc, updated_at_utc)
      VALUES (?, 1, 'published', 'daily', 'Interaction', 'original', ?, ?)`,
      )
      .run(AGENT, NOW, NOW);
    database
      .prepare(
        `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
      VALUES (?, ?, 'Interaction', ?, ?)`,
      )
      .run(SESSION, AGENT, NOW, NOW);
  });
  afterEach(() => database.close());

  function insert(
    id: string,
    role: "user" | "assistant",
    content: string,
    createdAtUtc = "2026-09-07T01:00:00.000Z",
  ) {
    store.insertMessage({
      id,
      role,
      content,
      createdAtUtc,
      agentId: AGENT,
      sessionId: SESSION,
      messageKind: role === "user" ? "user" : "assistant_reply",
      metadata: {},
    });
  }

  it("retains the correct statement and immutable original while annotating only the unsupported sentence", () => {
    insert("t9", "user", REQUEST);
    insert("t14", "assistant", VALID + INVALID);
    const evidence = loadInteractionEvidence({
      store,
      agentId: AGENT,
      nowUtc: NOW,
    });
    const originals = [
      { id: "t9", role: "user", content: REQUEST },
      { id: "t14", role: "assistant", content: VALID + INVALID },
    ];
    const before = structuredClone(originals);
    const result = projectInteractionHistory(originals, evidence);
    expect(result.messages[1]?.content).toBe(VALID);
    expect(result.annotations).toMatchObject([
      { messageId: "t14", excludedText: INVALID },
    ]);
    expect(originals).toEqual(before);
    expect(
      database.prepare("SELECT content FROM messages WHERE id = 't14'").get(),
    ).toEqual({ content: VALID + INVALID });
    expect(
      database
        .prepare("SELECT content FROM message_archive WHERE id = 't14'")
        .get(),
    ).toEqual({ content: VALID + INVALID });
  });

  it("never imports an assistant assertion as support, including across repeated reads", () => {
    insert("t14", "assistant", INVALID);
    insert("another-copy", "assistant", INVALID);
    for (let count = 0; count < 2; count++) {
      const evidence = loadInteractionEvidence({
        store,
        agentId: AGENT,
        nowUtc: NOW,
      });
      expect(evidence.sourceMessages).toEqual([]);
      expect(evidence.historicalAnchors).toEqual([]);
      const projection = projectInteractionHistory(
        [{ id: "t14", role: "assistant", content: INVALID }],
        evidence,
      );
      expect(projection.messages[0]?.content).not.toContain(INVALID);
      expect(projection.annotations).toHaveLength(1);
    }
  });

  it("allows a later user-confirmed reverse history while excluding future messages from earlier snapshots", () => {
    insert("t9", "user", REQUEST);
    insert(
      "confirmation",
      "user",
      "这些年我一直先听你说，再讲自己的事情。",
      "2026-09-07T02:00:00.000Z",
    );
    const before = loadInteractionEvidence({
      store,
      agentId: AGENT,
      nowUtc: "2026-09-07T01:30:00.000Z",
    });
    expect(
      inspectInteractionAttribution({ text: INVALID, evidence: before })
        .allowed,
    ).toBe(false);
    const after = loadInteractionEvidence({
      store,
      agentId: AGENT,
      nowUtc: NOW,
    });
    expect(
      inspectInteractionAttribution({ text: INVALID, evidence: after }).allowed,
    ).toBe(true);
    expect(
      projectInteractionHistory(
        [{ id: "supported", role: "assistant", content: INVALID }],
        after,
      ).annotations,
    ).toEqual([]);
  });

  it.each(["needs_review", "superseded"])(
    "does not revive a corrected user report whose memory source is %s",
    (status) => {
      insert("report", "user", "这些年我一直先听你说。");
      database
        .prepare(
          `INSERT INTO memories(id, agent_id, type, content, tags_json, importance, confidence,
      source_message_id, created_at_utc, status) VALUES ('reported-memory', ?, 'episodic', '先听你说', '[]', 0.5, 0.9, 'report', ?, ?)`,
        )
        .run(AGENT, NOW, status);
      database
        .prepare(
          `INSERT INTO memory_evidence(id, memory_id, source_type, source_id, quote, recorded_at_utc, evidence_json)
      VALUES ('reported-source', 'reported-memory', 'message', 'report', '这些年我一直先听你说。', ?, '{}')`,
        )
        .run(NOW);
      const evidence = loadInteractionEvidence({
        store,
        agentId: AGENT,
        nowUtc: NOW,
      });
      expect(evidence.historicalAnchors).toEqual([]);
      expect(
        inspectInteractionAttribution({ text: INVALID, evidence }).allowed,
      ).toBe(false);
      expect(
        database
          .prepare("SELECT content FROM messages WHERE id = 'report'")
          .get(),
      ).toEqual({ content: "这些年我一直先听你说。" });
    },
  );

  it("leaves quoted denials and the user's own history untouched", () => {
    const evidence = buildInteractionEvidence({
      userId: "local-user",
      characterId: AGENT,
      messages: [],
    });
    const originals = [
      {
        id: "correction",
        role: "assistant",
        content: `“${INVALID}”这句话把主体反过来了。不是说你之前一直听我说。`,
      },
      { id: "user-report", role: "user", content: INVALID },
    ];
    const result = projectInteractionHistory(originals, evidence);
    expect(result.messages).toEqual(originals);
    expect(result.annotations).toEqual([]);
  });
});
