import { performance } from "node:perf_hooks";

import {
  MemoryRecallPreviewResponseSchema,
  MemoryRecallQuerySchema,
  type JsonValue,
  type Memory,
  type MemoryEvidence,
  type MemoryRecallPreviewCandidate as ContractMemoryRecallPreviewCandidate,
  type MemoryRecallPreviewRejection,
  type MemoryRecallPreviewResponse,
  type MemoryRecallQuery,
  type MemoryRecallResult,
  type RetrievalScoreBreakdown,
} from "@personasim/contracts";
import { recallMemory } from "@personasim/features";

import type { DatabaseStore } from "../db/store.js";
import {
  RETRIEVAL_RUN_STAGE_NAMES,
  RetrievalRunRepository,
  type CreateRetrievalRunInput,
  type RetrievalHierarchySnapshot,
  type RetrievalReplayInput,
  type RetrievalRunCandidate,
  type RetrievalRunStage,
} from "../repositories/retrieval-run-repository.js";
import type { ContinuityIndexService } from "./continuity-index-service.js";
import type { DateDigestService } from "./date-digest-service.js";
import {
  inspectContinuityRecall,
  replayContinuityRecall,
} from "./memory-recall-hierarchy.js";
import {
  readMemoryEvidence,
  readRecallCandidateRecords,
} from "./memory-service.js";
import { memorySourceCanAuthorizeUserFact } from "./memory-epistemic.js";

export const DEFAULT_MEMORY_RECALL_MINIMUM_SCORE = 0.42;
const DEFAULT_MEMORY_RECALL_CANDIDATE_LIMIT = 200;
const DEFAULT_MEMORY_RECALL_KEYWORD_LIMIT = 50;
const DEFAULT_MEMORY_RECALL_MAX_EVIDENCE = 3;
const MAX_CANDIDATE_EVIDENCE_IDS = 20;

export type AgentMemoryRecallInput = {
  sessionId?: string;
  agentId: string;
  query: string | MemoryRecallQuery;
  nowUtc: string;
  timezone?: string;
  limit?: number;
  maxEvidence?: number;
};

export interface ContinuityRecallDependencies {
  continuityIndex: ContinuityIndexService;
  dateDigests: DateDigestService;
}

export type MemoryRecallPreviewCandidate = ContractMemoryRecallPreviewCandidate;

export type MemoryRecallPreview = MemoryRecallPreviewResponse;

export type PreparedMemoryRecallPreview = {
  preview: MemoryRecallPreview;
  retrievalRun: CreateRetrievalRunInput;
};

export function recallAgentMemories(
  store: DatabaseStore,
  input: AgentMemoryRecallInput,
): MemoryRecallResult {
  const prepared = prepareRecall(store, input);
  return evaluateRecall(prepared, input.nowUtc);
}

export function previewAgentMemoryRecall(
  store: DatabaseStore,
  input: AgentMemoryRecallInput,
): MemoryRecallPreview {
  return inspectAgentMemoryRecall(store, input).preview;
}

export class MemoryRecallService {
  private readonly retrievalRuns: RetrievalRunRepository;

  constructor(
    private readonly store: DatabaseStore,
    retrievalRuns?: RetrievalRunRepository,
    private readonly continuity?: ContinuityRecallDependencies,
  ) {
    this.retrievalRuns =
      retrievalRuns ?? new RetrievalRunRepository(store.database);
  }

  recall(input: AgentMemoryRecallInput): MemoryRecallResult {
    return recallAgentMemories(this.store, input);
  }

  preview(input: AgentMemoryRecallInput): MemoryRecallPreview {
    const prepared = this.preparePreviewRecording(input);
    this.retrievalRuns.create(prepared.retrievalRun);
    return prepared.preview;
  }

  preparePreviewRecording(
    input: AgentMemoryRecallInput,
  ): PreparedMemoryRecallPreview {
    const inspection =
      this.continuity === undefined
        ? inspectAgentMemoryRecall(this.store, input)
        : inspectContinuityRecall(this.store, this.continuity, input);
    return {
      preview: inspection.preview,
      retrievalRun: toRetrievalRunInput(this.store, input, inspection),
    };
  }

