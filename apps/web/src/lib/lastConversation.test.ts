import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import {
  ApiError,
  type CharacterSpec,
  type CharacterSummary,
  type ChatSession,
} from "../api/types";
import {
  chatHref,
  findOwnedSession,
  readLastConversation,
  rememberLastConversation,
  selectLegacySession,
  validateLastConversation,
  publishedUserCharacters,
  resolveWelcomeConversation,
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

  it("uses only published user and imported characters, newest first", () => {
    const characters = [
      summary("draft", { status: "draft" }),
      summary("demo", { creationOrigin: "demo" }),
      summary("archived", { status: "archived" }),
      summary("older", { updatedAtUtc: "2026-08-01" }),
      summary("imported", { sourceType: "imported_character" }),
    ];
    expect(publishedUserCharacters(characters).map((item) => item.id)).toEqual([
      "imported",
      "older",
    ]);
    expect(characters[0]?.id).toBe("draft");
  });

  it("prefers an exact valid conversation over the active or newest character", async () => {
    const characters = [
      summary("newest"),
      summary("character-1", { updatedAtUtc: "2026-08-01" }),
    ];
    expect(
      await resolveWelcomeConversation(
        characters,
        {
          version: 1,
          characterId: "character-1",
          sessionId: "older",
        },
        "newest",
      ),
    ).toEqual({ version: 1, characterId: "character-1", sessionId: "older" });
    expect(api.agents.sessions).toHaveBeenCalledOnce();
  });

  it("falls back from an invalid saved session to the active character", async () => {
    vi.mocked(api.agents.sessions).mockImplementation((id) =>
      Promise.resolve({ sessions: id === "character-1" ? sessions : [] }),
    );
    expect(
      await resolveWelcomeConversation(
        [
          summary("newest"),
          summary("active", { updatedAtUtc: "2026-08-01" }),
          summary("character-1"),
        ],
        { version: 1, characterId: "character-1", sessionId: "removed" },
        "active",
      ),
    ).toEqual({ version: 1, characterId: "active" });
  });

  it("falls back from an archived active character to the most recently updated user character", async () => {
    vi.mocked(api.agents.sessions).mockResolvedValue({ sessions: [] });
    expect(
      await resolveWelcomeConversation(
        [
          summary("older", { updatedAtUtc: "2026-08-01" }),
          summary("archived", { status: "archived" }),
          summary("newest"),
        ],
        { version: 1, characterId: "archived", sessionId: "old" },
        "archived",
      ),
    ).toEqual({ version: 1, characterId: "newest" });
    expect(api.agents.sessions).toHaveBeenCalledWith("newest");
  });

  it("returns an empty welcome state after the last published user character is archived", async () => {
    expect(
      await resolveWelcomeConversation(
        [
          summary("character-1", { status: "archived" }),
          summary("demo", { creationOrigin: "demo" }),
        ],
        { version: 1, characterId: "character-1", sessionId: "older" },
        "character-1",
      ),
    ).toBeUndefined();
    expect(api.agents.sessions).not.toHaveBeenCalled();
  });

  it("preserves session read failures instead of treating them as empty history", async () => {
    vi.mocked(api.agents.sessions).mockRejectedValue(new Error("offline"));
    await expect(
      resolveWelcomeConversation(
        [summary("character-1")],
        undefined,
        "character-1",
      ),
    ).rejects.toThrow("offline");
  });
});

function summary(
  id: string,
  overrides: Partial<CharacterSummary> = {},
): CharacterSummary {
  return {
    id,
    name: "林夏",
    status: "published",
    creationOrigin: "user",
    sourceType: "original",
    version: 1,
    tier: "high_fidelity",
    workOrRole: "插画师",
    updatedAtUtc: "2026-09-08",
    ...overrides,
  };
}
