import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CharacterInterviewCompileResponseSchema,
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

  it("reuses one request and recompiles the same draft without resetting its initial state", async () => {
    await start();
    const spy = vi.spyOn(app.personasim.llm, "generateObject");
    const [first, retry] = await Promise.all([
      compile({ requestId: "creation-one" }),
      compile({ requestId: "creation-one" }),
    ]);
    expect(retry.character.id).toBe(first.character.id);
    expect(spy).toHaveBeenCalledTimes(1);
    const state = app.personasim.store.getRuntimeState(first.character.id);
    const revised = await compile({
      characterId: first.character.id,
      expectedVersion: 1,
      answers: { ...ANSWERS, name: "阿澄", ageText: "年龄不详" },
    });
    expect(revised.character).toMatchObject({
      id: first.character.id,
      version: 2,
      identity: { name: "阿澄", ageText: "年龄不详" },
    });
    expect(revised.preview.answers.name).toBe("阿澄");
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
});
