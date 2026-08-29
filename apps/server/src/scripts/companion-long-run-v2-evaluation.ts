/**
 * Pure planning and aggregation primitives for the companion long-run v2
 * evaluation.  This module deliberately has no filesystem, network, clock or
 * environment dependencies so an evaluation plan can be reproduced from its
 * inputs and seed alone.
 */

export const COMPANION_LONG_RUN_V2_PROFILE_ORDER = [
  "deepseek",
  "claude",
  "grok",
  "gemini",
  "gpt56-sol",
  "bigmodel",
] as const;

export type CompanionLongRunV2Profile =
  (typeof COMPANION_LONG_RUN_V2_PROFILE_ORDER)[number];

/**
 * Each run has two reviewers.  Across the three runs every non-subject
 * profile reviews the subject at least once; offset +2 is repeated to make the
 * six assignments balance exactly.
 */
export const COMPANION_LONG_RUN_V2_REVIEWER_OFFSET_PAIRS = [
  [1, 2],
  [2, 4],
  [3, 5],
] as const;

export const COMPANION_LONG_RUN_V2_REVIEWER_OFFSETS_BY_REPETITION =
  COMPANION_LONG_RUN_V2_REVIEWER_OFFSET_PAIRS;

export type CompanionLongRunV2ReviewRound = 1 | 2 | 3;
export type CompanionLongRunV2Repetition = CompanionLongRunV2ReviewRound;

export const COMPANION_LONG_RUN_V2_REVIEW_BATCH_SIZE = 10 as const;

export const COMPANION_LONG_RUN_V2_RUBRIC = [
  {
    key: "persona",
    weight: 0.2,
    description:
      "Persona identity, traits, values, contradiction and voice remain specific and coherent.",
  },
  {
    key: "daily_relevance",
    weight: 0.15,
    description:
      "The response remains useful and relevant to the user's daily context.",
  },
  {
    key: "emotion",
    weight: 0.2,
    description:
      "The response recognizes and follows the user's emotion without flattening or overreaching.",
  },
  {
    key: "memory_time",
    weight: 0.15,
    description:
      "Recall, correction, abstention and temporal claims stay grounded in available evidence.",
  },
  {
    key: "relationship_romance",
    weight: 0.15,
    description:
      "Warmth, repair, familiarity and romantic progression fit the established relationship state.",
  },
  {
    key: "independent_life_schedule",
    weight: 0.1,
    description:
      "The character sustains a causally grounded independent life and coherent schedule.",
  },
  {
    key: "language_naturalness",
    weight: 0.05,
    description:
      "The language is natural, specific and non-repetitive rather than generic assistant talk.",
  },
] as const;

export type CompanionLongRunV2RubricDimension =
  (typeof COMPANION_LONG_RUN_V2_RUBRIC)[number]["key"];

export type CompanionLongRunV2RubricScore = 0 | 1 | 2 | 3 | 4;

export const COMPANION_LONG_RUN_V2_SCORE_ANCHORS = {
  0: "Collapsed or contradicted the dimension, with clear harmful or fabricated behavior.",
  1: "Major recurring failures dominate the evaluated unit.",
  2: "Mixed or merely acceptable performance with material weaknesses.",
  3: "Consistently good performance with only minor weaknesses.",
  4: "Excellent, specific and sustained performance with no material weakness.",
} as const satisfies Readonly<Record<CompanionLongRunV2RubricScore, string>>;

export type CompanionLongRunV2RubricScores = Readonly<
  Record<CompanionLongRunV2RubricDimension, CompanionLongRunV2RubricScore>
>;

export const COMPANION_LONG_RUN_V2_THRESHOLDS = {
  profileMinimumScore: 3,
  runMinimumScore: 2.6,
  /** Compatibility alias for the profile-level release minimum. */
  semanticPassScore: 3,
  criticalDimensionMinimum: 2.8,
  providerFailureRate: 0.2,
  nearThresholdDistance: 0.25,
  blindAuditMinimumRate: 0.2,
  reviewerDifferencePriority: 1,
  calibrationMaximumMae: 0.5,
  calibrationMinimumAgreementRate: 0.8,
} as const;

export const COMPANION_LONG_RUN_V2_CRITICAL_DIMENSIONS = [
  "persona",
  "memory_time",
  "emotion",
  "relationship_romance",
] as const satisfies readonly CompanionLongRunV2RubricDimension[];

export type CompanionLongRunV2SemanticConclusion =
  "PASS" | "PASS_WITH_WARNINGS" | "FAIL_SEMANTIC";

export type CompanionLongRunV2Classification =
  | "PASS"
  | "PASS_WITH_WARNINGS"
  | "FAIL_PRODUCT"
  | "FAIL_PROVIDER"
  | "FAIL_SEMANTIC"
  | "PARTIAL"
  | "SKIPPED";

