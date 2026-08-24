import type { TurnObservationProposal } from "@personasim/contracts";
import { findFreeSlots, validateWorldEffects } from "@personasim/features";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, type PersonaSimApp } from "../app.js";
import {
  CONTEXT_PLAN_SERVICE_TOKEN,
  REPLY_GENERATION_SERVICE_TOKEN,
  REPLY_REPAIR_SERVICE_TOKEN,
  TURN_EXECUTION_SERVICE_TOKEN,
  TURN_UNDERSTANDING_SERVICE_TOKEN,
} from "../composition/service-tokens.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { FakeClock } from "../runtime/clock.js";
import type { ChatTurnResult } from "./conversation-service.js";
import type { GenerateObjectInput, LlmService } from "./llm-service.js";
import { recallAgentMemories } from "./memory-recall-service.js";
import type { ValidatedTurnOutcome } from "./turn-execution-service.js";

const START_UTC = "2026-08-16T02:00:00.000Z"; // 10:00 Asia/Shanghai
const DIRECT_OFFER = "明天早上七点和我一起去跑步半小时";

describe("split turn pipeline semantic regressions", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (app) await app.close();
    app = undefined;
  });

  it("isolates an explicit memory/care request from every schedule writer", async () => {
    const harness = await createHarness();
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return observation({
          route: "explicit_memory",
          dialogueActs: ["request_memory"],
          topicKey: "CARE-ALPHA",
          topicDomain: "care_preference",
          topicQuote: "CARE-ALPHA",
          salientQuotes: ["CARE-ALPHA", "先听我说完"],
        });
      }
      if (input.purpose === "reply_generation") {
        return {
          text: "CARE-ALPHA 和“先听我说完”这两个重点，我都听到了。",
          toneTags: ["温和"],
        };
      }
      return fixtureOrThrow(input);
    });
    const beforeSchedule = app.personasim.store.listSchedule(harness.agentId);
    const clientMessageId = "split-memory-care-a";

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      "请记住，事实标识符是 CARE-ALPHA；我难过时请先听我说完，别急着给建议。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.scheduleChanges).toEqual([]);
    expect(app.personasim.store.listSchedule(harness.agentId)).toEqual(
      beforeSchedule,
    );
    expect(scheduleEventsFor(app, harness.agentId, clientMessageId)).toEqual(
      [],
    );
    expect(body.decision.reasonCode).not.toMatch(/^schedule_negotiation_/u);
    expect(body.assistantMessage.content).not.toMatch(
      /未修改日程|结构化日程动作|日程保持不变/u,
    );
    expect(body.assistantMessage.content).toMatch(/CARE-ALPHA|先听我说完/u);
    expect(body.assistantMessage.metadata).toMatchObject({
      turnPipelineMode: "enforced",
      turnRoute: "explicit_memory",
      understandingOrigin: "model_valid",
      replyMutationAuthorization: "disabled",
    });
    expect(purposeCount(calls, "turn_understanding")).toBe(1);
    expect(purposeCount(calls, "reply_generation")).toBe(1);
    expect(purposeCount(calls, "chat_turn")).toBe(0);
  });

  it("answers the exact just-settled activity instead of a different goal activity that starts immediately", async () => {
    const harness = await createHarness();
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const store = app.personasim.store;
    const schedule = store.listSchedule(harness.agentId);
    const finishedBase = schedule[0];
    const currentBase = schedule[1];
    if (finishedBase === undefined || currentBase === undefined) {
      throw new Error("Expected at least two generated schedule items.");
    }
    const now = DateTime.fromISO(START_UTC);
    const finished = {
      ...finishedBase,
      title: "早晨创作时间",
      startAtUtc: now.minus({ minutes: 75 }).toUTC().toISO()!,
      endAtUtc: now.minus({ minutes: 15 }).toUTC().toISO()!,
      status: "completed" as const,
      revision: finishedBase.revision + 1,
      updatedAtUtc: START_UTC,
    };
    const current = {
      ...currentBase,
      title: "一部关于城市夜归人的纪录短片",
      startAtUtc: START_UTC,
      endAtUtc: now.plus({ minutes: 60 }).toUTC().toISO()!,
      status: "in_progress" as const,
      revision: currentBase.revision + 1,
      updatedAtUtc: START_UTC,
    };
    for (const item of schedule) {
      if (item.id === finished.id || item.id === current.id) continue;
      if (item.startAtUtc <= START_UTC && item.endAtUtc > START_UTC) {
        store.updateScheduleItem({
          ...item,
          status: "cancelled",
          revision: item.revision + 1,
          updatedAtUtc: START_UTC,
        });
      }
    }
    store.updateScheduleItem(finished);
    store.updateScheduleItem(current);
    expect(
      store.insertActivityEvent({
        id: "activity-finished-authoritative",
        agentId: harness.agentId,
        scheduleItemId: finished.id,
        eventType: "completed",
        occurredAtUtc: finished.endAtUtc,
        summary: "完成了早晨创作时间",
        outcomeFacts: ["早晨创作时间已经完成"],
        stateDelta: {},
        origin: "deterministic",
        idempotencyKey: "test:activity-finished-authoritative",
      }),
    ).toBe(true);
    expect(
      store.insertActivityEvent({
        id: "activity-current-started",
        agentId: harness.agentId,
        scheduleItemId: current.id,
        eventType: "started",
        occurredAtUtc: START_UTC,
        summary: "开始了一部关于城市夜归人的纪录短片",
        outcomeFacts: [],
        stateDelta: {},
        origin: "deterministic",
        idempotencyKey: "test:activity-current-started",
      }),
    ).toBe(true);
    const state = store.getRuntimeState(harness.agentId);
    if (state === undefined) throw new Error("Expected runtime state.");
    store.updateRuntimeState({
      ...state,
      asOfUtc: START_UTC,
      currentActivityId: current.id,
      revision: state.revision + 1,
    });

    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return observation({
          route: "conversation",
          topicKey: "当前活动状态",
          topicDomain: "daily_state",
          salientQuotes: ["刚才那项活动结束了吗？"],
        });
      }
      if (input.purpose === "reply_generation") {
        return {
          text: "夜归人那部纪录短片还没结束，我刚坐下准备继续做。",
        };
      }
      if (input.purpose === "repair_chat_turn") {
        throw new Error("force deterministic authoritative fallback");
      }
      return fixtureOrThrow(input);
    });

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "recent-settled-activity-conflict",
      "刚才那项活动结束了吗？",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toContain("早晨创作时间");
    expect(body.assistantMessage.content).toContain("已经结束");
    expect(body.assistantMessage.content).toContain("已完成");
    expect(body.assistantMessage.content).not.toMatch(/还没结束|未结束/u);
    expect(body.assistantMessage.metadata).toMatchObject({
      turnRoute: "conversation",
      repairAttempted: true,
      usedFallback: true,
    });
    const replyCall = calls.find(
      (input) => input.purpose === "reply_generation",
    );
    expect(replyCall?.prompt).toContain("早晨创作时间");
    expect(replyCall?.prompt).toContain('"activityEventType":"completed"');
    expect(replyCall?.prompt).not.toContain(current.title);
    expect(purposeCount(calls, "reply_generation")).toBe(1);
    expect(purposeCount(calls, "repair_chat_turn")).toBe(1);
  });

  it("audits accepted shadow world effects without applying state or memory writes", async () => {
    const harness = await createHarness("shadow");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return worldEffectObservation("SHADOW-WORLD-EFFECT");
      }
      if (input.purpose === "reply_generation") {
        return { text: "听起来你今天确实有点累，我们可以慢一点聊。" };
      }
      return fixtureOrThrow(input);
    });
    const stateBefore = app.personasim.store.getRuntimeState(harness.agentId);
    const memoryCountBefore = app.personasim.store.tableCounts()["memories"];
    const clientMessageId = "shadow-world-effect-audit";

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      "今天感觉有点累，代号是 SHADOW-WORLD-EFFECT。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.state).toEqual(stateBefore);
    expect(app.personasim.store.getRuntimeState(harness.agentId)).toEqual(
      stateBefore,
    );
    expect(app.personasim.store.tableCounts()["memories"]).toBe(
      memoryCountBefore,
    );
    expect(body.assistantMessage.metadata["worldEffectsMode"]).toBe("shadow");
    expect(body.assistantMessage.metadata["worldEffectsWritesEnabled"]).toBe(
      false,
    );
    expect(body.assistantMessage.metadata["worldEffectsApplied"]).toBe(false);
    expect(body.assistantMessage.metadata["acceptedEffectKinds"]).toEqual([
      "state_delta",
    ]);
    expect(
      eventFor(
        app,
        harness.agentId,
        clientMessageId,
        "conversation.world_effects_shadow_evaluated",
      )?.payload,
    ).toMatchObject({
      mode: "shadow",
      writesEnabled: false,
      applied: false,
      accepted: {
        stateDelta: true,
        memoryCandidateCount: 0,
      },
    });
    expect(
      eventFor(
        app,
        harness.agentId,
        clientMessageId,
        "conversation.world_effects_committed",
      ),
    ).toBeUndefined();
  });

  it("persists every preflight-authorized memory and audits only the grounded candidate", async () => {
    const harness = await createHarness("enforced");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return observation({
          route: "explicit_memory",
          dialogueActs: ["request_memory"],
          salientQuotes: ["我喜欢茉莉花茶"],
          worldEffects: {
            memoryCandidates: [
              { type: "user_preference", content: "用户喜欢茉莉花茶" },
              { type: "user_fact", content: "用户养了一只叫月亮的猫" },
            ],
          },
        });
      }
      if (input.purpose === "reply_generation") {
        return { text: "茉莉花茶，听起来很清爽。" };
      }
      return fixtureOrThrow(input);
    });
    const memoriesBefore = memoryCount(app, harness.agentId);
    const clientMessageId = "grounded-memory-authority";

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      "请记住，我喜欢茉莉花茶。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(memoryCount(app, harness.agentId)).toBe(memoriesBefore + 1);
    expect(body.assistantMessage.metadata).toMatchObject({
      acceptedEffectKinds: ["memory_candidate"],
      acceptedEffectCount: 1,
      worldEffectsApplied: true,
      proposalRejectionCodes: ["ungrounded_memory_candidate"],
    });
    expect(
      eventFor(
        app,
        harness.agentId,
        clientMessageId,
        "conversation.world_effects_committed",
      )?.payload,
    ).toMatchObject({
      applied: true,
      accepted: { memoryCandidateCount: 1 },
      rejectionCodes: ["ungrounded_memory_candidate"],
    });
    expect(
      eventFor(
        app,
        harness.agentId,
        clientMessageId,
        "conversation.turn_committed",
      )?.payload,
    ).toMatchObject({
      memoryIds: [expect.any(String)],
      acceptedEffectKinds: ["memory_candidate"],
      worldEffectsApplied: true,
    });
  });

  it("persists the exact explicit source when DeepSeek returns only unrelated memory candidates", async () => {
    const harness = await createHarness("enforced");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const userText =
      "我只告诉很信任的人一个习惯：每次重要演讲前，我都会把一枚蓝色玻璃鲸放在左口袋，它的代号是 BGW-7419。最近想到博士资格面谈就有些紧张。另请记住我的关怀方式偏好：只要我谈到这场面谈，先问我现在更需要安慰还是建议，不要马上讲道理。";
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return observation({
          route: "explicit_memory",
          dialogueActs: ["request_memory"],
          salientQuotes: ["蓝色玻璃鲸", "左口袋", "BGW-7419"],
          worldEffects: {
            memoryCandidates: [
              { type: "user_fact", content: "用户喜欢茉莉花茶" },
              { type: "user_fact", content: "用户住在苏州" },
              { type: "user_preference", content: "用户习惯早晨跑步" },
            ],
          },
        });
      }
      if (input.purpose === "reply_generation") {
        return { text: "蓝色玻璃鲸、左口袋和 BGW-7419，我都听清了。" };
      }
      return fixtureOrThrow(input);
    });
    const memoriesBefore = memoryCount(app, harness.agentId);
    const clientMessageId = "deepseek-explicit-source-fallback";

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      userText,
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(memoryCount(app, harness.agentId)).toBe(memoriesBefore + 1);
    const memory = app.personasim.store.database
      .prepare(
        `SELECT id, content, namespace, certainty, attribution, stability,
                source_message_id AS sourceMessageId
         FROM memories
         WHERE agent_id = ? AND content LIKE '%BGW-7419%'
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get(harness.agentId) as
      | {
          id: string;
          content: string;
          namespace: string;
          certainty: string;
          attribution: string;
          stability: string;
          sourceMessageId: string;
        }
      | undefined;
    expect(memory).toMatchObject({
      content: userText,
      namespace: "user_model",
      certainty: "explicit",
      attribution: "user_explicit",
      stability: "stable",
      sourceMessageId: body.userMessage.id,
    });
    expect(memory?.content).toContain("蓝色玻璃鲸");
    expect(memory?.content).toContain("左口袋");
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT source_type AS sourceType, source_id AS sourceId, quote
           FROM memory_evidence
           WHERE memory_id = ?`,
        )
        .get(memory?.id),
    ).toMatchObject({
      sourceType: "message",
      sourceId: body.userMessage.id,
      quote: userText,
    });
    expect(body.assistantMessage.metadata).toMatchObject({
      acceptedEffectKinds: ["memory_candidate"],
      acceptedEffectCount: 1,
      worldEffectsApplied: true,
      proposalRejectionCodes: ["ungrounded_memory_candidate"],
    });
    expect(
      eventFor(
        app,
        harness.agentId,
        clientMessageId,
        "conversation.world_effects_committed",
      )?.payload,
    ).toMatchObject({
      accepted: { memoryCandidateCount: 1 },
      persisted: { memoryCount: 1 },
    });
  });

  it.each([
    {
      label: "LPM asserted fact",
      userText:
        "我只告诉很信任的人一件小事：重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827。请只按我说的内容记，不要补充。",
      salientQuotes: ["墨绿色珐琅松针", "LPM-4827"],
      drifted: "用户会在重要发言前随身携带一枚松针纪念物",
      reply: "墨绿色珐琅松针和 LPM-4827，我听清了。",
      lookup: "%LPM-4827%",
    },
    {
      label: "Xiaolin asserted fact",
      userText: "我大学同学叫小林，她最近刚搬到苏州。",
      salientQuotes: ["大学同学叫小林", "搬到苏州"],
      drifted: "用户的大学同学小林最近迁居苏州",
      reply: "原来小林是你的大学同学，她最近搬到了苏州。",
      lookup: "%小林%",
    },
  ])(
    "persists the exact authoritative $label on a model-valid conversation turn",
    async ({ userText, salientQuotes, drifted, reply, lookup }) => {
      const harness = await createHarness("enforced");
      app = harness.app;
      const sessionId = createSession(app, harness.agentId);
      const calls: Array<GenerateObjectInput<unknown>> = [];
      mockSplitLlm(app.personasim.llm, calls, (input) => {
        if (input.purpose === "turn_understanding") {
          return observation({
            route: "conversation",
            salientQuotes,
            worldEffects: {
              memoryCandidates: [
                { type: "user_fact", content: drifted },
                {
                  type: "user_fact",
                  content: `${drifted}，而且用户已经结婚`,
                },
              ],
            },
          });
        }
        if (input.purpose === "reply_generation") return { text: reply };
        return fixtureOrThrow(input);
      });
      const memoriesBefore = memoryCount(app, harness.agentId);

      const response = await sendMessage(
        app,
        sessionId,
        harness.agentId,
        `conversation-source-fallback-${lookup.includes("LPM") ? "lpm" : "xiaolin"}`,
        userText,
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(memoryCount(app, harness.agentId)).toBe(memoriesBefore + 1);
      expect(
        app.personasim.store.database
          .prepare(
            `SELECT content, source_message_id AS sourceMessageId
             FROM memories
             WHERE agent_id = ? AND content LIKE ?
             ORDER BY rowid DESC
             LIMIT 1`,
          )
          .get(harness.agentId, lookup),
      ).toMatchObject({
        content: userText,
        sourceMessageId: body.userMessage.id,
      });
      expect(body.assistantMessage.metadata).toMatchObject({
        acceptedEffectKinds: ["memory_candidate"],
        acceptedEffectCount: 1,
        worldEffectsApplied: true,
        proposalRejectionCodes: ["ungrounded_memory_candidate"],
      });
      expect(
        app.personasim.store.database
          .prepare(
            `SELECT COUNT(*) AS count
             FROM memories
             WHERE agent_id = ? AND content LIKE '%已经结婚%'`,
          )
          .get(harness.agentId),
      ).toMatchObject({ count: 0 });
    },
  );

  it("persists only the active correction, supersedes the old cilantro claim, and recalls only new evidence", async () => {
    const harness = await createHarness("enforced");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const correction =
      "我纠正一下：前面说“我不吃香菜”太绝对了。准确说法是，我可以接受少量香菜，但不喜欢整把香菜。";
    const active = "我可以接受少量香菜，但不喜欢整把香菜。";
    let understandingTurn = 0;
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        const turn = understandingTurn;
        understandingTurn += 1;
        return turn === 0
          ? observation({
              route: "conversation",
              salientQuotes: ["我通常不吃香菜"],
              worldEffects: {
                memoryCandidates: [
                  {
                    type: "user_preference",
                    content: "用户通常不吃香菜",
                  },
                ],
              },
            })
          : observation({
              route: "conversation",
              salientQuotes: [active],
              worldEffects: {
                memoryCandidates: [
                  { type: "user_preference", content: "用户从不吃香菜" },
                ],
              },
            });
      }
      if (input.purpose === "reply_generation") {
        return {
          text:
            understandingTurn === 1
              ? "原来你通常不吃香菜。"
              : "明白，少量香菜可以接受，整把香菜不喜欢。",
        };
      }
      return fixtureOrThrow(input);
    });

    const originalResponse = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "cilantro-original",
      "我通常不吃香菜。",
    );
    expect(originalResponse.statusCode).toBe(201);
    const original = app.personasim.store.database
      .prepare(
        `SELECT id, content, status
         FROM memories
         WHERE agent_id = ? AND content LIKE '%不吃香菜%'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(harness.agentId) as
      { id: string; content: string; status: string } | undefined;
    expect(original).toMatchObject({
      content: "用户通常不吃香菜",
      status: "active",
    });

    const correctionResponse = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "cilantro-correction",
      correction,
    );
    expect(correctionResponse.statusCode).toBe(201);
    const corrected = app.personasim.store.database
      .prepare(
        `SELECT id, content, status
         FROM memories
         WHERE agent_id = ? AND content = ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(harness.agentId, active) as
      { id: string; content: string; status: string } | undefined;
    expect(corrected).toMatchObject({ content: active, status: "active" });
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT status, superseded_by_id AS supersededById
           FROM memories WHERE id = ?`,
        )
        .get(original?.id),
    ).toEqual({ status: "superseded", supersededById: corrected?.id });
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT quote FROM memory_evidence
           WHERE memory_id = ? AND source_type = 'message'`,
        )
        .get(corrected?.id),
    ).toEqual({ quote: active });

    const recall = recallAgentMemories(app.personasim.store, {
      agentId: harness.agentId,
      query: {
        query: "我对香菜的准确偏好是什么？",
        minimumScore: 0,
        purpose: "user_fact_query",
      },
      nowUtc: START_UTC,
    });
    expect(recall).toMatchObject({ abstained: false });
    expect(recall.selectedMemoryIds).toEqual([corrected?.id]);
    if (!recall.abstained) {
      expect(recall.evidenceBundle.evidence).toHaveLength(1);
      expect(recall.evidenceBundle.evidence[0]).toMatchObject({
        memoryContent: active,
      });
      expect(recall.evidenceBundle.evidence[0]?.evidence.quote).toBe(active);
      expect(JSON.stringify(recall.evidenceBundle)).not.toContain("我不吃香菜");
    }
  });

  it("persists a bounded direct-contrast correction and recalls only its affirmative projection", async () => {
    const harness = await createHarness("enforced");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    const originalSource = "我大学同学叫小林，她最近刚搬到苏州。";
    const correctionSource =
      "我纠正一下：小林不是我的大学同学，是我高中同学。她搬到苏州这件事没变。";
    const canonicalCorrection = "小林是我高中同学。她搬到苏州。";
    let understandingTurn = 0;
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        const turn = understandingTurn;
        understandingTurn += 1;
        return turn === 0
          ? observation({
              route: "conversation",
              salientQuotes: [originalSource],
              worldEffects: {
                memoryCandidates: [
                  {
                    type: "user_fact",
                    content: "我大学同学叫小林，她最近刚搬到苏州",
                  },
                ],
              },
            })
          : observation({
              route: "conversation",
              salientQuotes: [correctionSource],
              worldEffects: {
                memoryCandidates: [
                  {
                    type: "user_fact",
                    content:
                      "小林不是我的大学同学，是我高中同学。她搬到苏州这件事没变",
                  },
                ],
              },
            });
      }
      if (input.purpose === "reply_generation") {
        return {
          text:
            understandingTurn === 1
              ? "原来小林是你的大学同学，她最近搬到了苏州。"
              : "明白，小林是你的高中同学，她搬到苏州这点没变。",
        };
      }
      return fixtureOrThrow(input);
    });

    const originalResponse = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "xiaolin-original",
      originalSource,
    );
    expect(originalResponse.statusCode).toBe(201);
    const original = app.personasim.store.database
      .prepare(
        `SELECT id, content, status
         FROM memories
         WHERE agent_id = ? AND content LIKE '%大学同学%小林%'
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(harness.agentId) as
      { id: string; content: string; status: string } | undefined;
    expect(original).toMatchObject({ status: "active" });

    const correctionResponse = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "xiaolin-direct-contrast-correction",
      correctionSource,
    );
    expect(correctionResponse.statusCode).toBe(201);
    const correctionBody = jsonBody<ChatTurnResult>(correctionResponse);
    expect(correctionBody.assistantMessage.metadata).toMatchObject({
      acceptedEffectKinds: ["memory_candidate"],
      proposalRejectionCodes: ["ungrounded_memory_candidate"],
      worldEffectsApplied: true,
    });
    const corrected = app.personasim.store.database
      .prepare(
        `SELECT id, content, status
         FROM memories
         WHERE agent_id = ? AND content = ?
         ORDER BY rowid DESC LIMIT 1`,
      )
      .get(harness.agentId, canonicalCorrection) as
      { id: string; content: string; status: string } | undefined;
    expect(corrected).toMatchObject({
      content: canonicalCorrection,
      status: "active",
    });
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT status, superseded_by_id AS supersededById
           FROM memories WHERE id = ?`,
        )
        .get(original?.id),
    ).toEqual({ status: "superseded", supersededById: corrected?.id });
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT quote FROM memory_evidence
           WHERE memory_id = ? AND source_type = 'message'`,
        )
        .get(corrected?.id),
    ).toEqual({ quote: correctionSource });

    const recall = recallAgentMemories(app.personasim.store, {
      agentId: harness.agentId,
      query: {
        query: "小林和我是什么关系，她搬到哪里？",
        minimumScore: 0,
        purpose: "user_fact_query",
      },
      nowUtc: START_UTC,
    });
    expect(recall).toMatchObject({ abstained: false });
    expect(recall.selectedMemoryIds).toEqual([corrected?.id]);
    if (!recall.abstained) {
      expect(recall.evidenceBundle.evidence).toHaveLength(1);
      expect(recall.evidenceBundle.evidence[0]).toMatchObject({
        memoryContent: canonicalCorrection,
      });
      expect(recall.evidenceBundle.evidence[0]?.evidence.quote).toBe(
        correctionSource,
      );
    }
  });

  it("grounds LPM-4827 immediate recall in same-session user evidence after durable retrieval abstains", async () => {
    const harness = await createHarness("enforced", "enforced", "enforced");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const source =
      "我只告诉很信任的人一件小事：重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827。请只按我说的内容记，不要补充。";
    app.personasim.store.insertMessage({
      id: "message-lpm-recent-source",
      sessionId,
      agentId: harness.agentId,
      role: "user",
      content: source,
      messageKind: "user",
      metadata: { epistemicStatus: "asserted_fact" },
      createdAtUtc: DateTime.fromISO(START_UTC)
        .minus({ minutes: 2 })
        .toUTC()
        .toISO()!,
    });
    app.personasim.store.insertMessage({
      id: "message-lpm-assistant-poison",
      sessionId,
      agentId: harness.agentId,
      role: "assistant",
      content: "ASSISTANT-POISON：你已经结婚并有两个孩子。",
      messageKind: "assistant_reply",
      metadata: {},
      createdAtUtc: DateTime.fromISO(START_UTC)
        .minus({ minutes: 1 })
        .toUTC()
        .toISO()!,
    });
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return observation({
          route: "conversation",
          salientQuotes: ["我刚才说的代号是什么？", "那件东西放在哪里？"],
        });
      }
      if (input.purpose === "reply_generation") {
        return { text: "你已经结婚，而且有两个孩子。" };
      }
      if (input.purpose === "repair_chat_turn") {
        return { text: "代号是 WRONG-999，而且它放在书桌上。" };
      }
      return fixtureOrThrow(input);
    });

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "lpm-4827-immediate-recall",
      "我刚才说的代号是什么？那件东西放在哪里？只回答你确定的部分。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.memoryRecall).toMatchObject({
      rolloutMode: "enforced",
      recallMode: "none",
      abstained: true,
      selectedEvidenceIds: [],
    });
    expect(body.assistantMessage.content).toContain(
      "LPM-4827 是墨绿色珐琅松针",
    );
    expect(body.assistantMessage.content).toContain("深灰色电脑包的内侧拉链袋");
    expect(body.assistantMessage.content).not.toMatch(
      /WRONG-999|结婚|孩子|书桌/u,
    );
    expect(body.assistantMessage.metadata).toMatchObject({
      repairAttempted: true,
      usedFallback: true,
      replyIssueCodes: [],
    });
    const replyCall = calls.find(
      (input) => input.purpose === "reply_generation",
    );
    expect(replyCall?.prompt).toContain(source);
    expect(replyCall?.prompt).not.toContain("ASSISTANT-POISON");
    expect(purposeCount(calls, "reply_generation")).toBe(1);
    expect(purposeCount(calls, "repair_chat_turn")).toBe(1);
  });

  it("rejects a memory proposal on an LPM-4827 recall question without changing durable memory", async () => {
    const harness = await createHarness("enforced", "enforced", "enforced");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const source =
      "我只告诉很信任的人一件小事：重要发言前，我会把一枚墨绿色珐琅松针放进深灰色电脑包的内侧拉链袋，代号是 LPM-4827。请只按我说的内容记，不要补充。";
    const query = "再确认一次：LPM-4827 放在哪里？";
    const calls: Array<GenerateObjectInput<unknown>> = [];
    let recalling = false;
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return recalling
          ? observation({
              route: "conversation",
              salientQuotes: ["LPM-4827", "放在哪里？"],
              worldEffects: {
                memoryCandidates: [
                  {
                    type: "user_fact",
                    content: "LPM-4827 放在外侧口袋。",
                    evidenceQuotes: [query],
                  },
                ],
              },
            })
          : observation({
              route: "explicit_memory",
              dialogueActs: ["request_memory"],
              salientQuotes: ["LPM-4827", "深灰色电脑包的内侧拉链袋"],
              worldEffects: {
                memoryCandidates: [
                  {
                    type: "user_fact",
                    content: source,
                    evidenceQuotes: [source],
                  },
                ],
              },
            });
      }
      if (input.purpose === "reply_generation") {
        return {
          text: recalling
            ? "LPM-4827 放在深灰色电脑包的内侧拉链袋。"
            : "LPM-4827 和内侧拉链袋的位置，我记住了。",
        };
      }
      return fixtureOrThrow(input);
    });

    const sourceResponse = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "lpm-4827-recall-gate-source",
      source,
    );
    expect(sourceResponse.statusCode).toBe(201);
    const memoriesBefore = memoryCount(app, harness.agentId);
    const activeMemoriesBefore = app.personasim.store.database
      .prepare(
        `SELECT id, content, status
         FROM memories
         WHERE agent_id = ? AND status = 'active'
         ORDER BY id`,
      )
      .all(harness.agentId);
    expect(activeMemoriesBefore).toEqual([
      expect.objectContaining({ content: source, status: "active" }),
    ]);

    recalling = true;
    const clientMessageId = "lpm-4827-recall-gate-query";
    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      query,
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.memoryRecall).toMatchObject({
      rolloutMode: "enforced",
      abstained: false,
    });
    expect(body.memoryRecall?.selectedEvidenceIds.length).toBeGreaterThan(0);
    expect(body.assistantMessage.content).toContain("LPM-4827");
    expect(body.assistantMessage.content).toContain("深灰色电脑包的内侧拉链袋");
    expect(body.assistantMessage.content).not.toContain("外侧口袋");
    expect(body.assistantMessage.metadata).toMatchObject({
      acceptedEffectKinds: [],
      worldEffectsApplied: false,
      proposalRejectionCodes: ["memory_not_eligible_for_turn"],
    });
    expect(memoryCount(app, harness.agentId)).toBe(memoriesBefore);
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT id, content, status
           FROM memories
           WHERE agent_id = ? AND status = 'active'
           ORDER BY id`,
        )
        .all(harness.agentId),
    ).toEqual(activeMemoriesBefore);

    const recallUnderstandingCall = calls
      .filter((input) => input.purpose === "turn_understanding")
      .at(-1);
    expect(recallUnderstandingCall?.prompt).toContain('"memory":false');
    expect(recallUnderstandingCall?.prompt).not.toContain('"memoryCandidates"');
    const recallReplyCall = calls
      .filter((input) => input.purpose === "reply_generation")
      .at(-1);
    expect(recallReplyCall?.prompt).toContain(source);
    expect(
      eventFor(
        app,
        harness.agentId,
        clientMessageId,
        "conversation.world_effects_committed",
      )?.payload,
    ).toMatchObject({
      applied: false,
      accepted: { memoryCandidateCount: 0 },
      rejectionCodes: ["memory_not_eligible_for_turn"],
    });
  });

  it.each([
    {
      label: "hypothetical",
      messages: [
        {
          id: "message-hypothetical-source",
          content:
            "假设我把一枚墨绿色珐琅松针放进电脑包，代号是 LPM-4827。这里只是举例。",
          epistemicStatus: "hypothetical",
        },
      ],
    },
    {
      label: "retracted",
      messages: [
        {
          id: "message-retracted-source",
          content: "我把一枚墨绿色珐琅松针放进电脑包，代号是 LPM-4827。",
          epistemicStatus: "asserted_fact",
        },
        {
          id: "message-retraction",
          content: "撤回刚才关于 LPM-4827 的内容，前面的说法不算事实。",
          epistemicStatus: "retracted",
        },
      ],
    },
  ])(
    "does not authorize $label recent user text as LPM-4827 evidence",
    async ({ label, messages }) => {
      const harness = await createHarness("enforced", "enforced", "enforced");
      app = harness.app;
      const sessionId = createSession(app, harness.agentId);
      messages.forEach((message, index) => {
        harness.app.personasim.store.insertMessage({
          id: message.id,
          sessionId,
          agentId: harness.agentId,
          role: "user",
          content: message.content,
          messageKind: "user",
          metadata: { epistemicStatus: message.epistemicStatus },
          createdAtUtc: DateTime.fromISO(START_UTC)
            .minus({ minutes: messages.length - index })
            .toUTC()
            .toISO()!,
        });
      });
      const calls: Array<GenerateObjectInput<unknown>> = [];
      mockSplitLlm(app.personasim.llm, calls, (input) => {
        if (input.purpose === "turn_understanding") {
          return observation({ route: "conversation" });
        }
        if (input.purpose === "reply_generation") {
          return {
            text: "LPM-4827 是墨绿色珐琅松针，放在电脑包里。",
          };
        }
        return fixtureOrThrow(input);
      });

      const response = await sendMessage(
        app,
        sessionId,
        harness.agentId,
        `lpm-4827-${label}`,
        "我刚才说的代号是什么？那件东西放在哪里？只回答你确定的部分。",
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.assistantMessage.content).toMatch(/不知道|没有.{0,8}依据/u);
      expect(purposeCount(calls, "reply_generation")).toBe(0);
    },
  );

  it("persists grounded memory and care proposals, then injects the care cue without a schedule write", async () => {
    const harness = await createHarness("enforced");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    let secondTurn = false;
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return secondTurn
          ? observation({
              route: "conversation",
              topicKey: "蓝鲸答辩",
              topicDomain: "study",
              topicQuote: "蓝鲸答辩",
              salientQuotes: ["蓝鲸答辩", "我还是很紧张"],
            })
          : observation({
              route: "explicit_memory",
              dialogueActs: ["request_memory"],
              topicKey: "蓝鲸答辩",
              topicDomain: "study",
              topicQuote: "蓝鲸答辩",
              salientQuotes: ["我在准备蓝鲸答辩时会紧张", "希望你先听我说完"],
              worldEffects: {
                memoryCandidates: [
                  {
                    type: "user_fact",
                    content: "我在准备蓝鲸答辩时会紧张",
                    confidence: 0.98,
                    evidenceQuotes: ["我在准备蓝鲸答辩时会紧张"],
                  },
                ],
                continuityEffects: {
                  careCueCandidates: [
                    {
                      cueType: "presentation_anxiety",
                      contextSummary: "用户准备蓝鲸答辩时会紧张",
                      mentionGuidance:
                        "后续谈到蓝鲸答辩时先倾听，再温和询问近况。",
                      evidenceQuotes: [
                        "我在准备蓝鲸答辩时会紧张",
                        "希望你先听我说完",
                      ],
                    },
                  ],
                },
              },
            });
      }
      if (input.purpose === "reply_generation") {
        return {
          text: secondTurn
            ? "蓝鲸答辩越来越近，你还是很紧张。你先慢慢说，我听着。"
            : "蓝鲸答辩带来的紧张和你希望我先听完，我都听到了。",
        };
      }
      return fixtureOrThrow(input);
    });
    const scheduleBefore = app.personasim.store.listSchedule(harness.agentId);
    const memoriesBefore = memoryCount(app, harness.agentId);

    const first = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "grounded-memory-care-first",
      "请记住，我在准备蓝鲸答辩时会紧张，希望你先听我说完。",
    );

    expect(first.statusCode).toBe(201);
    const firstBody = jsonBody<ChatTurnResult>(first);
    expect(memoryCount(app, harness.agentId)).toBe(memoriesBefore + 1);
    const persistedCue = careCueFor(app, harness.agentId);
    expect(persistedCue?.contextSummary).toContain("蓝鲸答辩");
    expect(persistedCue?.mentionGuidance).toContain("先倾听");
    expect(persistedCue?.status).toBe("active");
    expect(firstBody.scheduleChanges).toEqual([]);
    expect(
      scheduleEventsFor(app, harness.agentId, "grounded-memory-care-first"),
    ).toEqual([]);

    secondTurn = true;
    const callCountBeforeSecondTurn = calls.length;
    const second = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "grounded-memory-care-second",
      "蓝鲸答辩越来越近，我还是很紧张。",
    );

    expect(second.statusCode).toBe(201);
    const secondBody = jsonBody<ChatTurnResult>(second);
    expect(persistedCue?.id).toBeDefined();
    expect(secondBody.assistantMessage.metadata).toMatchObject({
      turnPipelineMode: "enforced",
      continuityPromptCueIds: [persistedCue?.id],
    });
    const secondTurnCalls = calls.slice(callCountBeforeSecondTurn);
    const understandingCall = secondTurnCalls.find(
      (call) => call.purpose === "turn_understanding",
    );
    const replyCall = secondTurnCalls.find(
      (call) => call.purpose === "reply_generation",
    );
    expect(understandingCall?.prompt).toContain("蓝鲸答辩");
    expect(understandingCall?.prompt).toContain("先倾听");
    expect(replyCall?.prompt).toContain("FOLLOWUP_CONTEXT_JSON");
    expect(replyCall?.prompt).toContain("蓝鲸答辩");
    expect(secondBody.scheduleChanges).toEqual([]);
    expect(app.personasim.store.listSchedule(harness.agentId)).toEqual(
      scheduleBefore,
    );
    expect(
      scheduleEventsFor(app, harness.agentId, "grounded-memory-care-second"),
    ).toEqual([]);
  });

  it("persists and immediately selects an event-bound care preference when understanding returns only state", async () => {
    const harness = await createHarness("enforced");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return observation({
          route: "conversation",
          topicKey: "公开分享",
          topicDomain: "work",
          topicQuote: "公开分享",
          salientQuotes: ["公开分享", "只想被听见", "不要马上给建议"],
          worldEffects: { stateDelta: { stress: 0.05 } },
        });
      }
      if (input.purpose === "reply_generation") {
        return {
          text: input.prompt.includes("我希望你先听我说完")
            ? "好，我在。"
            : input.prompt.includes("FOLLOWUP_CONTEXT_JSON")
              ? "公开分享还让你紧张，我先听着，不急着给建议。"
              : "下周四的公开分享让你紧张；这一刻我先听着，不给建议。",
        };
      }
      return fixtureOrThrow(input);
    });
    const userText =
      "下周四我要做一次公开分享，现在有点紧张。这一刻我只想被听见，不要马上给建议。";
    const clientMessageId = "deepseek-state-only-explicit-care";

    const first = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      userText,
    );

    expect(first.statusCode).toBe(201);
    const firstBody = jsonBody<ChatTurnResult>(first);
    const cue = app.personasim.store.database
      .prepare(
        `SELECT id,
                context_summary AS contextSummary,
                mention_guidance AS mentionGuidance,
                source_message_id AS sourceMessageId,
                earliest_at_utc AS earliestAtUtc,
                max_mentions AS maxMentions,
                status,
                revision,
                updated_at_utc AS updatedAtUtc,
                dedupe_key AS dedupeKey
         FROM care_cues
         WHERE agent_id = ?`,
      )
      .get(harness.agentId) as
      | {
          id: string;
          contextSummary: string;
          mentionGuidance: string;
          sourceMessageId: string;
          earliestAtUtc: string | null;
          maxMentions: number;
          status: string;
          revision: number;
          updatedAtUtc: string;
          dedupeKey: string;
        }
      | undefined;
    if (cue === undefined) throw new Error("Expected a persisted care cue.");
    expect(cue.id).toBeTruthy();
    expect(cue).toMatchObject({
      contextSummary: "下周四我要做一次公开分享，现在有点紧张",
      mentionGuidance:
        "当用户再次谈到这项事件或相关感受时，先倾听并确认感受，不要马上给建议。",
      sourceMessageId: firstBody.userMessage.id,
      earliestAtUtc: null,
      maxMentions: 1,
      status: "active",
      revision: 0,
      updatedAtUtc: START_UTC,
    });
    expect(cue.dedupeKey).toMatch(/^carecue:v1:/u);
    expect(firstBody.assistantMessage.metadata).toMatchObject({
      acceptedEffectKinds: ["state_delta"],
      acceptedEffectCount: 1,
    });
    const callCountAfterFirst = calls.length;
    const eventTypesAfterFirst = eventTypesFor(
      app,
      harness.agentId,
      clientMessageId,
    );

    const replay = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      userText,
    );

    expect(replay.statusCode).toBe(200);
    expect(jsonBody<ChatTurnResult>(replay).idempotentReplay).toBe(true);
    expect(calls).toHaveLength(callCountAfterFirst);
    expect(eventTypesFor(app, harness.agentId, clientMessageId)).toEqual(
      eventTypesAfterFirst,
    );
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM care_cues WHERE agent_id = ?")
        .get(harness.agentId),
    ).toEqual({ count: 1 });
    const replayedCue = app.personasim.store.database
      .prepare(
        `SELECT id,
                context_summary AS contextSummary,
                mention_guidance AS mentionGuidance,
                source_message_id AS sourceMessageId,
                earliest_at_utc AS earliestAtUtc,
                max_mentions AS maxMentions,
                status,
                revision,
                updated_at_utc AS updatedAtUtc,
                dedupe_key AS dedupeKey
         FROM care_cues
         WHERE id = ?`,
      )
      .get(cue.id) as typeof cue | undefined;
    expect(replayedCue).toEqual(cue);

    const related = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "deepseek-state-only-explicit-care-related",
      "想到这次公开分享，我还是有点紧张。",
    );

    expect(related.statusCode).toBe(201);
    expect(
      jsonBody<ChatTurnResult>(related).assistantMessage.metadata,
    ).toMatchObject({
      continuityPromptCueIds: [cue.id],
    });

    const restatement = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "deepseek-state-only-explicit-care-restatement",
      "下周四我要做一次公开分享，现在有点紧张。我希望你先听我说完。别急着给建议。",
    );

    expect(restatement.statusCode).toBe(201);
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT COUNT(*) AS count,
                  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS activeCount
           FROM care_cues
           WHERE agent_id = ?`,
        )
        .get(harness.agentId),
    ).toEqual({ count: 1, activeCount: 0 });
    expect(
      app.personasim.store.database
        .prepare(
          `SELECT source_message_id AS sourceMessageId,
                  dedupe_key AS dedupeKey
           FROM care_cues WHERE id = ?`,
        )
        .get(cue.id),
    ).toEqual({
      sourceMessageId: cue.sourceMessageId,
      dedupeKey: cue.dedupeKey,
    });
  });

  it("audits an all-schema-invalid care array while committing only the independent care projection", async () => {
    const harness = await createHarness("enforced");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return observation({
          route: "conversation",
          topicKey: "公开分享",
          topicDomain: "work",
          topicQuote: "公开分享",
          salientQuotes: ["公开分享", "只想被听见", "不要马上给建议"],
          worldEffects: {
            stateDelta: { stress: 0.05 },
            continuityEffects: {
              followUpCandidates: [],
              followUpTransitions: [],
              careCueCandidates: [
                {
                  cueType: "listen_first",
                  contextSummary: null,
                  evidenceQuotes: ["这一刻我只想被听见，不要马上给建议"],
                },
              ],
            },
          },
        });
      }
      if (input.purpose === "reply_generation") {
        return { text: "这次公开分享让你紧张；我先听着，不给建议。" };
      }
      return fixtureOrThrow(input);
    });
    const clientMessageId = "malformed-envelope-explicit-care";

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      "下周四我要做一次公开分享，现在有点紧张。这一刻我只想被听见，不要马上给建议。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(careCueFor(app, harness.agentId)).toMatchObject({
      contextSummary: "下周四我要做一次公开分享，现在有点紧张",
      status: "active",
    });
    expect(
      app.personasim.store.database
        .prepare("SELECT COUNT(*) AS count FROM care_cues WHERE agent_id = ?")
        .get(harness.agentId),
    ).toEqual({ count: 1 });
    expect(body.assistantMessage.metadata).toMatchObject({
      acceptedEffectKinds: ["state_delta"],
    });
    const rejection = app.personasim.store
      .listRejectedProposals(harness.agentId, 20)
      .find(
        (candidate) =>
          candidate.reasonCode === "schema_mismatch" &&
          candidate.correlationId === clientMessageId,
      );
    expect(rejection).toMatchObject({
      reasonCode: "schema_mismatch",
      correlationId: clientMessageId,
    });
    expect(rejection?.reasonSummary).toContain("care_cue");
  });

  it("rejects model continuity effects when the current message has no continuity signal", async () => {
    const harness = await createHarness("enforced");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return observation({
          route: "continuity",
          salientQuotes: ["今天天气真不错"],
          worldEffects: {
            continuityEffects: {
              careCueCandidates: [
                {
                  cueType: "ordinary_weather",
                  contextSummary: "今天天气真不错",
                  mentionGuidance: "以后主动反复提起天气。",
                  evidenceQuotes: ["今天天气真不错"],
                },
              ],
            },
          },
        });
      }
      if (input.purpose === "reply_generation") {
        return { text: "是啊，光线也很舒服。" };
      }
      return fixtureOrThrow(input);
    });

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "ordinary-continuity-gate",
      "今天天气真不错。",
    );

    expect(response.statusCode).toBe(201);
    expect(careCueFor(app, harness.agentId)).toBeUndefined();
    expect(
      app.personasim.store.database
        .prepare(
          "SELECT COUNT(*) AS count FROM follow_up_intents WHERE agent_id = ?",
        )
        .get(harness.agentId),
    ).toEqual({ count: 0 });
    expect(
      app.personasim.store.listRejectedProposals(harness.agentId, 20),
    ).toContainEqual(
      expect.objectContaining({
        reasonCode: "continuity_effect_not_eligible_for_turn",
        correlationId: "ordinary-continuity-gate",
      }),
    );
  });

  it("rejects an eligible continuity candidate without a grounded source quote", async () => {
    const harness = await createHarness("enforced");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return observation({
          route: "continuity",
          salientQuotes: ["只想被听见", "不要马上给建议"],
          worldEffects: {
            continuityEffects: {
              careCueCandidates: [
                {
                  cueType: "listen_first",
                  contextSummary: "用户希望先被倾听",
                  mentionGuidance: "后续先听用户说完。",
                  evidenceQuotes: ["模型编造的证据"],
                },
              ],
            },
          },
        });
      }
      if (input.purpose === "reply_generation") {
        return { text: "好，我先听你说。" };
      }
      return fixtureOrThrow(input);
    });

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "ungrounded-continuity-candidate",
      "下周四我要做一次公开分享，现在有点紧张。这一刻我只想被听见，不要马上给建议。",
    );

    expect(response.statusCode).toBe(201);
    expect(careCueFor(app, harness.agentId)).toBeUndefined();
    expect(
      app.personasim.store.listRejectedProposals(harness.agentId, 20),
    ).toContainEqual(
      expect.objectContaining({
        reasonCode: "missing_grounded_quote",
        correlationId: "ungrounded-continuity-candidate",
      }),
    );
  });

  it("omits world-effect evaluation events when live effects are off", async () => {
    const harness = await createHarness("off");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return worldEffectObservation("OFF-WORLD-EFFECT");
      }
      if (input.purpose === "reply_generation") {
        return { text: "我听到了，今天可以给自己留一点余地。" };
      }
      return fixtureOrThrow(input);
    });
    const stateBefore = app.personasim.store.getRuntimeState(harness.agentId);
    const memoryCountBefore = app.personasim.store.tableCounts()["memories"];
    const clientMessageId = "off-world-effect-no-audit";

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      "今天感觉有点累，代号是 OFF-WORLD-EFFECT。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.state).toEqual(stateBefore);
    expect(app.personasim.store.getRuntimeState(harness.agentId)).toEqual(
      stateBefore,
    );
    expect(app.personasim.store.tableCounts()["memories"]).toBe(
      memoryCountBefore,
    );
    expect(body.assistantMessage.metadata).toMatchObject({
      worldEffectsMode: "off",
      worldEffectsWritesEnabled: false,
      worldEffectsApplied: false,
      acceptedEffectKinds: [],
    });
    expect(
      eventTypesFor(app, harness.agentId, clientMessageId).filter((eventType) =>
        eventType.startsWith("conversation.world_effects_"),
      ),
    ).toEqual([]);
  });

  it.each([
    "你是不是已经答应明天去了？",
    "他说‘好啊，明天见’，但我还没决定。",
    "要是明天不下雨就散步，不过再看看吧。",
    "答辩结束后想吃点好的，帮我记住。",
  ])(
    "does not authorize a shared schedule for a question, quote, hypothesis, or memory frame: %s",
    async (userText) => {
      const harness = await createHarness();
      app = harness.app;
      const sessionId = createSession(app, harness.agentId);
      const calls: Array<GenerateObjectInput<unknown>> = [];
      mockSplitLlm(app.personasim.llm, calls, (input) => {
        if (input.purpose === "turn_understanding") {
          // Deliberately malicious: the deterministic router must prevent this
          // model proposal from elevating framed prose into write access.
          return observation({
            route: "schedule_mutation",
            dialogueActs: ["invite"],
            scheduleIntent: {
              kind: "create_shared_activity",
              activityQuote: { text: "明天" },
              timeQuote: { text: "明天" },
              missingFields: [],
            },
          });
        }
        if (input.purpose === "reply_generation") {
          return { text: "我明白，你是在谈一种可能性，还没有作出安排。" };
        }
        return fixtureOrThrow(input);
      });
      const beforeSchedule = app.personasim.store.listSchedule(harness.agentId);
      const clientMessageId = `split-framed-${String(
        [
          "你是不是已经答应明天去了？",
          "他说‘好啊，明天见’，但我还没决定。",
          "要是明天不下雨就散步，不过再看看吧。",
          "答辩结束后想吃点好的，帮我记住。",
        ].indexOf(userText),
      )}`;

      const response = await sendMessage(
        app,
        sessionId,
        harness.agentId,
        clientMessageId,
        userText,
      );

      expect(response.statusCode).toBe(201);
      const body = jsonBody<ChatTurnResult>(response);
      expect(body.scheduleChanges).toEqual([]);
      expect(app.personasim.store.listSchedule(harness.agentId)).toEqual(
        beforeSchedule,
      );
      expect(scheduleEventsFor(app, harness.agentId, clientMessageId)).toEqual(
        [],
      );
      expect(
        app.personasim.store.listScheduleNegotiations({ sessionId }),
      ).toEqual([]);
      expect(purposeCount(calls, "chat_turn")).toBe(0);
    },
  );

  it("does not leak an active pending offer into an unrelated care turn", async () => {
    const harness = await createHarness();
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    let ordinaryCareTurn = false;
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return ordinaryCareTurn
          ? observation({
              route: "explicit_memory",
              dialogueActs: ["request_memory"],
              salientQuotes: ["先听我说说"],
            })
          : directOfferObservation();
      }
      if (input.purpose === "reply_generation") {
        return {
          text: ordinaryCareTurn
            ? "我听见你说“先听我说说”了。好，你先说，我认真听着。"
            : "我把明早七点听清了，先等你明确确认。",
        };
      }
      return fixtureOrThrow(input);
    });

    const proposal = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "active-offer-proposal",
      DIRECT_OFFER,
    );
    expect(proposal.statusCode).toBe(201);
    const pendingBefore =
      app.personasim.store.getActiveScheduleNegotiation(sessionId);
    expect(pendingBefore).toMatchObject({
      status: "awaiting_confirmation",
      offerVersion: 1,
    });

    ordinaryCareTurn = true;
    const care = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "active-offer-care-turn",
      "这件事先放着；我有点难过，你先听我说说。",
    );

    expect(care.statusCode).toBe(201);
    const careBody = jsonBody<ChatTurnResult>(care);
    expect(careBody.assistantMessage.metadata).toMatchObject({
      turnRoute: "explicit_memory",
      scheduleOutcomeKind: "none",
    });
    expect(careBody.scheduleChanges).toEqual([]);
    expect(
      scheduleEventsFor(app, harness.agentId, "active-offer-care-turn"),
    ).toEqual([]);
    expect(
      app.personasim.store.getActiveScheduleNegotiation(sessionId),
    ).toEqual(pendingBefore);
  });

  it("keeps execution and domain events independent of reply wording", async () => {
    const harness = await createHarness();
    app = harness.app;
    const turnExecutions = app.personasim.kernel.registry.resolve(
      TURN_EXECUTION_SERVICE_TOKEN,
    );
    const replyGenerations = app.personasim.kernel.registry.resolve(
      REPLY_GENERATION_SERVICE_TOKEN,
    );
    const executionOutcomes: ValidatedTurnOutcome[] = [];
    const executeAuthoritatively = turnExecutions.execute.bind(turnExecutions);
    vi.spyOn(turnExecutions, "execute").mockImplementation((input) => {
      const outcome = executeAuthoritatively(input);
      executionOutcomes.push(outcome);
      return outcome;
    });
    const calls: Array<GenerateObjectInput<unknown>> = [];
    let activeObservation = directOfferObservation();
    const replyQueue = ["好，我愿意。", "嗯，可以。", "我记住了。"];
    vi.spyOn(replyGenerations, "generate").mockImplementation(() => {
      const text = replyQueue.shift() ?? "我听到了。";
      return Promise.resolve({
        reply: { text, chunks: [text], toneTags: [] },
        response: { text },
        repairAttempted: false,
        usedFallback: false,
        issues: [],
        promptSegmentTrace: [],
      } as never);
    });
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") return activeObservation;
      return fixtureOrThrow(input);
    });
    const firstSession = createSession(app, harness.agentId);
    const secondSession = createSession(app, harness.agentId);

    const first = jsonBody<ChatTurnResult>(
      await sendMessage(
        app,
        firstSession,
        harness.agentId,
        "reply-independent-a",
        DIRECT_OFFER,
      ),
    );
    const second = jsonBody<ChatTurnResult>(
      await sendMessage(
        app,
        secondSession,
        harness.agentId,
        "reply-independent-b",
        DIRECT_OFFER,
      ),
    );
    const firstOutcome = executionOutcomes[0];
    const secondOutcome = executionOutcomes[1];
    if (firstOutcome === undefined || secondOutcome === undefined) {
      throw new Error("Expected two authoritative execution outcomes");
    }
    expect(canonicalOutcome(firstOutcome)).toEqual(
      canonicalOutcome(secondOutcome),
    );
    expect(first.assistantMessage.content).toBe("好，我愿意。");
    expect(second.assistantMessage.content).toBe("嗯，可以。");
    expect(first.scheduleChanges.map((item) => item.id)).toEqual([]);
    expect(second.scheduleChanges.map((item) => item.id)).toEqual([]);
    expect(eventTypesFor(app, harness.agentId, "reply-independent-a")).toEqual(
      eventTypesFor(app, harness.agentId, "reply-independent-b"),
    );
    expect(
      app.personasim.store.getActiveScheduleNegotiation(firstSession),
    ).toMatchObject({ status: "awaiting_confirmation", offerVersion: 1 });
    expect(
      app.personasim.store.getActiveScheduleNegotiation(secondSession),
    ).toMatchObject({ status: "awaiting_confirmation", offerVersion: 1 });

    const reverseSession = createSession(app, harness.agentId);
    activeObservation = observation({ route: "conversation" });
    const reverseClientId = "reply-claims-memory-without-outcome";
    const reverse = jsonBody<ChatTurnResult>(
      await sendMessage(
        app,
        reverseSession,
        harness.agentId,
        reverseClientId,
        "今天只是想随便聊聊天。",
      ),
    );
    const reverseOutcome = executionOutcomes[2];
    expect(reverseOutcome?.scheduleOutcome).toEqual({ kind: "none" });
    expect(reverse.assistantMessage.content).toBe("我记住了。");
    expect(reverse.scheduleChanges).toEqual([]);
    expect(scheduleEventsFor(app, harness.agentId, reverseClientId)).toEqual(
      [],
    );
    expect(purposeCount(calls, "chat_turn")).toBe(0);
  });

  it("uses a typed deterministic request-details fallback for a high-precision incomplete invitation", async () => {
    const harness = await createHarness();
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return { schemaVersion: 2, route: "schedule_mutation" };
      }
      if (input.purpose === "reply_generation") {
        return { text: "我听见你的邀请了，我们可以先把想法聊清楚。" };
      }
      return fixtureOrThrow(input);
    });
    const clientMessageId = "understanding-fallback-d";
    const beforeSchedule = app.personasim.store.listSchedule(harness.agentId);

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      "我们明天晚上一起散步吧。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).toContain("说清楚时间");
    expect(body.assistantMessage.content).toContain("不会改动日程");
    expect(body.assistantMessage.content).not.toMatch(
      /schema|JSON|解析|模型|provider|fallback/iu,
    );
    expect(body.scheduleChanges).toEqual([]);
    expect(app.personasim.store.listSchedule(harness.agentId)).toEqual(
      beforeSchedule,
    );
    expect(body.assistantMessage.metadata).toMatchObject({
      understandingOrigin: "deterministic",
      turnRoute: "schedule_mutation",
      scheduleOutcomeKind: "needs_clarification",
    });
    expect(body.assistantMessage.metadata.observationRejectedFields).toEqual(
      [],
    );
    const audit = eventFor(
      app,
      harness.agentId,
      clientMessageId,
      "conversation.turn_understanding_resolved",
    );
    expect(audit?.payload).toMatchObject({
      origin: "deterministic",
      route: "schedule_mutation",
      scheduleIntentKind: "create_shared_activity",
    });
    expect(scheduleEventsFor(app, harness.agentId, clientMessageId)).toContain(
      "schedule.negotiation_details_collected",
    );
    expect(purposeCount(calls, "turn_understanding")).toBe(0);
    expect(purposeCount(calls, "reply_generation")).toBe(1);
    expect(purposeCount(calls, "chat_turn")).toBe(0);
  });

  it("executes the authoritative offer-read-confirm-read and details-withdraw chains without model schedule authority", async () => {
    const harness = await createHarness();
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const calls: Array<GenerateObjectInput<unknown>> = [];
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "reply_generation") {
        return { invalid: "force authoritative fallback" };
      }
      if (input.purpose === "repair_chat_turn") {
        throw new Error("repair unavailable");
      }
      return fixtureOrThrow(input);
    });
    const scheduleBefore = app.personasim.store.listSchedule(harness.agentId);
    const memoriesBefore = memoryCount(app, harness.agentId);
    const bookSlot = findFreeSlots({
      horizonStartAtUtc: START_UTC,
      horizonEndAtUtc: DateTime.fromISO(START_UTC)
        .plus({ hours: 72 })
        .toUTC()
        .toISO()!,
      timezone: "Asia/Shanghai",
      existingItems: scheduleBefore,
      durationMinutes: 45,
      bufferMinutes: 5,
    })[0];
    if (bookSlot === undefined) throw new Error("Expected a free book slot");
    const bookLocal = DateTime.fromISO(bookSlot.startAtUtc)
      .setZone("Asia/Shanghai")
      .toFormat("yyyy年MM月dd日 HH:mm");
    const invitation = `这是一个明确的共同邀约：我想在 ${bookLocal} 和你一起去梧桐路 23 号的“北岸书店”喝茶，预计 45 分钟。你愿意吗？如果愿意，请先作为待我确认的共同安排，不要声称已经写入日程。`;

    const offered = jsonBody<ChatTurnResult>(
      await sendMessage(
        app,
        sessionId,
        harness.agentId,
        "frame-book-offer",
        invitation,
      ),
    );
    expect(offered.scheduleChanges).toEqual([]);
    expect(offered.assistantMessage.metadata).toMatchObject({
      understandingOrigin: "deterministic",
      turnRoute: "schedule_mutation",
      scheduleOutcomeKind: "pending_confirmation",
      replyMutationAuthorization: "disabled",
    });
    expect(offered.assistantMessage.content).toMatch(/待确认|尚未修改/u);
    const bookPending =
      app.personasim.store.getActiveScheduleNegotiation(sessionId);
    expect(bookPending).toMatchObject({
      status: "awaiting_confirmation",
      offerVersion: 1,
    });
    expect(app.personasim.store.listSchedule(harness.agentId)).toEqual(
      scheduleBefore,
    );

    const pendingRead = jsonBody<ChatTurnResult>(
      await sendMessage(
        app,
        sessionId,
        harness.agentId,
        "frame-book-pending-read",
        "你是不是已经把刚才的北岸书店安排写进日程了？",
      ),
    );
    expect(pendingRead.scheduleChanges).toEqual([]);
    expect(pendingRead.assistantMessage.metadata).toMatchObject({
      turnRoute: "schedule_query",
      scheduleOutcomeKind: "read_only",
    });
    expect(pendingRead.assistantMessage.content).toContain("北岸书店");
    expect(pendingRead.assistantMessage.content).toContain("待确认");
    expect(pendingRead.assistantMessage.content).not.toContain("剪辑工作");
    expect(
      app.personasim.store.getActiveScheduleNegotiation(sessionId),
    ).toEqual(bookPending);

    const committed = jsonBody<ChatTurnResult>(
      await sendMessage(
        app,
        sessionId,
        harness.agentId,
        "frame-book-confirm",
        "确认。",
      ),
    );
    expect(committed.scheduleChanges).toHaveLength(1);
    expect(committed.scheduleChanges[0]).toMatchObject({
      source: "user_invitation",
      startAtUtc: bookSlot.startAtUtc,
    });
    expect(committed.scheduleChanges[0]?.title).toContain("北岸书店");
    expect(committed.assistantMessage.metadata).toMatchObject({
      scheduleOutcomeKind: "committed",
      replyMutationAuthorization: "disabled",
    });
    expect(
      app.personasim.store.getActiveScheduleNegotiation(sessionId),
    ).toBeUndefined();
    expect(
      scheduleEventsFor(app, harness.agentId, "frame-book-confirm").filter(
        (eventType) => eventType === "schedule.command_committed",
      ),
    ).toHaveLength(1);

    const committedRead = jsonBody<ChatTurnResult>(
      await sendMessage(
        app,
        sessionId,
        harness.agentId,
        "frame-book-committed-read",
        "当前真正生效的北岸书店安排是什么？",
      ),
    );
    expect(committedRead.assistantMessage.metadata).toMatchObject({
      scheduleOutcomeKind: "read_only",
      scheduleOutcome: {
        kind: "read_only",
        itemIds: [committed.scheduleChanges[0]!.id],
      },
    });
    expect(committedRead.assistantMessage.content).toContain("北岸书店");
    expect(committedRead.assistantMessage.content).not.toContain("剪辑工作");

    const missingDetails = jsonBody<ChatTurnResult>(
      await sendMessage(
        app,
        sessionId,
        harness.agentId,
        "frame-park-details",
        "哪天一起去公园走走吧。",
      ),
    );
    expect(missingDetails.scheduleChanges).toEqual([]);
    expect(missingDetails.assistantMessage.metadata).toMatchObject({
      scheduleOutcomeKind: "needs_clarification",
    });
    expect(
      app.personasim.store.getActiveScheduleNegotiation(sessionId),
    ).toMatchObject({ status: "collecting_details", offerVersion: 0 });

    const parkSlot = findFreeSlots({
      horizonStartAtUtc: START_UTC,
      horizonEndAtUtc: DateTime.fromISO(START_UTC)
        .plus({ hours: 72 })
        .toUTC()
        .toISO()!,
      timezone: "Asia/Shanghai",
      existingItems: app.personasim.store.listSchedule(harness.agentId),
      durationMinutes: 60,
      bufferMinutes: 5,
    })[0];
    if (parkSlot === undefined) throw new Error("Expected a free park slot");
    const parkLocal = DateTime.fromISO(parkSlot.startAtUtc)
      .setZone("Asia/Shanghai")
      .toFormat("yyyy年MM月dd日 HH:mm");
    const parkPendingResponse = jsonBody<ChatTurnResult>(
      await sendMessage(
        app,
        sessionId,
        harness.agentId,
        "frame-park-complete",
        `那就定在 ${parkLocal}，世纪公园，走 60 分钟。先等我确认。`,
      ),
    );
    expect(parkPendingResponse.scheduleChanges).toEqual([]);
    expect(
      parkPendingResponse.assistantMessage.metadata["proposalRejectionCodes"],
    ).toEqual([]);
    expect(parkPendingResponse.assistantMessage.metadata).toMatchObject({
      scheduleOutcomeKind: "pending_confirmation",
    });
    const parkPending =
      app.personasim.store.getActiveScheduleNegotiation(sessionId);
    expect(parkPending).toMatchObject({
      status: "awaiting_confirmation",
      offerVersion: 1,
    });
    expect(JSON.stringify(parkPending)).toContain("世纪公园");

    const withdrawn = jsonBody<ChatTurnResult>(
      await sendMessage(
        app,
        sessionId,
        harness.agentId,
        "frame-park-withdraw",
        "取消刚才这个公园方案。",
      ),
    );
    expect(withdrawn.scheduleChanges).toEqual([]);
    expect(withdrawn.assistantMessage.metadata).toMatchObject({
      scheduleOutcomeKind: "declined",
    });
    expect(
      app.personasim.store.getScheduleNegotiationById(parkPending!.id),
    ).toMatchObject({ status: "withdrawn" });
    expect(
      app.personasim.store.getActiveScheduleNegotiation(sessionId),
    ).toBeUndefined();
    expect(
      app.personasim.store
        .listSchedule(harness.agentId)
        .filter((item) => item.source === "user_invitation"),
    ).toHaveLength(1);
    expect(memoryCount(app, harness.agentId)).toBe(memoriesBefore);
    expect(purposeCount(calls, "turn_understanding")).toBe(0);
    expect(purposeCount(calls, "chat_turn")).toBe(0);
  });

  it("commits a validated outcome with reply fallback and rolls back the whole turn on final CAS failure", async () => {
    const harness = await createHarness();
    app = harness.app;
    const calls: Array<GenerateObjectInput<unknown>> = [];
    let invalidReply = false;
    mockSplitLlm(app.personasim.llm, calls, (input) => {
      if (input.purpose === "turn_understanding") {
        return input.prompt.includes("后天早上七点")
          ? directOfferObservation("后天早上七点")
          : directOfferObservation();
      }
      if (input.purpose === "reply_generation") {
        return invalidReply
          ? { mutation: "not-a-reply" }
          : { text: "我把明早七点听清了，先等你明确确认。" };
      }
      if (input.purpose === "repair_chat_turn" && invalidReply) {
        throw new Error("repair unavailable");
      }
      return fixtureOrThrow(input);
    });

    const successfulSession = createSession(app, harness.agentId);
    const proposal = await sendMessage(
      app,
      successfulSession,
      harness.agentId,
      "fallback-commit-proposal",
      DIRECT_OFFER,
    );
    expect(proposal.statusCode).toBe(201);
    expect(
      app.personasim.store.getActiveScheduleNegotiation(successfulSession),
    ).toMatchObject({ status: "awaiting_confirmation" });

    invalidReply = true;
    const confirmation = await sendMessage(
      app,
      successfulSession,
      harness.agentId,
      "fallback-commit-confirmation",
      "确认",
    );
    expect(confirmation.statusCode).toBe(201);
    const confirmationBody = jsonBody<ChatTurnResult>(confirmation);
    expect(confirmationBody.scheduleChanges).toHaveLength(1);
    expect(confirmationBody.assistantMessage.metadata).toMatchObject({
      usedFallback: true,
      repairAttempted: true,
      scheduleOutcomeKind: "committed",
    });
    expect(confirmationBody.assistantMessage.content).toContain(
      "已经确认并加入日程",
    );
    const committedEvent = eventFor(
      app,
      harness.agentId,
      "fallback-commit-confirmation",
      "schedule.command_committed",
    );
    expect(committedEvent?.payload).toMatchObject({
      changedItemIds: confirmationBody.scheduleChanges.map((item) => item.id),
    });

    const secondSession = createSession(app, harness.agentId);
    invalidReply = false;
    const secondProposal = await sendMessage(
      app,
      secondSession,
      harness.agentId,
      "second-command-proposal",
      "后天早上七点和我一起去跑步半小时",
    );
    expect(secondProposal.statusCode).toBe(201);
    invalidReply = true;
    const secondConfirmation = await sendMessage(
      app,
      secondSession,
      harness.agentId,
      "second-command-confirmation",
      "确认",
    );
    expect(secondConfirmation.statusCode).toBe(201);
    const commandVersions = app.personasim.store
      .listDomainEvents(harness.agentId, 500)
      .filter(
        (event) =>
          event.streamType === "schedule" &&
          event.streamId === harness.agentId &&
          event.eventType === "schedule.command_committed",
      )
      .sort(
        (left, right) =>
          Number(left.streamVersion) - Number(right.streamVersion),
      )
      .map((event) => Number(event.streamVersion));
    expect(commandVersions).toHaveLength(2);
    expect(commandVersions[1]).toBeGreaterThan(commandVersions[0]!);

    const rollbackCharacter = await createPublishedCharacter(app);
    const rollbackSession = createSession(app, rollbackCharacter.id);
    invalidReply = false;
    const rollbackProposal = await sendMessage(
      app,
      rollbackSession,
      rollbackCharacter.id,
      "cas-rollback-proposal",
      DIRECT_OFFER,
    );
    expect(rollbackProposal.statusCode).toBe(201);
    const pendingBefore =
      app.personasim.store.getActiveScheduleNegotiation(rollbackSession);
    expect(pendingBefore).toMatchObject({ status: "awaiting_confirmation" });
    const messagesBefore = app.personasim.store.listMessages(rollbackSession);
    const scheduleBefore = app.personasim.store.listSchedule(
      rollbackCharacter.id,
    );
    invalidReply = true;
    const compareAndSet = vi
      .spyOn(app.personasim.store, "compareAndSetScheduleNegotiation")
      .mockReturnValue(false);

    const failed = await sendMessage(
      app,
      rollbackSession,
      rollbackCharacter.id,
      "cas-rollback-confirmation",
      "确认",
    );

    expect(failed.statusCode).toBe(409);
    expect(compareAndSet).toHaveBeenCalledOnce();
    expect(app.personasim.store.listMessages(rollbackSession)).toEqual(
      messagesBefore,
    );
    expect(app.personasim.store.listSchedule(rollbackCharacter.id)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store.getActiveScheduleNegotiation(rollbackSession),
    ).toEqual(pendingBefore);
    expect(
      eventTypesFor(app, rollbackCharacter.id, "cas-rollback-confirmation"),
    ).toEqual([]);
    expect(purposeCount(calls, "chat_turn")).toBe(0);
    expect(purposeCount(calls, "reply_generation")).toBeGreaterThanOrEqual(4);
  });

  it("runs an audited reply-only dry-run in shadow without persisting split state or memory", async () => {
    const harness = await createHarness("shadow", "shadow");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const clientMessageId = "shadow-reply-dry-run";
    const shadowOnlyReply = "SHADOW-ONLY-REPLY-DO-NOT-PERSIST";
    const shadowOnlyMemory = "SHADOW-ONLY-MEMORY-DO-NOT-PERSIST";
    const stateBefore = app.personasim.store.getRuntimeState(harness.agentId);
    const scheduleBefore = app.personasim.store.listSchedule(harness.agentId);
    const negotiationsBefore = app.personasim.store.listScheduleNegotiations({
      sessionId,
    });
    const memoriesBefore = memoryCount(app, harness.agentId);
    const stateWrites = vi.spyOn(app.personasim.store, "updateRuntimeState");
    const contextPlans = app.personasim.kernel.registry.resolve(
      CONTEXT_PLAN_SERVICE_TOKEN,
    );
    const contextPlanBuild = vi.spyOn(contextPlans, "build");

    const turnUnderstandings = app.personasim.kernel.registry.resolve(
      TURN_UNDERSTANDING_SERVICE_TOKEN,
    );
    const understand = turnUnderstandings.understand.bind(turnUnderstandings);
    vi.spyOn(turnUnderstandings, "understand").mockImplementation(
      async (input) => {
        const resolved = await understand(input);
        return {
          ...resolved,
          confidence: 0.73,
          rejectedFields: [
            {
              field: "salientUserQuotes",
              reasonCode: "ungrounded_evidence_quote",
              reasonSummary: "Rejected an ungrounded observation field.",
            },
          ],
          worldEffectsValidation: validateWorldEffects(
            worldEffectObservation(shadowOnlyMemory).worldEffects,
          ),
        };
      },
    );

    const replyGenerations = app.personasim.kernel.registry.resolve(
      REPLY_GENERATION_SERVICE_TOKEN,
    );
    const generate = replyGenerations.generate.bind(replyGenerations);
    const replySpy = vi
      .spyOn(replyGenerations, "generate")
      .mockImplementation(async (input) => {
        expect(input.validatedOutcome.audit.dryRun).toBe(true);
        expect(input.validatedOutcome.scheduleWritesEnabled).toBe(false);
        expect(input.validatedOutcome.worldEffectWritesEnabled).toBe(false);
        expect(
          input.validatedOutcome.acceptedWorldEffects.memoryCandidates,
        ).toHaveLength(0);
        const generated = await generate(input);
        return {
          ...generated,
          reply: {
            ...generated.reply,
            text: shadowOnlyReply,
            chunks: [shadowOnlyReply],
          },
          response: {
            ...generated.response,
            text: shadowOnlyReply,
            chunks: [shadowOnlyReply],
          },
          repairAttempted: false,
          usedFallback: false,
          issues: [],
        };
      });

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      "今天有点累，只想聊聊近况。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(replySpy).toHaveBeenCalledOnce();
    expect(
      contextPlanBuild.mock.calls.some(
        ([planInput]) => planInput.outcome !== undefined,
      ),
    ).toBe(true);
    const authoritativePlanCall = contextPlanBuild.mock.calls.at(-1)?.[0];
    expect(authoritativePlanCall).toBeDefined();
    expect(authoritativePlanCall).not.toHaveProperty("outcome");
    expect(body.assistantMessage.content).not.toBe(shadowOnlyReply);
    expect(body.assistantMessage.content).not.toContain("SHADOW-ONLY");
    const stateAfter = app.personasim.store.getRuntimeState(harness.agentId);
    expect(stateAfter).toEqual(body.state);
    expect(stateWrites).toHaveBeenCalledOnce();
    expect(stateAfter?.revision).toBe((stateBefore?.revision ?? 0) + 1);
    expect(stateAfter?.energy).toBe(stateBefore?.energy);
    expect(app.personasim.store.listSchedule(harness.agentId)).toEqual(
      scheduleBefore,
    );
    expect(
      app.personasim.store.listScheduleNegotiations({ sessionId }),
    ).toEqual(negotiationsBefore);
    expect(memoryCount(app, harness.agentId)).toBe(memoriesBefore);

    const replyAudits = app.personasim.store
      .listLlmCalls(100)
      .filter(
        (call) =>
          call.agentId === harness.agentId &&
          call.purpose === "reply_generation",
      );
    expect(replyAudits).toHaveLength(1);
    expect(replyAudits[0]).toMatchObject({ success: true });

    const comparisonEvent = eventFor(
      app,
      harness.agentId,
      clientMessageId,
      "conversation.turn_pipeline_shadow_compared",
    );
    expect(comparisonEvent?.payload).toMatchObject({
      splitReplyStatus: "generated",
      splitReplyRepairAttempted: false,
      splitReplyUsedFallback: false,
      splitReplyIssueCodes: [],
      splitObservationConfidence: 0.73,
      splitObservationRejectedFields: [
        {
          field: "salientuserquotes",
          reasonCode: "ungrounded_evidence_quote",
        },
      ],
      splitScheduleOutcomeKind: "none",
      splitObjectiveReplyAligned: false,
      splitFailures: [],
      splitAcceptedEffectKinds: ["state_delta"],
    });
    const persistedAudit = JSON.stringify({
      event: comparisonEvent?.payload,
      metadata: body.assistantMessage.metadata.turnPipelineShadow,
    });
    expect(persistedAudit).not.toContain(shadowOnlyReply);
    expect(persistedAudit).not.toContain(shadowOnlyMemory);
    expect(persistedAudit).not.toMatch(
      /system|prompt|raw(?:Output|Json)|replyText/iu,
    );
  });

  it("keeps legacy repair on the independently filtered enforced persona context", async () => {
    const harness = await createHarness("off", "legacy");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const spec = app.personasim.store.getCharacterSpec(harness.agentId);
    if (spec === undefined) throw new Error("Expected a published character");
    const repairs = app.personasim.kernel.registry.resolve(
      REPLY_REPAIR_SERVICE_TOKEN,
    );
    const repair = vi.spyOn(repairs, "repairFixtureDecision");
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        if (input.purpose === "chat_turn") {
          throw new Error("force fixture repair");
        }
        if (input.purpose === "repair_chat_turn") {
          if (input.fixture === undefined) {
            throw new Error("Expected a bounded repair fixture");
          }
          return Promise.resolve(input.fixture as never);
        }
        return Promise.resolve(fixtureOrThrow(input) as never);
      },
    );

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      "legacy-filtered-repair",
      "今天天气不错，我们随便聊聊吧。",
    );

    expect(response.statusCode).toBe(201);
    expect(repair).toHaveBeenCalledOnce();
    const repairInput = repair.mock.calls[0]?.[0];
    expect(repairInput?.personaContext).toBeDefined();
    const serializedPersona = JSON.stringify(repairInput?.personaContext);
    expect(serializedPersona).not.toContain(spec.identity.selfDescription);
    expect(serializedPersona).not.toContain(spec.persona.goals[0]!.title);
  });

  it("isolates a shadow reply-generation failure from the legacy reply and records only a safe code", async () => {
    const harness = await createHarness("off", "shadow");
    app = harness.app;
    const sessionId = createSession(app, harness.agentId);
    const clientMessageId = "shadow-reply-failure-isolated";
    const rawFailureSecret = "RAW-REPLY-FAILURE-SECRET";
    const stateBefore = app.personasim.store.getRuntimeState(harness.agentId);
    const scheduleBefore = app.personasim.store.listSchedule(harness.agentId);
    const memoriesBefore = memoryCount(app, harness.agentId);
    const stateWrites = vi.spyOn(app.personasim.store, "updateRuntimeState");
    const replyGenerations = app.personasim.kernel.registry.resolve(
      REPLY_GENERATION_SERVICE_TOKEN,
    );
    vi.spyOn(replyGenerations, "generate").mockRejectedValue(
      new Error(`provider included ${rawFailureSecret}`),
    );

    const response = await sendMessage(
      app,
      sessionId,
      harness.agentId,
      clientMessageId,
      "今天想安静聊几句。",
    );

    expect(response.statusCode).toBe(201);
    const body = jsonBody<ChatTurnResult>(response);
    expect(body.assistantMessage.content).not.toContain(rawFailureSecret);
    const stateAfter = app.personasim.store.getRuntimeState(harness.agentId);
    expect(stateAfter).toEqual(body.state);
    expect(stateWrites).toHaveBeenCalledOnce();
    expect(stateAfter?.revision).toBe((stateBefore?.revision ?? 0) + 1);
    expect(app.personasim.store.listSchedule(harness.agentId)).toEqual(
      scheduleBefore,
    );
    expect(memoryCount(app, harness.agentId)).toBe(memoriesBefore);
    const comparisonEvent = eventFor(
      app,
      harness.agentId,
      clientMessageId,
      "conversation.turn_pipeline_shadow_compared",
    );
    expect(comparisonEvent?.payload).toMatchObject({
      splitReplyStatus: "failed",
      splitFailures: ["reply_generation:error"],
    });
    expect(JSON.stringify(comparisonEvent?.payload)).not.toContain(
      rawFailureSecret,
    );
  });
});

async function createHarness(
  liveWorldEffectsMode: "off" | "shadow" | "enforced" = "enforced",
  turnPipelineMode: "legacy" | "shadow" | "enforced" = "enforced",
  memoryRecallMode: "legacy" | "shadow" | "enforced" = "legacy",
): Promise<{
  app: PersonaSimApp;
  agentId: string;
}> {
  const config = readConfig({
    nodeEnv: "test",
    profile: "turn-pipeline-regression",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    turnPipelineMode,
    personaContextMode: "enforced",
    scheduleNegotiationMode: "enforced",
    liveWorldEffectsMode,
    memoryRecallMode,
    llm: {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
  });
  const app = await buildApp({
    config,
    database: openDatabase(":memory:"),
    clock: new FakeClock(START_UTC),
    seedDemo: false,
    startScheduler: false,
    logger: false,
  });
  const character = await createPublishedCharacter(app);
  return { app, agentId: character.id };
}

function memoryCount(app: PersonaSimApp, agentId: string): number {
  const row = app.personasim.store.database
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE agent_id = ?")
    .get(agentId) as { count: number };
  return row.count;
}

function careCueFor(
  app: PersonaSimApp,
  agentId: string,
):
  | {
      id: string;
      contextSummary: string;
      mentionGuidance: string;
      status: string;
    }
  | undefined {
  return app.personasim.store.database
    .prepare(
      `SELECT id,
              context_summary AS contextSummary,
              mention_guidance AS mentionGuidance,
              status
       FROM care_cues
       WHERE agent_id = ?
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(agentId) as
    | {
        id: string;
        contextSummary: string;
        mentionGuidance: string;
        status: string;
      }
    | undefined;
}

