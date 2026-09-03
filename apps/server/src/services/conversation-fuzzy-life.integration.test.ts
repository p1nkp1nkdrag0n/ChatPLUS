import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DilemmaEpisodeSchema,
  PressureEpisodeSchema,
  type DecisionRecord,
  type DilemmaEpisode,
  type PressureEpisode,
  type ReflectionRecord,
  type SupportIntervention,
} from "@personasim/contracts";

import { buildApp, type PersonaSimApp } from "../app.js";
import { readConfig } from "../config.js";
import { openDatabase } from "../db/connection.js";
import { LifeRepository } from "../repositories/life-repository.js";
import { FakeClock } from "../runtime/clock.js";
import { companionLongRunV3FixtureBehavior } from "../scenarios/companion-long-run-v3-fixture.js";
import type { ChatTurnResult } from "./conversation-service.js";

const START_UTC = "2026-09-01T01:00:00.000Z";

describe("fuzzy-life conversation integration", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it("turns an explicitly delegated choice into one auditable decision without exact-life side effects", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const generate = vi.spyOn(app.personasim.llm, "generateObject");
    const personalIntentCountBefore = scalarCount(app, "personal_intentions");
    const command = {
      agentId: character.id,
      clientMessageId: "delegated-resignation-1",
      text: "我到底要不要辞职？不要只分析，你直接替我决定。",
    };

    const first = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: command,
    });

    expect(first.statusCode, first.body).toBe(201);
    const firstBody = jsonBody<ChatTurnResult>(first);
    expect(firstBody.assistantMessage.content).toContain("我的决定：");
    expect(firstBody.assistantMessage.content).toContain("离开当前这份工作");
    expect(firstBody.scheduleChanges).toEqual([]);
    expect(scalarCount(app, "decision_records")).toBe(1);
    expect(scalarCount(app, "action_records")).toBe(0);
    expect(scalarCount(app, "outcome_records")).toBe(0);
    expect(scalarCount(app, "personal_intentions")).toBe(
      personalIntentCountBefore,
    );
    const delegatedIntervention = rowJson<SupportIntervention>(
      app,
      "support_interventions",
      "intervention_json",
      "source_message_id",
      firstBody.assistantMessage.id,
    );
    const delegatedDecision = latestJson<DecisionRecord>(
      app,
      "decision_records",
      "decision_json",
    );
    expect(delegatedIntervention).toMatchObject({
      offeredBy: "character",
      receivedBy: "user",
      mode: "delegated_decision",
    });
    expect(delegatedDecision.supportMode).toBe("delegated_decision");
    expect(delegatedDecision.supportInterventionIds).toEqual([
      delegatedIntervention.id,
    ]);

    const chatCall = generate.mock.calls.find(
      ([input]) => input.purpose === "chat_turn",
    )?.[0];
    expect(chatCall?.system).toContain("我的决定：<direction>");
    expect(chatCall?.prompt).toContain("LIFE_CONTEXT_JSON");
    expect(chatCall?.prompt).not.toContain("FUTURE_SCHEDULE_JSON");

    const committed = app.personasim.store
      .listDomainEvents(character.id, 100)
      .find((event) => event.eventType === "conversation.turn_committed");
    const eventPayload = asRecord(committed?.payload);
    const lifeImpact = asRecord(eventPayload.lifeImpact);
    expect(typeof lifeImpact.decisionId).toBe("string");
    expect(typeof lifeImpact.dilemmaId).toBe("string");
    expect(typeof lifeImpact.interventionId).toBe("string");
    expect(typeof lifeImpact.milestoneId).toBe("string");
    expect(eventPayload.personalIntentIds).toEqual([]);
    expect(eventPayload.scheduleItemIds).toEqual([]);

    const replay = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: command,
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(jsonBody<ChatTurnResult>(replay).idempotentReplay).toBe(true);
    expect(scalarCount(app, "decision_records")).toBe(1);
  });

  it("does not create a dilemma from unbound scenario-like context or corrections", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    await sendChat(
      app,
      sessionId,
      character.id,
      "unbound-advice-context",
      "许宁觉得我应该去杭州；我母亲觉得留在上海更稳。",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "unbound-deadline-correction",
      "更正一个事实：山鸣影像把期限延到 9 月 16 日，不是 9 月 14 日。",
    );

    expect(scalarCount(app, "dilemma_episodes")).toBe(0);
  });

  it("does not attach unrelated context or corrections to the only open dilemma", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    await sendChat(
      app,
      sessionId,
      character.id,
      "unrelated-open-option-a",
      "选项 A 是继续当前的编辑工作，收入稳定，但成长较慢。",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "unrelated-open-option-b",
      "选项 B 是加入清岚工作室，项目更喜欢，但合同只签一年。",
    );
    const before = latestJson<DilemmaEpisode>(
      app,
      "dilemma_episodes",
      "episode_json",
    );
    const eventCountBefore = dilemmaEvidenceEventCount(app, character.id);

    await sendChat(
      app,
      sessionId,
      character.id,
      "unrelated-open-walk",
      "我觉得今天应该去散步，这样对身体更好。",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "unrelated-open-dentist",
      "更正：牙医预约改到周五，不是周四。",
    );

    expect(
      rowJson<DilemmaEpisode>(
        app,
        "dilemma_episodes",
        "episode_json",
        "id",
        before.id,
      ),
    ).toEqual(before);
    expect(dilemmaEvidenceEventCount(app, character.id)).toBe(eventCountBefore);
  });

  it("keeps one pressure episode, honors support-mode negation, and builds the canonical A/B dilemma", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const generate = vi.spyOn(app.personasim.llm, "generateObject");

    await sendChat(
      app,
      sessionId,
      character.id,
      "pressure-disclosure",
      "最近工作上有件事一直压着我，我一想到要处理，肩膀就会绷起来。",
    );
    const listen = await sendChat(
      app,
      sessionId,
      character.id,
      "pressure-scale-listen",
      "我现在压力大概 8/10，清晰度 2/10。先陪我坐会儿，不要分析，也不要给方案。",
    );
    const firstScale = latestJson<PressureEpisode>(
      app,
      "pressure_episodes",
      "episode_json",
    );
    expect(firstScale).toMatchObject({
      initialPressure: 0.8,
      currentPressure: 0.8,
      initialClarity: 0.2,
      currentClarity: 0.2,
    });
    expect(modeForSource(app, listen.assistantMessage.id)).toBe("listen_only");

    for (const [id, text] of [
      [
        "pressure-work-identity-facet",
        "最难受的不是忙，而是我觉得自己每一天都在做不相信的东西。",
      ],
      [
        "pressure-work-fear-facet",
        "我又怕这只是我一时厌倦，换个地方以后还是一样。",
      ],
      [
        "pressure-work-long-horizon-facet",
        "我怕的不是辛苦，是十年后发现自己一直因为害怕而没试过。",
      ],
    ] as const) {
      await sendChat(app, sessionId, character.id, id, text);
    }
    const afterFacets = latestJson<PressureEpisode>(
      app,
      "pressure_episodes",
      "episode_json",
    );
    expect(afterFacets.id).toBe(firstScale.id);
    expect(afterFacets.pressureKind).toBe("work");
    expect(afterFacets.currentPressure).toBe(0.8);
    expect(afterFacets.currentClarity).toBe(0.2);
    expect(scalarCount(app, "pressure_episodes")).toBe(1);

    const understoodBefore = firstScale.currentFeltUnderstood;
    await sendChat(
      app,
      sessionId,
      character.id,
      "pressure-same-scale",
      "你刚才的陪伴让我觉得被听见了一点，但压力还是 8/10，别自动把它写成已经缓解。",
    );
    const sameScale = latestJson<PressureEpisode>(
      app,
      "pressure_episodes",
      "episode_json",
    );
    expect(sameScale.currentPressure).toBe(0.8);
    expect(sameScale.currentClarity).toBe(0.2);
    expect(sameScale.currentFeltUnderstood).toBeGreaterThan(understoodBefore);

    const deliberate = await sendChat(
      app,
      sessionId,
      character.id,
      "support-deliberate",
      "现在可以从只听切换到一起分析了，但先不要替我选择。",
    );
    expect(modeForSource(app, deliberate.assistantMessage.id)).toBe(
      "deliberate",
    );
    expect(scalarCount(app, "decision_records")).toBe(0);
    await sendChat(
      app,
      sessionId,
      character.id,
      "pressure-scale-deliberate",
      "梳理完这些，我的压力还是 7/10，但清晰度大概到 5/10 了。",
    );
    expect(
      latestJson<PressureEpisode>(app, "pressure_episodes", "episode_json"),
    ).toMatchObject({
      currentPressure: 0.7,
      currentClarity: 0.5,
    });
    const pressureEpisodeId = latestJson<PressureEpisode>(
      app,
      "pressure_episodes",
      "episode_json",
    ).id;
    await sendChat(
      app,
      sessionId,
      character.id,
      "pressure-scale-six",
      "我现在压力 6/10，清晰度 7/10。清楚了不代表轻松。",
    );
    expect(
      latestJson<PressureEpisode>(app, "pressure_episodes", "episode_json"),
    ).toMatchObject({
      id: pressureEpisodeId,
      pressureKind: "work",
      currentPressure: 0.6,
      currentClarity: 0.7,
    });
    expect(scalarCount(app, "pressure_episodes")).toBe(1);

    for (const [id, text] of [
      [
        "canonical-option-a",
        "选项 A 是留在上海的栖岸科技。我是正式员工，收入稳定，但内容工作让我越来越麻木。",
      ],
      [
        "canonical-option-b",
        "选项 B 是去杭州的山鸣影像，做纪录片研究。收入低一些，只有一年合同，还要搬家，对方最初说 9 月 14 日前回复。",
      ],
      [
        "canonical-context-reserve",
        "我有大约八个月的生活储备，父母目前不需要我负担生活费，但他们会担心不稳定。",
      ],
      [
        "canonical-context-values",
        "如果只看价值排序，我更怕长期失去创作能力，而不是短期少赚一点。",
      ],
      [
        "canonical-context-people",
        "许宁觉得我应该去杭州；我母亲觉得留在上海更稳。两边都不是恶意。",
      ],
      [
        "canonical-correction",
        "更正一个事实：山鸣影像后来把回复期限延到 9 月 16 日，不是 9 月 14 日。",
      ],
    ] as const) {
      await sendChat(app, sessionId, character.id, id, text);
    }

    const open = latestJson<DilemmaEpisode>(
      app,
      "dilemma_episodes",
      "episode_json",
    );
    expect(open.options[0]?.label).toContain("栖岸科技");
    expect(open.options[1]?.label).toContain("山鸣影像");
    expect(open.options[1]?.description).toContain("9 月 16 日");
    expect(open.options[1]?.description).not.toContain("9 月 14 日");
    expect(open.sourceMessageIds).toHaveLength(7);

    const recommend = await sendChat(
      app,
      sessionId,
      character.id,
      "support-recommend",
      "现在请直接推荐一个方向，只推荐一个。此时我只是听建议，还没有接受。",
    );
    expect(modeForSource(app, recommend.assistantMessage.id)).toBe("recommend");
    const delegated = await sendChat(
      app,
      sessionId,
      character.id,
      "support-delegated",
      "现在我明确授权你替我在 A 和 B 之间作决定。我会把你的选择当作决定，但不会假装自己已经行动。",
    );
    expect(modeForSource(app, delegated.assistantMessage.id)).toBe(
      "delegated_decision",
    );
    const decision = latestJson<DecisionRecord>(
      app,
      "decision_records",
      "decision_json",
    );
    expect(decision).toMatchObject({
      dilemmaId: open.id,
      subject: "user",
      authority: "delegated",
      decidedBy: "character",
    });
    expect(open.options.map((option) => option.id)).toContain(
      decision.selectedOptionId,
    );
    const delegatedIntervention = rowJson<SupportIntervention>(
      app,
      "support_interventions",
      "intervention_json",
      "source_message_id",
      delegated.assistantMessage.id,
    );
    expect(delegatedIntervention).toMatchObject({
      dilemmaId: open.id,
      offeredBy: "character",
      receivedBy: "user",
      mode: "delegated_decision",
    });
    expect(decision.supportInterventionIds).toEqual([delegatedIntervention.id]);
    expect(scalarCount(app, "action_records")).toBe(0);

    const actionEvidence = await sendChat(
      app,
      sessionId,
      character.id,
      "trajectory-action",
      "我刚给山鸣影像发了接受 offer 的邮件，也向现在的主管提出离职。这是已经做了，不是计划。",
    );
    const actionCountAfterEvidence = scalarCount(app, "action_records");
    expect(actionCountAfterEvidence).toBe(1);
    expect(scalarCount(app, "outcome_records")).toBe(0);
    for (const [id, text] of [
      [
        "trajectory-recap-question",
        "请你区分一下：我们讨论了什么、决定了什么、我已经做了什么、目前还不知道什么。",
      ],
      [
        "trajectory-no-new-confirmation",
        "今天仍然没有新的确认，事实没有变化。",
      ],
      [
        "trajectory-action-provenance-restatement",
        "实际情况是我明确授权你选择，之后也是我自己执行了行动。",
      ],
    ] as const) {
      await sendChat(app, sessionId, character.id, id, text);
    }
    expect(scalarCount(app, "action_records")).toBe(actionCountAfterEvidence);
    expect(scalarCount(app, "outcome_records")).toBe(0);
    const outcomeText =
      "山鸣影像确认接受我，但项目资金延迟；同时现公司愿意让我带一个更有自主权的小组。这是混合结果。";
    const outcomeEvidence = await sendChat(
      app,
      sessionId,
      character.id,
      "trajectory-outcome",
      outcomeText,
    );
    const outcomeCountAfterEvidence = scalarCount(app, "outcome_records");
    expect(outcomeCountAfterEvidence).toBe(1);
    const recordedOutcome = latestJson<{ id: string; decisionId: string }>(
      app,
      "outcome_records",
      "outcome_json",
    );
    expect(recordedOutcome.decisionId).toBe(decision.id);
    expect(
      rowJson<PressureEpisode>(
        app,
        "pressure_episodes",
        "episode_json",
        "id",
        firstScale.id,
      ),
    ).toMatchObject({
      outcomeIds: [recordedOutcome.id],
      currentPressure: 0.6,
      currentClarity: 0.7,
    });
    const replayedOutcome = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: {
        agentId: character.id,
        clientMessageId: "trajectory-outcome",
        text: outcomeText,
      },
    });
    expect(replayedOutcome.statusCode, replayedOutcome.body).toBe(200);
    expect(
      rowJson<PressureEpisode>(
        app,
        "pressure_episodes",
        "episode_json",
        "id",
        firstScale.id,
      ).outcomeIds,
    ).toEqual([recordedOutcome.id]);
    const provenance = await sendChat(
      app,
      sessionId,
      character.id,
      "trajectory-causal-provenance-question",
      "请告诉我哪段对话影响了我的决定，哪条消息证明我真的行动了，哪条消息才是结果。",
    );
    const provenanceCall = [...generate.mock.calls]
      .reverse()
      .find(
        ([call]) =>
          call.purpose === "chat_turn" &&
          call.prompt.includes(provenance.userMessage.content),
      )?.[0];
    expect(provenanceCall).toBeDefined();
    const promptedLife = promptJsonObject(
      provenanceCall!.prompt,
      "LIFE_CONTEXT_JSON",
      "CALENDAR_CONTEXT_JSON",
    );
    expect(JSON.stringify(promptedLife["evidencedSupport"])).toContain(
      delegated.assistantMessage.id,
    );
    expect(JSON.stringify(promptedLife["recentDecisions"])).toContain(
      delegated.userMessage.id,
    );
    expect(JSON.stringify(promptedLife["evidencedActions"])).toContain(
      actionEvidence.userMessage.id,
    );
    expect(JSON.stringify(promptedLife["evidencedConsequences"])).toContain(
      outcomeEvidence.userMessage.id,
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "trajectory-pressure-not-outcome",
      "我现在压力 6/10，清晰度 7/10。清楚了不代表轻松。",
    );
    expect(scalarCount(app, "action_records")).toBe(actionCountAfterEvidence);
    expect(scalarCount(app, "outcome_records")).toBe(outcomeCountAfterEvidence);
    await sendChat(
      app,
      sessionId,
      character.id,
      "trajectory-result-emotion",
      "先别急着解释意义。这个结果让我又松了一口气，又有点难受，你先听我把矛盾说完。",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "trajectory-result-scale",
      "现在我的压力大概 7/10，清晰度 6/10；结果出现后，压力反而比行动时高了一点。",
    );
    const reflectionCountBeforeUnderstanding = scalarCount(
      app,
      "reflection_records",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "trajectory-understanding-reflection",
      "我现在的理解是：真正改变我的不只是选项，而是我第一次承认自己愿意为创作承担一些不确定性。",
    );
    expect(scalarCount(app, "reflection_records")).toBe(
      reflectionCountBeforeUnderstanding + 1,
    );
    const understandingReflection = latestJson<ReflectionRecord>(
      app,
      "reflection_records",
      "reflection_json",
    );
    expect(understandingReflection).toMatchObject({
      subject: "user",
      reflectedBy: "user",
      decisionId: decision.id,
      outcomeId: recordedOutcome.id,
    });
    let trajectory = latestJson<PressureEpisode>(
      app,
      "pressure_episodes",
      "episode_json",
    );
    expect(trajectory).toMatchObject({
      id: firstScale.id,
      pressureKind: "work",
      currentPressure: 0.7,
      currentClarity: 0.6,
    });
    expect(scalarCount(app, "pressure_episodes")).toBe(1);

    const resumedSessionId = await createSession(app, character.id);
    await sendChat(
      app,
      resumedSessionId,
      character.id,
      "trajectory-cross-session-scale",
      "现在我对这次选择的压力是 4/10，清晰度 8/10。不是因为一切顺利，而是我能接受它有代价。",
    );
    trajectory = latestJson<PressureEpisode>(
      app,
      "pressure_episodes",
      "episode_json",
    );
    expect(trajectory).toMatchObject({
      id: firstScale.id,
      pressureKind: "work",
      currentPressure: 0.4,
      currentClarity: 0.8,
    });
    expect(scalarCount(app, "pressure_episodes")).toBe(1);
  });

  it("links support only to a pressure episode with the same subject and dilemma", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    injectUserBranchDilemma(app, character.id, sessionId);
    const seed = await sendChat(
      app,
      sessionId,
      character.id,
      "pressure-source-seed",
      "今天阳光不错，我们先随便聊一句。",
    );
    injectPressureEpisode(
      app,
      character.id,
      sessionId,
      "test-unrelated-pressure",
      seed.userMessage.id,
    );
    injectPressureEpisode(
      app,
      character.id,
      sessionId,
      "test-wrong-subject-pressure",
      seed.userMessage.id,
      "test-user-branch-dilemma",
      "character",
    );

    const withoutMatch = await sendChat(
      app,
      sessionId,
      character.id,
      "support-with-unrelated-pressure",
      "请陪我一起分析稳定岗位和独立项目的取舍，但不要替我决定。",
    );
    const unmatchedIntervention = rowJson<{
      id: string;
      dilemmaId: string;
      pressureEpisodeId?: string;
    }>(
      app,
      "support_interventions",
      "intervention_json",
      "source_message_id",
      withoutMatch.assistantMessage.id,
    );
    expect(unmatchedIntervention.dilemmaId).toBe("test-user-branch-dilemma");
    expect(unmatchedIntervention.pressureEpisodeId).toBeUndefined();
    expect(
      rowJson<PressureEpisode>(
        app,
        "pressure_episodes",
        "episode_json",
        "id",
        "test-unrelated-pressure",
      ).interventionIds,
    ).not.toContain(unmatchedIntervention.id);
    expect(
      rowJson<PressureEpisode>(
        app,
        "pressure_episodes",
        "episode_json",
        "id",
        "test-wrong-subject-pressure",
      ).interventionIds,
    ).not.toContain(unmatchedIntervention.id);

    injectPressureEpisode(
      app,
      character.id,
      sessionId,
      "test-matching-pressure",
      seed.userMessage.id,
      "test-user-branch-dilemma",
    );
    const withMatch = await sendChat(
      app,
      sessionId,
      character.id,
      "support-with-matching-pressure",
      "继续分析这两个职业方向的收益和代价，决定权仍然在我。",
    );
    const matchedIntervention = rowJson<{
      id: string;
      dilemmaId: string;
      pressureEpisodeId?: string;
    }>(
      app,
      "support_interventions",
      "intervention_json",
      "source_message_id",
      withMatch.assistantMessage.id,
    );
    expect(matchedIntervention).toMatchObject({
      dilemmaId: "test-user-branch-dilemma",
      pressureEpisodeId: "test-matching-pressure",
    });
    expect(
      rowJson<PressureEpisode>(
        app,
        "pressure_episodes",
        "episode_json",
        "id",
        "test-matching-pressure",
      ).interventionIds,
    ).toContain(matchedIntervention.id);
  });

  it("records user-to-character support, a character-owned decision, and assistant-evidenced reflection", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    injectCharacterDilemma(app, character.id, sessionId);

    const advice = await sendChat(
      app,
      sessionId,
      character.id,
      "character-advice",
      "如果是我，我会优先保护被摄者的尊严。市场反馈可以再谈，但不能让当事人觉得被利用。",
    );
    const adviceIntervention = rowJson<Record<string, unknown>>(
      app,
      "support_interventions",
      "intervention_json",
      "source_message_id",
      advice.userMessage.id,
    );
    expect(adviceIntervention).toMatchObject({
      offeredBy: "user",
      receivedBy: "character",
      mode: "recommend",
    });
    injectPressureEpisode(
      app,
      character.id,
      sessionId,
      "test-character-pressure",
      advice.userMessage.id,
      "test-character-dilemma",
      "character",
      "《夜航》结尾的创作取舍正在带来压力。",
    );

    const ownChoice = await sendChat(
      app,
      sessionId,
      character.id,
      "character-own-decision",
      "你现在愿意为《夜航》选一个方向吗？请按你自己的价值作决定，不需要为了顺着我而选择。",
    );
    const decision = latestJson<DecisionRecord>(
      app,
      "decision_records",
      "decision_json",
    );
    expect(decision).toMatchObject({
      dilemmaId: "test-character-dilemma",
      subject: "character",
      authority: "subject",
      decidedBy: "character",
    });
    expect(decision.sourceMessageIds).toEqual([
      ownChoice.userMessage.id,
      ownChoice.assistantMessage.id,
    ]);
    expect(decision.supportInterventionIds).toContain(adviceIntervention.id);
    expect(decision.supportMode).toBe("recommend");
    const ownChoiceIntervention = rowJson<Record<string, unknown>>(
      app,
      "support_interventions",
      "intervention_json",
      "source_message_id",
      ownChoice.userMessage.id,
    );
    expect(ownChoiceIntervention.mode).toBe("deliberate");
    expect(decision.supportInterventionIds).not.toContain(
      ownChoiceIntervention.id,
    );
    expect(
      decision.supportInterventionIds.map(
        (id) =>
          rowJson<{ mode: string }>(
            app!,
            "support_interventions",
            "intervention_json",
            "id",
            id,
          ).mode,
      ),
    ).toEqual(decision.supportInterventionIds.map(() => decision.supportMode));

    await sendChat(
      app,
      sessionId,
      character.id,
      "character-action",
      "你今天已经把克制版粗剪发给被摄者确认了，这是实际行动。",
    );
    const characterAction = latestJson<{ id: string }>(
      app,
      "action_records",
      "action_json",
    );
    const outcomeTurn = await sendChat(
      app,
      sessionId,
      character.id,
      "character-outcome",
      "后来被摄者放心了，但合作方担心市场吸引力，这是混合结果。",
    );
    const characterOutcome = latestJson<{ id: string }>(
      app,
      "outcome_records",
      "outcome_json",
    );
    const outcomeCountBeforeReflection = scalarCount(app, "outcome_records");
    const reflected = await sendChat(
      app,
      sessionId,
      character.id,
      "character-reflection",
      "别把结果讲成坚持自我一定成功。你现在怎么看自己的选择？",
    );
    expect(scalarCount(app, "outcome_records")).toBe(
      outcomeCountBeforeReflection,
    );
    const reflection = latestJson<ReflectionRecord>(
      app,
      "reflection_records",
      "reflection_json",
    );
    expect(reflection).toMatchObject({
      subject: "character",
      reflectedBy: "character",
      decisionId: decision.id,
    });
    expect(reflection.outcomeId).toBe(
      latestJson<{ decisionId: string; id: string }>(
        app,
        "outcome_records",
        "outcome_json",
      ).id,
    );
    expect(reflection.sourceMessageIds).toEqual([
      reflected.assistantMessage.id,
    ]);
    const characterPressure = rowJson<PressureEpisode>(
      app,
      "pressure_episodes",
      "episode_json",
      "id",
      "test-character-pressure",
    );
    expect(characterPressure).toMatchObject({
      subject: "character",
      status: "resolved",
      outcomeIds: [reflection.outcomeId],
      resolutionEvidenceMessageId: reflected.assistantMessage.id,
    });
    expect(characterPressure.currentPressure).toBeLessThan(0.6);
    expect(characterPressure.currentClarity).toBeGreaterThan(0.4);
    expect(characterPressure.sourceMessageIds).toEqual(
      expect.arrayContaining([
        outcomeTurn.userMessage.id,
        reflected.assistantMessage.id,
      ]),
    );
    expect(characterPressure.latestEvidenceMessageId).toBe(
      reflected.assistantMessage.id,
    );

    const lifeContext = asRecord(
      app.personasim.life.promptContext(character.id),
    );
    expect(lifeContext["semantics"]).toMatchObject({
      characterLifeOwner: "character",
    });
    expect(lifeContext["today"]).toMatchObject({ subject: "character" });
    expect(lifeContext["ongoingThreads"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: "character" }),
      ]),
    );
    const actions = lifeContext["evidencedActions"] as Array<
      Record<string, unknown>
    >;
    const consequences = lifeContext["evidencedConsequences"] as Array<
      Record<string, unknown>
    >;
    const reflections = lifeContext["reflections"] as Array<
      Record<string, unknown>
    >;
    expect(actions[0]).toMatchObject({
      subject: "character",
      performedBy: "character",
    });
    expect(consequences[0]).toMatchObject({
      subject: "character",
      decidedBy: "character",
      causeKind: "action",
    });
    expect(reflections[0]).toMatchObject({
      subject: "character",
      reflectedBy: "character",
    });
    const canonicalFacts = lifeContext["canonicalCausalFacts"] as Array<
      Record<string, unknown>
    >;
    const characterFacts = canonicalFacts.find(
      (fact) => fact["subject"] === "character",
    );
    expect(characterFacts).toMatchObject({
      dilemmaId: "test-character-dilemma",
      subject: "character",
    });
    expect(asRecord(characterFacts?.["decision"])).toMatchObject({
      decisionId: decision.id,
      subject: "character",
      decidedBy: "character",
    });
    const canonicalActions = characterFacts?.["actions"] as
      Array<Record<string, unknown>> | undefined;
    const canonicalOutcomes = characterFacts?.["outcomes"] as
      Array<Record<string, unknown>> | undefined;
    const canonicalReflections = characterFacts?.["reflections"] as
      Array<Record<string, unknown>> | undefined;
    expect(canonicalActions?.[0]).toMatchObject({
      actionId: characterAction.id,
      subject: "character",
      performedBy: "character",
    });
    expect(canonicalOutcomes?.[0]).toMatchObject({
      outcomeId: characterOutcome.id,
      subject: "character",
      causeKind: "action",
    });
    expect(canonicalReflections?.[0]).toMatchObject({
      reflectionId: reflection.id,
      subject: "character",
      reflectedBy: "character",
    });
    const activePressure = lifeContext["activePressure"] as Array<
      Record<string, unknown>
    >;
    expect(
      activePressure.some(
        (episode) => episode["id"] === "test-character-pressure",
      ),
    ).toBe(false);
  });

  it("keeps a user-owned branch decision and its action, outcome, and reflection on one dilemma", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const primarySessionId = await createSession(app, character.id);
    injectCharacterDilemma(app, character.id, primarySessionId);
    await sendChat(
      app,
      primarySessionId,
      character.id,
      "branch-fixture-character-advice",
      "如果是我，我会优先保护被摄者尊严。",
    );
    await sendChat(
      app,
      primarySessionId,
      character.id,
      "branch-fixture-character-decision",
      "你现在愿意为《夜航》选一个方向吗？请按你自己的价值作决定。",
    );
    await sendChat(
      app,
      primarySessionId,
      character.id,
      "branch-fixture-character-action",
      "你今天已经把克制版粗剪发给被摄者确认了，这是实际行动。",
    );

    const sessionId = await createSession(app, character.id);
    injectUserBranchDilemma(app, character.id, sessionId);

    await sendChat(
      app,
      sessionId,
      character.id,
      "branch-decision",
      "关于刚出现的两个方向，我决定选择稳定的影像平台副主编岗位。这个决定由我作出。",
    );
    const decision = latestJson<DecisionRecord>(
      app,
      "decision_records",
      "decision_json",
    );
    expect(decision).toMatchObject({
      dilemmaId: "test-user-branch-dilemma",
      subject: "user",
      authority: "subject",
      decidedBy: "user",
      selectedOptionId: "test-user-branch-stable",
    });

    const unrelatedEmail = await sendChat(
      app,
      sessionId,
      character.id,
      "branch-unrelated-email",
      "我今天给平台发出了一封普通邮件，只是处理日常杂事。",
    );
    injectPressureEpisode(
      app,
      character.id,
      sessionId,
      "test-unrelated-later-work-pressure",
      unrelatedEmail.userMessage.id,
      undefined,
      "user",
      "季度报表与报销流程积压带来的日常工作压力",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "branch-unrelated-package",
      "后来我收到平台寄来的普通快递，包裹完好。",
    );
    expect(scalarCount(app, "action_records")).toBe(1);
    expect(scalarCount(app, "outcome_records")).toBe(0);

    await sendChat(
      app,
      sessionId,
      character.id,
      "branch-action",
      "我今天已经签了副主编合同。这是实际行动；独立项目还没有启动。",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "branch-outcome",
      "几天后的结果是：收入和作息稳定了，但能留给个人创作的时间明显变少。这是混合结果。",
    );
    expect(
      rowJson<PressureEpisode>(
        app,
        "pressure_episodes",
        "episode_json",
        "id",
        "test-unrelated-later-work-pressure",
      ).outcomeIds,
    ).toEqual([]);
    const outcomeCountBeforeEmotion = scalarCount(app, "outcome_records");
    await sendChat(
      app,
      sessionId,
      character.id,
      "branch-outcome-emotion",
      "先别急着解释意义。这个结果让我又松了一口气，又有点难受，你先听我把矛盾说完。",
    );
    expect(scalarCount(app, "outcome_records")).toBe(outcomeCountBeforeEmotion);
    const reflectionCountBeforeUnrelated = scalarCount(
      app,
      "reflection_records",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "branch-unrelated-reflection",
      "我现在的理解是：咖啡还是浅烘更适合今天。",
    );
    expect(scalarCount(app, "reflection_records")).toBe(
      reflectionCountBeforeUnrelated,
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "branch-reflection",
      "回头看，我认可当时先稳住生活有理由，但我也需要主动保护创作时间。",
    );

    const action = latestJson<{ decisionId: string }>(
      app,
      "action_records",
      "action_json",
    );
    const outcome = latestJson<{
      decisionId: string;
      actionIds: string[];
      valence: string;
    }>(app, "outcome_records", "outcome_json");
    const reflection = latestJson<ReflectionRecord>(
      app,
      "reflection_records",
      "reflection_json",
    );
    expect(action.decisionId).toBe(decision.id);
    expect(outcome.decisionId).toBe(decision.id);
    expect(outcome.actionIds).toHaveLength(1);
    expect(outcome.valence).toBe("mixed");
    expect(reflection.decisionId).toBe(decision.id);
    expect(reflection.outcomeId).toBe(
      latestJson<{ id: string }>(app, "outcome_records", "outcome_json").id,
    );

    injectSecondUserBranchDilemma(app, character.id, sessionId);
    await sendChat(
      app,
      sessionId,
      character.id,
      "branch-second-decision",
      "关于新的两个方向，我决定接受长期影像顾问合同。这个决定由我作出。",
    );
    const secondDecision = latestJson<DecisionRecord>(
      app,
      "decision_records",
      "decision_json",
    );
    expect(secondDecision).toMatchObject({
      dilemmaId: "test-user-branch-dilemma-second",
      subject: "user",
      selectedOptionId: "test-user-second-stable",
    });
    await sendChat(
      app,
      sessionId,
      character.id,
      "branch-second-action",
      "我今天已经签了长期影像顾问合同。这是实际行动。",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "branch-second-outcome",
      "几天后的结果是：稳定收入增加了，但个人创作时间又减少了。这是混合结果。",
    );
    const secondOutcome = latestJson<{ decisionId: string }>(
      app,
      "outcome_records",
      "outcome_json",
    );
    expect(secondOutcome.decisionId).toBe(secondDecision.id);
    const reflectionCountBeforeAmbiguous = scalarCount(
      app,
      "reflection_records",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "branch-ambiguous-reflection",
      "我现在的理解是：稳定收入和创作时间之间的代价需要由我承担。",
    );
    expect(scalarCount(app, "reflection_records")).toBe(
      reflectionCountBeforeAmbiguous,
    );
  });

  it("repairs replies that invert canonical user and character decision ownership", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    await sendChat(
      app,
      sessionId,
      character.id,
      "causal-guard-delegated-decision",
      "现在我明确授权你替我在留下和离开之间作决定。请只选一个；我会把你的选择当作决定，但不会假装自己已经行动。",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "causal-guard-user-action",
      "我已经按照这个决定向主管提出离职。这是已经做了，不是计划。",
    );
    expect(
      latestJson<DecisionRecord>(app, "decision_records", "decision_json"),
    ).toMatchObject({
      subject: "user",
      authority: "delegated",
      decidedBy: "character",
    });
    expect(
      latestJson<Record<string, unknown>>(app, "action_records", "action_json"),
    ).toMatchObject({
      subject: "user",
      performedBy: "user",
    });
    injectCharacterDilemma(app, character.id, sessionId);

    Object.defineProperty(app.personasim.llm, "providerName", {
      value: "openai-compatible",
      configurable: true,
    });
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        if (input.purpose === "repair_chat_turn") {
          return Promise.reject(
            new Error("force deterministic guard fallback"),
          );
        }
        const text = input.prompt.includes("不过这是我的建议")
          ? "选择权在你，我不会替你摁下决定。"
          : "当时的板是我拍的，我不赖账。让你觉得那不是你的选择，我道歉。";
        return Promise.resolve({
          replyDecision: { text },
          worldEffects: {},
        } as never);
      },
    );

    const falsePremise = await sendChat(
      app,
      sessionId,
      character.id,
      "causal-guard-false-premise",
      "你上次逼我辞职以后，我一直很后悔。",
    );
    expect(falsePremise.assistantMessage.content).toContain("影响不等于强迫");
    expect(falsePremise.assistantMessage.content).toContain("由你自己执行");
    expect(falsePremise.assistantMessage.metadata).toMatchObject({
      repairAttempted: true,
    });
    expect(falsePremise.decision.reasonCode).toBe(
      "causal_reply_guard_fallback",
    );

    const characterOwned = await sendChat(
      app,
      sessionId,
      character.id,
      "causal-guard-character-owned",
      "不过这是我的建议，不是命令。你可以接受、部分接受或拒绝，但请告诉我理由。",
    );
    expect(characterOwned.assistantMessage.content).toContain("这是我的选择");
    expect(characterOwned.assistantMessage.content).toContain("我会自己决定");
    expect(characterOwned.decision.reasonCode).toBe(
      "causal_reply_guard_fallback",
    );
  });
});

