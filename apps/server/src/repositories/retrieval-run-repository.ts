import {
  EntityIdSchema,
  EvidenceBundleSchema,
  JsonValueSchema,
  MemoryEvidenceSchema,
  MemoryNamespaceSchema,
  MemoryRecallQuerySchema,
  MemoryRecallResultSchema,
  MemorySchema,
  ReasonCodeSchema,
  RetrievalScoreBreakdownSchema,
  UnitIntervalSchema,
  UtcDateTimeSchema,
  type EvidenceBundle,
  type JsonValue,
  type Memory,
  type MemoryEvidence,
  type MemoryRecallQuery,
  type MemoryRecallResult,
} from "@personasim/contracts";
import { z } from "zod";

import type { Database } from "../db/connection.js";
import {
  explicitFactCandidateScore,
  explicitFactValueResolution,
  isFactBearingUserStatement,
  parseExplicitFactVerificationRequest,
  type ExplicitFactFacetDescriptor,
} from "../domain/explicit-fact-verification.js";
import { createEntityId } from "../domain/id.js";

export const RETRIEVAL_RUN_STAGE_NAMES = [
  "query_normalization",
  "temporal_resolution",
  "namespace_filter",
  "candidate_generation",
  "evidence_verification",
  "scoring",
  "selection",
  "prompt_rendering",
] as const;

export type RetrievalRunStageName = (typeof RETRIEVAL_RUN_STAGE_NAMES)[number];

export const RetrievalRunStageSchema = z
  .object({
    name: z.enum(RETRIEVAL_RUN_STAGE_NAMES),
    ordinal: z
      .number()
      .int()
      .min(0)
      .max(RETRIEVAL_RUN_STAGE_NAMES.length - 1),
    status: z.enum(["completed", "skipped", "failed"]),
    inputCount: z.number().int().nonnegative().max(10_000).optional(),
    outputCount: z.number().int().nonnegative().max(10_000).optional(),
    durationMs: z.number().finite().nonnegative(),
    reasonCode: ReasonCodeSchema.optional(),
    snapshot: JsonValueSchema.optional(),
  })
  .strict();
export type RetrievalRunStage = z.infer<typeof RetrievalRunStageSchema>;

const RetrievalRunStagesSchema = z
  .array(RetrievalRunStageSchema)
  .length(RETRIEVAL_RUN_STAGE_NAMES.length)
  .superRefine((stages, context) => {
    RETRIEVAL_RUN_STAGE_NAMES.forEach((name, index) => {
      const stage = stages[index];
      if (stage?.name !== name || stage.ordinal !== index) {
        context.addIssue({
          code: "custom",
          message: "Retrieval stages must be complete and in canonical order",
          path: [index],
        });
      }
    });
  });

export const RetrievalRunCandidateSchema = z
  .object({
    memoryId: EntityIdSchema,
    namespace: MemoryNamespaceSchema,
    evidenceIds: z
      .array(EntityIdSchema)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Candidate evidence ids must be unique",
      }),
    score: UnitIntervalSchema,
    scoreBreakdown: RetrievalScoreBreakdownSchema,
    semanticScore: UnitIntervalSchema.nullable(),
    relationshipScore: UnitIntervalSchema.nullable(),
    decision: z.enum(["selected", "excluded"]),
    reasonCode: ReasonCodeSchema,
    reasonSummary: z.string().trim().min(1).max(1_000).optional(),
    selectionRank: z.number().int().min(1).max(8).optional(),
  })
  .strict()
  .superRefine((candidate, context) => {
    if (
      candidate.decision === "selected" &&
      candidate.selectionRank === undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Selected candidates require selectionRank",
        path: ["selectionRank"],
      });
    }
    if (
      candidate.decision === "excluded" &&
      candidate.selectionRank !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Excluded candidates cannot have selectionRank",
        path: ["selectionRank"],
      });
    }
  });
export type RetrievalRunCandidate = z.infer<typeof RetrievalRunCandidateSchema>;

const ExplicitFactSelectorOutcomeSchema = z.enum([
  "selected",
  "incomplete",
  "conflicted",
  "below_threshold",
  "capacity_insufficient",
  "scan_truncated",
]);

const ExplicitFactSelectorAttemptOutcomeSchema = z.enum([
  ...ExplicitFactSelectorOutcomeSchema.options,
  "consistent_not_selected",
  "complete_not_selected",
]);

const ExplicitFactSelectorEvidenceReasonSchema = z.enum([
  "fact_evidence_accepted",
  "fact_evidence_future",
  "fact_evidence_not_assertive",
  "fact_evidence_quote_not_grounded",
  "fact_evidence_source_missing",
  "fact_evidence_source_not_snapshot_safe",
  "fact_evidence_source_not_user",
  "fact_evidence_unsupported_source",
  "fact_evidence_value_conflict",
  "fact_evidence_value_mismatch",
]);
export type ExplicitFactSelectorEvidenceReason = z.infer<
  typeof ExplicitFactSelectorEvidenceReasonSchema
>;

const ExplicitFactSelectorCandidateReasonSchema = z.enum([
  "fact_candidate_evidence_conflicted",
  "fact_candidate_evidence_not_verified",
  "fact_candidate_evidence_scan_truncated",
  "fact_candidate_future",
  "fact_candidate_lifecycle_ineligible",
  "fact_candidate_low_reliability",
  "fact_candidate_lower_ranked",
  "fact_candidate_not_active",
  "fact_candidate_not_explicit",
  "fact_candidate_not_stable",
  "fact_candidate_not_user_attributed",
  "fact_candidate_outside_time_range",
  "fact_candidate_provisional_winner",
  "fact_candidate_rejected_due_atomic_conflict",
  "fact_candidate_rejected_due_higher_tier_failure",
  "fact_candidate_rejected_due_scan_truncation",
  "fact_candidate_same_value_shadowed_by_event_card",
  "fact_candidate_selected",
  "fact_candidate_value_conflict",
  "fact_candidate_value_conflicted",
  "fact_candidate_value_unparseable",
]);
export type ExplicitFactSelectorCandidateReason = z.infer<
  typeof ExplicitFactSelectorCandidateReasonSchema
>;

const ExplicitFactSelectorEvidenceAuditSchema = z
  .object({
    evidenceId: EntityIdSchema,
    decision: z.enum(["accepted", "rejected"]),
    reasonCode: ExplicitFactSelectorEvidenceReasonSchema,
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      (evidence.decision === "accepted") !==
      (evidence.reasonCode === "fact_evidence_accepted")
    ) {
      context.addIssue({
        code: "custom",
        message: "Fact evidence decision and reason must agree",
        path: ["reasonCode"],
      });
    }
  });

const ExplicitFactSelectorCandidateAuditSchema = z
  .object({
    memoryId: EntityIdSchema,
    decision: z.enum(["selected", "rejected"]),
    reasonCode: ExplicitFactSelectorCandidateReasonSchema,
    valueGroupId: z
      .string()
      .regex(/^value_[1-9]\d*$/u)
      .optional(),
    evidence: z.array(ExplicitFactSelectorEvidenceAuditSchema).max(20),
    evidenceOmittedCount: z.number().int().positive().max(10_000).optional(),
  })
  .strict()
  .superRefine((candidate, context) => {
    const matchedReasonCodes: ExplicitFactSelectorCandidateReason[] = [
      "fact_candidate_lower_ranked",
      "fact_candidate_provisional_winner",
      "fact_candidate_same_value_shadowed_by_event_card",
      "fact_candidate_rejected_due_higher_tier_failure",
      "fact_candidate_rejected_due_scan_truncation",
      "fact_candidate_rejected_due_atomic_conflict",
      "fact_candidate_value_conflict",
      "fact_candidate_selected",
    ];
    const hasMatchedReason = matchedReasonCodes.includes(candidate.reasonCode);
    if (
      (candidate.decision === "selected") !==
      (candidate.reasonCode === "fact_candidate_selected")
    ) {
      context.addIssue({
        code: "custom",
        message: "Fact candidate decision and reason must agree",
        path: ["reasonCode"],
      });
    }
    if (
      candidate.decision === "selected" &&
      (candidate.valueGroupId === undefined ||
        !candidate.evidence.some((item) => item.decision === "accepted"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Selected fact candidates require a value and evidence",
        path: ["decision"],
      });
    }
    if (
      candidate.valueGroupId !== undefined &&
      !candidate.evidence.some((item) => item.decision === "accepted")
    ) {
      context.addIssue({
        code: "custom",
        message: "A fact value group requires accepted evidence",
        path: ["valueGroupId"],
      });
    }
    if (
      hasMatchedReason &&
      (candidate.valueGroupId === undefined ||
        !candidate.evidence.some((item) => item.decision === "accepted"))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A matched fact-candidate decision requires its value and accepted evidence",
        path: ["reasonCode"],
      });
    }
    if (candidate.valueGroupId !== undefined && !hasMatchedReason) {
      context.addIssue({
        code: "custom",
        message:
          "Only a matched fact-candidate decision may carry a value group",
        path: ["valueGroupId"],
      });
    }
    if (
      [
        "fact_candidate_evidence_scan_truncated",
        "fact_candidate_future",
        "fact_candidate_lifecycle_ineligible",
        "fact_candidate_low_reliability",
        "fact_candidate_not_active",
        "fact_candidate_not_explicit",
        "fact_candidate_not_stable",
        "fact_candidate_not_user_attributed",
        "fact_candidate_outside_time_range",
        "fact_candidate_value_conflicted",
        "fact_candidate_value_unparseable",
      ].includes(candidate.reasonCode) &&
      candidate.evidence.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A pre-evidence fact-candidate rejection cannot carry evidence decisions",
        path: ["evidence"],
      });
    }
    if (
      candidate.reasonCode === "fact_candidate_evidence_conflicted" &&
      !candidate.evidence.some(
        (evidence) =>
          evidence.decision === "rejected" &&
          evidence.reasonCode === "fact_evidence_value_conflict",
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An evidence-conflicted candidate requires rejected conflicting source evidence",
        path: ["evidence"],
      });
    }
    if (
      candidate.evidence.some(
        (evidence) => evidence.reasonCode === "fact_evidence_value_conflict",
      ) &&
      candidate.reasonCode !== "fact_candidate_evidence_conflicted"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Conflicting source evidence must propagate to the candidate decision",
        path: ["reasonCode"],
      });
    }
    if (
      candidate.reasonCode === "fact_candidate_evidence_not_verified" &&
      candidate.evidence.some((evidence) => evidence.decision === "accepted")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An unverified-evidence candidate cannot contain accepted evidence",
        path: ["evidence"],
      });
    }
    if (
      new Set(candidate.evidence.map((item) => item.evidenceId)).size !==
      candidate.evidence.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Fact candidate evidence ids must be unique",
        path: ["evidence"],
      });
    }
    if (
      candidate.evidenceOmittedCount !== undefined &&
      candidate.evidence.length !== 20
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Omitted fact evidence may be reported only after filling the audit preview cap",
        path: ["evidenceOmittedCount"],
      });
    }
  });

const ExplicitFactFacetRequestSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("beverage_preference"),
      selector: z.discriminatedUnion("scope", [
        z.object({ scope: z.literal("any") }).strict(),
        z
          .object({
            scope: z.literal("family"),
            family: z.enum(["tea", "coffee", "cocoa", "juice", "water"]),
          })
          .strict(),
        z
          .object({
            scope: z.literal("specific"),
            canonical: z.string().trim().min(1).max(64),
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("entity_inscription"),
      entity: z.string().trim().min(2).max(32),
    })
    .strict(),
]);

const ExplicitFactSelectorFacetAuditSchema = z
  .object({
    index: z.number().int().min(0).max(2),
    kind: z.enum(["beverage_preference", "entity_inscription"]),
    request: ExplicitFactFacetRequestSchema,
    outcome: z.enum(["selected", "missing", "conflicted"]),
    candidates: z.array(ExplicitFactSelectorCandidateAuditSchema).max(500),
  })
  .strict()
  .superRefine((facet, context) => {
    if (facet.request.kind !== facet.kind) {
      context.addIssue({
        code: "custom",
        message: "Fact facet kind must match its frozen request descriptor",
        path: ["request", "kind"],
      });
    }
    if (
      new Set(facet.candidates.map((candidate) => candidate.memoryId)).size !==
      facet.candidates.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Fact facet candidate ids must be unique",
        path: ["candidates"],
      });
    }
    const candidatesWithValues = facet.candidates.filter(
      (candidate) => candidate.valueGroupId !== undefined,
    );
    const valueGroupIds = new Set(
      candidatesWithValues.flatMap((candidate) =>
        candidate.valueGroupId === undefined ? [] : [candidate.valueGroupId],
      ),
    );
    const hasConflictCandidate = facet.candidates.some(
      (candidate) =>
        candidate.reasonCode === "fact_candidate_evidence_conflicted" ||
        candidate.reasonCode === "fact_candidate_value_conflicted" ||
        candidate.reasonCode === "fact_candidate_value_conflict",
    );
    if (
      facet.outcome === "missing" &&
      facet.candidates.some(
        (candidate) =>
          candidate.valueGroupId !== undefined ||
          candidate.evidence.some((item) => item.decision === "accepted"),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "A missing fact facet cannot contain matched evidence",
        path: ["candidates"],
      });
    }
    if (facet.outcome === "selected" && valueGroupIds.size !== 1) {
      context.addIssue({
        code: "custom",
        message: "A selected fact facet requires exactly one value group",
        path: ["candidates"],
      });
    }
    if (
      facet.outcome === "conflicted" &&
      valueGroupIds.size < 2 &&
      !hasConflictCandidate
    ) {
      context.addIssue({
        code: "custom",
        message: "A conflicted fact facet requires conflict evidence",
        path: ["candidates"],
      });
    }
    if (hasConflictCandidate && facet.outcome !== "conflicted") {
      context.addIssue({
        code: "custom",
        message: "A conflict-marked candidate requires a conflicted facet",
        path: ["outcome"],
      });
    }
    if (
      facet.outcome === "conflicted" &&
      candidatesWithValues.some(
        (candidate) => candidate.reasonCode !== "fact_candidate_value_conflict",
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Every matched candidate in a conflicted facet must carry the value-conflict decision",
        path: ["candidates"],
      });
    }
  });

