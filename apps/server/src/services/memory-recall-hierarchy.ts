import { performance } from "node:perf_hooks";

import {
  MemoryEvidenceSchema,
  MemoryRecallPreviewResponseSchema,
  MemoryRecallQuerySchema,
  MemoryRecallResultSchema,
  MemorySchema,
  type ConversationContextPlan,
  type EventCard,
  type JsonValue,
  type Memory,
  type MemoryEvidence,
  type MemoryRecallPreviewRejection,
  type MemoryRecallQuery,
  type MemoryRecallResult,
  type RetrievalScoreBreakdown,
} from "@personasim/contracts";
import {
  recallExactIdentifiers,
  recallCandidateQueries,
  recallMemory,
  stableId,
  type DateDigest,
  type TemporalQueryResolution,
} from "@personasim/features";

import type { DatabaseStore } from "../db/store.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";
import {
  explicitFactCandidateScore,
  explicitFactValueResolution,
  isFactBearingUserStatement,
  isGroundedEvidenceExcerpt,
  parseExplicitFactVerificationRequest,
  type ExplicitFactFacet,
  type ExplicitFactFacetDescriptor,
  type ExplicitFactVerificationParse,
  type ExplicitFactVerificationRequest,
} from "../domain/explicit-fact-verification.js";
import type {
  ExplicitFactSelectorAttemptAudit,
  ExplicitFactSelectorAudit,
  ExplicitFactSelectorCandidateReason,
  ExplicitFactSelectorEvidenceReason,
  ExplicitFactSelectorInputSnapshot,
  RetrievalHierarchySnapshot,
  RetrievalReplayInput,
} from "../repositories/retrieval-run-repository.js";
import {
  temporalAnchorsFromEventCards,
  type ContinuityIndexService,
} from "./continuity-index-service.js";
import type { ArchivedMessage } from "./continuity-repository.js";
import type { DateDigestService } from "./date-digest-service.js";
import type {
  AgentMemoryRecallInput,
  MemoryRecallPreview,
} from "./memory-recall-service.js";
import {
  readExplicitFactMemoryEvidenceScan,
  readMemoryEvidence,
  readRecallCandidateRecords,
  readStableExplicitUserMemoryScan,
} from "./memory-service.js";

const DEFAULT_MINIMUM_SCORE = 0.42;
const DEFAULT_CANONICAL_CLAIM_MINIMUM_SCORE = 0.35;
const DEFAULT_LINKED_CLAIM_MINIMUM_SCORE = 0.2;
const DEFAULT_EXPLICIT_FACT_MINIMUM_SCORE = 0.2;
const EXPLICIT_FACT_SAFETY_SCAN_LIMIT = 500;
const EXPLICIT_FACT_EVIDENCE_SAFETY_SCAN_LIMIT = 100;
const DEFAULT_CANDIDATE_LIMIT = 200;
const DEFAULT_MAX_EVIDENCE = 3;
const MAX_PREVIEW_EVIDENCE_IDS_PER_MEMORY = 20;
const MAX_EXPLICIT_FACT_DIAGNOSTIC_EVIDENCE = 500;

type HierarchyTier =
  "event_card" | "verbatim_quote" | "date_digest" | "basic_memory";

type PreparedRecall = {
  query: MemoryRecallQuery;
  candidateLimit: number;
  maxEvidence: number;
  minimumScore: number;
  memories: Memory[];
  rawEvidence: MemoryEvidence[];
  evidence: MemoryEvidence[];
  evidenceRejections: MemoryRecallPreviewRejection[];
};

type HierarchyCandidate = {
  tier: HierarchyTier;
  memory: Memory;
  evidence: MemoryEvidence[];
};

type PreparedTierSelection = {
  prepared: PreparedRecall;
  result: MemoryRecallResult;
  candidates: HierarchyCandidate[];
};

type FactFacetCandidateMatch = {
  candidate: HierarchyCandidate;
  evidence: MemoryEvidence[];
  valueKey: string;
  score: number;
};

type FactEvidenceDecisionAudit = {
  evidenceId: string;
  decision: "accepted" | "rejected";
  reasonCode: ExplicitFactSelectorEvidenceReason;
};

type FactCandidateEvaluation =
  | {
      candidate: HierarchyCandidate;
      match: FactFacetCandidateMatch;
      hardConflict?: boolean;
      reasonCode: "fact_candidate_eligible";
      evidence: FactEvidenceDecisionAudit[];
    }
  | {
      candidate: HierarchyCandidate;
      match?: undefined;
      hardConflict?: boolean;
      reasonCode: ExplicitFactSelectorCandidateReason;
      evidence: FactEvidenceDecisionAudit[];
    };

type ExplicitFactRecallPreparation =
  | {
      status: "selected";
      selection: PreparedTierSelection;
      audit: ExplicitFactSelectorAttemptAudit;
      matchesByFacet: FactFacetCandidateMatch[][];
      hardConflictFacetIndexes: number[];
    }
  | {
      status: "rejected";
      reason:
        | "requested_fact_facets_incomplete"
        | "requested_fact_facets_conflicted"
        | "requested_fact_evidence_capacity_insufficient"
        | "requested_fact_scan_truncated"
        | "requested_fact_below_caller_threshold";
      score: number;
      prepared?: PreparedRecall;
      candidates?: HierarchyCandidate[];
      audit: ExplicitFactSelectorAttemptAudit;
      matchesByFacet: FactFacetCandidateMatch[][];
      hardConflictFacetIndexes: number[];
    };

type FactFacetMatchSelection =
  | { status: "selected"; matches: FactFacetCandidateMatch[] }
  | { status: "incomplete" | "conflicted" };

type TemporalContext = {
  resolution: JsonValue;
  range?: {
    fromUtc: string;
    toUtc: string;
  };
  digest?: DateDigest;
};

export interface ContinuityRecallDependencies {
  continuityIndex: ContinuityIndexService;
  dateDigests: DateDigestService;
}

export interface ContinuityRecallInspection {
  preview: MemoryRecallPreview;
  prepared: PreparedRecall;
  candidateBreakdowns: Map<string, RetrievalScoreBreakdown>;
  hierarchy: RetrievalHierarchySnapshot;
  selectorAuditInput?: ExplicitFactSelectorInputSnapshot;
}

