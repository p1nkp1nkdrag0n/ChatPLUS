import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import type { FuzzyLifeContext } from "../api/types";
import { LifeContextOverview } from "./LifeContextOverview";

const context: FuzzyLifeContext = {
  authority: "server_persisted_fuzzy_life",
  semantics: {
    intentionsAreNotOccurrences: true,
    decisionsAreNotActions: true,
    actionsAreNotOutcomes: true,
    characterTimePrecision: "day_or_period",
    characterLifeOwner: "character",
    lifeThreadStagesAdvanceByCharacterLocalDate: true,
    lifeThreadStageIsNotDailyOutcome: true,
    lifeThreadStageIsNotProofOfExternalSuccess: true,
  },
  today: {
    subject: "character",
    localDate: "2026-09-03",
    currentPeriod: "evening",
    availability: "interruptible",
    currentFocus: "整理采访材料",
    intentions: [
      {
        title: "完成采访提纲",
        period: "evening",
        commitmentLevel: "priority",
        status: "intended",
      },
    ],
  },
  ongoingThreads: [
    {
      subject: "character",
      title: "社区报道",
      currentStage: "核对线索",
      progressNote: "已经约到两位受访者。",
      nextStepHint: "明天确认采访地点。",
    },
  ],
  verifiedRecentOutcomes: [],
  unresolvedDilemmas: [
    {
      id: "dilemma-1",
      subject: "character",
      domain: "work",
      title: "是否公开一条敏感线索",
      summary: "公开价值与保护消息源之间仍需权衡。",
      options: ["继续核实", "暂缓公开"],
    },
  ],
  recentDecisionDilemmas: [],
  activePressure: [
    {
      id: "pressure-1",
      subject: "character",
      pressureKind: "work",
      triggerSummary: "截稿时间正在接近。",
      status: "open",
      currentPressure: 0.7,
      currentClarity: 0.5,
      currentFeltUnderstood: 0.6,
      sourceMessageIds: ["message-pressure"],
      latestEvidenceMessageId: "message-pressure",
    },
  ],
  relationshipMilestones: [],
  evidencedSupport: [],
  recentDecisions: [],
  evidencedConsequences: [],
  reflections: [],
  canonicalCausalFacts: [
    {
      dilemmaId: "dilemma-closed",
      subject: "character",
      decision: {
        decisionId: "decision-1",
        subject: "character",
        authority: "subject",
        decidedBy: "character",
        selectionSummary: "先完成交叉核验再发布。",
        sourceMessageIds: ["message-decision"],
      },
      actions: [
        {
          actionId: "action-1",
          decisionId: "decision-1",
          subject: "character",
          performedBy: "character",
          actionKind: "initiated",
          summary: "联系第二位独立消息源。",
          sourceEvidenceIds: ["message-action"],
        },
      ],
      outcomes: [
        {
          outcomeId: "outcome-1",
          decisionId: "decision-1",
          subject: "character",
          actionIds: ["action-1"],
          causeKind: "action",
          valence: "positive",
          summary: "关键事实得到补充确认。",
          sourceEvidenceIds: ["message-outcome"],
        },
      ],
      reflections: [
        {
          reflectionId: "reflection-1",
          decisionId: "decision-1",
          outcomeId: "outcome-1",
          subject: "character",
          reflectedBy: "character",
          stanceTowardDecision: "affirm",
          summary: "谨慎没有拖慢报道，反而提高了可信度。",
          sourceMessageIds: ["message-reflection"],
        },
      ],
    },
  ],
  evidencedActions: [],
};

describe("LifeContextOverview", () => {
  it("turns persisted fuzzy-life context into a user-facing causal narrative", () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <LifeContextOverview value={context} timelineHref="/timeline" />
      </MemoryRouter>,
    );

    expect(markup).toContain("生活脉络");
    expect(markup).toContain("可短暂交流");
    expect(markup).toContain("整理采访材料");
    expect(markup).toContain("是否公开一条敏感线索");
    expect(markup).toContain("压力 70%");
    expect(markup).toContain("先完成交叉核验再发布");
    expect(markup).toContain("联系第二位独立消息源");
    expect(markup).toContain("关键事实得到补充确认");
    expect(markup).toContain("谨慎没有拖慢报道");
  });
});
