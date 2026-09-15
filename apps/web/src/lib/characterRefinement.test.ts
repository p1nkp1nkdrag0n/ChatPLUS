import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REFINEMENT_KEY,
  clearRefinementDraft,
  newRefinementDraft,
  readRefinementDraft,
  saveRefinementDraft,
  updateRefinementFeedback,
} from "./characterRefinement";

describe("character refinement recovery", () => {
  let storage: Map<string, string>;
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("restores feedback, its original version and retry identity after a reload", () => {
    const draft = newRefinementDraft(
      "character-1",
      3,
      "  她更有戒心。\n保留职业。 ",
    );
    expect(saveRefinementDraft(draft)).toBe(true);
    expect(readRefinementDraft("character-1")).toEqual(draft);
    expect(readRefinementDraft("character-2")).toBeUndefined();
    expect(updateRefinementFeedback(draft, draft.feedback).requestId).toBe(
      draft.requestId,
    );
  });

  it("uses a fresh operation for changed feedback or a reviewed newer version", () => {
    const original = newRefinementDraft("character-1", 3, "保留职业");
    const changed = updateRefinementFeedback(original, "保留职业和名字");
    expect(changed.requestId).not.toBe(original.requestId);
    expect(changed.characterVersion).toBe(3);
    const reviewed = newRefinementDraft(
      original.characterId,
      4,
      changed.feedback,
    );
    expect(reviewed.feedback).toBe(changed.feedback);
    expect(reviewed.requestId).not.toBe(changed.requestId);
    expect(reviewed.characterVersion).toBe(4);
  });

  it("keeps another character's work when one request completes", () => {
    const first = newRefinementDraft("character-1", 1, "第一份意见");
    const second = newRefinementDraft("character-2", 5, "第二份意见");
    saveRefinementDraft(first);
    saveRefinementDraft(second);
    clearRefinementDraft(first.characterId, first.requestId);
    expect(readRefinementDraft(first.characterId)).toBeUndefined();
    expect(readRefinementDraft(second.characterId)).toEqual(second);
  });

  it("does not let an older request completion erase newer writing from another tab", () => {
    const first = newRefinementDraft("character-1", 1, "第一份意见");
    saveRefinementDraft(first);
    const newer = updateRefinementFeedback(first, "保留更详细的意见");
    saveRefinementDraft(newer);
    clearRefinementDraft(first.characterId, first.requestId);
    expect(readRefinementDraft(first.characterId)).toEqual(newer);
    clearRefinementDraft(newer.characterId, newer.requestId);
    expect(storage.has(REFINEMENT_KEY)).toBe(false);
  });

  it("rejects oversized feedback and keeps the previous recoverable draft", () => {
    const draft = newRefinementDraft("character-1", 1, "保留职业");
    saveRefinementDraft(draft);
    expect(saveRefinementDraft({ ...draft, feedback: "x".repeat(5_001) })).toBe(
      false,
    );
    expect(readRefinementDraft(draft.characterId)).toEqual(draft);
  });

  it.each(["{broken", "null", "[]", "x".repeat(100_001)])(
    "recovers from malformed storage without losing the next valid save (case %#)",
    (raw) => {
      storage.set(REFINEMENT_KEY, raw);
      expect(readRefinementDraft("character-1")).toBeUndefined();
      const draft = newRefinementDraft("character-1", 1, "重新开始");
      expect(saveRefinementDraft(draft)).toBe(true);
      expect(readRefinementDraft("character-1")).toEqual(draft);
    },
  );

  it("keeps only the ten most recently saved character drafts", () => {
    for (let index = 0; index < 11; index++) {
      expect(
        saveRefinementDraft(newRefinementDraft(`character-${index}`, 1)),
      ).toBe(true);
    }
    expect(readRefinementDraft("character-0")).toBeUndefined();
    expect(readRefinementDraft("character-10")).toBeDefined();
  });

  it("reports unavailable browser storage without breaking the page", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readRefinementDraft("character-1")).toBeUndefined();
    expect(saveRefinementDraft(newRefinementDraft("character-1", 1))).toBe(
      false,
    );
    expect(() =>
      clearRefinementDraft("character-1", "request-1"),
    ).not.toThrow();
  });
});
