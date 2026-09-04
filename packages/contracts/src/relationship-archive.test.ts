import { describe, expect, it } from "vitest";

import {
  RelationshipArchiveLetterEntrySchema,
  RelationshipArchivePageResponseSchema,
  RelationshipArchiveQuerySchema,
  RelationshipRecapSchema,
  ShareComposerSelectionSchema,
} from "./relationship-archive.js";

const NOW = "2026-09-15T10:00:00.000Z";

describe("relationship archive contracts", () => {
  it("forbids an unopened agent reply preview", () => {
    const entry = {
      id: "archive-letter-1",
      agentId: "agent-1",
      entryType: "letter",
      title: "一封尚未启封的回信",
      summary: "信件已抵达。",
      effectiveAtUtc: "2026-09-13T20:00:00.000Z",
      recordedAtUtc: NOW,
      href: "/letters/reply-1",
      sourceIds: ["reply-1"],
      letterId: "reply-1",
      threadId: "thread-1",
      direction: "agent_to_user",
      status: "delivered_unread",
      postmark: "2026-09-08 · Asia/Shanghai",
      waitingDays: 5,
      previewText: "THIS MUST STAY SEALED",
    } as const;
    expect(RelationshipArchiveLetterEntrySchema.safeParse(entry).success).toBe(
      false,
    );
    expect(
      RelationshipArchiveLetterEntrySchema.safeParse({
        ...entry,
        status: "read",
      }).success,
    ).toBe(true);
  });

  it("keeps archive responses cursor-paged and strict", () => {
    expect(
      RelationshipArchivePageResponseSchema.safeParse({
        items: [],
        nextCursor: "2026-09-01T00:00:00.000Z|event-20",
        serverTimeUtc: NOW,
      }).success,
    ).toBe(true);
    expect(
      RelationshipArchivePageResponseSchema.safeParse({
        items: [],
        serverTimeUtc: NOW,
        allRows: [],
      }).success,
    ).toBe(false);
  });

  it("accepts exact archive entry ids but never combines them with a cursor", () => {
    expect(
      RelationshipArchiveQuerySchema.parse({
        entryId: "outcome_record:outcome-42",
        includePreviewText: "false",
      }),
    ).toMatchObject({
      filter: "all",
      entryId: "outcome_record:outcome-42",
      includePreviewText: false,
      limit: 40,
    });
    expect(
      RelationshipArchiveQuerySchema.safeParse({
        entryId: "unknown_source:outcome-42",
      }).success,
    ).toBe(false);
    expect(
      RelationshipArchiveQuerySchema.safeParse({
        entryId: "domain_event:event-42",
        cursor: "opaque-cursor",
      }).success,
    ).toBe(false);
  });

  it("defaults to metadata-only sharing and requires deliberate excerpt selection", () => {
    const letterOnlyDefault = ShareComposerSelectionSchema.parse({
      templateVersion: "relationship-share-v1",
      letterId: "letter-1",
    });
    expect(letterOnlyDefault).toMatchObject({
      includeEnvelope: true,
      includePostmark: true,
      includeWaitingDays: true,
      includeKeepsake: false,
      includeExcerpt: false,
      redactions: [],
    });
    expect(letterOnlyDefault).not.toHaveProperty("excerpt");

    const safeDefault = ShareComposerSelectionSchema.parse({
      templateVersion: "relationship-share-v1",
      keepsakeId: "keepsake-1",
    });
    expect(safeDefault).toMatchObject({
      includeEnvelope: true,
      includeKeepsake: false,
      includeExcerpt: false,
      redactions: [],
    });
    expect(safeDefault).not.toHaveProperty("excerpt");

    expect(
      ShareComposerSelectionSchema.safeParse({
        templateVersion: "relationship-share-v1",
        keepsakeId: "keepsake-1",
        excerpt: "隐私正文",
      }).success,
    ).toBe(false);
    expect(
      ShareComposerSelectionSchema.safeParse({
        templateVersion: "relationship-share-v1",
        keepsakeId: "keepsake-1",
        includeExcerpt: true,
        letterId: "reply-1",
        excerpt: "手动选中的一句话",
        redactions: [{ start: 0, end: 2, label: "name" }],
      }).success,
    ).toBe(true);
    expect(
      ShareComposerSelectionSchema.safeParse({
        templateVersion: "relationship-share-v1",
        includeExcerpt: true,
        letterId: "reply-1",
        excerpt: "四个字",
        redactions: [{ start: 2, end: 5, label: "custom" }],
      }).success,
    ).toBe(false);
    expect(
      ShareComposerSelectionSchema.safeParse({
        templateVersion: "relationship-share-v1",
        includeExcerpt: true,
        letterId: "reply-1",
        excerpt: "一二三四五六",
        redactions: [
          { start: 1, end: 4, label: "name" },
          { start: 3, end: 5, label: "place" },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires every recap item to cite its durable source", () => {
    const base = {
      version: "relationship_recap_v1",
      agentId: "agent-1",
      periodStartUtc: "2026-09-01T00:00:00.000Z",
      periodEndUtc: NOW,
      generatedAtUtc: NOW,
      items: [
        {
          title: "第一封信",
          summary: "从一次缓慢往返开始。",
          sourceType: "letter",
          sourceIds: [],
        },
      ],
    } as const;
    expect(RelationshipRecapSchema.safeParse(base).success).toBe(false);
    expect(
      RelationshipRecapSchema.safeParse({
        ...base,
        items: [{ ...base.items[0], sourceIds: ["letter-1"] }],
      }).success,
    ).toBe(true);
  });
});