export type CompanionLongRunV2ExecutionStatus =
  "completed" | "product_failure" | "provider_failure" | "skipped";

export interface CompanionLongRunV2EvaluationItemRef {
  itemId: string;
  profile: CompanionLongRunV2Profile;
  scenarioId: string;
  runId: string;
  /** The matrix repetition selects its fixed reviewer offset pair. */
  repetition?: CompanionLongRunV2Repetition;
  /** One based. When omitted, callers must supply a default round to planning. */
  reviewRound?: CompanionLongRunV2ReviewRound;
}

export interface CompanionLongRunV2ReviewAssignment extends CompanionLongRunV2EvaluationItemRef {
  assignmentId: string;
  repetition: CompanionLongRunV2Repetition;
  reviewRound: CompanionLongRunV2ReviewRound;
  reviewerSlot: 1 | 2;
  reviewerProfile: CompanionLongRunV2Profile;
}

export interface CompanionLongRunV2ReviewBatch {
  batchId: string;
  reviewRound: CompanionLongRunV2ReviewRound;
  reviewerProfile: CompanionLongRunV2Profile;
  assignments: readonly CompanionLongRunV2ReviewAssignment[];
}

export interface CompanionLongRunV2SemanticReview {
  reviewId: string;
  itemId: string;
  subjectProfile: CompanionLongRunV2Profile;
  reviewerProfile: CompanionLongRunV2Profile;
  scores: CompanionLongRunV2RubricScores;
  conclusion: CompanionLongRunV2SemanticConclusion;
}

export interface CompanionLongRunV2EvaluationItem extends CompanionLongRunV2EvaluationItemRef {
  executionStatus: CompanionLongRunV2ExecutionStatus;
  /** Deterministic product assertions. Any entry is release-blocking. */
  productFailureCodes?: readonly string[];
  /** Non-blocking recovery or repair events that require a warning verdict. */
  repairWarningCodes?: readonly string[];
  reviews?: readonly CompanionLongRunV2SemanticReview[];
}

export interface CompanionLongRunV2ItemReviewAggregate extends CompanionLongRunV2EvaluationItemRef {
  reviewCount: number;
  complete: boolean;
  averageScores: Readonly<Record<CompanionLongRunV2RubricDimension, number>>;
  weightedScore: number | null;
  weightedScoreDifference: number | null;
  maximumDimensionDifference: number | null;
  conclusion: CompanionLongRunV2SemanticConclusion | null;
  conclusionDisagreement: boolean;
}

export interface CompanionLongRunV2HumanCalibrationSample {
  sampleId: string;
  automatedScore: number;
  humanScore: number;
  automatedConclusion: CompanionLongRunV2SemanticConclusion;
  humanConclusion: CompanionLongRunV2SemanticConclusion;
}

export interface CompanionLongRunV2HumanCalibrationResult {
  sampleCount: number;
  meanAbsoluteError: number | null;
  conclusionAgreementRate: number | null;
  calibrated: boolean;
  provisional: boolean;
  reasons: readonly string[];
}

export interface CompanionLongRunV2AggregateResult {
  classification: CompanionLongRunV2Classification;
  provisional: boolean;
  reasons: readonly string[];
  itemCount: number;
  completedCount: number;
  skippedCount: number;
  providerFailureCount: number;
  productFailureCount: number;
  providerFailureRate: number;
  semanticWeightedScore: number | null;
  profileScores: Readonly<
    Partial<Record<CompanionLongRunV2Profile, number | null>>
  >;
  runScores: Readonly<Record<string, number | null>>;
  dimensionScores: Readonly<
    Record<CompanionLongRunV2RubricDimension, number | null>
  >;
  itemAggregates: readonly CompanionLongRunV2ItemReviewAggregate[];
}

export type CompanionLongRunV2BlindPriorityReason =
  "REVIEWER_DIFFERENCE" | "CONCLUSION_DISAGREEMENT" | "NEAR_SEMANTIC_THRESHOLD";

export interface CompanionLongRunV2BlindAuditSelection {
  blindId: string;
  /** Keep this mapping out of the reviewer-facing packet. */
  itemId: string;
  priorityReasons: readonly CompanionLongRunV2BlindPriorityReason[];
}

const PROFILE_INDEX = new Map<CompanionLongRunV2Profile, number>(
  COMPANION_LONG_RUN_V2_PROFILE_ORDER.map((profile, index) => [profile, index]),
);

const RUBRIC_KEYS = COMPANION_LONG_RUN_V2_RUBRIC.map((entry) => entry.key);
const RUBRIC_KEY_SET = new Set<string>(RUBRIC_KEYS);

