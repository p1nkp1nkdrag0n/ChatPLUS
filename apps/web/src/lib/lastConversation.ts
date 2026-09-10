import { api, unwrapCharacter, unwrapList } from "../api/client";
import {
  ApiError,
  type CharacterSummary,
  type ChatSession,
} from "../api/types";
import {
  readActiveCharacter,
  rememberActiveCharacter,
} from "./activeCharacter";

const KEY = "dearvale.last-conversation.v1";

export interface LastConversation {
  version: 1;
  characterId: string;
  sessionId: string;
}

export type LastConversationCandidate = Omit<LastConversation, "sessionId"> & {
  sessionId?: string;
};

export function readLastConversation(): LastConversationCandidate | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const value: unknown = JSON.parse(raw);
      if (
        typeof value === "object" &&
        value !== null &&
        "version" in value &&
        value.version === 1 &&
        "characterId" in value &&
        typeof value.characterId === "string" &&
        value.characterId.trim() &&
        "sessionId" in value &&
        typeof value.sessionId === "string" &&
        value.sessionId.trim()
      ) {
        return {
          version: 1,
          characterId: value.characterId,
          sessionId: value.sessionId,
        };
      }
    }
  } catch {
    // Broken or unavailable storage must not prevent opening a direct link.
  }
  const characterId = readActiveCharacter();
  return characterId?.trim() ? { version: 1, characterId } : undefined;
}

export function rememberLastConversation(
  characterId: string,
  sessionId: string,
): void {
  if (!characterId.trim() || !sessionId.trim()) return;
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({ version: 1, characterId, sessionId }),
    );
  } catch {
    // The URL remains the source of truth when storage is unavailable.
  }
  rememberActiveCharacter(characterId);
}

export function findOwnedSession(
  sessions: readonly ChatSession[],
  characterId: string,
  sessionId: string,
): ChatSession | undefined {
  return sessions.find(
    (session) => session.id === sessionId && session.agentId === characterId,
  );
}

export function selectLegacySession(
  sessions: readonly ChatSession[],
  characterId: string,
  candidate: LastConversationCandidate | undefined,
): ChatSession | undefined {
  const saved =
    candidate?.characterId === characterId && candidate.sessionId
      ? findOwnedSession(sessions, characterId, candidate.sessionId)
      : undefined;
  return (
    saved ??
    sessions
      .filter((session) => session.agentId === characterId)
      .sort((a, b) => b.updatedAtUtc.localeCompare(a.updatedAtUtc))[0]
  );
}

export async function validateLastConversation(
  candidate: LastConversationCandidate | undefined = readLastConversation(),
): Promise<LastConversation | undefined> {
  if (!candidate) return undefined;
  try {
    const character = unwrapCharacter(
      await api.characters.get(candidate.characterId),
    );
    if (
      character.id !== candidate.characterId ||
      character.status !== "published"
    )
      return undefined;
    const sessions = unwrapList<ChatSession>(
      await api.agents.sessions(candidate.characterId),
      "sessions",
    );
    // An explicit stored session must still exist; do not substitute a different conversation.
    const session = candidate.sessionId
      ? findOwnedSession(sessions, candidate.characterId, candidate.sessionId)
      : selectLegacySession(sessions, candidate.characterId, candidate);
    return session
      ? { version: 1, characterId: character.id, sessionId: session.id }
      : undefined;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return undefined;
    throw error;
  }
}

export function publishedUserCharacters(
  characters: readonly CharacterSummary[],
): CharacterSummary[] {
  return characters
    .filter(
      (character) =>
        character.status === "published" && character.creationOrigin !== "demo",
    )
    .sort((a, b) => b.updatedAtUtc.localeCompare(a.updatedAtUtc));
}

/** Resolve the welcome destination from the server's current library only. */
export async function resolveWelcomeConversation(
  characters: readonly CharacterSummary[],
  candidate = readLastConversation(),
  activeCharacterId = readActiveCharacter(),
): Promise<LastConversationCandidate | undefined> {
  const available = publishedUserCharacters(characters);
  if (available.length === 0) return undefined;
  const listedCandidate = available.find(
    (character) => character.id === candidate?.characterId,
  );
  let candidateSessions: ChatSession[] | undefined;
  if (listedCandidate && candidate?.sessionId) {
    candidateSessions = await readSessions(listedCandidate.id);
    const session = findOwnedSession(
      candidateSessions,
      listedCandidate.id,
      candidate.sessionId,
    );
    if (session) {
      return {
        version: 1,
        characterId: listedCandidate.id,
        sessionId: session.id,
      };
    }
  }
  const selected =
    available.find((character) => character.id === activeCharacterId) ??
    available[0]!;
  const sessions =
    selected.id === listedCandidate?.id && candidateSessions !== undefined
      ? candidateSessions
      : await readSessions(selected.id);
  const session = selectLegacySession(sessions, selected.id, undefined);
  return {
    version: 1,
    characterId: selected.id,
    ...(session ? { sessionId: session.id } : {}),
  };
}

async function readSessions(characterId: string): Promise<ChatSession[]> {
  try {
    return unwrapList<ChatSession>(
      await api.agents.sessions(characterId),
      "sessions",
    );
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return [];
    throw error;
  }
}

export function chatHref(characterId: string, sessionId?: string): string {
  const path = `/characters/${encodeURIComponent(characterId)}/chat`;
  return sessionId
    ? `${path}?${new URLSearchParams({ sessionId }).toString()}`
    : path;
}
