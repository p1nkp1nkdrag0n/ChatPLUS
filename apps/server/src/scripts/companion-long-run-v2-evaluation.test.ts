import { describe, expect, it } from "vitest";

import {
  COMPANION_LONG_RUN_V2_CRITICAL_DIMENSIONS,
  COMPANION_LONG_RUN_V2_PROFILE_ORDER,
  COMPANION_LONG_RUN_V2_REVIEW_BATCH_SIZE,
  COMPANION_LONG_RUN_V2_REVIEWER_OFFSET_PAIRS,
  COMPANION_LONG_RUN_V2_REVIEWER_OFFSETS_BY_REPETITION,
  COMPANION_LONG_RUN_V2_RUBRIC,
  COMPANION_LONG_RUN_V2_THRESHOLDS,
  aggregateCompanionLongRunV2Evaluation,
  aggregateCompanionLongRunV2ItemReviews,
  companionLongRunV2ReviewersFor,
  companionLongRunV2StableHash,
  evaluateCompanionLongRunV2HumanCalibration,
  planCompanionLongRunV2AllOffsetAssignments,
  planCompanionLongRunV2ReviewAssignments,
  planCompanionLongRunV2ReviewBatches,
  scoreCompanionLongRunV2Rubric,
  selectCompanionLongRunV2BlindAuditSample,
  type CompanionLongRunV2EvaluationItem,
  type CompanionLongRunV2EvaluationItemRef,
  type CompanionLongRunV2HumanCalibrationResult,
  type CompanionLongRunV2ItemReviewAggregate,
  type CompanionLongRunV2Profile,
  type CompanionLongRunV2RubricScores,
  type CompanionLongRunV2SemanticConclusion,
  type CompanionLongRunV2SemanticReview,
} from "./companion-long-run-v2-evaluation.js";

const SCORE_KEYS = [
  "persona",
  "daily_relevance",
  "emotion",
  "memory_time",
  "relationship_romance",
  "independent_life_schedule",
  "language_naturalness",
] as const;

function scores(
  value: 0 | 1 | 2 | 3 | 4,
  overrides: Partial<CompanionLongRunV2RubricScores> = {},
): CompanionLongRunV2RubricScores {
  return {
    persona: value,
    daily_relevance: value,
    emotion: value,
    memory_time: value,
    relationship_romance: value,
    independent_life_schedule: value,
    language_naturalness: value,
    ...overrides,
  };
}

function itemRef(
  itemId: string,
  profile: CompanionLongRunV2Profile = "deepseek",
  runId = "run-1",
): CompanionLongRunV2EvaluationItemRef {
  return { itemId, profile, scenarioId: "scenario-a", runId };
}

function review(input: {
  itemId: string;
  subjectProfile?: CompanionLongRunV2Profile;
  reviewerProfile: CompanionLongRunV2Profile;
  rubricScores?: CompanionLongRunV2RubricScores;
  conclusion?: CompanionLongRunV2SemanticConclusion;
  suffix?: string;
}): CompanionLongRunV2SemanticReview {
  return {
    reviewId: `${input.itemId}-${input.reviewerProfile}-${input.suffix ?? "review"}`,
    itemId: input.itemId,
    subjectProfile: input.subjectProfile ?? "deepseek",
    reviewerProfile: input.reviewerProfile,
    scores: input.rubricScores ?? scores(3),
    conclusion: input.conclusion ?? "PASS",
  };
}

function completedItem(input: {
  itemId: string;
  profile?: CompanionLongRunV2Profile;
  runId?: string;
  firstScores?: CompanionLongRunV2RubricScores;
  secondScores?: CompanionLongRunV2RubricScores;
  firstConclusion?: CompanionLongRunV2SemanticConclusion;
  secondConclusion?: CompanionLongRunV2SemanticConclusion;
}): CompanionLongRunV2EvaluationItem {
  const profile = input.profile ?? "deepseek";
  return {
    ...itemRef(input.itemId, profile, input.runId ?? "run-1"),
    executionStatus: "completed",
    reviews: [
      review({
        itemId: input.itemId,
        subjectProfile: profile,
        reviewerProfile: "claude",
        rubricScores: input.firstScores ?? scores(3),
        conclusion: input.firstConclusion ?? "PASS",
        suffix: "first",
      }),
      review({
        itemId: input.itemId,
        subjectProfile: profile,
        reviewerProfile: "grok",
        rubricScores: input.secondScores ?? scores(3),
        conclusion: input.secondConclusion ?? "PASS",
        suffix: "second",
      }),
    ],
  };
}