const ExplicitFactSelectorAttemptAuditSchema = z
  .object({
    tier: z.enum(["event_card", "basic_memory"]),
    outcome: ExplicitFactSelectorAttemptOutcomeSchema,
    scannedCandidateCount: z.number().int().nonnegative().max(500),
    scanLimit: z.number().int().min(1).max(500).optional(),
    scanUnit: z.enum(["candidate_pool", "evidence_per_memory"]).optional(),
    scanWitnessMemoryId: EntityIdSchema.optional(),
    truncatedMemoryIds: z.array(EntityIdSchema).max(500).optional(),
    facets: z.array(ExplicitFactSelectorFacetAuditSchema).min(2).max(3),
  })
  .strict()
  .superRefine((attempt, context) => {
    attempt.facets.forEach((facet, index) => {
      if (facet.index !== index) {
        context.addIssue({
          code: "custom",
          message: "Selector facet indexes must be continuous",
          path: ["facets", index, "index"],
        });
      }
      if (
        attempt.outcome !== "scan_truncated" &&
        facet.candidates.length !== attempt.scannedCandidateCount
      ) {
        context.addIssue({
          code: "custom",
          message: "Fact attempt count must match every facet candidate set",
          path: ["facets", index, "candidates"],
        });
      }
    });
    const firstCandidateIds = attempt.facets[0]?.candidates.map(
      (candidate) => candidate.memoryId,
    );
    if (
      firstCandidateIds !== undefined &&
      attempt.facets.some(
        (facet) =>
          !sameStringSet(
            facet.candidates.map((candidate) => candidate.memoryId),
            firstCandidateIds,
          ),
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Fact attempt facets must audit the same candidate pool",
        path: ["facets"],
      });
    }
    const selectedCandidates = attempt.facets.flatMap((facet) =>
      facet.candidates.filter((candidate) => candidate.decision === "selected"),
    );
    const hasMissingFacet = attempt.facets.some(
      (facet) => facet.outcome === "missing",
    );
    const hasConflictedFacet = attempt.facets.some(
      (facet) => facet.outcome === "conflicted",
    );
    const allFacetsMatched = attempt.facets.every(
      (facet) => facet.outcome === "selected",
    );
    const everyFacetBlockedByScan = attempt.facets.every(
      (facet) =>
        facet.outcome === "selected" &&
        facet.candidates.filter(
          (candidate) =>
            candidate.reasonCode ===
            "fact_candidate_rejected_due_scan_truncation",
        ).length === 1,
    );
    const hasScanBlockedCandidate = attempt.facets.some((facet) =>
      facet.candidates.some(
        (candidate) =>
          candidate.reasonCode ===
          "fact_candidate_rejected_due_scan_truncation",
      ),
    );
    const hasHigherTierFailureCandidate = attempt.facets.some((facet) =>
      facet.candidates.some(
        (candidate) =>
          candidate.reasonCode ===
          "fact_candidate_rejected_due_higher_tier_failure",
      ),
    );
    const hasEventShadowedCandidate = attempt.facets.some((facet) =>
      facet.candidates.some(
        (candidate) =>
          candidate.reasonCode ===
          "fact_candidate_same_value_shadowed_by_event_card",
      ),
    );
    const hasEvidenceScanCandidate = attempt.facets.some((facet) =>
      facet.candidates.some(
        (candidate) =>
          candidate.reasonCode === "fact_candidate_evidence_scan_truncated",
      ),
    );
    const provisionalWinnerCounts = attempt.facets.map(
      (facet) =>
        facet.candidates.filter(
          (candidate) =>
            candidate.reasonCode === "fact_candidate_provisional_winner",
        ).length,
    );
    const hasProvisionalWinner = provisionalWinnerCounts.some(
      (count) => count > 0,
    );
    const atomicConflictFacets = attempt.facets.filter((facet) =>
      facet.candidates.some(
        (candidate) =>
          candidate.reasonCode ===
          "fact_candidate_rejected_due_atomic_conflict",
      ),
    );
    if (attempt.outcome === "selected") {
      if (
        attempt.facets.some(
          (facet) =>
            facet.outcome !== "selected" ||
            facet.candidates.filter(
              (candidate) => candidate.decision === "selected",
            ).length !== 1,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "A selected selector attempt must select every facet",
          path: ["facets"],
        });
      }
    } else if (selectedCandidates.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A non-selected selector attempt cannot select candidates",
        path: ["facets"],
      });
    }
    if (
      attempt.outcome === "incomplete" &&
      !hasMissingFacet &&
      !everyFacetBlockedByScan &&
      !provisionalWinnerCounts.every((count) => count === 1)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An incomplete selector attempt requires a missing or scan-blocked facet set",
        path: ["facets"],
      });
    }
    if (
      (attempt.outcome === "below_threshold" ||
        attempt.outcome === "capacity_insufficient") &&
      provisionalWinnerCounts.some((count) => count !== 1)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A threshold or capacity rejection must identify one provisional winner per facet",
        path: ["facets"],
      });
    }
    if (
      hasProvisionalWinner &&
      (attempt.outcome === "selected" ||
        attempt.outcome === "consistent_not_selected" ||
        attempt.outcome === "complete_not_selected" ||
        attempt.outcome === "scan_truncated" ||
        (attempt.outcome === "incomplete" && hasMissingFacet) ||
        (attempt.outcome === "conflicted" &&
          attempt.facets.some(
            (facet) =>
              facet.outcome !== "selected" &&
              facet.candidates.some(
                (candidate) =>
                  candidate.reasonCode === "fact_candidate_provisional_winner",
              ),
          )))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A provisional winner may annotate only a complete rejected selection before final conflict resolution",
        path: ["facets"],
      });
    }
    if (hasProvisionalWinner && hasScanBlockedCandidate) {
      context.addIssue({
        code: "custom",
        message:
          "A provisional winner cannot be combined with a scan-blocked winner",
        path: ["facets"],
      });
    }
    if (
      hasScanBlockedCandidate &&
      (attempt.outcome !== "incomplete" || !everyFacetBlockedByScan)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Scan-blocked candidates require one complete provisional Event result",
        path: ["facets"],
      });
    }
    if (attempt.outcome === "conflicted" && !hasConflictedFacet) {
      context.addIssue({
        code: "custom",
        message: "A conflicted selector attempt requires a conflicted facet",
        path: ["facets"],
      });
    }
    if (hasConflictedFacet && attempt.outcome !== "conflicted") {
      context.addIssue({
        code: "custom",
        message: "A conflicted fact facet requires a conflicted attempt",
        path: ["outcome"],
      });
    }
    if (
      (attempt.outcome === "below_threshold" ||
        attempt.outcome === "capacity_insufficient" ||
        attempt.outcome === "consistent_not_selected" ||
        attempt.outcome === "complete_not_selected") &&
      !allFacetsMatched
    ) {
      context.addIssue({
        code: "custom",
        message: "This selector attempt outcome requires every facet to match",
        path: ["facets"],
      });
    }
    if (
      attempt.outcome === "complete_not_selected" &&
      attempt.facets.some(
        (facet) =>
          facet.candidates.filter(
            (candidate) =>
              candidate.reasonCode ===
              "fact_candidate_rejected_due_higher_tier_failure",
          ).length !== 1,
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A complete non-selected attempt must identify its blocked winner",
        path: ["facets"],
      });
    }
    if (
      hasHigherTierFailureCandidate &&
      (attempt.tier !== "basic_memory" ||
        attempt.outcome !== "complete_not_selected")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Only a complete blocked Basic attempt may use the higher-tier failure reason",
        path: ["facets"],
      });
    }
    if (
      attempt.outcome === "consistent_not_selected" &&
      attempt.facets.some(
        (facet) =>
          !facet.candidates.some(
            (candidate) =>
              candidate.reasonCode ===
              "fact_candidate_same_value_shadowed_by_event_card",
          ) ||
          facet.candidates.some(
            (candidate) =>
              candidate.valueGroupId !== undefined &&
              candidate.reasonCode !==
                "fact_candidate_same_value_shadowed_by_event_card",
          ),
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A consistency-only Basic attempt must identify its Event-shadowed matches",
        path: ["facets"],
      });
    }
    if (
      hasEventShadowedCandidate &&
      (attempt.tier !== "basic_memory" ||
        attempt.outcome !== "consistent_not_selected")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Only a consistency-only Basic attempt may use the Event-shadow reason",
        path: ["facets"],
      });
    }
    if (
      hasEvidenceScanCandidate &&
      (attempt.tier !== "basic_memory" ||
        attempt.outcome !== "scan_truncated" ||
        attempt.scanUnit !== "evidence_per_memory")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Evidence-scan truncation candidates belong only to a truncated Basic evidence scan",
        path: ["facets"],
      });
    }
    if (
      atomicConflictFacets.length > 0 &&
      (attempt.outcome !== "conflicted" ||
        !hasConflictedFacet ||
        hasMissingFacet ||
        atomicConflictFacets.some((facet) => facet.outcome !== "selected") ||
        attempt.facets.some(
          (facet) =>
            facet.outcome === "selected" &&
            facet.candidates.filter(
              (candidate) =>
                candidate.reasonCode ===
                "fact_candidate_rejected_due_atomic_conflict",
            ).length !== 1,
        ))
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Atomic-conflict rejections require a conflicted attempt and apply only to its otherwise selected facets",
        path: ["facets"],
      });
    }
    if (attempt.outcome === "scan_truncated") {
      if (attempt.scanLimit === undefined || attempt.scanUnit === undefined) {
        context.addIssue({
          code: "custom",
          message: "A truncated fact attempt requires its scan boundary",
          path: ["scanLimit"],
        });
      } else if (
        attempt.scanUnit === "candidate_pool" &&
        attempt.scannedCandidateCount !== attempt.scanLimit
      ) {
        context.addIssue({
          code: "custom",
          message: "A truncated candidate scan must reach its limit",
          path: ["scannedCandidateCount"],
        });
      }
      if (
        (attempt.tier === "event_card" &&
          attempt.scanUnit !== "candidate_pool") ||
        (attempt.scanUnit === "evidence_per_memory" &&
          attempt.tier !== "basic_memory")
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Event scans use candidate-pool limits and per-memory evidence scans belong to Basic memory",
          path: ["scanUnit"],
        });
      }
      if (
        attempt.scanUnit === "evidence_per_memory" &&
        attempt.scanLimit !== 100
      ) {
        context.addIssue({
          code: "custom",
          message: "Per-memory evidence scans must use the v1 safety limit",
          path: ["scanLimit"],
        });
      }
      if (attempt.scanUnit === "evidence_per_memory") {
        const truncatedMemoryIds = attempt.truncatedMemoryIds ?? [];
        if (
          attempt.scannedCandidateCount === 0 ||
          truncatedMemoryIds.length === 0 ||
          truncatedMemoryIds.length > attempt.scannedCandidateCount ||
          attempt.facets.some(
            (facet) =>
              !sameStringSet(
                facet.candidates.map((candidate) => candidate.memoryId),
                truncatedMemoryIds,
              ),
          )
        ) {
          context.addIssue({
            code: "custom",
            message:
              "A truncated evidence scan must identify its affected memories",
            path: ["truncatedMemoryIds"],
          });
        }
        if (
          attempt.facets.some(
            (facet) =>
              facet.outcome !== "missing" ||
              facet.candidates.some(
                (candidate) =>
                  candidate.decision !== "rejected" ||
                  candidate.reasonCode !==
                    "fact_candidate_evidence_scan_truncated" ||
                  candidate.valueGroupId !== undefined ||
                  candidate.evidence.length > 0,
              ),
          )
        ) {
          context.addIssue({
            code: "custom",
            message:
              "A truncated evidence scan must mark every culprit as uninspected",
            path: ["facets"],
          });
        }
      } else if (attempt.truncatedMemoryIds !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Only evidence scans may identify truncated memories",
          path: ["truncatedMemoryIds"],
        });
      }
      if (
        attempt.scanUnit === "candidate_pool" &&
        attempt.facets.some(
          (facet) => facet.outcome !== "missing" || facet.candidates.length > 0,
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "A truncated candidate scan cannot audit its unseen candidate suffix",
          path: ["facets"],
        });
      }
      if (
        attempt.scanUnit === "candidate_pool" &&
        attempt.scanWitnessMemoryId === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "A truncated candidate scan requires one overflow witness",
          path: ["scanWitnessMemoryId"],
        });
      }
      if (
        attempt.scanUnit !== "candidate_pool" &&
        attempt.scanWitnessMemoryId !== undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "Only candidate scans may identify an overflow witness",
          path: ["scanWitnessMemoryId"],
        });
      }
      if (
        attempt.truncatedMemoryIds !== undefined &&
        new Set(attempt.truncatedMemoryIds).size !==
          attempt.truncatedMemoryIds.length
      ) {
        context.addIssue({
          code: "custom",
          message: "Truncated memory ids must be unique",
          path: ["truncatedMemoryIds"],
        });
      }
    } else if (
      attempt.scanLimit !== undefined ||
      attempt.scanUnit !== undefined ||
      attempt.scanWitnessMemoryId !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "Only truncated fact attempts may declare a scan boundary",
        path: ["scanLimit"],
      });
    } else if (attempt.truncatedMemoryIds !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Only truncated fact attempts may identify memories",
        path: ["truncatedMemoryIds"],
      });
    }
  });

