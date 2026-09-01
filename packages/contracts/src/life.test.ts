import { describe, expect, it } from "vitest";

import {
  ActionRecordSchema,
  DailyLifeIntentSchema,
  DecisionRecordSchema,
  DilemmaEpisodeSchema,
  LifeOutcomeSchema,
  LifeThreadSchema,
  LocalDateSchema,
  OutcomeRecordSchema,
  SupportInterventionSchema,
} from "./life.js";

const PERIOD_TIME = {
  effectiveLocalDate: "2026-09-01",
  effectivePeriod: "evening",
  temporalPrecision: "period",
  recordedAtUtc: "2026-09-01T13:00:00.000Z",
} as const;

const validDilemma = {
  id: "dilemma-1",
  agentId: "agent-1",
  sessionId: "session-1",
  subject: "user",
  title: "是否接受外地的新工作",
  summary: "新的工作更有发展空间，但意味着离开熟悉的城市。",
  domain: "work",
  options: [
    {
      id: "stay",
      label: "留在现在的城市",
      description: "保留当前工作和生活支持网络。",
      likelyTradeoffs: ["职业成长可能较慢"],
      valuesAtStake: ["稳定"],
    },
    {
      id: "move",
      label: "接受外地工作",
      description: "迁居并进入新的职业阶段。",
      likelyTradeoffs: ["需要重新建立生活支持网络"],
      valuesAtStake: ["成长"],
    },
  ],
  status: "open",
  sourceMessageIds: ["message-1"],
  idempotencyKey: "dilemma:message-1",
  schemaVersion: 1,
  ...PERIOD_TIME,
  updatedAtUtc: "2026-09-01T13:00:00.000Z",
} as const;

const validDelegatedDecision = {
  id: "decision-1",
  agentId: "agent-1",
  sessionId: "session-1",
  dilemmaId: "dilemma-1",
  subject: "user",
  supportMode: "delegated_decision",
  authority: "delegated",
  decidedBy: "character",
  selectedOptionId: "move",
  selectionSummary: "接受外地工作。",
  reasoningSummary: "成长机会与用户当前想改变生活的价值目标更一致。",
  supportInterventionIds: ["intervention-1"],
  sourceMessageIds: ["message-2"],
  authorizedByMessageId: "message-2",
  confidence: 0.72,
  status: "current",
  idempotencyKey: "decision:message-2",
  schemaVersion: 1,
  ...PERIOD_TIME,
} as const;