export function inspectContinuityRecall(
  store: DatabaseStore,
  dependencies: ContinuityRecallDependencies,
  input: AgentMemoryRecallInput,
): ContinuityRecallInspection {
  const started = performance.now();
  const query = normalizeQuery(input.query, input.contextPlan);
  const explicitFactParse =
    input.requireDurableEvidence === true
      ? parseExplicitFactVerificationRequest(query.query)
      : ({ kind: "none" } satisfies ExplicitFactVerificationParse);
  const explicitFactVerification =
    explicitFactParse.kind === "valid" ? explicitFactParse.request : undefined;
  const exactIdentifiers = recallExactIdentifiers(query.query);
  const candidateLimit = boundedInteger(
    input.limit ?? DEFAULT_CANDIDATE_LIMIT,
    1,
    500,
  );
  const maxEvidence = boundedInteger(
    input.maxEvidence ??
      query.contextPlan?.maxRecallEvidence ??
      DEFAULT_MAX_EVIDENCE,
    1,
    query.contextPlan?.maxRecallEvidence ?? 3,
  );
  const minimumScore = query.minimumScore ?? DEFAULT_MINIMUM_SCORE;
  const searchLimit = Math.min(100, candidateLimit);
  const searchedCards = [
    ...new Map(
      recallCandidateQueries(query)
        .flatMap((candidateQuery) =>
          dependencies.continuityIndex.searchEventCards({
            agentId: input.agentId,
            query: candidateQuery,
            limit: searchLimit,
            nowUtc: input.nowUtc,
            suppressedMemoryIds: input.suppressedMemoryIds ?? [],
          }),
        )
        .map((card) => [card.id, card]),
    ).values(),
  ].slice(0, searchLimit);
  const temporal = temporalContext(
    store,
    dependencies,
    input,
    query,
    searchedCards,
    candidateLimit,
  );
  if (
    input.requireDurableEvidence !== true &&
    isAmbiguousResolution(temporal.resolution)
  ) {
    const result = abstainResult(ambiguousReason(temporal.resolution));
    return buildInspection({
      store,
      input,
      started,
      prepared: emptyPrepared(query, candidateLimit, maxEvidence, minimumScore),
      result,
      finalTier: "none",
      tierByMemoryId: new Map(),
      temporalResolution: temporal.resolution,
    });
  }

  const effectiveQuery =
    temporal.range === undefined
      ? query
      : MemoryRecallQuerySchema.parse({
          ...query,
          timeRange: {
            fromUtc: temporal.range.fromUtc,
            toUtc: temporal.range.toUtc,
            statuses: ["occurred"],
          },
        });
  const explicitFactQuery =
    explicitFactVerification === undefined
      ? undefined
      : query.timeRange === undefined
        ? withoutTimeRange(effectiveQuery)
        : effectiveQuery;
  if (explicitFactParse.kind === "invalid") {
    return buildInspection({
      store,
      input,
      started,
      prepared: emptyPrepared(query, candidateLimit, maxEvidence, minimumScore),
      result: abstainResult(explicitFactParse.reason),
      finalTier: "none",
      tierByMemoryId: new Map(),
      temporalResolution: temporal.resolution,
    });
  }

  const explicitFactSearchTerms =
    explicitFactVerification?.facets.flatMap((facet) => facet.searchTerms) ??
    [];
  const explicitEventCardScan =
    explicitFactVerification === undefined
      ? undefined
      : dependencies.continuityIndex.scanExplicitFactEventCards({
          agentId: input.agentId,
          searchTerms: explicitFactSearchTerms,
          scanLimit: EXPLICIT_FACT_SAFETY_SCAN_LIMIT,
          nowUtc: input.nowUtc,
          suppressedMemoryIds: input.suppressedMemoryIds ?? [],
        });
  const eventCardPool = explicitEventCardScan?.cards ?? searchedCards;
  const eventCardRange =
    explicitFactVerification !== undefined && query.timeRange === undefined
      ? undefined
      : temporal.range;
  const eventCards =
    eventCardRange === undefined
      ? eventCardPool
      : eventCardPool.filter((card) =>
          eventCardOccursInRange(card, eventCardRange),
        );
  const eventScanCandidates = eventCardPool.map((card) =>
    eventCardCandidate(store, card),
  );
  const eventCandidates =
    eventCardRange === undefined
      ? eventScanCandidates
      : eventCards.map((card) => eventCardCandidate(store, card));
  const eventScanWitnessCandidate =
    explicitEventCardScan?.truncationWitness === undefined
      ? undefined
      : eventCardCandidate(store, explicitEventCardScan.truncationWitness);
  const eventPreparedCandidates =
    explicitFactVerification === undefined
      ? eventCandidates
      : diagnosticExplicitFactCandidates(eventCandidates);
  const eventPrepared = prepareCandidates(
    store,
    input.agentId,
    explicitFactQuery ?? effectiveQuery,
    candidateLimit,
    maxEvidence,
    minimumScore,
    eventPreparedCandidates,
  );
  const eventResult = evaluateTier(eventPrepared, input.nowUtc, "event_card");
  const eventFactSelection =
    explicitFactVerification === undefined || explicitFactQuery === undefined
      ? undefined
      : prepareExplicitFactVerificationRecall({
          store,
          input,
          query: explicitFactQuery,
          candidateLimit,
          maxEvidence,
          request: explicitFactVerification,
          candidates: eventCandidates,
          tier: "event_card",
        });
  if (
    explicitFactVerification !== undefined &&
    explicitFactQuery !== undefined &&
    eventFactSelection !== undefined
  ) {
    // Atomic fact verification uses a fixed safety pool. Caller-facing limits
    // must never hide a lower-ranked contradiction.
    const explicitFactMemoryScan = readStableExplicitUserMemoryScan(
      store,
      input.agentId,
      input.nowUtc,
      {
        searchTerms: explicitFactSearchTerms,
        scanLimit: EXPLICIT_FACT_SAFETY_SCAN_LIMIT,
        suppressedMemoryIds: input.suppressedMemoryIds ?? [],
      },
    );
    const explicitFactEvidenceScan = readExplicitFactMemoryEvidenceScan(
      store,
      explicitFactMemoryScan.memories.map((memory) => memory.id),
      EXPLICIT_FACT_EVIDENCE_SAFETY_SCAN_LIMIT,
    );
    const allExplicitBasicCandidates = basicMemoryCandidatesFromMemories(
      store,
      explicitFactMemoryScan.memories,
      explicitFactEvidenceScan.evidence,
    );
    const basicScanWitnessCandidate =
      explicitFactMemoryScan.truncationWitness === undefined
        ? undefined
        : {
            tier: "basic_memory" as const,
            memory: explicitFactMemoryScan.truncationWitness,
            evidence: [],
          };
    const explicitBasicCandidates = allExplicitBasicCandidates.filter(
      (candidate) =>
        isEligibleDurableCandidateForIntent(
          store,
          input.agentId,
          query.query,
          true,
          candidate,
        ),
    );
    const explicitBasicPrepared = prepareCandidates(
      store,
      input.agentId,
      explicitFactQuery,
      candidateLimit,
      maxEvidence,
      minimumScore,
      diagnosticExplicitFactCandidates(explicitBasicCandidates),
    );
    const explicitBasicResult = evaluateTier(
      explicitBasicPrepared,
      input.nowUtc,
      "basic_memory",
    );
    const truncatedEvidenceMemoryIds =
      explicitFactMemoryScan.truncated ||
      explicitFactEvidenceScan.truncatedMemoryIds.length === 0
        ? []
        : explicitFactEvidenceScan.truncatedMemoryIds.slice(0, candidateLimit);
    const truncatedEvidenceMemoryIdSet = new Set(truncatedEvidenceMemoryIds);
    const truncatedEvidenceCandidates = allExplicitBasicCandidates.filter(
      (candidate) => truncatedEvidenceMemoryIdSet.has(candidate.memory.id),
    );
    const truncatedEvidencePrepared = prepareCandidates(
      store,
      input.agentId,
      explicitFactQuery,
      candidateLimit,
      maxEvidence,
      minimumScore,
      diagnosticExplicitFactCandidates(truncatedEvidenceCandidates),
    );
    if (
      explicitEventCardScan?.truncated === true ||
      explicitFactMemoryScan.truncated ||
      explicitFactEvidenceScan.truncatedMemoryIds.length > 0
    ) {
      const eventAttempt = explicitEventCardScan?.truncated
        ? truncatedExplicitFactAttemptAudit(
            explicitFactVerification,
            "event_card",
            explicitEventCardScan.cards.length,
            "candidate_pool",
            explicitEventCardScan.scanLimit,
            undefined,
            eventScanWitnessCandidate?.memory.id,
          )
        : blockSelectedExplicitFactAttemptAudit(
            eventFactSelection.audit,
            "fact_candidate_rejected_due_scan_truncation",
          );
      const attempts = [eventAttempt];
      if (
        explicitFactMemoryScan.truncated ||
        explicitFactEvidenceScan.truncatedMemoryIds.length > 0
      ) {
        const memoryPoolTruncated = explicitFactMemoryScan.truncated;
        attempts.push(
          truncatedExplicitFactAttemptAudit(
            explicitFactVerification,
            "basic_memory",
            allExplicitBasicCandidates.length,
            memoryPoolTruncated ? "candidate_pool" : "evidence_per_memory",
            memoryPoolTruncated
              ? explicitFactMemoryScan.scanLimit
              : EXPLICIT_FACT_EVIDENCE_SAFETY_SCAN_LIMIT,
            memoryPoolTruncated ? undefined : truncatedEvidenceMemoryIds,
            memoryPoolTruncated
              ? basicScanWitnessCandidate?.memory.id
              : undefined,
          ),
        );
      }
      const basicScanTruncated =
        explicitFactMemoryScan.truncated ||
        explicitFactEvidenceScan.truncatedMemoryIds.length > 0;
      const prepared = basicScanTruncated
        ? explicitFactMemoryScan.truncated
          ? explicitBasicPrepared
          : truncatedEvidencePrepared
        : eventPrepared;
      const candidates = basicScanTruncated
        ? explicitFactMemoryScan.truncated
          ? explicitBasicCandidates
          : truncatedEvidenceCandidates
        : eventCandidates;
      const rejection = strongestExplicitFactAttemptRejection(attempts);
      return buildInspection({
        store,
        input,
        started,
        prepared,
        result: abstainResult(
          rejection.reason,
          Math.max(eventResult.score, explicitBasicResult.score),
        ),
        finalTier: "none",
        tierByMemoryId: tierMap(candidates),
        temporalResolution: temporal.resolution,
        selectorCandidates: [
          ...eventScanCandidates,
          ...(eventScanWitnessCandidate === undefined
            ? []
            : [eventScanWitnessCandidate]),
          ...(explicitFactMemoryScan.truncated
            ? allExplicitBasicCandidates
            : truncatedEvidenceCandidates),
          ...(basicScanWitnessCandidate === undefined
            ? []
            : [basicScanWitnessCandidate]),
        ],
        selectorAudit: explicitFactSelectorAudit({
          request: explicitFactVerification,
          outcome: rejection.outcome,
          attempts,
          replayEvidenceIds: prepared.evidence.map((evidence) => evidence.id),
          matchesByAttempt: [eventFactSelection.matchesByFacet],
        }),
      });
    }

    const basicFactSelection = prepareExplicitFactVerificationRecall({
      store,
      input,
      query: explicitFactQuery,
      candidateLimit,
      maxEvidence,
      request: explicitFactVerification,
      candidates: explicitBasicCandidates,
      tier: "basic_memory",
    });
    const combinedMatchesByFacet = explicitFactVerification.facets.map(
      (_facet, index) => [
        ...(eventFactSelection.matchesByFacet[index] ?? []),
        ...(basicFactSelection.matchesByFacet[index] ?? []),
      ],
    );
    const conflictingFacetIndexes = [
      ...new Set([
        ...factConflictFacetIndexes(combinedMatchesByFacet),
        ...eventFactSelection.hardConflictFacetIndexes,
        ...basicFactSelection.hardConflictFacetIndexes,
      ]),
    ].sort((left, right) => left - right);
    if (conflictingFacetIndexes.length > 0) {
      const conflictCandidates = factMatchCandidates(combinedMatchesByFacet);
      const conflictPrepared = prepareCandidates(
        store,
        input.agentId,
        explicitFactQuery,
        candidateLimit,
        maxEvidence,
        explicitFactQuery.minimumScore ?? DEFAULT_EXPLICIT_FACT_MINIMUM_SCORE,
        diagnosticExplicitFactCandidates(conflictCandidates),
      );
      return buildInspection({
        store,
        input,
        started,
        prepared: conflictPrepared,
        result: abstainResult(
          "requested_fact_facets_conflicted",
          Math.max(
            explicitFactPreparationScore(eventFactSelection),
            explicitFactPreparationScore(basicFactSelection),
          ),
        ),
        finalTier: "none",
        tierByMemoryId: tierMap(conflictCandidates),
        temporalResolution: temporal.resolution,
        selectorCandidates: [...eventCandidates, ...explicitBasicCandidates],
        selectorAudit: explicitFactSelectorAudit({
          request: explicitFactVerification,
          outcome: "conflicted",
          attempts: markExplicitFactConflictAttempts(
            [eventFactSelection, basicFactSelection],
            combinedMatchesByFacet,
            conflictingFacetIndexes,
          ),
          replayEvidenceIds: conflictPrepared.evidence.map(
            (evidence) => evidence.id,
          ),
          matchesByAttempt: [
            eventFactSelection.matchesByFacet,
            basicFactSelection.matchesByFacet,
          ],
        }),
      });
    }

    if (eventFactSelection.status === "selected") {
      return buildInspection({
        store,
        input,
        started,
        prepared: eventFactSelection.selection.prepared,
        result: eventFactSelection.selection.result,
        finalTier: "event_card",
        tierByMemoryId: tierMap(eventFactSelection.selection.candidates),
        temporalResolution: temporal.resolution,
        selectorCandidates: [...eventCandidates, ...explicitBasicCandidates],
        selectorAudit: explicitFactSelectorAudit({
          request: explicitFactVerification,
          outcome: "selected",
          attempts: [
            eventFactSelection.audit,
            consistentNotSelectedFactAttemptAudit(basicFactSelection.audit),
          ],
          replayEvidenceIds: eventFactSelection.selection.prepared.evidence.map(
            (evidence) => evidence.id,
          ),
          matchesByAttempt: [
            eventFactSelection.matchesByFacet,
            basicFactSelection.matchesByFacet,
          ],
        }),
      });
    }
    if (basicFactSelection.status === "selected") {
      if (
        eventFactSelection.status === "rejected" &&
        (eventFactSelection.reason ===
          "requested_fact_evidence_capacity_insufficient" ||
          eventFactSelection.reason === "requested_fact_below_caller_threshold")
      ) {
        const rejection = combinedExplicitFactRejection([eventFactSelection]);
        return buildInspection({
          store,
          input,
          started,
          prepared: basicFactSelection.selection.prepared,
          result: abstainResult(
            rejection.reason,
            Math.max(
              rejection.score,
              basicFactSelection.selection.result.score,
            ),
          ),
          finalTier: "none",
          tierByMemoryId: tierMap(basicFactSelection.selection.candidates),
          temporalResolution: temporal.resolution,
          selectorCandidates: [...eventCandidates, ...explicitBasicCandidates],
          selectorAudit: explicitFactSelectorAudit({
            request: explicitFactVerification,
            outcome: rejection.outcome,
            attempts: [
              eventFactSelection.audit,
              completeNotSelectedFactAttemptAudit(basicFactSelection.audit),
            ],
            replayEvidenceIds:
              basicFactSelection.selection.prepared.evidence.map(
                (evidence) => evidence.id,
              ),
            matchesByAttempt: [
              eventFactSelection.matchesByFacet,
              basicFactSelection.matchesByFacet,
            ],
          }),
        });
      }
      return buildInspection({
        store,
        input,
        started,
        prepared: basicFactSelection.selection.prepared,
        result: basicFactSelection.selection.result,
        finalTier: "basic_memory",
        tierByMemoryId: tierMap(basicFactSelection.selection.candidates),
        temporalResolution: temporal.resolution,
        selectorCandidates: [...eventCandidates, ...explicitBasicCandidates],
        selectorAudit: explicitFactSelectorAudit({
          request: explicitFactVerification,
          outcome: "selected",
          attempts: [eventFactSelection.audit, basicFactSelection.audit],
          replayEvidenceIds: basicFactSelection.selection.prepared.evidence.map(
            (evidence) => evidence.id,
          ),
          matchesByAttempt: [
            eventFactSelection.matchesByFacet,
            basicFactSelection.matchesByFacet,
          ],
        }),
      });
    }
    const rejection = combinedExplicitFactRejection([
      eventFactSelection,
      basicFactSelection,
    ]);
    const rejectionPrepared = diagnosticPreparedRecall(
      basicFactSelection.prepared ?? explicitBasicPrepared,
    );
    return buildInspection({
      store,
      input,
      started,
      prepared: rejectionPrepared,
      result: abstainResult(rejection.reason, rejection.score),
      finalTier: "none",
      tierByMemoryId: tierMap(
        basicFactSelection.candidates ?? explicitBasicCandidates,
      ),
      temporalResolution: temporal.resolution,
      selectorCandidates: [...eventCandidates, ...explicitBasicCandidates],
      selectorAudit: explicitFactSelectorAudit({
        request: explicitFactVerification,
        outcome: rejection.outcome,
        attempts: [eventFactSelection.audit, basicFactSelection.audit],
        replayEvidenceIds: rejectionPrepared.evidence.map(
          (evidence) => evidence.id,
        ),
        matchesByAttempt: [
          eventFactSelection.matchesByFacet,
          basicFactSelection.matchesByFacet,
        ],
      }),
    });
  }

  if (
    !eventResult.abstained &&
    resultCoversExactIdentifiers(eventResult, exactIdentifiers)
  ) {
    return buildInspection({
      store,
      input,
      started,
      prepared: eventPrepared,
      result: eventResult,
      finalTier: "event_card",
      tierByMemoryId: tierMap(eventCandidates),
      temporalResolution: temporal.resolution,
    });
  }

  // A non-temporal fact query must consult the canonical durable memory rows
  // before raw archived wording. Verbatim candidates are intentionally
  // synthetic, so letting them win here can resurrect an old statement after
  // its structured claim has been superseded by an explicit correction.
  const allBasicCandidates = basicMemoryCandidates(
    store,
    input.agentId,
    recallCandidateQueries(query).join("\n"),
    input.nowUtc,
    candidateLimit,
    input.suppressedMemoryIds ?? [],
  );
  const basicCandidates = allBasicCandidates.filter((candidate) =>
    isEligibleDurableCandidateForIntent(
      store,
      input.agentId,
      query.query,
      input.requireDurableEvidence === true,
      candidate,
    ),
  );
  const basicPrepared = prepareCandidates(
    store,
    input.agentId,
    effectiveQuery,
    candidateLimit,
    maxEvidence,
    minimumScore,
    basicCandidates,
  );
  const basicResult = evaluateTier(basicPrepared, input.nowUtc, "basic_memory");
  if (
    input.requireDurableEvidence === true &&
    isLinkedFriendDestinationIntent(query.query)
  ) {
    const linkedSelection = prepareLinkedFriendDestinationRecall({
      store,
      input,
      query: effectiveQuery,
      candidateLimit,
      maxEvidence,
      candidates: basicCandidates,
    });
    if (linkedSelection !== undefined) {
      return buildInspection({
        store,
        input,
        started,
        prepared: linkedSelection.prepared,
        result: linkedSelection.result,
        finalTier: "basic_memory",
        tierByMemoryId: tierMap(linkedSelection.candidates),
        temporalResolution: temporal.resolution,
      });
    }
    return buildInspection({
      store,
      input,
      started,
      prepared: basicPrepared,
      result: abstainResult(
        "linked_durable_facts_incomplete",
        basicResult.score,
      ),
      finalTier: "none",
      tierByMemoryId: tierMap(basicCandidates),
      temporalResolution: temporal.resolution,
    });
  }
  if (
    input.requireDurableEvidence === true &&
    isRelationshipBoundaryIntent(query.query)
  ) {
    const boundarySelection = prepareRelationshipBoundaryRecall({
      store,
      input,
      query: withoutTimeRange(effectiveQuery),
      candidateLimit,
      maxEvidence,
      candidates: basicCandidates,
    });
    if (boundarySelection !== undefined) {
      return buildInspection({
        store,
        input,
        started,
        prepared: boundarySelection.prepared,
        result: boundarySelection.result,
        finalTier: "basic_memory",
        tierByMemoryId: tierMap(boundarySelection.candidates),
        temporalResolution: temporal.resolution,
      });
    }
    return buildInspection({
      store,
      input,
      started,
      prepared: basicPrepared,
      result: abstainResult(
        "relationship_boundary_evidence_not_found",
        basicResult.score,
      ),
      finalTier: "none",
      tierByMemoryId: tierMap(basicCandidates),
      temporalResolution: temporal.resolution,
    });
  }
  if (
    input.requireDurableEvidence === true &&
    (isConflictRepairIntent(query.query) ||
      isRelationshipHistoryIntent(query.query))
  ) {
    const relationshipSelection = prepareRelationshipConflictRepairRecall({
      store,
      input,
      // A conflict-and-repair recap is an episode-level query: the initial
      // rupture and the later repair may have been recorded on adjacent days.
      // The explicit facets below retain semantic scope while avoiding a
      // relative-date parser from dropping one half of the causal pair.
      query: withoutTimeRange(effectiveQuery),
      candidateLimit,
      maxEvidence,
      candidates: basicCandidates,
    });
    if (relationshipSelection !== undefined) {
      return buildInspection({
        store,
        input,
        started,
        prepared: relationshipSelection.prepared,
        result: relationshipSelection.result,
        finalTier: "basic_memory",
        tierByMemoryId: tierMap(relationshipSelection.candidates),
        temporalResolution: temporal.resolution,
      });
    }
    if (isConflictRepairIntent(query.query)) {
      return buildInspection({
        store,
        input,
        started,
        prepared: basicPrepared,
        result: abstainResult(
          "relationship_conflict_repair_incomplete",
          basicResult.score,
        ),
        finalTier: "none",
        tierByMemoryId: tierMap(basicCandidates),
        temporalResolution: temporal.resolution,
      });
    }
  }
  const canonicalBasicCandidates = basicCandidates.filter(
    (candidate) =>
      candidate.memory.status === "active" &&
      (candidate.memory.claim !== undefined ||
        (candidate.memory.namespace === "user_model" &&
          candidate.memory.certainty === "explicit" &&
          candidate.memory.attribution === "user_explicit") ||
        isGroundedSharedRelationshipCandidate(
          store,
          input.agentId,
          query.query,
          candidate,
        )) &&
      candidate.memory.supersededById === undefined &&
      candidate.memory.mergedIntoId === undefined,
  );
  const canonicalBasicPrepared =
    input.requireDurableEvidence === true &&
    basicResult.abstained &&
    query.minimumScore === undefined &&
    canonicalBasicCandidates.length > 0
      ? prepareCandidates(
          store,
          input.agentId,
          effectiveQuery,
          candidateLimit,
          maxEvidence,
          Math.min(minimumScore, canonicalClaimMinimumScore(query.query)),
          canonicalBasicCandidates,
        )
      : undefined;
  const canonicalBasicResult =
    canonicalBasicPrepared === undefined
      ? undefined
      : evaluateTier(canonicalBasicPrepared, input.nowUtc, "basic_memory");
  const prioritizedBasicResult =
    canonicalBasicResult !== undefined && !canonicalBasicResult.abstained
      ? canonicalBasicResult
      : basicResult;
  const prioritizedBasicCandidates =
    canonicalBasicResult !== undefined && !canonicalBasicResult.abstained
      ? canonicalBasicCandidates
      : basicCandidates;
  const prioritizedBasicPrepared =
    canonicalBasicResult !== undefined && !canonicalBasicResult.abstained
      ? canonicalBasicPrepared!
      : basicPrepared;
  if (
    input.requireDurableEvidence === true &&
    !prioritizedBasicResult.abstained &&
    resultCoversExactIdentifiers(prioritizedBasicResult, exactIdentifiers)
  ) {
    return buildInspection({
      store,
      input,
      started,
      prepared: prioritizedBasicPrepared,
      result: prioritizedBasicResult,
      finalTier: "basic_memory",
      tierByMemoryId: tierMap(prioritizedBasicCandidates),
      temporalResolution: temporal.resolution,
    });
  }
  if (
    input.requireDurableEvidence === true &&
    temporal.range !== undefined &&
    temporal.digest !== undefined
  ) {
    const digestCandidates = dateDigestCandidates(
      store,
      input.agentId,
      temporal.digest,
      input.nowUtc,
      candidateLimit,
      input.suppressedMemoryIds ?? [],
    );
    const digestPrepared = prepareCandidates(
      store,
      input.agentId,
      effectiveQuery,
      candidateLimit,
      maxEvidence,
      minimumScore,
      digestCandidates,
    );
    const digestResult = evaluateTier(
      digestPrepared,
      input.nowUtc,
      "date_digest",
    );
    if (
      !digestResult.abstained &&
      resultCoversExactIdentifiers(digestResult, exactIdentifiers)
    ) {
      return buildInspection({
        store,
        input,
        started,
        prepared: digestPrepared,
        result: digestResult,
        finalTier: "date_digest",
        tierByMemoryId: tierMap(digestCandidates),
        temporalResolution: temporal.resolution,
      });
    }
  }
  if (input.requireDurableEvidence === true) {
    const bestScore = Math.max(
      basicResult.score,
      canonicalBasicResult?.score ?? 0,
    );
    return buildInspection({
      store,
      input,
      started,
      prepared: basicPrepared,
      result: abstainResult(
        basicCandidates.length === 0
          ? "no_durable_memory_evidence"
          : "durable_memory_below_relevance_threshold",
        bestScore,
      ),
      finalTier: "none",
      tierByMemoryId: tierMap(basicCandidates),
      temporalResolution: temporal.resolution,
    });
  }

  const archived = dependencies.continuityIndex
    .searchVerbatim({
      agentId: input.agentId,
      query: query.query,
      limit: searchLimit,
      suppressedMemoryIds: input.suppressedMemoryIds ?? [],
    })
    .filter(
      (message) =>
        !isVerbatimQueryEcho(message.content, query.query) &&
        (temporal.range === undefined ||
          instantInRange(message.createdAtUtc, temporal.range)),
    );
  const verbatimCandidates = archived.map(verbatimCandidate);
  const verbatimQuery =
    temporal.range === undefined
      ? effectiveQuery
      : withoutTimeRange(effectiveQuery);
  let attempted = mergeCandidates(
    eventCandidates,
    verbatimCandidates,
    candidateLimit,
  );
  const verbatimPrepared = prepareCandidates(
    store,
    input.agentId,
    verbatimQuery,
    candidateLimit,
    maxEvidence,
    minimumScore,
    verbatimCandidates,
  );
  const verbatimResult = evaluateTier(
    verbatimPrepared,
    input.nowUtc,
    "verbatim_quote",
  );
  if (
    !verbatimResult.abstained &&
    resultCoversExactIdentifiers(verbatimResult, exactIdentifiers)
  ) {
    const prepared = prepareCandidates(
      store,
      input.agentId,
      verbatimQuery,
      candidateLimit,
      maxEvidence,
      minimumScore,
      attempted,
    );
    return buildInspection({
      store,
      input,
      started,
      prepared,
      result: verbatimResult,
      finalTier: "verbatim_quote",
      tierByMemoryId: tierMap(attempted),
      temporalResolution: temporal.resolution,
    });
  }

  if (temporal.range !== undefined && temporal.digest !== undefined) {
    const digestCandidates = dateDigestCandidates(
      store,
      input.agentId,
      temporal.digest,
      input.nowUtc,
      candidateLimit,
      input.suppressedMemoryIds ?? [],
    );
    attempted = mergeCandidates(attempted, digestCandidates, candidateLimit);
    const digestPrepared = prepareCandidates(
      store,
      input.agentId,
      effectiveQuery,
      candidateLimit,
      maxEvidence,
      minimumScore,
      digestCandidates,
    );
    const digestResult = evaluateTier(
      digestPrepared,
      input.nowUtc,
      "date_digest",
    );
    if (
      !digestResult.abstained &&
      resultCoversExactIdentifiers(digestResult, exactIdentifiers)
    ) {
      const prepared = prepareCandidates(
        store,
        input.agentId,
        effectiveQuery,
        candidateLimit,
        maxEvidence,
        minimumScore,
        attempted,
      );
      return buildInspection({
        store,
        input,
        started,
        prepared,
        result: digestResult,
        finalTier: "date_digest",
        tierByMemoryId: tierMap(attempted),
        temporalResolution: temporal.resolution,
      });
    }
  }

  const snapshotCandidates = mergeCandidates(
    attempted,
    basicCandidates,
    candidateLimit,
  );
  const snapshotPrepared = prepareCandidates(
    store,
    input.agentId,
    effectiveQuery,
    candidateLimit,
    maxEvidence,
    minimumScore,
    snapshotCandidates,
  );
  if (
    !basicResult.abstained &&
    resultCoversExactIdentifiers(basicResult, exactIdentifiers)
  ) {
    return buildInspection({
      store,
      input,
      started,
      prepared: snapshotPrepared,
      result: basicResult,
      finalTier: "basic_memory",
      tierByMemoryId: tierMap(snapshotCandidates),
      temporalResolution: temporal.resolution,
    });
  }

  const bestScore = Math.max(
    eventResult.score,
    verbatimResult.score,
    basicResult.score,
  );
  const reason =
    temporal.range !== undefined
      ? "date_digest_no_reliable_facts"
      : snapshotPrepared.memories.length === 0
        ? "no_continuity_evidence"
        : "below_relevance_threshold";
  return buildInspection({
    store,
    input,
    started,
    prepared: snapshotPrepared,
    result: abstainResult(reason, bestScore),
    finalTier: "none",
    tierByMemoryId: tierMap(snapshotCandidates),
    temporalResolution: temporal.resolution,
  });
}

