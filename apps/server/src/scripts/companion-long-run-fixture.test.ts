import {
  CharacterCompilationProposalSchema,
  PersonaChatResponseSchema,
  TurnObservationProposalSchema,
  type PersonaChatResponse,
  type TurnObservationProposal,
} from "@personasim/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type Database } from "../db/connection.js";
import { runMigrations } from "../db/migrations.js";
import { DatabaseStore } from "../db/store.js";
import {
  getCompanionLongRunTurn,
  materializeCompanionLongRunTurn,
} from "../scenarios/companion-long-run-manifest.js";
import {
  COMPANION_LONG_RUN_TURN_PROFILES,
  type CompanionLongRunTurnCount,
} from "../scenarios/companion-long-run-profiles.js";
import type { MaterializedCompanionTurnSpec } from "../scenarios/companion-long-run-types.js";
import { FakeClock } from "../runtime/clock.js";
import { LlmService } from "../services/llm-service.js";
import {
  installCompanionLongRunFixtureLlm,
  type CompanionLongRunFixtureController,
} from "./companion-long-run-fixture.js";

const TEMPLATE_VALUES = {
  "sharedSlotA.localLabel": "2026 年 9 月 21 日 15:00",
  "sharedSlotA.durationMinutes": 45,
  "sharedSlotB.localLabel": "2026 年 9 月 22 日 10:00",
  "sharedSlotB.durationMinutes": 60,
} as const;

interface Harness {
  database: Database;
  store: DatabaseStore;
  llm: LlmService;
  controller: CompanionLongRunFixtureController;
}

const harnesses: Harness[] = [];

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.controller.restore();
    harness.database.close();
  }
});