const CALIBRATED: CompanionLongRunV2HumanCalibrationResult =
  evaluateCompanionLongRunV2HumanCalibration(
    Array.from({ length: 5 }, (_, index) => ({
      sampleId: `calibration-${String(index)}`,
      automatedScore: 3,
      humanScore: 3,
      automatedConclusion: "PASS" as const,
      humanConclusion: "PASS" as const,
    })),
  );

describe("companion long-run v2 reviewer planning", () => {
  it("freezes the five-profile order and three balanced offset pairs", () => {
    expect(COMPANION_LONG_RUN_V2_PROFILE_ORDER).toEqual([
      "deepseek",
      "claude",
      "grok",
      "gpt56-sol",
      "bigmodel",
    ]);
    expect(COMPANION_LONG_RUN_V2_REVIEWER_OFFSET_PAIRS).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    expect(COMPANION_LONG_RUN_V2_REVIEWER_OFFSETS_BY_REPETITION).toBe(
      COMPANION_LONG_RUN_V2_REVIEWER_OFFSET_PAIRS,
    );

    for (const subject of COMPANION_LONG_RUN_V2_PROFILE_ORDER) {
      const acrossRounds = ([1, 2, 3] as const).flatMap((round) => {
        const reviewers = companionLongRunV2ReviewersFor(subject, round);
        expect(new Set(reviewers).size).toBe(2);
        expect(reviewers).not.toContain(subject);
        return reviewers;
      });
      expect(new Set(acrossRounds)).toEqual(
        new Set(
          COMPANION_LONG_RUN_V2_PROFILE_ORDER.filter(
            (profile) => profile !== subject,
          ),
        ),
      );
    }
  });

  it("plans exactly two non-self reviews per item and all three rounds reproducibly", () => {
    const refs = COMPANION_LONG_RUN_V2_PROFILE_ORDER.map((profile, index) => ({
      ...itemRef(`item-${String(index)}`, profile),
      reviewRound: ((index % 3) + 1) as 1 | 2 | 3,
    }));
    const assignments = planCompanionLongRunV2ReviewAssignments(refs);
    expect(assignments).toHaveLength(refs.length * 2);
    for (const ref of refs) {
      const assigned = assignments.filter(
        (assignment) => assignment.itemId === ref.itemId,
      );
      expect(assigned).toHaveLength(2);
      expect(new Set(assigned.map((entry) => entry.reviewerProfile)).size).toBe(
        2,
      );
      expect(
        assigned.some((entry) => entry.reviewerProfile === ref.profile),
      ).toBe(false);
    }
    expect(
      planCompanionLongRunV2ReviewAssignments([...refs].reverse()),
    ).toEqual(assignments);
    expect(planCompanionLongRunV2AllOffsetAssignments(refs)).toHaveLength(
      refs.length * 6,
    );

    const repeated = planCompanionLongRunV2ReviewAssignments([
      { ...itemRef("repeat-2"), repetition: 2 },
    ]);
    expect(repeated.map(({ reviewerProfile }) => reviewerProfile)).toEqual([
      "grok",
      "gpt56-sol",
    ]);
    expect(repeated.every(({ repetition }) => repetition === 2)).toBe(true);
  });

  it("rejects ambiguous rounds, duplicate items and tampered self-review batches", () => {
    expect(() =>
      planCompanionLongRunV2ReviewAssignments([itemRef("a")]),
    ).toThrow(/reviewRound/u);
    expect(() =>
      planCompanionLongRunV2ReviewAssignments([itemRef("a"), itemRef("a")], 1),
    ).toThrow(/Duplicate evaluation item/u);
    expect(() =>
      planCompanionLongRunV2ReviewAssignments([
        { ...itemRef("conflict"), repetition: 1, reviewRound: 2 },
      ]),
    ).toThrow(/conflicting/u);
    const [assignment] = planCompanionLongRunV2ReviewAssignments(
      [itemRef("a")],
      1,
    );
    expect(assignment).toBeDefined();
    expect(() =>
      planCompanionLongRunV2ReviewBatches([
        { ...assignment!, reviewerProfile: assignment!.profile },
      ]),
    ).toThrow(/Self-review/u);
  });

  it("chunks homogeneous reviewer queues into stable batches of at most ten", () => {
    const refs = Array.from({ length: 26 }, (_, index) =>
      itemRef(`item-${String(index).padStart(2, "0")}`),
    );
    const assignments = planCompanionLongRunV2ReviewAssignments(refs, 1);
    const batches = planCompanionLongRunV2ReviewBatches(assignments);
    expect(COMPANION_LONG_RUN_V2_REVIEW_BATCH_SIZE).toBe(10);
    expect(batches.every((batch) => batch.assignments.length <= 10)).toBe(true);
    for (const batch of batches) {
      expect(
        new Set(batch.assignments.map((entry) => entry.reviewerProfile)),
      ).toEqual(new Set([batch.reviewerProfile]));
      expect(
        new Set(batch.assignments.map((entry) => entry.reviewRound)),
      ).toEqual(new Set([batch.reviewRound]));
    }
    expect(
      batches.flatMap((batch) =>
        batch.assignments.map((entry) => entry.assignmentId),
      ),
    ).toHaveLength(assignments.length);
    expect(
      new Set(
        batches.flatMap((batch) =>
          batch.assignments.map((entry) => entry.assignmentId),
        ),
      ).size,
    ).toBe(assignments.length);
    expect(planCompanionLongRunV2ReviewBatches(assignments)).toEqual(batches);
  });
});

