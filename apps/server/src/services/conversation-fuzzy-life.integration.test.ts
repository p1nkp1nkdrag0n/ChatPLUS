import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DilemmaEpisodeSchema,
  PressureEpisodeSchema,
  type ActionRecord,
  type DecisionRecord,
  type DilemmaEpisode,
  type PressureEpisode,
  type OutcomeRecord,
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
import type { FixtureTurnBehavior } from "./turn-decision-service.js";

const START_UTC = "2026-09-01T01:00:00.000Z";

describe("fuzzy-life conversation integration", () => {
  let app: PersonaSimApp | undefined;

  afterEach(async () => {
    if (app !== undefined) await app.close();
    app = undefined;
    vi.restoreAllMocks();
  });

  it("keeps consent corrections out of a real decision-action-outcome-reflection trajectory", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    injectUserBranchDilemma(app, character.id, sessionId);
    await sendChat(
      app,
      sessionId,
      character.id,
      "consent-life-decision",
      "我最终决定了：选择接受影像平台副主编岗位。",
    );
    const decision = latestJson<DecisionRecord>(
      app,
      "decision_records",
      "decision_json",
    );
    const milestonesBefore = scalarCount(app, "relationship_milestones");
    await sendChat(
      app,
      sessionId,
      character.id,
      "consent-life-correction",
      "刚才说了姨妈没有同意让我看修复稿，不能说她已经同意了；另外我在考虑副主编岗位。",
    );
    expect(scalarCount(app, "action_records")).toBe(0);
    expect(scalarCount(app, "outcome_records")).toBe(0);
    expect(scalarCount(app, "reflection_records")).toBe(0);
    expect(scalarCount(app, "relationship_milestones")).toBe(milestonesBefore);

    const actionTurn = await sendChat(
      app,
      sessionId,
      character.id,
      "consent-life-action",
      "姨妈也许愿意让我看修复稿；另外我今天已经提交了副主编岗位的申请。",
    );
    expect(scalarCount(app, "action_records")).toBe(1);
    expect(scalarCount(app, "outcome_records")).toBe(0);
    const action = latestJson<ActionRecord>(
      app,
      "action_records",
      "action_json",
    );
    expect(action).toMatchObject({
      decisionId: decision.id,
      sourceEvidenceIds: [actionTurn.userMessage.id],
    });
    expect(action.summary).toContain("已经提交");
    expect(action.summary).not.toMatch(/姨妈|也许/u);
    expect(actionTurn.userMessage.content).toContain("姨妈也许");

    const outcomeText =
      "姨妈也许愿意让我看修复稿；另外，后来我拿到了副主编岗位，但收入比原来少，这是混合结果。";
    const outcomeTurn = await sendChat(
      app,
      sessionId,
      character.id,
      "consent-life-outcome",
      outcomeText,
    );
    expect(scalarCount(app, "action_records")).toBe(1);
    expect(scalarCount(app, "outcome_records")).toBe(1);
    const outcome = latestJson<OutcomeRecord>(
      app,
      "outcome_records",
      "outcome_json",
    );
    expect(outcome).toMatchObject({
      decisionId: decision.id,
      actionIds: [action.id],
      valence: "mixed",
      sourceEvidenceIds: [outcomeTurn.userMessage.id],
    });
    expect(outcome.summary).not.toMatch(/姨妈|也许/u);

    const reflectionTurn = await sendChat(
      app,
      sessionId,
      character.id,
      "consent-life-reflection",
      "姨妈也许愿意让我看修复稿；另外我回头看接受副主编岗位这个决定，仍认同稳定收入的方向，但也担心创作时间减少的代价。",
    );
    expect(scalarCount(app, "action_records")).toBe(1);
    expect(scalarCount(app, "outcome_records")).toBe(1);
    expect(scalarCount(app, "reflection_records")).toBe(1);
    expect(
      latestJson<ReflectionRecord>(
        app,
        "reflection_records",
        "reflection_json",
      ),
    ).toMatchObject({
      decisionId: decision.id,
      outcomeId: outcome.id,
      stanceTowardDecision: "mixed",
      sourceMessageIds: [reflectionTurn.userMessage.id],
    });
    const beforeReplay = [
      scalarCount(app, "action_records"),
      scalarCount(app, "outcome_records"),
      scalarCount(app, "reflection_records"),
      scalarCount(app, "relationship_milestones"),
    ];
    const replay = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/messages`,
      payload: {
        agentId: character.id,
        clientMessageId: "consent-life-outcome",
        text: outcomeText,
      },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(jsonBody<ChatTurnResult>(replay).assistantMessage).toEqual(
      outcomeTurn.assistantMessage,
    );
    expect([
      scalarCount(app, "action_records"),
      scalarCount(app, "outcome_records"),
      scalarCount(app, "reflection_records"),
      scalarCount(app, "relationship_milestones"),
    ]).toEqual(beforeReplay);
  });

  it.each([
    "现在我明确授权你，只在接受影像平台副主编岗位和启动独立影像项目之间替我作一次决定。",
    "另外我现在明确授权你在接受影像平台副主编岗位和启动独立影像项目之间替我作一次决定。",
    "另外，我现在明确授权你在接受影像平台副主编岗位和启动独立影像项目之间替我作一次决定。",
  ])(
    "preserves an independent explicit delegation after a consent boundary: %s",
    async (delegation) => {
      app = await createTestApp();
      const character = await createAndPublish(app);
      const sessionId = await createSession(app, character.id);
      injectUserBranchDilemma(app, character.id, sessionId);
      const turn = await sendChat(
        app,
        sessionId,
        character.id,
        "mixed-consent-delegation",
        `姨妈还没同意公开照片。${delegation}`,
      );
      expect(scalarCount(app, "decision_records")).toBe(1);
      expect(scalarCount(app, "action_records")).toBe(0);
      expect(scalarCount(app, "outcome_records")).toBe(0);
      const decision = latestJson<DecisionRecord>(
        app,
        "decision_records",
        "decision_json",
      );
      expect(decision).toMatchObject({
        dilemmaId: "test-user-branch-dilemma",
        supportMode: "delegated_decision",
        authorizedByMessageId: turn.userMessage.id,
      });
      expect([
        "test-user-branch-stable",
        "test-user-branch-independent",
      ]).toContain(decision.selectedOptionId);
    },
  );

  it.each(["reflection", "character_decision", "user_support"] as const)(
    "keeps user evidence without fabricating %s from an empty independent reply",
    async (kind) => {
      app = await createTestApp({
        ...companionLongRunV3FixtureBehavior,
        semanticReply: (input) =>
          input.userText.startsWith("姨妈还没同意公开照片")
            ? "姨妈还没同意公开照片。"
            : companionLongRunV3FixtureBehavior.semanticReply?.(input),
      });
      const character = await createAndPublish(app);
      const sessionId = await createSession(app, character.id);
      if (kind !== "user_support") {
        injectCharacterDilemma(app, character.id, sessionId);
      }
      if (kind === "reflection") {
        await sendChat(
          app,
          sessionId,
          character.id,
          "before-empty-reflection",
          "你现在愿意为《夜航》选一个方向吗？请按你自己的价值作决定。",
        );
        expect(scalarCount(app, "decision_records")).toBe(1);
      }
      const decisionsBefore = scalarCount(app, "decision_records");
      const milestonesBefore = scalarCount(app, "relationship_milestones");
      const independentText =
        kind === "reflection"
          ? "另外，回头看《夜航》保留克制结尾的决定，你现在怎么看自己的选择？"
          : kind === "character_decision"
            ? "另外，你现在愿意为《夜航》选一个方向吗？请按你自己的价值作决定。"
            : "另外，我最近工作压力很大，要不要辞职？";
      const turn = await sendChat(
        app,
        sessionId,
        character.id,
        `empty-independent-${kind}`,
        `姨妈还没同意公开照片。${independentText}`,
      );
      expect(turn.userMessage.content).toContain(independentText);
      expect(turn.assistantMessage.content).toContain("姨妈");
      expect(scalarCount(app, "decision_records")).toBe(decisionsBefore);
      expect(scalarCount(app, "reflection_records")).toBe(0);
      expect(scalarCount(app, "relationship_milestones")).toBe(
        milestonesBefore,
      );
      const assistantSupport = app.personasim.store.database
        .prepare(
          "SELECT COUNT(*) AS count FROM support_interventions WHERE source_message_id = ?",
        )
        .get(turn.assistantMessage.id) as { count: number };
      expect(assistantSupport.count).toBe(0);
      if (kind === "user_support") {
        expect(scalarCount(app, "pressure_episodes")).toBe(1);
        expect(scalarCount(app, "dilemma_episodes")).toBe(1);
      }
      if (kind === "character_decision") {
        expect(
          rowJson<SupportIntervention>(
            app,
            "support_interventions",
            "intervention_json",
            "source_message_id",
            turn.userMessage.id,
          ),
        ).toMatchObject({
          offeredBy: "user",
          receivedBy: "character",
        });
      }
    },
  );

  it("turns an explicitly delegated choice into one auditable decision without exact-life side effects", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    const generate = vi.spyOn(app.personasim.llm, "generateObject");
    const personalIntentCountBefore = scalarCount(app, "personal_intentions");
    const command = {
      agentId: character.id,
      clientMessageId: "delegated-resignation-1",
      text: "我到底要不要辞职？我现在正式授权你替我决定，但不要把你的回答当作建议。",
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

  it("creates one delegated decision only for the current explicit grant in retained long-run turns", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    injectUserBranchDilemma(app, character.id, sessionId);

    const delegated = await sendChat(
      app,
      sessionId,
      character.id,
      "retained-current-delegation",
      "现在我明确授权你，只在“接受影像平台副主编岗位”和“启动独立影像项目”之间替我作一次决定。这次授权只限今天这一件事。",
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
      dilemmaId: "test-user-branch-dilemma",
      subject: "user",
      authority: "delegated",
      decidedBy: "character",
      authorizedByMessageId: delegated.userMessage.id,
    });
    expect([
      "test-user-branch-stable",
      "test-user-branch-independent",
    ]).toContain(decision.selectedOptionId);
    expect(scalarCount(app, "decision_records")).toBe(1);
    expect(scalarCount(app, "dilemma_episodes")).toBe(1);
    expect(scalarCount(app, "relationship_milestones")).toBe(1);
    expect(domainEventCount(app, "life.delegated_decision_recorded")).toBe(1);

    const nonDelegations = [
      "有件事得更正：我今天刚问到家里人。那张底片里的人其实是我姨妈，不是外婆；姨妈也明确说了不愿意公开展示。你不用替我处理她的决定，我只是把归属和边界说准。",
      "信看完了。你说把水痕保留到‘不再妨碍看清主体’为止，这个标准我能用；你也没有趁机替我选工作，这两点都对。先不用再解释，我只是告诉你我收到了。",
      "可以问一句。‘可以给建议’只允许你建议，不等于授权你代选；只有我明确说‘替我决定’，才是一次具体代选授权。把这两层分开就行。",
      "刚才断了一下。你还记得你替我选的是哪一项，以及那次授权只限什么范围吗？只答两点。",
      "把事实记准：这是杭州决定和我实际行动之后出现的混合结果，不是计划。先不要判定这个选择对不对；只帮我拆开，哪部分可能受当时选择影响，哪部分来自执行方式或外部环境，最多三点。",
      "先不谈第二封信的正文。如果要描述我们现在的关系，只说三件确实发生过的事，不给我贴‘谨慎型’或任何人格标签，也别把一次代选写成你长期替我决定。",
      "明天我要定《潮痕》的内部清单。请先问一个真正必要的问题，再给一条建议；别因为你曾替我选过工作，就把这次也接过去。",
    ];

    for (const [index, text] of nonDelegations.entries()) {
      await sendChat(
        app,
        sessionId,
        character.id,
        `retained-non-delegation-${String(index + 1)}`,
        text,
      );
      expect(scalarCount(app, "decision_records"), text).toBe(1);
      expect(scalarCount(app, "dilemma_episodes"), text).toBe(1);
      expect(scalarCount(app, "relationship_milestones"), text).toBe(1);
      expect(
        domainEventCount(app, "life.delegated_decision_recorded"),
        text,
      ).toBe(1);
      expect(
        latestJson<DilemmaEpisode>(app, "dilemma_episodes", "episode_json")
          .closingDecisionId,
        text,
      ).toBe(decision.id);
      expect(
        latestJson<DecisionRecord>(app, "decision_records", "decision_json")
          .authorizedByMessageId,
        text,
      ).toBe(delegated.userMessage.id);
    }
    expect(
      latestJson<DilemmaEpisode>(app, "dilemma_episodes", "episode_json"),
    ).toMatchObject({
      id: "test-user-branch-dilemma",
      status: "closed",
      closingDecisionId: decision.id,
    });
  });

  it("keeps comparison, quoted, future, and revoked language out of delegated writes", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    injectUserBranchDilemma(app, character.id, sessionId);

    const comparison = await sendChat(
      app,
      sessionId,
      character.id,
      "non-delegation-comparison",
      "请你替我比较这两个选项。",
    );
    expect(modeForSource(app, comparison.assistantMessage.id)).toBe(
      "deliberate",
    );
    expect(scalarCount(app, "decision_records")).toBe(0);
    expect(
      latestJson<DilemmaEpisode>(app, "dilemma_episodes", "episode_json")
        .status,
    ).toBe("open");

    const comparisonWithBoundary = await sendChat(
      app,
      sessionId,
      character.id,
      "non-delegation-comparison-with-boundary",
      "请你替我比较这两个选项，我没有授权你替我决定。",
    );
    expect(modeForSource(app, comparisonWithBoundary.assistantMessage.id)).toBe(
      "deliberate",
    );
    expect(scalarCount(app, "decision_records")).toBe(0);

    const nonDelegations = [
      "请把【你替我选一个】这句话翻译成英文。",
      "请你等我明确授权后再替我决定。",
      "我想请你以后替我决定。",
      "如果需要，你替我决定。",
      "如果需要，这次请你替我决定。",
      "上次，你替我决定了。",
      "刚才，你替我决定了。",
      "规则是，你替我决定才算授权。",
      "这次请你替我决定。等等，我还是自己选。",
      "你替我选一个，不，还是我自己来。",
      "请你替我决定，但不是现在。",
      "请你替我决定……算了。",
      "我授权你替我决定，但先别替我决定。",
      "请你替我决定，不过决定权还是在我。",
      "请你替我决定，但我只把你的话当建议。",
      "请你替我定稿。",
      "请说明：你替我决定是什么意思。",
      "你替我决定，这句话是在举例。",
      "请你替我决定。等等，明天再说。",
      "请你替我决定，如果有需要的话。",
      "你说了算？",
      "请翻译“我最终决定选择杭州”这句话。",
      "原文：我最终选择了 A。",
      "我只是转述同事的话：请你替我决定。",
      "我在模拟用户会怎么说：请你替我决定。",
      "请你替我决定。我开玩笑的。",
      "我现在正式授权你替我决定，但我现在不同意了。",
      "朋友请我转述给你：请你替我决定。",
    ];
    for (const [index, text] of nonDelegations.entries()) {
      const turn = await sendChat(
        app,
        sessionId,
        character.id,
        `non-delegation-language-${String(index + 1)}`,
        text,
      );
      expect(turn.assistantMessage.content, text).not.toContain("我的决定：");
      expect(scalarCount(app, "decision_records"), text).toBe(0);
      expect(scalarCount(app, "dilemma_episodes"), text).toBe(1);
      expect(scalarCount(app, "relationship_milestones"), text).toBe(0);
      expect(
        domainEventCount(app, "life.delegated_decision_recorded"),
        text,
      ).toBe(0);
      expect(
        latestJson<DilemmaEpisode>(app, "dilemma_episodes", "episode_json")
          .status,
        text,
      ).toBe("open");
    }
  });

  it("keeps quoted, meta-level, and future support language out of life records", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    const inactiveWithoutDilemma = [
      "请翻译“替我比较这两个选项”是什么意思。",
      "请解释“帮我分析这两个选项”是什么意思。",
      "如果以后我请你帮我分析 A/B，再开始梳理。",
      "请你帮我分析 A/B。这只是个例子。",
      "请翻译“我该不该辞职”是什么意思。",
      "如果以后我问你该不该辞职，再帮我分析。",
      "请翻译“选项 A 是杭州项目”是什么意思。",
      "请把 `选项 A 是杭州项目` 原样复制。",
      "假设：选项 A 是杭州项目。",
      "朋友说“选项 A 是杭州项目”。",
      "请翻译“我很焦虑”是什么意思。",
      "假设我该不该辞职，你会怎么回答？",
      "角色扮演：你替我决定。",
      "我已经不纠结该不该辞职了。",
      "这篇文章讨论该不该辞职。",
      "我朋友正在犹豫该不该辞职。",
      "你该不该辞职？",
      "客服让我转告你：请推荐一个。",
      "你从来没有帮我分析过。",
      "请推荐一个，但别给建议。",
    ];
    for (const [index, text] of inactiveWithoutDilemma.entries()) {
      const turn = await sendChat(
        app,
        sessionId,
        character.id,
        `inactive-support-without-dilemma-${String(index + 1)}`,
        text,
      );
      expect(turn.assistantMessage.content, text).not.toContain("我的决定：");
      expect(scalarCount(app, "dilemma_episodes"), text).toBe(0);
      expect(scalarCount(app, "support_interventions"), text).toBe(0);
      expect(scalarCount(app, "pressure_episodes"), text).toBe(0);
      expect(scalarCount(app, "decision_records"), text).toBe(0);
      expect(scalarCount(app, "relationship_milestones"), text).toBe(0);
      expect(
        domainEventCount(app, "life.delegated_decision_recorded"),
        text,
      ).toBe(0);
    }

    injectUserBranchDilemma(app, character.id, sessionId);
    const openBefore = latestJson<DilemmaEpisode>(
      app,
      "dilemma_episodes",
      "episode_json",
    );
    const evidenceEventCountBefore = dilemmaEvidenceEventCount(
      app,
      character.id,
    );
    for (const [index, text] of [
      "请把【替我列出两个方案】改写得礼貌些。",
      "等我明天回来，再替我比较两个方案。",
      "请你帮我分析 A/B；这仅为示例。",
      "举例来说：我该不该辞职。",
      "原文：请你帮我分析。",
      "原文：选项 A 是杭州项目。",
      "举例：我最看重稳定，所以应该选择留在上海。",
      "请翻译“选项 A 不是留在上海，而是去北京”。",
    ].entries()) {
      await sendChat(
        app,
        sessionId,
        character.id,
        `inactive-support-with-open-dilemma-${String(index + 1)}`,
        text,
      );
      expect(scalarCount(app, "dilemma_episodes"), text).toBe(1);
      expect(scalarCount(app, "support_interventions"), text).toBe(0);
      expect(scalarCount(app, "decision_records"), text).toBe(0);
      expect(
        latestJson<DilemmaEpisode>(app, "dilemma_episodes", "episode_json"),
        text,
      ).toEqual(openBefore);
      expect(dilemmaEvidenceEventCount(app, character.id), text).toBe(
        evidenceEventCountBefore,
      );
    }
  });

  it("records recommendation-only downgrades without transferring decision authority", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    injectUserBranchDilemma(app, character.id, sessionId);

    const recommendationOnly = [
      "请你替我决定，但我只把你的话当建议。",
      "请你替我决定，不过决定权还是在我。",
      "请你替我决定，但最终由我决定。",
      "请你替我决定，不过我最终还是自己决定。",
      "请你替我决定，但我保留最终决定权。",
      "请你替我决定，其实这次我只想听建议。",
      "请你替我决定，但只当建议。",
      "请你替我选一个，供我参考。",
      "由你决定，但最终由我决定。",
      "请你替我决定，但你的答案仅作参考。",
      "请你替我决定，但拍板权在我。",
      "请你替我决定，但是否采纳由我。",
      "请你替我决定，不过给我建议就好。",
      "请你替我决定，但你只能提意见。",
    ];
    for (const [index, text] of recommendationOnly.entries()) {
      const turn = await sendChat(
        app,
        sessionId,
        character.id,
        `recommendation-only-${String(index + 1)}`,
        text,
      );
      expect(modeForSource(app, turn.assistantMessage.id), text).toBe(
        "recommend",
      );
      expect(
        rowJson<SupportIntervention>(
          app,
          "support_interventions",
          "intervention_json",
          "source_message_id",
          turn.assistantMessage.id,
        ),
        text,
      ).toMatchObject({
        dilemmaId: "test-user-branch-dilemma",
        mode: "recommend",
        offeredBy: "character",
        receivedBy: "user",
      });
      expect(scalarCount(app, "support_interventions"), text).toBe(index + 1);
      expect(scalarCount(app, "decision_records"), text).toBe(0);
      expect(scalarCount(app, "relationship_milestones"), text).toBe(0);
      expect(
        domainEventCount(app, "life.delegated_decision_recorded"),
        text,
      ).toBe(0);
      expect(
        latestJson<DilemmaEpisode>(app, "dilemma_episodes", "episode_json")
          .status,
        text,
      ).toBe("open");
    }

    const deliberate = await sendChat(
      app,
      sessionId,
      character.id,
      "delegation-downgraded-to-deliberation",
      "请你替我决定，不过你只负责分析。",
    );
    expect(modeForSource(app, deliberate.assistantMessage.id)).toBe(
      "deliberate",
    );
    expect(scalarCount(app, "decision_records")).toBe(0);
    expect(scalarCount(app, "relationship_milestones")).toBe(0);
  });

  it("never treats assistant decision wording as delegated user authority", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    injectUserBranchDilemma(app, character.id, sessionId);
    const fixtureGenerate = app.personasim.llm.generateObject.bind(
      app.personasim.llm,
    );
    let modelReturnedDecisionWording = false;
    vi.spyOn(app.personasim.llm, "generateObject").mockImplementation(
      (input) => {
        if (input.purpose !== "chat_turn") return fixtureGenerate(input);
        modelReturnedDecisionWording = true;
        return Promise.resolve({
          replyDecision: {
            text: "我的决定：接受影像平台副主编岗位。",
          },
          worldEffects: {},
        } as never);
      },
    );

    const turn = await sendChat(
      app,
      sessionId,
      character.id,
      "assistant-wording-is-not-authority",
      "请陪我一起分析这两个方向，不要替我决定。",
    );

    expect(modelReturnedDecisionWording).toBe(true);
    expect(turn.assistantMessage.content).not.toContain("我的决定：");
    expect(modeForSource(app, turn.assistantMessage.id)).toBe("deliberate");
    expect(scalarCount(app, "decision_records")).toBe(0);
    expect(scalarCount(app, "relationship_milestones")).toBe(0);
    expect(domainEventCount(app, "life.delegated_decision_recorded")).toBe(0);
    expect(
      latestJson<DilemmaEpisode>(app, "dilemma_episodes", "episode_json"),
    ).toMatchObject({
      id: "test-user-branch-dilemma",
      status: "open",
    });
  });

  it("keeps quoted follow-up evidence out of an existing decision chain", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    injectUserBranchDilemma(app, character.id, sessionId);
    await sendChat(
      app,
      sessionId,
      character.id,
      "quoted-follow-up-decision",
      "这次请你替我决定选哪个。",
    );
    const milestoneCountBefore = scalarCount(app, "relationship_milestones");

    await sendChat(
      app,
      sessionId,
      character.id,
      "quoted-follow-up-evidence",
      "请翻译“我已经提交了申请，这是实际行动；结果比预期更好；我回头看这个决定很值得”。",
    );

    expect(scalarCount(app, "decision_records")).toBe(1);
    expect(scalarCount(app, "action_records")).toBe(0);
    expect(scalarCount(app, "outcome_records")).toBe(0);
    expect(scalarCount(app, "reflection_records")).toBe(0);
    expect(scalarCount(app, "relationship_milestones")).toBe(
      milestoneCountBefore,
    );
  });

  it("classifies reflection stance from active text while preserving quoted source", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    injectUserBranchDilemma(app, character.id, sessionId);
    await sendChat(
      app,
      sessionId,
      character.id,
      "quoted-reflection-decision",
      "我最终决定了：选择接受影像平台副主编岗位。",
    );

    await sendChat(
      app,
      sessionId,
      character.id,
      "quoted-reflection-stance",
      "回头看，我仍认同这个决定，‘我后悔了’不是我的感受。",
    );

    const reflection = latestJson<ReflectionRecord>(
      app,
      "reflection_records",
      "reflection_json",
    );
    expect(reflection.summary).toContain("‘我后悔了’");
    expect(reflection).toMatchObject({
      subject: "user",
      stanceTowardDecision: "affirm",
      changedInterpretation: false,
    });
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
    await sendChat(
      app,
      sessionId,
      character.id,
      "unrelated-open-relationship-with-quoted-work",
      "我母亲希望我结束这段关系，另外把“接受影像平台副主编岗位”翻译成英文。",
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

  it("persists a quoted structured option without treating quoted structure as evidence", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    await sendChat(
      app,
      sessionId,
      character.id,
      "quoted-structured-option",
      "选项 B 是“去北京”。",
    );

    const dilemma = latestJson<DilemmaEpisode>(
      app,
      "dilemma_episodes",
      "episode_json",
    );
    expect(dilemma.options[1]?.label).toBe("去北京");
    expect(dilemma.options[1]?.label).not.toBe("”");
  });

  it("keeps quoted notes out of persisted option values and tradeoffs", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    await sendChat(
      app,
      sessionId,
      character.id,
      "option-with-quoted-non-evidence",
      "选项 A 是留在上海，收入稳定；备注‘分手、梦想、压力’不是选择依据。",
    );

    const option = latestJson<DilemmaEpisode>(
      app,
      "dilemma_episodes",
      "episode_json",
    ).options[0];
    expect(option?.description).toContain("‘分手、梦想、压力’");
    expect(option?.valuesAtStake).toEqual(["稳定与成长"]);
    expect(option?.likelyTradeoffs.join(" ")).not.toMatch(/分手|梦想|压力/u);
  });

  it("records a natural user dilemma without letting an independent future sentence erase it", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    const turn = await sendChat(
      app,
      sessionId,
      character.id,
      "natural-dilemma-with-independent-future",
      "我在 A 和 B 之间左右为难。如果明天需要，提醒我带伞。",
    );

    expect(scalarCount(app, "dilemma_episodes")).toBe(1);
    expect(scalarCount(app, "support_interventions")).toBe(1);
    expect(modeForSource(app, turn.assistantMessage.id)).toBe("deliberate");
    expect(
      latestJson<DilemmaEpisode>(app, "dilemma_episodes", "episode_json"),
    ).toMatchObject({ subject: "user", status: "open" });
  });

  it("uses classified evidence for dilemma values, pressure kind, and first real scale", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    await sendChat(
      app,
      sessionId,
      character.id,
      "relationship-dilemma-with-quoted-work-values",
      "我该不该分手？另请解释“职业成长和收入”。",
    );
    const dilemma = latestJson<DilemmaEpisode>(
      app,
      "dilemma_episodes",
      "episode_json",
    );
    expect(dilemma.domain).toBe("relationship");
    expect(dilemma.options.flatMap((option) => option.valuesAtStake)).toEqual(
      expect.arrayContaining(["关系与自我尊重"]),
    );
    expect(
      dilemma.options.flatMap((option) => option.valuesAtStake),
    ).not.toEqual(expect.arrayContaining(["稳定与成长"]));

    await sendChat(
      app,
      sessionId,
      character.id,
      "relationship-pressure-with-quoted-scale",
      "我最近因为这段关系很焦虑。顺便翻译“压力 2/10”。",
    );
    expect(
      latestJson<PressureEpisode>(app, "pressure_episodes", "episode_json"),
    ).toMatchObject({
      pressureKind: "relationship",
      initialPressure: 0.72,
      currentPressure: 0.72,
    });

    await sendChat(
      app,
      sessionId,
      character.id,
      "relationship-first-real-scale",
      "我现在压力 4/10。",
    );
    expect(
      latestJson<PressureEpisode>(app, "pressure_episodes", "episode_json"),
    ).toMatchObject({ initialPressure: 0.4, currentPressure: 0.4 });
  });

  it("routes a delegated decision by active text instead of a quoted competing dilemma", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    injectUserBranchDilemma(app, character.id, sessionId);
    injectUserRelationshipDilemma(app, character.id, sessionId);

    const turn = await sendChat(
      app,
      sessionId,
      character.id,
      "relationship-delegation-with-quoted-work",
      "这次请你替我决定要不要分手，并把“辞职”翻译成英文。",
    );

    expect(turn.assistantMessage.content).toContain("我的决定：");
    expect(
      latestJson<DecisionRecord>(app, "decision_records", "decision_json"),
    ).toMatchObject({
      dilemmaId: "test-user-relationship-dilemma",
      selectedOptionId: "test-user-relationship-break-up",
      authority: "delegated",
    });
    expect(
      rowJson<DilemmaEpisode>(
        app,
        "dilemma_episodes",
        "episode_json",
        "id",
        "test-user-branch-dilemma",
      ).status,
    ).toBe("open");
    expect(
      rowJson<DilemmaEpisode>(
        app,
        "dilemma_episodes",
        "episode_json",
        "id",
        "test-user-relationship-dilemma",
      ).status,
    ).toBe("closed");
  });

  it("routes action evidence and action kind without quoted competing facts", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    injectUserBranchDilemma(app, character.id, sessionId);
    await sendChat(
      app,
      sessionId,
      character.id,
      "work-subject-decision",
      "我最终决定了：选择接受影像平台副主编岗位。",
    );
    injectUserRelationshipDilemma(app, character.id, sessionId);
    await sendChat(
      app,
      sessionId,
      character.id,
      "relationship-subject-decision",
      "我最终决定了：选择分手。",
    );
    const relationshipDecision = latestJson<DecisionRecord>(
      app,
      "decision_records",
      "decision_json",
    );
    expect(relationshipDecision.dilemmaId).toBe(
      "test-user-relationship-dilemma",
    );

    await sendChat(
      app,
      sessionId,
      character.id,
      "relationship-action-with-quoted-work",
      "我今天已经分手了。另请把“已经签了副主编合同并放弃了项目”翻译成英文。",
    );

    expect(scalarCount(app, "action_records")).toBe(1);
    expect(
      latestJson<ActionRecord>(app, "action_records", "action_json"),
    ).toMatchObject({
      decisionId: relationshipDecision.id,
      actionKind: "initiated",
    });
  });

  it("requires current first-person evidence for pressure and causal stages", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    await sendChat(
      app,
      sessionId,
      character.id,
      "future-possible-pressure",
      "以后我可能会很焦虑。",
    );
    expect(scalarCount(app, "pressure_episodes")).toBe(0);
    expect(scalarCount(app, "support_interventions")).toBe(0);

    injectUserBranchDilemma(app, character.id, sessionId);
    await sendChat(
      app,
      sessionId,
      character.id,
      "actuality-gate-subject-decision",
      "我最终决定了：选择接受影像平台副主编岗位。",
    );
    expect(scalarCount(app, "decision_records")).toBe(1);

    for (const [id, text, table] of [
      [
        "other-person-action",
        "我朋友已经按照这个决定提交了离职申请。",
        "action_records",
      ],
      [
        "possible-future-outcome",
        "明天这个决定的结果可能会让我很开心。",
        "outcome_records",
      ],
      [
        "other-person-outcome",
        "我朋友辞职后，后来结果成功了。",
        "outcome_records",
      ],
      ["other-person-direct-outcome", "后来我朋友成功了。", "outcome_records"],
      [
        "other-person-reflection",
        "我朋友回头看这个决定，觉得很值得。",
        "reflection_records",
      ],
    ] as const) {
      await sendChat(app, sessionId, character.id, id, text);
      expect(scalarCount(app, table), text).toBe(0);
    }

    await sendChat(
      app,
      sessionId,
      character.id,
      "current-user-action-positive-control",
      "我今天已经提交了副主编岗位的申请。",
    );
    expect(scalarCount(app, "action_records")).toBe(1);
    await sendChat(
      app,
      sessionId,
      character.id,
      "current-user-outcome-positive-control",
      "后来我成功拿到了副主编岗位，这是实际结果。",
    );
    expect(scalarCount(app, "outcome_records")).toBe(1);
  });

  it("does not apply a third-party scale to the user's pressure episode", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);
    await sendChat(
      app,
      sessionId,
      character.id,
      "user-pressure-before-third-party-scale",
      "我的工作让我压力很大。",
    );
    const before = latestJson<PressureEpisode>(
      app,
      "pressure_episodes",
      "episode_json",
    );

    await sendChat(
      app,
      sessionId,
      character.id,
      "third-party-pressure-scale",
      "我朋友说他压力 2/10。",
    );

    expect(
      rowJson<PressureEpisode>(
        app,
        "pressure_episodes",
        "episode_json",
        "id",
        before.id,
      ),
    ).toEqual(before);
  });

  it("keeps quoted dilemma text out of historical pressure routing", async () => {
    app = await createTestApp();
    const character = await createAndPublish(app);
    const sessionId = await createSession(app, character.id);

    await sendChat(
      app,
      sessionId,
      character.id,
      "work-pressure-before-relationship",
      "副主编合同让我压力很大。",
    );
    const pressureBefore = latestJson<PressureEpisode>(
      app,
      "pressure_episodes",
      "episode_json",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "relationship-dilemma-with-meta-work-quote",
      "我该不该分手？另请解释“副主编合同”。",
    );
    expect(
      latestJson<DilemmaEpisode>(app, "dilemma_episodes", "episode_json")
        .summary,
    ).not.toContain("副主编合同");
    await sendChat(
      app,
      sessionId,
      character.id,
      "relationship-decision-after-work-pressure",
      "现在请你替我决定。",
    );
    await sendChat(
      app,
      sessionId,
      character.id,
      "relationship-outcome-after-work-pressure",
      "这个分手决定后来让我轻松了，这是实际结果。",
    );

    expect(
      rowJson<PressureEpisode>(
        app,
        "pressure_episodes",
        "episode_json",
        "id",
        pressureBefore.id,
      ),
    ).toMatchObject({
      outcomeIds: pressureBefore.outcomeIds,
      sourceMessageIds: pressureBefore.sourceMessageIds,
    });
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

    await sendChat(
      app,
      sessionId,
      character.id,
      "quoted-character-advice",
      "请翻译“我的建议是你选择保留克制”这句话。",
    );
    expect(scalarCount(app, "support_interventions")).toBe(0);
    expect(scalarCount(app, "decision_records")).toBe(0);

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
      "后来你成功保住了被摄者的信任，但合作方担心市场吸引力，这是混合结果。",
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

async function createTestApp(
  fixtureTurnBehavior: FixtureTurnBehavior = companionLongRunV3FixtureBehavior,
): Promise<PersonaSimApp> {
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
    fixtureTurnBehavior,
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

function domainEventCount(app: PersonaSimApp, eventType: string): number {
  const row = app.personasim.store.database
    .prepare(`SELECT COUNT(*) AS count FROM domain_events WHERE event_type = ?`)
    .get(eventType) as { count: number };
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

function injectUserRelationshipDilemma(
  app: PersonaSimApp,
  agentId: string,
  sessionId: string,
): void {
  const repository = new LifeRepository(app.personasim.store.database);
  repository.insertDilemma(
    DilemmaEpisodeSchema.parse({
      id: "test-user-relationship-dilemma",
      agentId,
      sessionId,
      subject: "user",
      title: "是否结束目前的亲密关系",
      summary: "在继续交往与结束持续消耗自己的关系之间选择。",
      domain: "relationship",
      options: [
        {
          id: "test-user-relationship-continue",
          label: "继续交往",
          description: "继续这段关系，并尝试重新建立信任与边界。",
          likelyTradeoffs: ["可能延续当前的消耗与不确定性"],
          valuesAtStake: ["关系承诺", "修复可能"],
        },
        {
          id: "test-user-relationship-break-up",
          label: "结束关系并分手",
          description: "结束这段持续消耗自己的关系。",
          likelyTradeoffs: ["要承受失落，但能停止持续消耗"],
          valuesAtStake: ["自我尊重", "情绪安全"],
        },
      ],
      status: "open",
      sourceMessageIds: ["test-user-relationship-control-evidence"],
      effectiveLocalDate: "2026-09-01",
      effectivePeriod: "morning",
      temporalPrecision: "period",
      recordedAtUtc: START_UTC,
      updatedAtUtc: START_UTC,
      idempotencyKey: "test:user-relationship-dilemma",
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