export const ExplicitFactSelectorAuditSchema = z
  .object({
    policy: z.literal("explicit_fact_checklist_v1"),
    expectedFacetCount: z.number().int().min(2).max(3),
    outcome: ExplicitFactSelectorOutcomeSchema,
    scanLimit: z.literal(500),
    scanTruncated: z.boolean(),
    replayEvidenceIds: z
      .array(EntityIdSchema)
      .max(500)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Fact replay evidence ids must be unique",
      })
      .optional(),
    attempts: z.array(ExplicitFactSelectorAttemptAuditSchema).min(1).max(2),
  })
  .strict()
  .superRefine((audit, context) => {
    const evidenceOwnerById = new Map<string, string>();
    const evidenceReasonsById = new Map<
      string,
      ExplicitFactSelectorEvidenceReason[]
    >();
    const auditedEvidenceTotalByAttemptAndMemory = new Map<string, number>();
    const facetIndependentEvidenceReasons =
      new Set<ExplicitFactSelectorEvidenceReason>([
        "fact_evidence_future",
        "fact_evidence_not_assertive",
        "fact_evidence_quote_not_grounded",
        "fact_evidence_source_missing",
        "fact_evidence_source_not_snapshot_safe",
        "fact_evidence_source_not_user",
        "fact_evidence_unsupported_source",
      ]);
    audit.attempts.forEach((attempt, attemptIndex) => {
      attempt.facets.forEach((facet) => {
        facet.candidates.forEach((candidate) => {
          if (
            candidate.evidence.length > 0 ||
            candidate.evidenceOmittedCount !== undefined
          ) {
            const key = `${attemptIndex}\u0000${candidate.memoryId}`;
            const evidenceTotal =
              candidate.evidence.length + (candidate.evidenceOmittedCount ?? 0);
            const previousTotal =
              auditedEvidenceTotalByAttemptAndMemory.get(key);
            if (
              previousTotal !== undefined &&
              previousTotal !== evidenceTotal
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "A candidate must report the same evidence total across evaluated facets",
                path: ["attempts", attemptIndex, "facets"],
              });
            }
            auditedEvidenceTotalByAttemptAndMemory.set(key, evidenceTotal);
          }
          candidate.evidence.forEach((evidence) => {
            const previousOwner = evidenceOwnerById.get(evidence.evidenceId);
            if (
              previousOwner !== undefined &&
              previousOwner !== candidate.memoryId
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "A fact evidence id must have one candidate-memory owner",
                path: ["attempts", attemptIndex, "facets"],
              });
            }
            evidenceOwnerById.set(evidence.evidenceId, candidate.memoryId);
            const reasons = evidenceReasonsById.get(evidence.evidenceId) ?? [];
            reasons.push(evidence.reasonCode);
            evidenceReasonsById.set(evidence.evidenceId, reasons);
          });
        });
      });
    });
    for (const reasons of evidenceReasonsById.values()) {
      const independentReasons = reasons.filter((reason) =>
        facetIndependentEvidenceReasons.has(reason),
      );
      if (
        independentReasons.length > 0 &&
        (new Set(independentReasons).size !== 1 || new Set(reasons).size !== 1)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Facet-independent evidence rejections must be consistent across the audit",
          path: ["attempts"],
        });
      }
    }
    const tiers = audit.attempts.map((attempt) => attempt.tier);
    if (new Set(tiers).size !== tiers.length) {
      context.addIssue({
        code: "custom",
        message: "Selector attempt tiers must be unique",
        path: ["attempts"],
      });
    }
    if (tiers[0] !== "event_card") {
      context.addIssue({
        code: "custom",
        message: "Fact selection must inspect EventCards first",
        path: ["attempts", 0, "tier"],
      });
    }
    if (
      tiers.length === 2 &&
      (tiers[0] !== "event_card" || tiers[1] !== "basic_memory")
    ) {
      context.addIssue({
        code: "custom",
        message: "Fact selector attempts must preserve hierarchy order",
        path: ["attempts"],
      });
    }
    if (audit.outcome !== "scan_truncated" && audit.attempts.length !== 2) {
      context.addIssue({
        code: "custom",
        message: "A complete fact safety check requires both hierarchy tiers",
        path: ["attempts"],
      });
    }
    audit.attempts.forEach((attempt, index) => {
      if (attempt.facets.length !== audit.expectedFacetCount) {
        context.addIssue({
          code: "custom",
          message: "Selector attempts must cover every requested facet",
          path: ["attempts", index, "facets"],
        });
      }
      if (
        attempt.facets.some(
          (facet, facetIndex) =>
            facet.kind !== audit.attempts[0]?.facets[facetIndex]?.kind ||
            JSON.stringify(facet.request) !==
              JSON.stringify(audit.attempts[0]?.facets[facetIndex]?.request),
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Selector attempts must preserve facet identity and complete descriptors",
          path: ["attempts", index, "facets"],
        });
      }
      if (
        attempt.outcome === "scan_truncated" &&
        attempt.scanUnit === "candidate_pool" &&
        attempt.scanLimit !== audit.scanLimit
      ) {
        context.addIssue({
          code: "custom",
          message:
            "A candidate-pool truncation must use the selector safety limit",
          path: ["attempts", index, "scanLimit"],
        });
      }
    });
    if (
      audit.scanTruncated !==
      audit.attempts.some((attempt) => attempt.outcome === "scan_truncated")
    ) {
      context.addIssue({
        code: "custom",
        message: "Selector scan flag must match its truncated attempts",
        path: ["scanTruncated"],
      });
    }
    const scanBlockedAttemptIndexes = audit.attempts.flatMap(
      (attempt, index) =>
        attempt.facets.some((facet) =>
          facet.candidates.some(
            (candidate) =>
              candidate.reasonCode ===
              "fact_candidate_rejected_due_scan_truncation",
          ),
        )
          ? [index]
          : [],
    );
    if (
      scanBlockedAttemptIndexes.length > 0 &&
      (audit.outcome !== "scan_truncated" ||
        scanBlockedAttemptIndexes.length !== 1 ||
        scanBlockedAttemptIndexes[0] !== 0 ||
        audit.attempts[0]?.tier !== "event_card" ||
        audit.attempts[0]?.outcome !== "incomplete" ||
        audit.attempts[1]?.tier !== "basic_memory" ||
        audit.attempts[1]?.outcome !== "scan_truncated")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A scan-blocked Event attempt requires a following truncated Basic scan",
        path: ["attempts"],
      });
    }
    if (
      audit.attempts[0]?.outcome === "scan_truncated" &&
      audit.attempts.length === 2 &&
      audit.attempts[1]?.outcome !== "scan_truncated"
    ) {
      context.addIssue({
        code: "custom",
        message:
          "An Event candidate-pool truncation cannot be followed by a completed Basic attempt",
        path: ["attempts", 1],
      });
    }
    const selectedAttemptCount = audit.attempts.filter(
      (attempt) => attempt.outcome === "selected",
    ).length;
    if (
      (audit.outcome === "selected" && selectedAttemptCount !== 1) ||
      (audit.outcome !== "selected" && selectedAttemptCount !== 0)
    ) {
      context.addIssue({
        code: "custom",
        message: "Selector outcome and selected attempt count must agree",
        path: ["attempts"],
      });
    }
    if (
      audit.outcome === "selected" &&
      audit.attempts.some(
        (attempt) =>
          attempt.outcome !== "selected" &&
          attempt.outcome !== "incomplete" &&
          attempt.outcome !== "consistent_not_selected",
      )
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A selected fact audit cannot hide a conflict, truncation, or capacity failure",
        path: ["attempts"],
      });
    }
    for (
      let facetIndex = 0;
      facetIndex < audit.expectedFacetCount;
      facetIndex += 1
    ) {
      const facets = audit.attempts.flatMap((attempt) => {
        const facet = attempt.facets[facetIndex];
        return facet === undefined ? [] : [facet];
      });
      const valueGroupIds = new Set(
        facets.flatMap((facet) =>
          facet.candidates.flatMap((candidate) =>
            candidate.valueGroupId === undefined
              ? []
              : [candidate.valueGroupId],
          ),
        ),
      );
      if (
        valueGroupIds.size > 1 &&
        facets.some(
          (facet) =>
            facet.candidates.some(
              (candidate) => candidate.valueGroupId !== undefined,
            ) && facet.outcome !== "conflicted",
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Cross-tier value disagreement must propagate to every matched facet",
          path: ["attempts", 0, "facets", facetIndex],
        });
      }
    }
    const rejectionPriority = [
      "conflicted",
      "scan_truncated",
      "capacity_insufficient",
      "below_threshold",
      "incomplete",
    ] as const;
    const expectedRejectedOutcome = rejectionPriority.find((outcome) =>
      audit.attempts.some((attempt) => attempt.outcome === outcome),
    );
    if (
      audit.outcome !== "selected" &&
      audit.outcome !== expectedRejectedOutcome
    ) {
      context.addIssue({
        code: "custom",
        message: "Selector outcome must match the strongest rejected attempt",
        path: ["attempts"],
      });
    }
    const completeNotSelectedIndex = audit.attempts.findIndex(
      (attempt) => attempt.outcome === "complete_not_selected",
    );
    if (
      completeNotSelectedIndex >= 0 &&
      (audit.outcome === "selected" ||
        completeNotSelectedIndex !== 1 ||
        audit.attempts[0]?.tier !== "event_card" ||
        (audit.attempts[0]?.outcome !== "capacity_insufficient" &&
          audit.attempts[0]?.outcome !== "below_threshold") ||
        audit.attempts[1]?.tier !== "basic_memory")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A complete blocked Basic attempt requires a stronger Event rejection",
        path: ["attempts"],
      });
    }
    if (
      audit.outcome === "scan_truncated" &&
      !audit.attempts.some((attempt) => attempt.outcome === "scan_truncated")
    ) {
      context.addIssue({
        code: "custom",
        message: "A truncated selector audit requires a truncated attempt",
        path: ["attempts"],
      });
    }
    if (
      audit.outcome !== "selected" &&
      audit.attempts.some(
        (attempt) => attempt.outcome === "consistent_not_selected",
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "A consistency-only attempt requires a selected outer result",
        path: ["attempts"],
      });
    }
    const consistencyAttemptIndex = audit.attempts.findIndex(
      (attempt) => attempt.outcome === "consistent_not_selected",
    );
    if (
      consistencyAttemptIndex >= 0 &&
      (audit.outcome !== "selected" ||
        consistencyAttemptIndex !== 1 ||
        audit.attempts[0]?.tier !== "event_card" ||
        audit.attempts[0]?.outcome !== "selected" ||
        audit.attempts[1]?.tier !== "basic_memory")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "A consistency-only Basic attempt requires a selected EventCard attempt",
        path: ["attempts"],
      });
    }
    if (consistencyAttemptIndex === 1) {
      const selectedEventAttempt = audit.attempts[0];
      const consistentBasicAttempt = audit.attempts[1];
      const mismatchedFacet = consistentBasicAttempt?.facets.some(
        (facet, index) => {
          const eventGroup = selectedEventAttempt?.facets[
            index
          ]?.candidates.find(
            (candidate) => candidate.decision === "selected",
          )?.valueGroupId;
          const basicGroups = new Set(
            facet.candidates.flatMap((candidate) =>
              candidate.valueGroupId === undefined
                ? []
                : [candidate.valueGroupId],
            ),
          );
          return (
            eventGroup === undefined ||
            basicGroups.size !== 1 ||
            !basicGroups.has(eventGroup)
          );
        },
      );
      if (mismatchedFacet === true) {
        context.addIssue({
          code: "custom",
          message:
            "A consistency-only Basic attempt must match every EventCard value group",
          path: ["attempts", 1, "facets"],
        });
      }
    }
    if (audit.outcome === "selected") {
      const selectedAttemptIndex = audit.attempts.findIndex(
        (attempt) => attempt.outcome === "selected",
      );
      const selectedAttempt = audit.attempts[selectedAttemptIndex];
      audit.attempts.forEach((attempt, attemptIndex) => {
        if (attemptIndex === selectedAttemptIndex) return;
        const mismatchedFacet = attempt.facets.some((facet, facetIndex) => {
          const selectedGroup = selectedAttempt?.facets[
            facetIndex
          ]?.candidates.find(
            (candidate) => candidate.decision === "selected",
          )?.valueGroupId;
          const groups = new Set(
            facet.candidates.flatMap((candidate) =>
              candidate.valueGroupId === undefined
                ? []
                : [candidate.valueGroupId],
            ),
          );
          return (
            groups.size > 0 &&
            (selectedGroup === undefined ||
              groups.size !== 1 ||
              !groups.has(selectedGroup))
          );
        });
        if (mismatchedFacet) {
          context.addIssue({
            code: "custom",
            message:
              "Every matched fallback facet must agree with the selected tier",
            path: ["attempts", attemptIndex, "facets"],
          });
        }
      });
    }
    if (audit.outcome === "conflicted") {
      for (
        let facetIndex = 0;
        facetIndex < audit.expectedFacetCount;
        facetIndex += 1
      ) {
        const facets = audit.attempts.flatMap((attempt) => {
          const facet = attempt.facets[facetIndex];
          return facet === undefined ? [] : [facet];
        });
        if (!facets.some((facet) => facet.outcome === "conflicted")) continue;
        const valueGroups = new Set(
          facets.flatMap((facet) =>
            facet.candidates.flatMap((candidate) =>
              candidate.valueGroupId === undefined
                ? []
                : [candidate.valueGroupId],
            ),
          ),
        );
        const hasIntrinsicConflict = facets.some((facet) =>
          facet.candidates.some(
            (candidate) =>
              candidate.reasonCode === "fact_candidate_evidence_conflicted" ||
              candidate.reasonCode === "fact_candidate_value_conflicted",
          ),
        );
        if (valueGroups.size < 2 && !hasIntrinsicConflict) {
          context.addIssue({
            code: "custom",
            message:
              "A conflicted fact facet requires two values or intrinsic conflict evidence",
            path: ["attempts", 0, "facets", facetIndex],
          });
        }
      }
    }
    for (
      let facetIndex = 0;
      facetIndex < audit.expectedFacetCount;
      facetIndex += 1
    ) {
      const facets = audit.attempts.flatMap((attempt) => {
        const facet = attempt.facets[facetIndex];
        return facet === undefined ? [] : [facet];
      });
      const hasIntrinsicConflict = facets.some((facet) =>
        facet.candidates.some(
          (candidate) =>
            candidate.reasonCode === "fact_candidate_evidence_conflicted" ||
            candidate.reasonCode === "fact_candidate_value_conflicted",
        ),
      );
      if (
        hasIntrinsicConflict &&
        facets.some((facet) => {
          const matchedCandidates = facet.candidates.filter(
            (candidate) => candidate.valueGroupId !== undefined,
          );
          return (
            matchedCandidates.length > 0 &&
            (facet.outcome !== "conflicted" ||
              matchedCandidates.some(
                (candidate) =>
                  candidate.reasonCode !== "fact_candidate_value_conflict",
              ))
          );
        })
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Intrinsic fact conflicts must propagate across every matched hierarchy tier",
          path: ["attempts", 0, "facets", facetIndex],
        });
      }
    }
  });