describe("companion long-run v2 rubric", () => {
  it("uses the approved seven dimensions and exact weights", () => {
    expect(COMPANION_LONG_RUN_V2_RUBRIC.map(({ key }) => key)).toEqual(
      SCORE_KEYS,
    );
    expect(COMPANION_LONG_RUN_V2_RUBRIC.map(({ weight }) => weight)).toEqual([
      0.2, 0.15, 0.2, 0.15, 0.15, 0.1, 0.05,
    ]);
    expect(
      COMPANION_LONG_RUN_V2_RUBRIC.reduce(
        (total, dimension) => total + dimension.weight,
        0,
      ),
    ).toBeCloseTo(1, 12);
    expect(COMPANION_LONG_RUN_V2_CRITICAL_DIMENSIONS).toEqual([
      "persona",
      "memory_time",
      "emotion",
      "relationship_romance",
    ]);
    expect(COMPANION_LONG_RUN_V2_THRESHOLDS.criticalDimensionMinimum).toBe(2.8);
  });

  it("scores the complete 0-4 rubric using weights", () => {
    expect(scoreCompanionLongRunV2Rubric(scores(0))).toBe(0);
    expect(scoreCompanionLongRunV2Rubric(scores(4))).toBe(4);
    expect(
      scoreCompanionLongRunV2Rubric(
        scores(0, {
          persona: 4,
          daily_relevance: 2,
          emotion: 3,
        }),
      ),
    ).toBeCloseTo(1.7, 12);
  });

  it("rejects missing, extra, fractional and out-of-range rubric values", () => {
    const missing = { ...scores(3) } as Record<string, number>;
    delete missing.persona;
    expect(() =>
      scoreCompanionLongRunV2Rubric(
        missing as unknown as CompanionLongRunV2RubricScores,
      ),
    ).toThrow(/exactly seven/u);
    expect(() =>
      scoreCompanionLongRunV2Rubric({
        ...scores(3),
        extra: 3,
      } as unknown as CompanionLongRunV2RubricScores),
    ).toThrow(/exactly seven/u);
    expect(() =>
      scoreCompanionLongRunV2Rubric({
        ...scores(3),
        persona: 2.5,
      } as unknown as CompanionLongRunV2RubricScores),
    ).toThrow(/integer/u);
    expect(() =>
      scoreCompanionLongRunV2Rubric({
        ...scores(3),
        persona: 5,
      } as unknown as CompanionLongRunV2RubricScores),
    ).toThrow(/integer/u);
  });
});

