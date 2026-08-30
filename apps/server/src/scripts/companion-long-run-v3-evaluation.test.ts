import { describe, expect, it } from "vitest";

import {
  COMPANION_LONG_RUN_V3_HARD_GATE_CODES,
  type CompanionLongRunV3HardGateResult,
} from "./companion-long-run-v3-assertions.js";
import {
  COMPANION_LONG_RUN_V3_REQUIRED_ARTIFACTS,
  aggregateCompanionLongRunV3Artifacts,
  aggregateCompanionLongRunV3Evaluation,
  aggregateCompanionLongRunV3SemanticScores,
  scoreCompanionLongRunV3Assessment,
  type CompanionLongRunV3ArtifactEvidence,
  type CompanionLongRunV3EvaluationInput,
  type CompanionLongRunV3RubricDimension,
  type CompanionLongRunV3RubricScore,
  type CompanionLongRunV3SemanticAssessment,
} from "./companion-long-run-v3-evaluation.js";

describe("companion long-run v3 semantic scoring", () => {
  it("uses the frozen eight-dimension weighting and normalizes partial turn rubrics", () => {
    expect(scoreCompanionLongRunV3Assessment(scores(3))).toBe(3);
    expect(
      scoreCompanionLongRunV3Assessment({
        emotion_understanding: 4,
        pressure_clarity: 2,
      }),
    ).toBe(3.14);
  });

  it("aggregates dimensions and named stages independently", () => {
    const aggregate = aggregateCompanionLongRunV3SemanticScores([
      assessment("T1", "daily", scores(3)),
      assessment("T48", "decision", scores(4)),
    ]);
    expect(aggregate.overallScore).toBe(3.5);
    expect(aggregate.dimensionScores.causal_continuity).toBe(3.5);
    expect(aggregate.groupScores).toEqual({ daily: 3, decision: 4 });
    expect(aggregate.missingDimensions).toEqual([]);
  });

  it("does not manufacture an overall score when a dimension was never judged", () => {
    const aggregate = aggregateCompanionLongRunV3SemanticScores([
      assessment("T26", "emotion", { emotion_understanding: 4 }),
    ]);
    expect(aggregate.overallScore).toBeNull();
    expect(aggregate.missingDimensions).toContain("causal_continuity");
  });
});

describe("companion long-run v3 artifact hard gate", () => {
  it("requires every artifact to be non-empty and hash-verifiable", () => {
    expect(aggregateCompanionLongRunV3Artifacts(artifacts()).complete).toBe(
      true,
    );
    const damaged = artifacts().map((item) =>
      item.key === "model-io.jsonl" ? { ...item, sha256: "bad" } : item,
    );
    expect(aggregateCompanionLongRunV3Artifacts(damaged)).toMatchObject({
      complete: false,
      invalidHashes: ["model-io.jsonl"],
    });
  });
});