export type ExplicitFactSelectorAudit = z.infer<
  typeof ExplicitFactSelectorAuditSchema
>;
export type ExplicitFactSelectorAttemptAudit = z.infer<
  typeof ExplicitFactSelectorAttemptAuditSchema
>;

export const ExplicitFactSelectorInputSnapshotSchema = z
  .object({
    // Each of the two hierarchy tiers may freeze a 500-item safety prefix and
    // one overflow witness proving that the prefix was actually truncated.
    memories: z.array(MemorySchema).max(1_002),
    // EventCards expose at most 20 sources per candidate (10,000 total),
    // while each Basic candidate can contribute distinct 20-item previews to
    // three facets (30,000 total). Preserve the complete audited union.
    evidence: z.array(MemoryEvidenceSchema).max(40_000),
    candidateTiers: z
      .array(
        z
          .object({
            memoryId: EntityIdSchema,
            tier: z.enum(["event_card", "basic_memory"]),
          })
          .strict(),
      )
      .max(1_002),
  })
  .strict();
export type ExplicitFactSelectorInputSnapshot = z.infer<
  typeof ExplicitFactSelectorInputSnapshotSchema
>;

export const RetrievalHierarchySnapshotSchema = z
  .object({
    finalTier: z.enum([
      "event_card",
      "verbatim_quote",
      "date_digest",
      "basic_memory",
      "none",
    ]),
    candidateTiers: z
      .array(
        z
          .object({
            memoryId: EntityIdSchema,
            tier: z.enum([
              "event_card",
              "verbatim_quote",
              "date_digest",
              "basic_memory",
            ]),
          })
          .strict(),
      )
      .max(500),
    temporalResolution: JsonValueSchema.optional(),
    selectorAudit: ExplicitFactSelectorAuditSchema.optional(),
    abstentionReason: ReasonCodeSchema.optional(),
    abstentionScore: UnitIntervalSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const candidateIds = snapshot.candidateTiers.map((item) => item.memoryId);
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({
        code: "custom",
        message: "Hierarchy candidate ids must be unique",
        path: ["candidateTiers"],
      });
    }
    if (snapshot.finalTier === "none") {
      if (snapshot.abstentionReason === undefined) {
        context.addIssue({
          code: "custom",
          message: "An abstained hierarchy replay requires a reason",
          path: ["abstentionReason"],
        });
      }
      if (snapshot.abstentionScore === undefined) {
        context.addIssue({
          code: "custom",
          message: "An abstained hierarchy replay requires a score",
          path: ["abstentionScore"],
        });
      }
    } else if (
      snapshot.abstentionReason !== undefined ||
      snapshot.abstentionScore !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "A selected hierarchy replay cannot contain abstention data",
        path: ["abstentionReason"],
      });
    }
  });
export type RetrievalHierarchySnapshot = z.infer<
  typeof RetrievalHierarchySnapshotSchema
>;