export function replayContinuityRecall(
  input: RetrievalReplayInput,
): MemoryRecallResult {
  const hierarchy = input.hierarchy;
  if (hierarchy === undefined) {
    throw new TypeError("Continuity replay requires a hierarchy snapshot");
  }
  if (hierarchy.finalTier === "none") {
    return abstainResult(
      hierarchy.abstentionReason ?? "no_continuity_evidence",
      hierarchy.abstentionScore ?? 0,
    );
  }
  const selectedTier = hierarchy.finalTier;
  const candidateIds = new Set(
    hierarchy.candidateTiers
      .filter((item) => item.tier === selectedTier)
      .map((item) => item.memoryId),
  );
  const memories = input.memories.filter((memory) =>
    candidateIds.has(memory.id),
  );
  const evidence = input.evidence.filter((item) =>
    candidateIds.has(item.memoryId),
  );
  const recalled = recallMemory({
    query: input.query,
    memories,
    evidence,
    nowUtc: input.nowUtc,
    minimumScore: selectedTier === "date_digest" ? 0 : input.minimumScore,
    maxEvidence: input.maxEvidence,
  });
  const result = forceMode(recalled, selectedTier);
  if (hierarchy.selectorAudit?.outcome !== "selected") return result;
  const candidates = memories.map((memory) => ({
    tier: selectedTier,
    memory,
    evidence: evidence.filter((item) => item.memoryId === memory.id),
  }));
  return completeExplicitFactEvidenceResult(result, candidates) ?? result;
}

function temporalContext(
  store: DatabaseStore,
  dependencies: ContinuityRecallDependencies,
  input: AgentMemoryRecallInput,
  query: MemoryRecallQuery,
  cards: readonly EventCard[],
  maxItems: number,
): TemporalContext {
  if (query.timeRange !== undefined) {
    const range = {
      fromUtc: query.timeRange.fromUtc,
      toUtc: query.timeRange.toUtc,
    };
    const digest = dependencies.dateDigests.build({
      agentId: input.agentId,
      ...range,
      maxItems,
      nowUtc: input.nowUtc,
      suppressedMemoryIds: input.suppressedMemoryIds ?? [],
    });

    return {
      resolution: {
        kind: "resolved",
        expression: "explicit_range",
        ...range,
      },
      range,
      ...(digest === undefined ? {} : { digest }),
    };
  }
  const timezone =
    input.timezone ?? store.getCharacterSpec(input.agentId)?.identity.timezone;
  if (timezone === undefined) {
    return {
      resolution: {
        kind: "ambiguous",
        reasonCode: "timezone_not_found",
      },
    };
  }
  const result = dependencies.dateDigests.query({
    agentId: input.agentId,
    text: query.query,
    nowUtc: input.nowUtc,
    timezone,
    suppressedMemoryIds: input.suppressedMemoryIds ?? [],
    anchors: temporalAnchorsFromEventCards(cards, query.query),
    maxItems,
  });
  return {
    resolution: toJson(result.resolution),
    ...(result.resolution.kind === "resolved"
      ? {
          range: {
            fromUtc: result.resolution.fromUtc,
            toUtc: result.resolution.toUtc,
          },
        }
      : {}),
    ...(result.digest === undefined ? {} : { digest: result.digest }),
  };
}

function eventCardOccursInRange(
  card: EventCard,
  range: { fromUtc: string; toUtc: string },
): boolean {
  const temporal = card.temporalMetadata;
  if (
    temporal.temporalStatus !== "occurred" ||
    temporal.occurredStartAtUtc === undefined ||
    (temporal.temporalCertainty !== "exact" &&
      temporal.temporalCertainty !== "date_only")
  ) {
    return false;
  }
  return overlapsRange(
    temporal.occurredStartAtUtc,
    temporal.occurredEndAtUtc,
    range,
  );
}

function eventCardCandidate(
  store: DatabaseStore,
  card: EventCard,
): HierarchyCandidate {
  const sources = [...card.evidence]
    .filter((item) => item.reliability !== "context")
    .sort(
      (left, right) =>
        reliabilityRank(right.reliability) -
          reliabilityRank(left.reliability) || left.id.localeCompare(right.id),
    );
  const evidence = deduplicateEvidence(
    sources.flatMap((source) => continuityEvidence(store, card.id, source)),
  );
  const reliable = card.certainty !== "uncertain" && evidence.length > 0;
  const memory = MemorySchema.parse({
    id: card.id,
    agentId: card.agentId,
    kind: memoryKindForCard(card),
    content: card.summary.slice(0, 2_000),
    importance: card.importance,
    confidence: reliable ? 1 : 0.49,
    tags: card.tags,
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: card.namespace,
    certainty: card.certainty,
    attribution: card.attribution,
    stability:
      card.cardKind === "goal" || card.cardKind === "commitment"
        ? "stable"
        : "situational",
    temporalMetadata: card.temporalMetadata,
    status: "active",
    dedupeKey: ("recall:event_card:" + card.id).slice(0, 240),
    createdAtUtc: card.createdAtUtc,
    updatedAtUtc: card.updatedAtUtc,
  });
  return { tier: "event_card", memory, evidence };
}

function continuityEvidence(
  store: DatabaseStore,
  memoryId: string,
  source: EventCard["evidence"][number],
): MemoryEvidence[] {
  if (source.sourceType === "message_archive") {
    return [
      MemoryEvidenceSchema.parse({
        id: stableId("evidence", "event_card:" + memoryId + ":" + source.id),
        memoryId,
        sourceType: "message",
        sourceId: source.sourceId,
        ...(source.quote === undefined ? {} : { quote: source.quote }),
        ...(source.contextSummary === undefined
          ? {}
          : { contextSummary: source.contextSummary }),
        recordedAtUtc: source.recordedAtUtc,
      }),
    ];
  }
  if (source.sourceType === "activity_event") {
    return [
      MemoryEvidenceSchema.parse({
        id: stableId("evidence", "event_card:" + memoryId + ":" + source.id),
        memoryId,
        sourceType: "activity_event",
        sourceId: source.sourceId,
        ...(source.quote === undefined ? {} : { quote: source.quote }),
        ...(source.contextSummary === undefined
          ? {}
          : { contextSummary: source.contextSummary }),
        recordedAtUtc: source.recordedAtUtc,
      }),
    ];
  }
  if (source.sourceType !== "memory_evidence") return [];
  const row = store.database
    .prepare("SELECT evidence_json FROM memory_evidence WHERE id = ?")
    .get(source.sourceId) as { evidence_json: string } | undefined;
  if (row === undefined) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(row.evidence_json) as unknown;
  } catch {
    return [];
  }
  const parsed = MemoryEvidenceSchema.safeParse(raw);
  if (!parsed.success || parsed.data.sourceType === "schedule_event") return [];
  return [
    MemoryEvidenceSchema.parse({
      ...parsed.data,
      id: stableId("evidence", "event_card:" + memoryId + ":" + source.id),
      memoryId,
    }),
  ];
}

function deduplicateEvidence(
  evidence: readonly MemoryEvidence[],
): MemoryEvidence[] {
  return [...new Map(evidence.map((item) => [item.id, item])).values()].sort(
    (left, right) => left.id.localeCompare(right.id),
  );
}

function verbatimCandidate(message: ArchivedMessage): HierarchyCandidate {
  const memoryId = stableId("memory", "verbatim:" + message.id);
  const content = message.content.trim().slice(0, 2_000);
  const memory = MemorySchema.parse({
    id: memoryId,
    agentId: message.agentId,
    kind: "episodic",
    content,
    importance: 0.6,
    confidence: 1,
    tags: ["verbatim", message.role],
    sourceMessageIds: [],
    sourceActivityEventIds: [],
    origin: "runtime_simulation",
    namespace: message.role === "user" ? "user_model" : "character_self",
    certainty: "explicit",
    attribution:
      message.role === "user" ? "user_explicit" : "character_decision",
    stability: "situational",
    temporalMetadata: {
      mentionedAtUtc: message.createdAtUtc,
      recordedAtUtc: message.createdAtUtc,
      temporalCertainty: "exact",
      temporalStatus: "unknown",
    },
    status: "active",
    dedupeKey: ("recall:verbatim:" + message.id).slice(0, 240),
    createdAtUtc: message.createdAtUtc,
    updatedAtUtc: message.createdAtUtc,
  });
  const evidence = [
    MemoryEvidenceSchema.parse({
      id: stableId("evidence", "verbatim:" + message.id),
      memoryId,
      sourceType: "message",
      sourceId: message.id,
      quote: content,
      recordedAtUtc: message.createdAtUtc,
    }),
  ];
  return { tier: "verbatim_quote", memory, evidence };
}