export function companionLongRunV2StableHash(
  seed: string | number,
  ...parts: readonly string[]
): string {
  const input = [String(seed), ...parts].join("\u001f");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function companionLongRunV2ReviewersFor(
  subjectProfile: CompanionLongRunV2Profile,
  reviewRound: CompanionLongRunV2ReviewRound,
): readonly [CompanionLongRunV2Profile, CompanionLongRunV2Profile] {
  const subjectIndex = PROFILE_INDEX.get(subjectProfile);
  if (subjectIndex === undefined) {
    throw new TypeError(`Unknown v2 profile: ${String(subjectProfile)}`);
  }
  assertReviewRound(reviewRound);
  const offsets = COMPANION_LONG_RUN_V2_REVIEWER_OFFSET_PAIRS[reviewRound - 1];
  if (offsets === undefined) {
    throw new Error("The fixed reviewer offset plan is incomplete.");
  }
  const first =
    COMPANION_LONG_RUN_V2_PROFILE_ORDER[
      (subjectIndex + offsets[0]) % COMPANION_LONG_RUN_V2_PROFILE_ORDER.length
    ];
  const second =
    COMPANION_LONG_RUN_V2_PROFILE_ORDER[
      (subjectIndex + offsets[1]) % COMPANION_LONG_RUN_V2_PROFILE_ORDER.length
    ];
  if (
    first === undefined ||
    second === undefined ||
    first === subjectProfile ||
    second === subjectProfile ||
    first === second
  ) {
    throw new Error("The fixed reviewer offset plan produced an invalid pair.");
  }
  return [first, second];
}

export const companionLongRunV2ReviewersForRepetition =
  companionLongRunV2ReviewersFor;

export function planCompanionLongRunV2ReviewAssignments(
  items: readonly CompanionLongRunV2EvaluationItemRef[],
  defaultReviewRound?: CompanionLongRunV2ReviewRound,
): readonly CompanionLongRunV2ReviewAssignment[] {
  assertUniqueEvaluationItems(items);
  const assignments: CompanionLongRunV2ReviewAssignment[] = [];
  for (const item of stableSortItems(items)) {
    if (
      item.repetition !== undefined &&
      item.reviewRound !== undefined &&
      item.repetition !== item.reviewRound
    ) {
      throw new TypeError(
        `Evaluation item ${item.itemId} has conflicting repetition and reviewRound.`,
      );
    }
    const reviewRound =
      item.repetition ?? item.reviewRound ?? defaultReviewRound;
    if (reviewRound === undefined) {
      throw new TypeError(
        `Evaluation item ${item.itemId} must provide repetition/reviewRound or use a defaultReviewRound.`,
      );
    }
    const reviewers = companionLongRunV2ReviewersFor(item.profile, reviewRound);
    reviewers.forEach((reviewerProfile, reviewerIndex) => {
      const reviewerSlot = reviewerIndex === 0 ? 1 : 2;
      assignments.push({
        ...item,
        assignmentId: `review-${companionLongRunV2StableHash(
          "assignment-v2",
          item.itemId,
          String(reviewRound),
          reviewerProfile,
        )}`,
        repetition: reviewRound,
        reviewRound,
        reviewerSlot,
        reviewerProfile,
      });
    });
  }
  return assignments;
}

/** Useful for calibration rehearsals; production runs normally set one round per item. */
export function planCompanionLongRunV2AllOffsetAssignments(
  items: readonly CompanionLongRunV2EvaluationItemRef[],
): readonly CompanionLongRunV2ReviewAssignment[] {
  return ([1, 2, 3] as const).flatMap((reviewRound) =>
    planCompanionLongRunV2ReviewAssignments(
      items.map((item) => ({
        itemId: item.itemId,
        profile: item.profile,
        scenarioId: item.scenarioId,
        runId: item.runId,
      })),
      reviewRound,
    ),
  );
}

export function planCompanionLongRunV2ReviewBatches(
  assignments: readonly CompanionLongRunV2ReviewAssignment[],
  batchSize = COMPANION_LONG_RUN_V2_REVIEW_BATCH_SIZE,
): readonly CompanionLongRunV2ReviewBatch[] {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError("Review batch size must be a positive integer.");
  }
  const seenAssignmentIds = new Set<string>();
  const groups = new Map<string, CompanionLongRunV2ReviewAssignment[]>();
  for (const assignment of assignments) {
    assertNonEmpty(assignment.assignmentId, "assignmentId");
    assertNonEmpty(assignment.itemId, "itemId");
    assertReviewRound(assignment.reviewRound);
    if (assignment.reviewerProfile === assignment.profile) {
      throw new Error(
        `Self-review is forbidden for ${assignment.assignmentId}.`,
      );
    }
    if (seenAssignmentIds.has(assignment.assignmentId)) {
      throw new Error(
        `Duplicate review assignment: ${assignment.assignmentId}`,
      );
    }
    seenAssignmentIds.add(assignment.assignmentId);
    const key = `${String(assignment.reviewRound)}\u001f${assignment.reviewerProfile}`;
    const group = groups.get(key) ?? [];
    group.push(assignment);
    groups.set(key, group);
  }

  const batches: CompanionLongRunV2ReviewBatch[] = [];
  const sortedGroups = [...groups.entries()].sort(([left], [right]) =>
    compareText(left, right),
  );
  for (const [key, group] of sortedGroups) {
    const sorted = [...group].sort(compareAssignments);
    for (let start = 0; start < sorted.length; start += batchSize) {
      const chunk = sorted.slice(start, start + batchSize);
      const first = chunk[0];
      if (first === undefined) continue;
      const batchNumber = Math.floor(start / batchSize) + 1;
      batches.push({
        batchId: `batch-${companionLongRunV2StableHash(
          "review-batch-v2",
          key,
          String(batchNumber),
          ...chunk.map((assignment) => assignment.assignmentId),
        )}`,
        reviewRound: first.reviewRound,
        reviewerProfile: first.reviewerProfile,
        assignments: chunk,
      });
    }
  }
  return batches;
}

