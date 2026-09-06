import { describe, expect, it } from "vitest";
import type {
  KeepsakeSummaryResponse,
  RelationshipArchiveEntry,
} from "@personasim/contracts";
import {
  addRedaction,
  archiveEntryDisplayTitle,
  canUseLetterForExcerpt,
  groupArchiveByMonth,
  redactForPreview,
  selectRelationshipShareSources,
} from "./relationshipArchive";

function letter(
  id: string,
  direction: "user_to_agent" | "agent_to_user",
  status: "in_transit" | "delivered_unread" | "read",
  effectiveAtUtc: string,
): RelationshipArchiveEntry {
  return {
    id,
    agentId: "agent-1",
    entryType: "letter",
    title: `信件 ${id}`,
    summary: "只包含安全投影。",
    effectiveAtUtc,
    recordedAtUtc: effectiveAtUtc,
    href: `/letters/${id}`,
    sourceIds: [id],
    letterId: id,
    threadId: "thread-1",
    direction,
    status,
    postmark: "2026-09-01 · Asia/Shanghai",
    waitingDays: 5,
  };
}

function archiveKeepsake(id: string): RelationshipArchiveEntry {
  return {
    id,
    agentId: "agent-1",
    entryType: "keepsake",
    title: `纪念物 ${id}`,
    summary: "一件安全的纪念物投影。",
    effectiveAtUtc: "2026-09-04T00:00:00.000Z",
    recordedAtUtc: "2026-09-04T00:00:00.000Z",
    href: `/characters/agent-1/relationship-archive?entryId=keepsake:${id}`,
    sourceIds: [id],
    keepsakeId: id,
    keepsakeKind: "ticket_stub",
    thumbnailUrl: `/api/keepsakes/${id}/thumbnail`,
  };
}

describe("relationship archive presentation", () => {
  it("groups cursor-page entries by relationship-local month without reordering", () => {
    const entries = [
      letter("letter-2", "user_to_agent", "read", "2026-09-30T16:30:00.000Z"),
      letter("letter-1", "user_to_agent", "read", "2026-09-01T00:00:00.000Z"),
    ];
    const groups = groupArchiveByMonth(entries, "zh-CN", "Asia/Shanghai");

    expect(groups.map((group) => group.key)).toEqual(["2026-10", "2026-09"]);
    expect(
      groups.flatMap((group) => group.items.map((item) => item.id)),
    ).toEqual(["letter-2", "letter-1"]);
  });

  it("never offers an unopened reply as an excerpt source", () => {
    expect(
      canUseLetterForExcerpt(
        letter(
          "hidden",
          "agent_to_user",
          "delivered_unread",
          "2026-09-03T00:00:00.000Z",
        ),
      ),
    ).toBe(false);
    expect(
      canUseLetterForExcerpt(
        letter("opened", "agent_to_user", "read", "2026-09-03T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("projects internal domain event names into relationship language", () => {
    const entry = {
      ...letter("event-1", "user_to_agent", "read", "2026-09-03T00:00:00.000Z"),
      title: "life.daily_context_created",
    };
    expect(archiveEntryDisplayTitle(entry)).toBe("一天的生活开始展开");
  });

  it("builds ordered non-overlapping manual redactions and a safe preview", () => {
    const excerpt = "在杭州和林枫一起看雨。";
    const first = addRedaction([], excerpt, 1, 3, "place");
    const second = addRedaction(first, excerpt, 4, 6, "name");

    expect(addRedaction(second, excerpt, 2, 5, "custom")).toEqual(second);
    expect(redactForPreview(excerpt, second)).toEqual([
      { text: "在", redacted: false },
      { text: "██", redacted: true, label: "place" },
      { text: "和", redacted: false },
      { text: "██", redacted: true, label: "name" },
      { text: "一起看雨。", redacted: false },
    ]);
  });

  it("prefers the selected archive entry in custom-share links", () => {
    const firstLetter = letter(
      "first-letter",
      "user_to_agent",
      "read",
      "2026-09-03T00:00:00.000Z",
    );
    const selectedLetter = letter(
      "selected-letter",
      "agent_to_user",
      "read",
      "2026-09-02T00:00:00.000Z",
    );
    const selectedKeepsake = archiveKeepsake("selected-keepsake");
    const shelfKeepsake: KeepsakeSummaryResponse = {
      id: "first-shelf-keepsake",
      agentId: "agent-1",
      title: "陈列柜第一件",
      kind: "ticket_stub",
      description: "安全摘要",
      status: "ready",
      createdEffectiveAtUtc: "2026-09-01T00:00:00.000Z",
    };
    const entries = [firstLetter, selectedLetter, selectedKeepsake];

    expect(
      selectRelationshipShareSources(entries, selectedLetter, shelfKeepsake),
    ).toEqual({
      letterId: "selected-letter",
      keepsakeId: "first-shelf-keepsake",
    });
    expect(
      selectRelationshipShareSources(entries, selectedKeepsake, shelfKeepsake),
    ).toEqual({
      letterId: "first-letter",
      keepsakeId: "selected-keepsake",
    });
  });
});
