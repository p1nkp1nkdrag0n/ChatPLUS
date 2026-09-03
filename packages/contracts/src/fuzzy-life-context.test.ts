import { describe, expect, it } from "vitest";

import { FuzzyLifePromptContextSchema } from "./fuzzy-life-context.js";

function minimalContext() {
  return {
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
      intentions: [],
    },
    ongoingThreads: [],
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
  };
}

describe("FuzzyLifePromptContextSchema", () => {
  it("accepts the complete persisted fuzzy-life view", () => {
    expect(FuzzyLifePromptContextSchema.parse(minimalContext())).toEqual(
      minimalContext(),
    );
  });

  it("accepts a newly opened life thread before it has a progress note", () => {
    const context = minimalContext();

    expect(
      FuzzyLifePromptContextSchema.parse({
        ...context,
        ongoingThreads: [
          {
            subject: "character",
            title: "准备新的研究主题",
            currentStage: "刚刚开始",
          },
        ],
      }).ongoingThreads[0]?.progressNote,
    ).toBeUndefined();
  });

  it("rejects a partial hand-written UI projection", () => {
    const partialContext: Record<string, unknown> = { ...minimalContext() };
    delete partialContext.semantics;

    expect(() => FuzzyLifePromptContextSchema.parse(partialContext)).toThrow();
  });

  it("rejects semantics that collapse decisions into actions", () => {
    const context = minimalContext();

    expect(() =>
      FuzzyLifePromptContextSchema.parse({
        ...context,
        semantics: {
          ...context.semantics,
          decisionsAreNotActions: false,
        },
      }),
    ).toThrow();
  });
});