export function scoreCompanionLongRunV2Rubric(
  scores: CompanionLongRunV2RubricScores,
): number {
  assertCompleteRubricScores(scores);
  return Number(
    COMPANION_LONG_RUN_V2_RUBRIC.reduce(
      (total, dimension) => total + scores[dimension.key] * dimension.weight,
      0,
    ).toFixed(12),
  );
}

export function aggregateCompanionLongRunV2ItemReviews(
  item: CompanionLongRunV2EvaluationItemRef,
  reviews: readonly CompanionLongRunV2SemanticReview[],
): CompanionLongRunV2ItemReviewAggregate {
  assertItemRef(item);
  const reviewIds = new Set<string>();
  const reviewerProfiles = new Set<CompanionLongRunV2Profile>();
  for (const review of reviews) {
    assertNonEmpty(review.reviewId, "reviewId");
    if (reviewIds.has(review.reviewId)) {
      throw new Error(`Duplicate semantic review: ${review.reviewId}`);
    }
    reviewIds.add(review.reviewId);
    if (
      review.itemId !== item.itemId ||
      review.subjectProfile !== item.profile
    ) {
      throw new Error(
        `Review ${review.reviewId} does not target ${item.itemId}.`,
      );
    }
    if (review.reviewerProfile === item.profile) {
      throw new Error(`Self-review is forbidden for ${review.reviewId}.`);
    }
    if (reviewerProfiles.has(review.reviewerProfile)) {
      throw new Error(
        `Item ${item.itemId} requires two distinct reviewer profiles.`,
      );
    }
    reviewerProfiles.add(review.reviewerProfile);
    assertCompleteRubricScores(review.scores);
  }
  if (reviews.length > 2) {
    throw new Error(`Item ${item.itemId} accepts exactly two primary reviews.`);
  }

  const emptyScores = Object.fromEntries(
    RUBRIC_KEYS.map((key) => [key, 0]),
  ) as Record<CompanionLongRunV2RubricDimension, number>;
  if (reviews.length === 0) {
    return {
      ...item,
      reviewCount: 0,
      complete: false,
      averageScores: emptyScores,
      weightedScore: null,
      weightedScoreDifference: null,
      maximumDimensionDifference: null,
      conclusion: null,
      conclusionDisagreement: false,
    };
  }

  const averageScores = { ...emptyScores };
  for (const dimension of RUBRIC_KEYS) {
    averageScores[dimension] =
      reviews.reduce((total, review) => total + review.scores[dimension], 0) /
      reviews.length;
  }
  const weightedScores = reviews.map((review) =>
    scoreCompanionLongRunV2Rubric(review.scores),
  );
  const complete = reviews.length === 2;
  const weightedScoreDifference = complete
    ? Math.abs((weightedScores[0] ?? 0) - (weightedScores[1] ?? 0))
    : null;
  const maximumDimensionDifference = complete
    ? Math.max(
        ...RUBRIC_KEYS.map((dimension) =>
          Math.abs(
            (reviews[0]?.scores[dimension] ?? 0) -
              (reviews[1]?.scores[dimension] ?? 0),
          ),
        ),
      )
    : null;
  const conclusionDisagreement =
    complete && reviews[0]?.conclusion !== reviews[1]?.conclusion;
  return {
    ...item,
    reviewCount: reviews.length,
    complete,
    averageScores,
    weightedScore:
      weightedScores.reduce((total, value) => total + value, 0) /
      weightedScores.length,
    weightedScoreDifference,
    maximumDimensionDifference,
    conclusion: aggregateSemanticConclusion(
      reviews.map((review) => review.conclusion),
    ),
    conclusionDisagreement,
  };
}