describe("companion long-run v2 aggregation", () => {
  it("aggregates two distinct external reviews and exposes audit deltas", () => {
    const aggregate = aggregateCompanionLongRunV2ItemReviews(itemRef("item"), [
      review({
        itemId: "item",
        reviewerProfile: "claude",
        rubricScores: scores(4),
      }),
      review({
        itemId: "item",
        reviewerProfile: "grok",
        rubricScores: scores(3),
        conclusion: "PASS_WITH_WARNINGS",
      }),
    ]);
    expect(aggregate.complete).toBe(true);
    expect(aggregate.weightedScore).toBeCloseTo(3.5, 12);
    expect(aggregate.weightedScoreDifference).toBeCloseTo(1, 12);
    expect(aggregate.maximumDimensionDifference).toBe(1);
    expect(aggregate.conclusionDisagreement).toBe(true);
    expect(aggregate.conclusion).toBe("PASS_WITH_WARNINGS");
  });

  it("forbids self-review, duplicate reviewers and more than two primaries", () => {
    expect(() =>
      aggregateCompanionLongRunV2ItemReviews(itemRef("item"), [
        review({ itemId: "item", reviewerProfile: "deepseek" }),
      ]),
    ).toThrow(/Self-review/u);
    expect(() =>
      aggregateCompanionLongRunV2ItemReviews(itemRef("item"), [
        review({ itemId: "item", reviewerProfile: "claude", suffix: "a" }),
        review({ itemId: "item", reviewerProfile: "claude", suffix: "b" }),
      ]),
    ).toThrow(/distinct reviewer/u);
    expect(() =>
      aggregateCompanionLongRunV2ItemReviews(itemRef("item"), [
        review({ itemId: "item", reviewerProfile: "claude" }),
        review({ itemId: "item", reviewerProfile: "grok" }),
        review({ itemId: "item", reviewerProfile: "gpt56-sol" }),
      ]),
    ).toThrow(/exactly two/u);
  });

  it.each([
    {
      expected: "SKIPPED",
      items: [{ ...itemRef("skip"), executionStatus: "skipped" as const }],
    },
    {
      expected: "FAIL_PRODUCT",
      items: [
        {
          ...itemRef("product"),
          executionStatus: "completed" as const,
          productFailureCodes: ["persona_boundary_respected"],
          reviews: completedItem({ itemId: "product" }).reviews!,
        },
      ],
    },
    {
      expected: "FAIL_PROVIDER",
      items: [
        ...Array.from({ length: 4 }, (_, index) =>
          completedItem({ itemId: `ok-${String(index)}` }),
        ),
        {
          ...itemRef("provider"),
          executionStatus: "provider_failure" as const,
        },
      ],
    },
    {
      expected: "PARTIAL",
      items: [
        ...Array.from({ length: 5 }, (_, index) =>
          completedItem({ itemId: `ok-${String(index)}` }),
        ),
        {
          ...itemRef("provider"),
          executionStatus: "provider_failure" as const,
        },
      ],
    },
    {
      expected: "FAIL_SEMANTIC",
      items: [
        completedItem({
          itemId: "semantic",
          firstScores: scores(3, { persona: 2 }),
          secondScores: scores(3, { persona: 3 }),
        }),
      ],
    },
    {
      expected: "PASS_WITH_WARNINGS",
      items: [
        {
          ...completedItem({ itemId: "warning" }),
          repairWarningCodes: ["structured_repair"],
        },
      ],
    },
    {
      expected: "PASS",
      items: [completedItem({ itemId: "pass" })],
    },
  ])(
    "classifies $expected with deterministic priority",
    ({ expected, items }) => {
      expect(
        aggregateCompanionLongRunV2Evaluation({
          items,
          calibration: CALIBRATED,
        }).classification,
      ).toBe(expected);
    },
  );

  it("treats the 2.8 critical-dimension minimum as inclusive", () => {
    const boundaryItems = Array.from({ length: 5 }, (_, index) =>
      completedItem({
        itemId: `boundary-${String(index)}`,
        firstScores: scores(4, { persona: index === 0 ? 2 : 3 }),
        secondScores: scores(4, { persona: index === 0 ? 2 : 3 }),
      }),
    );
    const boundary = aggregateCompanionLongRunV2Evaluation({
      items: boundaryItems,
      calibration: CALIBRATED,
    });
    expect(boundary.dimensionScores.persona).toBe(2.8);
    expect(boundary.classification).toBe("PASS");

    const belowItems = Array.from({ length: 5 }, (_, index) =>
      completedItem({
        itemId: `below-${String(index)}`,
        firstScores: scores(4, { persona: index < 2 ? 2 : 3 }),
        secondScores: scores(4, { persona: index < 2 ? 2 : 3 }),
      }),
    );
    expect(
      aggregateCompanionLongRunV2Evaluation({
        items: belowItems,
        calibration: CALIBRATED,
      }).classification,
    ).toBe("FAIL_SEMANTIC");
  });

  it.each(COMPANION_LONG_RUN_V2_CRITICAL_DIMENSIONS)(
    "fails when critical dimension %s is below 2.8",
    (dimension) => {
      const weakScores = scores(4, { [dimension]: 2 });
      const result = aggregateCompanionLongRunV2Evaluation({
        items: [
          completedItem({
            itemId: `weak-${dimension}`,
            firstScores: weakScores,
            secondScores: weakScores,
          }),
        ],
        calibration: CALIBRATED,
      });
      expect(result.classification).toBe("FAIL_SEMANTIC");
    },
  );

  it("fails a profile whose comprehensive mean is 2.99", () => {
    const items = Array.from({ length: 100 }, (_, index) =>
      completedItem({
        itemId: `profile-boundary-${String(index).padStart(3, "0")}`,
        runId: "profile-run",
        firstScores: scores(index === 0 ? 2 : 3),
        secondScores: scores(index === 0 ? 2 : 3),
      }),
    );
    items[0] = {
      ...items[0]!,
      repairWarningCodes: ["must_not_hide_semantic_failure"],
    };
    const result = aggregateCompanionLongRunV2Evaluation({
      items,
      calibration: CALIBRATED,
    });
    expect(result.semanticWeightedScore).toBe(2.99);
    expect(result.profileScores.deepseek).toBe(2.99);
    expect(result.runScores["profile-run"]).toBe(2.99);
    expect(result.classification).toBe("FAIL_SEMANTIC");
  });

  it("does not let a strong profile hide another profile below 3.0", () => {
    const weak = scores(3, { language_naturalness: 2 });
    expect(scoreCompanionLongRunV2Rubric(weak)).toBe(2.95);
    const result = aggregateCompanionLongRunV2Evaluation({
      items: [
        completedItem({
          itemId: "weak-profile",
          profile: "deepseek",
          runId: "shared-run",
          firstScores: weak,
          secondScores: weak,
        }),
        completedItem({
          itemId: "strong-profile",
          profile: "bigmodel",
          runId: "shared-run",
          firstScores: scores(4),
          secondScores: scores(4),
        }),
      ],
      calibration: CALIBRATED,
    });
    expect(result.semanticWeightedScore).toBeGreaterThan(3);
    expect(result.runScores["shared-run"]).toBeGreaterThan(3);
    expect(result.profileScores.deepseek).toBe(2.95);
    expect(result.profileScores.bigmodel).toBe(4);
    expect(result.classification).toBe("FAIL_SEMANTIC");
  });

  it("accepts a run mean of 2.6 and fails 2.59", () => {
    const score260 = scores(3, {
      daily_relevance: 1,
      language_naturalness: 1,
    });
    const score255 = scores(3, { daily_relevance: 0 });
    expect(scoreCompanionLongRunV2Rubric(score260)).toBe(2.6);
    expect(scoreCompanionLongRunV2Rubric(score255)).toBe(2.55);

    const boundary = aggregateCompanionLongRunV2Evaluation({
      items: [
        completedItem({
          itemId: "run-boundary",
          runId: "run-1",
          firstScores: score260,
          secondScores: score260,
        }),
        completedItem({
          itemId: "run-high-2",
          runId: "run-2",
          firstScores: scores(4),
          secondScores: scores(4),
        }),
        completedItem({
          itemId: "run-high-3",
          runId: "run-3",
          firstScores: scores(4),
          secondScores: scores(4),
        }),
      ],
      calibration: CALIBRATED,
    });
    expect(boundary.runScores["run-1"]).toBe(2.6);
    expect(boundary.classification).toBe("PASS");

    const belowItems = [
      ...Array.from({ length: 5 }, (_, index) =>
        completedItem({
          itemId: `run-low-${String(index)}`,
          runId: "run-1",
          firstScores: index === 0 ? score255 : score260,
          secondScores: index === 0 ? score255 : score260,
        }),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        completedItem({
          itemId: `run-2-high-${String(index)}`,
          runId: "run-2",
          firstScores: scores(4),
          secondScores: scores(4),
        }),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        completedItem({
          itemId: `run-3-high-${String(index)}`,
          runId: "run-3",
          firstScores: scores(4),
          secondScores: scores(4),
        }),
      ),
    ];
    const below = aggregateCompanionLongRunV2Evaluation({
      items: belowItems,
      calibration: CALIBRATED,
    });
    expect(below.runScores["run-1"]).toBe(2.59);
    expect(below.profileScores.deepseek).toBeGreaterThan(3);
    expect(below.classification).toBe("FAIL_SEMANTIC");
  });

  it("marks an otherwise passing result provisional when calibration is absent", () => {
    const result = aggregateCompanionLongRunV2Evaluation({
      items: [completedItem({ itemId: "pass" })],
    });
    expect(result.provisional).toBe(true);
    expect(result.classification).toBe("PASS_WITH_WARNINGS");
  });
});

