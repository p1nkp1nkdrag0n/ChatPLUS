import { FuzzyLifePromptContextSchema } from "@personasim/contracts";
import { describe, expect, it } from "vitest";

import { buildConversationContextPlan } from "./conversation-context-plan.js";
import { selectLifeContextForTurn } from "./life-context-selection.js";

const CONTEXT = FuzzyLifePromptContextSchema.parse({
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
    localDate: "2026-09-06",
    currentPeriod: "morning",
    availability: "free",
    intentions: [],
  },
  ongoingThreads: [
    { subject: "character", title: "整理画册", currentStage: "当前关注" },
  ],
  verifiedRecentOutcomes: [],
  unresolvedDilemmas: [],
  recentDecisionDilemmas: [],
  activePressure: [],
  relationshipMilestones: [],
  evidencedSupport: [],
  recentDecisions: [],
  canonicalCausalFacts: [],
  evidencedActions: [],
  evidencedConsequences: [],
  reflections: [],
});
const planFor = (originalQuery: string) =>
  buildConversationContextPlan({
    originalQuery,
    agentId: "agent-1",
    sessionId: "session-1",
    recentMessages: [],
  });

describe("life context for conversation", () => {
  it("does not expose the character's goals during ordinary sharing or unrelated advice", () => {
    for (const query of [
      "今天路边的猫在晒太阳。",
      "为什么我总把事搞砸？",
      "请帮我选择今晚吃什么",
    ]) {
      const result = selectLifeContextForTurn({
        context: CONTEXT,
        plan: planFor(query),
      });
      expect(result.context).toBeUndefined();
      expect(result.omittedSections).toContain("ongoingThreads");
    }
  });
  it("keeps the bounded snapshot intact when asked about the character's day", () => {
    const result = selectLifeContextForTurn({
      context: CONTEXT,
      plan: planFor("你最近在忙什么？"),
    });
    expect(result.context).toEqual(CONTEXT);
    expect(result.context).not.toBe(CONTEXT);
    result.context!.ongoingThreads.splice(0);
    expect(CONTEXT.ongoingThreads).toHaveLength(1);
    expect(result.omittedSections).toEqual([]);
  });
  it("retains the causal snapshot for explicit help with a named ongoing topic", () => {
    const result = selectLifeContextForTurn({
      context: CONTEXT,
      plan: planFor("请帮我分析整理画册这件事。"),
    });
    expect(result.context).toEqual(CONTEXT);
  });

  it.each([
    "城市速写画得怎么样了？",
    "你最近的城市速写进度如何？",
    "城市速写完成了吗？",
    "“城市速写”画得怎么样了？",
    "城市速写进展？",
    "不用给我提建议，城市速写画得怎么样了？",
    "她说“先别聊你的项目”。城市速写画得怎么样了？",
  ])(
    "selects the named project and its evidence without unrelated life: %s",
    (query) => {
      const source = projectContext();
      const before = structuredClone(source);
      const result = selectLifeContextForTurn({
        context: source,
        plan: planFor(query),
      });
      expect(result.context?.ongoingThreads.map((item) => item.title)).toEqual([
        "城市速写",
      ]);
      expect(result.context?.today.currentFocus).toBeUndefined();
      expect(
        result.context?.today.intentions.map((item) => item.title),
      ).toEqual(["城市速写：画桥边的树"]);
      expect(
        result.context?.verifiedRecentOutcomes.map((item) => item.summary),
      ).toEqual(["城市速写只画了一页，还没有完成"]);
      expect(result.context?.canonicalCausalFacts).toHaveLength(1);
      expect(
        result.context?.canonicalCausalFacts[0]?.outcomes[0]?.summary,
      ).toBe("编辑说还需要修改，尚未采用");
      expect(result.context?.evidencedActions.map((item) => item.id)).toEqual([
        "sketch-action",
      ]);
      expect(
        result.context?.evidencedConsequences.map((item) => item.id),
      ).toEqual(["sketch-outcome"]);
      expect(result.context?.reflections.map((item) => item.id)).toEqual([
        "sketch-reflection",
      ]);
      expect(JSON.stringify(result.context)).not.toContain("吉他");
      expect(result.omittedSections).toContain("ongoingThreads");
      expect(source).toEqual(before);
      expect(FuzzyLifePromptContextSchema.parse(result.context)).toEqual(
        result.context,
      );
    },
  );

  it("resolves a familiar manuscript alias only when exactly one existing title matches", () => {
    const context = projectContext();
    context.ongoingThreads.push({
      subject: "character",
      title: "修改短篇稿件",
      currentStage: "修改中",
    });
    const selected = selectLifeContextForTurn({
      context,
      plan: planFor("稿子后来怎样了？"),
    });
    expect(selected.context?.ongoingThreads.map((item) => item.title)).toEqual([
      "修改短篇稿件",
    ]);
    context.ongoingThreads.push({
      subject: "character",
      title: "整理另一份文稿",
      currentStage: "整理中",
    });
    expect(
      selectLifeContextForTurn({ context, plan: planFor("稿子后来怎样了？") })
        .context,
    ).toBeUndefined();
  });

  it.each([
    "我看见别人有本城市速写。",
    "别人的城市速写画得怎么样了？",
    "先别聊你的项目。",
    "先别聊你的城市速写最近进度。",
    "我今天想买一本城市速写。",
    "她问我“城市速写画得怎么样了”，我觉得挺意外。",
    "我想到城市速写这个词。",
    "城市速写后来搁置了，我只是转述这件事。",
    "城市速写有进展这件事让我挺意外的。",
    "今天看见城市速写。请帮我选晚饭。",
  ])(
    "does not authorize project disclosure from mentions, exclusions, or other owners: %s",
    (query) => {
      expect(
        selectLifeContextForTurn({
          context: projectContext(),
          plan: planFor(query),
        }).context,
      ).toBeUndefined();
    },
  );

  it("does not authorize a life topic from unresolved retrieval expansions", () => {
    const plan = planFor("那件事我该怎么办？");
    plan.expandedQueries = ["城市速写画得怎么样了？"];
    plan.contextMessageIds = ["sketch-message"];
    expect(
      selectLifeContextForTurn({ context: projectContext(), plan }).context,
    ).toBeUndefined();
  });

  it("keeps a proven conversational continuation within its linked causal branch", () => {
    const plan = planFor("她又提了修改意见。");
    plan.resolvedCurrentTopic = {
      basis: "recent_user_continuity",
      text: "城市速写的编辑让我改稿，她比较严格。\n她又提了修改意见。",
      sourceMessageIds: ["sketch-message"],
      policyVersion: "scoped_topic_v1",
    };
    const selected = selectLifeContextForTurn({
      context: projectContext(),
      plan,
    }).context;
    expect(
      selected?.canonicalCausalFacts.map((item) => item.dilemmaId),
    ).toEqual(["sketch-dilemma"]);
    expect(selected?.ongoingThreads).toEqual([]);
    expect(JSON.stringify(selected)).not.toContain("吉他");
  });
});

