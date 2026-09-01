import {
  COMPANION_LONG_RUN_V3_HARD_GATE_CODES,
  type CompanionLongRunV3HardGateResult,
} from "./companion-long-run-v3-assertions.js";

/** Pure scoring and release-classification rules for a v3 profile run. */

export const COMPANION_LONG_RUN_V3_RUBRIC = [
  { key: "emotion_understanding", weight: 0.2 },
  { key: "pressure_clarity", weight: 0.15 },
  { key: "value_conflict_analysis", weight: 0.2 },
  { key: "recommendation_delegation", weight: 0.1 },
  { key: "causal_continuity", weight: 0.15 },
  { key: "mutual_influence", weight: 0.1 },
  { key: "relationship_accumulation", weight: 0.05 },
  { key: "language_naturalness", weight: 0.05 },
] as const;

export type CompanionLongRunV3RubricDimension =
  (typeof COMPANION_LONG_RUN_V3_RUBRIC)[number]["key"];
export type CompanionLongRunV3RubricScore = 0 | 1 | 2 | 3 | 4;

export const COMPANION_LONG_RUN_V3_CRITICAL_DIMENSIONS = [
  "emotion_understanding",
  "pressure_clarity",
  "value_conflict_analysis",
  "recommendation_delegation",
  "causal_continuity",
  "mutual_influence",
] as const satisfies readonly CompanionLongRunV3RubricDimension[];

export const COMPANION_LONG_RUN_V3_REQUIRED_ARTIFACTS = [
  "run-manifest.json",
  "baseline.sqlite",
  "run.sqlite",
  "conversation.md",
  "model-io.jsonl",
  "causal-evidence.jsonl",
  "turn-evidence.jsonl",
  "hard-gates.json",
  "semantic-scores.json",
  "checkpoints",
  "report.md",
] as const;

export type CompanionLongRunV3RequiredArtifact =
  (typeof COMPANION_LONG_RUN_V3_REQUIRED_ARTIFACTS)[number];

export const COMPANION_LONG_RUN_V3_THRESHOLDS = {
  expectedCandidateTurns: 120,
  overallMinimum: 3,
  criticalDimensionMinimum: 2.8,
  secondaryDimensionMinimum: 2.6,
  ordinaryGroupMinimum: 2.6,
  criticalGroupMinimum: 2.8,
  repairWarningRate: 0.1,
  repairFailureRate: 0.2,
} as const;

export type CompanionLongRunV3FinalStatus =
  | "PASS"
  | "PASS_WITH_WARNINGS"
  | "FAIL_PRODUCT"
  | "FAIL_PROVIDER"
  | "FAIL_SEMANTIC"
  | "PARTIAL"
  | "SKIPPED"
  | "INVALID_RUN";

export interface CompanionLongRunV3SemanticAssessment {
  turnId: string;
  /** Examples: `memory`, `causality`, `branch_A`, `branch_B`. */
  group: string;
  /** Only dimensions declared applicable to this turn should be present. */
  scores: Readonly<
    Partial<
      Record<CompanionLongRunV3RubricDimension, CompanionLongRunV3RubricScore>
    >
  >;
  evidence: readonly string[];
}

export interface CompanionLongRunV3SemanticVeto {
  code: string;
  turnId: string;
  evidence: string;
}

export interface CompanionLongRunV3ArtifactEvidence {
  key: CompanionLongRunV3RequiredArtifact;
  exists: boolean;
  nonEmpty: boolean;
  /** SHA-256 of the file or deterministic directory manifest. */
  sha256?: string;
  expectedSha256?: string;
}

export interface CompanionLongRunV3EvaluationInput {
  expectedCandidateTurns?: number;
  completedCandidateTurns: number;
  hardGateResults: readonly CompanionLongRunV3HardGateResult[];
  semanticAssessments: readonly CompanionLongRunV3SemanticAssessment[];
  /** Groups such as decision/causality/memory/autonomy/A/B that require 2.8. */
  criticalSemanticGroups: readonly string[];
  semanticVetoes: readonly CompanionLongRunV3SemanticVeto[];
  artifacts: readonly CompanionLongRunV3ArtifactEvidence[];
  provider: {
    physicalAttemptCount: number;
    recoveredRetryCount: number;
    unrecoveredFailureCount: number;
    repairedCandidateTurns: number;
  };
  invalidRunReasons?: readonly string[];
  skippedReason?: string;
}

export interface CompanionLongRunV3SemanticAggregate {
  overallScore: number | null;
  dimensionScores: Readonly<
    Record<CompanionLongRunV3RubricDimension, number | null>
  >;
  groupScores: Readonly<Record<string, number | null>>;
  missingDimensions: readonly CompanionLongRunV3RubricDimension[];
}

export interface CompanionLongRunV3ArtifactAggregate {
  complete: boolean;
  missing: readonly CompanionLongRunV3RequiredArtifact[];
  empty: readonly CompanionLongRunV3RequiredArtifact[];
  invalidHashes: readonly CompanionLongRunV3RequiredArtifact[];
}

