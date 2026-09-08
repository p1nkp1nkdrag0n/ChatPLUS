import type { DatabaseStore } from "../db/store.js";
import type { CharacterService } from "./character-service.js";
import type { ConversationService } from "./conversation-service.js";

// Identity belongs to this internal registration, never a mutable display name.
const WELCOME_DEMO_KEY = "welcome-demo";

export interface DemoConversation {
  characterId: string;
  sessionId: string;
}

export function ensureDemoConversation({
  store,
  characters,
  conversations,
}: {
  store: DatabaseStore;
  characters: CharacterService;
  conversations: ConversationService;
}): DemoConversation {
  // Lock before looking up the registration, including across SQLite
  // connections. All nested character/session writes are synchronous savepoints
  // in this transaction; no model calls or asynchronous work run under the lock.
  return store.database
    .transaction(() => {
      const registration = store.getDemoConversation(WELCOME_DEMO_KEY);
      const previous = registration
        ? store.getCharacterSpec(registration.characterId)
        : undefined;
      const character =
        previous?.status === "published"
          ? previous
          : characters.publish(characters.createDemoCharacter().id);
      const registeredSession =
        registration?.characterId === character.id && registration.sessionId
          ? store.getSession(registration.sessionId)
          : undefined;
      const session =
        registeredSession?.agentId === character.id
          ? registeredSession
          : (conversations.listSessions(character.id)[0] ??
            conversations.createSession(character.id));
      const result = { characterId: character.id, sessionId: session.id };

      if (
        registration?.characterId !== result.characterId ||
        registration.sessionId !== result.sessionId
      ) {
        store.setDemoConversation(WELCOME_DEMO_KEY, result);
      }
      return result;
    })
    .immediate();
}