export const RetrievalReplayInputSchema = z
  .object({
    agentId: EntityIdSchema,
    query: MemoryRecallQuerySchema,
    nowUtc: UtcDateTimeSchema,
    memories: z.array(MemorySchema).max(500),
    evidence: z.array(MemoryEvidenceSchema).max(10_000),
    minimumScore: UnitIntervalSchema,
    maxEvidence: z.number().int().min(1).max(8),
    candidateLimit: z.number().int().min(1).max(500),
    strategyVersion: z
      .enum(["continuity_hierarchy_v1", "continuity_context_v2"])
      .optional(),
    hierarchy: RetrievalHierarchySnapshotSchema.optional(),
    selectorAuditInput: ExplicitFactSelectorInputSnapshotSchema.optional(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const contextual = snapshot.strategyVersion === "continuity_context_v2";
    if (contextual !== (snapshot.query.contextPlan !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Context recall strategy requires its frozen query plan",
        path: ["query", "contextPlan"],
      });
    }
    if (
      snapshot.maxEvidence >
      (snapshot.query.contextPlan?.maxRecallEvidence ?? 3)
    ) {
      context.addIssue({
        code: "custom",
        message: "Recall evidence budget exceeds the frozen policy",
        path: ["maxEvidence"],
      });
    }
    const memoryIds = new Set<string>();
    const replayMemoryById = new Map<string, Memory>();
    for (const [index, memory] of snapshot.memories.entries()) {
      if (memory.agentId !== snapshot.agentId) {
        context.addIssue({
          code: "custom",
          message: "Replay memories must belong to the run agent",
          path: ["memories", index, "agentId"],
        });
      }
      if (memoryIds.has(memory.id)) {
        context.addIssue({
          code: "custom",
          message: "Replay memory ids must be unique",
          path: ["memories", index, "id"],
        });
      }
      memoryIds.add(memory.id);
      replayMemoryById.set(memory.id, memory);
    }
    const evidenceIds = new Set<string>();
    const replayEvidenceById = new Map(
      snapshot.evidence.map((evidence) => [evidence.id, evidence]),
    );
    for (const [index, evidence] of snapshot.evidence.entries()) {
      if (!memoryIds.has(evidence.memoryId)) {
        context.addIssue({
          code: "custom",
          message: "Replay evidence must reference a snapshotted memory",
          path: ["evidence", index, "memoryId"],
        });
      }
      if (evidenceIds.has(evidence.id)) {
        context.addIssue({
          code: "custom",
          message: "Replay evidence ids must be unique",
          path: ["evidence", index, "id"],
        });
      }
      evidenceIds.add(evidence.id);
    }
    if (
      (snapshot.strategyVersion === "continuity_hierarchy_v1" &&
        snapshot.hierarchy === undefined) ||
      (snapshot.strategyVersion === undefined &&
        snapshot.hierarchy !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Continuity hierarchy strategy and snapshot must coexist",
        path: ["hierarchy"],
      });
    }
    if (
      (snapshot.hierarchy?.selectorAudit !== undefined) !==
      (snapshot.selectorAuditInput !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "A fact selector audit requires its frozen audit input corpus",
        path: ["selectorAuditInput"],
      });
    }
    if (snapshot.hierarchy !== undefined) {
      const hierarchyIds = snapshot.hierarchy.candidateTiers.map(
        (item) => item.memoryId,
      );
      const hierarchyTierByMemoryId = new Map(
        snapshot.hierarchy.candidateTiers.map((item) => [
          item.memoryId,
          item.tier,
        ]),
      );
      if (!sameStringSet(hierarchyIds, [...memoryIds])) {
        context.addIssue({
          code: "custom",
          message: "Hierarchy candidate tiers must cover every replay memory",
          path: ["hierarchy", "candidateTiers"],
        });
      }
      const finalTier = snapshot.hierarchy.finalTier;
      if (
        finalTier !== "none" &&
        !snapshot.hierarchy.candidateTiers.some(
          (item) => item.tier === finalTier,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "The final hierarchy tier requires a candidate",
          path: ["hierarchy", "finalTier"],
        });
      }
      const selectorAudit = snapshot.hierarchy.selectorAudit;
      if (selectorAudit !== undefined) {
        const parsedRequest = parseExplicitFactVerificationRequest(
          snapshot.query.query,
        );
        if (
          parsedRequest.kind !== "valid" ||
          parsedRequest.request.expectedFacetCount !==
            selectorAudit.expectedFacetCount ||
          selectorAudit.attempts.some((attempt) =>
            attempt.facets.some((facet, facetIndex) => {
              const expectedFacet =
                parsedRequest.kind === "valid"
                  ? parsedRequest.request.facets[facetIndex]
                  : undefined;
              return (
                expectedFacet === undefined ||
                JSON.stringify(facet.request) !==
                  JSON.stringify(explicitFactFacetDescriptor(expectedFacet))
              );
            }),
          )
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Fact selector facets must exactly match the frozen replay query",
            path: ["hierarchy", "selectorAudit", "attempts"],
          });
        }
        const selectorInput = snapshot.selectorAuditInput;
        if (selectorInput !== undefined) {
          const selectorMemoryIds = new Set<string>();
          const selectorMemoryById = new Map<string, Memory>();
          selectorInput.memories.forEach((memory, index) => {
            if (memory.agentId !== snapshot.agentId) {
              context.addIssue({
                code: "custom",
                message: "Selector audit memories must belong to the run agent",
                path: ["selectorAuditInput", "memories", index, "agentId"],
              });
            }
            if (selectorMemoryIds.has(memory.id)) {
              context.addIssue({
                code: "custom",
                message: "Selector audit memory ids must be unique",
                path: ["selectorAuditInput", "memories", index, "id"],
              });
            }
            selectorMemoryIds.add(memory.id);
            selectorMemoryById.set(memory.id, memory);
            const replayMemory = replayMemoryById.get(memory.id);
            if (
              replayMemory !== undefined &&
              JSON.stringify(replayMemory) !== JSON.stringify(memory)
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "Overlapping replay and selector memories must be identical",
                path: ["selectorAuditInput", "memories", index],
              });
            }
          });
          const selectorTierByMemoryId = new Map<
            string,
            "event_card" | "basic_memory"
          >();
          selectorInput.candidateTiers.forEach((candidate, index) => {
            if (selectorTierByMemoryId.has(candidate.memoryId)) {
              context.addIssue({
                code: "custom",
                message: "Selector audit candidate tiers must be unique",
                path: [
                  "selectorAuditInput",
                  "candidateTiers",
                  index,
                  "memoryId",
                ],
              });
            }
            if (!selectorMemoryIds.has(candidate.memoryId)) {
              context.addIssue({
                code: "custom",
                message:
                  "Selector audit candidate tiers must reference frozen audit memories",
                path: [
                  "selectorAuditInput",
                  "candidateTiers",
                  index,
                  "memoryId",
                ],
              });
            }
            const replayTier = hierarchyTierByMemoryId.get(candidate.memoryId);
            if (replayTier !== undefined && replayTier !== candidate.tier) {
              context.addIssue({
                code: "custom",
                message:
                  "Overlapping replay and selector candidates must have the same hierarchy tier",
                path: ["selectorAuditInput", "candidateTiers", index, "tier"],
              });
            }
            selectorTierByMemoryId.set(candidate.memoryId, candidate.tier);
          });
          if (
            !sameStringSet(
              [...selectorTierByMemoryId.keys()],
              [...selectorMemoryIds],
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "Frozen selector tiers must exactly cover frozen audit memories",
              path: ["selectorAuditInput", "candidateTiers"],
            });
          }
          const acceptedSelectorEvidenceIds = new Set(
            selectorAudit.attempts.flatMap((attempt) =>
              attempt.facets.flatMap((facet) =>
                facet.candidates.flatMap((candidate) =>
                  candidate.evidence.flatMap((evidence) =>
                    evidence.decision === "accepted"
                      ? [evidence.evidenceId]
                      : [],
                  ),
                ),
              ),
            ),
          );
          const selectorEvidenceById = new Map<string, MemoryEvidence>();
          selectorInput.evidence.forEach((evidence, index) => {
            if (selectorEvidenceById.has(evidence.id)) {
              context.addIssue({
                code: "custom",
                message: "Selector audit evidence ids must be unique",
                path: ["selectorAuditInput", "evidence", index, "id"],
              });
            }
            if (!selectorMemoryIds.has(evidence.memoryId)) {
              context.addIssue({
                code: "custom",
                message:
                  "Selector audit evidence must reference a frozen audit memory",
                path: ["selectorAuditInput", "evidence", index, "memoryId"],
              });
            }
            if (evidence.contextSummary !== undefined) {
              context.addIssue({
                code: "custom",
                message:
                  "Selector audit evidence cannot persist unverified context summaries",
                path: [
                  "selectorAuditInput",
                  "evidence",
                  index,
                  "contextSummary",
                ],
              });
            }
            if (
              !acceptedSelectorEvidenceIds.has(evidence.id) &&
              evidence.quote !== undefined
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "Rejected selector evidence cannot persist unverified quote text",
                path: ["selectorAuditInput", "evidence", index, "quote"],
              });
            }
            selectorEvidenceById.set(evidence.id, evidence);
            const replayEvidence = replayEvidenceById.get(evidence.id);
            if (
              replayEvidence !== undefined &&
              JSON.stringify(replayEvidence) !== JSON.stringify(evidence)
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "Overlapping replay and selector evidence must be identical",
                path: ["selectorAuditInput", "evidence", index],
              });
            }
          });
          const auditedMemoryIds = new Set<string>();
          const auditedEvidenceIds = new Set<string>();
          const valueKeyByGroupByFacet = Array.from(
            { length: selectorAudit.expectedFacetCount },
            () => new Map<string, string>(),
          );
          const groupByValueKeyByFacet = Array.from(
            { length: selectorAudit.expectedFacetCount },
            () => new Map<string, string>(),
          );
          const memoryIdsByValueKeyByFacet = Array.from(
            { length: selectorAudit.expectedFacetCount },
            () => new Map<string, Set<string>>(),
          );
          const candidatePoolScanTiers = new Set<
            "event_card" | "basic_memory"
          >();
          selectorAudit.attempts.forEach((attempt, attemptIndex) => {
            const attemptedMemoryIds = new Set(
              attempt.facets[0]?.candidates.map(
                (candidate) => candidate.memoryId,
              ) ?? [],
            );
            const frozenTierMemoryIds = new Set(
              selectorInput.candidateTiers.flatMap((candidate) =>
                candidate.tier === attempt.tier ? [candidate.memoryId] : [],
              ),
            );
            if (
              attempt.outcome === "scan_truncated" &&
              attempt.scanUnit === "candidate_pool"
            ) {
              candidatePoolScanTiers.add(attempt.tier);
              if (
                attempt.scanWitnessMemoryId === undefined ||
                !frozenTierMemoryIds.has(attempt.scanWitnessMemoryId) ||
                attemptedMemoryIds.has(attempt.scanWitnessMemoryId) ||
                frozenTierMemoryIds.size !== attempt.scannedCandidateCount + 1
              ) {
                context.addIssue({
                  code: "custom",
                  message:
                    "A truncated candidate scan must freeze its complete prefix and one distinct overflow witness",
                  path: ["selectorAuditInput", "candidateTiers"],
                });
              }
            } else if (
              !sameStringSet([...attemptedMemoryIds], [...frozenTierMemoryIds])
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "Each selector attempt must exactly match its frozen tier candidate pool",
                path: [
                  "hierarchy",
                  "selectorAudit",
                  "attempts",
                  attemptIndex,
                  "facets",
                ],
              });
            }
            attempt.facets.forEach((facet, facetIndex) => {
              facet.candidates.forEach((candidate, candidateIndex) => {
                auditedMemoryIds.add(candidate.memoryId);
                const frozenMemory = selectorMemoryById.get(candidate.memoryId);
                let resolvedCandidateValueKey: string | undefined;
                if (frozenMemory === undefined) {
                  context.addIssue({
                    code: "custom",
                    message:
                      "Fact audit candidates must reference frozen audit memories",
                    path: [
                      "hierarchy",
                      "selectorAudit",
                      "attempts",
                      attemptIndex,
                      "facets",
                      facetIndex,
                      "candidates",
                      candidateIndex,
                      "memoryId",
                    ],
                  });
                } else if (!(
                  attempt.outcome === "scan_truncated" &&
                  attempt.scanUnit === "evidence_per_memory"
                )) {
                  const expectedIneligibilityReason =
                    frozenFactMemoryIneligibilityReason(
                      frozenMemory,
                      attempt.tier,
                      snapshot.nowUtc,
                      snapshot.query.timeRange,
                    );
                  const deterministicReasonCodes =
                    new Set<ExplicitFactSelectorCandidateReason>([
                      "fact_candidate_future",
                      "fact_candidate_lifecycle_ineligible",
                      "fact_candidate_low_reliability",
                      "fact_candidate_not_active",
                      "fact_candidate_not_explicit",
                      "fact_candidate_not_stable",
                      "fact_candidate_not_user_attributed",
                      "fact_candidate_outside_time_range",
                    ]);
                  if (
                    candidate.reasonCode !== expectedIneligibilityReason &&
                    (expectedIneligibilityReason !== undefined ||
                      deterministicReasonCodes.has(candidate.reasonCode))
                  ) {
                    context.addIssue({
                      code: "custom",
                      message:
                        "Fact candidate eligibility reasons must match the frozen memory state",
                      path: [
                        "hierarchy",
                        "selectorAudit",
                        "attempts",
                        attemptIndex,
                        "facets",
                        facetIndex,
                        "candidates",
                        candidateIndex,
                        "reasonCode",
                      ],
                    });
                  }
                  if (expectedIneligibilityReason === undefined) {
                    const valueResolution = explicitFactValueResolution(
                      frozenMemory.content,
                      facet.request,
                    );
                    const requiresResolvedValue =
                      candidate.valueGroupId !== undefined ||
                      candidate.reasonCode ===
                        "fact_candidate_evidence_not_verified" ||
                      candidate.reasonCode ===
                        "fact_candidate_evidence_conflicted";
                    if (
                      (requiresResolvedValue &&
                        valueResolution.kind !== "resolved") ||
                      (candidate.reasonCode ===
                        "fact_candidate_value_unparseable" &&
                        valueResolution.kind !== "none") ||
                      (candidate.reasonCode ===
                        "fact_candidate_value_conflicted" &&
                        valueResolution.kind !== "conflicted")
                    ) {
                      context.addIssue({
                        code: "custom",
                        message:
                          "Fact candidate value decisions must match the frozen memory content",
                        path: [
                          "hierarchy",
                          "selectorAudit",
                          "attempts",
                          attemptIndex,
                          "facets",
                          facetIndex,
                          "candidates",
                          candidateIndex,
                          "reasonCode",
                        ],
                      });
                    }
                    if (valueResolution.kind === "resolved") {
                      resolvedCandidateValueKey = valueResolution.valueKey;
                    }
                    if (
                      candidate.valueGroupId !== undefined &&
                      valueResolution.kind === "resolved"
                    ) {
                      const valueKeyByGroup =
                        valueKeyByGroupByFacet[facetIndex]!;
                      const groupByValueKey =
                        groupByValueKeyByFacet[facetIndex]!;
                      const previousValueKey = valueKeyByGroup.get(
                        candidate.valueGroupId,
                      );
                      const previousGroup = groupByValueKey.get(
                        valueResolution.valueKey,
                      );
                      if (
                        (previousValueKey !== undefined &&
                          previousValueKey !== valueResolution.valueKey) ||
                        (previousGroup !== undefined &&
                          previousGroup !== candidate.valueGroupId)
                      ) {
                        context.addIssue({
                          code: "custom",
                          message:
                            "Fact value groups must map one-to-one to canonical frozen values",
                          path: [
                            "hierarchy",
                            "selectorAudit",
                            "attempts",
                            attemptIndex,
                            "facets",
                            facetIndex,
                            "candidates",
                            candidateIndex,
                            "valueGroupId",
                          ],
                        });
                      }
                      valueKeyByGroup.set(
                        candidate.valueGroupId,
                        valueResolution.valueKey,
                      );
                      groupByValueKey.set(
                        valueResolution.valueKey,
                        candidate.valueGroupId,
                      );
                      const memoryIdsByValueKey =
                        memoryIdsByValueKeyByFacet[facetIndex]!;
                      const groupedMemoryIds =
                        memoryIdsByValueKey.get(valueResolution.valueKey) ??
                        new Set<string>();
                      groupedMemoryIds.add(candidate.memoryId);
                      memoryIdsByValueKey.set(
                        valueResolution.valueKey,
                        groupedMemoryIds,
                      );
                    }
                  }
                }
                if (
                  selectorTierByMemoryId.get(candidate.memoryId) !==
                  attempt.tier
                ) {
                  context.addIssue({
                    code: "custom",
                    message:
                      "Fact audit candidates must belong to their frozen attempt tier",
                    path: [
                      "hierarchy",
                      "selectorAudit",
                      "attempts",
                      attemptIndex,
                      "facets",
                      facetIndex,
                      "candidates",
                      candidateIndex,
                      "memoryId",
                    ],
                  });
                }
                candidate.evidence.forEach((evidence, evidenceIndex) => {
                  auditedEvidenceIds.add(evidence.evidenceId);
                  const frozen = selectorEvidenceById.get(evidence.evidenceId);
                  if (
                    frozen === undefined ||
                    frozen.memoryId !== candidate.memoryId
                  ) {
                    context.addIssue({
                      code: "custom",
                      message:
                        "Fact audit evidence must reference frozen evidence for its candidate",
                      path: [
                        "hierarchy",
                        "selectorAudit",
                        "attempts",
                        attemptIndex,
                        "facets",
                        facetIndex,
                        "candidates",
                        candidateIndex,
                        "evidence",
                        evidenceIndex,
                        "evidenceId",
                      ],
                    });
                  } else {
                    const evidenceRecordedInFuture =
                      Date.parse(frozen.recordedAtUtc) >
                      Date.parse(snapshot.nowUtc);
                    if (
                      (frozen.sourceType !== "message" &&
                        evidence.reasonCode !==
                          "fact_evidence_unsupported_source") ||
                      (frozen.sourceType === "message" &&
                        evidence.reasonCode ===
                          "fact_evidence_unsupported_source") ||
                      (frozen.sourceType === "message" &&
                        evidenceRecordedInFuture &&
                        evidence.reasonCode !== "fact_evidence_future")
                    ) {
                      context.addIssue({
                        code: "custom",
                        message:
                          "Fact evidence reasons must match deterministic frozen source metadata",
                        path: [
                          "hierarchy",
                          "selectorAudit",
                          "attempts",
                          attemptIndex,
                          "facets",
                          facetIndex,
                          "candidates",
                          candidateIndex,
                          "evidence",
                          evidenceIndex,
                          "reasonCode",
                        ],
                      });
                    }
                    if (
                      evidence.decision === "accepted" &&
                      (frozen.sourceType !== "message" ||
                        evidenceRecordedInFuture ||
                        frozen.quote === undefined)
                    ) {
                      context.addIssue({
                        code: "custom",
                        message:
                          "Accepted fact evidence requires a present-tense message source snapshot",
                        path: ["selectorAuditInput", "evidence", evidenceIndex],
                      });
                    }
                    if (
                      evidence.decision === "accepted" &&
                      frozen.quote !== undefined
                    ) {
                      const sourceValue = explicitFactValueResolution(
                        frozen.quote,
                        facet.request,
                      );
                      if (
                        !isFactBearingUserStatement(frozen.quote) ||
                        sourceValue.kind !== "resolved" ||
                        resolvedCandidateValueKey === undefined ||
                        sourceValue.valueKey !== resolvedCandidateValueKey
                      ) {
                        context.addIssue({
                          code: "custom",
                          message:
                            "Accepted fact evidence must assert the candidate's canonical frozen value",
                          path: [
                            "hierarchy",
                            "selectorAudit",
                            "attempts",
                            attemptIndex,
                            "facets",
                            facetIndex,
                            "candidates",
                            candidateIndex,
                            "evidence",
                            evidenceIndex,
                          ],
                        });
                      }
                    }
                  }
                });
              });
              const winnerReasonCodes =
                new Set<ExplicitFactSelectorCandidateReason>([
                  "fact_candidate_selected",
                  "fact_candidate_provisional_winner",
                  "fact_candidate_rejected_due_atomic_conflict",
                  "fact_candidate_rejected_due_higher_tier_failure",
                  "fact_candidate_rejected_due_scan_truncation",
                ]);
              const declaredWinners = facet.candidates.filter((candidate) =>
                winnerReasonCodes.has(candidate.reasonCode),
              );
              if (declaredWinners.length > 0) {
                const rankedMatches = facet.candidates
                  .flatMap((candidate) => {
                    if (candidate.valueGroupId === undefined) return [];
                    const memory = selectorMemoryById.get(candidate.memoryId);
                    return memory === undefined
                      ? []
                      : [
                          {
                            memoryId: candidate.memoryId,
                            score: explicitFactCandidateScore(
                              memory,
                              facet.request,
                            ),
                            confidence: memory.confidence,
                          },
                        ];
                  })
                  .sort(
                    (left, right) =>
                      right.score - left.score ||
                      right.confidence - left.confidence ||
                      left.memoryId.localeCompare(right.memoryId),
                  );
                if (
                  declaredWinners.length !== 1 ||
                  declaredWinners[0]?.memoryId !== rankedMatches[0]?.memoryId
                ) {
                  context.addIssue({
                    code: "custom",
                    message:
                      "Fact winner decisions must follow the deterministic facet ranking",
                    path: [
                      "hierarchy",
                      "selectorAudit",
                      "attempts",
                      attemptIndex,
                      "facets",
                      facetIndex,
                      "candidates",
                    ],
                  });
                }
              }
            });
          });
          memoryIdsByValueKeyByFacet.forEach(
            (memoryIdsByValueKey, facetIndex) => {
              const orderedValueKeys = [...memoryIdsByValueKey.entries()]
                .map(([valueKey, memoryIds]) => ({
                  valueKey,
                  firstMemoryId: [...memoryIds].sort()[0] ?? "",
                }))
                .sort((left, right) =>
                  left.firstMemoryId.localeCompare(right.firstMemoryId),
                );
              orderedValueKeys.forEach(({ valueKey }, index) => {
                if (
                  groupByValueKeyByFacet[facetIndex]?.get(valueKey) !==
                  `value_${index + 1}`
                ) {
                  context.addIssue({
                    code: "custom",
                    message:
                      "Fact value groups must use deterministic canonical numbering",
                    path: [
                      "hierarchy",
                      "selectorAudit",
                      "attempts",
                      0,
                      "facets",
                      facetIndex,
                      "candidates",
                    ],
                  });
                }
              });
            },
          );
          selectorAudit.attempts.forEach((attempt, attemptIndex) => {
            if (
              attempt.outcome === "below_threshold" &&
              snapshot.query.minimumScore === undefined
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "A caller-threshold rejection requires an explicit query minimum score",
                path: [
                  "hierarchy",
                  "selectorAudit",
                  "attempts",
                  attemptIndex,
                  "outcome",
                ],
              });
            }
            const hasProvisionalWinnerForEveryFacet = attempt.facets.every(
              (facet) =>
                facet.candidates.filter(
                  (candidate) =>
                    candidate.reasonCode ===
                    "fact_candidate_provisional_winner",
                ).length === 1,
            );
            if (
              attempt.outcome !== "capacity_insufficient" &&
              attempt.outcome !== "below_threshold" &&
              !(
                attempt.outcome === "incomplete" &&
                hasProvisionalWinnerForEveryFacet
              )
            ) {
              return;
            }
            const minimalEvidenceIds = minimalFactEvidenceIdsForReason(
              attempt,
              snapshot.maxEvidence,
              "fact_candidate_provisional_winner",
            );
            const capacityDecisionMatches =
              attempt.outcome === "capacity_insufficient"
                ? minimalEvidenceIds === undefined
                : minimalEvidenceIds !== undefined;
            if (!capacityDecisionMatches) {
              context.addIssue({
                code: "custom",
                message:
                  "Fact capacity outcomes must match the frozen provisional evidence coverage",
                path: [
                  "hierarchy",
                  "selectorAudit",
                  "attempts",
                  attemptIndex,
                  "outcome",
                ],
              });
            }
          });
          const expectedSelectorMemoryIds = new Set(auditedMemoryIds);
          selectorInput.candidateTiers.forEach((candidate) => {
            if (candidatePoolScanTiers.has(candidate.tier)) {
              expectedSelectorMemoryIds.add(candidate.memoryId);
            }
          });
          if (
            !sameStringSet(
              [...expectedSelectorMemoryIds],
              [...selectorMemoryIds],
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "Frozen selector audit memories must exactly match audited candidates",
              path: ["selectorAuditInput", "memories"],
            });
          }
          if (
            !sameStringSet(
              [...auditedEvidenceIds],
              [...selectorEvidenceById.keys()],
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "Frozen selector audit evidence must exactly match audited evidence",
              path: ["selectorAuditInput", "evidence"],
            });
          }
          if (
            selectorAudit.replayEvidenceIds === undefined ||
            !sameStringSet(
              selectorAudit.replayEvidenceIds,
              snapshot.evidence.map((evidence) => evidence.id),
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "Fact replay evidence must exactly match the producer-selected audit evidence",
              path: ["hierarchy", "selectorAudit", "replayEvidenceIds"],
            });
          } else if (
            selectorAudit.replayEvidenceIds.some(
              (evidenceId) =>
                auditedEvidenceIds.has(evidenceId) &&
                !acceptedSelectorEvidenceIds.has(evidenceId),
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "Fact replay evidence cannot use an audited rejected source",
              path: ["hierarchy", "selectorAudit", "replayEvidenceIds"],
            });
          }
          const truncatedMemoryIds = selectorAudit.attempts.flatMap(
            (attempt) => attempt.truncatedMemoryIds ?? [],
          );
          if (
            truncatedMemoryIds.some(
              (memoryId) => !selectorMemoryIds.has(memoryId),
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "Truncated evidence scans must reference frozen selector memories",
              path: ["hierarchy", "selectorAudit", "attempts"],
            });
          }
          if (
            [...memoryIds].some((memoryId) => !selectorMemoryIds.has(memoryId))
          ) {
            context.addIssue({
              code: "custom",
              message:
                "Replay fact memories must come from frozen selector inputs",
              path: ["memories"],
            });
          }
          const scanWitnessMemoryIds = new Set(
            selectorAudit.attempts.flatMap((attempt) =>
              attempt.scanWitnessMemoryId === undefined
                ? []
                : [attempt.scanWitnessMemoryId],
            ),
          );
          if (
            [...memoryIds].some((memoryId) =>
              scanWitnessMemoryIds.has(memoryId),
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "A scan overflow witness cannot enter the replay candidate pool",
              path: ["memories"],
            });
          }
          const hasTruncatedAttempt = selectorAudit.attempts.some(
            (attempt) => attempt.outcome === "scan_truncated",
          );
          const matchedAuditMemoryIds = new Set(
            selectorAudit.attempts.flatMap((attempt) =>
              attempt.facets.flatMap((facet) =>
                facet.candidates.flatMap((candidate) =>
                  candidate.valueGroupId === undefined
                    ? []
                    : [candidate.memoryId],
                ),
              ),
            ),
          );
          if (
            !hasTruncatedAttempt &&
            [...memoryIds].some(
              (memoryId) => !matchedAuditMemoryIds.has(memoryId),
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "A non-truncated fact replay may contain only matched audit candidates",
              path: ["memories"],
            });
          }
          const evidenceScanAttempt = selectorAudit.attempts.find(
            (attempt) =>
              attempt.outcome === "scan_truncated" &&
              attempt.scanUnit === "evidence_per_memory",
          );
          if (
            evidenceScanAttempt !== undefined &&
            !sameStringSet(
              [...memoryIds],
              evidenceScanAttempt.truncatedMemoryIds ?? [],
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "A truncated evidence scan must replay exactly its affected Basic memories",
              path: ["memories"],
            });
          }
          const basicCandidatePoolScan = selectorAudit.attempts.find(
            (attempt) =>
              attempt.tier === "basic_memory" &&
              attempt.outcome === "scan_truncated" &&
              attempt.scanUnit === "candidate_pool",
          );
          const eventCandidatePoolScan = selectorAudit.attempts.find(
            (attempt) =>
              attempt.tier === "event_card" &&
              attempt.outcome === "scan_truncated" &&
              attempt.scanUnit === "candidate_pool",
          );
          const requiredScanReplayTier =
            evidenceScanAttempt !== undefined ||
            basicCandidatePoolScan !== undefined
              ? "basic_memory"
              : eventCandidatePoolScan !== undefined
                ? "event_card"
                : undefined;
          if (
            requiredScanReplayTier !== undefined &&
            [...memoryIds].some(
              (memoryId) =>
                hierarchyTierByMemoryId.get(memoryId) !==
                requiredScanReplayTier,
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "A truncated fact scan must replay the tier whose diagnostics were prepared",
              path: ["hierarchy", "candidateTiers"],
            });
          }
          if (
            basicCandidatePoolScan !== undefined &&
            memoryIds.size !== snapshot.candidateLimit
          ) {
            context.addIssue({
              code: "custom",
              message:
                "A truncated Basic candidate scan must replay the caller-sized diagnostic prefix",
              path: ["memories"],
            });
          }
          if (
            evidenceScanAttempt === undefined &&
            basicCandidatePoolScan === undefined &&
            eventCandidatePoolScan !== undefined
          ) {
            const eligibleEventPrefixIds = new Set(
              selectorInput.candidateTiers.flatMap((candidate) => {
                if (
                  candidate.tier !== "event_card" ||
                  candidate.memoryId ===
                    eventCandidatePoolScan.scanWitnessMemoryId
                ) {
                  return [];
                }
                const memory = selectorMemoryById.get(candidate.memoryId);
                return memory !== undefined &&
                  frozenEventCardOccursInRange(memory, snapshot.query.timeRange)
                  ? [candidate.memoryId]
                  : [];
              }),
            );
            const expectedEventReplayCount = Math.min(
              snapshot.candidateLimit,
              eligibleEventPrefixIds.size,
            );
            if (
              memoryIds.size !== expectedEventReplayCount ||
              [...memoryIds].some(
                (memoryId) => !eligibleEventPrefixIds.has(memoryId),
              )
            ) {
              context.addIssue({
                code: "custom",
                message:
                  "A truncated Event candidate scan must replay its in-range diagnostic prefix",
                path: ["memories"],
              });
            }
          }
          if (!hasTruncatedAttempt && selectorAudit.outcome === "conflicted") {
            const expectedConflictMemoryIds = orderedFactDiagnosticMemoryIds(
              selectorAudit.attempts,
              selectorMemoryById,
              snapshot.candidateLimit,
            );
            if (!sameStringSet([...memoryIds], expectedConflictMemoryIds)) {
              context.addIssue({
                code: "custom",
                message:
                  "A conflicted fact replay must exactly match its combined diagnostic candidate pool",
                path: ["memories"],
              });
            }
          }
          const completeNotSelectedAttempt = selectorAudit.attempts.find(
            (attempt) => attempt.outcome === "complete_not_selected",
          );
          if (completeNotSelectedAttempt !== undefined) {
            const blockedWinnerIds = [
              ...new Set(
                completeNotSelectedAttempt.facets.flatMap((facet) =>
                  facet.candidates.flatMap((candidate) =>
                    candidate.reasonCode ===
                    "fact_candidate_rejected_due_higher_tier_failure"
                      ? [candidate.memoryId]
                      : [],
                  ),
                ),
              ),
            ];
            if (!sameStringSet([...memoryIds], blockedWinnerIds)) {
              context.addIssue({
                code: "custom",
                message:
                  "A complete blocked Basic attempt must replay exactly its provisional winners",
                path: ["memories"],
              });
            }
          }
          if (
            !hasTruncatedAttempt &&
            selectorAudit.outcome !== "selected" &&
            selectorAudit.outcome !== "conflicted" &&
            completeNotSelectedAttempt === undefined
          ) {
            const basicAttempt = selectorAudit.attempts.find(
              (attempt) => attempt.tier === "basic_memory",
            );
            const provisionalWinnerIds =
              basicAttempt === undefined
                ? []
                : orderedFactReasonMemoryIds(
                    basicAttempt,
                    "fact_candidate_provisional_winner",
                  ).slice(0, snapshot.candidateLimit);
            const expectedBasicMemoryIds =
              basicAttempt === undefined
                ? []
                : provisionalWinnerIds.length > 0
                  ? provisionalWinnerIds
                  : orderedFactDiagnosticMemoryIds(
                      [basicAttempt],
                      selectorMemoryById,
                      snapshot.candidateLimit,
                    );
            if (!sameStringSet([...memoryIds], expectedBasicMemoryIds)) {
              context.addIssue({
                code: "custom",
                message:
                  "A rejected fact replay must exactly match its Basic diagnostic candidate pool",
                path: ["memories"],
              });
            }
          }
          if (
            !hasTruncatedAttempt &&
            selectorAudit.outcome !== "selected" &&
            selectorAudit.outcome !== "conflicted" &&
            completeNotSelectedAttempt === undefined &&
            [...memoryIds].some(
              (memoryId) =>
                hierarchyTierByMemoryId.get(memoryId) !== "basic_memory",
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "A completed rejected fact hierarchy must replay its Basic fallback diagnostics",
              path: ["hierarchy", "candidateTiers"],
            });
          }
        }
        const expectedAbstentionReason =
          selectorAudit.outcome === "selected"
            ? undefined
            : {
                incomplete: "requested_fact_facets_incomplete",
                conflicted: "requested_fact_facets_conflicted",
                below_threshold: "requested_fact_below_caller_threshold",
                capacity_insufficient:
                  "requested_fact_evidence_capacity_insufficient",
                scan_truncated: "requested_fact_scan_truncated",
              }[selectorAudit.outcome];
        if (snapshot.hierarchy.abstentionReason !== expectedAbstentionReason) {
          context.addIssue({
            code: "custom",
            message:
              "Fact selector outcome must match the hierarchy abstention reason",
            path: ["hierarchy", "abstentionReason"],
          });
        }
        const selectedAttempts = selectorAudit.attempts.filter(
          (attempt) => attempt.outcome === "selected",
        );
        const selectedCandidates = selectorAudit.attempts.flatMap((attempt) =>
          attempt.facets.flatMap((facet) =>
            facet.candidates.filter(
              (candidate) => candidate.decision === "selected",
            ),
          ),
        );
        if (selectorAudit.outcome === "selected") {
          const selectedAttempt = selectedAttempts[0];
          if (
            finalTier === "none" ||
            selectedAttempts.length !== 1 ||
            selectedAttempt?.tier !== finalTier ||
            selectedAttempt.facets.some(
              (facet) =>
                facet.outcome !== "selected" ||
                facet.candidates.filter(
                  (candidate) => candidate.decision === "selected",
                ).length !== 1,
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "A selected fact audit requires one complete final-tier attempt",
              path: ["hierarchy", "selectorAudit"],
            });
          }
          const selectedMemoryIds = [
            ...new Set(
              selectedCandidates.map((candidate) => candidate.memoryId),
            ),
          ];
          if (!sameStringSet(selectedMemoryIds, [...memoryIds])) {
            context.addIssue({
              code: "custom",
              message:
                "Selected fact audit candidates must match replay memories",
              path: ["hierarchy", "selectorAudit", "attempts"],
            });
          }
          const acceptedEvidenceIds = [
            ...new Set(
              selectedCandidates.flatMap((candidate) =>
                candidate.evidence
                  .filter((evidence) => evidence.decision === "accepted")
                  .map((evidence) => evidence.evidenceId),
              ),
            ),
          ];
          if (
            [...evidenceIds].some(
              (evidenceId) => !acceptedEvidenceIds.includes(evidenceId),
            ) ||
            selectedCandidates.some(
              (candidate) =>
                !candidate.evidence.some(
                  (evidence) =>
                    evidence.decision === "accepted" &&
                    evidenceIds.has(evidence.evidenceId) &&
                    replayEvidenceById.get(evidence.evidenceId)?.memoryId ===
                      candidate.memoryId,
                ),
            )
          ) {
            context.addIssue({
              code: "custom",
              message:
                "Selected fact replay evidence must cover every audited facet",
              path: ["hierarchy", "selectorAudit", "attempts"],
            });
          }
        } else {
          if (finalTier !== "none" || selectedCandidates.length > 0) {
            context.addIssue({
              code: "custom",
              message: "A rejected fact audit cannot select replay candidates",
              path: ["hierarchy", "selectorAudit"],
            });
          }
          if (
            selectorAudit.outcome === "conflicted" &&
            !selectorAudit.attempts.some((attempt) =>
              attempt.facets.some((facet) => facet.outcome === "conflicted"),
            )
          ) {
            context.addIssue({
              code: "custom",
              message: "A conflicted fact audit requires a conflicted facet",
              path: ["hierarchy", "selectorAudit", "outcome"],
            });
          }
        }
      }
    }
  });