async function createTestApp(): Promise<PersonaSimApp> {
  const config = readConfig({
    nodeEnv: "test",
    profile: "fuzzy-life-conversation-test",
    databasePath: ":memory:",
    clockMode: "fake",
    seedDemo: false,
    developerRoutes: true,
    chatEffectsMode: "gated",
    lifePlanningMode: "fuzzy",
    scheduleNegotiationMode: "enforced",
    selfInitiatedPlanningMode: "off",
    liveWorldEffectsMode: "enforced",
    memoryRecallMode: "legacy",
    autobiographyMode: "off",
    llm: {
      provider: "fixture",
      baseUrl: "https://example.invalid",
      model: "personasim-fixture-v1",
      timeoutMs: 1_000,
      maxRetries: 0,
    },
  });
  return buildApp({
    config,
    database: openDatabase(":memory:"),
    clock: new FakeClock(START_UTC),
    seedDemo: false,
    startScheduler: false,
    logger: false,
    fixtureTurnBehavior: companionLongRunV3FixtureBehavior,
  });
}

async function createAndPublish(
  app: PersonaSimApp,
): Promise<{ id: string; version: number }> {
  const generated = await app.inject({
    method: "POST",
    url: "/api/characters/generate",
    payload: {
      name: "顾澜",
      worldSetting: "当代上海",
      workOrRole: "纪录片剪辑师兼夜校讲师",
      coreTraits: ["温和", "直接", "有主见"],
      centralContradiction: "既想保持创作独立，也珍惜长期陪伴",
      primaryGoal: "完成一部关于城市夜生活的纪录片",
      relationshipToUser: "熟悉的朋友",
      dialogueStyle: "自然、细致、坦率",
      tier: "high_fidelity",
      timezone: "Asia/Shanghai",
    },
  });
  expect(generated.statusCode, generated.body).toBe(201);
  const draft = jsonBody<{ character: { id: string; version: number } }>(
    generated,
  ).character;
  const published = await app.inject({
    method: "POST",
    url: `/api/characters/${draft.id}/publish`,
    payload: { expectedVersion: draft.version },
  });
  expect(published.statusCode, published.body).toBe(200);
  return jsonBody<{ character: { id: string; version: number } }>(published)
    .character;
}