  replay(input: RetrievalReplayInput): MemoryRecallResult {
    if (input.strategyVersion === "continuity_hierarchy_v1") {
      return replayContinuityRecall(input);
    }
    return recallMemory({
      query: input.query,
      memories: input.memories,
      evidence: input.evidence,
      nowUtc: input.nowUtc,
      minimumScore: input.minimumScore,
      maxEvidence: input.maxEvidence,
    });
  }
}

type MemoryRecallInspection = {
  preview: MemoryRecallPreview;
  prepared: PreparedRecall;
  candidateBreakdowns: Map<string, RetrievalScoreBreakdown>;
  hierarchy?: RetrievalHierarchySnapshot;
};

function inspectAgentMemoryRecall(
  store: DatabaseStore,
  input: AgentMemoryRecallInput,
): MemoryRecallInspection {
  const started = performance.now();
  const prepared = prepareRecall(store, input);
  const result = evaluateRecall(prepared, input.nowUtc);
  const selectedIds = new Set(result.selectedMemoryIds);
  const evidenceByMemory = groupEvidenceByMemory(prepared.evidence);
  const rawEvidenceByMemory = groupEvidenceByMemory(prepared.rawEvidence);
  const candidateBreakdowns = new Map<string, RetrievalScoreBreakdown>();

  const candidates = prepared.memories.map((memory) => {
    const candidateEvidence = evidenceByMemory.get(memory.id) ?? [];
    const individual = recallMemory({
      query: prepared.query,
      memories: [withoutLegacyEvidenceFallback(memory)],
      evidence: candidateEvidence,
      nowUtc: input.nowUtc,
      minimumScore: prepared.minimumScore,
      maxEvidence: 1,
    });
    const diagnostic = individual.abstained
      ? recallMemory({
          query: prepared.query,
          memories: [withoutLegacyEvidenceFallback(memory)],
          evidence: candidateEvidence,
          nowUtc: input.nowUtc,
          minimumScore: 0,
          maxEvidence: 1,
        })
      : individual;
    candidateBreakdowns.set(
      memory.id,
      diagnostic.abstained
        ? zeroScoreBreakdown()
        : (diagnostic.evidenceBundle.evidence[0]?.scoreBreakdown ??
            zeroScoreBreakdown()),
    );
    const selected = selectedIds.has(memory.id);
    const rejectionReason = selected
      ? undefined
      : candidateRejectionReason(
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
      evidenceIds: candidateEvidence
        .slice(0, MAX_CANDIDATE_EVIDENCE_IDS)
        .map((item) => item.id),
      score: individual.score,
      selected,
      ...(rejectionReason === undefined ? {} : { rejectionReason }),
    };
  });

  const selectedItems = result.abstained ? [] : result.evidenceBundle.evidence;
  const evidenceById = new Map(
    prepared.evidence.map((item) => [item.id, item]),
  );
  const selectedEvidence = result.selectedEvidenceIds.flatMap((id) => {
    const item = evidenceById.get(id);
    return item === undefined ? [] : [item];
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
    agentId: input.agentId,
    query: prepared.query,
    candidateCount: prepared.memories.length,
    evidenceCount: prepared.evidence.length,
    candidates,
    selectedItems,
    evidence: selectedEvidence,
    rejections: [...prepared.evidenceRejections, ...memoryRejections],
    strategy: {
      name: "keyword_evidence_v1",
      minimumScore: prepared.minimumScore,
      maxEvidence: prepared.maxEvidence,
      candidateLimit: prepared.candidateLimit,
    },
    timing: {
      evaluatedAtUtc: input.nowUtc,
      durationMs: roundMilliseconds(performance.now() - started),
    },
    result,
  });
  return { preview, prepared, candidateBreakdowns };
}