describe("companion long-run fixture controller", () => {
  it("emits grounded memory correction and care proposals", async () => {
    const harness = createHarness();

    const anchor = await understand(harness, materializedTurn(11));
    expect(anchor.route).toBe("explicit_memory");
    expect(anchor.worldEffects.memoryCandidates).toEqual([
      expect.objectContaining({
        type: "user_fact",
        content:
          "重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827",
        evidenceQuotes: [
          "重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827",
        ],
      }),
    ]);

    const correction = await understand(harness, materializedTurn(17));
    expect(correction.worldEffects.memoryCandidates).toEqual([
      expect.objectContaining({
        type: "user_preference",
        content: "我可以接受少量香菜，但不喜欢整把香菜",
        evidenceQuotes: ["我可以接受少量香菜，但不喜欢整把香菜"],
      }),
    ]);

    const care = await understand(harness, materializedTurn(21));
    const continuity = asRecord(care.worldEffects.continuityEffects);
    expect(continuity["careCueCandidates"]).toEqual([
      expect.objectContaining({
        cueType: "listen_first_public_talk_anxiety",
        evidenceQuotes: [
          "下周四我要做一次公开分享，现在有点紧张",
          "这一刻我只想被听见，不要马上给建议",
        ],
      }),
    ]);

    expect(
      harness.store.listLlmCalls(10).map((call) => call["purpose"]),
    ).toEqual([
      "turn_understanding",
      "turn_understanding",
      "turn_understanding",
    ]);
  });

  it("emits absolute, grounded A/B schedule proposals and safe counterexamples", async () => {
    const harness = createHarness();

    const slotA = await understand(harness, materializedTurn(31));
    expect(slotA.route).toBe("schedule_mutation");
    expect(slotA.scheduleIntent).toEqual({
      kind: "create_shared_activity",
      activityQuote: { text: "去梧桐路 23 号的“北岸书店”喝茶" },
      timeQuote: { text: "2026 年 9 月 21 日 15:00" },
      participantQuote: { text: "和你一起" },
      durationMinutes: 45,
      missingFields: [],
    });

    const slotB = await understand(harness, materializedTurn(40));
    expect(slotB.scheduleIntent).toEqual({
      kind: "create_shared_activity",
      activityQuote: { text: "世纪公园" },
      timeQuote: { text: "2026 年 9 月 22 日 10:00" },
      participantQuote: { text: "我" },
      durationMinutes: 60,
      missingFields: [],
    });

    const quoted = await understand(harness, materializedTurn(35));
    expect(quoted.route).toBe("ambiguous");
    expect(quoted.dialogueActs).toContain("quote");
    expect(quoted.scheduleIntent).toMatchObject({ kind: "ambiguous" });
    expect(quoted.worldEffects.memoryCandidates).toBeUndefined();

    const unsupported = await understand(harness, materializedTurn(43));
    expect(unsupported.scheduleIntent).toMatchObject({
      kind: "unsupported_mutation",
      operation: "reschedule",
    });
  });

  it("returns natural mutation-free replies for anchors, care, boundaries, goals and abstention", async () => {
    const harness = createHarness();
    const cases = [
      {
        turn: 76,
        anchors: ["LPM-4827", "墨绿色珐琅松针", "深灰色电脑包", "内侧拉链袋"],
      },
      { turn: 26, anchors: ["安慰", "建议"] },
      { turn: 58, anchors: ["啰嗦", "受挫"] },
      { turn: 59, anchors: ["道歉", "放下"] },
      { turn: 60, anchors: ["不能替你决定"] },
      { turn: 62, anchors: ["不想聊", "停", "不再"] },
      { turn: 68, anchors: ["城市夜归人"] },
      { turn: 95, anchors: ["不知道"] },
    ] as const;

    for (const item of cases) {
      const reply = await generateReply(harness, materializedTurn(item.turn));
      for (const anchor of item.anchors) expect(reply.text).toContain(anchor);
      expect(Object.keys(reply).sort()).toEqual([
        "chunks",
        "deliveryMode",
        "text",
        "toneTags",
      ]);
      expect(reply).not.toHaveProperty("scheduleAction");
      expect(reply).not.toHaveProperty("scheduleEffects");
      expect(reply).not.toHaveProperty("memoryCandidates");
      expect(reply.chunks).toEqual([reply.text]);
    }
  });

  it("aligns schedule language with the authoritative outcome while preserving required anchors", async () => {
    const harness = createHarness();
    const turn = materializedTurn(33);
    const prompt = promptWithOutcome({
      scheduleOutcome: { kind: "committed" },
      replyDirectives: {
        authoritativeFacts: [
          {
            kind: "schedule",
            text: "北岸书店喝茶，2026 年 9 月 21 日 15:00，45 分钟",
          },
        ],
        presentationText: "北岸书店喝茶，2026 年 9 月 21 日 15:00，45 分钟",
      },
    });
    const reply = await generateReply(harness, turn, prompt);

    expect(reply.text).toContain("已经确认并加入日程");
    for (const anchor of turn.expected.requiredAnchors ?? []) {
      expect(reply.text).toContain(anchor);
    }

    const combined = await generateReply(
      harness,
      materializedTurn(99),
      promptWithOutcome({
        scheduleOutcome: { kind: "read_only" },
        replyDirectives: {
          authoritativeFacts: [
            {
              kind: "schedule",
              text: "北岸书店喝茶，2026 年 9 月 21 日 15:00，45 分钟",
            },
          ],
        },
      }),
    );
    expect(combined.text).toContain("我会先听你说");
    expect(combined.text).toContain("安慰还是建议");
  });

  it.each([20, 30, 100] as const)(
    "builds the profile %i turn-100 summary from its retrieved relation evidence",
    async (count) => {
      const harness = createHarness();
      const corrected = profileIncludesTurn(count, 89);
      const reply = await generateReply(
        harness,
        materializedTurn(100),
        summaryPrompt(count),
      );

      expect(reply.text).toContain("LPM-4827");
      expect(reply.text).toContain("少量香菜");
      expect(reply.text).toContain("不喜欢整把香菜");
      expect(reply.text).toContain(corrected ? "高中同学" : "大学同学");
      if (corrected) {
        expect(reply.text).toContain("不是你的大学同学");
        expect(reply.text).not.toContain("小林是你的大学同学");
      } else {
        expect(reply.text).not.toContain("高中同学");
      }
      expect(reply.text).not.toMatch(/豆包|养狗|狗狗|宠物|宿舍号/u);
      expect(sentenceCount(reply.text)).toBe(3);
    },
  );

  it("leaves unrelated fixture purposes untouched and restores the service", async () => {
    const harness = createHarness();
    harness.controller.setActiveTurn(materializedTurn(11));

    const compiled = await harness.llm.generateObject({
      purpose: "compile_character",
      system: "system",
      prompt: "prompt",
      schema: CharacterCompilationProposalSchema,
    });
    expect(compiled.draft.identity.name).toBe("林澈");
    expect(harness.store.listLlmCalls(10).at(-1)?.["purpose"]).toBe(
      "compile_character",
    );

    harness.controller.restore();
    expect(() =>
      harness.controller.setActiveTurn(materializedTurn(12)),
    ).toThrow(/restored/);

    const defaultObservation = await harness.llm.generateObject({
      purpose: "turn_understanding",
      system: "system",
      prompt: 'CURRENT_USER_MESSAGE_JSON\n{"content":"普通测试消息"}',
      schema: TurnObservationProposalSchema,
    });
    expect(defaultObservation.topics).toEqual([]);
  });
});