export function evaluateCompanionLongRunV2HumanCalibration(
  samples: readonly CompanionLongRunV2HumanCalibrationSample[],
): CompanionLongRunV2HumanCalibrationResult {
  const sampleIds = new Set<string>();
  let totalAbsoluteError = 0;
  let agreements = 0;
  for (const sample of samples) {
    assertNonEmpty(sample.sampleId, "calibration sampleId");
    if (sampleIds.has(sample.sampleId)) {
      throw new Error(`Duplicate calibration sample: ${sample.sampleId}`);
    }
    sampleIds.add(sample.sampleId);
    assertScoreRange(sample.automatedScore, "automatedScore");
    assertScoreRange(sample.humanScore, "humanScore");
    totalAbsoluteError += Math.abs(sample.automatedScore - sample.humanScore);
    if (sample.automatedConclusion === sample.humanConclusion) agreements += 1;
  }
  const meanAbsoluteError =
    samples.length === 0 ? null : totalAbsoluteError / samples.length;
  const conclusionAgreementRate =
    samples.length === 0 ? null : agreements / samples.length;
  const reasons: string[] = [];
  if (samples.length === 0) {
    reasons.push("Human calibration has no audited samples.");
  } else {
    if (
      meanAbsoluteError === null ||
      meanAbsoluteError > COMPANION_LONG_RUN_V2_THRESHOLDS.calibrationMaximumMae
    ) {
      reasons.push(
        `Human calibration MAE exceeds ${String(COMPANION_LONG_RUN_V2_THRESHOLDS.calibrationMaximumMae)}.`,
      );
    }
    if (
      conclusionAgreementRate === null ||
      conclusionAgreementRate <
        COMPANION_LONG_RUN_V2_THRESHOLDS.calibrationMinimumAgreementRate
    ) {
      reasons.push(
        `Human calibration conclusion agreement is below ${String(COMPANION_LONG_RUN_V2_THRESHOLDS.calibrationMinimumAgreementRate)}.`,
      );
    }
  }
  const calibrated = reasons.length === 0;
  return {
    sampleCount: samples.length,
    meanAbsoluteError,
    conclusionAgreementRate,
    calibrated,
    provisional: !calibrated,
    reasons,
  };
}

