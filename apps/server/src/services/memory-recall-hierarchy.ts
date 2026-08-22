import { performance } from "node:perf_hooks";

import {
  MemoryEvidenceSchema,
  MemoryRecallPreviewResponseSchema,
  MemoryRecallQuerySchema,
  MemoryRecallResultSchema,
  MemorySchema,
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
  recallMemory,
  stableId,
  type DateDigest,
  type TemporalQueryResolution,
} from "@personasim/features";

import type { DatabaseStore } from "../db/store.js";
import type {
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
  readMemoryEvidence,
  readRecallCandidateRecords,
} from "./memory-service.js";

const DEFAULT_MINIMUM_SCORE = 0.42;
const DEFAULT_CANDIDATE_LIMIT = 200;
const DEFAULT_MAX_EVIDENCE = 3;

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
}

export function inspectContinuityRecall(
  store: DatabaseStore,
  dependencies: ContinuityRecallDependencies,
  input: AgentMemoryRecallInput,
): ContinuityRecallInspection {
  const started = performance.now();
  const query = normalizeQuery(input.query);
  const exactIdentifiers = recallExactIdentifiers(query.query);
  const candidateLimit = boundedInteger(
    input.limit ?? DEFAULT_CANDIDATE_LIMIT,
    1,
    500,
  );
  const maxEvidence = boundedInteger(
    input.maxEvidence ?? DEFAULT_MAX_EVIDENCE,
    1,
    3,
  );
  const minimumScore = query.minimumScore ?? DEFAULT_MINIMUM_SCORE;
  const searchLimit = Math.min(100, candidateLimit);
  const searchedCards = dependencies.continuityIndex.searchEventCards({
    agentId: input.agentId,
    query: query.query,
    limit: searchLimit,
  });
  const temporal = temporalContext(
    store,
    dependencies,
    input,
    query,
    searchedCards,
    candidateLimit,
  );
  if (isAmbiguousResolution(temporal.resolution)) {
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

  const eventCards =
    temporal.range === undefined
      ? searchedCards
      : searchedCards.filter((card) =>
          eventCardOccursInRange(card, temporal.range!),
        );
  const eventCandidates = eventCards
    .slice(0, searchLimit)
    .map((card) => eventCardCandidate(store, card));
  const eventPrepared = prepareCandidates(
    store,
    input.agentId,
    effectiveQuery,
    candidateLimit,
    maxEvidence,
    minimumScore,
    eventCandidates,
  );
  const eventResult = evaluateTier(eventPrepared, input.nowUtc, "event_card");
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

  const archived = dependencies.continuityIndex
    .searchVerbatim({
      agentId: input.agentId,
      query: query.query,
      limit: searchLimit,
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

  const basicCandidates = basicMemoryCandidates(
    store,
    input.agentId,
    query.query,
    input.nowUtc,
    candidateLimit,
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
  return forceMode(recalled, selectedTier);
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
  const source = [...card.evidence]
    .filter((item) => item.reliability !== "context")
    .sort(
      (left, right) =>
        reliabilityRank(right.reliability) -
          reliabilityRank(left.reliability) || left.id.localeCompare(right.id),
    )[0];
  const evidence =
    source === undefined ? [] : continuityEvidence(store, card.id, source);
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
): HierarchyCandidate[] {
  return digest.items
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
): HierarchyCandidate[] {
  const memories = readRecallCandidateRecords(store, agentId, nowUtc, {
    candidateLimit,
    query,
    keywordLimit: 50,
  });
  const evidenceByMemory = groupEvidenceByMemory(
    readMemoryEvidence(
      store,
      memories.map((memory) => memory.id),
    ),
  );
  return memories.map((memory) => ({
    tier: "basic_memory",
    memory,
    evidence: evidenceByMemory.get(memory.id) ?? [],
  }));
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
    memories: prepared.memories,
    evidence: prepared.evidence,
    nowUtc,
    minimumScore: tier === "date_digest" ? 0 : prepared.minimumScore,
    maxEvidence: prepared.maxEvidence,
  });
  return forceMode(recalled, tier);
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
      name: "continuity_hierarchy_v1",
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
    ...(input.result.abstained
      ? {
          abstentionReason: input.result.abstentionReason,
          abstentionScore: input.result.score,
        }
      : {}),
  };
  return {
    preview,
    prepared: input.prepared,
    candidateBreakdowns,
    hierarchy,
  };
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
    current.push(item);
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

function normalizeQuery(query: string | MemoryRecallQuery): MemoryRecallQuery {
  return MemoryRecallQuerySchema.parse(
    typeof query === "string" ? { query } : query,
  );
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
