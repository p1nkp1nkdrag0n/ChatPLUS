import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { FakeClock } from "./runtime/clock.js";
import type { DemoConversation } from "./services/demo-conversation-service.js";

const START_UTC = "2026-09-08T02:00:00.000Z";

describe("welcome demo conversation", () => {
  const apps = new Set<PersonaSimApp>();
  const directories: string[] = [];

  async function createApp({
    databasePath = ":memory:",
    seedDemo = false,
  }: { databasePath?: string; seedDemo?: boolean } = {}) {
    const app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "demo-conversation-test",
        databasePath,
        clockMode: "fake",
        seedDemo,
        lifePlanningMode: "fuzzy",
        correspondenceMode: "off",
        keepsakeMode: "off",
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      clock: new FakeClock(START_UTC),
      startScheduler: false,
      logger: false,
    });
    apps.add(app);
    return app;
  }

  async function ensure(app: PersonaSimApp): Promise<DemoConversation> {
    const response = await app.inject({
      method: "POST",
      url: "/api/demo/ensure",
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<DemoConversation>();
  }

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.clear();
    for (const directory of directories) {
      const withinTemp = relative(tmpdir(), directory);
      if (
        !withinTemp.startsWith("dearvale-demo-test-") ||
        isAbsolute(withinTemp) ||
        withinTemp.includes("..")
      ) {
        throw new Error("Refusing to remove an unexpected test directory");
      }
      rmSync(directory, { recursive: true, force: true });
    }
    directories.length = 0;
  });

  it("creates a published demo and its session only after an explicit request when seeding is off", async () => {
    const app = await createApp();
    const { store } = app.personasim;
    expect(store.countCharacters()).toBe(0);

    const result = await ensure(app);

    expect(Object.keys(result).sort()).toEqual(["characterId", "sessionId"]);
    expect(result.characterId).toMatch(/^character_/u);
    expect(result.sessionId).toMatch(/^session_/u);
    expect(store.countCharacters()).toBe(1);
    expect(store.getCharacterSpec(result.characterId)).toMatchObject({
      status: "published",
      identity: { name: "林夏" },
    });
    expect(store.getSession(result.sessionId)?.agentId).toBe(
      result.characterId,
    );
    expect(store.tableCounts().llm_calls).toBe(0);
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual(
      [],
    );
  });

  it("preserves a renamed published demo, its messages, and its registered session when another session exists", async () => {
    const app = await createApp();
    const { characters, conversations, store } = app.personasim;
    const first = await ensure(app);
    const draft = characters.updateDraft(first.characterId, {
      path: "identity.name",
      value: "用户给的新名字",
    });
    characters.publish(draft.id);
    conversations.createSession(first.characterId, "另一段对话");
    store.insertMessage({
      id: "message_preserved_demo",
      sessionId: first.sessionId,
      agentId: first.characterId,
      role: "user",
      content: "原来的经历保留在这里。",
      messageKind: "user",
      metadata: {},
      createdAtUtc: START_UTC,
    });
    const before = {
      character: store.getCharacterSpec(first.characterId),
      versions: characters.listVersions(first.characterId),
      messages: store.listMessages(first.sessionId),
      counts: store.tableCounts(),
    };

    expect(await ensure(app)).toEqual(first);
    expect(await ensure(app)).toEqual(first);
    expect({
      character: store.getCharacterSpec(first.characterId),
      versions: characters.listVersions(first.characterId),
      messages: store.listMessages(first.sessionId),
      counts: store.tableCounts(),
    }).toEqual(before);
  });

  it("does not claim an unregistered same-name character in an existing library", async () => {
    const app = await createApp();
    const { characters, store } = app.personasim;
    const existing = characters.publish(characters.createDemoCharacter().id);

    const result = await ensure(app);

    expect(result.characterId).not.toBe(existing.id);
    expect(store.getCharacterSpec(existing.id)).toEqual(existing);
    expect(store.countCharacters()).toBe(2);
    expect(await ensure(app)).toEqual(result);
  });

  it.each(["draft", "archived"] as const)(
    "replaces a %s registration without editing or publishing the old character",
    async (status) => {
      const app = await createApp();
      const { characters, store } = app.personasim;
      const first = await ensure(app);
      const preserved =
        status === "archived"
          ? characters.archive(first.characterId)
          : characters.updateDraft(first.characterId, {
              path: "identity.name",
              value: "正在编辑的角色",
            });

      const replacement = await ensure(app);

      expect(replacement.characterId).not.toBe(first.characterId);
      expect(store.getCharacterSpec(first.characterId)).toEqual(preserved);
      expect(store.getSession(first.sessionId)?.agentId).toBe(
        first.characterId,
      );
      expect(store.getCharacterSpec(replacement.characterId)?.status).toBe(
        "published",
      );
      expect(store.countCharacters()).toBe(2);
      expect(await ensure(app)).toEqual(replacement);
    },
  );

  it.each([false, true])(
    "repairs a deleted session without replacing the character (existing fallback: %s)",
    async (hasFallback) => {
      const app = await createApp();
      const { conversations, store } = app.personasim;
      const first = await ensure(app);
      const fallback = hasFallback
        ? conversations.createSession(first.characterId)
        : undefined;
      store.database
        .prepare("DELETE FROM sessions WHERE id = ?")
        .run(first.sessionId);

      const repaired = await ensure(app);

      expect(repaired.characterId).toBe(first.characterId);
      expect(repaired.sessionId).not.toBe(first.sessionId);
      if (fallback) expect(repaired.sessionId).toBe(fallback.id);
      expect(store.listSessions(first.characterId)).toHaveLength(1);
      expect(store.countCharacters()).toBe(1);
      expect(await ensure(app)).toEqual(repaired);
    },
  );

  it("recovers after the registered character is deleted", async () => {
    const app = await createApp();
    const { store } = app.personasim;
    const first = await ensure(app);
    store.database
      .prepare("DELETE FROM characters WHERE id = ?")
      .run(first.characterId);

    const replacement = await ensure(app);

    expect(replacement.characterId).not.toBe(first.characterId);
    expect(store.countCharacters()).toBe(1);
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual(
      [],
    );
  });

  it("does not return another character's session from a damaged registration", async () => {
    const app = await createApp();
    const { characters, conversations, store } = app.personasim;
    const first = await ensure(app);
    const other = characters.publish(characters.createDemoCharacter().id);
    const otherSession = conversations.createSession(other.id);
    store.database
      .prepare("UPDATE demo_conversations SET session_id = ?")
      .run(otherSession.id);

    expect(await ensure(app)).toEqual(first);
    expect(store.listSessions(other.id)).toEqual([otherSession]);
  });

  it("rolls back all new character and session writes if registration fails", async () => {
    const app = await createApp();
    const { store } = app.personasim;
    const before = store.tableCounts();
    const write = vi
      .spyOn(store, "setDemoConversation")
      .mockImplementationOnce(() => {
        throw new Error("injected registration failure");
      });

    const failed = await app.inject({
      method: "POST",
      url: "/api/demo/ensure",
    });

    expect(failed.statusCode).toBe(500);
    expect(store.tableCounts()).toEqual(before);
    expect(
      store.database.prepare("SELECT * FROM demo_conversations").all(),
    ).toEqual([]);
    write.mockRestore();
    await ensure(app);
    expect(store.countCharacters()).toBe(1);
  });

  it("registers the automatically seeded demo so the button returns the same character and session", async () => {
    const app = await createApp({ seedDemo: true });
    const { store } = app.personasim;
    const existing = store.listCharacters()[0]!;
    const session = store.listSessions(existing.id)[0]!;
    const before = store.tableCounts();

    expect(await ensure(app)).toEqual({
      characterId: existing.id,
      sessionId: session.id,
    });
    expect(store.countCharacters()).toBe(1);
    expect(store.tableCounts()).toEqual(before);
  });

  it("shares one durable registration across concurrent requests, connections, and restarts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "dearvale-demo-test-"));
    directories.push(directory);
    const databasePath = join(directory, "instance.sqlite");
    const firstApp = await createApp({ databasePath });
    const secondApp = await createApp({ databasePath });
    const firstStore = firstApp.personasim.store;
    const secondDatabase = secondApp.personasim.store.database;
    secondDatabase.pragma("busy_timeout = 0");
    const readRegistration = firstStore.getDemoConversation.bind(firstStore);
    vi.spyOn(firstStore, "getDemoConversation").mockImplementationOnce(
      (key) => {
        // An independent connection must already be excluded before the initial
        // read; serializing only the final INSERT leaves a read/create race.
        expect(() => secondDatabase.exec("BEGIN IMMEDIATE")).toThrow(
          "database is locked",
        );
        return readRegistration(key);
      },
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        ensure(index % 2 === 0 ? firstApp : secondApp),
      ),
    );

    expect(
      results.every(
        (result) => JSON.stringify(result) === JSON.stringify(results[0]),
      ),
    ).toBe(true);
    expect(firstApp.personasim.store.countCharacters()).toBe(1);
    expect(firstApp.personasim.store.tableCounts().sessions).toBe(1);
    expect(
      firstApp.personasim.store.database
        .prepare("SELECT * FROM demo_conversations")
        .all(),
    ).toHaveLength(1);
    await firstApp.close();
    apps.delete(firstApp);
    await secondApp.close();
    apps.delete(secondApp);

    const restarted = await createApp({ databasePath, seedDemo: true });
    expect(await ensure(restarted)).toEqual(results[0]);
    expect(restarted.personasim.store.countCharacters()).toBe(1);
  });
});