function blindAggregate(input: {
  itemId: string;
  profile?: CompanionLongRunV2Profile;
  scenarioId?: string;
  runId?: string;
  weightedScore?: number;
  weightedScoreDifference?: number;
  maximumDimensionDifference?: number;
  conclusionDisagreement?: boolean;
  criticalScore?: number;
}): CompanionLongRunV2ItemReviewAggregate {
  const criticalScore = input.criticalScore ?? 4;
  return {
    itemId: input.itemId,
    profile: input.profile ?? "deepseek",
    scenarioId: input.scenarioId ?? "scenario-a",
    runId: input.runId ?? "run-1",
    reviewCount: 2,
    complete: true,
    averageScores: {
      persona: criticalScore,
      daily_relevance: 4,
      emotion: criticalScore,
      memory_time: criticalScore,
      relationship_romance: criticalScore,
      independent_life_schedule: 4,
      language_naturalness: 4,
    },
    weightedScore: input.weightedScore ?? 4,
    weightedScoreDifference: input.weightedScoreDifference ?? 0,
    maximumDimensionDifference: input.maximumDimensionDifference ?? 0,
    conclusion: "PASS",
    conclusionDisagreement: input.conclusionDisagreement ?? false,
  };
}

describe("companion long-run v2 blind audit selection", () => {
  it("always selects at least 20% and all high-priority items", () => {
    const items = Array.from({ length: 25 }, (_, index) =>
      blindAggregate({ itemId: `ordinary-${String(index)}` }),
    );
    items[0] = blindAggregate({
      itemId: "priority-difference",
      maximumDimensionDifference: 1,
    });
    items[1] = blindAggregate({
      itemId: "priority-conclusion",
      conclusionDisagreement: true,
    });
    items[2] = blindAggregate({
      itemId: "priority-threshold",
      weightedScore: 3,
    });
    const selected = selectCompanionLongRunV2BlindAuditSample(items, {
      seed: "audit-seed",
      sampleRate: 0.01,
    });
    expect(selected.length).toBeGreaterThanOrEqual(
      Math.ceil(items.length * 0.2),
    );
    expect(selected.map(({ itemId }) => itemId)).toEqual(
      expect.arrayContaining([
        "priority-difference",
        "priority-conclusion",
        "priority-threshold",
      ]),
    );
    expect(
      selected.find(({ itemId }) => itemId === "priority-difference")
        ?.priorityReasons,
    ).toContain("REVIEWER_DIFFERENCE");
  });

  it("keeps every priority item even when priorities exceed the nominal quota", () => {
    const items = Array.from({ length: 10 }, (_, index) =>
      blindAggregate({
        itemId: `priority-${String(index)}`,
        conclusionDisagreement: index < 4,
      }),
    );
    const selected = selectCompanionLongRunV2BlindAuditSample(items, {
      seed: 42,
    });
    expect(selected).toHaveLength(4);
  });

  it("uses stable seeded profile/scenario/run strata to fill the quota", () => {
    const items = COMPANION_LONG_RUN_V2_PROFILE_ORDER.flatMap((profile) =>
      Array.from({ length: 5 }, (_, index) =>
        blindAggregate({
          itemId: `${profile}-${String(index)}`,
          profile,
          scenarioId: "scenario-stratified",
          runId: "run-1",
        }),
      ),
    );
    const first = selectCompanionLongRunV2BlindAuditSample(items, {
      seed: "stable-seed",
    });
    const repeated = selectCompanionLongRunV2BlindAuditSample(
      [...items].reverse(),
      { seed: "stable-seed" },
    );
    const anotherSeed = selectCompanionLongRunV2BlindAuditSample(items, {
      seed: "another-seed",
    });
    expect(first).toHaveLength(5);
    expect(new Set(first.map(({ itemId }) => itemId.split("-")[0])).size).toBe(
      5,
    );
    expect(repeated).toEqual(first);
    expect(anotherSeed.map(({ itemId }) => itemId)).not.toEqual(
      first.map(({ itemId }) => itemId),
    );
    expect(first.every(({ blindId, itemId }) => blindId !== itemId)).toBe(true);
  });
});