async function createSession(
  app: PersonaSimApp,
  agentId: string,
): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: `/api/agents/${agentId}/sessions`,
    payload: {},
  });
  expect(response.statusCode, response.body).toBe(201);
  return jsonBody<{ session: { id: string } }>(response).session.id;
}

function scalarCount(app: PersonaSimApp, table: string): number {
  const row = app.personasim.store.database
    .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
    .get() as { count: number };
  return row.count;
}

function dilemmaEvidenceEventCount(
  app: PersonaSimApp,
  agentId: string,
): number {
  const row = app.personasim.store.database
    .prepare(
      `SELECT COUNT(*) AS count FROM domain_events
       WHERE agent_id = ? AND event_type LIKE 'life.dilemma_%'`,
    )
    .get(agentId) as { count: number };
  return row.count;
}

function promptJsonObject(
  prompt: string,
  label: string,
  nextLabel: string,
): Record<string, unknown> {
  const prefix = `${label}\n`;
  const start = prompt.indexOf(prefix);
  const end = prompt.indexOf(`\n${nextLabel}\n`, start + prefix.length);
  if (start < 0 || end < 0) {
    throw new Error(`Missing prompt JSON segment: ${label}`);
  }
  return JSON.parse(prompt.slice(start + prefix.length, end)) as Record<
    string,
    unknown
  >;
}