export type RetrievalReplayInput = z.infer<typeof RetrievalReplayInputSchema>;

const RetrievalConfigSnapshotSchema = z
  .record(z.string().min(1).max(128), JsonValueSchema)
  .superRefine((snapshot, context) => {
    const sensitivePath = findSensitiveConfigPath(snapshot);
    if (sensitivePath !== undefined) {
      context.addIssue({
        code: "custom",
        message: "Retrieval config snapshots cannot contain secrets",
        path: sensitivePath,
      });
    }
  });

export const RetrievalRunSchema = z
  .object({
    id: EntityIdSchema,
    agentId: EntityIdSchema,
    sessionId: EntityIdSchema.optional(),
    sourceMessageId: EntityIdSchema.optional(),
    inputSnapshot: RetrievalReplayInputSchema,
    stages: RetrievalRunStagesSchema,
    candidates: z.array(RetrievalRunCandidateSchema).max(500),
    result: MemoryRecallResultSchema,
    evidenceBundle: EvidenceBundleSchema.optional(),
    configSnapshot: RetrievalConfigSnapshotSchema,
    renderedPromptFragment: z.string().max(100_000).optional(),
    createdAtUtc: UtcDateTimeSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (run.inputSnapshot.agentId !== run.agentId) {
      context.addIssue({
        code: "custom",
        message: "Replay snapshot agent must match the run agent",
        path: ["inputSnapshot", "agentId"],
      });
    }

    const candidateIds = run.candidates.map((candidate) => candidate.memoryId);
    if (new Set(candidateIds).size !== candidateIds.length) {
      context.addIssue({
        code: "custom",
        message: "Retrieval candidate memory ids must be unique",
        path: ["candidates"],
      });
    }
    const snapshotMemoryIds = run.inputSnapshot.memories.map(
      (memory) => memory.id,
    );
    if (!sameStringSet(candidateIds, snapshotMemoryIds)) {
      context.addIssue({
        code: "custom",
        message: "Candidates must cover every snapshotted memory exactly once",
        path: ["candidates"],
      });
    }
    if (run.inputSnapshot.memories.length > run.inputSnapshot.candidateLimit) {
      context.addIssue({
        code: "custom",
        message: "Replay memories cannot exceed candidateLimit",
        path: ["inputSnapshot", "memories"],
      });
    }
    const evidenceById = new Map(
      run.inputSnapshot.evidence.map((evidence) => [evidence.id, evidence]),
    );
    run.candidates.forEach((candidate, index) => {
      if (
        candidate.evidenceIds.some(
          (id) => evidenceById.get(id)?.memoryId !== candidate.memoryId,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "Candidate evidence must reference the same memory",
          path: ["candidates", index, "evidenceIds"],
        });
      }
    });
    const selected = run.candidates.filter(
      (candidate) => candidate.decision === "selected",
    );
    const ranks = selected.flatMap((candidate) =>
      candidate.selectionRank === undefined ? [] : [candidate.selectionRank],
    );
    if (new Set(ranks).size !== ranks.length) {
      context.addIssue({
        code: "custom",
        message: "Selected candidate ranks must be unique",
        path: ["candidates"],
      });
    }
    if (
      !sameStringSet(
        selected.map((candidate) => candidate.memoryId),
        run.result.selectedMemoryIds,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Selected candidates must match the recall result",
        path: ["candidates"],
      });
    }

    const hierarchy = run.inputSnapshot.hierarchy;
    if (hierarchy !== undefined) {
      if ((hierarchy.finalTier === "none") !== run.result.abstained) {
        context.addIssue({
          code: "custom",
          message: "Recall result abstention must match the hierarchy outcome",
          path: ["result", "abstained"],
        });
      } else if (run.result.abstained) {
        if (
          run.result.abstentionReason !== hierarchy.abstentionReason ||
          run.result.score !== hierarchy.abstentionScore
        ) {
          context.addIssue({
            code: "custom",
            message:
              "Recall result abstention must match the frozen hierarchy replay",
            path: ["result", "abstentionReason"],
          });
        }
      } else if (run.result.mode !== hierarchy.finalTier) {
        context.addIssue({
          code: "custom",
          message: "Recall result mode must match the final hierarchy tier",
          path: ["result", "mode"],
        });
      }
    }

    if (run.result.abstained) {
      if (run.evidenceBundle !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Abstained runs cannot contain an EvidenceBundle",
          path: ["evidenceBundle"],
        });
      }
      return;
    }
    const memoryById = new Map(
      run.inputSnapshot.memories.map((memory) => [memory.id, memory]),
    );
    const selectedCandidateById = new Map(
      selected.map((candidate) => [candidate.memoryId, candidate]),
    );
    if (hierarchy !== undefined && hierarchy.finalTier !== "none") {
      const tierByMemoryId = new Map(
        hierarchy.candidateTiers.map((candidate) => [
          candidate.memoryId,
          candidate.tier,
        ]),
      );
      if (
        run.result.selectedMemoryIds.some(
          (memoryId) => tierByMemoryId.get(memoryId) !== hierarchy.finalTier,
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Every selected result memory must belong to the final hierarchy tier",
          path: ["result", "selectedMemoryIds"],
        });
      }
    }
    const selectorAudit = hierarchy?.selectorAudit;
    if (selectorAudit?.outcome === "selected") {
      const selectedAttempt = selectorAudit.attempts.find(
        (attempt) => attempt.outcome === "selected",
      );
      const auditedSelectedCandidates = selectorAudit.attempts.flatMap(
        (attempt) =>
          attempt.facets.flatMap((facet) =>
            facet.candidates.filter(
              (candidate) => candidate.decision === "selected",
            ),
          ),
      );
      const auditedSelectedMemoryIds = [
        ...new Set(
          auditedSelectedCandidates.map((candidate) => candidate.memoryId),
        ),
      ];
      if (
        !sameStringSet(auditedSelectedMemoryIds, run.result.selectedMemoryIds)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Selected selector audit memories must exactly match the recall result",
          path: ["result", "selectedMemoryIds"],
        });
      }
      const resultEvidenceIds = new Set(run.result.selectedEvidenceIds);
      const expectedMinimalEvidenceIds =
        selectedAttempt === undefined
          ? undefined
          : minimalFactEvidenceIdsFromAudit(
              selectedAttempt,
              run.inputSnapshot.maxEvidence,
            );
      const acceptedAuditEvidenceIds = new Set(
        auditedSelectedCandidates.flatMap((candidate) =>
          candidate.evidence.flatMap((evidence) =>
            evidence.decision === "accepted" ? [evidence.evidenceId] : [],
          ),
        ),
      );
      if (
        !sameStringSet(
          [...resultEvidenceIds],
          run.inputSnapshot.evidence.map((evidence) => evidence.id),
        ) ||
        [...resultEvidenceIds].some(
          (evidenceId) => !acceptedAuditEvidenceIds.has(evidenceId),
        ) ||
        expectedMinimalEvidenceIds === undefined ||
        !sameStringSet([...resultEvidenceIds], expectedMinimalEvidenceIds) ||
        auditedSelectedCandidates.some(
          (candidate) =>
            !candidate.evidence.some(
              (evidence) =>
                evidence.decision === "accepted" &&
                resultEvidenceIds.has(evidence.evidenceId),
            ),
        )
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Selected selector result evidence must exactly cover every audited facet",
          path: ["result", "selectedEvidenceIds"],
        });
      }
    }
    if (run.result.evidenceBundle.query !== run.inputSnapshot.query.query) {
      context.addIssue({
        code: "custom",
        message: "Recall result query must match the frozen replay query",
        path: ["result", "evidenceBundle", "query"],
      });
    }
    if (run.result.evidenceBundle.generatedAtUtc !== run.inputSnapshot.nowUtc) {
      context.addIssue({
        code: "custom",
        message: "Recall result time must match the frozen replay time",
        path: ["result", "evidenceBundle", "generatedAtUtc"],
      });
    }
    run.result.evidenceBundle.evidence.forEach((item, index) => {
      const path = ["result", "evidenceBundle", "evidence", index] as const;
      const memory = memoryById.get(item.memoryId);
      const evidence = evidenceById.get(item.evidence.id);
      const candidate = selectedCandidateById.get(item.memoryId);
      if (memory === undefined) {
        context.addIssue({
          code: "custom",
          message: "Recall result memory must exist in the frozen replay input",
          path: [...path, "memoryId"],
        });
      }
      if (evidence === undefined) {
        context.addIssue({
          code: "custom",
          message:
            "Recall result evidence must exist in the frozen replay input",
          path: [...path, "evidence", "id"],
        });
      }
      if (candidate === undefined) {
        context.addIssue({
          code: "custom",
          message: "Recall result memory must be a selected candidate",
          path: [...path, "memoryId"],
        });
      } else if (!candidate.evidenceIds.includes(item.evidence.id)) {
        context.addIssue({
          code: "custom",
          message:
            "Recall result evidence must belong to the selected candidate",
          path: [...path, "evidence", "id"],
        });
      }
      if (evidence !== undefined) {
        if (evidence.memoryId !== item.memoryId) {
          context.addIssue({
            code: "custom",
            message: "Recall result evidence must reference its result memory",
            path: [...path, "evidence", "memoryId"],
          });
        }
        if (JSON.stringify(evidence) !== JSON.stringify(item.evidence)) {
          context.addIssue({
            code: "custom",
            message:
              "Recall result evidence must exactly match frozen evidence",
            path: [...path, "evidence"],
          });
        }
      }
      if (memory === undefined) return;
      const projections = [
        ["memoryContent", memory.content, item.memoryContent],
        ["memoryKind", memory.kind, item.memoryKind],
        ["namespace", recallMemoryNamespace(memory), item.namespace],
        ["certainty", memory.certainty ?? "inferred", item.certainty],
        ["stability", memory.stability ?? "situational", item.stability],
      ] as const;
      for (const [field, expected, actual] of projections) {
        if (expected === actual) continue;
        context.addIssue({
          code: "custom",
          message: `Recall result ${field} must match the frozen memory`,
          path: [...path, field],
        });
      }
      if (
        evidence !== undefined &&
        recallMemoryAttribution(memory, evidence) !== item.attribution
      ) {
        context.addIssue({
          code: "custom",
          message: "Recall result attribution must match the frozen inputs",
          path: [...path, "attribution"],
        });
      }
      if (
        JSON.stringify(recallMemoryTemporal(memory)) !==
        JSON.stringify(item.temporalMetadata)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Recall result temporal metadata must match the frozen memory",
          path: [...path, "temporalMetadata"],
        });
      }
    });
    if (
      run.evidenceBundle === undefined ||
      JSON.stringify(run.evidenceBundle) !==
        JSON.stringify(run.result.evidenceBundle)
    ) {
      context.addIssue({
        code: "custom",
        message: "RetrievalRun EvidenceBundle must match the recall result",
        path: ["evidenceBundle"],
      });
    }
  });
