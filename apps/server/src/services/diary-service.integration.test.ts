import Fastify from "fastify";
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CharacterSpecSchema,
  DiarySourceMessageSchema,
  type DiaryDraft,
  type GenerateDiaryInput,
} from "@personasim/contracts";
import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import { buildOriginalDraft, initialRuntimeState } from "../domain/defaults.js";
import { ApiError } from "../domain/errors.js";
import { registerDiaryRoutes } from "../http/diary-routes.js";
import { FakeClock } from "../runtime/clock.js";
import { LlmService, type GenerateObjectInput } from "./llm-service.js";
import { DiaryService } from "./diary-service.js";
import { DiaryRepository } from "./diary-repository.js";
import { InteractionAppraisalService } from "./interaction-appraisal-service.js";

const NOW = "2026-09-14T04:00:00.000Z";
const DAY = "2026-09-13";
const AGENT = "agent_diary";
const input = (
  clientRequestId = "request_1",
  extra: Partial<GenerateDiaryInput> = {},
): GenerateDiaryInput => ({
  entryDate: DAY,
  timezone: "Asia/Shanghai",
  clientRequestId,
  ...extra,
});
const draft = (
  sourceMessageIds = ["user_day"],
  text = "我还是礼貌地听完了，但那个话题让我有些不自在。我想留点空间给自己。",
): DiaryDraft => ({
  title: "留一点空间",
  paragraphs: [{ text, sourceMessageIds }],
});

class Model {
  calls: GenerateObjectInput<unknown>[] = [];
  reviewCalls: GenerateObjectInput<unknown>[] = [];
  constructor(
    private readonly respond: (
      call: GenerateObjectInput<unknown>,
      index: number,
    ) => unknown = () => draft(),
    private readonly review: (
      call: GenerateObjectInput<unknown>,
      index: number,
    ) => unknown = () => ({ valid: true, issues: [] }),
  ) {}
  async generateObject<T>(call: GenerateObjectInput<T>): Promise<T> {
    if (call.purpose === "diary_review") {
      this.reviewCalls.push(call);
      return call.schema.parse(
        await this.review(call, this.reviewCalls.length - 1),
      );
    }
    this.calls.push(call);
    return call.schema.parse(await this.respond(call, this.calls.length - 1));
  }
}

function promptOf(call: GenerateObjectInput<unknown>) {
  return z
    .object({
      sourceMessageIds: z.array(z.string()),
      sourceMessages: z.array(DiarySourceMessageSchema.passthrough()),
      historicalStates: z.array(
        z.object({ id: z.string(), sourceMessageId: z.string() }).passthrough(),
      ),
      historicalStateAvailable: z.boolean(),
      appraisals: z.array(z.record(z.string(), z.unknown())),
    })
    .parse(JSON.parse(call.prompt));
}

