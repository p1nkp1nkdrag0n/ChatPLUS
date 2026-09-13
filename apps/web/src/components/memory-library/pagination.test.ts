import { describe, expect, it } from "vitest";
import type { DiaryEntry } from "../../api/diaries";
import {
  paginateDiaryEntries,
  readReadingAnchor,
  saveReadingAnchor,
  spreadForAnchor,
} from "./pagination";

const entry = (id: string, entryDate: string, body: string): DiaryEntry => ({
  id,
  agentId: "agent-1",
  entryDate,
  timezone: "Asia/Shanghai",
  title: "那天的手记",
  body,
  revision: 1,
  createdAtUtc: "2026-09-13T00:00:00.000Z",
  updatedAtUtc: "2026-09-13T00:00:00.000Z",
  sourceMessageIds: ["message-1"],
  validity: "current",
  hasNewMaterial: false,
});

describe("diary book pagination", () => {
  it("preserves long Chinese text, paragraph breaks, whitespace and whole emoji while starting each diary on the left", () => {
    const body = `今晚，你说起了那条小路。\n\n  我记住了这句话 👩🏽‍🚀。\n${"后来，我们慢慢聊了很久。".repeat(20)}`;
    const entries = [
      entry("late", "2026-09-13", body),
      entry("early", "2026-09-01", "短短一页。"),
    ];
    const pages = paginateDiaryEntries(
      entries,
      (page) => page.body.length <= (page.first ? 35 : 50),
    );
    expect(pages.length % 2).toBe(0);
    expect(pages[0]?.entryId).toBe("early");
    for (const item of entries) {
      const selected = pages.filter((page) => page?.entryId === item.id);
      expect(selected.map((page) => page!.body).join("")).toBe(item.body);
      expect(pages.findIndex((page) => page?.entryId === item.id) % 2).toBe(0);
      expect(selected.filter((page) => page!.first)).toHaveLength(1);
      expect(selected.filter((page) => page!.last)).toHaveLength(1);
    }
    expect(pages.some((page) => page?.body.includes("👩🏽‍🚀"))).toBe(true);
    expect(pages.some((page) => page?.body.endsWith("\u200d"))).toBe(false);
  });

  it("retains a semantic reading position after a narrower layout adds pages", () => {
    const entries = [
      entry("a", "2026-09-01", "甲".repeat(420)),
      entry("b", "2026-09-02", "乙".repeat(120)),
    ];
    const wide = paginateDiaryEntries(
      entries,
      (page) => page.body.length <= 100,
    );
    const narrow = paginateDiaryEntries(
      entries,
      (page) => page.body.length <= 40,
    );
    const anchor = { entryId: "a", offset: 300 };
    expect(spreadForAnchor(wide, anchor)).toBe(1);
    expect(spreadForAnchor(narrow, anchor)).toBe(3);
    expect(spreadForAnchor(narrow, { entryId: "removed", offset: 50 })).toBe(0);
    expect(
      narrow[spreadForAnchor(narrow, { entryId: "b", offset: 0 }) * 2]?.entryId,
    ).toBe("b");
  });

  it("locates the same bookmarked text when moving between single pages and desktop spreads", () => {
    const entries = [
      entry("a", "2026-09-01", "甲".repeat(150)),
      entry("b", "2026-09-02", "乙".repeat(510)),
    ];
    const desktop = paginateDiaryEntries(
      entries,
      (page) => page.body.length <= 85,
    );
    const phone = paginateDiaryEntries(
      entries,
      (page) => page.body.length <= 140,
    ).filter((page) => page !== null);
    const anchor = { entryId: "b", offset: 300 };
    const phonePage = phone[spreadForAnchor(phone, anchor, 1)]!;
    expect(phonePage.entryId).toBe(anchor.entryId);
    expect(phonePage.offset).toBeLessThanOrEqual(anchor.offset);
    expect(phonePage.offset + phonePage.body.length).toBeGreaterThan(
      anchor.offset,
    );

    const desktopIndex = spreadForAnchor(desktop, anchor);
    expect(
      desktop
        .slice(desktopIndex * 2, desktopIndex * 2 + 2)
        .some(
          (page) =>
            page?.entryId === anchor.entryId &&
            page.offset <= anchor.offset &&
            page.offset + page.body.length > anchor.offset,
        ),
    ).toBe(true);
    const savedOnPhone = {
      entryId: phonePage.entryId,
      offset: phonePage.offset,
    };
    expect(desktop[spreadForAnchor(desktop, savedOnPhone) * 2]?.entryId).toBe(
      "b",
    );
  });

  it("reaches every text page and the final page after removing binding blanks for a phone", () => {
    const entries = [
      entry("first", "2026-09-01", "甲".repeat(250)),
      entry("middle", "2026-09-02", "  中间的一小篇 👩🏽‍🚀。\n\n"),
      entry("last", "2026-09-03", "末".repeat(250)),
    ];
    const bound = paginateDiaryEntries(
      entries,
      (page) => page.body.length <= 100,
    );
    expect(bound.filter((page) => page === null)).toHaveLength(3);
    expect(bound.at(-1)).toBeNull();
    const phone = bound.filter((page) => page !== null);
    const reached = phone.map((page, expectedIndex) => {
      const index = spreadForAnchor(
        phone,
        {
          entryId: page.entryId,
          offset: page.offset,
        },
        1,
      );
      expect(index).toBe(expectedIndex);
      return phone[index]!.body;
    });
    expect(reached.join("")).toBe(entries.map((item) => item.body).join(""));
    const last = phone.at(-1)!;
    expect(
      spreadForAnchor(
        phone,
        {
          entryId: last.entryId,
          offset: last.offset + last.body.length,
        },
        1,
      ),
    ).toBe(phone.length - 1);
    expect(spreadForAnchor(phone, undefined, 1)).toBe(0);
    expect(spreadForAnchor([], { entryId: "missing", offset: 0 }, 1)).toBe(0);
  });

  it("makes progress even when one grapheme cannot fit and never drops the final text", () => {
    const pages = paginateDiaryEntries(
      [entry("tiny", "2026-09-01", "👨‍👩‍👧‍👦甲乙")],
      () => false,
    );
    expect(pages.filter(Boolean).map((page) => page!.body)).toEqual([
      "👨‍👩‍👧‍👦",
      "甲",
      "乙",
    ]);
    expect(pages).toHaveLength(4);
    expect(paginateDiaryEntries([], () => true)).toEqual([]);
  });

  it("does not require browser storage to read or turn pages", () => {
    expect(() =>
      saveReadingAnchor("agent:2026-09", { entryId: "a", offset: 0 }),
    ).not.toThrow();
    expect(readReadingAnchor("agent:2026-09")).toBeUndefined();
  });

  it("moves a whole paragraph to the final page instead of leaving one short trailing sentence", () => {
    const body = `${"甲".repeat(100)}\n\n${"乙".repeat(100)}\n\n${"丙".repeat(15)}`;
    const pages = paginateDiaryEntries(
      [entry("balanced", "2026-09-13", body)],
      (page) => page.body.length <= 210,
    );
    expect(pages).toHaveLength(2);
    expect(pages[0]?.body).toBe(`${"甲".repeat(100)}\n\n`);
    expect(pages[1]?.body).toBe(`${"乙".repeat(100)}\n\n${"丙".repeat(15)}`);
    expect(pages[1]?.offset).toBe(pages[0]?.body.length);
    expect(pages.map((page) => page?.body ?? "").join("")).toBe(body);
  });
});
