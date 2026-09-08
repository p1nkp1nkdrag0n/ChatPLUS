import type { CharacterSummary } from "../api/types";

const ENTRY_KEY = "chatplus.entry.v1";
const CHARACTER_ROUTE =
  /^\/characters\/([^/?#]+)\/(chat|correspondence|relationship-archive|keepsakes)$/;
const STATIC_ROUTES = new Set([
  "/characters",
  "/create",
  "/import",
  "/settings",
  "/timeline",
]);

export interface EntryPreferences {
  version: 1;
  entered: true;
  lastRoute?: string;
}

export function safeEntryRoute(pathname: string): string | undefined {
  return STATIC_ROUTES.has(pathname) || CHARACTER_ROUTE.test(pathname)
    ? pathname
    : undefined;
}

export function readEntryPreferences(): EntryPreferences | undefined {
  try {
    const raw = localStorage.getItem(ENTRY_KEY);
    if (!raw) return undefined;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const entry = value as Record<string, unknown>;
    if (entry.version !== 1 || entry.entered !== true) return undefined;
    const lastRoute =
      typeof entry.lastRoute === "string"
        ? safeEntryRoute(entry.lastRoute)
        : undefined;
    return { version: 1, entered: true, ...(lastRoute ? { lastRoute } : {}) };
  } catch {
    return undefined;
  }
}

export function rememberApplicationEntry(pathname: string): void {
  const lastRoute = safeEntryRoute(pathname);
  try {
    localStorage.setItem(
      ENTRY_KEY,
      JSON.stringify({
        version: 1,
        entered: true,
        ...(lastRoute ? { lastRoute } : {}),
      }),
    );
  } catch {
    // Storage is an optional UI convenience; every direct link still works.
  }
}

export function resolveReturnRoute(
  characters: readonly CharacterSummary[],
  lastRoute?: string,
  activeCharacterId?: string,
): string {
  if (lastRoute) {
    const safeRoute = safeEntryRoute(lastRoute);
    if (safeRoute && STATIC_ROUTES.has(safeRoute)) return safeRoute;
    const match = safeRoute?.match(CHARACTER_ROUTE);
    if (match) {
      let characterId: string;
      try {
        characterId = decodeURIComponent(match[1]!);
      } catch {
        return "/characters";
      }
      return characters.some(
        (character) =>
          character.id === characterId && character.status === "published",
      )
        ? safeRoute!
        : "/characters";
    }
  }
  return activeCharacterId &&
    characters.some(
      (character) =>
        character.id === activeCharacterId && character.status === "published",
    )
    ? `/characters/${encodeURIComponent(activeCharacterId)}/chat`
    : "/characters";
}

export function selectAvailableCharacter(
  characters: readonly CharacterSummary[],
  activeCharacterId?: string,
): CharacterSummary | undefined {
  return (
    characters.find(
      (character) =>
        character.id === activeCharacterId && character.status === "published",
    ) ?? characters.find((character) => character.status === "published")
  );
}