async function createPublishedCharacter(
  app: PersonaSimApp,
): Promise<{ id: string; version: number }> {
  const draft = app.personasim.characters.createDemoCharacter();
  const published = app.personasim.characters.publish(draft.id, draft.version);
  await app.personasim.schedules.ensure72Hours(published.id, true);
  return published;
}

function createSession(app: PersonaSimApp, agentId: string): string {
  return app.personasim.conversations.createSession(agentId).id;
}

function mockSplitLlm(
  llm: LlmService,
  calls: Array<GenerateObjectInput<unknown>>,
  responder: (input: GenerateObjectInput<unknown>) => unknown,
): void {
  vi.spyOn(llm, "generateObject").mockImplementation((input) => {
    calls.push(input);
    return Promise.resolve(responder(input) as never);
  });
}

function fixtureOrThrow(input: GenerateObjectInput<unknown>): unknown {
  if (input.fixture !== undefined) return input.fixture;
  throw new Error(`No test response for ${input.purpose}`);
}

function observation(input: {
  route: TurnObservationProposal["route"];
  dialogueActs?: TurnObservationProposal["dialogueActs"];
  scheduleIntent?: TurnObservationProposal["scheduleIntent"];
  topicKey?: string;
  topicDomain?: string;
  topicQuote?: string;
  salientQuotes?: string[];
  worldEffects?: TurnObservationProposal["worldEffects"];
}): TurnObservationProposal {
  return {
    schemaVersion: 1,
    route: input.route,
    dialogueActs: input.dialogueActs ?? ["inform"],
    topics:
      input.topicKey === undefined ||
      input.topicDomain === undefined ||
      input.topicQuote === undefined
        ? []
        : [
            {
              key: input.topicKey,
              domain: input.topicDomain,
              confidence: 0.95,
              evidenceQuotes: [{ text: input.topicQuote }],
            },
          ],
    scheduleIntent: input.scheduleIntent ?? { kind: "none" },
    worldEffects: input.worldEffects ?? {},
    salientUserQuotes: (input.salientQuotes ?? []).map((text) => ({ text })),
    uncertainty: [],
    confidence: 0.95,
  };
}