export function aggregateCompanionLongRunV2Evaluation(input: {
  items: readonly CompanionLongRunV2EvaluationItem[];
  calibration?: CompanionLongRunV2HumanCalibrationResult;
}): CompanionLongRunV2AggregateResult {
  assertUniqueEvaluationItems(input.items);
  const completed = input.items.filter(
    (item) => item.executionStatus === "completed",
  );
  const skippedCount = input.items.filter(
    (item) => item.executionStatus === "skipped",
  ).length;
  const providerFailureCount = input.items.filter(
    (item) => item.executionStatus === "provider_failure",
  ).length;
  const productFailureCount = new Set(
    input.items
      .filter(
        (item) =>
          item.executionStatus === "product_failure" ||
          (item.productFailureCodes?.length ?? 0) > 0,
      )
      .map((item) => item.itemId),
  ).size;
  const attemptedCount = input.items.length - skippedCount;
  const providerFailureRate =
    attemptedCount === 0 ? 0 : providerFailureCount / attemptedCount;
  const itemAggregates = completed.map((item) =>
    aggregateCompanionLongRunV2ItemReviews(item, item.reviews ?? []),
  );
  const completeAggregates = itemAggregates.filter((item) => item.complete);
  const semanticWeightedScore = meanNullable(
    completeAggregates.map((item) => item.weightedScore),
  );
  const presentProfiles = COMPANION_LONG_RUN_V2_PROFILE_ORDER.filter(
    (profile) => input.items.some((item) => item.profile === profile),
  );
  const profileScores = Object.fromEntries(
    presentProfiles.map((profile) => [
      profile,
      meanNullable(
        completeAggregates
          .filter((item) => item.profile === profile)
          .map((item) => item.weightedScore),
      ),
    ]),
  ) as Partial<Record<CompanionLongRunV2Profile, number | null>>;
  const runIds = [...new Set(input.items.map((item) => item.runId))].sort(
    compareText,
  );
  const runScores = Object.fromEntries(
    runIds.map((runId) => [
      runId,
      meanNullable(
        completeAggregates
          .filter((item) => item.runId === runId)
          .map((item) => item.weightedScore),
      ),
    ]),
  ) as Record<string, number | null>;
  const dimensionScores = Object.fromEntries(
    RUBRIC_KEYS.map((dimension) => [
      dimension,
      meanNullable(
        completeAggregates.map((item) => item.averageScores[dimension]),
      ),
    ]),
  ) as Record<CompanionLongRunV2RubricDimension, number | null>;
  const profileScoreFailures = presentProfiles.filter((profile) => {
    const score = profileScores[profile];
    return (
      score !== null &&
      score !== undefined &&
      score < COMPANION_LONG_RUN_V2_THRESHOLDS.profileMinimumScore
    );
  });
  const runScoreFailures = runIds.filter((runId) => {
    const score = runScores[runId];
    return (
      score !== null &&
      score !== undefined &&
      score < COMPANION_LONG_RUN_V2_THRESHOLDS.runMinimumScore
    );
  });
  const criticalDimensionFailures = presentProfiles.flatMap((profile) => {
    const profileItems = completeAggregates.filter(
      (item) => item.profile === profile,
    );
    return COMPANION_LONG_RUN_V2_CRITICAL_DIMENSIONS.filter((dimension) => {
      const score = meanNullable(
        profileItems.map((item) => item.averageScores[dimension]),
      );
      return (
        score !== null &&
        score < COMPANION_LONG_RUN_V2_THRESHOLDS.criticalDimensionMinimum
      );
    }).map((dimension) => `${profile}:${dimension}`);
  });
  const repairWarningCount = input.items.reduce(
    (count, item) => count + (item.repairWarningCodes?.length ?? 0),
    0,
  );

  const reasons: string[] = [];
  let classification: CompanionLongRunV2Classification;
  if (input.items.length === 0 || skippedCount === input.items.length) {
    classification = "SKIPPED";
    reasons.push("No evaluation item was attempted.");
  } else if (productFailureCount > 0) {
    classification = "FAIL_PRODUCT";
    reasons.push(
      `${String(productFailureCount)} item(s) failed deterministic product assertions.`,
    );
  } else if (
    providerFailureRate >= COMPANION_LONG_RUN_V2_THRESHOLDS.providerFailureRate
  ) {
    classification = "FAIL_PROVIDER";
    reasons.push(
      `Provider failure rate ${formatRate(providerFailureRate)} reached the ${formatRate(COMPANION_LONG_RUN_V2_THRESHOLDS.providerFailureRate)} limit.`,
    );
  } else if (
    providerFailureCount > 0 ||
    skippedCount > 0 ||
    completeAggregates.length !== completed.length
  ) {
    classification = "PARTIAL";
    reasons.push("The evaluation matrix or its dual reviews are incomplete.");
  } else {
    if (
      semanticWeightedScore === null ||
      profileScoreFailures.length > 0 ||
      runScoreFailures.length > 0 ||
      criticalDimensionFailures.length > 0 ||
      completeAggregates.some((item) => item.conclusion === "FAIL_SEMANTIC")
    ) {
      classification = "FAIL_SEMANTIC";
      if (profileScoreFailures.length > 0) {
        reasons.push(
          `Profile mean is below ${String(COMPANION_LONG_RUN_V2_THRESHOLDS.profileMinimumScore)}: ${profileScoreFailures.join(", ")}.`,
        );
      }
      if (runScoreFailures.length > 0) {
        reasons.push(
          `Run mean is below ${String(COMPANION_LONG_RUN_V2_THRESHOLDS.runMinimumScore)}: ${runScoreFailures.join(", ")}.`,
        );
      }
      if (criticalDimensionFailures.length > 0) {
        reasons.push(
          `Critical dimension is below ${String(COMPANION_LONG_RUN_V2_THRESHOLDS.criticalDimensionMinimum)}: ${criticalDimensionFailures.join(", ")}.`,
        );
      }
      if (
        completeAggregates.some((item) => item.conclusion === "FAIL_SEMANTIC")
      ) {
        reasons.push("At least one dual-review verdict failed semantically.");
      }
    } else if (
      repairWarningCount > 0 ||
      completeAggregates.some(
        (item) =>
          item.conclusion === "PASS_WITH_WARNINGS" ||
          item.conclusionDisagreement,
      )
    ) {
      classification = "PASS_WITH_WARNINGS";
      reasons.push(
        "All semantic gates passed, but review disagreement or repair warnings remain.",
      );
    } else {
      classification = "PASS";
    }
  }

  const provisional = input.calibration?.provisional ?? true;
  if (provisional) {
    reasons.push(
      "Human calibration is missing or outside its acceptance limits.",
    );
    if (classification === "PASS") classification = "PASS_WITH_WARNINGS";
  }
  return {
    classification,
    provisional,
    reasons,
    itemCount: input.items.length,
    completedCount: completed.length,
    skippedCount,
    providerFailureCount,
    productFailureCount,
    providerFailureRate,
    semanticWeightedScore,
    profileScores,
    runScores,
    dimensionScores,
    itemAggregates,
  };
}