function dateDigestCandidates(
  store: DatabaseStore,
  agentId: string,
  digest: DateDigest,
  nowUtc: string,
  candidateLimit: number,
  suppressedMemoryIds: readonly string[],
): HierarchyCandidate[] {
  const suppressed = new Set(suppressedMemoryIds);
  const validity = new MemoryValidityRepository(store);
  return digest.items
    .filter(
      (item) =>
        item.sourceType !== "memory" ||
        (!suppressed.has(item.sourceId) &&
          validity.readSource(agentId, "memory", item.sourceId, nowUtc) !==
            undefined),
    )
    .slice(0, candidateLimit)
    .flatMap((item): HierarchyCandidate[] => {
      const memoryId =
        item.sourceType === "memory"
          ? item.sourceId
          : stableId(
              "memory",
              "date_digest:" + item.sourceType + ":" + item.sourceId,
            );
      let evidence: MemoryEvidence[];
      if (item.sourceType === "activity_event") {
        evidence = [
          MemoryEvidenceSchema.parse({
            id: stableId(
              "evidence",
              "date_digest:" + item.sourceType + ":" + item.sourceId,
            ),
            memoryId,
            sourceType: "activity_event",
            sourceId: item.sourceId,
            contextSummary: item.content.slice(0, 1_000),
            recordedAtUtc: item.occurredStartAtUtc,
          }),
        ];
      } else if (item.sourceType === "memory") {
        const allowed = new Set(item.sourceEvidenceIds);
        const source = readMemoryEvidence(store, [item.sourceId]).find(
          (candidate) =>
            allowed.has(candidate.id) &&
            candidate.sourceType !== "schedule_event",
        );
        evidence =
          source === undefined
            ? []
            : [
                MemoryEvidenceSchema.parse({
                  ...source,
                  id: stableId(
                    "evidence",
                    "date_digest:" + item.sourceId + ":" + source.id,
                  ),
                  memoryId,
                }),
              ];
      } else {
        evidence = [];
      }
      const content = item.content.trim().slice(0, 2_000);
      if (content.length === 0) return [];
      const memory = MemorySchema.parse({
        id: memoryId,
        agentId,
        kind: item.kind === "shared_memory" ? "relationship" : "episodic",
        content,
        importance: 0.7,
        confidence: evidence.length > 0 ? 1 : 0.49,
        tags: ["date_digest", item.kind],
        sourceMessageIds: [],
        sourceActivityEventIds: [],
        origin: "runtime_simulation",
        namespace:
          item.kind === "activity_event"
            ? "runtime_simulation"
            : item.kind === "shared_memory"
              ? "shared_relationship"
              : "user_model",
        certainty: "explicit",
        attribution:
          item.kind === "activity_event"
            ? "simulation_event"
            : item.kind === "user_event"
              ? "user_explicit"
              : "mixed",
        stability: "situational",
        occurredAtUtc: item.occurredStartAtUtc,
        temporalMetadata: {
          occurredStartAtUtc: item.occurredStartAtUtc,
          ...(item.occurredEndAtUtc === undefined
            ? {}
            : { occurredEndAtUtc: item.occurredEndAtUtc }),
          recordedAtUtc: item.occurredStartAtUtc,
          temporalCertainty: "exact",
          temporalStatus: "occurred",
        },
        status: "active",
        dedupeKey: ("recall:date_digest:" + memoryId).slice(0, 240),
        createdAtUtc: item.occurredStartAtUtc,
        updatedAtUtc: nowUtc,
      });
      return [{ tier: "date_digest", memory, evidence }];
    });
}

function basicMemoryCandidates(
  store: DatabaseStore,
  agentId: string,
  query: string,
  nowUtc: string,
  candidateLimit: number,
  suppressedMemoryIds: readonly string[],
): HierarchyCandidate[] {
  const memories = readRecallCandidateRecords(store, agentId, nowUtc, {
    candidateLimit,
    query,
    keywordLimit: 50,
    suppressedMemoryIds,
  });
  return basicMemoryCandidatesFromMemories(store, memories);
}

function basicMemoryCandidatesFromMemories(
  store: DatabaseStore,
  memories: readonly Memory[],
  completeEvidence?: readonly MemoryEvidence[],
): HierarchyCandidate[] {
  const evidenceByMemory =
    completeEvidence === undefined
      ? groupEvidenceByMemory(
          readMemoryEvidence(
            store,
            memories.map((memory) => memory.id),
          ),
        )
      : groupAllEvidenceByMemory(completeEvidence);
  return memories.map((memory) => ({
    tier: "basic_memory",
    memory,
    evidence: evidenceByMemory.get(memory.id) ?? [],
  }));
}

function groupAllEvidenceByMemory(
  evidence: readonly MemoryEvidence[],
): Map<string, MemoryEvidence[]> {
  const grouped = new Map<string, MemoryEvidence[]>();
  for (const item of evidence) {
    const current = grouped.get(item.memoryId) ?? [];
    current.push(item);
    grouped.set(item.memoryId, current);
  }
  return grouped;
}

function prepareCandidates(
  store: DatabaseStore,
  agentId: string,
  query: MemoryRecallQuery,
  candidateLimit: number,
  maxEvidence: number,
  minimumScore: number,
  candidates: readonly HierarchyCandidate[],
): PreparedRecall {
  const unique = deduplicateCandidates(candidates).slice(0, candidateLimit);
  const rawEvidence = unique.flatMap((candidate) => candidate.evidence);
  const verification = verifyEvidenceSources(store, agentId, rawEvidence);
  return {
    query,
    candidateLimit,
    maxEvidence,
    minimumScore,
    memories: unique.map((candidate) => candidate.memory),
    rawEvidence,
    evidence: verification.evidence,
    evidenceRejections: verification.rejections,
  };
}

function emptyPrepared(
  query: MemoryRecallQuery,
  candidateLimit: number,
  maxEvidence: number,
  minimumScore: number,
): PreparedRecall {
  return {
    query,
    candidateLimit,
    maxEvidence,
    minimumScore,
    memories: [],
    rawEvidence: [],
    evidence: [],
    evidenceRejections: [],
  };
}

function evaluateTier(
  prepared: PreparedRecall,
  nowUtc: string,
  tier: HierarchyTier,
): MemoryRecallResult {
  const recalled = recallMemory({
    query: prepared.query,
    // Hierarchy candidates carry source ids for provenance inspection, but a
    // source id is not itself verified evidence. Strip the legacy synthesis
    // inputs here so every selected item must come from prepareCandidates'
    // verified evidence set and can be replayed from the frozen snapshot.
    memories: prepared.memories.map(withoutLegacyEvidenceFallback),
    evidence: prepared.evidence,
    nowUtc,
    minimumScore: tier === "date_digest" ? 0 : prepared.minimumScore,
    maxEvidence: prepared.maxEvidence,
  });
  return forceMode(recalled, tier);
}

function withoutLegacyEvidenceFallback(memory: Memory): Memory {
  return {
    ...memory,
    sourceMessageIds: [],
    sourceActivityEventIds: [],
  };
}

function forceMode(
  result: MemoryRecallResult,
  tier: HierarchyTier,
): MemoryRecallResult {
  if (result.abstained) return result;
  return MemoryRecallResultSchema.parse({
    ...result,
    mode: tier,
    evidenceBundle: {
      ...result.evidenceBundle,
      mode: tier,
    },
  });
}

function resultCoversExactIdentifiers(
  result: MemoryRecallResult,
  identifiers: readonly string[],
): boolean {
  if (identifiers.length === 0) return true;
  if (result.abstained) return false;

  const selectedText = result.evidenceBundle.evidence
    .flatMap((item) => [
      item.memoryContent,
      item.evidence.quote ?? "",
      item.evidence.contextSummary ?? "",
    ])
    .join("\n");
  const covered = new Set(recallExactIdentifiers(selectedText));
  return identifiers.every((identifier) => covered.has(identifier));
}

function abstainResult(reason: string, score = 0): MemoryRecallResult {
  return MemoryRecallResultSchema.parse({
    mode: "none",
    selectedMemoryIds: [],
    selectedEvidenceIds: [],
    score: roundScore(score),
    abstained: true,
    abstentionReason: reason,
  });
}

function buildInspection(input: {
  store: DatabaseStore;
  input: AgentMemoryRecallInput;
  started: number;
  prepared: PreparedRecall;
  result: MemoryRecallResult;
  finalTier: HierarchyTier | "none";
  tierByMemoryId: Map<string, HierarchyTier>;
  temporalResolution: JsonValue;
  selectorAudit?: ExplicitFactSelectorAudit;
  selectorCandidates?: readonly HierarchyCandidate[];
}): ContinuityRecallInspection {
  const selectedIds = new Set(input.result.selectedMemoryIds);
  const evidenceByMemory = groupEvidenceByMemory(input.prepared.evidence);
  const rawEvidenceByMemory = groupEvidenceByMemory(input.prepared.rawEvidence);
  const candidateBreakdowns = new Map<string, RetrievalScoreBreakdown>();
  const selectedItemByMemory = new Map(
    input.result.abstained
      ? []
      : input.result.evidenceBundle.evidence.map((item) => [
          item.memoryId,
          item,
        ]),
  );
  const candidates = input.prepared.memories.map((memory) => {
    const candidateEvidence = evidenceByMemory.get(memory.id) ?? [];
    const tier = input.tierByMemoryId.get(memory.id) ?? "event_card";
    const individual = evaluateTier(
      {
        ...input.prepared,
        memories: [memory],
        rawEvidence: rawEvidenceByMemory.get(memory.id) ?? [],
        evidence: candidateEvidence,
      },
      input.input.nowUtc,
      tier,
    );
    const diagnostic = individual.abstained
      ? forceMode(
          recallMemory({
            query: input.prepared.query,
            memories: [memory],
            evidence: candidateEvidence,
            nowUtc: input.input.nowUtc,
            minimumScore: 0,
            maxEvidence: 1,
          }),
          tier,
        )
      : individual;
    const selectedItem = selectedItemByMemory.get(memory.id);
    const breakdown =
      selectedItem?.scoreBreakdown ??
      (diagnostic.abstained
        ? zeroScoreBreakdown()
        : diagnostic.evidenceBundle.evidence[0]?.scoreBreakdown) ??
      zeroScoreBreakdown();
    candidateBreakdowns.set(memory.id, breakdown);
    const selected = selectedIds.has(memory.id);
    const rejectionReason = selected
      ? undefined
      : hierarchyRejectionReason(
          memory,
          individual,
          rawEvidenceByMemory.get(memory.id) ?? [],
          candidateEvidence,
        );
    return {
      memoryId: memory.id,
      content: memory.content,
      namespace: memory.namespace ?? "runtime_simulation",
      temporalStatus:
        (memory.temporalMetadata ?? memory.temporal)?.temporalStatus ??
        "unknown",
      evidenceIds: candidateEvidence.map((item) => item.id),
      score: selectedItem?.score ?? diagnostic.score,
      selected,
      ...(rejectionReason === undefined ? {} : { rejectionReason }),
    };
  });
  const evidenceById = new Map(
    input.prepared.evidence.map((item) => [item.id, item]),
  );
  const selectedEvidence = input.result.selectedEvidenceIds.flatMap((id) => {
    const evidence = evidenceById.get(id);
    return evidence === undefined ? [] : [evidence];
  });
  const memoryRejections: MemoryRecallPreviewRejection[] = candidates.flatMap(
    (candidate) =>
      candidate.selected || candidate.rejectionReason === undefined
        ? []
        : [
            {
              targetType: "memory",
              targetId: candidate.memoryId,
              memoryId: candidate.memoryId,
              reasonCode: candidate.rejectionReason,
              score: candidate.score,
            },
          ],
  );
  const preview = MemoryRecallPreviewResponseSchema.parse({
    agentId: input.input.agentId,
    query: input.prepared.query,
    candidateCount: input.prepared.memories.length,
    evidenceCount: input.prepared.evidence.length,
    candidates,
    selectedItems: input.result.abstained
      ? []
      : input.result.evidenceBundle.evidence,
    evidence: selectedEvidence,
    rejections: [...input.prepared.evidenceRejections, ...memoryRejections],
    strategy: {
      name:
        input.prepared.query.contextPlan?.policyVersion ??
        "continuity_hierarchy_v1",
      minimumScore: input.prepared.minimumScore,
      maxEvidence: input.prepared.maxEvidence,
      candidateLimit: input.prepared.candidateLimit,
    },
    timing: {
      evaluatedAtUtc: input.input.nowUtc,
      durationMs: roundMilliseconds(performance.now() - input.started),
    },
    result: input.result,
  });
  const hierarchy: RetrievalHierarchySnapshot = {
    finalTier: input.finalTier,
    candidateTiers: input.prepared.memories.map((memory) => ({
      memoryId: memory.id,
      tier: input.tierByMemoryId.get(memory.id) ?? "event_card",
    })),
    temporalResolution: input.temporalResolution,
    ...(input.selectorAudit === undefined
      ? {}
      : { selectorAudit: input.selectorAudit }),
    ...(input.result.abstained
      ? {
          abstentionReason: input.result.abstentionReason,
          abstentionScore: input.result.score,
        }
      : {}),
  };
  const selectorAuditInput =
    input.selectorAudit === undefined
      ? undefined
      : explicitFactSelectorInputSnapshot(
          input.store,
          input.input.agentId,
          input.selectorAudit,
          input.selectorCandidates ?? [],
          input.prepared.evidence,
        );
  return {
    preview,
    prepared: input.prepared,
    candidateBreakdowns,
    hierarchy,
    ...(selectorAuditInput === undefined ? {} : { selectorAuditInput }),
  };
}

