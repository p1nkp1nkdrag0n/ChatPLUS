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
});