describe("fuzzy life and decision contracts", () => {
  it("keeps old life threads readable and requires complete milestone projection metadata", () => {
    const legacyThread = {
      id: "thread-1",
      agentId: "agent-1",
      subject: "character",
      title: "完成长片",
      summary: "持续推进长片创作",
      domain: "creative",
      status: "active",
      currentStage: "持续推进中",
      startedLocalDate: "2026-09-01",
      sourceMessageIds: [],
      idempotencyKey: "thread:agent-1:goal-1",
      revision: 1,
      schemaVersion: 1,
      createdAtUtc: "2026-09-01T00:00:00.000Z",
      updatedAtUtc: "2026-09-01T00:00:00.000Z",
    } as const;
    expect(LifeThreadSchema.safeParse(legacyThread).success).toBe(true);
    expect(
      LifeThreadSchema.safeParse({
        ...legacyThread,
        currentMilestoneId: "milestone-1",
      }).success,
    ).toBe(false);
    expect(
      LifeThreadSchema.safeParse({
        ...legacyThread,
        timelinePlan: {
          schemaVersion: 1,
          sourceGoalId: "goal-1",
          sourceCharacterVersion: 1,
          origin: "character_spec",
          timeBasis: { mode: "realtime", timezone: "Asia/Shanghai" },
          milestones: [
            {
              id: "milestone-1",
              afterDays: 0,
              title: "起点",
              focus: "确认方向",
            },
            {
              id: "milestone-2",
              afterDays: 14,
              title: "形成节奏",
              focus: "保持投入",
            },
          ],
          planSha256: "a".repeat(64),
        },
        currentMilestoneId: "milestone-1",
      }).success,
    ).toBe(true);
  });

  it("accepts a fuzzy dilemma without inventing an exact occurrence time", () => {
    expect(DilemmaEpisodeSchema.parse(validDilemma).status).toBe("open");
    expect(
      DilemmaEpisodeSchema.safeParse({
        ...validDilemma,
        temporalPrecision: "exact",
        effectiveAtUtc: "2026-09-01T13:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("validates real local calendar dates", () => {
    expect(LocalDateSchema.safeParse("2026-02-29").success).toBe(false);
    expect(LocalDateSchema.safeParse("2028-02-29").success).toBe(true);
  });

  it("keeps daily intentions separate from completed outcomes", () => {
    const intent = {
      id: "intent-1",
      agentId: "agent-1",
      contextId: "context-1",
      localDate: "2026-09-01",
      title: "整理纪录片素材",
      summary: "今天找一段时间梳理采访素材。",
      domain: "creative",
      period: "afternoon",
      durationBand: "part_of_period",
      commitmentLevel: "priority",
      status: "intended",
      sourceKind: "life_thread",
      shareable: true,
      importance: 0.7,
      threadIds: ["thread-1"],
      goalRefIds: [],
      evidenceMessageIds: [],
      idempotencyKey: "intent:agent-1:2026-09-01:edit",
      revision: 0,
      schemaVersion: 1,
      createdAtUtc: "2026-09-01T00:00:00.000Z",
      updatedAtUtc: "2026-09-01T00:00:00.000Z",
    } as const;
    expect(DailyLifeIntentSchema.safeParse(intent).success).toBe(true);
    expect(
      DailyLifeIntentSchema.safeParse({ ...intent, status: "completed" })
        .success,
    ).toBe(false);

    const outcome = {
      id: "life-outcome-1",
      agentId: "agent-1",
      intentId: "intent-1",
      outcomeKind: "completed",
      summary: "完成了今天计划的素材分类。",
      outcomeFacts: ["把采访素材分成了三个主题组"],
      origin: "character_report",
      threadIds: ["thread-1"],
      sourceEvidenceIds: ["message-3"],
      importance: 0.7,
      idempotencyKey: "life-outcome:intent-1",
      schemaVersion: 1,
      ...PERIOD_TIME,
    } as const;
    expect(LifeOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(
      LifeOutcomeSchema.safeParse({ ...outcome, sourceEvidenceIds: [] })
        .success,
    ).toBe(false);
  });

  it("requires explicit authorization when the character decides for the user", () => {
    expect(DecisionRecordSchema.safeParse(validDelegatedDecision).success).toBe(
      true,
    );
    expect(
      DecisionRecordSchema.safeParse({
        ...validDelegatedDecision,
        authorizedByMessageId: undefined,
      }).success,
    ).toBe(false);
    expect(
      DecisionRecordSchema.safeParse({
        ...validDelegatedDecision,
        decidedBy: "user",
      }).success,
    ).toBe(false);
  });

  it("does not let listening or deliberation silently claim a recommendation", () => {
    const intervention = {
      id: "intervention-1",
      agentId: "agent-1",
      sessionId: "session-1",
      dilemmaId: "dilemma-1",
      mode: "listen_only",
      offeredBy: "character",
      receivedBy: "user",
      summary: "复述了用户对离开熟悉城市的担心。",
      intendedEffect: "让用户感到被理解。",
      sourceMessageId: "message-2",
      idempotencyKey: "intervention:message-2",
      schemaVersion: 1,
      ...PERIOD_TIME,
    } as const;
    expect(SupportInterventionSchema.safeParse(intervention).success).toBe(
      true,
    );
    expect(
      SupportInterventionSchema.safeParse({
        ...intervention,
        recommendationOptionId: "move",
      }).success,
    ).toBe(false);
  });

  it("requires action evidence independently of the earlier decision", () => {
    const action = {
      id: "action-1",
      agentId: "agent-1",
      sessionId: "session-1",
      decisionId: "decision-1",
      subject: "user",
      performedBy: "user",
      actionKind: "initiated",
      summary: "用户回复了录用邮件。",
      sourceEvidenceIds: ["message-3"],
      idempotencyKey: "action:message-3",
      schemaVersion: 1,
      ...PERIOD_TIME,
    } as const;
    expect(ActionRecordSchema.safeParse(action).success).toBe(true);
    expect(
      ActionRecordSchema.safeParse({ ...action, sourceEvidenceIds: [] })
        .success,
    ).toBe(false);
  });

  it("requires an observed action before attributing an outcome to action", () => {
    const outcome = {
      id: "outcome-1",
      agentId: "agent-1",
      sessionId: "session-1",
      decisionId: "decision-1",
      actionIds: ["action-1"],
      causeKind: "action",
      valence: "mixed",
      summary: "迁居带来了职业成长，也暂时增加了孤独感。",
      consequenceFacts: ["开始了新工作", "暂时离开原有朋友网络"],
      sourceEvidenceIds: ["message-10"],
      confidence: 0.9,
      status: "confirmed",
      idempotencyKey: "outcome:message-10",
      schemaVersion: 1,
      ...PERIOD_TIME,
    } as const;
    expect(OutcomeRecordSchema.safeParse(outcome).success).toBe(true);
    expect(
      OutcomeRecordSchema.safeParse({ ...outcome, actionIds: [] }).success,
    ).toBe(false);
  });
});