function createHarness(): Harness {
  const database = openDatabase(":memory:");
  runMigrations(database);
  const store = new DatabaseStore(database);
  const llm = new LlmService(
    {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
    store,
    new FakeClock("2026-08-23T04:00:00.000Z"),
  );
  const harness = {
    database,
    store,
    llm,
    controller: installCompanionLongRunFixtureLlm(llm),
  };
  harnesses.push(harness);
  return harness;
}

function materializedTurn(number: number): MaterializedCompanionTurnSpec {
  return materializeCompanionLongRunTurn(
    getCompanionLongRunTurn(number),
    TEMPLATE_VALUES,
  );
}

async function understand(
  harness: Harness,
  turn: MaterializedCompanionTurnSpec,
): Promise<TurnObservationProposal> {
  harness.controller.setActiveTurn(turn);
  return harness.llm.generateObject({
    purpose: "turn_understanding",
    system: "system",
    prompt: "prompt",
    schema: TurnObservationProposalSchema,
  });
}

async function generateReply(
  harness: Harness,
  turn: MaterializedCompanionTurnSpec,
  prompt = promptWithOutcome({
    scheduleOutcome: { kind: "none" },
    replyDirectives: { authoritativeFacts: [] },
  }),
): Promise<PersonaChatResponse> {
  harness.controller.setActiveTurn(turn);
  return harness.llm.generateObject({
    purpose: "reply_generation",
    system: "system",
    prompt,
    schema: PersonaChatResponseSchema,
  });
}

function promptWithOutcome(outcome: Record<string, unknown>): string {
  return "VALIDATED_TURN_OUTCOME_JSON\n" + JSON.stringify(outcome);
}

function summaryPrompt(count: CompanionLongRunTurnCount): string {
  const corrected = profileIncludesTurn(count, 89);
  const relation = corrected
    ? "小林不是我的大学同学，是我高中同学。她搬到苏州这件事没变"
    : "我大学同学叫小林，她最近刚搬到苏州";
  const contents = [
    "重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827",
    "我可以接受少量香菜，但不喜欢整把香菜",
    relation,
  ];
  return [
    "RETRIEVED_EVIDENCE_JSON",
    JSON.stringify({
      evidence: contents.map((memoryContent, index) => ({
        memoryContent,
        namespace: "user_model",
        certainty: "explicit",
        attribution: "user_explicit",
        evidence: { quote: memoryContent, id: `evidence-${String(index)}` },
      })),
    }),
    promptWithOutcome({
      scheduleOutcome: { kind: "none" },
      replyDirectives: { authoritativeFacts: [] },
    }),
  ].join("\n");
}

function profileIncludesTurn(
  count: CompanionLongRunTurnCount,
  turnNumber: number,
): boolean {
  return (
    COMPANION_LONG_RUN_TURN_PROFILES[count] as readonly number[]
  ).includes(turnNumber);
}

function sentenceCount(text: string): number {
  return text
    .split(/[。！？!?]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
