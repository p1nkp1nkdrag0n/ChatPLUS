import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CharacterCompilationProposalSchema,
  CharacterInterviewCompileResponseSchema,
  OriginalCharacterInputSchema,
  type CharacterInterviewAnswers,
  type CharacterInterviewCompileResponse,
} from "@personasim/contracts";
import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { FakeClock } from "../runtime/clock.js";
import { buildOriginalDraft } from "../domain/defaults.js";
import {
  buildInterviewPreview,
  interviewOriginalInput,
} from "./character-interview-service.js";

const ANSWERS: CharacterInterviewAnswers = {
  gender: "女性",
  name: "林澈",
  ageText: "二十多岁",
  worldSetting: "江南的一座小城",
  workOrRole: "古籍修复师",
  personality: "习惯先听别人说完",
  appearanceDescription: "栗色短发，戴一副圆眼镜",
  dailyHabits: "傍晚沿河散步",
  importantExperience: "曾随外祖父修补过一本家谱",
  currentFocus: "那间即将搬迁的老书店",
  dialogueStyle: "自然克制，偶尔有一点干幽默",
};

describe("character interview lifecycle", () => {
  let app: PersonaSimApp;
  afterEach(async () => {
    vi.restoreAllMocks();
    await app?.close();
  });
  async function start() {
    app = await buildApp({
      config: readConfig({
        nodeEnv: "test",
        databasePath: ":memory:",
        clockMode: "fake",
        seedDemo: false,
        llm: {
          provider: "fixture",
          baseUrl: "https://example.invalid",
          model: "fixture",
          timeoutMs: 1000,
          maxRetries: 0,
        },
      }),
      clock: new FakeClock("2026-09-11T04:00:00.000Z"),
      seedDemo: false,
      startScheduler: false,
      logger: false,
    });
    return app;
  }
  async function compile(extra: Record<string, unknown> = {}) {
    const response = await app.inject({
      method: "POST",
      url: "/api/characters/interview/compile",
      payload: { answers: ANSWERS, ...extra },
    });
    expect(response.statusCode, response.body).toBe(
      extra.characterId ? 200 : 201,
    );
    return CharacterInterviewCompileResponseSchema.parse(response.json());
  }
  function planRefinement(
    patch: Record<string, unknown>,
    changedPaths: string[],
    expand = false,
  ) {
    const provider = app.personasim.llm.generateObject.bind(app.personasim.llm);
    return vi
      .spyOn(app.personasim.llm, "generateObject")
      .mockImplementation(async (input) => {
        if (input.purpose === "character_refinement")
          return input.schema.parse({ answersPatch: patch, changedPaths });
        if (input.purpose === "compile_character" && expand) {
          const proposal = CharacterCompilationProposalSchema.parse(
            await provider(input),
          );
          proposal.draft.persona.traits[0]!.description =
            "她会把温和与自己的判断放在一起；如果书友争论一本书的价值，她可能先听清彼此理由，再平静地说明自己不同意的地方。";
          proposal.draft.persona.traits[0]!.triggers = ["面对意见不同的书友"];
          proposal.draft.persona.traits[0]!.exceptions = [
            "需要即时作出决定时会直接表态",
          ];
          // Unselected content must not drift even if the compiler changes it.
          proposal.draft.persona.values[0]!.description =
            "不应覆盖的无关价值观";
          return input.schema.parse(proposal);
        }
        return provider(input);
      });
  }
  function refine(
    characterId: string,
    expectedVersion: number,
    requestId = "refine-one",
    feedback = "把名字改为林汐，性格改为温和但有主见",
  ) {
    return app.inject({
      method: "POST",
      url: "/api/characters/interview/refine",
      payload: { characterId, expectedVersion, requestId, feedback },
    });
  }

  it("keeps author fields, persists interview source and creates a draft without a session", async () => {
    await start();
    const { character, preview } = await compile();
    expect(character.status).toBe("draft");
    expect(character.identity).toMatchObject({
      gender: "女性",
      ageText: "二十多岁",
      appearance: { summary: ANSWERS.appearanceDescription },
    });
    expect(character.persona.biography).toEqual([
      expect.objectContaining({
        event: ANSWERS.importantExperience,
        period: "未注明时期",
        origin: "user_spec",
      }),
    ]);
    expect(character.persona.goals).toEqual([]);
    expect(character.knowledge.knownFacts).toContain(
      `日常习惯：${ANSWERS.dailyHabits}`,
    );
    expect(app.personasim.store.listSessions(character.id)).toEqual([]);
    expect(preview.answers).toEqual(ANSWERS);
    expect(preview.paragraphs.join("")).toContain(ANSWERS.importantExperience);
    expect(preview.paragraphs.join("")).not.toContain("初始信任");
    const read = await app.inject({
      method: "GET",
      url: `/api/characters/${character.id}/creation-preview`,
    });
    expect(read.json()).toEqual(preview);
    const source = app.personasim.store
      .listCharacterSources(character.id)
      .find((item) => item.sourceType === "character_interview_v1");
    expect(source?.contentExcerpt).toEqual(expect.stringContaining("二十多岁"));
  });

  it("compiles and restores all maximum-length answers without losing full source writing", async () => {
    await start();
    const longAnswers: CharacterInterviewAnswers = {
      gender: "性".repeat(2_000),
      name: "名".repeat(2_000),
      ageText: "龄".repeat(2_000),
      worldSetting: "世".repeat(4_000),
      workOrRole: "职".repeat(2_000),
      personality: "格".repeat(2_000),
      appearanceDescription: "貌".repeat(2_000),
      dailyHabits: "惯".repeat(2_000),
      importantExperience: "历".repeat(2_000),
      dialogueStyle: "话".repeat(2_000),
      currentFocus: "意".repeat(2_000),
      additionalDetails: "补".repeat(6_000),
      followUps: [
        { id: "one", question: "其一？", answer: "一".repeat(2_000) },
        { id: "two", question: "其二？", answer: "二".repeat(2_000) },
      ],
      advanced: { storyEra: "代".repeat(2_000) },
    };
    const input = interviewOriginalInput(longAnswers);
    expect(OriginalCharacterInputSchema.safeParse(input).success).toBe(true);
    expect(input.characterBrief!.length).toBeGreaterThan(30_000);
    const spy = vi.spyOn(app.personasim.llm, "generateObject");
    const { character, preview } = await compile({ answers: longAnswers });
    expect(preview.answers).toEqual(longAnswers);
    expect(character.identity.name).toHaveLength(120);
    expect(character.identity.workOrRole).toHaveLength(240);
    expect(character.persona.traits[0]!.name).toHaveLength(120);
    const compilerPrompt = spy.mock.calls.find(
      ([call]) => call.purpose === "compile_character",
    )![0].prompt;
    for (const value of Object.values(longAnswers).filter(
      (value): value is string => typeof value === "string",
    ))
      expect(compilerPrompt).toContain(value);
    expect(compilerPrompt).toContain(longAnswers.advanced!.storyEra!);
    expect(compilerPrompt).toContain(longAnswers.followUps![1]!.answer);
    const read = await app.inject({
      method: "GET",
      url: `/api/characters/${character.id}/creation-preview`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json<{ answers: CharacterInterviewAnswers }>().answers).toEqual(
      longAnswers,
    );
    const source = app.personasim.store
      .listCharacterSources(character.id)
      .find((item) => item.sourceType === "character_interview_v1")!;
    const persisted = JSON.parse(String(source.contentExcerpt)) as {
      answers: CharacterInterviewAnswers;
    };
    expect(persisted.answers).toEqual(longAnswers);

    vi.restoreAllMocks();
    planRefinement({ name: "林澈" }, ["identity.name"]);
    const response = await refine(
      character.id,
      1,
      "long-answers-refinement",
      "只把名字改为林澈，其余保留",
    );
    expect(response.statusCode, response.body).toBe(200);
    const revised = CharacterInterviewCompileResponseSchema.parse(
      response.json(),
    );
    expect(revised.preview.answers).toMatchObject({
      ...longAnswers,
      name: "林澈",
    });
  });

  it("reuses one request and recompiles the same draft without resetting its initial state", async () => {
    await start();
    const spy = vi.spyOn(app.personasim.llm, "generateObject");
    const [first, retry] = await Promise.all([
      compile({ requestId: "creation-one" }),
      compile({ requestId: "creation-one" }),
    ]);
    expect(retry.character.id).toBe(first.character.id);
    expect(spy.mock.calls.map(([input]) => input.purpose)).toEqual([
      "compile_character",
      "character_portrait",
    ]);
    const state = app.personasim.store.getRuntimeState(first.character.id);
    const revised = await compile({
      characterId: first.character.id,
      expectedVersion: 1,
      requestId: "creation-one",
      answers: { ...ANSWERS, name: "阿澄", ageText: "年龄不详" },
    });
    expect(revised.character).toMatchObject({
      id: first.character.id,
      version: 2,
      identity: { name: "阿澄", ageText: "年龄不详" },
    });
    expect(revised.preview.answers.name).toBe("阿澄");
    const retryRevised = await compile({
      characterId: first.character.id,
      expectedVersion: 1,
      requestId: "creation-one",
      answers: { ...ANSWERS, name: "阿澄", ageText: "年龄不详" },
    });
    expect(retryRevised).toEqual(revised);
    expect(app.personasim.store.getRuntimeState(first.character.id)).toEqual(
      state,
    );
    expect(app.personasim.store.countCharacters()).toBe(1);
    const stale = await app.inject({
      method: "POST",
      url: "/api/characters/interview/compile",
      payload: {
        answers: ANSWERS,
        characterId: first.character.id,
        expectedVersion: 1,
      },
    });
    expect(stale.statusCode).toBe(409);
    const conflict = await app.inject({
      method: "POST",
      url: "/api/characters/interview/compile",
      payload: {
        answers: { ...ANSWERS, name: "另一位" },
        requestId: "creation-one",
      },
    });
    expect(conflict.statusCode).toBe(409);
    expect(app.personasim.store.countCharacters()).toBe(1);
  });

  it("previews the actual edited identity while retaining the original interview as its source", async () => {
    await start();
    const { character, preview } = await compile();
    expect(preview.canReviseInterview).toBe(true);
    app.personasim.characters.updateDraft(character.id, {
      path: "identity.name",
      value: "后来确定的名字",
      expectedVersion: character.version,
    });
    const response = await app.inject({
      method: "GET",
      url: `/api/characters/${character.id}/creation-preview`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      characterVersion: 2,
      status: "draft",
      identity: { name: "后来确定的名字" },
      answers: { name: ANSWERS.name },
      canReviseInterview: false,
    });
    expect(
      response.json<{ paragraphs: string[] }>().paragraphs.join(""),
    ).toContain("后来确定的名字");
  });

  it("rejects recompilation after publication even if the head is later a draft", async () => {
    await start();
    const { character } = await compile();
    const published = await app.inject({
      method: "POST",
      url: `/api/characters/${character.id}/publish`,
      payload: { expectedVersion: 1 },
    });
    expect(published.statusCode, published.body).toBe(200);
    const edited = app.personasim.characters.updateDraft(character.id, {
      path: "identity.name",
      value: "新名字",
      expectedVersion: 1,
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/characters/interview/compile",
      payload: {
        answers: ANSWERS,
        characterId: character.id,
        expectedVersion: edited.version,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      "interview_draft_not_editable",
    );
  });

  it("checks the version again after an in-flight model call and leaves no extra source or character", async () => {
    await start();
    const first = await compile();
    const beforeSources = app.personasim.store.listCharacterSources(
      first.character.id,
    );
    const provider = app.personasim.llm.generateObject.bind(app.personasim.llm);
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementationOnce(
      async (input) => {
        const result = await provider(input);
        app.personasim.characters.publish(
          first.character.id,
          first.character.version,
        );
        return result;
      },
    );
    const response = await app.inject({
      method: "POST",
      url: "/api/characters/interview/compile",
      payload: {
        answers: ANSWERS,
        characterId: first.character.id,
        expectedVersion: first.character.version,
      },
    });
    expect(response.statusCode).toBe(409);
    expect(
      app.personasim.store.listCharacterSources(first.character.id),
    ).toEqual(beforeSources);
    expect(app.personasim.store.countCharacters()).toBe(1);
  });

  it("offers at most two optional questions and degrades provider failure to an empty list", async () => {
    await start();
    const ask = () =>
      app.inject({
        method: "POST",
        url: "/api/characters/interview/follow-ups",
        payload: { answers: ANSWERS },
      });
    expect(
      (await ask()).json<{ questions: unknown[] }>().questions,
    ).toHaveLength(2);
    vi.spyOn(app.personasim.llm, "generateObject").mockRejectedValueOnce(
      new Error("offline"),
    );
    expect((await ask()).json()).toEqual({ questions: [] });
    expect(app.personasim.store.countCharacters()).toBe(0);
  });

  it("rolls back a newly generated character if its durable interview source cannot be saved", async () => {
    await start();
    app.personasim.store.database.exec(`CREATE TRIGGER reject_interview_source
      BEFORE INSERT ON character_sources WHEN NEW.source_type = 'character_interview_v1'
      BEGIN SELECT RAISE(ABORT, 'injected interview source failure'); END;`);
    const response = await app.inject({
      method: "POST",
      url: "/api/characters/interview/compile",
      payload: { answers: ANSWERS, requestId: "rollback-source" },
    });
    expect(response.statusCode).toBe(500);
    expect(app.personasim.store.countCharacters()).toBe(0);
    expect(
      app.personasim.store.database
        .prepare("SELECT * FROM runtime_states")
        .all(),
    ).toEqual([]);
    expect(
      app.personasim.store.database
        .prepare("SELECT * FROM character_sources")
        .all(),
    ).toEqual([]);
  });

  it("keeps unapproved candidate prose out of the preview and does not turn questions into author facts", async () => {
    await start();
    const input = interviewOriginalInput(ANSWERS);
    const draft = buildOriginalDraft(input, "companion_character_v3");
    draft.identity.name = "错误姓名";
    draft.identity.gender = "错误性别";
    draft.identity.ageText = "五百岁";
    draft.identity.selfDescription = "她出生于虚构秘境，和用户是青梅竹马。";
    draft.knowledge.knownFacts.push("她出生于虚构秘境。");
    draft.userRelationship.sharedContext = "和用户是青梅竹马。";
    vi.spyOn(app.personasim.llm, "generateObject").mockResolvedValueOnce({
      draft,
      reasonCode: "test",
      reasonSummary: "test",
    });
    const result: CharacterInterviewCompileResponse = await compile();
    expect(result.character.identity).toMatchObject({
      name: ANSWERS.name,
      gender: ANSWERS.gender,
      ageText: ANSWERS.ageText,
    });
    expect(result.preview.paragraphs.join("")).not.toMatch(
      /虚构秘境|青梅竹马|错误姓名|五百岁/,
    );
    expect(result.character.userRelationship.sharedContext).toBe("");
    const before = JSON.stringify(result.character.authorityAudit);
    buildInterviewPreview(result.character, ANSWERS);
    expect(JSON.stringify(result.character.authorityAudit)).toBe(before);
    const followInput = interviewOriginalInput({
      ...ANSWERS,
      followUps: [
        {
          id: "q1",
          question: "你提到的母亲叫什么名字？",
          answer: "我没有设定过母亲。",
        },
      ],
    });
    expect(followInput.characterBrief).not.toContain("你提到的母亲");
    expect(followInput.characterBrief).toContain("我没有设定过母亲。");
  });

  it("persists prose from expanded effective traits and restores the matching version's prose", async () => {
    await start();
    const provider = app.personasim.llm.generateObject.bind(app.personasim.llm);
    const spy = vi
      .spyOn(app.personasim.llm, "generateObject")
      .mockImplementation(async (input) => {
        if (input.purpose === "compile_character") {
          const proposal = CharacterCompilationProposalSchema.parse(
            await provider(input),
          );
          proposal.draft.persona.traits[0]!.description =
            "面对分歧，她倾向于先确认对方真正担心的是什么；如果讨论一本旧书，她可能先听完对方的理由，再说自己的观察。";
          proposal.draft.persona.traits[0]!.triggers = ["修复方案出现分歧时"];
          proposal.draft.persona.traits[0]!.exceptions = ["涉及当下紧急决定时"];
          return input.schema.parse(proposal);
        }
        return provider(input);
      });
    const first = await compile({ requestId: "prose-v1" });
    expect(first.preview.paragraphs.join("")).toContain("真正担心的是什么");
    expect(first.preview.paragraphs.join("")).toContain("修复方案出现分歧时");
    expect(first.preview.paragraphs.join("")).toContain("涉及当下紧急决定时");
    expect(first.preview.canRefine).toBe(true);
    const portrait = spy.mock.calls.find(
      ([input]) => input.purpose === "character_portrait",
    )![0];
    expect(portrait.prompt).toContain("真正担心的是什么");
    expect(portrait.prompt).not.toContain("authorityAudit");
    expect(
      spy.mock.calls.every(([input]) => input.useModelMaxOutputTokens === true),
    ).toBe(true);
    const saved = app.personasim.store
      .listCharacterSources(first.character.id)
      .find((item) => item.sourceType === "character_interview_prose_v1");
    expect(saved?.contentExcerpt).toContain(first.preview.factsHash);
    const second = await compile({
      characterId: first.character.id,
      expectedVersion: 1,
      answers: { ...ANSWERS, name: "修订名字" },
    });
    expect(second.preview.paragraphs.join("")).toContain("修订名字");
    app.personasim.characters.restore(first.character.id, 1);
    const restored = await app.inject({
      method: "GET",
      url: `/api/characters/${first.character.id}/creation-preview`,
    });
    expect(restored.json()).toMatchObject({
      characterVersion: 3,
      paragraphs: first.preview.paragraphs,
      answers: first.preview.answers,
      factsHash: first.preview.factsHash,
    });
  });

  it("applies natural feedback to real author fields, preserves unrelated content, and retries exactly once", async () => {
    await start();
    const first = await compile();
    const initialState = app.personasim.store.getRuntimeState(
      first.character.id,
    );
    const spy = planRefinement(
      { name: "林汐", personality: "温和但有主见" },
      ["identity.name", "persona.traits"],
      true,
    );
    const response = await refine(first.character.id, 1);
    expect(response.statusCode, response.body).toBe(200);
    const revised = CharacterInterviewCompileResponseSchema.parse(
      response.json(),
    );
    expect(revised.character).toMatchObject({
      id: first.character.id,
      version: 2,
      status: "draft",
      identity: { name: "林汐" },
    });
    expect(revised.character.persona.traits[0]!.name).toBe("温和但有主见");
    expect(revised.preview.answers).toMatchObject({
      name: "林汐",
      personality: "温和但有主见",
    });
    expect(revised.preview.paragraphs.join("")).toContain(
      "平静地说明自己不同意的地方",
    );
    expect(revised.preview.paragraphs.join("")).toContain("林汐");
    expect(revised.character.persona.values).toEqual(
      first.character.persona.values,
    );
    expect(revised.character.persona.biography).toEqual(
      first.character.persona.biography,
    );
    expect(revised.character.routines).toEqual(first.character.routines);
    expect(revised.character.knowledge).toEqual(first.character.knowledge);
    expect(revised.character.userRelationship).toEqual(
      first.character.userRelationship,
    );
    expect(app.personasim.store.getRuntimeState(first.character.id)).toEqual(
      initialState,
    );
    expect(spy.mock.calls.map(([input]) => input.purpose)).toEqual([
      "character_refinement",
      "compile_character",
      "character_portrait",
    ]);
    expect(
      spy.mock.calls.every(([input]) => input.useModelMaxOutputTokens === true),
    ).toBe(true);
    const context = spy.mock.calls
      .find(([input]) => input.purpose === "compile_character")![0]
      .prompt.split("REVISION_CONTEXT_JSON\n")[1]!;
    expect(context).not.toContain("authorityAudit");
    const retry = await refine(first.character.id, 1);
    expect(retry.json()).toEqual(revised);
    expect(spy).toHaveBeenCalledTimes(3);
    const mismatch = await refine(
      first.character.id,
      1,
      "refine-one",
      "另一条修改意见",
    );
    expect(mismatch.statusCode).toBe(409);
    const stale = await refine(first.character.id, 1, "refine-stale");
    expect(stale.statusCode).toBe(409);
    expect(
      app.personasim.store.listCharacterVersions(first.character.id),
    ).toHaveLength(2);
    const read = await app.inject({
      method: "GET",
      url: `/api/characters/${first.character.id}/creation-preview`,
    });
    expect(read.json()).toEqual(revised.preview);
  });

  it("refines a newer manually edited draft using its complete current content", async () => {
    await start();
    const first = await compile();
    const edited = app.personasim.characters.updateDraft(first.character.id, {
      path: "identity.name",
      value: "手工确定的姓名",
      expectedVersion: 1,
    });
    const spy = planRefinement(
      { personality: "温和但有主见" },
      ["persona.traits"],
      true,
    );
    const before = await app.inject({
      method: "GET",
      url: `/api/characters/${first.character.id}/creation-preview`,
    });
    expect(before.json()).toMatchObject({
      canReviseInterview: false,
      canRefine: true,
    });
    const response = await refine(
      first.character.id,
      edited.version,
      "after-manual",
      "把性格改为温和但有主见",
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      character: { identity: { name: "手工确定的姓名" }, version: 3 },
      preview: { answers: { name: "手工确定的姓名" } },
    });
    expect(spy.mock.calls[0]![0].prompt).toContain("手工确定的姓名");
  });

  it("rejects refinement after publication or activation and does no new model work", async () => {
    await start();
    const first = await compile();
    const second = await compile();
    app.personasim.characters.publish(first.character.id);
    const edited = app.personasim.characters.updateDraft(first.character.id, {
      path: "identity.name",
      value: "后来的草稿",
      expectedVersion: 1,
    });
    const state = app.personasim.store.getRuntimeState(second.character.id)!;
    app.personasim.store.updateRuntimeState({ ...state, revision: 1 });
    const spy = vi.spyOn(app.personasim.llm, "generateObject");
    expect(
      (await refine(first.character.id, edited.version, "after-publish"))
        .statusCode,
    ).toBe(409);
    expect(
      (await refine(second.character.id, 1, "after-activation")).statusCode,
    ).toBe(409);
    expect(spy).not.toHaveBeenCalled();
    const preview = await app.inject({
      method: "GET",
      url: `/api/characters/${second.character.id}/creation-preview`,
    });
    expect(preview.json()).toMatchObject({
      canRefine: false,
      canReviseInterview: false,
    });
  });

  it("keeps character, sources and version unchanged when portrait generation or persistence fails", async () => {
    await start();
    const first = await compile();
    const sources = app.personasim.store.listCharacterSources(
      first.character.id,
    );
    const state = app.personasim.store.getRuntimeState(first.character.id);
    const provider = app.personasim.llm.generateObject.bind(app.personasim.llm);
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      async (input) => {
        if (input.purpose === "character_portrait")
          throw new Error("portrait offline");
        return provider(input);
      },
    );
    expect((await refine(first.character.id, 1)).statusCode).toBe(500);
    expect(app.personasim.store.getCharacterSpec(first.character.id)).toEqual(
      first.character,
    );
    expect(
      app.personasim.store.listCharacterSources(first.character.id),
    ).toEqual(sources);
    expect(app.personasim.store.getRuntimeState(first.character.id)).toEqual(
      state,
    );
    const failedCreate = await app.inject({
      method: "POST",
      url: "/api/characters/interview/compile",
      payload: { answers: ANSWERS, requestId: "failed-prose" },
    });
    expect(failedCreate.statusCode).toBe(500);
    expect(app.personasim.store.countCharacters()).toBe(1);
    vi.restoreAllMocks();
    app.personasim.store.database.exec(
      `CREATE TRIGGER reject_prose_source BEFORE INSERT ON character_sources WHEN NEW.source_type = 'character_interview_prose_v1' BEGIN SELECT RAISE(ABORT, 'injected prose source failure'); END;`,
    );
    expect((await refine(first.character.id, 1)).statusCode).toBe(500);
    expect(app.personasim.store.getCharacterSpec(first.character.id)).toEqual(
      first.character,
    );
    expect(
      app.personasim.store.listCharacterVersions(first.character.id),
    ).toHaveLength(1);
    expect(
      app.personasim.store.listCharacterSources(first.character.id),
    ).toEqual(sources);
  });

  it("rechecks the draft after prose generation and atomically refuses a concurrent update", async () => {
    await start();
    const first = await compile();
    const sources = app.personasim.store.listCharacterSources(
      first.character.id,
    );
    const provider = app.personasim.llm.generateObject.bind(app.personasim.llm);
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      async (input) => {
        const result = await provider(input);
        if (input.purpose === "character_portrait")
          app.personasim.characters.updateDraft(first.character.id, {
            path: "identity.name",
            value: "另一处修改",
            expectedVersion: 1,
          });
        return result;
      },
    );
    expect((await refine(first.character.id, 1)).statusCode).toBe(409);
    expect(
      app.personasim.store.getCharacterSpec(first.character.id)?.identity.name,
    ).toBe("另一处修改");
    expect(
      app.personasim.store.listCharacterSources(first.character.id),
    ).toEqual(sources);
    expect(
      app.personasim.store.listCharacterVersions(first.character.id),
    ).toHaveLength(2);
  });

  it("retains approved facts while replacing the stale fact for a changed author field", async () => {
    await start();
    const first = await compile();
    const fact = "她保留着一份祖父亲手写的修复笔记。";
    const pending = app.personasim.characters.updateDraft(first.character.id, {
      path: "knowledge.knownFacts",
      value: [...first.character.knowledge.knownFacts, fact],
      expectedVersion: 1,
    });
    const candidate = pending.authorityAudit!.candidates.find(
      (item) =>
        item.target === "knowledge.knownFacts" &&
        item.originalValue === JSON.stringify(fact),
    )!;
    const accepted = app.personasim.characters.updateDraft(first.character.id, {
      expectedVersion: 2,
      authorityDecisions: [
        {
          candidateId: candidate.candidateId,
          candidateSha256: candidate.candidateSha256,
          decision: "accept",
        },
      ],
    });
    planRefinement({ ageText: "三十岁", workOrRole: "旧书店店主" }, [
      "identity.ageText",
      "identity.workOrRole",
    ]);
    const response = await refine(
      first.character.id,
      accepted.version,
      "age-and-work",
      "年龄改成三十岁，职业改成旧书店店主，其余保留",
    );
    expect(response.statusCode, response.body).toBe(200);
    const revised = CharacterInterviewCompileResponseSchema.parse(
      response.json(),
    );
    expect(revised.character.knowledge.knownFacts).toContain(fact);
    expect(revised.character.knowledge.knownFacts).toContain("年龄：三十岁");
    expect(revised.character.knowledge.knownFacts).toContain("旧书店店主");
    expect(revised.character.knowledge.knownFacts).not.toContain(
      "年龄：二十多岁",
    );
    expect(revised.character.knowledge.knownFacts).not.toContain("古籍修复师");
  });

  it("retains manually confirmed personality and voice as the current refinement baseline", async () => {
    await start();
    const first = await compile();
    const currentTrait = {
      ...first.character.persona.traits[0]!,
      name: "平静但直率",
      description: "会清楚解释自己的分歧",
    };
    const pending = app.personasim.characters.updateDraft(first.character.id, {
      path: "persona.traits",
      value: [currentTrait],
      expectedVersion: 1,
    });
    const candidate = pending.authorityAudit!.candidates.find(
      (item) => item.target === "persona.traits" && item.status === "pending",
    )!;
    app.personasim.characters.updateDraft(first.character.id, {
      expectedVersion: 2,
      authorityDecisions: [
        {
          candidateId: candidate.candidateId,
          candidateSha256: candidate.candidateSha256,
          decision: "accept",
        },
      ],
    });
    const edited = app.personasim.characters.updateDraft(first.character.id, {
      path: "dialogue.authorGuidance",
      value: "语气明快，想法直接，具体而细致",
      expectedVersion: 3,
    });
    const spy = planRefinement({}, ["persona.traits", "dialogue.warmth"]);
    const response = await refine(
      first.character.id,
      edited.version,
      "current-trait",
      "保留现在的性格和说话基调，把性格表现写得更具体，稍微更亲切一些",
    );
    expect(response.statusCode, response.body).toBe(200);
    const revised = CharacterInterviewCompileResponseSchema.parse(
      response.json(),
    );
    expect(revised.character.persona.traits.map((item) => item.name)).toContain(
      "平静但直率",
    );
    expect(
      revised.character.persona.traits.map((item) => item.name),
    ).not.toContain(ANSWERS.personality);
    expect(revised.character.dialogue.authorGuidance).toBe(
      "语气明快，想法直接，具体而细致",
    );
    expect(spy.mock.calls[0]![0].prompt).toContain(
      '"personality":"平静但直率"',
    );
  });

  it("preserves prior approved constraints, excludes pending candidates from model context and respects locks", async () => {
    await start();
    const draft = buildOriginalDraft(
      interviewOriginalInput(ANSWERS),
      "companion_character_v3",
    );
    draft.persona.boundaries = [
      {
        id: "approved-later",
        condition: "讨论私人日记时",
        forbiddenBehavior: "必须先获得本人同意",
        responsePattern: "先说明需要许可",
        hard: true,
      },
      {
        id: "quarantined",
        condition: "任何时候",
        forbiddenBehavior: "永不提及隔离候选标记甲",
        responsePattern: "拒绝谈论",
        hard: true,
      },
    ];
    vi.spyOn(app.personasim.llm, "generateObject").mockResolvedValueOnce({
      draft,
      reasonCode: "test",
      reasonSummary: "test",
    });
    const first = await compile();
    vi.restoreAllMocks();
    const candidate = first.character.authorityAudit!.candidates.find(
      (item) => item.ruleId === "approved-later",
    )!;
    const approved = app.personasim.characters.updateDraft(first.character.id, {
      expectedVersion: 1,
      authorityDecisions: [
        {
          candidateId: candidate.candidateId,
          candidateSha256: candidate.candidateSha256,
          decision: "accept",
        },
      ],
    });
    const spy = planRefinement({ name: "林汐" }, ["identity.name"]);
    const response = await refine(
      first.character.id,
      approved.version,
      "keep-approved",
      "把名字改为林汐",
    );
    expect(response.statusCode, response.body).toBe(200);
    const revised = CharacterInterviewCompileResponseSchema.parse(
      response.json(),
    );
    expect(revised.character.persona.boundaries).toEqual(
      approved.persona.boundaries,
    );
    for (const [input] of spy.mock.calls)
      expect(input.prompt).not.toContain("隔离候选标记甲");
    expect(
      revised.character.authorityAudit!.candidates.find(
        (item) => item.ruleId === "quarantined",
      )?.status,
    ).toBe("pending");
    const lockDraft = app.personasim.characters.updateDraft(
      first.character.id,
      {
        path: "lockedPaths",
        value: ["identity.name"],
        expectedVersion: revised.character.version,
      },
    );
    const lock = lockDraft.authorityAudit!.candidates.find(
      (item) => item.target === "lockedPaths" && item.status === "pending",
    )!;
    const locked = app.personasim.characters.updateDraft(first.character.id, {
      expectedVersion: lockDraft.version,
      authorityDecisions: [
        {
          candidateId: lock.candidateId,
          candidateSha256: lock.candidateSha256,
          decision: "accept",
        },
      ],
    });
    vi.restoreAllMocks();
    planRefinement({ name: "陈晞" }, ["identity.name"]);
    const blocked = await refine(
      first.character.id,
      locked.version,
      "locked-name",
      "改姓名",
    );
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(blocked.json()).toMatchObject({ error: { code: "field_locked" } });
    expect(app.personasim.store.getCharacterSpec(first.character.id)).toEqual(
      locked,
    );
  });
});