export interface CompanionLongRunV3EvaluationResult {
  status: CompanionLongRunV3FinalStatus;
  reasons: readonly string[];
  completedCandidateTurns: number;
  expectedCandidateTurns: number;
  hardGates: { passed: number; failed: number; skipped: number };
  semantic: CompanionLongRunV3SemanticAggregate;
  artifacts: CompanionLongRunV3ArtifactAggregate;
  repairRate: number;
}

export function scoreCompanionLongRunV3Assessment(
  scores: CompanionLongRunV3SemanticAssessment["scores"],
): number | null {
  let total = 0;
  let applicableWeight = 0;
  for (const item of COMPANION_LONG_RUN_V3_RUBRIC) {
    const score = scores[item.key];
    if (score === undefined) continue;
    total += score * item.weight;
    applicableWeight += item.weight;
  }
  return applicableWeight === 0 ? null : round(total / applicableWeight);
}

export function aggregateCompanionLongRunV3SemanticScores(
  assessments: readonly CompanionLongRunV3SemanticAssessment[],
): CompanionLongRunV3SemanticAggregate {
  const dimensionScores = Object.fromEntries(
    COMPANION_LONG_RUN_V3_RUBRIC.map((item) => {
      const values = assessments.flatMap((assessment) => {
        const score = assessment.scores[item.key];
        return score === undefined ? [] : [score];
      });
      return [item.key, mean(values)];
    }),
  ) as unknown as Record<CompanionLongRunV3RubricDimension, number | null>;
  const missingDimensions = COMPANION_LONG_RUN_V3_RUBRIC.flatMap((item) =>
    dimensionScores[item.key] === null ? [item.key] : [],
  );
  const overallScore =
    missingDimensions.length > 0
      ? null
      : round(
          COMPANION_LONG_RUN_V3_RUBRIC.reduce(
            (total, item) => total + dimensionScores[item.key]! * item.weight,
            0,
          ),
        );

  const groups = new Map<string, number[]>();
  for (const assessment of assessments) {
    const score = scoreCompanionLongRunV3Assessment(assessment.scores);
    if (score === null) continue;
    const group = groups.get(assessment.group) ?? [];
    group.push(score);
    groups.set(assessment.group, group);
  }
  const groupScores = Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([group, values]) => [group, mean(values)]),
  );
  return { overallScore, dimensionScores, groupScores, missingDimensions };
}

export function aggregateCompanionLongRunV3Artifacts(
  evidence: readonly CompanionLongRunV3ArtifactEvidence[],
): CompanionLongRunV3ArtifactAggregate {
  const byKey = new Map(evidence.map((item) => [item.key, item]));
  const missing: CompanionLongRunV3RequiredArtifact[] = [];
  const empty: CompanionLongRunV3RequiredArtifact[] = [];
  const invalidHashes: CompanionLongRunV3RequiredArtifact[] = [];
  for (const key of COMPANION_LONG_RUN_V3_REQUIRED_ARTIFACTS) {
    const item = byKey.get(key);
    if (item === undefined || !item.exists) {
      missing.push(key);
      continue;
    }
    if (!item.nonEmpty) empty.push(key);
    if (
      item.sha256 === undefined ||
      !/^[a-f\d]{64}$/iu.test(item.sha256) ||
      (item.expectedSha256 !== undefined &&
        item.sha256.toLowerCase() !== item.expectedSha256.toLowerCase())
    ) {
      invalidHashes.push(key);
    }
  }
  return {
    complete:
      missing.length === 0 && empty.length === 0 && invalidHashes.length === 0,
    missing,
    empty,
    invalidHashes,
  };
}