function projectContext() {
  const facts = ["sketch", "guitar"].map((id) => ({
    dilemmaId: `${id}-dilemma`,
    subject: "character",
    decision: {
      decisionId: `${id}-decision`,
      subject: "character",
      authority: "subject",
      decidedBy: "character",
      selectionSummary: id === "sketch" ? "城市速写先画一页" : "吉他先练一首",
      sourceMessageIds: [`${id}-message`],
    },
    actions: [
      {
        actionId: `${id}-action`,
        decisionId: `${id}-decision`,
        subject: "character",
        performedBy: "character",
        actionKind: "advanced",
        summary: "只试了一遍",
        sourceEvidenceIds: [`${id}-action-message`],
      },
    ],
    outcomes: [
      {
        outcomeId: `${id}-outcome`,
        decisionId: `${id}-decision`,
        subject: "character",
        actionIds: [`${id}-action`],
        causeKind: "mixed",
        valence: "mixed",
        summary:
          id === "sketch" ? "编辑说还需要修改，尚未采用" : "吉他弹奏不太顺利",
        sourceEvidenceIds: [`${id}-outcome-message`],
      },
    ],
    reflections: [],
  }));
  return FuzzyLifePromptContextSchema.parse({
    ...CONTEXT,
    today: {
      ...CONTEXT.today,
      currentFocus: "练吉他",
      intentions: [
        {
          title: "城市速写：画桥边的树",
          period: "afternoon",
          commitmentLevel: "optional",
          status: "intended",
        },
        {
          title: "吉他练习",
          period: "evening",
          commitmentLevel: "optional",
          status: "intended",
        },
      ],
    },
    ongoingThreads: [
      {
        subject: "character",
        title: "城市速写",
        currentStage: "尝试中",
        progressNote: "还未完成",
      },
      { subject: "character", title: "学吉他", currentStage: "练习中" },
    ],
    verifiedRecentOutcomes: [
      {
        subject: "character",
        effectiveLocalDate: "2026-09-05",
        outcomeKind: "partial",
        summary: "城市速写只画了一页，还没有完成",
      },
      {
        subject: "character",
        effectiveLocalDate: "2026-09-05",
        outcomeKind: "partial",
        summary: "吉他只练习了十分钟",
      },
    ],
    canonicalCausalFacts: facts,
    evidencedActions: facts.flatMap((fact) =>
      fact.actions.map(({ actionId, ...action }) => ({
        ...action,
        id: actionId,
        effectiveLocalDate: "2026-09-05",
      })),
    ),
    evidencedConsequences: facts.flatMap((fact) =>
      fact.outcomes.map(({ outcomeId, ...outcome }) => ({
        ...outcome,
        id: outcomeId,
        status: "observed",
        effectiveLocalDate: "2026-09-05",
      })),
    ),
    reflections: facts.map((fact) => ({
      id: fact.dilemmaId.replace("dilemma", "reflection"),
      decisionId: fact.decision.decisionId,
      subject: "character",
      reflectedBy: "character",
      stanceTowardDecision: "mixed",
      summary: "下次慢慢来，不急着证明自己",
      sourceMessageIds: [],
      effectiveLocalDate: "2026-09-06",
    })),
  });
}