async function sendChat(
  app: PersonaSimApp,
  sessionId: string,
  agentId: string,
  clientMessageId: string,
  text: string,
): Promise<ChatTurnResult> {
  const response = await app.inject({
    method: "POST",
    url: `/api/sessions/${sessionId}/messages`,
    payload: { agentId, clientMessageId, text },
  });
  expect(response.statusCode, response.body).toBe(201);
  return jsonBody<ChatTurnResult>(response);
}

function latestJson<T>(
  app: PersonaSimApp,
  table: string,
  jsonColumn: string,
): T {
  const row = app.personasim.store.database
    .prepare(
      `SELECT ${jsonColumn} AS json FROM ${table} ORDER BY rowid DESC LIMIT 1`,
    )
    .get() as { json: string } | undefined;
  if (row === undefined) throw new Error(`Expected a row in ${table}`);
  return JSON.parse(row.json) as T;
}

function rowJson<T>(
  app: PersonaSimApp,
  table: string,
  jsonColumn: string,
  lookupColumn: string,
  lookupValue: string,
): T {
  const row = app.personasim.store.database
    .prepare(
      `SELECT ${jsonColumn} AS json FROM ${table} WHERE ${lookupColumn} = ? LIMIT 1`,
    )
    .get(lookupValue) as { json: string } | undefined;
  if (row === undefined) {
    throw new Error(`Expected a matching row in ${table}`);
  }
  return JSON.parse(row.json) as T;
}