function toRetrievalRunInput(
  store: DatabaseStore,
  input: AgentMemoryRecallInput,
  inspection: MemoryRecallInspection,
): CreateRetrievalRunInput {
  const inputSnapshot: RetrievalReplayInput = {
    agentId: input.agentId,
    query: inspection.prepared.query,
    nowUtc: input.nowUtc,
    memories: inspection.prepared.memories.map(withoutLegacyEvidenceFallback),
    evidence: inspection.prepared.evidence,
    minimumScore: inspection.prepared.minimumScore,
    maxEvidence: inspection.prepared.maxEvidence,
    candidateLimit: inspection.prepared.candidateLimit,
    ...(inspection.hierarchy === undefined
      ? {}
      : {
          strategyVersion: "continuity_hierarchy_v1",
          hierarchy: inspection.hierarchy,
        }),
  };
  const strategyName =
    inspection.hierarchy === undefined
      ? "keyword_evidence_v1"
      : "continuity_hierarchy_v1";
  const relationshipScore = runtimeRelationshipScore(store, input.agentId);
  const renderedPromptFragment = renderRetrievalPromptFragment(
    inspection.preview.result,
  );
  const configSnapshot = {
    schemaVersion: 1,
    strategy: {
      name: strategyName,
      candidateLimit: inputSnapshot.candidateLimit,
      maxEvidence: inputSnapshot.maxEvidence,
      minimumScore: inputSnapshot.minimumScore,
    },
    hierarchy: [
      "event_card",
      "verbatim_quote",
      "date_digest",
      "basic_memory",
      "none",
    ],
    scoreWeights: {
      lexical: 0.4,
      tag: 0.15,
      importance: 0.15,
      recency: 0.1,
      temporal: 0.1,
      namespace: 0.1,
    },
    reliability: {
      base: 0.7,
      confidence: 0.3,
      uncertainMultiplier: 0.75,
    },
    evidencePolicy: {
      formalSources: [
        "message",
        "activity_event",
        "character_source",
        "manual",
      ],
      rejectsScheduleEvents: true,
      legacyFallback: false,
    },
    selection: {
      maxSelected: inputSnapshot.maxEvidence,
      tieBreak: "score_desc_memory_id_asc",
    },
    relationship: {
      source: "runtime_state",
      score: relationshipScore ?? null,
    },
  } satisfies Record<string, JsonValue>;

  return {
    agentId: input.agentId,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    inputSnapshot,
    stages: retrievalRunStages(
      inspection,
      inputSnapshot,
      renderedPromptFragment,
    ),
    candidates: retrievalRunCandidates(inspection, relationshipScore),
    result: inspection.preview.result,
    configSnapshot,
    ...(renderedPromptFragment === undefined ? {} : { renderedPromptFragment }),
    createdAtUtc: input.nowUtc,
  };
}