function explicitFactSelectorInputSnapshot(
  store: DatabaseStore,
  agentId: string,
  audit: ExplicitFactSelectorAudit,
  candidates: readonly HierarchyCandidate[],
  replayEvidence: readonly MemoryEvidence[],
): ExplicitFactSelectorInputSnapshot {
  const auditedMemoryIds = new Set(
    audit.attempts.flatMap((attempt) =>
      attempt.facets.flatMap((facet) =>
        facet.candidates.map((candidate) => candidate.memoryId),
      ),
    ),
  );
  const candidatePoolScanTiers = new Set(
    audit.attempts.flatMap((attempt) =>
      attempt.outcome === "scan_truncated" &&
      attempt.scanUnit === "candidate_pool"
        ? [attempt.tier]
        : [],
    ),
  );
  const auditedEvidenceIds = new Set(
    audit.attempts.flatMap((attempt) =>
      attempt.facets.flatMap((facet) =>
        facet.candidates.flatMap((candidate) =>
          candidate.evidence.map((evidence) => evidence.evidenceId),
        ),
      ),
    ),
  );
  const candidateById = new Map<string, HierarchyCandidate>();
  const evidenceById = new Map<string, MemoryEvidence>();
  for (const candidate of candidates) {
    const existingCandidate = candidateById.get(candidate.memory.id);
    if (
      existingCandidate !== undefined &&
      (existingCandidate.tier !== candidate.tier ||
        JSON.stringify(existingCandidate.memory) !==
          JSON.stringify(candidate.memory))
    ) {
      throw new TypeError(
        "Selector audit memory ids must identify one immutable tier candidate",
      );
    }
    candidateById.set(candidate.memory.id, candidate);
    for (const evidence of candidate.evidence) {
      const existing = evidenceById.get(evidence.id);
      if (
        existing !== undefined &&
        JSON.stringify(existing) !== JSON.stringify(evidence)
      ) {
        throw new TypeError(
          "Selector audit evidence ids must identify one immutable source",
        );
      }
      evidenceById.set(evidence.id, evidence);
    }
  }
  for (const candidate of candidates) {
    if (
      (candidate.tier === "event_card" || candidate.tier === "basic_memory") &&
      candidatePoolScanTiers.has(candidate.tier)
    ) {
      auditedMemoryIds.add(candidate.memory.id);
    }
  }
  const replayEvidenceById = new Map(
    replayEvidence.map((evidence) => [evidence.id, evidence]),
  );
  const acceptedAuditEvidenceIds = new Set(
    audit.attempts.flatMap((attempt) =>
      attempt.facets.flatMap((facet) =>
        facet.candidates.flatMap((candidate) =>
          candidate.evidence.flatMap((evidence) =>
            evidence.decision === "accepted" ? [evidence.evidenceId] : [],
          ),
        ),
      ),
    ),
  );
  const memories = [...auditedMemoryIds].sort().map((memoryId) => {
    const candidate = candidateById.get(memoryId);
    if (candidate === undefined) {
      throw new TypeError(
        "Selector audit candidates must have a frozen input memory",
      );
    }
    return withoutLegacyEvidenceFallback(candidate.memory);
  });
  const candidateTiers = [...auditedMemoryIds].sort().map((memoryId) => {
    const candidate = candidateById.get(memoryId);
    if (candidate === undefined) {
      throw new TypeError(
        "Selector audit candidates must have a frozen tier assignment",
      );
    }
    if (candidate.tier !== "event_card" && candidate.tier !== "basic_memory") {
      throw new TypeError(
        "Selector audit candidates must belong to an auditable fact tier",
      );
    }
    return { memoryId, tier: candidate.tier };
  });
  const evidence = [...auditedEvidenceIds].sort().map((evidenceId) => {
    const replayItem = replayEvidenceById.get(evidenceId);
    const item = replayItem ?? evidenceById.get(evidenceId);
    if (item === undefined) {
      throw new TypeError(
        "Selector audit decisions must have frozen input evidence",
      );
    }
    if (replayItem !== undefined) return replayItem;
    const accepted = acceptedAuditEvidenceIds.has(evidenceId);
    const source = accepted
      ? (store.database
          .prepare(
            `SELECT role, content
             FROM messages WHERE id = ? AND agent_id = ?`,
          )
          .get(item.sourceId, agentId) as
          { role: string; content: string } | undefined)
      : undefined;
    const verifiedSource = source?.content.trim();
    if (
      accepted &&
      (item.sourceType !== "message" ||
        source?.role !== "user" ||
        verifiedSource === undefined ||
        verifiedSource.length === 0 ||
        verifiedSource.length > 2_000)
    ) {
      throw new TypeError(
        "Accepted selector evidence requires its verified user source snapshot",
      );
    }
    return MemoryEvidenceSchema.parse({
      id: item.id,
      memoryId: item.memoryId,
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      ...(accepted && verifiedSource !== undefined
        ? { quote: verifiedSource }
        : {}),
      recordedAtUtc: item.recordedAtUtc,
    });
  });
  return { memories, evidence, candidateTiers };
}

function hierarchyRejectionReason(
  memory: Memory,
  result: MemoryRecallResult,
  rawEvidence: readonly MemoryEvidence[],
  evidence: readonly MemoryEvidence[],
): string {
  if (memory.confidence < 0.5 || memory.certainty === "uncertain") {
    return "low_reliability";
  }
  if (rawEvidence.length > 0 && evidence.length === 0) {
    return "evidence_source_not_found";
  }
  if (evidence.length === 0) return "no_formal_evidence";
  return result.abstained ? result.abstentionReason : "selection_limit";
}

function verifyEvidenceSources(
  store: DatabaseStore,
  agentId: string,
  evidence: readonly MemoryEvidence[],
): {
  evidence: MemoryEvidence[];
  rejections: MemoryRecallPreviewRejection[];
} {
  const verified: MemoryEvidence[] = [];
  const rejections: MemoryRecallPreviewRejection[] = [];
  for (const item of evidence) {
    const reasonCode = rejectedEvidenceReason(store, agentId, item);
    if (reasonCode === undefined) {
      verified.push(item);
    } else {
      rejections.push({
        targetType: "evidence",
        targetId: item.id,
        memoryId: item.memoryId,
        reasonCode,
      });
    }
  }
  return { evidence: verified, rejections };
}

function rejectedEvidenceReason(
  store: DatabaseStore,
  agentId: string,
  evidence: MemoryEvidence,
): "evidence_source_not_found" | "unsupported_evidence_source" | undefined {
  if (evidence.sourceType === "manual") return undefined;
  if (evidence.sourceType === "schedule_event") {
    return "unsupported_evidence_source";
  }
  const source =
    evidence.sourceType === "message"
      ? store.database
          .prepare("SELECT 1 FROM messages WHERE id = ? AND agent_id = ?")
          .get(evidence.sourceId, agentId)
      : evidence.sourceType === "activity_event"
        ? store.database
            .prepare(
              "SELECT 1 FROM activity_events WHERE id = ? AND agent_id = ?",
            )
            .get(evidence.sourceId, agentId)
        : store.database
            .prepare(
              "SELECT 1 FROM character_sources WHERE id = ? AND character_id = ?",
            )
            .get(evidence.sourceId, agentId);
  return source === undefined ? "evidence_source_not_found" : undefined;
}

function memoryKindForCard(card: EventCard): Memory["kind"] {
  if (
    card.cardKind === "relationship_change" ||
    card.cardKind === "shared_experience"
  ) {
    return "relationship";
  }
  if (card.cardKind === "commitment") return "commitment";
  if (card.cardKind === "goal") return "semantic";
  return "episodic";
}

function tierMap(
  candidates: readonly HierarchyCandidate[],
): Map<string, HierarchyTier> {
  return new Map(
    deduplicateCandidates(candidates).map((candidate) => [
      candidate.memory.id,
      candidate.tier,
    ]),
  );
}

function mergeCandidates(
  prior: readonly HierarchyCandidate[],
  next: readonly HierarchyCandidate[],
  limit: number,
): HierarchyCandidate[] {
  const uniqueNext = deduplicateCandidates(next).slice(0, limit);
  const nextIds = new Set(uniqueNext.map((item) => item.memory.id));
  const uniquePrior = deduplicateCandidates(prior).filter(
    (item) => !nextIds.has(item.memory.id),
  );
  const retainedPrior = uniquePrior.slice(
    0,
    Math.max(0, limit - uniqueNext.length),
  );
  return [...retainedPrior, ...uniqueNext];
}

function deduplicateCandidates(
  candidates: readonly HierarchyCandidate[],
): HierarchyCandidate[] {
  const byId = new Map<string, HierarchyCandidate>();
  for (const candidate of candidates) {
    if (!byId.has(candidate.memory.id)) {
      byId.set(candidate.memory.id, candidate);
    }
  }
  return [...byId.values()];
}

function groupEvidenceByMemory(
  evidence: readonly MemoryEvidence[],
): Map<string, MemoryEvidence[]> {
  const grouped = new Map<string, MemoryEvidence[]>();
  for (const item of evidence) {
    const current = grouped.get(item.memoryId) ?? [];
    if (current.length < MAX_PREVIEW_EVIDENCE_IDS_PER_MEMORY) {
      current.push(item);
    }
    grouped.set(item.memoryId, current);
  }
  return grouped;
}

function isAmbiguousResolution(resolution: JsonValue): boolean {
  return (
    typeof resolution === "object" &&
    resolution !== null &&
    !Array.isArray(resolution) &&
    resolution["kind"] === "ambiguous"
  );
}

function ambiguousReason(resolution: JsonValue): string {
  if (
    typeof resolution === "object" &&
    resolution !== null &&
    !Array.isArray(resolution) &&
    typeof resolution["reasonCode"] === "string"
  ) {
    return resolution["reasonCode"];
  }
  return "ambiguous_temporal_query";
}

function isVerbatimQueryEcho(content: string, query: string): boolean {
  const normalize = (value: string) =>
    value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
  return normalize(content) === normalize(query);
}

function prepareExplicitFactVerificationRecall(input: {
  store: DatabaseStore;
  input: AgentMemoryRecallInput;
  query: MemoryRecallQuery;
  candidateLimit: number;
  maxEvidence: number;
  request: ExplicitFactVerificationRequest;
  candidates: readonly HierarchyCandidate[];
  tier: "event_card" | "basic_memory";
}): ExplicitFactRecallPreparation {
  const evaluationsByFacet = input.request.facets.map((facet) =>
    input.candidates.map((candidate) =>
      evaluateExplicitFactCandidate(
        input.store,
        input.input.agentId,
        input.input.nowUtc,
        input.query.timeRange,
        input.tier,
        facet,
        candidate,
      ),
    ),
  );
  const matchesByFacet = evaluationsByFacet.map((evaluations) =>
    evaluations
      .flatMap((evaluation) =>
        evaluation.match === undefined ? [] : [evaluation.match],
      )
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.candidate.memory.id.localeCompare(right.candidate.memory.id),
      ),
  );
  const hardConflictFacetIndexes = evaluationsByFacet.flatMap(
    (evaluations, index) =>
      evaluations.some((evaluation) => evaluation.hardConflict === true)
        ? [index]
        : [],
  );
  const facetSelection =
    hardConflictFacetIndexes.length > 0
      ? ({ status: "conflicted" } as const)
      : selectUnambiguousFactFacetMatches(matchesByFacet);
  if (facetSelection.status !== "selected") {
    const candidates = diagnosticExplicitFactCandidates(
      factMatchCandidates(matchesByFacet),
    );
    const prepared = prepareCandidates(
      input.store,
      input.input.agentId,
      input.query,
      input.candidateLimit,
      input.maxEvidence,
      input.query.minimumScore ?? DEFAULT_EXPLICIT_FACT_MINIMUM_SCORE,
      candidates,
    );
    const diagnostic = evaluateTier(prepared, input.input.nowUtc, input.tier);
    return {
      status: "rejected",
      reason:
        facetSelection.status === "conflicted"
          ? "requested_fact_facets_conflicted"
          : "requested_fact_facets_incomplete",
      score: diagnostic.score,
      prepared,
      candidates,
      audit: explicitFactAttemptAudit({
        request: input.request,
        tier: input.tier,
        outcome:
          facetSelection.status === "conflicted" ? "conflicted" : "incomplete",
        evaluationsByFacet,
        hardConflictFacetIndexes,
      }),
      matchesByFacet,
      hardConflictFacetIndexes,
    };
  }

  const candidates = minimalSelectedFactCandidates(
    facetSelection.matches,
    input.maxEvidence,
  );
  if (candidates === undefined) {
    const diagnosticCandidates = diagnosticExplicitFactCandidates(
      mergeSelectedFactCandidates(facetSelection.matches),
    );
    const prepared = prepareCandidates(
      input.store,
      input.input.agentId,
      input.query,
      input.candidateLimit,
      input.maxEvidence,
      input.query.minimumScore ?? DEFAULT_EXPLICIT_FACT_MINIMUM_SCORE,
      diagnosticCandidates,
    );
    return {
      status: "rejected",
      reason: "requested_fact_evidence_capacity_insufficient",
      score: evaluateTier(prepared, input.input.nowUtc, input.tier).score,
      prepared,
      candidates: diagnosticCandidates,
      audit: explicitFactAttemptAudit({
        request: input.request,
        tier: input.tier,
        outcome: "capacity_insufficient",
        evaluationsByFacet,
        provisionalMatches: facetSelection.matches,
        selectedEvidenceIds: [],
        hardConflictFacetIndexes,
      }),
      matchesByFacet,
      hardConflictFacetIndexes,
    };
  }
  const threshold =
    input.query.minimumScore ?? DEFAULT_EXPLICIT_FACT_MINIMUM_SCORE;
  const prepared = prepareCandidates(
    input.store,
    input.input.agentId,
    input.query,
    input.candidateLimit,
    input.maxEvidence,
    threshold,
    candidates,
  );
  const evaluatedResult = evaluateTier(
    prepared,
    input.input.nowUtc,
    input.tier,
  );
  if (evaluatedResult.abstained) {
    return {
      status: "rejected",
      reason:
        input.query.minimumScore === undefined
          ? "requested_fact_facets_incomplete"
          : "requested_fact_below_caller_threshold",
      score: evaluatedResult.score,
      prepared,
      candidates,
      audit: explicitFactAttemptAudit({
        request: input.request,
        tier: input.tier,
        outcome:
          input.query.minimumScore === undefined
            ? "incomplete"
            : "below_threshold",
        evaluationsByFacet,
        provisionalMatches: facetSelection.matches,
        selectedEvidenceIds: candidates.flatMap((candidate) =>
          candidate.evidence.map((evidence) => evidence.id),
        ),
        hardConflictFacetIndexes,
      }),
      matchesByFacet,
      hardConflictFacetIndexes,
    };
  }
  const result = completeExplicitFactEvidenceResult(
    evaluatedResult,
    candidates,
  );
  if (result === undefined) {
    return {
      status: "rejected",
      reason: "requested_fact_facets_incomplete",
      score: evaluatedResult.score,
      prepared,
      candidates,
      audit: explicitFactAttemptAudit({
        request: input.request,
        tier: input.tier,
        outcome: "incomplete",
        evaluationsByFacet,
        provisionalMatches: facetSelection.matches,
        selectedEvidenceIds: candidates.flatMap((candidate) =>
          candidate.evidence.map((evidence) => evidence.id),
        ),
        hardConflictFacetIndexes,
      }),
      matchesByFacet,
      hardConflictFacetIndexes,
    };
  }
  if (
    result.selectedMemoryIds.length !== candidates.length ||
    !candidates.every((candidate) =>
      result.selectedMemoryIds.includes(candidate.memory.id),
    ) ||
    !resultCoversExactIdentifiers(
      result,
      recallExactIdentifiers(input.query.query),
    )
  ) {
    return {
      status: "rejected",
      reason: "requested_fact_facets_incomplete",
      score: result.score,
      prepared,
      candidates,
      audit: explicitFactAttemptAudit({
        request: input.request,
        tier: input.tier,
        outcome: "incomplete",
        evaluationsByFacet,
        provisionalMatches: facetSelection.matches,
        selectedEvidenceIds: candidates.flatMap((candidate) =>
          candidate.evidence.map((evidence) => evidence.id),
        ),
        hardConflictFacetIndexes,
      }),
      matchesByFacet,
      hardConflictFacetIndexes,
    };
  }
  return {
    status: "selected",
    selection: { prepared, result, candidates },
    audit: explicitFactAttemptAudit({
      request: input.request,
      tier: input.tier,
      outcome: "selected",
      evaluationsByFacet,
      selectedMatches: facetSelection.matches,
      selectedEvidenceIds: candidates.flatMap((candidate) =>
        candidate.evidence.map((evidence) => evidence.id),
      ),
      hardConflictFacetIndexes,
    }),
    matchesByFacet,
    hardConflictFacetIndexes,
  };
}