export function selectCompanionLongRunV2BlindAuditSample(
  items: readonly CompanionLongRunV2ItemReviewAggregate[],
  options: { seed: string | number; sampleRate?: number },
): readonly CompanionLongRunV2BlindAuditSelection[] {
  const sampleRate =
    options.sampleRate ??
    COMPANION_LONG_RUN_V2_THRESHOLDS.blindAuditMinimumRate;
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    throw new TypeError("Blind audit sampleRate must be between 0 and 1.");
  }
  assertUniqueEvaluationItems(items);
  if (items.length === 0) return [];

  const effectiveRate = Math.max(
    sampleRate,
    COMPANION_LONG_RUN_V2_THRESHOLDS.blindAuditMinimumRate,
  );
  const targetCount = Math.ceil(items.length * effectiveRate);
  const priorityReasons = new Map<
    string,
    readonly CompanionLongRunV2BlindPriorityReason[]
  >();
  for (const item of items) {
    const reasons: CompanionLongRunV2BlindPriorityReason[] = [];
    if (
      (item.maximumDimensionDifference ?? 0) >=
        COMPANION_LONG_RUN_V2_THRESHOLDS.reviewerDifferencePriority ||
      (item.weightedScoreDifference ?? 0) >=
        COMPANION_LONG_RUN_V2_THRESHOLDS.reviewerDifferencePriority
    ) {
      reasons.push("REVIEWER_DIFFERENCE");
    }
    if (item.conclusionDisagreement) {
      reasons.push("CONCLUSION_DISAGREEMENT");
    }
    if (
      (item.weightedScore !== null &&
        isNearSemanticThreshold(item.weightedScore)) ||
      COMPANION_LONG_RUN_V2_CRITICAL_DIMENSIONS.some(
        (dimension) =>
          Math.abs(
            item.averageScores[dimension] -
              COMPANION_LONG_RUN_V2_THRESHOLDS.criticalDimensionMinimum,
          ) <= COMPANION_LONG_RUN_V2_THRESHOLDS.nearThresholdDistance,
      )
    ) {
      reasons.push("NEAR_SEMANTIC_THRESHOLD");
    }
    if (reasons.length > 0) priorityReasons.set(item.itemId, reasons);
  }

  const selectedIds = new Set(priorityReasons.keys());
  const groups = new Map<string, CompanionLongRunV2ItemReviewAggregate[]>();
  for (const item of items) {
    if (selectedIds.has(item.itemId)) continue;
    const stratum = `${item.profile}\u001f${item.scenarioId}\u001f${item.runId}`;
    const group = groups.get(stratum) ?? [];
    group.push(item);
    groups.set(stratum, group);
  }
  const strata = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      cursor: 0,
      group: [...group].sort((left, right) =>
        compareStableRank(options.seed, left.itemId, right.itemId),
      ),
    }))
    .sort((left, right) =>
      compareStableRank(options.seed, left.key, right.key),
    );

  while (selectedIds.size < targetCount) {
    let selectedInPass = false;
    for (const stratum of strata) {
      if (selectedIds.size >= targetCount) break;
      const candidate = stratum.group[stratum.cursor];
      if (candidate === undefined) continue;
      stratum.cursor += 1;
      selectedIds.add(candidate.itemId);
      selectedInPass = true;
    }
    if (!selectedInPass) break;
  }

  return items
    .filter((item) => selectedIds.has(item.itemId))
    .map((item) => ({
      blindId: `blind-${companionLongRunV2StableHash(
        options.seed,
        "blind-audit-v2",
        item.itemId,
      )}`,
      itemId: item.itemId,
      priorityReasons: priorityReasons.get(item.itemId) ?? [],
    }))
    .sort((left, right) => compareText(left.blindId, right.blindId));
}

function assertUniqueEvaluationItems(
  items: readonly CompanionLongRunV2EvaluationItemRef[],
): void {
  const ids = new Set<string>();
  for (const item of items) {
    assertItemRef(item);
    if (ids.has(item.itemId)) {
      throw new Error(`Duplicate evaluation item: ${item.itemId}`);
    }
    ids.add(item.itemId);
  }
}