function retrievalRunStages(
  inspection: MemoryRecallInspection,
  input: RetrievalReplayInput,
  renderedPromptFragment: string | undefined,
): RetrievalRunStage[] {
  const { preview, prepared } = inspection;
  const namespaces = input.query.namespaces;
  const namespaceMatches =
    namespaces === undefined
      ? preview.candidates
      : preview.candidates.filter((candidate) =>
          namespaces.includes(candidate.namespace),
        );
  const selectedIds = new Set(preview.result.selectedMemoryIds);
  const temporalResolution = input.hierarchy?.temporalResolution;
  const hasTemporalResolution =
    input.query.timeRange !== undefined || temporalResolution !== undefined;

  const definitions: Array<Omit<RetrievalRunStage, "name" | "ordinal">> = [
    {
      status: "completed",
      inputCount: 1,
      outputCount: 1,
      durationMs: 0,
      snapshot: jsonSnapshot({ query: input.query }),
    },
    {
      status: hasTemporalResolution ? "completed" : "skipped",
      inputCount: 1,
      outputCount: hasTemporalResolution ? 1 : 0,
      durationMs: 0,
      ...(hasTemporalResolution ? {} : { reasonCode: "no_temporal_filter" }),
      snapshot: jsonSnapshot({
        timeRange: input.query.timeRange ?? null,
        resolution: temporalResolution ?? null,
      }),
    },
    {
      status: namespaces === undefined ? "skipped" : "completed",
      inputCount: preview.candidateCount,
      outputCount: namespaceMatches.length,
      durationMs: 0,
      ...(namespaces === undefined
        ? { reasonCode: "no_namespace_filter" }
        : {}),
      snapshot: jsonSnapshot({
        namespaces: namespaces ?? [],
        matchedMemoryIds: namespaceMatches.map(
          (candidate) => candidate.memoryId,
        ),
      }),
    },
    {
      status: "completed",
      inputCount: preview.candidateCount,
      outputCount: preview.candidates.length,
      durationMs: 0,
      snapshot: jsonSnapshot({
        candidateLimit: input.candidateLimit,
        memoryIds: input.memories.map((memory) => memory.id),
      }),
    },
    {
      status: "completed",
      inputCount: prepared.rawEvidence.length,
      outputCount: prepared.evidence.length,
      durationMs: 0,
      snapshot: jsonSnapshot({
        acceptedEvidenceIds: prepared.evidence.map((item) => item.id),
        rejections: prepared.evidenceRejections,
      }),
    },
    {
      status: "completed",
      inputCount: preview.candidates.length,
      outputCount: preview.candidates.filter((candidate) => candidate.score > 0)
        .length,
      durationMs: preview.timing.durationMs,
      snapshot: jsonSnapshot({
        minimumScore: input.minimumScore,
        scores: preview.candidates.map((candidate) => ({
          memoryId: candidate.memoryId,
          score: candidate.score,
          scoreBreakdown:
            inspection.candidateBreakdowns.get(candidate.memoryId) ??
            zeroScoreBreakdown(),
        })),
      }),
    },
    {
      status: "completed",
      inputCount: preview.candidates.length,
      outputCount: preview.result.selectedMemoryIds.length,
      durationMs: 0,
      snapshot: jsonSnapshot({
        selectedMemoryIds: preview.result.selectedMemoryIds,
        excludedMemoryIds: preview.candidates
          .filter((candidate) => !selectedIds.has(candidate.memoryId))
          .map((candidate) => candidate.memoryId),
        abstained: preview.result.abstained,
        ...(preview.result.abstained
          ? { abstentionReason: preview.result.abstentionReason }
          : {}),
      }),
    },
    {
      status: renderedPromptFragment === undefined ? "skipped" : "completed",
      inputCount: preview.result.abstained ? 0 : 1,
      outputCount: renderedPromptFragment === undefined ? 0 : 1,
      durationMs: 0,
      ...(renderedPromptFragment === undefined
        ? { reasonCode: "recall_abstained" }
        : {}),
      snapshot: jsonSnapshot({
        rendered: renderedPromptFragment !== undefined,
        fragmentLength: renderedPromptFragment?.length ?? 0,
      }),
    },
  ];
  return RETRIEVAL_RUN_STAGE_NAMES.map((name, ordinal) => ({
    name,
    ordinal,
    ...definitions[ordinal]!,
  }));
}

function retrievalRunCandidates(
  inspection: MemoryRecallInspection,
  relationshipScore: number | undefined,
): RetrievalRunCandidate[] {
  const selectedRanks = new Map(
    inspection.preview.result.selectedMemoryIds.map((id, index) => [
      id,
      index + 1,
    ]),
  );
  return inspection.preview.candidates.map((candidate) => {
    const selectionRank = selectedRanks.get(candidate.memoryId);
    const selected = selectionRank !== undefined;
    const reasonCode = selected
      ? "top_ranked"
      : (candidate.rejectionReason ?? "not_selected");
    return {
      memoryId: candidate.memoryId,
      namespace: candidate.namespace,
      evidenceIds: candidate.evidenceIds,
      score: candidate.score,
      scoreBreakdown:
        inspection.candidateBreakdowns.get(candidate.memoryId) ??
        zeroScoreBreakdown(),
      semanticScore: null,
      relationshipScore:
        candidate.namespace === "shared_relationship"
          ? (relationshipScore ?? null)
          : null,
      decision: selected ? "selected" : "excluded",
      reasonCode,
      ...(!selected
        ? { reasonSummary: retrievalReasonSummary(reasonCode) }
        : {}),
      ...(selectionRank === undefined ? {} : { selectionRank }),
    };
  });
}

function runtimeRelationshipScore(
  store: DatabaseStore,
  agentId: string,
): number | undefined {
  const relationship = store.getRuntimeState(agentId)?.relationship;
  if (relationship === undefined) return undefined;
  const score =
    relationship.closeness * 0.35 +
    relationship.trust * 0.4 +
    relationship.familiarity * 0.25;
  return Math.round(Math.max(0, Math.min(1, score)) * 1_000_000) / 1_000_000;
}