function completeExplicitFactEvidenceResult(
  result: MemoryRecallResult,
  candidates: readonly HierarchyCandidate[],
): MemoryRecallResult | undefined {
  if (result.abstained) return undefined;
  const selectedByMemoryId = new Map(
    result.evidenceBundle.evidence.map((item) => [item.memoryId, item]),
  );
  const completeEvidence = candidates.flatMap((candidate) => {
    const selected = selectedByMemoryId.get(candidate.memory.id);
    if (selected === undefined) return [];
    return candidate.evidence.map((evidence) => ({
      ...selected,
      evidence,
    }));
  });
  const expectedEvidenceIds = new Set(
    candidates.flatMap((candidate) =>
      candidate.evidence.map((evidence) => evidence.id),
    ),
  );
  if (
    completeEvidence.length !== expectedEvidenceIds.size ||
    completeEvidence.some((item) => !expectedEvidenceIds.has(item.evidence.id))
  ) {
    return undefined;
  }
  return MemoryRecallResultSchema.parse({
    ...result,
    selectedMemoryIds: [
      ...new Set(completeEvidence.map((item) => item.memoryId)),
    ],
    selectedEvidenceIds: completeEvidence.map((item) => item.evidence.id),
    evidenceBundle: {
      ...result.evidenceBundle,
      evidence: completeEvidence,
    },
  });
}

function explicitFactAttemptAudit(input: {
  request: ExplicitFactVerificationRequest;
  tier: "event_card" | "basic_memory";
  outcome: ExplicitFactSelectorAttemptAudit["outcome"];
  evaluationsByFacet: readonly (readonly FactCandidateEvaluation[])[];
  selectedMatches?: readonly FactFacetCandidateMatch[];
  provisionalMatches?: readonly FactFacetCandidateMatch[];
  selectedEvidenceIds?: readonly string[];
  hardConflictFacetIndexes: readonly number[];
}): ExplicitFactSelectorAttemptAudit {
  const selectedEvidenceIds = new Set(input.selectedEvidenceIds ?? []);
  const coverageByEvidenceId = new Map<string, Set<number>>();
  (input.selectedMatches ?? input.provisionalMatches ?? []).forEach(
    (match, facetIndex) => {
      for (const evidence of match.evidence) {
        const covered = coverageByEvidenceId.get(evidence.id) ?? new Set();
        covered.add(facetIndex);
        coverageByEvidenceId.set(evidence.id, covered);
      }
    },
  );
  const representativeByCoverage = new Map<string, string>();
  for (const [evidenceId, facetIndexes] of coverageByEvidenceId) {
    const coverageKey = [...facetIndexes]
      .sort((left, right) => left - right)
      .join(",");
    const previous = representativeByCoverage.get(coverageKey);
    if (previous === undefined || evidenceId.localeCompare(previous) < 0) {
      representativeByCoverage.set(coverageKey, evidenceId);
    }
  }
  const coverageRepresentativeIds = new Set(representativeByCoverage.values());
  return {
    tier: input.tier,
    outcome: input.outcome,
    scannedCandidateCount: input.evaluationsByFacet[0]?.length ?? 0,
    facets: input.request.facets.map((facet, index) => {
      const evaluations = input.evaluationsByFacet[index] ?? [];
      const matches = evaluations.flatMap((evaluation) =>
        evaluation.match === undefined ? [] : [evaluation.match],
      );
      const valueGroups = factValueGroupIds(matches);
      const selected = input.selectedMatches?.[index];
      const provisional = input.provisionalMatches?.[index];
      const facetOutcome = input.hardConflictFacetIndexes.includes(index)
        ? "conflicted"
        : matches.length === 0
          ? "missing"
          : new Set(matches.map((match) => match.valueKey)).size > 1
            ? "conflicted"
            : "selected";
      return {
        index,
        kind: facet.kind,
        request: explicitFactAuditFacetDescriptor(facet),
        outcome: facetOutcome,
        candidates: evaluations.map((evaluation) => {
          const match = evaluation.match;
          const isSelected =
            input.outcome === "selected" &&
            selected !== undefined &&
            match?.candidate.memory.id === selected.candidate.memory.id;
          const isProvisional =
            !isSelected &&
            provisional !== undefined &&
            match?.candidate.memory.id === provisional.candidate.memory.id;
          const orderedEvidence = [...evaluation.evidence].sort(
            (left, right) =>
              Number(selectedEvidenceIds.has(right.evidenceId)) -
                Number(selectedEvidenceIds.has(left.evidenceId)) ||
              Number(coverageRepresentativeIds.has(right.evidenceId)) -
                Number(coverageRepresentativeIds.has(left.evidenceId)) ||
              Number(
                evaluation.hardConflict === true &&
                  right.reasonCode === "fact_evidence_value_conflict",
              ) -
                Number(
                  evaluation.hardConflict === true &&
                    left.reasonCode === "fact_evidence_value_conflict",
                ) ||
              Number(right.decision === "accepted") -
                Number(left.decision === "accepted") ||
              left.evidenceId.localeCompare(right.evidenceId),
          );
          const auditedEvidence = orderedEvidence.slice(
            0,
            MAX_PREVIEW_EVIDENCE_IDS_PER_MEMORY,
          );
          return {
            memoryId: evaluation.candidate.memory.id,
            decision: isSelected ? "selected" : "rejected",
            reasonCode: isSelected
              ? "fact_candidate_selected"
              : isProvisional
                ? "fact_candidate_provisional_winner"
                : match === undefined
                  ? evaluation.reasonCode
                  : facetOutcome === "conflicted"
                    ? "fact_candidate_value_conflict"
                    : "fact_candidate_lower_ranked",
            ...(match === undefined
              ? {}
              : { valueGroupId: valueGroups.get(match.valueKey) }),
            evidence: auditedEvidence,
            ...(orderedEvidence.length === auditedEvidence.length
              ? {}
              : {
                  evidenceOmittedCount:
                    orderedEvidence.length - auditedEvidence.length,
                }),
          };
        }),
      };
    }),
  };
}

function factValueGroupIds(
  matches: readonly FactFacetCandidateMatch[],
): Map<string, string> {
  const groups = new Map<string, FactFacetCandidateMatch[]>();
  for (const match of matches) {
    const group = groups.get(match.valueKey) ?? [];
    group.push(match);
    groups.set(match.valueKey, group);
  }
  const ordered = [...groups.entries()].sort((left, right) => {
    const leftKey = left[1].map((match) => match.candidate.memory.id).sort()[0];
    const rightKey = right[1]
      .map((match) => match.candidate.memory.id)
      .sort()[0];
    return (leftKey ?? "").localeCompare(rightKey ?? "");
  });
  return new Map(
    ordered.map(([valueKey], index) => [valueKey, `value_${index + 1}`]),
  );
}

function explicitFactSelectorAudit(input: {
  request: ExplicitFactVerificationRequest;
  outcome: ExplicitFactSelectorAudit["outcome"];
  attempts: ExplicitFactSelectorAttemptAudit[];
  replayEvidenceIds: readonly string[];
  matchesByAttempt?: readonly (readonly (readonly FactFacetCandidateMatch[])[])[];
}): ExplicitFactSelectorAudit {
  const globalValueGroups = input.request.facets.map((_facet, facetIndex) =>
    factValueGroupIds(
      (input.matchesByAttempt ?? []).flatMap(
        (matchesByFacet) => matchesByFacet[facetIndex] ?? [],
      ),
    ),
  );
  const attempts = input.attempts.map((attempt, attemptIndex) => ({
    ...attempt,
    facets: attempt.facets.map((facet, facetIndex) => {
      const valueKeyByMemoryId = new Map(
        (input.matchesByAttempt?.[attemptIndex]?.[facetIndex] ?? []).map(
          (match) => [match.candidate.memory.id, match.valueKey],
        ),
      );
      return {
        ...facet,
        candidates: facet.candidates.map((candidate) => {
          if (candidate.valueGroupId === undefined) return candidate;
          const valueKey = valueKeyByMemoryId.get(candidate.memoryId);
          const valueGroupId =
            valueKey === undefined
              ? undefined
              : globalValueGroups[facetIndex]?.get(valueKey);
          if (valueGroupId === undefined) {
            throw new TypeError(
              "Selector audit value groups require a matching canonical fact value",
            );
          }
          return { ...candidate, valueGroupId };
        }),
      };
    }),
  }));
  return {
    policy: "explicit_fact_checklist_v1",
    expectedFacetCount: input.request.expectedFacetCount,
    outcome: input.outcome,
    scanLimit: EXPLICIT_FACT_SAFETY_SCAN_LIMIT,
    scanTruncated: attempts.some(
      (attempt) => attempt.outcome === "scan_truncated",
    ),
    replayEvidenceIds: [...input.replayEvidenceIds],
    attempts,
  };
}

function combinedExplicitFactRejection(
  preparations: readonly ExplicitFactRecallPreparation[],
): {
  reason: Extract<
    ExplicitFactRecallPreparation,
    { status: "rejected" }
  >["reason"];
  outcome: Exclude<ExplicitFactSelectorAudit["outcome"], "selected">;
  score: number;
} {
  const rejected = preparations.filter(
    (
      preparation,
    ): preparation is Extract<
      ExplicitFactRecallPreparation,
      { status: "rejected" }
    > => preparation.status === "rejected",
  );
  const priority = [
    "requested_fact_facets_conflicted",
    "requested_fact_scan_truncated",
    "requested_fact_evidence_capacity_insufficient",
    "requested_fact_below_caller_threshold",
    "requested_fact_facets_incomplete",
  ] as const;
  const reason =
    priority.find((candidate) =>
      rejected.some((preparation) => preparation.reason === candidate),
    ) ?? "requested_fact_facets_incomplete";
  const matching = rejected.filter(
    (preparation) => preparation.reason === reason,
  );
  return {
    reason,
    outcome:
      reason === "requested_fact_facets_conflicted"
        ? "conflicted"
        : reason === "requested_fact_scan_truncated"
          ? "scan_truncated"
          : reason === "requested_fact_evidence_capacity_insufficient"
            ? "capacity_insufficient"
            : reason === "requested_fact_below_caller_threshold"
              ? "below_threshold"
              : "incomplete",
    score: Math.max(0, ...matching.map((preparation) => preparation.score)),
  };
}

function strongestExplicitFactAttemptRejection(
  attempts: readonly ExplicitFactSelectorAttemptAudit[],
): {
  outcome: Exclude<ExplicitFactSelectorAudit["outcome"], "selected">;
  reason:
    | "requested_fact_facets_conflicted"
    | "requested_fact_scan_truncated"
    | "requested_fact_evidence_capacity_insufficient"
    | "requested_fact_below_caller_threshold"
    | "requested_fact_facets_incomplete";
} {
  const priority = [
    {
      outcome: "conflicted",
      reason: "requested_fact_facets_conflicted",
    },
    {
      outcome: "scan_truncated",
      reason: "requested_fact_scan_truncated",
    },
    {
      outcome: "capacity_insufficient",
      reason: "requested_fact_evidence_capacity_insufficient",
    },
    {
      outcome: "below_threshold",
      reason: "requested_fact_below_caller_threshold",
    },
    {
      outcome: "incomplete",
      reason: "requested_fact_facets_incomplete",
    },
  ] as const;
  return (
    priority.find(({ outcome }) =>
      attempts.some((attempt) => attempt.outcome === outcome),
    ) ?? priority[priority.length - 1]!
  );
}

function explicitFactPreparationScore(
  preparation: ExplicitFactRecallPreparation,
): number {
  return preparation.status === "selected"
    ? preparation.selection.result.score
    : preparation.score;
}

function factConflictFacetIndexes(
  matchesByFacet: readonly (readonly FactFacetCandidateMatch[])[],
): number[] {
  return matchesByFacet.flatMap((matches, index) =>
    new Set(matches.map((match) => match.valueKey)).size > 1 ? [index] : [],
  );
}

function blockSelectedExplicitFactAttemptAudit(
  audit: ExplicitFactSelectorAttemptAudit,
  selectedReasonCode: ExplicitFactSelectorCandidateReason,
): ExplicitFactSelectorAttemptAudit {
  if (audit.outcome !== "selected") return audit;
  return {
    ...audit,
    outcome: "incomplete",
    facets: audit.facets.map((facet) => ({
      ...facet,
      candidates: facet.candidates.map((candidate) => ({
        ...candidate,
        decision: "rejected",
        reasonCode:
          candidate.decision === "selected"
            ? selectedReasonCode
            : candidate.reasonCode,
      })),
    })),
  };
}

function consistentNotSelectedFactAttemptAudit(
  audit: ExplicitFactSelectorAttemptAudit,
): ExplicitFactSelectorAttemptAudit {
  if (audit.facets.some((facet) => facet.outcome !== "selected")) return audit;
  return {
    ...audit,
    outcome: "consistent_not_selected",
    facets: audit.facets.map((facet) => ({
      ...facet,
      candidates: facet.candidates.map((candidate) => ({
        ...candidate,
        decision: "rejected",
        reasonCode:
          candidate.valueGroupId === undefined
            ? candidate.reasonCode
            : "fact_candidate_same_value_shadowed_by_event_card",
      })),
    })),
  };
}

function completeNotSelectedFactAttemptAudit(
  audit: ExplicitFactSelectorAttemptAudit,
): ExplicitFactSelectorAttemptAudit {
  if (audit.outcome !== "selected") return audit;
  return {
    ...audit,
    outcome: "complete_not_selected",
    facets: audit.facets.map((facet) => ({
      ...facet,
      candidates: facet.candidates.map((candidate) => ({
        ...candidate,
        decision: "rejected",
        reasonCode:
          candidate.decision === "selected"
            ? "fact_candidate_rejected_due_higher_tier_failure"
            : candidate.reasonCode,
      })),
    })),
  };
}