export function aggregateCompanionLongRunV3Evaluation(
  input: CompanionLongRunV3EvaluationInput,
): CompanionLongRunV3EvaluationResult {
  const expectedCandidateTurns =
    input.expectedCandidateTurns ??
    COMPANION_LONG_RUN_V3_THRESHOLDS.expectedCandidateTurns;
  const hardGates = {
    passed: input.hardGateResults.filter((item) => item.status === "PASS")
      .length,
    failed: input.hardGateResults.filter((item) => item.status === "FAIL")
      .length,
    skipped: input.hardGateResults.filter((item) => item.status === "SKIPPED")
      .length,
  };
  const unverifiedHardGates = COMPANION_LONG_RUN_V3_HARD_GATE_CODES.filter(
    (code) =>
      !input.hardGateResults.some(
        (item) => item.code === code && item.status !== "SKIPPED",
      ),
  );
  const semantic = aggregateCompanionLongRunV3SemanticScores(
    input.semanticAssessments,
  );
  const artifacts = aggregateCompanionLongRunV3Artifacts(input.artifacts);
  const repairRate =
    expectedCandidateTurns === 0
      ? 0
      : round(
          input.provider.repairedCandidateTurns / expectedCandidateTurns,
          4,
        );
  const reasons: string[] = [];

  if (input.skippedReason !== undefined) {
    return result("SKIPPED", [input.skippedReason]);
  }
  if ((input.invalidRunReasons?.length ?? 0) > 0) {
    return result("INVALID_RUN", [...input.invalidRunReasons!]);
  }
  if (hardGates.failed > 0) {
    reasons.push(
      ...input.hardGateResults
        .filter((item) => item.status === "FAIL")
        .map((item) => `hard_gate:${item.code}`),
    );
    return result("FAIL_PRODUCT", reasons);
  }
  if (unverifiedHardGates.length > 0) {
    return result("FAIL_PRODUCT", [
      `hard_gates_unverified:${unverifiedHardGates.join(",")}`,
    ]);
  }
  if (!artifacts.complete) {
    if (artifacts.missing.length > 0)
      reasons.push(`artifacts_missing:${artifacts.missing.join(",")}`);
    if (artifacts.empty.length > 0)
      reasons.push(`artifacts_empty:${artifacts.empty.join(",")}`);
    if (artifacts.invalidHashes.length > 0)
      reasons.push(
        `artifacts_hash_invalid:${artifacts.invalidHashes.join(",")}`,
      );
    return result("FAIL_PRODUCT", reasons);
  }
  if (input.provider.unrecoveredFailureCount > 0) {
    return result("FAIL_PROVIDER", [
      `unrecovered_provider_failures:${String(input.provider.unrecoveredFailureCount)}`,
    ]);
  }
  if (input.completedCandidateTurns !== expectedCandidateTurns) {
    return result("PARTIAL", [
      `candidate_turns:${String(input.completedCandidateTurns)}/${String(expectedCandidateTurns)}`,
    ]);
  }
  if (semantic.missingDimensions.length > 0 || semantic.overallScore === null) {
    return result("PARTIAL", [
      `semantic_dimensions_missing:${semantic.missingDimensions.join(",")}`,
    ]);
  }
  if (input.semanticVetoes.length > 0) {
    return result(
      "FAIL_SEMANTIC",
      input.semanticVetoes.map(
        (veto) => `semantic_veto:${veto.code}:${veto.turnId}`,
      ),
    );
  }
  if (repairRate > COMPANION_LONG_RUN_V3_THRESHOLDS.repairFailureRate) {
    return result("FAIL_SEMANTIC", [
      `repair_rate_above_20_percent:${String(repairRate)}`,
    ]);
  }
  if (semantic.overallScore < COMPANION_LONG_RUN_V3_THRESHOLDS.overallMinimum) {
    reasons.push(`overall_semantic_score:${String(semantic.overallScore)}`);
  }
  for (const dimension of COMPANION_LONG_RUN_V3_CRITICAL_DIMENSIONS) {
    const score = semantic.dimensionScores[dimension]!;
    if (score < COMPANION_LONG_RUN_V3_THRESHOLDS.criticalDimensionMinimum) {
      reasons.push(`critical_dimension:${dimension}:${String(score)}`);
    }
  }
  for (const dimension of [
    "relationship_accumulation",
    "language_naturalness",
  ] as const) {
    const score = semantic.dimensionScores[dimension]!;
    if (score < COMPANION_LONG_RUN_V3_THRESHOLDS.secondaryDimensionMinimum) {
      reasons.push(`secondary_dimension:${dimension}:${String(score)}`);
    }
  }
  const criticalGroups = new Set(input.criticalSemanticGroups);
  for (const [group, score] of Object.entries(semantic.groupScores)) {
    if (score === null) continue;
    const minimum = criticalGroups.has(group)
      ? COMPANION_LONG_RUN_V3_THRESHOLDS.criticalGroupMinimum
      : COMPANION_LONG_RUN_V3_THRESHOLDS.ordinaryGroupMinimum;
    if (score < minimum)
      reasons.push(`semantic_group:${group}:${String(score)}`);
  }
  for (const criticalGroup of criticalGroups) {
    if (!(criticalGroup in semantic.groupScores)) {
      reasons.push(`critical_group_missing:${criticalGroup}`);
    }
  }
  if (reasons.length > 0) return result("FAIL_SEMANTIC", reasons);

  if (
    repairRate > COMPANION_LONG_RUN_V3_THRESHOLDS.repairWarningRate ||
    input.provider.recoveredRetryCount > 0
  ) {
    if (repairRate > COMPANION_LONG_RUN_V3_THRESHOLDS.repairWarningRate) {
      reasons.push(`repair_rate_warning:${String(repairRate)}`);
    }
    if (input.provider.recoveredRetryCount > 0) {
      reasons.push(
        `recovered_provider_retries:${String(input.provider.recoveredRetryCount)}`,
      );
    }
    return result("PASS_WITH_WARNINGS", reasons);
  }
  return result("PASS", []);

  function result(
    status: CompanionLongRunV3FinalStatus,
    currentReasons: readonly string[],
  ): CompanionLongRunV3EvaluationResult {
    return {
      status,
      reasons: currentReasons,
      completedCandidateTurns: input.completedCandidateTurns,
      expectedCandidateTurns,
      hardGates,
      semantic,
      artifacts,
      repairRate,
    };
  }
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return round(
    values.reduce((total, value) => total + value, 0) / values.length,
  );
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