describe("companion long-run v2 human calibration", () => {
  it("accepts MAE <= 0.5 and conclusion agreement >= 80% inclusively", () => {
    const result = evaluateCompanionLongRunV2HumanCalibration(
      Array.from({ length: 5 }, (_, index) => ({
        sampleId: `sample-${String(index)}`,
        automatedScore: 3,
        humanScore: index % 2 === 0 ? 2.5 : 3.5,
        automatedConclusion: "PASS" as const,
        humanConclusion:
          index === 4 ? ("PASS_WITH_WARNINGS" as const) : ("PASS" as const),
      })),
    );
    expect(result.meanAbsoluteError).toBe(0.5);
    expect(result.conclusionAgreementRate).toBe(0.8);
    expect(result.calibrated).toBe(true);
    expect(result.provisional).toBe(false);
  });

  it.each([
    {
      label: "MAE",
      samples: [
        {
          sampleId: "mae",
          automatedScore: 3,
          humanScore: 2.49,
          automatedConclusion: "PASS" as const,
          humanConclusion: "PASS" as const,
        },
      ],
    },
    {
      label: "agreement",
      samples: Array.from({ length: 5 }, (_, index) => ({
        sampleId: `agreement-${String(index)}`,
        automatedScore: 3,
        humanScore: 3,
        automatedConclusion: "PASS" as const,
        humanConclusion:
          index < 2 ? ("FAIL_SEMANTIC" as const) : ("PASS" as const),
      })),
    },
    { label: "empty evidence", samples: [] },
  ])("marks $label failure provisional", ({ samples }) => {
    const result = evaluateCompanionLongRunV2HumanCalibration(samples);
    expect(result.calibrated).toBe(false);
    expect(result.provisional).toBe(true);
  });

  it("uses a platform-stable deterministic seed hash", () => {
    expect(companionLongRunV2StableHash("seed", "顾澜", "run-1")).toBe(
      companionLongRunV2StableHash("seed", "顾澜", "run-1"),
    );
    expect(companionLongRunV2StableHash("seed", "a")).not.toBe(
      companionLongRunV2StableHash("seed", "b"),
    );
  });
});