function markExplicitFactConflictAttempts(
  preparations: readonly ExplicitFactRecallPreparation[],
  combinedMatchesByFacet: readonly (readonly FactFacetCandidateMatch[])[],
  conflictingFacetIndexes: readonly number[],
): ExplicitFactSelectorAttemptAudit[] {
  const conflictIndexes = new Set(conflictingFacetIndexes);
  const globalValueGroups = combinedMatchesByFacet.map(factValueGroupIds);
  return preparations.map((preparation) => {
    const attemptHasConflict = conflictingFacetIndexes.some(
      (index) =>
        (preparation.matchesByFacet[index]?.length ?? 0) > 0 ||
        preparation.hardConflictFacetIndexes.includes(index),
    );
    return {
      ...preparation.audit,
      outcome: attemptHasConflict
        ? "conflicted"
        : preparation.audit.outcome === "selected"
          ? "incomplete"
          : preparation.audit.outcome,
      facets: preparation.audit.facets.map((facet, index) => {
        const matches = preparation.matchesByFacet[index] ?? [];
        const valueKeyByMemoryId = new Map(
          matches.map((match) => [match.candidate.memory.id, match.valueKey]),
        );
        const isConflicted =
          conflictIndexes.has(index) &&
          (valueKeyByMemoryId.size > 0 ||
            preparation.hardConflictFacetIndexes.includes(index));
        return {
          ...facet,
          outcome: isConflicted ? "conflicted" : facet.outcome,
          candidates: facet.candidates.map((candidate) => {
            const valueKey = valueKeyByMemoryId.get(candidate.memoryId);
            return {
              ...candidate,
              decision: "rejected",
              reasonCode:
                isConflicted && valueKey !== undefined
                  ? "fact_candidate_value_conflict"
                  : candidate.decision === "selected"
                    ? "fact_candidate_rejected_due_atomic_conflict"
                    : candidate.reasonCode,
              ...(valueKey === undefined
                ? {}
                : {
                    valueGroupId: globalValueGroups[index]?.get(valueKey),
                  }),
            };
          }),
        };
      }),
    };
  });
}

function truncatedExplicitFactAttemptAudit(
  request: ExplicitFactVerificationRequest,
  tier: "event_card" | "basic_memory",
  scannedCandidateCount: number,
  scanUnit: "candidate_pool" | "evidence_per_memory",
  scanLimit: number,
  truncatedMemoryIds?: readonly string[],
  scanWitnessMemoryId?: string,
): ExplicitFactSelectorAttemptAudit {
  return {
    tier,
    outcome: "scan_truncated",
    scannedCandidateCount,
    scanUnit,
    scanLimit,
    ...(scanWitnessMemoryId === undefined ? {} : { scanWitnessMemoryId }),
    ...(truncatedMemoryIds === undefined
      ? {}
      : { truncatedMemoryIds: [...truncatedMemoryIds].sort() }),
    facets: request.facets.map((facet, index) => ({
      index,
      kind: facet.kind,
      request: explicitFactAuditFacetDescriptor(facet),
      outcome: "missing",
      candidates: (truncatedMemoryIds ?? []).map((memoryId) => ({
        memoryId,
        decision: "rejected",
        reasonCode: "fact_candidate_evidence_scan_truncated",
        evidence: [],
      })),
    })),
  };
}

function explicitFactAuditFacetDescriptor(
  facet: ExplicitFactFacet,
): ExplicitFactFacetDescriptor {
  return facet.kind === "beverage_preference"
    ? { kind: facet.kind, selector: facet.selector }
    : { kind: facet.kind, entity: facet.entity };
}

function diagnosticExplicitFactCandidates(
  candidates: readonly HierarchyCandidate[],
): HierarchyCandidate[] {
  const evidenceByCandidate = candidates.map((candidate) =>
    [...candidate.evidence]
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, MAX_PREVIEW_EVIDENCE_IDS_PER_MEMORY),
  );
  const selectedIds = new Set<string>();
  for (
    let evidenceIndex = 0;
    selectedIds.size < MAX_EXPLICIT_FACT_DIAGNOSTIC_EVIDENCE &&
    evidenceByCandidate.some((evidence) => evidenceIndex < evidence.length);
    evidenceIndex += 1
  ) {
    for (const evidence of evidenceByCandidate) {
      const item = evidence[evidenceIndex];
      if (item === undefined) continue;
      selectedIds.add(item.id);
      if (selectedIds.size >= MAX_EXPLICIT_FACT_DIAGNOSTIC_EVIDENCE) break;
    }
  }
  return candidates.map((candidate, index) => ({
    ...candidate,
    evidence:
      evidenceByCandidate[index]?.filter((evidence) =>
        selectedIds.has(evidence.id),
      ) ?? [],
  }));
}

function diagnosticPreparedRecall(prepared: PreparedRecall): PreparedRecall {
  const evidenceIds = new Set(
    diagnosticExplicitFactCandidates(
      prepared.memories.map((memory) => ({
        tier: "basic_memory" as const,
        memory,
        evidence: prepared.rawEvidence.filter(
          (evidence) => evidence.memoryId === memory.id,
        ),
      })),
    ).flatMap((candidate) => candidate.evidence.map((evidence) => evidence.id)),
  );
  return {
    ...prepared,
    rawEvidence: prepared.rawEvidence.filter((item) =>
      evidenceIds.has(item.id),
    ),
    evidence: prepared.evidence.filter((item) => evidenceIds.has(item.id)),
  };
}