function worldEffectObservation(code: string): TurnObservationProposal {
  return observation({
    route: "conversation",
    worldEffects: {
      stateDelta: { energy: -0.1 },
      memoryCandidates: [
        {
          type: "user_fact",
          content: "用户今天感觉有点累",
          tags: ["test_trace", code],
          sourceMessageIds: [],
          sourceActivityEventIds: [],
        },
      ],
    },
  });
}

function directOfferObservation(
  timeQuote = "明天早上七点",
): TurnObservationProposal {
  return observation({
    route: "schedule_mutation",
    dialogueActs: ["invite"],
    topicKey: "一起去跑步",
    topicDomain: "exercise",
    topicQuote: "一起去跑步",
    salientQuotes: [timeQuote, "一起去跑步"],
    scheduleIntent: {
      kind: "create_shared_activity",
      activityQuote: { text: "一起去跑步" },
      timeQuote: { text: timeQuote },
      participantQuote: { text: "和我" },
      durationMinutes: 30,
      missingFields: [],
    },
  });
}

function sendMessage(
  app: PersonaSimApp,
  sessionId: string,
  agentId: string,
  clientMessageId: string,
  text: string,
) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/messages`,
    payload: { agentId, clientMessageId, text },
  });
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

function purposeCount(
  calls: readonly GenerateObjectInput<unknown>[],
  purpose: GenerateObjectInput<unknown>["purpose"],
): number {
  return calls.filter((call) => call.purpose === purpose).length;
}

function eventsFor(
  app: PersonaSimApp,
  agentId: string,
  clientMessageId: string,
): Array<Record<string, unknown>> {
  return app.personasim.store
    .listDomainEvents(agentId, 500)
    .filter((event) => event.correlationId === clientMessageId);
}

function eventTypesFor(
  app: PersonaSimApp,
  agentId: string,
  clientMessageId: string,
): string[] {
  return eventsFor(app, agentId, clientMessageId)
    .map((event) => String(event.eventType))
    .sort();
}

function scheduleEventsFor(
  app: PersonaSimApp,
  agentId: string,
  clientMessageId: string,
): string[] {
  return eventTypesFor(app, agentId, clientMessageId).filter(
    (eventType) =>
      eventType.startsWith("schedule.negotiation_") ||
      eventType === "schedule.command_committed",
  );
}

function eventFor(
  app: PersonaSimApp,
  agentId: string,
  clientMessageId: string,
  eventType: string,
): Record<string, unknown> | undefined {
  return eventsFor(app, agentId, clientMessageId).find(
    (event) => event.eventType === eventType,
  );
}

function canonicalOutcome(outcome: ValidatedTurnOutcome): unknown {
  return canonicalize(outcome, "");
}

function canonicalize(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item, key));
  }
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => {
      if (
        childKey === "id" ||
        childKey.endsWith("Id") ||
        childKey.endsWith("Ids") ||
        childKey === "createdAtUtc" ||
        childKey === "updatedAtUtc"
      ) {
        return [childKey, Array.isArray(childValue) ? [] : "<stable>"];
      }
      return [childKey, canonicalize(childValue, childKey)];
    }),
  );
}
