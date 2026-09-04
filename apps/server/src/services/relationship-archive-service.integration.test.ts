import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  LetterReplyProposal,
  RelationshipArchiveEntry,
} from "@personasim/contracts";
import { canonicalLetterContent } from "@personasim/features";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { FakeClock } from "../runtime/clock.js";
import {
  CorrespondenceCryptoService,
  hashLetterReplyProposal,
} from "./correspondence-crypto-service.js";
import {
  RelationshipArchiveError,
  RelationshipArchiveService,
} from "./relationship-archive-service.js";

const AGENT_ID = "agent-relationship-archive";
const NOW = "2026-09-15T12:00:00.000Z";
const INSTANCE_SECRET = Buffer.alloc(32, 0x47).toString("base64");
const PRIVATE_USER_BODY =
  "PRIVATE USER LETTER：在杭州的旧书店门口，我们约定明年再见。";
const PRIVATE_REPLY_BODY =
  "PRIVATE SEALED REPLY：我也记得那家旧书店，并会把约定留在信里。";

describe("RelationshipArchiveService SQLite integration", () => {
  let database: Database;
  let service: RelationshipArchiveService;

  beforeEach(() => {
    database = openDatabase(":memory:");
    runMigrations(database);
    seedCharacter(database);
    const crypto = CorrespondenceCryptoService.initialize(database, {
      mode: "enforced",
      instanceSecret: INSTANCE_SECRET,
      nowUtc: "2026-09-01T00:00:00.000Z",
    });
    if (crypto === undefined) throw new Error("Expected correspondence crypto");
    seedLetters(database, crypto);
    seedDomainEvents(database, 107);
    service = new RelationshipArchiveService(
      database,
      new FakeClock(NOW),
      crypto,
    );
  });

  afterEach(() => database.close());

  it("pages 100+ durable items with a stable effective-time/id cursor and traceable links", () => {
    const collected: RelationshipArchiveEntry[] = [];
    const cursorValues: string[] = [];
    let cursor: string | undefined;
    do {
      const page = service.listPage(AGENT_ID, {
        filter: "life",
        limit: 23,
        ...(cursor === undefined ? {} : { cursor }),
      });
      expect(page.items.length).toBeLessThanOrEqual(23);
      collected.push(...page.items);
      cursor = page.nextCursor;
      if (cursor !== undefined) cursorValues.push(cursor);
    } while (cursor !== undefined);

    expect(collected).toHaveLength(107);
    expect(new Set(collected.map((item) => item.id)).size).toBe(107);
    expect(new Set(cursorValues).size).toBe(cursorValues.length);
    for (const item of collected) {
      expect(item.sourceIds).toContain(item.id);
      expect(item.href).toContain(encodeURIComponent(item.id));
      expect(item.summary).not.toContain("PRIVATE EVENT PAYLOAD");
    }
    expect(
      collected.every((item, index) => {
        const next = collected[index + 1];
        if (next === undefined) return true;
        if (item.effectiveAtUtc !== next.effectiveAtUtc) {
          return item.effectiveAtUtc > next.effectiveAtUtc;
        }
        return item.id > next.id;
      }),
    ).toBe(true);

    expect(() =>
      service.listPage(AGENT_ID, {
        filter: "correspondence",
        limit: 10,
        cursor: cursorValues[0]!,
      }),
    ).toThrow(RelationshipArchiveError);

    const oldestEntryId = "domain_event:event-archive-000";
    const exact = service.listPage(AGENT_ID, {
      entryId: oldestEntryId,
      limit: 100,
    });
    expect(exact.items).toEqual([
      expect.objectContaining({
        id: "event-archive-000",
        agentId: AGENT_ID,
        href: `/characters/${AGENT_ID}/relationship-archive?entryId=${encodeURIComponent(oldestEntryId)}`,
        sourceIds: ["event-archive-000"],
      }),
    ]);
    expect(exact).not.toHaveProperty("nextCursor");

    expect(
      service.listPage(AGENT_ID, {
        filter: "correspondence",
        entryId: oldestEntryId,
      }).items,
    ).toEqual([]);
  });

  it("projects American local dates to true UTC before through-time, ordering, and cursor pagination", () => {
    setCharacterTimezone(database, "America/Los_Angeles");
    seedArchiveMilestone(database, {
      id: "milestone-america-previous-afternoon",
      localDate: "2026-09-14",
      period: "afternoon",
      precision: "period",
      title: "前一天下午",
    });
    seedArchiveMilestone(database, {
      id: "milestone-america-local-day",
      localDate: "2026-09-15",
      period: null,
      precision: "day",
      title: "当地日开始",
    });
    seedArchiveMilestone(database, {
      id: "milestone-america-zz-future-morning",
      localDate: "2026-09-15",
      period: "morning",
      precision: "period",
      title: "尚未到来的当地早晨",
    });

    const first = service.listPage(AGENT_ID, {
      filter: "turning_points",
      limit: 1,
    });
    expect(first.items).toEqual([
      expect.objectContaining({
        id: "milestone-america-local-day",
        effectiveAtUtc: "2026-09-15T07:00:00.000Z",
      }),
    ]);
    expect(first.nextCursor).toBeDefined();

    const second = service.listPage(AGENT_ID, {
      filter: "turning_points",
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items).toEqual([
      expect.objectContaining({
        id: "milestone-america-previous-afternoon",
        effectiveAtUtc: "2026-09-14T21:00:00.000Z",
      }),
    ]);
    expect(second.nextCursor).toBeUndefined();
    expect(
      service.listPage(AGENT_ID, {
        filter: "turning_points",
        entryId: "relationship_milestone:milestone-america-zz-future-morning",
      }).items,
    ).toEqual([]);

    const recap = service.buildRecap({
      agentId: AGENT_ID,
      fromUtc: "2026-09-15T06:30:00.000Z",
      toUtc: NOW,
    });
    expect(recap.items).toEqual([
      expect.objectContaining({
        title: "当地日开始",
        sourceIds: ["milestone-america-local-day"],
      }),
    ]);

    const afterMorning = new RelationshipArchiveService(
      database,
      new FakeClock("2026-09-15T14:00:00.000Z"),
    );
    const afterMorningFirst = afterMorning.listPage(AGENT_ID, {
      filter: "turning_points",
      limit: 1,
    });
    expect(afterMorningFirst.items).toEqual([
      expect.objectContaining({
        id: "milestone-america-zz-future-morning",
        effectiveAtUtc: "2026-09-15T13:00:00.000Z",
      }),
    ]);
    expect(afterMorningFirst.nextCursor).toBeDefined();
    expect(
      afterMorning.listPage(AGENT_ID, {
        filter: "turning_points",
        limit: 1,
        cursor: afterMorningFirst.nextCursor,
      }).items,
    ).toEqual([
      expect.objectContaining({
        id: "milestone-america-local-day",
        effectiveAtUtc: "2026-09-15T07:00:00.000Z",
      }),
    ]);
  });

  it("never projects unopened reply plaintext and keeps ordinary archive reads metadata-only", () => {
    const page = service.listPage(AGENT_ID, {
      filter: "correspondence",
      limit: 20,
    });
    const hidden = page.items.find((item) => item.id === "letter-hidden-reply");
    expect(hidden).toMatchObject({
      entryType: "letter",
      direction: "agent_to_user",
      status: "delivered_unread",
      sourceIds: ["letter-hidden-reply"],
      href: `/letters/letter-hidden-reply?agentId=${AGENT_ID}`,
    });
    expect(hidden).not.toHaveProperty("previewText");
    expect(JSON.stringify(page)).not.toContain(PRIVATE_REPLY_BODY);
    expect(JSON.stringify(page)).not.toContain("ciphertext");
    expect(JSON.stringify(page)).toContain("PRIVATE USER LETTER");

    const metadataOnlyPage = service.listPage(AGENT_ID, {
      filter: "correspondence",
      includePreviewText: false,
      limit: 20,
    });
    expect(
      metadataOnlyPage.items.find((item) => item.id === "letter-user"),
    ).not.toHaveProperty("previewText");
    expect(JSON.stringify(metadataOnlyPage)).not.toContain(PRIVATE_USER_BODY);

    const exactHidden = service.listPage(AGENT_ID, {
      entryId: "letter:letter-hidden-reply",
      includePreviewText: false,
    });
    expect(exactHidden.items).toHaveLength(1);
    expect(exactHidden.items[0]).not.toHaveProperty("previewText");
    expect(JSON.stringify(exactHidden)).not.toContain(PRIVATE_REPLY_BODY);
    expect(JSON.stringify(exactHidden)).not.toContain("ciphertext");

    const exactUserMetadata = service.listPage(AGENT_ID, {
      entryId: "letter:letter-user",
      includePreviewText: false,
    });
    expect(exactUserMetadata.items).toHaveLength(1);
    expect(exactUserMetadata.items[0]).not.toHaveProperty("previewText");
    expect(JSON.stringify(exactUserMetadata)).not.toContain(PRIVATE_USER_BODY);
  });

  it("does not expose an in-transit agent reply through an exact lookup", () => {
    expect(
      service.listPage(AGENT_ID, {
        entryId: "letter:letter-hidden-in-transit",
        includePreviewText: false,
      }).items,
    ).toEqual([]);
  });

  it("builds metadata-only shares by default and validates exact excerpts plus redactions", () => {
    const metadataOnly = service.buildShareProjection(AGENT_ID, {
      templateVersion: "relationship-share-v1",
      letterId: "letter-user",
      includeEnvelope: true,
      includePostmark: true,
      includeWaitingDays: true,
      includeKeepsake: false,
      includeExcerpt: false,
      redactions: [],
    });
    expect(metadataOnly).toMatchObject({
      exportMode: "local_png",
      templateVersion: "relationship-share-v1",
      envelope: {
        letterId: "letter-user",
        postmark: "2026-09-01 · Asia/Shanghai",
        waitingDays: 5,
      },
      sourceIds: ["letter-user"],
    });
    expect(metadataOnly).not.toHaveProperty("redactedExcerpt");
    expect(JSON.stringify(metadataOnly)).not.toContain(PRIVATE_USER_BODY);

    const excerpt = "在杭州的旧书店门口，我们约定明年再见。";
    const redacted = service.buildShareProjection(AGENT_ID, {
      templateVersion: "relationship-share-v1",
      letterId: "letter-user",
      includeEnvelope: false,
      includePostmark: false,
      includeWaitingDays: false,
      includeKeepsake: false,
      includeExcerpt: true,
      excerpt,
      redactions: [
        { start: 1, end: 3, label: "place" },
        { start: 4, end: 7, label: "place" },
      ],
    });
    expect(redacted.redactedExcerpt).toBe("在██的███门口，我们约定明年再见。");
    expect(redacted).not.toHaveProperty("publicUrl");

    expect(() =>
      service.buildShareProjection(AGENT_ID, {
        templateVersion: "relationship-share-v1",
        letterId: "letter-user",
        includeEnvelope: false,
        includePostmark: false,
        includeWaitingDays: false,
        includeKeepsake: false,
        includeExcerpt: true,
        excerpt: "这句话并不在信里",
        redactions: [],
      }),
    ).toThrowError(/exact part/u);
  });

  it("rejects excerpts from an unopened reply before decryption", () => {
    expect(() =>
      service.buildShareProjection(AGENT_ID, {
        templateVersion: "relationship-share-v1",
        letterId: "letter-hidden-reply",
        includeEnvelope: false,
        includePostmark: false,
        includeWaitingDays: false,
        includeKeepsake: false,
        includeExcerpt: true,
        excerpt: PRIVATE_REPLY_BODY,
        redactions: [],
      }),
    ).toThrowError(/unopened agent reply/u);
  });

  it("allows an explicitly selected excerpt only after the encrypted reply is read", () => {
    database
      .prepare(
        `UPDATE letters
         SET status = 'read', opened_at_utc = ?, updated_at_utc = ?
         WHERE id = 'letter-hidden-reply'`,
      )
      .run("2026-09-12T00:00:00.000Z", "2026-09-12T00:00:00.000Z");

    const projection = service.buildShareProjection(AGENT_ID, {
      templateVersion: "relationship-share-v1",
      letterId: "letter-hidden-reply",
      includeEnvelope: false,
      includePostmark: false,
      includeWaitingDays: false,
      includeKeepsake: false,
      includeExcerpt: true,
      excerpt: PRIVATE_REPLY_BODY,
      redactions: [{ start: 0, end: 7, label: "custom" }],
    });
    expect(projection.redactedExcerpt).toBe(
      "███████ SEALED REPLY：我也记得那家旧书店，并会把约定留在信里。",
    );
    const persisted = database
      .prepare("SELECT subject, body FROM letters WHERE id = ?")
      .get("letter-hidden-reply");
    expect(persisted).toEqual({ subject: null, body: null });
  });

  it("selects recap sources deterministically and rejects invented evidence", () => {
    const recap = service.buildRecap({
      agentId: AGENT_ID,
      fromUtc: "2026-09-01T00:00:00.000Z",
      toUtc: NOW,
      limit: 5,
    });
    expect(recap.items).toHaveLength(5);
    expect(recap.items.every((item) => item.sourceIds.length === 1)).toBe(true);
    expect(() =>
      service.validateRecapProjection({
        ...recap,
        items: [
          {
            title: "模型虚构的事件",
            summary: "这条内容没有持久化证据。",
            sourceType: "domain_event",
            sourceIds: ["event-never-existed"],
          },
        ],
      }),
    ).toThrowError(/does not belong/u);
  });
});

function seedCharacter(database: Database): void {
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO characters(
           id, current_version, status, tier, name, source_type,
           created_at_utc, updated_at_utc
         ) VALUES (?, 1, 'published', 'daily', '档案测试角色', 'original', ?, ?)`,
      )
      .run(AGENT_ID, "2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
    database
      .prepare(
        `INSERT INTO character_versions(
           character_id, version, status, spec_json, created_at_utc
         ) VALUES (?, 1, 'published', ?, ?)`,
      )
      .run(
        AGENT_ID,
        JSON.stringify({ identity: { timezone: "Asia/Shanghai" } }),
        "2026-08-01T00:00:00.000Z",
      );
  })();
}

function seedDomainEvents(database: Database, count: number): void {
  const insert = database.prepare(
    `INSERT INTO domain_events(
       id, agent_id, stream_type, stream_id, stream_version, event_type,
       recorded_at_utc, effective_at_utc, payload_json, correlation_id,
       causation_id, idempotency_key
     ) VALUES (?, ?, 'life', ?, 1, 'life.changed', ?, ?, ?, NULL, NULL, ?)`,
  );
  database.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const id = `event-archive-${String(index).padStart(3, "0")}`;
      const atUtc = new Date(
        Date.parse("2026-09-01T00:00:00.000Z") + index * 60_000,
      ).toISOString();
      insert.run(
        id,
        AGENT_ID,
        `life-${index}`,
        atUtc,
        atUtc,
        JSON.stringify({ secret: `PRIVATE EVENT PAYLOAD ${index}` }),
        `archive-event:${index}`,
      );
    }
  })();
}

function setCharacterTimezone(database: Database, timezone: string): void {
  database
    .prepare(
      `UPDATE character_versions SET spec_json = ?
        WHERE character_id = ? AND version = 1`,
    )
    .run(JSON.stringify({ identity: { timezone } }), AGENT_ID);
}

function seedArchiveMilestone(
  database: Database,
  input: {
    id: string;
    localDate: string;
    period: "morning" | "afternoon" | null;
    precision: "day" | "period";
    title: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO relationship_milestones(
         id, agent_id, kind, title, summary, significance,
         intervention_ids_json, decision_ids_json, outcome_ids_json,
         reflection_ids_json, source_message_ids_json, effective_local_date,
         effective_period, temporal_precision, recorded_at_utc,
         idempotency_key, schema_version, milestone_json
       ) VALUES (?, ?, 'turning_point', ?, ?, 0.8, '["evidence"]', '[]', '[]',
                 '[]', '["evidence"]', ?, ?, ?, '2026-09-14T05:00:00.000Z',
                 ?, 1, '{}')`,
    )
    .run(
      input.id,
      AGENT_ID,
      input.title,
      input.title,
      input.localDate,
      input.period,
      input.precision,
      `archive-milestone:${input.id}`,
    );
}

