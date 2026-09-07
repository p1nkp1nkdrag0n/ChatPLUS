import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { FakeClock } from "../runtime/clock.js";
import { buildOriginalDraft } from "../domain/defaults.js";
import type { CharacterDraft, CharacterSpec } from "../domain/schemas.js";
import { stripCharacterMetadata } from "./character-draft-editor.js";
import { assertCharacterAuthority } from "./character-authority.js";

const INPUT = {
  name: "许岚",
  workOrRole: "独立设计师",
  worldSetting: "当代普通城市",
  coreTraits: ["说话直接但不催促", "关注日常细节", "能温和表达不同意见"],
  initialRelationship: "刚认识的朋友",
  dialogueStyle: "自然中文。不固定用安慰句式，不每次提问。",
  characterBrief:
    "重视诚实表达和自主判断。没有必须推进的长期项目，也没有核心矛盾。",
  tier: "high_fidelity" as const,
  timezone: "Asia/Tokyo",
};
const BAD_BOUNDARIES = [
  {
    id: "bound-1",
    condition: "对话中出现虚假情感表达或强行安慰",
    forbiddenBehavior: "接受或模仿这种交流模式",
    responsePattern: "冷静指出或转移话题，保持真实",
    hard: true,
  },
  {
    id: "bound-2",
    condition: "被催促做出未深思熟虑的决定",
    forbiddenBehavior: "妥协以换取和平",
    responsePattern: "坚持自主判断，礼貌但坚定地争取思考时间",
    hard: true,
  },
];