function renderRetrievalPromptFragment(
  result: MemoryRecallResult,
): string | undefined {
  return result.abstained
    ? undefined
    : JSON.stringify({ memoryEvidence: result.evidenceBundle }, null, 2);
}

function retrievalReasonSummary(reasonCode: string): string {
  return (
    {
      evidence_source_not_found:
        "All attached evidence sources failed verification.",
      no_formal_evidence: "The candidate had no verified formal evidence.",
      below_relevance_threshold:
        "The candidate score was below the configured minimum.",
      selection_limit:
        "A higher-scoring candidate occupied the selection limit.",
      not_selected: "The candidate was not selected.",
    }[reasonCode] ?? reasonCode.replaceAll("_", " ")
  );
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

function jsonSnapshot(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

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

function prepareRecall(
  store: DatabaseStore,
  input: AgentMemoryRecallInput,
): PreparedRecall {
  const query = normalizeQuery(input.query);
  const candidateLimit = boundedInteger(
    input.limit ?? DEFAULT_MEMORY_RECALL_CANDIDATE_LIMIT,
    1,
    500,
  );
  const maxEvidence = boundedInteger(
    input.maxEvidence ?? DEFAULT_MEMORY_RECALL_MAX_EVIDENCE,
    1,
    3,
  );
  const minimumScore =
    query.minimumScore ?? DEFAULT_MEMORY_RECALL_MINIMUM_SCORE;
  const memories = readRecallCandidateRecords(
    store,
    input.agentId,
    input.nowUtc,
    {
      candidateLimit,
      query: query.query,
      keywordLimit: DEFAULT_MEMORY_RECALL_KEYWORD_LIMIT,
    },
  );
  const rawEvidence = readMemoryEvidence(
    store,
    memories.map((memory) => memory.id),
  );
  const verification = verifyEvidenceSources(store, input.agentId, rawEvidence);
  return {
    query,
    candidateLimit,
    maxEvidence,
    minimumScore,
    memories,
    rawEvidence,
    evidence: verification.evidence,
    evidenceRejections: verification.rejections,
  };
}

function evaluateRecall(
  prepared: PreparedRecall,
  nowUtc: string,
): MemoryRecallResult {
  return recallMemory({
    query: prepared.query,
    memories: prepared.memories.map(withoutLegacyEvidenceFallback),
    evidence: prepared.evidence,
    nowUtc,
    minimumScore: prepared.minimumScore,
    maxEvidence: prepared.maxEvidence,
  });
}

function withoutLegacyEvidenceFallback(memory: Memory): Memory {
  return {
    ...memory,
    sourceMessageIds: [],
    sourceActivityEventIds: [],
  };
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
):
  | "evidence_source_not_found"
  | "unsafe_epistemic_source"
  | "unsupported_evidence_source"
  | undefined {
  if (evidence.sourceType === "manual") return undefined;
  if (evidence.sourceType === "schedule_event") {
    return "unsupported_evidence_source";
  }
  const source =
    evidence.sourceType === "message"
      ? store.database
          .prepare(
            "SELECT content, metadata_json FROM messages WHERE id = ? AND agent_id = ?",
          )
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
  if (source === undefined) return "evidence_source_not_found";
  if (evidence.sourceType === "message") {
    const message = source as { content: string; metadata_json: string };
    const metadata = parseRecord(message.metadata_json);
    if (
      !memorySourceCanAuthorizeUserFact({
        text: message.content,
        status: metadata["epistemicStatus"],
      })
    ) {
      return "unsafe_epistemic_source";
    }
  }
  return undefined;
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function candidateRejectionReason(
  result: MemoryRecallResult,
  rawEvidence: readonly MemoryEvidence[],
  verifiedEvidence: readonly MemoryEvidence[],
): string {
  if (rawEvidence.length > 0 && verifiedEvidence.length === 0) {
    return "evidence_source_not_found";
  }
  if (result.abstained) return result.abstentionReason;
  return "selection_limit";
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

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
): number {
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function roundMilliseconds(value: number): number {
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}

function normalizeQuery(query: string | MemoryRecallQuery): MemoryRecallQuery {
  return MemoryRecallQuerySchema.parse(
    typeof query === "string" ? { query } : query,
  );
}
