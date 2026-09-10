import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "./app.js";
import { readConfig } from "./config.js";
import { runMigrations } from "./db/migrations.js";
import { FakeClock } from "./runtime/clock.js";
import { ensureDemoConversation } from "./services/demo-conversation-service.js";

const START_UTC = "2026-09-08T02:00:00.000Z";
const RETIREMENT_MIGRATION = "033_archive_system_demo_characters.sql";
const USER_INPUT = {
  name: "林夏",
  worldSetting: "当代城市",
  workOrRole: "插画师",
  coreTraits: ["温和", "认真"],
  dialogueStyle: "自然、克制",
  initialRelationship: "陌生人",
  tier: "high_fidelity",
  timezone: "Asia/Shanghai",
};

describe("welcome without system demo characters", () => {
  const apps: PersonaSimApp[] = [];

  async function createApp(seedDemo = false) {
    const config = readConfig({
      nodeEnv: "test",
      profile: "demo-retirement-test",
      databasePath: ":memory:",
      clockMode: "fake",
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
    });
    const app = await buildApp({
      // Also cover old callers constructing ServerConfig directly.
      config: { ...config, seedDemo },
      seedDemo,
      clock: new FakeClock(START_UTC),
      startScheduler: false,
      logger: false,
    });
    apps.push(app);
    return app;
  }

  afterEach(async () => {
    for (const app of apps) await app.close();
    apps.length = 0;
  });

  it.each([false, true])(
    "never seeds startup or welcome reads with the legacy seed flag %s",
    async (seedDemo) => {
      const app = await createApp(seedDemo);
      for (let visit = 0; visit < 3; visit += 1) {
        const response = await app.inject({
          method: "GET",
          url: "/api/characters",
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ characters: [], items: [] });
      }
      expect(app.personasim.store.countCharacters()).toBe(0);
      expect(app.personasim.store.tableCounts()).toMatchObject({
        sessions: 0,
        llm_calls: 0,
      });
    },
  );

  it("retires the old public ensure route without any writes", async () => {
    const app = await createApp(true);
    const before = app.personasim.store.tableCounts();
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({ method: "POST", url: "/api/demo/ensure" }),
      ),
    );
    for (const response of responses) {
      expect(response.statusCode).toBe(410);
      expect(response.json()).toMatchObject({
        error: { code: "demo_creation_retired" },
      });
    }
    expect(app.personasim.store.tableCounts()).toEqual(before);
  });

  it("exposes user and demo origins independently of name and source type", async () => {
    const app = await createApp();
    const { characters } = app.personasim;
    const user = characters.publish((await characters.generate(USER_INPUT)).id);
    const demo = ensureDemoConversation(app.personasim);
    const response = await app.inject({
      method: "GET",
      url: "/api/characters",
    });
    expect(response.json<{ characters: unknown[] }>().characters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: user.id,
          creationOrigin: "user",
          status: "published",
        }),
        expect.objectContaining({
          id: demo.characterId,
          creationOrigin: "demo",
          status: "published",
        }),
      ]),
    );
  });

  it("archives explicitly marked and registered legacy demos once while preserving sources, versions and messages", async () => {
    const app = await createApp();
    const { characters, store } = app.personasim;
    const user = characters.publish((await characters.generate(USER_INPUT)).id);
    const registered = ensureDemoConversation(app.personasim);
    const marked = characters.publish(characters.createDemoCharacter().id);
    const edited = characters.updateDraft(marked.id, {
      path: "identity.name",
      value: "已改名的示例",
    });
    characters.publish(edited.id);
    const prior = store.getCharacterSpec(marked.id, marked.version)!;
    store.insertCharacterSource({
      id: "source_preserved_demo",
      characterId: marked.id,
      sourceType: "original",
      title: "示例原始材料",
      contentExcerpt: "历史材料保持原样",
      sourceHash: "test-hash",
      createdAtUtc: START_UTC,
    });
    store.insertMessage({
      id: "message_preserved_demo",
      sessionId: registered.sessionId,
      agentId: registered.characterId,
      role: "user",
      content: "原来的经历保留在这里。",
      messageKind: "user",
      metadata: {},
      createdAtUtc: START_UTC,
    });
    const messages = store.listMessages(registered.sessionId);
    const sources = store.database
      .prepare("SELECT * FROM character_sources")
      .all();
    const counts = store.tableCounts();
    // Simulate a database from before the retirement migration, including a
    // legacy registration whose creation-origin backfill had not run.
    store.database
      .prepare("UPDATE characters SET creation_origin = 'user' WHERE id = ?")
      .run(registered.characterId);
    store.database
      .prepare("DELETE FROM schema_migrations WHERE name = ?")
      .run(RETIREMENT_MIGRATION);

    expect(runMigrations(store.database)).toEqual([RETIREMENT_MIGRATION]);
    for (const id of [registered.characterId, marked.id]) {
      expect(store.getCharacterSummary(id)).toMatchObject({
        status: "archived",
        creationOrigin: "demo",
      });
      expect(store.getCharacterSpec(id)?.status).toBe("archived");
    }
    expect(store.getCharacterSpec(user.id)).toEqual(user);
    expect(store.getCharacterSummary(user.id)?.creationOrigin).toBe("user");
    expect(store.getCharacterSpec(marked.id, prior.version)).toEqual(prior);
    expect(store.listCharacters().map((character) => character.id)).toEqual([
      user.id,
    ]);
    expect(store.listMessages(registered.sessionId)).toEqual(messages);
    expect(
      store.database.prepare("SELECT * FROM character_sources").all(),
    ).toEqual(sources);
    expect(store.tableCounts()).toEqual(counts);
    expect(store.getDemoConversation("welcome-demo")).toEqual(registered);
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual(
      [],
    );
    const archived = store.getCharacterSpec(marked.id);
    expect(runMigrations(store.database)).toEqual([]);
    expect(store.getCharacterSpec(marked.id)).toEqual(archived);
  });
});