export type RetrievalRun = z.infer<typeof RetrievalRunSchema>;

export type CreateRetrievalRunInput = Omit<
  RetrievalRun,
  "id" | "evidenceBundle"
> & {
  id?: string;
};

interface RetrievalRunRow {
  id: string;
  agent_id: string;
  session_id: string | null;
  source_message_id: string | null;
  mode: MemoryRecallResult["mode"];
  candidate_count: number;
  selected_count: number;
  query_json: string;
  input_snapshot_json: string;
  stages_json: string;
  candidates_json: string;
  result_json: string;
  evidence_bundle_json: string | null;
  config_snapshot_json: string;
  rendered_prompt_fragment: string | null;
  created_at_utc: string;
}

export class RetrievalRunRepository {
  constructor(private readonly database: Database) {}

  create(input: CreateRetrievalRunInput): RetrievalRun {
    const result = MemoryRecallResultSchema.parse(input.result);
    const run = RetrievalRunSchema.parse({
      ...input,
      id: input.id ?? createEntityId("retrievalrun"),
      result,
      ...(result.abstained ? {} : { evidenceBundle: result.evidenceBundle }),
    });
    this.database
      .prepare(
        `INSERT INTO retrieval_runs(
          id, agent_id, session_id, source_message_id, mode, candidate_count,
          selected_count, query_json, input_snapshot_json, stages_json,
          candidates_json, result_json, evidence_bundle_json,
          config_snapshot_json, rendered_prompt_fragment, created_at_utc
        ) VALUES (
          @id, @agentId, @sessionId, @sourceMessageId, @mode, @candidateCount,
          @selectedCount, @queryJson, @inputSnapshotJson, @stagesJson,
          @candidatesJson, @resultJson, @evidenceBundleJson,
          @configSnapshotJson, @renderedPromptFragment, @createdAtUtc
        )`,
      )
      .run(toParameters(run));
    return run;
  }

  findById(id: string): RetrievalRun | undefined {
    const row = this.database
      .prepare("SELECT * FROM retrieval_runs WHERE id = ?")
      .get(id) as RetrievalRunRow | undefined;
    return row === undefined ? undefined : parseRow(row);
  }

  listByAgent(agentId: string, limit = 50): RetrievalRun[] {
    const bounded = boundedLimit(limit);
    return (
      this.database
        .prepare(
          `SELECT * FROM retrieval_runs
           WHERE agent_id = ?
           ORDER BY created_at_utc DESC, rowid DESC
           LIMIT ?`,
        )
        .all(agentId, bounded) as RetrievalRunRow[]
    ).map(parseRow);
  }