function seedLetters(
  database: Database,
  crypto: CorrespondenceCryptoService,
): void {
  const proposal: LetterReplyProposal = {
    subject: "旧书店的回音",
    salutation: "亲爱的朋友：",
    paragraphs: [PRIVATE_REPLY_BODY],
    closing: "等下一封信",
    signature: "档案测试角色",
    referencedEvidenceIds: ["letter-user"],
  };
  const contentHash = hashLetterReplyProposal(proposal);
  const encrypted = crypto.encryptReply({
    letterId: "letter-hidden-reply",
    direction: "agent_to_user",
    contentHash,
    authoredEffectiveAtUtc: "2026-09-06T00:00:00.000Z",
    arrivalDueAtUtc: "2026-09-11T00:00:00.000Z",
    proposal,
    createdAtUtc: "2026-09-06T00:00:00.000Z",
  });
  const inTransitEncrypted = crypto.encryptReply({
    letterId: "letter-hidden-in-transit",
    direction: "agent_to_user",
    contentHash,
    authoredEffectiveAtUtc: "2026-09-12T00:00:00.000Z",
    arrivalDueAtUtc: "2026-09-17T00:00:00.000Z",
    proposal,
    createdAtUtc: "2026-09-12T00:00:00.000Z",
  });

  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO correspondence_threads(
           id, agent_id, status, root_letter_id, latest_letter_id,
           created_at_utc, updated_at_utc, closed_at_utc
         ) VALUES ('thread-archive', ?, 'open', NULL, NULL, ?, ?, NULL)`,
      )
      .run(AGENT_ID, "2026-09-01T00:00:00.000Z", "2026-09-11T00:00:00.000Z");
    database
      .prepare(
        `INSERT INTO letters(
           id, thread_id, agent_id, direction, status, subject, body,
           content_hash, transit_policy_version, transit_timezone,
           dispatched_at_utc, arrival_due_at_utc, effective_author_time_utc,
           delivered_effective_at_utc, processed_at_utc, read_at_utc,
           created_at_utc, updated_at_utc
         ) VALUES (
           'letter-user', 'thread-archive', ?, 'user_to_agent', 'read',
           '旧书店', ?, ?, 'fixed_5d_v1', 'Asia/Shanghai', ?, ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        AGENT_ID,
        PRIVATE_USER_BODY,
        createHash("sha256")
          .update(
            canonicalLetterContent({
              subject: "旧书店",
              body: PRIVATE_USER_BODY,
            }),
            "utf8",
          )
          .digest("hex"),
        "2026-09-01T00:00:00.000Z",
        "2026-09-06T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z",
        "2026-09-06T00:00:00.000Z",
        "2026-09-06T01:00:00.000Z",
        "2026-09-06T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z",
        "2026-09-06T01:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO letters(
           id, thread_id, agent_id, reply_to_letter_id, direction, status,
           subject, body, content_hash, encrypted_ciphertext, encrypted_iv,
           encrypted_auth_tag, encrypted_key_version, encrypted_aad_hash,
           encrypted_created_at_utc, transit_policy_version, transit_timezone,
           dispatched_at_utc, arrival_due_at_utc, effective_author_time_utc,
           delivered_effective_at_utc, processed_at_utc, created_at_utc,
           updated_at_utc
         ) VALUES (
           'letter-hidden-reply', 'thread-archive', ?, 'letter-user',
           'agent_to_user', 'delivered_unread', NULL, NULL, ?, ?, ?, ?, ?, ?, ?,
           'fixed_5d_v1', 'Asia/Shanghai', ?, ?, ?, ?, ?, ?, ?
         )`,
      )
      .run(
        AGENT_ID,
        contentHash,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        encrypted.keyVersion,
        encrypted.aadHash,
        encrypted.createdAtUtc,
        "2026-09-06T00:00:00.000Z",
        "2026-09-11T00:00:00.000Z",
        "2026-09-06T00:00:00.000Z",
        "2026-09-11T00:00:00.000Z",
        "2026-09-11T02:00:00.000Z",
        "2026-09-06T00:00:00.000Z",
        "2026-09-11T02:00:00.000Z",
      );
    database
      .prepare(
        `INSERT INTO letters(
           id, thread_id, agent_id, reply_to_letter_id, direction, status,
           subject, body, content_hash, encrypted_ciphertext, encrypted_iv,
           encrypted_auth_tag, encrypted_key_version, encrypted_aad_hash,
           encrypted_created_at_utc, transit_policy_version, transit_timezone,
           dispatched_at_utc, arrival_due_at_utc, effective_author_time_utc,
           created_at_utc, updated_at_utc
         ) VALUES (
           'letter-hidden-in-transit', 'thread-archive', ?, NULL,
           'agent_to_user', 'in_transit', NULL, NULL, ?, ?, ?, ?, ?, ?, ?,
           'fixed_5d_v1', 'Asia/Shanghai', ?, ?, ?, ?, ?
         )`,
      )
      .run(
        AGENT_ID,
        contentHash,
        inTransitEncrypted.ciphertext,
        inTransitEncrypted.iv,
        inTransitEncrypted.authTag,
        inTransitEncrypted.keyVersion,
        inTransitEncrypted.aadHash,
        inTransitEncrypted.createdAtUtc,
        "2026-09-12T00:00:00.000Z",
        "2026-09-17T00:00:00.000Z",
        "2026-09-12T00:00:00.000Z",
        "2026-09-12T00:00:00.000Z",
        "2026-09-12T00:00:00.000Z",
      );
    database
      .prepare(
        `UPDATE correspondence_threads
         SET root_letter_id = 'letter-user', latest_letter_id = 'letter-hidden-reply'
         WHERE id = 'thread-archive'`,
      )
      .run();
  })();
}