function assertItemRef(item: CompanionLongRunV2EvaluationItemRef): void {
  assertNonEmpty(item.itemId, "itemId");
  assertNonEmpty(item.scenarioId, "scenarioId");
  assertNonEmpty(item.runId, "runId");
  if (!PROFILE_INDEX.has(item.profile)) {
    throw new TypeError(`Unknown v2 profile: ${String(item.profile)}`);
  }
  if (item.repetition !== undefined) assertReviewRound(item.repetition);
  if (item.reviewRound !== undefined) assertReviewRound(item.reviewRound);
}

function assertReviewRound(
  reviewRound: number,
): asserts reviewRound is CompanionLongRunV2ReviewRound {
  if (reviewRound !== 1 && reviewRound !== 2 && reviewRound !== 3) {
    throw new TypeError("reviewRound must be 1, 2 or 3.");
  }
}

function assertCompleteRubricScores(
  scores: CompanionLongRunV2RubricScores,
): void {
  const keys = Object.keys(scores);
  if (
    keys.length !== RUBRIC_KEYS.length ||
    keys.some((key) => !RUBRIC_KEY_SET.has(key))
  ) {
    throw new TypeError("Rubric scores must contain exactly seven dimensions.");
  }
  for (const dimension of RUBRIC_KEYS) {
    const score = scores[dimension];
    if (!Number.isInteger(score) || score < 0 || score > 4) {
      throw new TypeError(`${dimension} must be an integer from 0 through 4.`);
    }
  }
}

function assertScoreRange(score: number, label: string): void {
  if (!Number.isFinite(score) || score < 0 || score > 4) {
    throw new TypeError(`${label} must be between 0 and 4.`);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim() === "") throw new TypeError(`${label} must not be empty.`);
}

function stableSortItems<T extends CompanionLongRunV2EvaluationItemRef>(
  items: readonly T[],
): T[] {
  return [...items].sort((left, right) => {
    const profileDifference =
      (PROFILE_INDEX.get(left.profile) ?? 0) -
      (PROFILE_INDEX.get(right.profile) ?? 0);
    if (profileDifference !== 0) return profileDifference;
    return (
      compareText(left.scenarioId, right.scenarioId) ||
      compareText(left.runId, right.runId) ||
      compareText(left.itemId, right.itemId)
    );
  });
}

function compareAssignments(
  left: CompanionLongRunV2ReviewAssignment,
  right: CompanionLongRunV2ReviewAssignment,
): number {
  return (
    compareText(left.scenarioId, right.scenarioId) ||
    compareText(left.runId, right.runId) ||
    (PROFILE_INDEX.get(left.profile) ?? 0) -
      (PROFILE_INDEX.get(right.profile) ?? 0) ||
    compareText(left.itemId, right.itemId) ||
    left.reviewerSlot - right.reviewerSlot
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareStableRank(
  seed: string | number,
  left: string,
  right: string,
): number {
  return (
    compareText(
      companionLongRunV2StableHash(seed, left),
      companionLongRunV2StableHash(seed, right),
    ) || compareText(left, right)
  );
}

function aggregateSemanticConclusion(
  conclusions: readonly CompanionLongRunV2SemanticConclusion[],
): CompanionLongRunV2SemanticConclusion | null {
  if (conclusions.length === 0) return null;
  if (conclusions.includes("FAIL_SEMANTIC")) return "FAIL_SEMANTIC";
  if (conclusions.includes("PASS_WITH_WARNINGS")) {
    return "PASS_WITH_WARNINGS";
  }
  return "PASS";
}

function meanNullable(values: readonly (number | null)[]): number | null {
  const available = values.filter((value): value is number => value !== null);
  if (available.length === 0) return null;
  return Number(
    (
      available.reduce((total, value) => total + value, 0) / available.length
    ).toFixed(12),
  );
}

function isNearSemanticThreshold(score: number): boolean {
  return [
    COMPANION_LONG_RUN_V2_THRESHOLDS.profileMinimumScore,
    COMPANION_LONG_RUN_V2_THRESHOLDS.runMinimumScore,
    COMPANION_LONG_RUN_V2_THRESHOLDS.criticalDimensionMinimum,
  ].some(
    (threshold) =>
      Math.abs(score - threshold) <=
      COMPANION_LONG_RUN_V2_THRESHOLDS.nearThresholdDistance,
  );
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

// Short aliases keep the runner-facing imports readable without weakening the
// explicit v2 contract above.
export const LONG_RUN_V2_PROFILE_ORDER = COMPANION_LONG_RUN_V2_PROFILE_ORDER;
export const LONG_RUN_V2_RUBRIC = COMPANION_LONG_RUN_V2_RUBRIC;
export const LONG_RUN_V2_THRESHOLDS = COMPANION_LONG_RUN_V2_THRESHOLDS;