  getReplayInput(id: string): RetrievalReplayInput | undefined {
    const row = this.database
      .prepare("SELECT input_snapshot_json FROM retrieval_runs WHERE id = ?")
      .get(id) as { input_snapshot_json: string } | undefined;
    return row === undefined
      ? undefined
      : RetrievalReplayInputSchema.parse(
          JSON.parse(row.input_snapshot_json) as unknown,
        );
  }
}

function toParameters(run: RetrievalRun): Record<string, unknown> {
  return {
    id: run.id,
    agentId: run.agentId,
    sessionId: run.sessionId ?? null,
    sourceMessageId: run.sourceMessageId ?? null,
    mode: run.result.mode,
    candidateCount: run.candidates.length,
    selectedCount: run.result.selectedMemoryIds.length,
    queryJson: JSON.stringify(run.inputSnapshot.query),
    inputSnapshotJson: JSON.stringify(run.inputSnapshot),
    stagesJson: JSON.stringify(run.stages),
    candidatesJson: JSON.stringify(run.candidates),
    resultJson: JSON.stringify(run.result),
    evidenceBundleJson:
      run.evidenceBundle === undefined
        ? null
        : JSON.stringify(run.evidenceBundle),
    configSnapshotJson: JSON.stringify(run.configSnapshot),
    renderedPromptFragment: run.renderedPromptFragment ?? null,
    createdAtUtc: run.createdAtUtc,
  };
}

function parseRow(row: RetrievalRunRow): RetrievalRun {
  const inputSnapshot = RetrievalReplayInputSchema.parse(
    JSON.parse(row.input_snapshot_json) as unknown,
  );
  const query = MemoryRecallQuerySchema.parse(
    JSON.parse(row.query_json) as unknown,
  );
  if (JSON.stringify(query) !== JSON.stringify(inputSnapshot.query)) {
    throw new TypeError(
      "RetrievalRun query column does not match input snapshot",
    );
  }
  const result = MemoryRecallResultSchema.parse(
    JSON.parse(row.result_json) as unknown,
  );
  const run = RetrievalRunSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.source_message_id === null
      ? {}
      : { sourceMessageId: row.source_message_id }),
    inputSnapshot,
    stages: JSON.parse(row.stages_json) as unknown,
    candidates: JSON.parse(row.candidates_json) as unknown,
    result,
    ...(row.evidence_bundle_json === null
      ? {}
      : {
          evidenceBundle: JSON.parse(
            row.evidence_bundle_json,
          ) as EvidenceBundle,
        }),
    configSnapshot: JSON.parse(row.config_snapshot_json) as unknown,
    ...(row.rendered_prompt_fragment === null
      ? {}
      : { renderedPromptFragment: row.rendered_prompt_fragment }),
    createdAtUtc: row.created_at_utc,
  });
  if (
    run.result.mode !== row.mode ||
    run.candidates.length !== row.candidate_count ||
    run.result.selectedMemoryIds.length !== row.selected_count
  ) {
    throw new TypeError("RetrievalRun indexed columns do not match snapshots");
  }
  return run;
}

function recallMemoryNamespace(memory: Memory) {
  if (memory.namespace !== undefined) return memory.namespace;
  if (memory.origin === "canon_extract" || memory.origin === "user_spec") {
    return "canon" as const;
  }
  if ((memory.sourceActivityEventIds?.length ?? 0) > 0) {
    return "runtime_simulation" as const;
  }
  if (memory.kind === "relationship" || memory.kind === "commitment") {
    return "shared_relationship" as const;
  }
  return "character_self" as const;
}

function recallMemoryAttribution(memory: Memory, evidence: MemoryEvidence) {
  if (memory.attribution !== undefined) return memory.attribution;
  if (evidence.sourceType === "activity_event") {
    return "simulation_event" as const;
  }
  if (memory.origin === "model_inference") return "model_inference" as const;
  return "mixed" as const;
}

function recallMemoryTemporal(memory: Memory) {
  const temporal = memory.temporalMetadata ?? memory.temporal;
  if (temporal !== undefined) return temporal;
  if (memory.occurredAtUtc === undefined) return undefined;
  return {
    occurredStartAtUtc: memory.occurredAtUtc,
    recordedAtUtc: memory.updatedAtUtc,
    temporalCertainty: "exact" as const,
    temporalStatus: "occurred" as const,
  };
}

function explicitFactFacetDescriptor(
  facet: ExplicitFactFacetDescriptor,
): ExplicitFactFacetDescriptor {
  return facet.kind === "beverage_preference"
    ? { kind: facet.kind, selector: facet.selector }
    : { kind: facet.kind, entity: facet.entity };
}

function frozenFactMemoryIneligibilityReason(
  memory: Memory,
  tier: "event_card" | "basic_memory",
  nowUtc: string,
  timeRange: MemoryRecallQuery["timeRange"],
): ExplicitFactSelectorCandidateReason | undefined {
  if (memory.status !== "active") return "fact_candidate_not_active";
  if (
    memory.supersededById !== undefined ||
    memory.mergedIntoId !== undefined ||
    memory.claim?.disposition === "cancelled" ||
    memory.claim?.disposition === "completed"
  ) {
    return "fact_candidate_lifecycle_ineligible";
  }
  if (memory.certainty === "uncertain" || memory.confidence < 0.5) {
    return "fact_candidate_low_reliability";
  }
  const recallAt = Date.parse(nowUtc);
  const recordedAt = memory.temporalMetadata?.recordedAtUtc;
  if (
    ![
      memory.createdAtUtc,
      memory.updatedAtUtc,
      memory.lifecycleUpdatedAtUtc,
      memory.lastReinforcedAtUtc,
      recordedAt,
    ]
      .filter((value): value is string => value !== undefined)
      .every((value) => Date.parse(value) <= recallAt)
  ) {
    return "fact_candidate_future";
  }
  if (!frozenFactMemoryMatchesTimeRange(memory, timeRange)) {
    return "fact_candidate_outside_time_range";
  }
  if (tier === "event_card") {
    return memory.certainty === "explicit"
      ? undefined
      : "fact_candidate_not_explicit";
  }
  if (
    memory.kind !== "semantic" ||
    memory.namespace !== "user_model" ||
    memory.certainty !== "explicit" ||
    memory.attribution !== "user_explicit"
  ) {
    return "fact_candidate_not_user_attributed";
  }
  return memory.stability === "stable"
    ? undefined
    : "fact_candidate_not_stable";
}

function frozenFactMemoryMatchesTimeRange(
  memory: Memory,
  range: MemoryRecallQuery["timeRange"],
): boolean {
  if (range === undefined) return true;
  const temporal = memory.temporalMetadata ?? memory.temporal;
  if (temporal === undefined) return false;
  const statuses = new Set(range.statuses ?? [temporal.temporalStatus]);
  let startAtUtc: string | undefined;
  let endAtUtc: string | undefined;
  if (statuses.has("occurred") && temporal.temporalStatus === "occurred") {
    startAtUtc = temporal.occurredStartAtUtc;
    endAtUtc = temporal.occurredEndAtUtc;
  } else if (
    statuses.has("in_progress") &&
    temporal.temporalStatus === "in_progress"
  ) {
    startAtUtc = temporal.occurredStartAtUtc;
  } else if (statuses.has("planned") && temporal.temporalStatus === "planned") {
    startAtUtc = temporal.plannedStartAtUtc;
    endAtUtc = temporal.plannedEndAtUtc;
  } else if (
    statuses.has("cancelled") &&
    temporal.temporalStatus === "cancelled"
  ) {
    startAtUtc = temporal.plannedStartAtUtc;
    endAtUtc = temporal.plannedEndAtUtc;
  }
  if (startAtUtc === undefined) return false;
  const start = Date.parse(startAtUtc);
  const end =
    Date.parse(endAtUtc ?? startAtUtc) + (endAtUtc === undefined ? 1 : 0);
  return start < Date.parse(range.toUtc) && end > Date.parse(range.fromUtc);
}

function frozenEventCardOccursInRange(
  memory: Memory,
  range: MemoryRecallQuery["timeRange"],
): boolean {
  if (range === undefined) return true;
  const temporal = memory.temporalMetadata ?? memory.temporal;
  return (
    temporal?.temporalStatus === "occurred" &&
    temporal.occurredStartAtUtc !== undefined &&
    (temporal.temporalCertainty === "exact" ||
      temporal.temporalCertainty === "date_only") &&
    frozenIntervalsOverlap(
      temporal.occurredStartAtUtc,
      temporal.occurredEndAtUtc,
      range,
    )
  );
}

function frozenIntervalsOverlap(
  startAtUtc: string,
  endAtUtc: string | undefined,
  range: { fromUtc: string; toUtc: string },
): boolean {
  const start = Date.parse(startAtUtc);
  const end =
    Date.parse(endAtUtc ?? startAtUtc) + (endAtUtc === undefined ? 1 : 0);
  return start < Date.parse(range.toUtc) && end > Date.parse(range.fromUtc);
}

function orderedFactReasonMemoryIds(
  attempt: ExplicitFactSelectorAttemptAudit,
  reasonCode: ExplicitFactSelectorCandidateReason,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const facet of attempt.facets) {
    for (const candidate of facet.candidates) {
      if (candidate.reasonCode !== reasonCode || seen.has(candidate.memoryId)) {
        continue;
      }
      seen.add(candidate.memoryId);
      ordered.push(candidate.memoryId);
    }
  }
  return ordered;
}

function orderedFactDiagnosticMemoryIds(
  attempts: readonly ExplicitFactSelectorAttemptAudit[],
  memoryById: ReadonlyMap<string, Memory>,
  candidateLimit: number,
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const facetCount = attempts[0]?.facets.length ?? 0;
  for (let facetIndex = 0; facetIndex < facetCount; facetIndex += 1) {
    for (const attempt of attempts) {
      const facet = attempt.facets[facetIndex];
      if (facet === undefined) continue;
      const ranked = facet.candidates
        .filter((candidate) => candidate.valueGroupId !== undefined)
        .flatMap((candidate) => {
          const memory = memoryById.get(candidate.memoryId);
          return memory === undefined
            ? []
            : [
                {
                  memoryId: candidate.memoryId,
                  score: explicitFactCandidateScore(memory, facet.request),
                },
              ];
        })
        .sort(
          (left, right) =>
            right.score - left.score ||
            left.memoryId.localeCompare(right.memoryId),
        );
      for (const candidate of ranked) {
        if (seen.has(candidate.memoryId)) continue;
        seen.add(candidate.memoryId);
        ordered.push(candidate.memoryId);
        if (ordered.length >= candidateLimit) return ordered;
      }
    }
  }
  return ordered;
}

function minimalFactEvidenceIdsFromAudit(
  attempt: ExplicitFactSelectorAttemptAudit,
  maxEvidence: number,
): string[] | undefined {
  return minimalFactEvidenceIdsFromCandidates(
    attempt,
    maxEvidence,
    (candidate) => candidate.decision === "selected",
  );
}

function minimalFactEvidenceIdsForReason(
  attempt: ExplicitFactSelectorAttemptAudit,
  maxEvidence: number,
  reasonCode: ExplicitFactSelectorCandidateReason,
): string[] | undefined {
  return minimalFactEvidenceIdsFromCandidates(
    attempt,
    maxEvidence,
    (candidate) => candidate.reasonCode === reasonCode,
  );
}

function minimalFactEvidenceIdsFromCandidates(
  attempt: ExplicitFactSelectorAttemptAudit,
  maxEvidence: number,
  isFacetCandidate: (
    candidate: ExplicitFactSelectorAttemptAudit["facets"][number]["candidates"][number],
  ) => boolean,
): string[] | undefined {
  const coverage = new Map<string, Set<number>>();
  attempt.facets.forEach((facet, facetIndex) => {
    const facetCandidate = facet.candidates.find(isFacetCandidate);
    facetCandidate?.evidence.forEach((evidence) => {
      if (evidence.decision !== "accepted") return;
      const facets = coverage.get(evidence.evidenceId) ?? new Set<number>();
      facets.add(facetIndex);
      coverage.set(evidence.evidenceId, facets);
    });
  });
  const uncovered = new Set(
    attempt.facets.map((_facet, facetIndex) => facetIndex),
  );
  const selected: string[] = [];
  while (uncovered.size > 0 && selected.length < maxEvidence) {
    const next = [...coverage.entries()]
      .filter(([evidenceId]) => !selected.includes(evidenceId))
      .map(([evidenceId, facetIndexes]) => ({
        evidenceId,
        facetIndexes,
        newlyCovered: [...facetIndexes].filter((facetIndex) =>
          uncovered.has(facetIndex),
        ).length,
      }))
      .filter((item) => item.newlyCovered > 0)
      .sort(
        (left, right) =>
          right.newlyCovered - left.newlyCovered ||
          left.evidenceId.localeCompare(right.evidenceId),
      )[0];
    if (next === undefined) break;
    selected.push(next.evidenceId);
    next.facetIndexes.forEach((facetIndex) => uncovered.delete(facetIndex));
  }
  return uncovered.size === 0 ? selected : undefined;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function findSensitiveConfigPath(
  value: JsonValue,
  path: Array<string | number> = [],
): Array<string | number> | undefined {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findSensitiveConfigPath(item, [...path, index]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  for (const [key, item] of Object.entries(value)) {
    if (
      /^(?:api[_-]?key|secret|access[_-]?token|password|authorization)$/iu.test(
        key,
      )
    ) {
      return [...path, key];
    }
    const found = findSensitiveConfigPath(item, [...path, key]);
    if (found !== undefined) return found;
  }
  return undefined;
}

function boundedLimit(value: number): number {
  if (!Number.isFinite(value)) {
    throw new TypeError("Retrieval run list limit must be finite");
  }
  return Math.max(1, Math.min(500, Math.trunc(value)));
}