describe("diary sources, generation and HTTP", () => {
  let db: Database;
  let store: DatabaseStore;
  let clock: FakeClock;
  beforeEach(() => {
    db = openDatabase(":memory:");
    runMigrations(db);
    store = new DatabaseStore(db);
    clock = new FakeClock(NOW);
    for (const id of [AGENT, "agent_other"]) {
      const character = CharacterSpecSchema.parse({
        ...buildOriginalDraft({
          name: id,
          worldSetting: "当代城市",
          workOrRole: "编辑",
          coreTraits: ["克制"],
          initialRelationship: "陌生人",
          dialogueStyle: "简洁礼貌",
          tier: "daily",
          timezone: "UTC",
        }),
        id,
        version: 1,
        status: "published",
        createdAtUtc: NOW,
        updatedAtUtc: NOW,
      });
      store.insertCharacter(character);
      db.prepare(
        `INSERT INTO sessions(id,agent_id,title,created_at_utc,updated_at_utc) VALUES (?,?,?,?,?)`,
      ).run(`session_${id}`, id, "日记测试", NOW, NOW);
    }
    message(
      "user_day",
      "user",
      "今天聊这个话题让我有些犹豫。",
      "2026-09-13T12:00:00.000Z",
    );
    message(
      "reply_day",
      "assistant",
      "我明白了，我们可以先停一停。",
      "2026-09-13T12:01:00.000Z",
      AGENT,
      "user_day",
    );
  });
  afterEach(() => {
    db.close();
  });

  function message(
    id: string,
    role: "user" | "assistant",
    content: string,
    createdAtUtc: string,
    agentId = AGENT,
    inReplyToMessageId?: string,
  ) {
    store.insertMessage({
      id,
      agentId,
      sessionId: `session_${agentId}`,
      role,
      content,
      createdAtUtc,
      messageKind: role === "user" ? "user" : "assistant_reply",
      metadata: {},
      ...(inReplyToMessageId ? { inReplyToMessageId } : {}),
    });
  }

  it("uses the actual fixture provider, persists a version, and has no memory/relationship side effects", async () => {
    const llm = new LlmService(
      {
        provider: "fixture",
        baseUrl: "http://unused.invalid",
        model: "fixture",
        timeoutMs: 1_000,
        maxRetries: 0,
      },
      store,
      clock,
    );
    const service = new DiaryService(store, clock, llm);
    const entry = await service.generate(AGENT, input());
    expect(entry).toMatchObject({
      agentId: AGENT,
      entryDate: DAY,
      timezone: "Asia/Shanghai",
      revision: 1,
      validity: "current",
      hasNewMaterial: false,
      sourceMessageIds: ["user_day"],
    });
    expect(entry.body).toContain("今天聊这个话题");
    expect(db.prepare("SELECT purpose,success FROM llm_calls").all()).toEqual([
      { purpose: "diary_generation", success: 1 },
      { purpose: "diary_review", success: 1 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM memories").get()).toEqual({
      count: 0,
    });
    expect(store.getRuntimeState(AGENT)).toBeUndefined();
    expect(service.volumes()).toEqual([
      {
        agentId: AGENT,
        characterName: AGENT,
        month: "2026-09",
        entryCount: 1,
        latestEntryDate: DAY,
        updatedAtUtc: NOW,
      },
    ]);
    const metadata = db
      .prepare("SELECT generation_metadata_json AS json FROM diary_revisions")
      .get() as { json: string };
    expect(JSON.parse(metadata.json)).toMatchObject({
      promptVersion: "character_private_diary_v1",
      characterVersion: 1,
      providerName: "fixture",
    });
  });

  it("isolates characters and respects the user's midnight, retaining a complete prior turn", async () => {
    message(
      "prior_user",
      "user",
      "昨天的话题还没有聊完。",
      "2026-09-12T15:58:00.000Z",
    );
    for (let index = 0; index < 4; index++)
      message(
        `prior_reply_${index}`,
        "assistant",
        `完整上下文${index}`,
        `2026-09-12T15:59:0${index}.000Z`,
        AGENT,
        "prior_user",
      );
    message(
      "start_user",
      "user",
      "今天的第一句话。",
      "2026-09-12T16:00:00.000Z",
    );
    message(
      "next_user",
      "user",
      "下一天的分享不能归到昨天。",
      "2026-09-13T16:00:00.000Z",
    );
    message(
      "other_user",
      "user",
      "另一角色的私密内容",
      "2026-09-13T12:00:00.000Z",
      "agent_other",
    );
    const model = new Model();
    await new DiaryService(store, clock, model).generate(AGENT, input());
    const prompt = promptOf(model.calls[0]!);
    expect(prompt.sourceMessageIds).toEqual(["start_user", "user_day"]);
    expect(prompt.sourceMessages.map((m: { id: string }) => m.id)).toEqual(
      expect.arrayContaining([
        "prior_user",
        ...Array.from({ length: 4 }, (_, i) => `prior_reply_${i}`),
      ]),
    );
    expect(
      prompt.sourceMessages.find((m: { id: string }) => m.id === "prior_user")
        ?.includedAsDaySource,
    ).toBe(false);
    expect(JSON.stringify(prompt)).not.toContain("另一角色的私密内容");
    expect(JSON.stringify(prompt)).not.toContain("下一天的分享不能归到昨天");
  });

  it("handles a DST day as a calendar day rather than 24 fixed hours", async () => {
    clock.setUtc("2026-11-02T15:00:00.000Z");
    message("dst_start", "user", "冬令时第一小时", "2026-11-01T04:00:00.000Z");
    message("dst_last", "user", "同一天最后一小时", "2026-11-02T04:59:00.000Z");
    message("dst_next", "user", "下一个日界线", "2026-11-02T05:00:00.000Z");
    const model = new Model(() => draft(["dst_start", "dst_last"]));
    await new DiaryService(store, clock, model).generate(
      AGENT,
      input("dst", { entryDate: "2026-11-01", timezone: "America/New_York" }),
    );
    expect(promptOf(model.calls[0]!).sourceMessageIds).toEqual([
      "dst_start",
      "dst_last",
    ]);
  });

  it("preserves insertion order when user and assistant timestamps are identical", async () => {
    const time = "2026-09-13T14:00:00.000Z";
    message("z_user_same", "user", "同一时间第一轮", time);
    message(
      "a_reply_same",
      "assistant",
      "第一轮回复",
      time,
      AGENT,
      "z_user_same",
    );
    message("y_user_same", "user", "同一时间第二轮", time);
    message(
      "b_reply_same",
      "assistant",
      "第二轮回复",
      time,
      AGENT,
      "y_user_same",
    );
    const model = new Model();
    await new DiaryService(store, clock, model).generate(AGENT, input());
    expect(
      promptOf(model.calls[0]!)
        .sourceMessages.filter((m) => m.createdAtUtc === time)
        .map((m) => m.id),
    ).toEqual(["z_user_same", "a_reply_same", "y_user_same", "b_reply_same"]);
  });

  it("freezes only committed historical states, never current state or shadow proposals", async () => {
    for (const [id, eventType, interactionStatus] of [
      ["event_real", "conversation.world_effects_committed", "committed"],
      [
        "event_shadow",
        "conversation.world_effects_shadow_evaluated",
        "committed",
      ],
      ["event_invalid", "conversation.world_effects_committed", "pending"],
    ]) {
      store.insertDomainEvent({
        agentId: AGENT,
        streamType: "world_effects",
        streamId: "session_agent_diary",
        streamVersion: 1,
        eventType: eventType!,
        recordedAtUtc: "2026-09-13T12:01:00.000Z",
        causationId: "user_day",
        idempotencyKey: id!,
        payload: {
          interactionStatus: interactionStatus!,
          before: { moodValence: -0.6, relationship: { closeness: 0.2 } },
          after: { moodValence: -0.7, relationship: { closeness: 0.2 } },
          wouldApply: { moodValence: 0.9 },
        },
      });
    }
    const model = new Model();
    await new DiaryService(store, clock, model).generate(AGENT, input());
    const prompt = promptOf(model.calls[0]!);
    expect(prompt.historicalStates).toHaveLength(1);
    expect(prompt.historicalStates[0]).toMatchObject({
      sourceMessageId: "user_day",
      before: { moodValence: -0.6 },
      after: { moodValence: -0.7 },
    });
    expect(prompt.historicalStateAvailable).toBe(true);
    expect(JSON.stringify(prompt)).not.toContain("wouldApply");
    expect(prompt).not.toHaveProperty("currentState");
  });

  it("reports no historical affect rather than making one up", async () => {
    const model = new Model();
    await new DiaryService(store, clock, model).generate(AGENT, input());
    expect(promptOf(model.calls[0]!)).toMatchObject({
      historicalStates: [],
      historicalStateAvailable: false,
    });
  });

  it("reads the real validated interaction appraisal and invalidates when its receipt is removed", async () => {
    const time = "2026-09-13T12:00:00.000Z";
    db.prepare("UPDATE messages SET created_at_utc = ? WHERE id = ?").run(
      time,
      "reply_day",
    );
    const character = store.getCharacterSpec(AGENT)!;
    const appraisals = new InteractionAppraisalService(store);
    const appraisal = appraisals.recordForTurn({
      candidate: {
        triggerQuote: "今天聊这个话题让我有些犹豫。",
        feelings: ["discomfort"],
        attitude: "cautious",
        publicExpression: "我明白了",
        privateView: ["need_more_space"],
      },
      character,
      stateBefore: initialRuntimeState(AGENT, time, character),
      userMessageId: "user_day",
      assistantMessageId: "reply_day",
      generatedReplyText: "我明白了，我们可以先停一停。",
      nowUtc: time,
    });
    expect(appraisal).toBeDefined();
    const model = new Model();
    const service = new DiaryService(store, clock, model);
    await service.generate(AGENT, input());
    expect(promptOf(model.calls[0]!).appraisals[0]).toMatchObject({
      feelings: ["discomfort"],
      privateViewText: "我现在需要多一点自己的空间。",
    });
    db.prepare("DELETE FROM domain_events WHERE idempotency_key = ?").run(
      `interaction-appraisal:${appraisal!.id}`,
    );
    expect(service.list(AGENT)[0]?.validity).toBe("source_changed");
  });

  it("invalidates a corrected interpretation even when its raw message text was retained", async () => {
    db.prepare(
      `INSERT INTO memories(id,agent_id,type,content,tags_json,importance,confidence,created_at_utc,status)
      VALUES ('memory_diary',?,'semantic','旧解释','[]',0.6,0.8,?,'active')`,
    ).run(AGENT, NOW);
    db.prepare(
      `INSERT INTO memory_evidence(id,memory_id,source_type,source_id,recorded_at_utc,evidence_json)
      VALUES ('evidence_diary','memory_diary','message','user_day',?,'{}')`,
    ).run(NOW);
    const service = new DiaryService(store, clock, new Model());
    await service.generate(AGENT, input());
    db.prepare(
      "UPDATE memories SET status = 'needs_review' WHERE id = 'memory_diary'",
    ).run();
    expect(service.list(AGENT)[0]?.validity).toBe("source_changed");
  });

  it("replays the same request and original revision after later regeneration", async () => {
    const model = new Model();
    const service = new DiaryService(store, clock, model);
    const original = await service.generate(AGENT, input());
    await service.generate(AGENT, input("revision_2", { expectedRevision: 1 }));
    const restarted = new DiaryService(store, clock, model);
    expect(await restarted.generate(AGENT, input())).toEqual(original);
    expect(model.calls).toHaveLength(2);
    await expect(
      service.generate(AGENT, input("request_1", { entryDate: "2026-09-12" })),
    ).rejects.toMatchObject({ code: "diary_request_conflict" });
    await expect(
      service.generate(AGENT, input("stale", { expectedRevision: 1 })),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "diary_revision_conflict",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM diary_entries").get(),
    ).toEqual({ count: 1 });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM diary_revisions").get(),
    ).toEqual({ count: 2 });
  });

  it("coalesces duplicate in-flight requests and rejects a competing write", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new Model(async () => {
      await blocked;
      return draft();
    });
    const service = new DiaryService(store, clock, model);
    const a = service.generate(AGENT, input());
    const b = service.generate(AGENT, input());
    await expect(
      service.generate(AGENT, input("other_request")),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: "diary_generation_in_progress",
    });
    release();
    expect(await a).toEqual(await b);
    expect(model.calls).toHaveLength(1);
  });

  it.each(["edit", "delete", "new_message"])(
    "fences %s during model generation",
    async (change) => {
      const model = new Model(() => {
        if (change === "edit")
          db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(
            "已更正原话。",
            "user_day",
          );
        else if (change === "delete")
          db.prepare("DELETE FROM messages WHERE id = ?").run("user_day");
        else message("new_day", "user", "补充分享", "2026-09-13T13:00:00.000Z");
        return draft();
      });
      await expect(
        new DiaryService(store, clock, model).generate(AGENT, input()),
      ).rejects.toMatchObject({ code: "diary_source_changed" });
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM diary_revisions").get(),
      ).toEqual({ count: 0 });
    },
  );

  it("marks changed and deleted sources invalid, additions separately, and regeneration restores current status", async () => {
    const model = new Model();
    const service = new DiaryService(store, clock, model);
    await service.generate(AGENT, input());
    message("new_day", "user", "补充分享", "2026-09-13T13:00:00.000Z");
    expect(service.list(AGENT)[0]).toMatchObject({
      validity: "current",
      hasNewMaterial: true,
    });
    db.prepare("UPDATE messages SET content = ? WHERE id = ?").run(
      "更正：那个话题其实已经结束。",
      "user_day",
    );
    expect(service.list(AGENT)[0]).toMatchObject({
      validity: "source_changed",
      hasNewMaterial: true,
    });
    await service.generate(AGENT, input("regenerate", { expectedRevision: 1 }));
    expect(service.list(AGENT)[0]).toMatchObject({
      revision: 2,
      validity: "current",
      hasNewMaterial: false,
    });
    db.prepare("DELETE FROM messages WHERE id = ?").run("new_day");
    expect(service.list(AGENT)[0]).toMatchObject({
      validity: "source_changed",
    });
    expect(service.sources(AGENT, DAY).sources.map((m) => m.id)).not.toContain(
      "new_day",
    );
  });

  it("does not invalidate when identical archives are rebuilt", async () => {
    const service = new DiaryService(store, clock, new Model());
    await service.generate(AGENT, input());
    db.prepare("DELETE FROM message_archive WHERE id = ?").run("user_day");
    expect(service.list(AGENT)[0]?.validity).toBe("current");
    db.prepare(
      `INSERT INTO message_archive(id,session_id,agent_id,role,message_kind,content,source_created_at_utc,indexed_at_utc)
      SELECT id,session_id,agent_id,role,message_kind,content,created_at_utc,created_at_utc FROM messages WHERE id = ?`,
    ).run("user_day");
    expect(service.list(AGENT)[0]?.validity).toBe("current");
    db.prepare("UPDATE message_archive SET content = ? WHERE id = ?").run(
      "冲突档案",
      "user_day",
    );
    expect(service.list(AGENT)[0]?.validity).toBe("source_changed");
  });

  it("keeps a successful version when the provider fails and never replays a failed request", async () => {
    const model = new Model((_call, index) => {
      if (index > 0) throw new Error("provider unavailable");
      return draft();
    });
    const service = new DiaryService(store, clock, model);
    const original = await service.generate(AGENT, input());
    await expect(
      service.generate(AGENT, input("failed", { expectedRevision: 1 })),
    ).rejects.toMatchObject({ code: "diary_generation_failed" });
    await expect(
      new DiaryService(store, clock, model).generate(
        AGENT,
        input("failed", { expectedRevision: 1 }),
      ),
    ).rejects.toMatchObject({ code: "diary_generation_failed" });
    expect(service.list(AGENT)[0]).toEqual(original);
    expect(model.calls).toHaveLength(2);
  });

  it("repairs invalid source IDs once, but rejects a second invalid result", async () => {
    const repair = new Model((_call, index) =>
      draft(index === 0 ? ["reply_day", "unknown_foreign"] : ["user_day"]),
    );
    await new DiaryService(store, clock, repair).generate(AGENT, input());
    expect(repair.calls).toHaveLength(2);
    expect(repair.calls[1]!.prompt).toContain("repair");
    const invalid = new Model(() => draft(["reply_day"]));
    await expect(
      new DiaryService(store, clock, invalid).generate(
        AGENT,
        input("invalid", { expectedRevision: 1 }),
      ),
    ).rejects.toMatchObject({ code: "diary_generation_invalid" });
    expect(invalid.calls).toHaveLength(2);
    expect(new DiaryRepository(store).list(AGENT)[0]?.revision).toBe(1);
  });

  it("rejects nonexistent dates, changed archival timezones and no-material days without an LLM call", async () => {
    const model = new Model();
    const service = new DiaryService(store, clock, model);
    expect(() =>
      service.generate(AGENT, input("bad", { entryDate: "2026-02-30" })),
    ).toThrow(z.ZodError);
    await expect(
      service.generate("agent_other", input()),
    ).rejects.toMatchObject({ code: "diary_no_material" });
    await service.generate(AGENT, input());
    await expect(
      service.generate(
        AGENT,
        input("timezone", { timezone: "UTC", expectedRevision: 1 }),
      ),
    ).rejects.toMatchObject({ code: "diary_timezone_conflict" });
    expect(model.calls).toHaveLength(1);
  });

  it("requires semantic approval even for valid source IDs and reviews the one repaired draft", async () => {
    const rejectedDraft = draft(["user_day"], "我昨晚偷偷去了你家。");
    const reviewIssues = ["第1段虚构了没有来源的角色行动：去了你家。"];
    const model = new Model(
      (_call, index) => (index === 0 ? rejectedDraft : draft()),
      (_call, index) =>
        index === 0
          ? {
              valid: false,
              issues: reviewIssues,
            }
          : { valid: true, issues: [] },
    );
    const entry = await new DiaryService(store, clock, model).generate(
      AGENT,
      input(),
    );
    expect(entry.body).not.toContain("去了你家");
    expect(model.calls).toHaveLength(2);
    expect(model.reviewCalls).toHaveLength(2);
    expect(JSON.parse(model.calls[1]!.prompt) as unknown).toMatchObject({
      repair: {
        draftToRepair: rejectedDraft,
        issues: reviewIssues,
      },
    });
    expect(model.calls[1]!.prompt).toContain("保留未受影响的段落与角色观点");
    expect(model.calls.every((call) => call.maxRetries === 0)).toBe(true);
  });

  it("rejects twice-failed semantic review without storing either unsupported diary", async () => {
    const model = new Model(
      () => draft(["user_day"], "我当时一直暗中讨厌你。"),
      () => ({
        valid: false,
        issues: ["第1段把未经记录的过去隐秘反应写成确定事实。"],
      }),
    );
    await expect(
      new DiaryService(store, clock, model).generate(AGENT, input()),
    ).rejects.toMatchObject({ code: "diary_generation_invalid" });
    expect(model.calls).toHaveLength(2);
    expect(model.reviewCalls).toHaveLength(2);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM diary_revisions").get(),
    ).toEqual({ count: 0 });
  });

  it.each(["provider_failure", "malformed_review"])(
    "preserves the old version after %s without blind regeneration",
    async (failure) => {
      const model = new Model(
        () => draft(),
        (_call, index) => {
          if (index === 0) return { valid: true, issues: [] };
          if (failure === "provider_failure")
            throw new Error("review unavailable");
          return { valid: true, issues: ["自相矛盾的审稿"] };
        },
      );
      const service = new DiaryService(store, clock, model);
      const original = await service.generate(AGENT, input());
      await expect(
        service.generate(
          AGENT,
          input("review_failure", { expectedRevision: 1 }),
        ),
      ).rejects.toMatchObject({ code: "diary_review_failed" });
      expect(model.calls).toHaveLength(2);
      expect(model.reviewCalls).toHaveLength(2);
      expect(service.list(AGENT)[0]).toEqual(original);
    },
  );

  it("exposes scoped HTTP reads and validates calendar filters and regeneration conflicts", async () => {
    const app = Fastify();
    const service = new DiaryService(store, clock, new Model());
    app.setErrorHandler((error, _request, reply) => {
      const status =
        error instanceof ApiError
          ? error.statusCode
          : error instanceof z.ZodError
            ? 400
            : 500;
      return reply.status(status).send({
        error: {
          code: error instanceof ApiError ? error.code : "validation_error",
        },
      });
    });
    registerDiaryRoutes(app, service);
    await app.ready();
    try {
      const url = `/api/agents/${AGENT}/diaries`;
      expect(
        (await app.inject({ method: "POST", url, payload: input() }))
          .statusCode,
      ).toBe(200);
      expect(
        (await app.inject({ url: `${url}?month=2026-09` })).json<{
          entries: unknown[];
        }>().entries,
      ).toHaveLength(1);
      expect(
        (await app.inject({ url: "/api/agents/agent_other/diaries" })).json<{
          entries: unknown[];
        }>().entries,
      ).toEqual([]);
      expect(
        (
          await app.inject({ url: "/api/diaries/volumes?year=2026&month=9" })
        ).json<{ volumes: unknown[] }>().volumes,
      ).toHaveLength(1);
      expect(
        (await app.inject({ url: "/api/diaries/volumes?month=13" })).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ url: "/api/diaries/volumes?year=-1" })).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ url: `${url}?month=2026-13` })).statusCode,
      ).toBe(400);
      expect(
        (await app.inject({ method: "POST", url, payload: input("conflict") }))
          .statusCode,
      ).toBe(409);
      expect(
        (await app.inject({ url: `${url}/${DAY}/sources` })).json<{
          sources: unknown[];
        }>().sources,
      ).toHaveLength(2);
      expect(
        (
          await app.inject({
            url: `/api/agents/agent_other/diaries/${DAY}/sources`,
          })
        ).statusCode,
      ).toBe(404);
    } finally {
      await app.close();
    }
  });
});
