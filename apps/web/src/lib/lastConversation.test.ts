import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { ApiError, type CharacterSpec, type ChatSession } from "../api/types";
import {
  chatHref,
  findOwnedSession,
  readLastConversation,
  rememberLastConversation,
  selectLegacySession,
  validateLastConversation,
} from "./lastConversation";

const sessions: ChatSession[] = [
  {
    id: "older",
    agentId: "character-1",
    createdAtUtc: "2026-08-01",
    updatedAtUtc: "2026-08-01",
  },
  {
    id: "foreign",
    agentId: "character-2",
    createdAtUtc: "2026-09-09",
    updatedAtUtc: "2026-09-09",
  },
  {
    id: "latest",
    agentId: "character-1",
    createdAtUtc: "2026-09-01",
    updatedAtUtc: "2026-09-01",
  },
];

describe("last conversation storage and validation", () => {
  let storage: Map<string, string>;
  const dispatchEvent = vi.fn();
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    });
    vi.stubGlobal("window", { dispatchEvent });
    vi.spyOn(api.characters, "get").mockResolvedValue({
      id: "character-1",
      status: "published",
    } as CharacterSpec);
    vi.spyOn(api.agents, "sessions").mockResolvedValue({ sessions });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stores an exact conversation and preserves the old active-character subscription", () => {
    rememberLastConversation("character-1", "older");
    expect(readLastConversation()).toEqual({
      version: 1,
      characterId: "character-1",
      sessionId: "older",
    });
    expect(JSON.parse(storage.get("personasim.active-character.v1")!)).toEqual({
      version: 1,
      characterId: "character-1",
    });
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });

  it("migrates a character-only record by resolving its latest owned session", async () => {
    storage.set(
      "personasim.active-character.v1",
      JSON.stringify({ version: 1, characterId: "character-1" }),
    );
    expect(readLastConversation()).toEqual({
      version: 1,
      characterId: "character-1",
    });
    expect(await validateLastConversation()).toEqual({
      version: 1,
      characterId: "character-1",
      sessionId: "latest",
    });
  });

  it("continues the saved session instead of a newer session", async () => {
    expect(
      await validateLastConversation({
        version: 1,
        characterId: "character-1",
        sessionId: "older",
      }),
    ).toEqual({ version: 1, characterId: "character-1", sessionId: "older" });
  });

  it.each(["foreign", "removed"])(
    "does not silently replace the explicit session %s",
    async (sessionId) => {
      expect(
        await validateLastConversation({
          version: 1,
          characterId: "character-1",
          sessionId,
        }),
      ).toBeUndefined();
      expect(
        findOwnedSession(sessions, "character-1", sessionId),
      ).toBeUndefined();
    },
  );

  it("only falls back for a legacy URL without an explicit session", () => {
    expect(
      selectLegacySession(sessions, "character-1", {
        version: 1,
        characterId: "character-1",
        sessionId: "older",
      })?.id,
    ).toBe("older");
    expect(
      selectLegacySession(sessions, "character-1", {
        version: 1,
        characterId: "character-2",
        sessionId: "foreign",
      })?.id,
    ).toBe("latest");
    expect(
      selectLegacySession(sessions, "character-3", undefined),
    ).toBeUndefined();
  });

  it("rejects draft, archived, and removed characters without creating a conversation", async () => {
    for (const status of ["draft", "archived"] as const) {
      vi.mocked(api.characters.get).mockResolvedValueOnce({
        id: "character-1",
        status,
      } as CharacterSpec);
      expect(
        await validateLastConversation({
          version: 1,
          characterId: "character-1",
        }),
      ).toBeUndefined();
    }
    vi.mocked(api.characters.get).mockRejectedValueOnce(
      new ApiError({ code: "NOT_FOUND", message: "missing", status: 404 }),
    );
    expect(
      await validateLastConversation({
        version: 1,
        characterId: "character-1",
      }),
    ).toBeUndefined();
    expect(api.agents.sessions).not.toHaveBeenCalled();
  });

  it("keeps network failures visible instead of presenting them as missing history", async () => {
    vi.mocked(api.agents.sessions).mockRejectedValueOnce(new Error("offline"));
    await expect(
      validateLastConversation({ version: 1, characterId: "character-1" }),
    ).rejects.toThrow("offline");
  });

  it("ignores malformed records and keeps direct links usable when storage is blocked", () => {
    storage.set("dearvale.last-conversation.v1", "{broken");
    expect(readLastConversation()).toBeUndefined();
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(readLastConversation()).toBeUndefined();
    expect(() =>
      rememberLastConversation("character-1", "older"),
    ).not.toThrow();
    expect(chatHref("角色 / 1", "session + 1")).toBe(
      "/characters/%E8%A7%92%E8%89%B2%20%2F%201/chat?sessionId=session+%2B+1",
    );
  });
});
