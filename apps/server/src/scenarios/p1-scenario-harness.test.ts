import { describe, expect, it } from "vitest";

import {
  P1_SCENARIO_NAMES,
  runP1Scenario,
  type P1ScenarioName,
  type P1ScenarioReport,
} from "./p1-scenario-harness.js";

const EXPECTED_CRITERIA: Record<P1ScenarioName, string> = {
  "party-invite": "planned facts never become occurred facts",
  "self-initiated": "proactive generation cannot overtake a returning user",
  "night-life": "checkpoint compression retains original messages",
  "false-memory": "a reliable later conflict supersedes the older memory",
  "offline-72h": "prompt size stays bounded by retained context, not history",
  "trip-share": "autobiography entries retain a verified evidence chain",
  "user-followup": "FollowUpIntent resolves or cancels conservatively",
  "30-day-life": "30 days under FakeClock remain stable and bounded",
  "checkpoint-conflict": "derived continuity indexes are fully rebuildable",
  "date-recall": "date recall never returns facts outside the resolved range",
};

describe("P1-15 executable acceptance scenarios", () => {
  it.each(P1_SCENARIO_NAMES)("%s", async (scenario) => {
    const report = await runP1Scenario(scenario);

    expect(report.scenario).toBe(scenario);
    expect(report.acceptanceCriterion).toBe(EXPECTED_CRITERIA[scenario]);
    expect(report.assertions.length).toBeGreaterThan(0);
    expect(report.assertions.every((item) => item.passed)).toBe(true);
    expect(Number.isFinite(report.tokenCost.estimatedInputTokens)).toBe(true);
    expect(Number.isFinite(report.tokenCost.estimatedOutputTokens)).toBe(true);
    expect(Number.isInteger(report.tokenCost.modelCalls)).toBe(true);
    expect(report.tokenCost.estimatedInputTokens).toBeGreaterThanOrEqual(0);
    expect(report.tokenCost.estimatedOutputTokens).toBeGreaterThanOrEqual(0);
    expect(report.tokenCost.modelCalls).toBeGreaterThanOrEqual(0);
    expect(Object.keys(report).sort()).toEqual(requiredReportKeys().sort());
  });
});

function requiredReportKeys(): Array<keyof P1ScenarioReport> {
  return [
    "scenario",
    "acceptanceCriterion",
    "initialCharacter",
    "initialState",
    "initialSchedule",
    "input",
    "proposal",
    "acceptedEffects",
    "rejectedEffects",
    "domainEvents",
    "finalState",
    "memories",
    "proactiveCandidates",
    "tokenCost",
    "assertions",
  ];
}