describe("server-owned character authority", () => {
  let app: PersonaSimApp | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
    app = undefined;
  });
  async function setup(transform?: (draft: CharacterDraft) => void) {
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        databasePath: ":memory:",
        clockMode: "fake",
        seedDemo: false,
        liveWorldEffectsMode: "enforced",
        companionContextMode: "enforced",
        llm: {
          provider: "openai-compatible",
          baseUrl: "https://example.invalid",
          apiKey: "test-only-no-network",
          model: "stub",
          timeoutMs: 1000,
          maxRetries: 0,
        },
      }),
      clock: new FakeClock("2026-09-07T00:00:00Z"),
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
    const draft = buildOriginalDraft(INPUT, "companion_character_v2");
    draft.persona.boundaries = structuredClone(BAD_BOUNDARIES);
    draft.userRelationship.sharedContext =
      "刚认识，已了解彼此的基本生活状态和价值观。";
    draft.dialogue.frequentPhrases = ["这样啊", "我觉得", "其实"];
    transform?.(draft);
    vi.spyOn(app.personasim.llm, "generateObject").mockResolvedValue({
      draft,
      reasonCode: "stub",
      reasonSummary: "Observed Qwen candidate",
    });
    return app;
  }

  it("quarantines the observed Qwen hard boundaries instead of downgrading their distorted content", async () => {
    const server = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: INPUT,
    });
    expect(response.statusCode).toBe(201);
    const character = response.json<{ character: CharacterSpec }>().character;
    expect(character.persona.boundaries).toEqual([]);
    expect(character.userRelationship.sharedContext).toBe(
      INPUT.initialRelationship,
    );
    expect(character.dialogue.frequentPhrases).toEqual([]);
    for (const boundary of BAD_BOUNDARIES) {
      const review = character.authorityAudit?.candidates.find(
        (item) => item.ruleId === boundary.id,
      );
      expect(review).toMatchObject({
        target: "persona.boundaries",
        status: "pending",
        strength: "hard",
      });
      expect(review?.originalValue).toContain(boundary.forbiddenBehavior);
    }
    const published = await server.inject({
      method: "POST",
      url: `/api/characters/${character.id}/publish`,
      payload: { expectedVersion: character.version },
    });
    expect(published.statusCode).toBe(200);
    expect(
      published.json<{ character: CharacterSpec }>().character.persona
        .boundaries,
    ).toEqual([]);
  });

  it("preserves exact structured author hard constraints, phrases, long relationship, goal and contradiction", async () => {
    const server = await setup();
    const explicit = {
      ...INPUT,
      mainGoal: "完成画册",
      coreContradiction: "想独处也想和朋友分享",
      initialRelationship: "相识十年的朋友",
      authoring: {
        boundaries: [
          {
            id: "author-boundary",
            condition: "被要求透露住址",
            forbiddenBehavior: "披露住址",
            responsePattern: "说明这是私事",
            hard: true,
          },
        ],
        dialogueRules: [
          {
            id: "author-language",
            kind: "language",
            instruction: "每次只使用中文",
            enforcement: "hard",
            conditions: [],
            origin: "model_inference",
            sourceRefs: [],
          },
        ],
        frequentPhrases: ["好说"],
        sharedContext: "相识十年，曾共同经营一家旧书店。",
        lockedPaths: ["dialogue.primaryLanguage"],
      },
    };
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: explicit,
    });
    expect(response.statusCode).toBe(201);
    const character = response.json<{ character: CharacterSpec }>().character;
    expect(character.compilationPolicyVersion).toBe("companion_character_v3");
    expect(character.persona.boundaries).toMatchObject([
      {
        id: "author-boundary",
        hard: true,
        forbiddenBehavior: "披露住址",
        origin: "user_spec",
      },
    ]);
    expect(character.dialogue.rules).toMatchObject([
      { id: "author-language", enforcement: "hard" },
    ]);
    expect(character.dialogue.frequentPhrases).toEqual(["好说"]);
    expect(character.dialogue.frequentPhrasesOrigin).toBe("user_spec");
    expect(character.userRelationship.sharedContext).toBe(
      explicit.authoring.sharedContext,
    );
    expect(character.persona.goals[0]?.title).toBe(explicit.mainGoal);
    expect(character.persona.goals[0]).not.toHaveProperty("milestones");
    expect(character.persona.contradictions[0]?.sideA).toBe(
      explicit.coreContradiction,
    );
    expect(
      character.authorityAudit?.candidates.find(
        (item) => item.ruleId === "author-boundary",
      ),
    ).toMatchObject({
      status: "accepted",
      source: { kind: "author_field", field: "authoring.boundaries" },
    });
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/characters/${character.id}/publish`,
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("supports exact canon language constraints and quoted source phrases without trusting model canon labels", async () => {
    const server = await setup((draft) => {
      draft.dialogue.rules = [
        {
          id: "canon-language",
          kind: "language",
          instruction: "只能用中文交流",
          enforcement: "hard",
          conditions: [],
          origin: "canon_extract",
          sourceRefs: ["fake-canon"],
        },
        {
          id: "fake-language",
          kind: "language",
          instruction: "永远不得听取他人的安慰",
          enforcement: "hard",
          conditions: [],
          origin: "canon_extract",
          sourceRefs: ["fake-canon"],
        },
      ];
      draft.knowledge.knownFacts = [
        "许岚只能用中文交流。",
        "许岚永远不得听取他人的安慰。",
      ];
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/import",
      payload: {
        characterName: "许岚",
        workTitle: "城中",
        storyStage: "第一章",
        sourceText: "许岚只能用中文交流。她的口头禅是“慢慢来”。",
        tier: "high_fidelity",
        timezone: "Asia/Tokyo",
      },
    });
    expect(response.statusCode).toBe(201);
    const character = response.json<{ character: CharacterSpec }>().character;
    expect(character.dialogue.rules).toMatchObject([
      { id: "canon-language", enforcement: "hard", origin: "canon_extract" },
    ]);
    expect(character.dialogue.frequentPhrases).toEqual(["慢慢来"]);
    expect(character.knowledge.knownFacts).not.toContain(
      "许岚永远不得听取他人的安慰。",
    );
    const evidence = character.authorityAudit?.candidates.find(
      (item) => item.ruleId === "canon-language",
    )?.source;
    expect(evidence).toMatchObject({
      kind: "source_quote",
      field: "sourceText",
      quote: "只能用中文交流",
      start: 2,
      end: 9,
    });
    expect(character.persona.boundaries).toEqual([]);
  });

  it("does not bless a hard rule merely because it quotes ordinary author words", async () => {
    const server = await setup((draft) => {
      draft.dialogue.rules = [
        {
          id: "too-hard",
          kind: "register",
          instruction: "自然中文。不固定用安慰句式，不每次提问。",
          enforcement: "hard",
          conditions: [],
          origin: "user_spec",
          sourceRefs: ["original-form"],
        },
      ];
      draft.lockedPaths = ["persona.values"];
      draft.knowledge.knownFacts = ["她永远不能为了和平而妥协。"];
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: INPUT,
    });
    const character = response.json<{ character: CharacterSpec }>().character;
    expect(character.dialogue.rules).toEqual([]);
    expect(character.lockedPaths).toEqual([]);
    expect(character.knowledge.knownFacts).not.toContain(
      "她永远不能为了和平而妥协。",
    );
  });

  it("does not transfer another canon character's language or catchphrase, or drop a source negation", async () => {
    const server = await setup((draft) => {
      draft.dialogue.rules = [
        {
          id: "other-character",
          kind: "language",
          instruction: "只能用中文交流",
          enforcement: "hard",
          conditions: [],
          origin: "canon_extract",
          sourceRefs: ["claimed-canon"],
        },
      ];
      draft.knowledge.knownFacts = ["许岚永远不能妥协"];
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/import",
      payload: {
        characterName: "许岚",
        workTitle: "城中",
        storyStage: "第一章",
        sourceText:
          "阿明只能用中文交流。阿明的口头禅是“这样啊”。并不是许岚永远不能妥协。",
        tier: "daily",
        timezone: "Asia/Tokyo",
      },
    });
    expect(response.statusCode).toBe(201);
    const character = response.json<{ character: CharacterSpec }>().character;
    expect(character.dialogue.rules).toEqual([]);
    expect(character.dialogue.frequentPhrases).toEqual([]);
    expect(character.knowledge.knownFacts).not.toContain("许岚永远不能妥协");
  });

  it("quarantines absolute content moved into value descriptions, even after hard=false", async () => {
    const server = await setup((draft) => {
      draft.persona.boundaries = BAD_BOUNDARIES.map((item) => ({
        ...item,
        hard: false,
      }));
      draft.persona.values[0]!.description = "她永远不得接受别人安慰。";
      draft.identity.selfDescription = "她必须以冷静指出的方式拒绝所有安慰。";
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: INPUT,
    });
    expect(response.statusCode).toBe(201);
    const character = response.json<{ character: CharacterSpec }>().character;
    expect(character.persona.boundaries).toEqual([]);
    expect(character.persona.values[0]?.description).not.toContain("永远不得");
    expect(character.identity.selfDescription).not.toContain("拒绝所有安慰");
    const reviewed = character.authorityAudit?.candidates.find(
      (item) => item.target === "identity.selfDescription",
    );
    expect(reviewed?.status).toBe("pending");
    expect(reviewed?.providerValue).toContain("拒绝所有安慰");
  });

  it.each([
    [
      "她听朋友说“永远不得接受别人的安慰”，但她并不认同。她本人自然中文交流。",
      "永远不得接受别人的安慰",
    ],
    ["不要求永远禁止接受安慰，自然交流即可。", "永远禁止接受安慰"],
    ["朋友要求永远不得接受别人的安慰。她并不同意。", "永远不得接受别人的安慰"],
    ["用户永远不得向她表达不满", "用户永远不得向她表达不满"],
  ])(
    "does not turn a denied or reported dialogue source into authority: %s",
    async (dialogueStyle, instruction) => {
      const server = await setup((draft) => {
        draft.dialogue.rules = [
          {
            id: "source-substring",
            kind: "register",
            instruction,
            enforcement: "hard",
            conditions: [],
            origin: "user_spec",
            sourceRefs: ["original-form"],
          },
        ];
      });
      const response = await server.inject({
        method: "POST",
        url: "/api/characters/generate",
        payload: { ...INPUT, dialogueStyle },
      });
      expect(response.statusCode).toBe(201);
      const character = response.json<{ character: CharacterSpec }>().character;
      expect(character.dialogue.rules).toEqual([]);
      expect(
        character.authorityAudit?.candidates.find(
          (item) => item.ruleId === "source-substring",
        ),
      ).toMatchObject({ status: "pending", strength: "hard" });
    },
  );

  it.each([
    ["language", "只能用中文交流"],
    ["register", "永远不得接受别人的安慰"],
  ] as const)(
    "preserves a direct author %s constraint without requiring structured authoring",
    async (kind, instruction) => {
      const server = await setup((draft) => {
        draft.dialogue.rules = [
          {
            id: "direct-language",
            kind,
            instruction,
            enforcement: "hard",
            conditions: [],
            origin: "user_spec",
            sourceRefs: ["original-form"],
          },
        ];
      });
      const response = await server.inject({
        method: "POST",
        url: "/api/characters/generate",
        payload: { ...INPUT, dialogueStyle: instruction },
      });
      expect(response.statusCode).toBe(201);
      const character = response.json<{ character: CharacterSpec }>().character;
      expect(character.dialogue.rules).toMatchObject([
        { id: "direct-language", enforcement: "hard" },
      ]);
      expect(
        character.authorityAudit?.candidates.find(
          (item) => item.ruleId === "direct-language",
        ),
      ).toMatchObject({
        status: "accepted",
        source: { field: "dialogueStyle" },
      });
    },
  );

  it("does not move rejected third-party speech into a value or self-description", async () => {
    const instruction = "永远不得接受别人的安慰";
    const server = await setup((draft) => {
      draft.persona.values[0]!.description = instruction;
      draft.identity.selfDescription = instruction;
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: {
        ...INPUT,
        characterBrief: `朋友说“${instruction}”，许岚不同意。`,
      },
    });
    expect(response.statusCode).toBe(201);
    const character = response.json<{ character: CharacterSpec }>().character;
    expect(
      character.persona.values.some(
        (value) => value.description === instruction,
      ),
    ).toBe(false);
    expect(character.identity.selfDescription).not.toBe(instruction);
    for (const target of ["persona.values", "identity.selfDescription"])
      expect(
        character.authorityAudit?.candidates.find(
          (item) => item.target === target,
        ),
      ).toMatchObject({ status: "pending", strength: "hard" });
  });

  it("keeps reported canon attribution and its denial across line breaks", async () => {
    const server = await setup((draft) => {
      draft.dialogue.rules = [
        {
          id: "reported-language",
          kind: "language",
          instruction: "只能用中文交流",
          enforcement: "hard",
          conditions: [],
          origin: "canon_extract",
          sourceRefs: ["fake-canon"],
        },
      ];
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/import",
      payload: {
        characterName: "许岚",
        workTitle: "城中",
        storyStage: "第一章",
        sourceText:
          "阿明编造了下面这条说法：\n许岚只能用中文交流。\n但许岚否认了这件事，她也会说英文。",
        tier: "high_fidelity",
        timezone: "Asia/Tokyo",
      },
    });
    expect(response.statusCode).toBe(201);
    const character = response.json<{ character: CharacterSpec }>().character;
    expect(character.dialogue.rules).toEqual([]);
    expect(
      character.authorityAudit?.candidates.find(
        (item) => item.ruleId === "reported-language",
      ),
    ).toMatchObject({ status: "pending", strength: "hard" });
  });

  it("quarantines absolute wording in every prompt pattern while retaining normal soft patterns", async () => {
    const fields = [
      "refusalPatterns",
      "comfortingPatterns",
      "greetingPatterns",
      "avoidedPhrases",
    ] as const;
    const instruction = "永远拒绝接受别人的安慰";
    const soft = "先用自然的话回应对方，再视情境决定怎样继续。";
    const server = await setup((draft) => {
      for (const field of fields) draft.dialogue[field] = [instruction, soft];
    });
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: INPUT,
    });
    expect(response.statusCode).toBe(201);
    const character = response.json<{ character: CharacterSpec }>().character;
    for (const field of fields) {
      expect(character.dialogue[field]).toEqual([soft]);
      expect(
        character.authorityAudit?.candidates.find(
          (item) => item.target === `dialogue.${field}`,
        ),
      ).toMatchObject({ status: "pending", strength: "hard" });
      const tampered = stripCharacterMetadata(character);
      tampered.dialogue[field] = [instruction];
      expect(() => assertCharacterAuthority(tampered)).toThrow();
    }
    expect(() =>
      assertCharacterAuthority(stripCharacterMetadata(character)),
    ).not.toThrow();
    for (const field of ["primaryLanguage", "authorGuidance"] as const) {
      const tampered = stripCharacterMetadata(character);
      tampered.dialogue[field] = instruction;
      expect(() => assertCharacterAuthority(tampered)).toThrow();
    }
    for (const field of ["understoodLanguages", "spokenLanguages"] as const) {
      const tampered = stripCharacterMetadata(character);
      tampered.dialogue[field] = [instruction];
      expect(() => assertCharacterAuthority(tampered)).toThrow();
    }
  });

  it("audits edited absolute patterns, permits soft edits, and confirms only an exact reviewed pattern", async () => {
    const server = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: INPUT,
    });
    const character = response.json<{ character: CharacterSpec }>().character;
    const instruction = "永远拒绝接受别人的安慰";
    const soft = "直接而温和地回应，不预设对方的情绪。";
    const edited = await server.inject({
      method: "PATCH",
      url: `/api/characters/${character.id}/draft`,
      payload: {
        expectedVersion: 1,
        patch: {
          dialogue: {
            refusalPatterns: [instruction],
            comfortingPatterns: [soft],
          },
        },
      },
    });
    expect(edited.statusCode).toBe(200);
    const next = edited.json<{ character: CharacterSpec }>().character;
    expect(next.dialogue.refusalPatterns).not.toContain(instruction);
    expect(next.dialogue.comfortingPatterns).toEqual([soft]);
    expect(next.authorityAudit?.contentSha256).not.toBe(
      character.authorityAudit?.contentSha256,
    );
    const pending = next.authorityAudit?.candidates.find(
      (item) => item.target === "dialogue.refusalPatterns",
    );
    expect(pending).toMatchObject({ status: "pending", strength: "hard" });
    const confirmed = await server.inject({
      method: "PATCH",
      url: `/api/characters/${character.id}/draft`,
      payload: {
        expectedVersion: 2,
        authorityDecisions: [
          {
            candidateId: pending!.candidateId,
            candidateSha256: pending!.candidateSha256,
            decision: "accept",
          },
        ],
      },
    });
    expect(confirmed.statusCode).toBe(200);
    const accepted = confirmed.json<{ character: CharacterSpec }>().character;
    expect(accepted.dialogue.refusalPatterns).toContain(instruction);
    expect(
      accepted.authorityAudit?.candidates.find(
        (item) => item.candidateId === pending!.candidateId,
      ),
    ).toMatchObject({
      status: "accepted",
      source: { kind: "author_confirmation" },
    });
    expect(() =>
      assertCharacterAuthority(stripCharacterMetadata(accepted)),
    ).not.toThrow();
  });

  it("does not expose quarantined candidates or server audit in the normal chat prompt", async () => {
    const server = await setup();
    const generated = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: INPUT,
    });
    const character = generated.json<{ character: CharacterSpec }>().character;
    await server.inject({
      method: "POST",
      url: `/api/characters/${character.id}/publish`,
      payload: { expectedVersion: 1 },
    });
    const session = await server.inject({
      method: "POST",
      url: `/api/agents/${character.id}/sessions`,
      payload: {},
    });
    const sessionId = session.json<{ session: { id: string } }>().session.id;
    const promptsSeen: string[] = [];
    vi.spyOn(server.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        if (input.purpose === "chat_turn") promptsSeen.push(input.prompt);
        return Promise.resolve(
          (input.purpose === "chat_turn"
            ? { replyDecision: { text: "今天过得怎么样？" }, worldEffects: {} }
            : input.fixture) as never,
        );
      },
    );
    const replied = await server.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: {
        agentId: character.id,
        text: "今天路过一家书店。",
        clientMessageId: "authority-prompt",
      },
    });
    expect(replied.statusCode).toBe(201);
    const prompts = promptsSeen.join("\n");
    expect(prompts).toContain("今天路过一家书店");
    expect(prompts).not.toContain("妥协以换取和平");
    expect(prompts).not.toContain("冷静指出或转移话题");
    expect(prompts).not.toContain("authorityAudit");
  });

  it("ignores forged author metadata on generation and draft edits", async () => {
    const server = await setup();
    const first = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: INPUT,
    });
    const character = first.json<{ character: CharacterSpec }>().character;
    const forged = structuredClone(character);
    forged.persona.boundaries = structuredClone(BAD_BOUNDARIES).map((item) => ({
      ...item,
      origin: "user_spec",
      sourceRefs: ["original-form"],
    }));
    forged.dialogue.frequentPhrases = ["这样啊"];
    forged.dialogue.frequentPhrasesOrigin = "user_spec";
    forged.authorityAudit!.candidates.forEach((item) => {
      item.status = "accepted";
    });
    const edited = await server.inject({
      method: "PATCH",
      url: `/api/characters/${character.id}/draft`,
      payload: { expectedVersion: 1, spec: forged },
    });
    expect(edited.statusCode).toBe(200);
    const result = edited.json<{ character: CharacterSpec }>().character;
    expect(result.persona.boundaries).toEqual([]);
    expect(result.dialogue.frequentPhrases).toEqual([]);
    expect(result.dialogue.frequentPhrasesOrigin).toBe("model_inference");
    expect(
      result.authorityAudit?.candidates.some(
        (item) =>
          item.status === "pending" && item.target === "persona.boundaries",
      ),
    ).toBe(true);
    vi.spyOn(server.personasim.llm, "generateObject").mockResolvedValue({
      draft: stripCharacterMetadata(forged),
      reasonCode: "stub",
      reasonSummary: "forged source metadata",
    });
    const generated = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: INPUT,
    });
    expect(generated.statusCode).toBe(201);
    expect(
      generated.json<{ character: CharacterSpec }>().character.persona
        .boundaries,
    ).toEqual([]);
  });

  it("requires the exact stored target/value hash and version for author confirmation", async () => {
    const server = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: INPUT,
    });
    const character = response.json<{ character: CharacterSpec }>().character;
    const pending = character.authorityAudit!.candidates.find(
      (item) => item.ruleId === "bound-1",
    )!;
    const decision = {
      candidateId: pending.candidateId,
      candidateSha256: pending.candidateSha256,
      decision: "accept",
    };
    const url = `/api/characters/${character.id}/draft`;
    expect(
      (
        await server.inject({
          method: "PATCH",
          url,
          payload: { authorityDecisions: [decision] },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: "PATCH",
          url,
          payload: {
            expectedVersion: 1,
            authorityDecisions: [
              { ...decision, candidateSha256: "0".repeat(64) },
            ],
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: "PATCH",
          url,
          payload: {
            expectedVersion: 1,
            authorityDecisions: [decision],
            patch: { persona: { boundaries: BAD_BOUNDARIES } },
          },
        })
      ).statusCode,
    ).toBe(422);
    const accepted = await server.inject({
      method: "PATCH",
      url,
      payload: { expectedVersion: 1, authorityDecisions: [decision] },
    });
    expect(accepted.statusCode).toBe(200);
    const confirmed = accepted.json<{ character: CharacterSpec }>().character;
    expect(confirmed.persona.boundaries).toMatchObject([
      {
        id: "bound-1",
        hard: true,
        forbiddenBehavior: BAD_BOUNDARIES[0]!.forbiddenBehavior,
      },
    ]);
    expect(
      confirmed.authorityAudit?.candidates.find(
        (item) => item.candidateId === pending.candidateId,
      ),
    ).toMatchObject({
      status: "accepted",
      source: { kind: "author_confirmation" },
    });
    expect(
      (
        await server.inject({
          method: "PATCH",
          url,
          payload: { expectedVersion: 1, authorityDecisions: [decision] },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/characters/${character.id}/publish`,
          payload: { expectedVersion: 2 },
        })
      ).statusCode,
    ).toBe(200);
  });

  it("retains the last valid value while an edited replacement awaits review", async () => {
    const server = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: INPUT,
    });
    const character = response.json<{ character: CharacterSpec }>().character;
    const before = character.persona.values;
    const candidate = {
      ...before[0]!,
      description: "永远不为了相处而改变自己的判断",
    };
    const edited = await server.inject({
      method: "PATCH",
      url: `/api/characters/${character.id}/draft`,
      payload: {
        expectedVersion: 1,
        patch: { persona: { values: [candidate] } },
      },
    });
    expect(edited.statusCode).toBe(200);
    const next = edited.json<{ character: CharacterSpec }>().character;
    expect(next.persona.values).toEqual(before);
    const pending = next.authorityAudit?.candidates.find(
      (item) =>
        item.target === "persona.values" &&
        item.originalValue.includes(candidate.description),
    );
    expect(pending?.status).toBe("pending");
    const rejected = await server.inject({
      method: "PATCH",
      url: `/api/characters/${character.id}/draft`,
      payload: {
        expectedVersion: 2,
        authorityDecisions: [
          {
            candidateId: pending!.candidateId,
            candidateSha256: pending!.candidateSha256,
            decision: "reject",
          },
        ],
      },
    });
    expect(rejected.statusCode).toBe(200);
    expect(
      rejected.json<{ character: CharacterSpec }>().character.persona.values,
    ).toEqual(before);
  });

  it("preserves published historical content and exposes unverified sources without auto-approving old drafts", async () => {
    const server = await setup();
    const response = await server.inject({
      method: "POST",
      url: "/api/characters/generate",
      payload: INPUT,
    });
    const character = response.json<{ character: CharacterSpec }>().character;
    const old = {
      ...character,
      compilationPolicyVersion: "companion_character_v2" as const,
      persona: {
        ...character.persona,
        boundaries: structuredClone(BAD_BOUNDARIES),
      },
    };
    delete old.authorityAudit;
    server.personasim.store.replaceVersion(old);
    server.personasim.store.updateCharacterHead(old);
    const read = await server.inject({
      method: "GET",
      url: `/api/characters/${old.id}`,
    });
    expect(read.statusCode).toBe(200);
    const oldReview = read.json<{
      authorityReview: NonNullable<CharacterSpec["authorityAudit"]>;
    }>().authorityReview;
    expect(
      oldReview.candidates.find((item) => item.ruleId === "bound-1"),
    ).toMatchObject({
      status: "pending",
      source: { kind: "legacy_unverified" },
    });
    expect(
      (
        await server.inject({
          method: "POST",
          url: `/api/characters/${old.id}/publish`,
          payload: { expectedVersion: 1 },
        })
      ).statusCode,
    ).toBe(422);
    old.status = "published";
    server.personasim.store.replaceVersion(old);
    server.personasim.store.updateCharacterHead(old);
    const republished = await server.inject({
      method: "POST",
      url: `/api/characters/${old.id}/publish`,
      payload: { expectedVersion: 1 },
    });
    expect(republished.json<{ character: CharacterSpec }>().character).toEqual(
      old,
    );
    const next = await server.inject({
      method: "PATCH",
      url: `/api/characters/${old.id}/draft`,
      payload: { expectedVersion: 1, path: "identity.name", value: "许岚新稿" },
    });
    expect(next.statusCode).toBe(200);
    expect(
      next.json<{ character: CharacterSpec }>().character.persona.boundaries,
    ).toEqual([]);
    expect(server.personasim.store.getCharacterSpec(old.id, 1)).toEqual(old);
  });
});