function minimalSelectedFactCandidates(
  matches: readonly FactFacetCandidateMatch[],
  maxEvidence: number,
): HierarchyCandidate[] | undefined {
  const evidenceCoverage = new Map<
    string,
    {
      evidence: MemoryEvidence;
      memoryId: string;
      facetIndexes: Set<number>;
    }
  >();
  matches.forEach((match, facetIndex) => {
    for (const evidence of match.evidence) {
      const existing = evidenceCoverage.get(evidence.id);
      if (
        existing !== undefined &&
        existing.memoryId !== match.candidate.memory.id
      ) {
        return;
      }
      const entry = existing ?? {
        evidence,
        memoryId: match.candidate.memory.id,
        facetIndexes: new Set<number>(),
      };
      entry.facetIndexes.add(facetIndex);
      evidenceCoverage.set(evidence.id, entry);
    }
  });

  const uncovered = new Set(matches.map((_match, index) => index));
  const selectedEvidence = new Set<string>();
  while (uncovered.size > 0 && selectedEvidence.size < maxEvidence) {
    const next = [...evidenceCoverage.entries()]
      .filter(([id]) => !selectedEvidence.has(id))
      .map(([id, entry]) => ({
        id,
        entry,
        newlyCovered: [...entry.facetIndexes].filter((index) =>
          uncovered.has(index),
        ).length,
      }))
      .filter((item) => item.newlyCovered > 0)
      .sort(
        (left, right) =>
          right.newlyCovered - left.newlyCovered ||
          left.id.localeCompare(right.id),
      )[0];
    if (next === undefined) break;
    selectedEvidence.add(next.id);
    for (const index of next.entry.facetIndexes) uncovered.delete(index);
  }
  if (uncovered.size > 0) return undefined;

  const selectedCandidates = new Map<string, HierarchyCandidate>();
  for (const match of matches) {
    const existing = selectedCandidates.get(match.candidate.memory.id);
    const selectedForCandidate = match.evidence.filter((evidence) =>
      selectedEvidence.has(evidence.id),
    );
    const evidence = new Map(
      [...(existing?.evidence ?? []), ...selectedForCandidate].map((item) => [
        item.id,
        item,
      ]),
    );
    selectedCandidates.set(match.candidate.memory.id, {
      ...match.candidate,
      evidence: [...evidence.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    });
  }
  const candidates = [...selectedCandidates.values()];
  return candidates.every((candidate) => candidate.evidence.length > 0)
    ? candidates
    : undefined;
}

function mergeSelectedFactCandidates(
  matches: readonly FactFacetCandidateMatch[],
): HierarchyCandidate[] {
  const selected = new Map<string, HierarchyCandidate>();
  for (const match of matches) {
    const existing = selected.get(match.candidate.memory.id);
    const evidence = new Map(
      [...(existing?.evidence ?? []), ...match.evidence].map((item) => [
        item.id,
        item,
      ]),
    );
    selected.set(match.candidate.memory.id, {
      ...match.candidate,
      evidence: [...evidence.values()].sort((left, right) =>
        left.id.localeCompare(right.id),
      ),
    });
  }
  return [...selected.values()];
}

function factMatchCandidates(
  matchesByFacet: readonly (readonly FactFacetCandidateMatch[])[],
): HierarchyCandidate[] {
  return deduplicateCandidates(
    matchesByFacet.flatMap((matches) =>
      matches.map((match) => ({
        ...match.candidate,
        evidence: match.evidence,
      })),
    ),
  );
}

function evaluateExplicitFactCandidate(
  store: DatabaseStore,
  agentId: string,
  nowUtc: string,
  timeRange: MemoryRecallQuery["timeRange"],
  tier: "event_card" | "basic_memory",
  facet: ExplicitFactFacet,
  candidate: HierarchyCandidate,
): FactCandidateEvaluation {
  const memory = candidate.memory;
  const ineligibleReason = explicitFactMemoryIneligibilityReason(
    memory,
    tier,
    nowUtc,
    timeRange,
  );
  if (ineligibleReason !== undefined) {
    return {
      candidate,
      reasonCode: ineligibleReason,
      evidence: [],
    };
  }
  const valueResolution = explicitFactValueResolution(memory.content, facet);
  if (valueResolution.kind !== "resolved") {
    return {
      candidate,
      ...(valueResolution.kind === "conflicted" ? { hardConflict: true } : {}),
      reasonCode:
        valueResolution.kind === "conflicted"
          ? "fact_candidate_value_conflicted"
          : "fact_candidate_value_unparseable",
      evidence: [],
    };
  }
  const valueKey = valueResolution.valueKey;
  const evidenceResolution = matchingUserFactEvidence(
    store,
    agentId,
    nowUtc,
    facet,
    valueKey,
    candidate.evidence,
  );
  if (
    evidenceResolution.conflicted ||
    evidenceResolution.evidence.length === 0
  ) {
    return {
      candidate,
      hardConflict: evidenceResolution.conflicted,
      reasonCode: evidenceResolution.conflicted
        ? "fact_candidate_evidence_conflicted"
        : "fact_candidate_evidence_not_verified",
      evidence: evidenceResolution.audit,
    };
  }

  const score = explicitFactCandidateScore(memory, facet);
  return {
    candidate,
    match: {
      candidate,
      evidence: evidenceResolution.evidence,
      valueKey,
      score,
    },
    reasonCode: "fact_candidate_eligible",
    evidence: evidenceResolution.audit,
  };
}

function explicitFactMemoryIneligibilityReason(
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
  if (!memoryExistedAtRecall(memory, nowUtc)) {
    return "fact_candidate_future";
  }
  if (!memoryMatchesExplicitFactTimeRange(memory, timeRange)) {
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

function memoryMatchesExplicitFactTimeRange(
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
  return (
    startAtUtc !== undefined &&
    overlapsRange(startAtUtc, endAtUtc, {
      fromUtc: range.fromUtc,
      toUtc: range.toUtc,
    })
  );
}

function memoryExistedAtRecall(memory: Memory, nowUtc: string): boolean {
  const recallAt = Date.parse(nowUtc);
  const recordedAt = memory.temporalMetadata?.recordedAtUtc;
  return (
    Number.isFinite(recallAt) &&
    [
      memory.createdAtUtc,
      memory.updatedAtUtc,
      memory.lifecycleUpdatedAtUtc,
      memory.lastReinforcedAtUtc,
      recordedAt,
    ]
      .filter((value): value is string => value !== undefined)
      .every((value) => Date.parse(value) <= recallAt)
  );
}

function matchingUserFactEvidence(
  store: DatabaseStore,
  agentId: string,
  nowUtc: string,
  facet: ExplicitFactFacet,
  expectedValueKey: string,
  evidence: readonly MemoryEvidence[],
): {
  evidence: MemoryEvidence[];
  audit: FactEvidenceDecisionAudit[];
  conflicted: boolean;
} {
  const recallAt = Date.parse(nowUtc);
  const accepted: MemoryEvidence[] = [];
  const audit: FactEvidenceDecisionAudit[] = [];
  let conflicted = false;
  for (const item of evidence) {
    let reasonCode: ExplicitFactSelectorEvidenceReason | undefined;
    if (item.sourceType !== "message") {
      reasonCode = "fact_evidence_unsupported_source";
    } else if (Date.parse(item.recordedAtUtc) > recallAt) {
      reasonCode = "fact_evidence_future";
    }
    const source =
      reasonCode === undefined
        ? (store.database
            .prepare(
              `SELECT role, content, created_at_utc AS createdAtUtc
               FROM messages WHERE id = ? AND agent_id = ?`,
            )
            .get(item.sourceId, agentId) as
            { role: string; content: string; createdAtUtc: string } | undefined)
        : undefined;
    const completeSource = source?.content.trim();
    if (reasonCode === undefined && source === undefined) {
      reasonCode = "fact_evidence_source_missing";
    } else if (reasonCode === undefined && source?.role !== "user") {
      reasonCode = "fact_evidence_source_not_user";
    } else if (
      reasonCode === undefined &&
      (completeSource === undefined ||
        completeSource.length === 0 ||
        completeSource.length > 2_000)
    ) {
      reasonCode = "fact_evidence_source_not_snapshot_safe";
    } else if (
      reasonCode === undefined &&
      source !== undefined &&
      Date.parse(source.createdAtUtc) > recallAt
    ) {
      reasonCode = "fact_evidence_future";
    } else if (
      reasonCode === undefined &&
      item.quote !== undefined &&
      completeSource !== undefined &&
      !isGroundedEvidenceExcerpt(completeSource, item.quote)
    ) {
      reasonCode = "fact_evidence_quote_not_grounded";
    } else if (
      reasonCode === undefined &&
      completeSource !== undefined &&
      !isFactBearingUserStatement(completeSource)
    ) {
      reasonCode = "fact_evidence_not_assertive";
    } else if (reasonCode === undefined && completeSource !== undefined) {
      const sourceValue = explicitFactValueResolution(completeSource, facet);
      if (
        sourceValue.kind !== "resolved" ||
        sourceValue.valueKey !== expectedValueKey
      ) {
        if (
          sourceValue.kind === "conflicted" ||
          (sourceValue.kind === "resolved" &&
            sourceValue.valueKey !== expectedValueKey)
        ) {
          conflicted = true;
        }
        reasonCode =
          sourceValue.kind === "none"
            ? "fact_evidence_value_mismatch"
            : "fact_evidence_value_conflict";
      }
    }
    if (reasonCode !== undefined || completeSource === undefined) {
      audit.push({
        evidenceId: item.id,
        decision: "rejected",
        reasonCode: reasonCode ?? "fact_evidence_source_missing",
      });
      continue;
    }
    // Legacy rows may have no quote or a benign excerpt. The immutable row
    // remains untouched; only the complete, verified user source is carried
    // into this recall snapshot so surrounding negation cannot be hidden.
    accepted.push(
      MemoryEvidenceSchema.parse({
        id: item.id,
        memoryId: item.memoryId,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        quote: completeSource,
        recordedAtUtc: item.recordedAtUtc,
      }),
    );
    audit.push({
      evidenceId: item.id,
      decision: "accepted",
      reasonCode: "fact_evidence_accepted",
    });
  }
  return {
    evidence: accepted.sort((left, right) => left.id.localeCompare(right.id)),
    audit: audit.sort((left, right) =>
      left.evidenceId.localeCompare(right.evidenceId),
    ),
    conflicted,
  };
}

function selectUnambiguousFactFacetMatches(
  matchesByFacet: readonly (readonly FactFacetCandidateMatch[])[],
): FactFacetMatchSelection {
  const selected: FactFacetCandidateMatch[] = [];
  for (const matches of matchesByFacet) {
    if (matches.length === 0) return { status: "incomplete" };
    const valueGroups = new Map<string, FactFacetCandidateMatch[]>();
    for (const match of matches) {
      const group = valueGroups.get(match.valueKey) ?? [];
      group.push(match);
      valueGroups.set(match.valueKey, group);
    }
    if (valueGroups.size > 1) return { status: "conflicted" };
    const best = [...(valueGroups.values().next().value ?? [])].sort(
      (left, right) =>
        right.score - left.score ||
        right.candidate.memory.confidence - left.candidate.memory.confidence ||
        left.candidate.memory.id.localeCompare(right.candidate.memory.id),
    )[0];
    if (best === undefined) return { status: "incomplete" };
    selected.push(best);
  }
  return { status: "selected", matches: selected };
}

function isLinkedFriendDestinationIntent(query: string): boolean {
  const normalized = query.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return (
    /(?:朋友).{0,16}(?:叫(?:什么|谁)|是谁)/u.test(normalized) &&
    /(?:她|他|这个人|朋友).{0,16}(?:准备|打算|计划)?.{0,8}(?:去哪里|去哪儿|目的地)/u.test(
      normalized,
    )
  );
}

function prepareLinkedFriendDestinationRecall(input: {
  store: DatabaseStore;
  input: AgentMemoryRecallInput;
  query: MemoryRecallQuery;
  candidateLimit: number;
  maxEvidence: number;
  candidates: readonly HierarchyCandidate[];
}): PreparedTierSelection | undefined {
  if (input.maxEvidence < 2) return undefined;
  const identities = new Map<string, HierarchyCandidate>();
  const destinations = new Map<string, HierarchyCandidate>();
  for (const candidate of input.candidates) {
    if (
      candidate.memory.status !== "active" ||
      candidate.memory.supersededById !== undefined ||
      candidate.memory.mergedIntoId !== undefined ||
      !hasUserMessageEvidence(input.store, input.input.agentId, candidate)
    ) {
      continue;
    }
    const claim = candidate.memory.claim;
    if (claim === undefined || claim.disposition !== "affirmed") continue;
    const subjectKey = claim.subjectKey;
    const identity = /^user_fact:relationship:(.+)$/u.exec(subjectKey)?.[1];
    if (identity !== undefined && !identities.has(identity)) {
      identities.set(identity, candidate);
      continue;
    }
    const destination = /^user_fact:person:(.+):destination$/u.exec(
      subjectKey,
    )?.[1];
    if (destination !== undefined && !destinations.has(destination)) {
      destinations.set(destination, candidate);
    }
  }

  const threshold =
    input.query.minimumScore ?? DEFAULT_LINKED_CLAIM_MINIMUM_SCORE;
  let best:
    | (PreparedTierSelection & {
        combinedScore: number;
      })
    | undefined;
  for (const [person, identity] of identities) {
    const destination = destinations.get(person);
    if (destination === undefined) continue;
    const candidates = [identity, destination];
    const prepared = prepareCandidates(
      input.store,
      input.input.agentId,
      input.query,
      input.candidateLimit,
      input.maxEvidence,
      threshold,
      candidates,
    );
    const result = evaluateTier(prepared, input.input.nowUtc, "basic_memory");
    if (
      result.abstained ||
      !candidates.every((candidate) =>
        result.selectedMemoryIds.includes(candidate.memory.id),
      )
    ) {
      continue;
    }
    const selection = {
      prepared,
      result,
      candidates,
      combinedScore: result.evidenceBundle.evidence.reduce(
        (sum, item) => sum + item.score,
        0,
      ),
    };
    if (best === undefined || selection.combinedScore > best.combinedScore) {
      best = selection;
    }
  }
  if (best === undefined) return undefined;
  return {
    prepared: best.prepared,
    result: best.result,
    candidates: best.candidates,
  };
}

function prepareRelationshipConflictRepairRecall(input: {
  store: DatabaseStore;
  input: AgentMemoryRecallInput;
  query: MemoryRecallQuery;
  candidateLimit: number;
  maxEvidence: number;
  candidates: readonly HierarchyCandidate[];
}): PreparedTierSelection | undefined {
  if (input.maxEvidence < 2) return undefined;
  const eligible = input.candidates.filter(
    (candidate) =>
      candidate.memory.status === "active" &&
      candidate.memory.supersededById === undefined &&
      candidate.memory.mergedIntoId === undefined &&
      hasUserMessageEvidence(input.store, input.input.agentId, candidate),
  );
  const conflicts = eligible.filter(isRelationshipConflictCandidate);
  const repairs = eligible.filter(isRelationshipRepairCandidate);
  const threshold = input.query.minimumScore ?? 0.3;
  let best:
    | (PreparedTierSelection & {
        combinedScore: number;
      })
    | undefined;
  for (const conflict of conflicts) {
    for (const repair of repairs) {
      if (
        conflict.memory.id === repair.memory.id ||
        !relationshipCandidatesShareEpisode(conflict, repair)
      ) {
        continue;
      }
      const candidates = [conflict, repair];
      const prepared = prepareCandidates(
        input.store,
        input.input.agentId,
        input.query,
        input.candidateLimit,
        input.maxEvidence,
        threshold,
        candidates,
      );
      const result = evaluateTier(prepared, input.input.nowUtc, "basic_memory");
      if (
        result.abstained ||
        !candidates.every((candidate) =>
          result.selectedMemoryIds.includes(candidate.memory.id),
        )
      ) {
        continue;
      }
      const selection = {
        prepared,
        result,
        candidates,
        combinedScore: result.evidenceBundle.evidence.reduce(
          (sum, item) => sum + item.score,
          0,
        ),
      };
      if (best === undefined || selection.combinedScore > best.combinedScore) {
        best = selection;
      }
    }
  }
  if (best === undefined) return undefined;
  return {
    prepared: best.prepared,
    result: best.result,
    candidates: best.candidates,
  };
}

function prepareRelationshipBoundaryRecall(input: {
  store: DatabaseStore;
  input: AgentMemoryRecallInput;
  query: MemoryRecallQuery;
  candidateLimit: number;
  maxEvidence: number;
  candidates: readonly HierarchyCandidate[];
}): PreparedTierSelection | undefined {
  const candidates = input.candidates.filter(
    (candidate) =>
      candidate.memory.status === "active" &&
      candidate.memory.supersededById === undefined &&
      candidate.memory.mergedIntoId === undefined &&
      isRelationshipBoundaryCandidate(candidate) &&
      hasUserMessageEvidence(input.store, input.input.agentId, candidate),
  );
  if (candidates.length === 0) return undefined;
  // The intent and the typed boundary tag establish semantic scope. Lowering
  // only this bounded selection avoids weakening unknown-fact abstention for
  // unrelated durable-memory queries.
  const threshold = input.query.minimumScore ?? 0.3;
  const prepared = prepareCandidates(
    input.store,
    input.input.agentId,
    input.query,
    input.candidateLimit,
    input.maxEvidence,
    threshold,
    candidates,
  );
  const result = evaluateTier(prepared, input.input.nowUtc, "basic_memory");
  if (result.abstained) return undefined;
  return { prepared, result, candidates };
}

function isRelationshipBoundaryCandidate(
  candidate: HierarchyCandidate,
): boolean {
  const tags = normalizedMemoryTags(candidate);
  if (
    tags.has("relationshipboundary") ||
    tags.has("stoptopic") ||
    tags.has("boundary")
  ) {
    return true;
  }
  const text = candidate.memory.content.normalize("NFKC");
  return /(?:关系边界|停止讨论|说停时先停止|不想继续.{0,8}话题)/u.test(text);
}

function isRelationshipConflictCandidate(
  candidate: HierarchyCandidate,
): boolean {
  const tags = normalizedMemoryTags(candidate);
  if (
    tags.has("relationshipconflict") ||
    (tags.has("relationshipevent") && tags.has("conflict"))
  ) {
    return !isRelationshipRepairCandidate(candidate);
  }
  const text = [candidate.memory.content, ...candidate.memory.tags].join(" ");
  const describesConflict =
    /(?:关系分歧|冲突|不舒服|误解|越界)|\b(?:conflict|rupture|overclaim)\b/iu.test(
      text,
    );
  return describesConflict && !isRelationshipRepairCandidate(candidate);
}

function isRelationshipRepairCandidate(candidate: HierarchyCandidate): boolean {
  const tags = normalizedMemoryTags(candidate);
  if (
    tags.has("relationshiprepair") ||
    (tags.has("relationshipevent") && tags.has("repair"))
  ) {
    return true;
  }
  const text = [candidate.memory.content, ...candidate.memory.tags].join(" ");
  return /(?:关系修复|道歉|说清责任|尊重边界|和好)|\b(?:repair|apology|reconcile)\b/iu.test(
    text,
  );
}

function normalizedMemoryTags(candidate: HierarchyCandidate): Set<string> {
  return new Set(
    candidate.memory.tags.map((tag) =>
      tag
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ""),
    ),
  );
}

function relationshipCandidatesShareEpisode(
  left: HierarchyCandidate,
  right: HierarchyCandidate,
): boolean {
  const leftEpisodes = relationshipEpisodeKeys(left);
  const rightEpisodes = relationshipEpisodeKeys(right);
  // Legacy records had no episode key. Retain their prior pairing behavior,
  // while never joining two differently typed episodes.
  if (leftEpisodes.size === 0 || rightEpisodes.size === 0) return true;
  return [...leftEpisodes].some((episode) => rightEpisodes.has(episode));
}

function relationshipEpisodeKeys(candidate: HierarchyCandidate): Set<string> {
  const episodes = new Set<string>();
  for (const tag of candidate.memory.tags) {
    const normalized = tag
      .normalize("NFKC")
      .replace(/\s+/gu, " ")
      .trim()
      .toLocaleLowerCase();
    const episode = normalized.match(/^episode(?:[:\s]+)(.+)$/u)?.[1];
    if (episode !== undefined) {
      episodes.add(episode.replace(/[^\p{L}\p{N}]+/gu, ""));
    }
  }
  const claimKey = candidate.memory.claim?.subjectKey
    .normalize("NFKC")
    .toLocaleLowerCase();
  const claimEpisode = claimKey?.match(/^relationship:episode:([^:]+)/u)?.[1];
  if (claimEpisode !== undefined) {
    episodes.add(claimEpisode.replace(/[^\p{L}\p{N}]+/gu, ""));
  }
  return episodes;
}

function isGroundedSharedRelationshipCandidate(
  store: DatabaseStore,
  agentId: string,
  query: string,
  candidate: HierarchyCandidate,
): boolean {
  return (
    isRelationshipHistoryIntent(query) &&
    candidate.memory.namespace === "shared_relationship" &&
    candidate.memory.attribution === "mixed" &&
    hasUserMessageEvidence(store, agentId, candidate)
  );
}

function isEligibleDurableCandidateForIntent(
  store: DatabaseStore,
  agentId: string,
  query: string,
  requireDurableEvidence: boolean,
  candidate: HierarchyCandidate,
): boolean {
  if (
    !requireDurableEvidence ||
    !isRelationshipHistoryIntent(query) ||
    candidate.memory.namespace !== "shared_relationship" ||
    candidate.memory.attribution !== "mixed"
  ) {
    return true;
  }
  return hasUserMessageEvidence(store, agentId, candidate);
}

function hasUserMessageEvidence(
  store: DatabaseStore,
  agentId: string,
  candidate: HierarchyCandidate,
): boolean {
  return candidate.evidence.some(
    (evidence) =>
      evidence.sourceType === "message" &&
      store.database
        .prepare(
          "SELECT 1 FROM messages WHERE id = ? AND agent_id = ? AND role = 'user'",
        )
        .get(evidence.sourceId, agentId) !== undefined,
  );
}

function isRelationshipHistoryIntent(query: string): boolean {
  const normalized = query.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return /(?:关系).{0,16}(?:积累|经历)|具体经历/u.test(normalized);
}

function isRelationshipBoundaryIntent(query: string): boolean {
  const normalized = query.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return (
    /(?:要求|说过|提过|定过).{0,16}(?:停止|停下|不再|别再|不想继续).{0,16}(?:哪个|什么|哪一).{0,8}(?:话题|事情)/u.test(
      normalized,
    ) ||
    /(?:停止|停下|不再|别再|不想继续).{0,16}(?:哪个|什么|哪一).{0,8}(?:话题|事情)/u.test(
      normalized,
    )
  );
}

function isConflictRepairIntent(query: string): boolean {
  const normalized = query.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return /(?:分歧).{0,20}(?:修复)|(?:修复).{0,20}(?:分歧)/u.test(normalized);
}

function canonicalClaimMinimumScore(query: string): number {
  const normalized = query.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (
    /(?:有把握|确定|确实)(?:知道|记得)?.{0,16}(?:关于我|我的).{0,12}(?:事|信息|事实)/u.test(
      normalized,
    )
  ) {
    return 0.2;
  }
  if (isRelationshipHistoryIntent(normalized)) {
    return 0.3;
  }
  return DEFAULT_CANONICAL_CLAIM_MINIMUM_SCORE;
}

function instantInRange(
  instantUtc: string,
  range: { fromUtc: string; toUtc: string },
): boolean {
  const instant = Date.parse(instantUtc);
  return (
    instant >= Date.parse(range.fromUtc) && instant < Date.parse(range.toUtc)
  );
}

function overlapsRange(
  startAtUtc: string,
  endAtUtc: string | undefined,
  range: { fromUtc: string; toUtc: string },
): boolean {
  const start = Date.parse(startAtUtc);
  const end =
    Date.parse(endAtUtc ?? startAtUtc) + (endAtUtc === undefined ? 1 : 0);
  return start < Date.parse(range.toUtc) && end > Date.parse(range.fromUtc);
}

function reliabilityRank(
  reliability: EventCard["evidence"][number]["reliability"],
): number {
  if (reliability === "fact") return 2;
  if (reliability === "reported") return 1;
  return 0;
}

function normalizeQuery(
  query: string | MemoryRecallQuery,
  contextPlan?: ConversationContextPlan,
): MemoryRecallQuery {
  return MemoryRecallQuerySchema.parse({
    ...(typeof query === "string" ? { query } : query),
    ...(contextPlan === undefined ? {} : { contextPlan }),
  });
}

function withoutTimeRange(query: MemoryRecallQuery): MemoryRecallQuery {
  const result: Partial<MemoryRecallQuery> & { query: string } = { ...query };
  delete result.timeRange;
  return MemoryRecallQuerySchema.parse(result);
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function roundScore(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 1_000_000) / 1_000_000;
}

function roundMilliseconds(value: number): number {
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}

function zeroScoreBreakdown(): RetrievalScoreBreakdown {
  return {
    lexical: 0,
    tag: 0,
    importance: 0,
    recency: 0,
    temporal: 0,
    namespace: 0,
  };
}

function toJson(value: TemporalQueryResolution): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
