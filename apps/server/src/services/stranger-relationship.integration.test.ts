import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { FakeClock } from "../runtime/clock.js";
import type { CharacterSpec } from "../domain/schemas.js";
import { STRANGER_RELATIONSHIP_TYPE } from "../domain/stranger-relationship.js";
import { assertCharacterAuthority } from "./character-authority.js";
import { stripCharacterMetadata } from "./character-draft-editor.js";

const INPUT = {
  name: "初识测试",
  worldSetting: "当代城市",
  workOrRole: "插画师",
  coreTraits: ["认真", "温和"],
  initialRelationship: "相识十年的恋人",
  dialogueStyle: "自然中文",
  tier: "high_fidelity",
  timezone: "Asia/Shanghai",
  authoring: { sharedContext: "一起住过三年，还共同经营过一家书店。" },
};

function expectStranger(spec: CharacterSpec): void {
  expect(spec.userRelationship).toMatchObject({
    relationshipType: STRANGER_RELATIONSHIP_TYPE,
    initialCloseness: 0.1,
    initialTrust: 0.1,
    sharedContext: "",
  });
  expect(() =>
    assertCharacterAuthority(stripCharacterMetadata(spec)),
  ).not.toThrow();
}

describe("server-owned stranger relationship", () => {
  let app: PersonaSimApp;
  beforeEach(async () => {
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        databasePath: ":memory:",
        clockMode: "fake",
        seedDemo: false,
        llm: {
          provider: "fixture",
          baseUrl: "http://127.0.0.1:1",
          model: "fixture",
          timeoutMs: 1_000,
          maxRetries: 0,
        },
      }),
      clock: new FakeClock("2026-09-10T00:00:00Z"),
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it("normalizes legacy and omitted creation inputs, including structured shared history", async () => {
    for (const payload of [
      INPUT,
      { ...INPUT, initialRelationship: undefined },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/characters/generate",
        payload,
      });
      expect(response.statusCode).toBe(201);
      const spec = response.json<{ character: CharacterSpec }>().character;
      expectStranger(spec);
      expect(
        app.personasim.store.getRuntimeState(spec.id)?.relationship,
      ).toMatchObject({
        closeness: 0.1,
        trust: 0.1,
        familiarity: 0.1,
        recentInteractionValence: 0,
      });
      expect(app.personasim.characters.getCreationOrigin(spec.id)).toBe("user");
    }
  });

  it("keeps imported biography and third-party facts while rejecting a shared past with the app user", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/characters/import",
      payload: {
        characterName: "远山",
        workTitle: "山城往事",
        storyStage: "重返故乡",
        tier: "high_fidelity",
        timezone: "Asia/Shanghai",
        sourceFormat: "txt",
        sourceText: "远山曾在山城当老师。他与林雨从小相识。",
        authoring: {
          sharedContext: "用户就是林雨，和远山从小相识。",
          knownFacts: ["远山曾在山城当老师。", "远山与林雨从小相识。"],
        },
      },
    });
    expect(response.statusCode).toBe(201);
    const spec = response.json<{ character: CharacterSpec }>().character;
    expectStranger(spec);
    expect(spec.knowledge.knownFacts).toEqual(
      expect.arrayContaining(["远山曾在山城当老师。", "远山与林雨从小相识。"]),
    );
  });

  it("enforces the baseline for every edit shape without resetting earned runtime progress", async () => {
    let spec = await app.personasim.characters.generate(INPUT);
    const state = app.personasim.store.getRuntimeState(spec.id)!;
    app.personasim.store.updateRuntimeState({
      ...state,
      relationship: { ...state.relationship, closeness: 0.56, trust: 0.42 },
    });
    const changed = {
      ...stripCharacterMetadata(spec),
      userRelationship: {
        ...spec.userRelationship,
        relationshipType: "恋人",
        initialCloseness: 1,
        initialTrust: 1,
        sharedContext: "相恋十年。",
      },
    };
    const mutations = [
      { spec: changed },
      { patch: { userRelationship: changed.userRelationship } },
      { path: "userRelationship.initialCloseness", value: 1 },
      { path: "userRelationship.sharedContext", value: "一起度过童年。" },
    ];
    for (const mutation of mutations) {
      spec = app.personasim.characters.updateDraft(spec.id, {
        ...mutation,
        expectedVersion: spec.version,
      });
      expectStranger(spec);
      spec = app.personasim.characters.publish(spec.id, spec.version);
      expectStranger(spec);
    }
    expect(
      app.personasim.store.getRuntimeState(spec.id)?.relationship,
    ).toMatchObject({ closeness: 0.56, trust: 0.42 });
  });

  it("rejects provider-authored shared history and prevents exact authority confirmation from reviving it", async () => {
    const baseline = await app.personasim.characters.generate(INPUT);
    const candidate = stripCharacterMetadata(baseline);
    candidate.userRelationship = {
      ...candidate.userRelationship,
      relationshipType: "青梅竹马",
      initialCloseness: 0.95,
      initialTrust: 0.98,
      sharedContext: "从小一起长大，彼此无比熟悉。",
    };
    vi.spyOn(app.personasim.llm, "generateObject").mockResolvedValueOnce({
      draft: candidate,
      reasonCode: "fixture",
      reasonSummary: "Provider attempted a prior user relationship",
    });
    const generated = await app.personasim.characters.generate(INPUT);
    expectStranger(generated);
    const rejected = generated.authorityAudit!.candidates.find(
      (item) =>
        item.target === "userRelationship.sharedContext" &&
        item.originalValue.includes("从小一起长大"),
    );
    expect(rejected?.status).toBe("rejected");
    expect(() =>
      app.personasim.characters.updateDraft(generated.id, {
        expectedVersion: generated.version,
        authorityDecisions: [
          {
            candidateId: rejected!.candidateId,
            candidateSha256: rejected!.candidateSha256,
            decision: "accept",
          },
        ],
      }),
    ).toThrow("The exact reviewed candidate");
    expectStranger(app.personasim.store.getCharacterSpec(generated.id)!);
  });

  it("restores and publishes old versions through the new policy without rewriting historical specs", async () => {
    const created = await app.personasim.characters.generate(INPUT);
    const historical = {
      ...created,
      status: "published" as const,
      userRelationship: {
        ...created.userRelationship,
        relationshipType: "旧友",
        initialCloseness: 0.8,
        initialTrust: 0.9,
        sharedContext: "曾一起旅行。",
      },
      lockedPaths: ["userRelationship", "userRelationship.sharedContext"],
    };
    delete historical.authorityAudit;
    app.personasim.store.replaceVersion(historical);
    app.personasim.store.updateCharacterHead(historical);
    const published = app.personasim.characters.publish(
      created.id,
      created.version,
    );
    expectStranger(published);
    expect(published.version).toBe(created.version + 1);
    const savedHistory = app.personasim.store.getCharacterSpec(
      created.id,
      created.version,
    )!;
    expect(savedHistory.userRelationship).toEqual(historical.userRelationship);
    expect(savedHistory.knowledge).toEqual(historical.knowledge);
    expect(savedHistory.lockedPaths).toEqual(historical.lockedPaths);
    const restored = app.personasim.characters.restore(
      created.id,
      created.version,
    );
    expectStranger(restored);
    expectStranger(
      app.personasim.characters.publish(created.id, restored.version),
    );
  });

  it("stores demo origin before publication and retains it after a replacement demo is registered", async () => {
    const first = await app.inject({ method: "POST", url: "/api/demo/ensure" });
    const oldDemo = first.json<{ characterId: string }>().characterId;
    expect(app.personasim.characters.getCreationOrigin(oldDemo)).toBe("demo");
    expectStranger(app.personasim.store.getCharacterSpec(oldDemo)!);
    app.personasim.characters.archive(oldDemo);
    const next = await app.inject({ method: "POST", url: "/api/demo/ensure" });
    const newDemo = next.json<{ characterId: string }>().characterId;
    expect(newDemo).not.toBe(oldDemo);
    expect(app.personasim.characters.getCreationOrigin(newDemo)).toBe("demo");
    expect(app.personasim.characters.getCreationOrigin(oldDemo)).toBe("demo");
  });
});
