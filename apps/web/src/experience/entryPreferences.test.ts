import { describe, expect, it, vi } from "vitest";
import type { CharacterSummary } from "../api/types";
import {
  readEntryPreferences,
  rememberApplicationEntry,
  resolveReturnRoute,
  safeEntryRoute,
  selectAvailableCharacter,
} from "./entryPreferences";

function character(
  id: string,
  status: CharacterSummary["status"] = "published",
): CharacterSummary {
  return {
    id,
    name: id,
    workOrRole: "",
    tier: "daily",
    status,
    sourceType: "original",
    version: 1,
    updatedAtUtc: "2026-09-08T00:00:00Z",
  };
}

describe("application entrance preferences", () => {
  it("restores only a route whose character still exists and is published", () => {
    const characters = [
      character("available"),
      character("draft", "draft"),
      character("archived", "archived"),
    ];
    expect(resolveReturnRoute(characters, "/characters/available/chat")).toBe(
      "/characters/available/chat",
    );
    expect(resolveReturnRoute(characters, "/characters/deleted/chat")).toBe(
      "/characters",
    );
    expect(resolveReturnRoute(characters, "/characters/draft/chat")).toBe(
      "/characters",
    );
    expect(
      resolveReturnRoute(characters, "/characters/archived/keepsakes"),
    ).toBe("/characters");
    expect(resolveReturnRoute(characters, undefined, "available")).toBe(
      "/characters/available/chat",
    );
    expect(resolveReturnRoute(characters, undefined, "deleted")).toBe(
      "/characters",
    );
  });

  it("selects only actual published characters without a demo id or name assumption", () => {
    const characters = [
      character("unfinished", "draft"),
      character("any-published-id"),
      character("previous"),
    ];
    expect(selectAvailableCharacter(characters)?.id).toBe("any-published-id");
    expect(selectAvailableCharacter(characters, "previous")?.id).toBe(
      "previous",
    );
    expect(selectAvailableCharacter([])).toBeUndefined();
    expect(
      selectAvailableCharacter([
        character("archived", "archived"),
        character("draft", "draft"),
      ]),
    ).toBeUndefined();
  });

  it("never persists reader URLs, queries, hashes, or arbitrary destinations", () => {
    const forbidden = [
      "/letters/private-id",
      "/characters/a/chat?body=secret",
      "/characters/a/chat#secret",
      "/characters/a/chat/extra",
      "https://example.com",
      "//example.com",
      "/about",
      "/welcome",
    ];
    for (const pathname of forbidden)
      expect(safeEntryRoute(pathname)).toBeUndefined();
    const setItem = vi.fn();
    vi.stubGlobal("localStorage", { setItem });
    try {
      rememberApplicationEntry("/letters/private-id?body=never-store");
      expect(setItem).toHaveBeenCalledWith(
        "chatplus.entry.v1",
        '{"version":1,"entered":true}',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats malformed and unavailable storage as a first visit", () => {
    const getItem = vi.fn(() => "not-json");
    vi.stubGlobal("localStorage", { getItem });
    try {
      expect(readEntryPreferences()).toBeUndefined();
      getItem.mockReturnValue('{"version":2,"entered":true}');
      expect(readEntryPreferences()).toBeUndefined();
      getItem.mockReturnValue(
        '{"version":1,"entered":true,"lastRoute":"/letters/private"}',
      );
      expect(readEntryPreferences()).toEqual({ version: 1, entered: true });
      getItem.mockImplementation(() => {
        throw new Error("storage blocked");
      });
      expect(readEntryPreferences()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
