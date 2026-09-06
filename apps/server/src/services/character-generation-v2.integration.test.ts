import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CharacterSpec } from "@personasim/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { FakeClock } from "../runtime/clock.js";

describe("companion generation lifecycle", () => {
  let app: PersonaSimApp | undefined;
  const roots: string[] = [];

  afterEach(async () => {
    await app?.close();
    app = undefined;
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  async function start(databasePath: string) {
    return buildApp({
      config: readConfig({
        nodeEnv: "test",
        profile: "character-v2",
        databasePath,
        clockMode: "fake",
        seedDemo: false,
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "personasim-fixture-v1",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      clock: new FakeClock("2026-09-06T01:00:00.000Z"),
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
  }

  it.each(["original", "imported"] as const)(
    "creates, edits, publishes and restarts an empty-goal %s character",
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), "chatplus-character-v2-"));
      roots.push(root);
      const databasePath = join(root, "test.db");
      app = await start(databasePath);
      const response = await app.inject({
        method: "POST",
        url:
          kind === "original"
            ? "/api/characters/generate"
            : "/api/characters/import",
        payload:
          kind === "original"
            ? {
                name: "阿澄",
                worldSetting: "当代城市",
                workOrRole: "书店店员",
                coreTraits: ["习惯先听别人说完"],
                mainGoal: "",
                coreContradiction: "  ",
                initialRelationship: "邻居",
                dialogueStyle: "自然简短",
                tier: "daily",
                timezone: "Asia/Shanghai",
              }
            : {
                characterName: "阿澄",
                workTitle: "街角",
                storyStage: "第一章",
                sourceText: "阿澄在书店工作。她常与邻居聊当天的小事。",
                tier: "daily",
                timezone: "Asia/Shanghai",
              },
      });
      expect(response.statusCode).toBe(201);
      let character = response.json<{ character: CharacterSpec }>().character;
      expect(character.compilationPolicyVersion).toBe("companion_character_v2");
      expect(character.persona.goals).toEqual([]);
      expect(character.persona.contradictions).toEqual([]);

      const candidate = structuredClone(character);
      delete candidate.compilationPolicyVersion;
      candidate.identity.selfDescription = "在书店工作，也喜欢普通的日常闲聊。";
      const edited = await app.inject({
        method: "PATCH",
        url: `/api/characters/${character.id}/draft`,
        payload: { spec: candidate, expectedVersion: character.version },
      });
      expect(edited.statusCode).toBe(200);
      character = edited.json<{ character: CharacterSpec }>().character;
      expect(character.compilationPolicyVersion).toBe("companion_character_v2");
      const published = await app.inject({
        method: "POST",
        url: `/api/characters/${character.id}/publish`,
        payload: { expectedVersion: character.version },
      });
      expect(published.statusCode).toBe(200);

      await app.close();
      app = await start(databasePath);
      const reopened = await app.inject({
        method: "GET",
        url: `/api/characters/${character.id}`,
      });
      const spec = reopened.json<{ character: CharacterSpec }>().character;
      expect(spec.persona.goals).toEqual([]);
      expect(spec.persona.contradictions).toEqual([]);
      expect(spec.compilationPolicyVersion).toBe("companion_character_v2");
      const session = await app.inject({
        method: "POST",
        url: `/api/agents/${character.id}/sessions`,
        payload: {},
      });
      expect(session.statusCode).toBe(201);
      const sessionId = session.json<{ session: { id: string } }>().session.id;
      const chatted = await app.inject({
        method: "POST",
        url: `/api/sessions/${sessionId}/messages`,
        payload: {
          agentId: character.id,
          clientMessageId: `empty-${kind}`,
          text: "今天路边的猫在晒太阳。",
        },
      });
      expect(chatted.statusCode).toBe(201);
      const afterChat = await app.inject({
        method: "GET",
        url: `/api/characters/${character.id}`,
      });
      expect(
        afterChat.json<{ character: CharacterSpec }>().character.persona.goals,
      ).toEqual([]);
    },
  );
});
