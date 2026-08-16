const KEY = "personasim.active-character.v1";
const CHANGE_EVENT = "personasim:active-character-changed";

export function rememberActiveCharacter(characterId: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, characterId }));
  } catch {
    // Local storage is a convenience; routes remain fully usable without it.
  }
  window.dispatchEvent(
    new CustomEvent<string>(CHANGE_EVENT, { detail: characterId }),
  );
}

export function readActiveCharacter(): string | undefined {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as {
      version?: unknown;
      characterId?: unknown;
    };
    return value.version === 1 && typeof value.characterId === "string"
      ? value.characterId
      : undefined;
  } catch {
    return undefined;
  }
}

export function subscribeActiveCharacter(
  listener: (characterId: string | undefined) => void,
): () => void {
  const onChange = (event: Event) => {
    const detail =
      event instanceof CustomEvent && typeof event.detail === "string"
        ? event.detail
        : readActiveCharacter();
    listener(detail);
  };
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