describe("companion long-run v3 final classification", () => {
  it("passes exactly 120 turns with all hard gates, artifacts, dimensions, and stages", () => {
    expect(aggregateCompanionLongRunV3Evaluation(validInput()).status).toBe(
      "PASS",
    );
  });

  it("classifies hard-gate or artifact failure as product failure before semantics", () => {
    const hardFailure = validInput({
      hardGateResults: [hardGate("no_schedule_growth", "FAIL")],
      semanticVetoes: [
        { code: "fabricated_outcome", turnId: "T49", evidence: "bad" },
      ],
    });
    expect(aggregateCompanionLongRunV3Evaluation(hardFailure)).toMatchObject({
      status: "FAIL_PRODUCT",
      reasons: ["hard_gate:no_schedule_growth"],
    });

    const missingArtifacts = artifacts().filter(
      (item) => item.key !== "conversation.md",
    );
    expect(
      aggregateCompanionLongRunV3Evaluation(
        validInput({ artifacts: missingArtifacts }),
      ).status,
    ).toBe("FAIL_PRODUCT");
  });

  it("cannot pass when the runner omitted a required hard gate", () => {
    const incomplete = validInput({
      hardGateResults: [hardGate("daily_context_unique", "PASS")],
    });
    expect(aggregateCompanionLongRunV3Evaluation(incomplete)).toMatchObject({
      status: "FAIL_PRODUCT",
    });
    expect(
      aggregateCompanionLongRunV3Evaluation(incomplete).reasons[0],
    ).toContain("hard_gates_unverified:");
  });

  it("separates unrecovered provider failure from an incomplete clean run", () => {
    expect(
      aggregateCompanionLongRunV3Evaluation(
        validInput({
          completedCandidateTurns: 63,
          provider: {
            physicalAttemptCount: 65,
            recoveredRetryCount: 1,
            unrecoveredFailureCount: 1,
            repairedCandidateTurns: 0,
          },
        }),
      ).status,
    ).toBe("FAIL_PROVIDER");
    expect(
      aggregateCompanionLongRunV3Evaluation(
        validInput({ completedCandidateTurns: 119 }),
      ).status,
    ).toBe("PARTIAL");
  });

  it("enforces critical dimension, critical group, and semantic veto thresholds", () => {
    const weakDimension = scores(4, { recommendation_delegation: 2 });
    const dimensionResult = aggregateCompanionLongRunV3Evaluation(
      validInput({
        semanticAssessments: [assessment("T48", "decision", weakDimension)],
      }),
    );
    expect(dimensionResult.semantic.overallScore).toBeGreaterThan(3);
    expect(dimensionResult.status).toBe("FAIL_SEMANTIC");
    expect(dimensionResult.reasons).toContain(
      "critical_dimension:recommendation_delegation:2",
    );

    const groupResult = aggregateCompanionLongRunV3Evaluation(
      validInput({
        semanticAssessments: [
          assessment("T1", "daily", scores(4)),
          assessment("T48", "decision", scores(2)),
        ],
      }),
    );
    expect(groupResult.status).toBe("FAIL_SEMANTIC");
    expect(groupResult.reasons).toContain("semantic_group:decision:2");

    const vetoResult = aggregateCompanionLongRunV3Evaluation(
      validInput({
        semanticVetoes: [
          {
            code: "unknown_fact_fabricated",
            turnId: "T102",
            evidence: "Invented a mentor name",
          },
        ],
      }),
    );
    expect(vetoResult.status).toBe("FAIL_SEMANTIC");
  });

  it("warns above 10% repairs, fails above 20%, and warns on recovered retries", () => {
    const warning = aggregateCompanionLongRunV3Evaluation(
      validInput({
        provider: {
          physicalAttemptCount: 133,
          recoveredRetryCount: 0,
          unrecoveredFailureCount: 0,
          repairedCandidateTurns: 13,
        },
      }),
    );
    expect(warning.status).toBe("PASS_WITH_WARNINGS");

    const failure = aggregateCompanionLongRunV3Evaluation(
      validInput({
        provider: {
          physicalAttemptCount: 145,
          recoveredRetryCount: 0,
          unrecoveredFailureCount: 0,
          repairedCandidateTurns: 25,
        },
      }),
    );
    expect(failure.status).toBe("FAIL_SEMANTIC");

    const recovered = aggregateCompanionLongRunV3Evaluation(
      validInput({
        provider: {
          physicalAttemptCount: 121,
          recoveredRetryCount: 1,
          unrecoveredFailureCount: 0,
          repairedCandidateTurns: 0,
        },
      }),
    );
    expect(recovered).toMatchObject({
      status: "PASS_WITH_WARNINGS",
      reasons: ["recovered_provider_retries:1"],
    });
  });

  it("marks missing rubric coverage or a missing critical stage as partial/semantic failure", () => {
    const partial = aggregateCompanionLongRunV3Evaluation(
      validInput({
        semanticAssessments: [
          assessment("T1", "daily", { emotion_understanding: 4 }),
        ],
      }),
    );
    expect(partial.status).toBe("PARTIAL");

    const missingGroup = aggregateCompanionLongRunV3Evaluation(
      validInput({ criticalSemanticGroups: ["decision", "branch_A"] }),
    );
    expect(missingGroup.status).toBe("FAIL_SEMANTIC");
    expect(missingGroup.reasons).toContain("critical_group_missing:branch_A");
  });
});

function validInput(
  overrides: Partial<CompanionLongRunV3EvaluationInput> = {},
): CompanionLongRunV3EvaluationInput {
  return {
    completedCandidateTurns: 120,
    hardGateResults: COMPANION_LONG_RUN_V3_HARD_GATE_CODES.map((code) =>
      hardGate(code, "PASS"),
    ),
    semanticAssessments: [assessment("T48", "decision", scores(3))],
    criticalSemanticGroups: ["decision"],
    semanticVetoes: [],
    artifacts: artifacts(),
    provider: {
      physicalAttemptCount: 120,
      recoveredRetryCount: 0,
      unrecoveredFailureCount: 0,
      repairedCandidateTurns: 0,
    },
    ...overrides,
  };
}

function hardGate(
  code: CompanionLongRunV3HardGateResult["code"],
  status: CompanionLongRunV3HardGateResult["status"],
): CompanionLongRunV3HardGateResult {
  return { code, status, summary: code };
}

function artifacts(): CompanionLongRunV3ArtifactEvidence[] {
  return COMPANION_LONG_RUN_V3_REQUIRED_ARTIFACTS.map((key, index) => ({
    key,
    exists: true,
    nonEmpty: true,
    sha256: (index % 10).toString().repeat(64),
  }));
}

function assessment(
  turnId: string,
  group: string,
  assessmentScores: CompanionLongRunV3SemanticAssessment["scores"],
): CompanionLongRunV3SemanticAssessment {
  return {
    turnId,
    group,
    scores: assessmentScores,
    evidence: [`${turnId}: evidence`],
  };
}

function scores(
  value: CompanionLongRunV3RubricScore,
  overrides: Partial<
    Record<CompanionLongRunV3RubricDimension, CompanionLongRunV3RubricScore>
  > = {},
): Record<CompanionLongRunV3RubricDimension, CompanionLongRunV3RubricScore> {
  return {
    emotion_understanding: value,
    pressure_clarity: value,
    value_conflict_analysis: value,
    recommendation_delegation: value,
    causal_continuity: value,
    mutual_influence: value,
    relationship_accumulation: value,
    language_naturalness: value,
    ...overrides,
  };
}