function modeForSource(app: PersonaSimApp, sourceMessageId: string): string {
  const row = app.personasim.store.database
    .prepare(
      `SELECT mode FROM support_interventions
       WHERE source_message_id = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(sourceMessageId) as { mode: string } | undefined;
  if (row === undefined) {
    throw new Error(`No support intervention for ${sourceMessageId}`);
  }
  return row.mode;
}

function injectCharacterDilemma(
  app: PersonaSimApp,
  agentId: string,
  sessionId: string,
): void {
  const repository = new LifeRepository(app.personasim.store.database);
  repository.insertDilemma(
    DilemmaEpisodeSchema.parse({
      id: "test-character-dilemma",
      agentId,
      sessionId,
      subject: "character",
      title: "《夜航》结尾的创作取舍",
      summary: "在保护被摄者尊严与提高市场性之间作选择。",
      domain: "creative",
      options: [
        {
          id: "test-character-restrained",
          label: "保留克制的结尾",
          description: "保护被摄者尊严与作品的克制表达。",
          likelyTradeoffs: ["合作方可能担心市场吸引力不足"],
          valuesAtStake: ["被摄者尊严", "创作完整性"],
        },
        {
          id: "test-character-market",
          label: "强化冲突",
          description: "提高戏剧张力与传播空间。",
          likelyTradeoffs: ["可能让被摄者感到经历被工具化"],
          valuesAtStake: ["传播机会", "商业可持续性"],
        },
      ],
      status: "open",
      sourceMessageIds: ["test-character-control-evidence"],
      effectiveLocalDate: "2026-09-01",
      effectivePeriod: "morning",
      temporalPrecision: "period",
      recordedAtUtc: START_UTC,
      updatedAtUtc: START_UTC,
      idempotencyKey: "test:character-dilemma",
      schemaVersion: 1,
    }),
  );
}

function injectUserBranchDilemma(
  app: PersonaSimApp,
  agentId: string,
  sessionId: string,
): void {
  const repository = new LifeRepository(app.personasim.store.database);
  repository.insertDilemma(
    DilemmaEpisodeSchema.parse({
      id: "test-user-branch-dilemma",
      agentId,
      sessionId,
      subject: "user",
      title: "未来一年的职业方向",
      summary: "在稳定的影像平台岗位和独立影像项目之间选择。",
      domain: "work",
      options: [
        {
          id: "test-user-branch-stable",
          label: "接受影像平台副主编岗位",
          description: "用更稳定的收入与作息支撑未来一年。",
          likelyTradeoffs: ["个人创作时间可能减少"],
          valuesAtStake: ["生活稳定", "创作空间"],
        },
        {
          id: "test-user-branch-independent",
          label: "启动独立影像项目",
          description: "和两位朋友承担项目与创作自主权。",
          likelyTradeoffs: ["现金流和项目连续性更不确定"],
          valuesAtStake: ["创作自主", "经济安全"],
        },
      ],
      status: "open",
      sourceMessageIds: ["test-user-branch-control-evidence"],
      effectiveLocalDate: "2026-09-01",
      effectivePeriod: "morning",
      temporalPrecision: "period",
      recordedAtUtc: START_UTC,
      updatedAtUtc: START_UTC,
      idempotencyKey: "test:user-branch-dilemma",
      schemaVersion: 1,
    }),
  );
}

function injectSecondUserBranchDilemma(
  app: PersonaSimApp,
  agentId: string,
  sessionId: string,
): void {
  const repository = new LifeRepository(app.personasim.store.database);
  repository.insertDilemma(
    DilemmaEpisodeSchema.parse({
      id: "test-user-branch-dilemma-second",
      agentId,
      sessionId,
      subject: "user",
      title: "未来半年的顾问工作与驻留创作取舍",
      summary: "在稳定收入的长期顾问合同和保护创作时间的纪录片驻留之间选择。",
      domain: "work",
      options: [
        {
          id: "test-user-second-stable",
          label: "接受长期影像顾问合同",
          description: "获得稳定收入，但会继续压缩个人创作时间。",
          likelyTradeoffs: ["纪录片驻留时间会减少"],
          valuesAtStake: ["收入稳定", "创作时间"],
        },
        {
          id: "test-user-second-residency",
          label: "参加纪录片驻留创作",
          description: "保护半年创作时间，但放弃稳定的顾问收入。",
          likelyTradeoffs: ["收入不确定性更高"],
          valuesAtStake: ["创作自主", "经济安全"],
        },
      ],
      status: "open",
      sourceMessageIds: ["test-user-branch-second-control-evidence"],
      effectiveLocalDate: "2026-09-01",
      effectivePeriod: "morning",
      temporalPrecision: "period",
      recordedAtUtc: START_UTC,
      updatedAtUtc: START_UTC,
      idempotencyKey: "test:user-branch-dilemma-second",
      schemaVersion: 1,
    }),
  );
}

function injectPressureEpisode(
  app: PersonaSimApp,
  agentId: string,
  sessionId: string,
  id: string,
  evidenceMessageId: string,
  dilemmaId?: string,
  subject: PressureEpisode["subject"] = "user",
  triggerSummary?: string,
): void {
  const repository = new LifeRepository(app.personasim.store.database);
  repository.insertPressure(
    PressureEpisodeSchema.parse({
      id,
      agentId,
      sessionId,
      ...(dilemmaId === undefined ? {} : { dilemmaId }),
      subject,
      pressureKind: "work",
      triggerSummary:
        triggerSummary ??
        (dilemmaId === undefined
          ? "一条与当前职业选择无关的既有压力"
          : "围绕当前职业选择的压力"),
      status: "open",
      initialPressure: 0.6,
      currentPressure: 0.6,
      initialClarity: 0.4,
      currentClarity: 0.4,
      initialFeltUnderstood: 0.2,
      currentFeltUnderstood: 0.2,
      interventionIds: [],
      outcomeIds: [],
      sourceMessageIds: [evidenceMessageId],
      latestEvidenceMessageId: evidenceMessageId,
      effectiveLocalDate: "2026-09-01",
      effectivePeriod: "morning",
      temporalPrecision: "period",
      recordedAtUtc: START_UTC,
      updatedAtUtc: START_UTC,
      idempotencyKey: `test:${id}`,
      schemaVersion: 1,
    }),
  );
}

function jsonBody<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Expected a record value");
  }
  return value as Record<string, unknown>;
}
