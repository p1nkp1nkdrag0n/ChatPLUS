import type {
  EvidenceBundleMode,
  MemoryAttribution,
  MemoryCertainty,
  MemoryEvidence,
  MemoryKind,
  MemoryNamespace,
  MemoryStatus,
  MemoryRecallQuery,
  MemoryRecallResult,
  MemoryStability,
  RetrievedMemoryEvidence,
  RetrievalScoreBreakdown,
  TemporalMetadata,
  TemporalQueryRange,
  TemporalStatus,
} from "@personasim/contracts";
import {
  EvidenceBundleSchema,
  MemoryRecallResultSchema,
  isFormalMemoryEvidenceSourceType,
} from "@personasim/contracts";

import { clamp, normalizeText, stableId } from "./shared.js";

export interface RecallableMemory {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  confidence: number;
  tags: readonly string[];
  status: MemoryStatus;
  createdAtUtc: string;
  updatedAtUtc: string;
  expiresAtUtc?: string | undefined;
  occurredAtUtc?: string | undefined;
  namespace?: MemoryNamespace | undefined;
  certainty?: MemoryCertainty | undefined;
  attribution?: MemoryAttribution | undefined;
  stability?: MemoryStability | undefined;
  temporalMetadata?: TemporalMetadata | undefined;
  /** @deprecated Use temporalMetadata. */
  temporal?: TemporalMetadata | undefined;
  origin?: string | undefined;
  sourceMessageIds?: readonly string[] | undefined;
  sourceActivityEventIds?: readonly string[] | undefined;
  evidence?: readonly MemoryEvidence[] | undefined;
}

export interface MemoryRecallInput {
  query: string | MemoryRecallQuery;
  memories: readonly RecallableMemory[];
  evidence?: readonly MemoryEvidence[];
  nowUtc: string;
  namespaceFilters?: readonly MemoryNamespace[];
  temporalRange?: TemporalQueryRange;
  minimumScore?: number;
  maxEvidence?: number;
}

type ScoredCandidate = {
  retrieved: RetrievedMemoryEvidence;
  mode: EvidenceBundleMode;
};

const DEFAULT_MINIMUM_SCORE = 0.42;

function tokens(value: string): Set<string> {
  const normalized = normalizeText(value);
  const output = new Set(
    normalized.split(" ").filter((token) => token.length > 0),
  );
  for (const part of normalized.split(" ")) {
    const characters = [...part];
    if (
      characters.length >= 2 &&
      characters.some((character) => /\p{Script=Han}/u.test(character))
    ) {
      for (let index = 0; index < characters.length - 1; index += 1) {
        output.add(`${characters[index] ?? ""}${characters[index + 1] ?? ""}`);
      }
    }
  }
  return output;
}

/**
 * Lexical tokens (words plus Han bigrams) a recall query should be able to
 * match against. Storage layers use these tokens as a keyword prefilter so
 * that highly relevant memories are recallable even when their importance
 * ranks below the default importance-ordered candidate pool.
 */
export function recallQueryTokens(query: string): string[] {
  return [...tokens(query)];
}

function hanPhraseAnchorScore(document: string, query: string): number {
  const documentHan = normalizeText(document)
    .match(/\p{Script=Han}+/gu)
    ?.join("");
  const querySegments = normalizeText(query).match(/\p{Script=Han}+/gu) ?? [];
  if (documentHan === undefined || documentHan.length < 6) return 0;

  let longest = 0;
  for (const segment of querySegments) {
    const characters = [...segment];
    const maximum = Math.min(24, characters.length);
    for (let length = maximum; length >= 6 && length > longest; length -= 1) {
      for (let index = 0; index <= characters.length - length; index += 1) {
        const phrase = characters.slice(index, index + length).join("");
        if (documentHan.includes(phrase)) {
          longest = length;
          break;
        }
      }
    }
  }
  return longest < 6 ? 0 : clamp(0.8 + (longest - 6) * 0.03);
}

function lexicalScore(document: string, query: string): number {
  const normalizedDocument = normalizeText(document);
  const normalizedQuery = normalizeText(query);
  if (normalizedDocument.length === 0 || normalizedQuery.length === 0) return 0;
  if (
    normalizedDocument.includes(normalizedQuery) ||
    normalizedQuery.includes(normalizedDocument)
  ) {
    return 1;
  }
  const phraseAnchor = hanPhraseAnchorScore(document, query);
  const documentTokens = tokens(document);
  const queryTokens = tokens(query);
  if (documentTokens.size === 0 || queryTokens.size === 0) {
    return phraseAnchor;
  }
  let intersection = 0;
  for (const token of queryTokens) {
    if (documentTokens.has(token)) intersection += 1;
  }
  const coverage = intersection / queryTokens.size;
  const union = new Set([...documentTokens, ...queryTokens]).size;
  return Math.max(
    phraseAnchor,
    clamp(coverage * 0.75 + (intersection / union) * 0.25),
  );
}

function tagScore(tags: readonly string[], query: string): number {
  return Math.max(...tags.map((tag) => lexicalScore(tag, query)), 0);
}

function roundScore(value: number): number {
  return Math.round(clamp(value) * 1_000_000) / 1_000_000;
}

function recencyScore(memory: RecallableMemory, nowUtc: string): number {
  const age = Date.parse(nowUtc) - Date.parse(memory.updatedAtUtc);
  if (!Number.isFinite(age)) return 0;
  return clamp(Math.exp(-Math.max(0, age) / 86_400_000 / 60));
}

function memoryNamespace(memory: RecallableMemory): MemoryNamespace {
  if (memory.namespace !== undefined) return memory.namespace;
  if (memory.origin === "canon_extract" || memory.origin === "user_spec") {
    return "canon";
  }
  if ((memory.sourceActivityEventIds?.length ?? 0) > 0) {
    return "runtime_simulation";
  }
  if (memory.kind === "relationship" || memory.kind === "commitment") {
    return "shared_relationship";
  }
  return "character_self";
}

function namespaceScore(
  namespace: MemoryNamespace,
  query: string,
  filters: readonly MemoryNamespace[] | undefined,
): number {
  if (filters !== undefined && filters.length > 0) {
    return filters.includes(namespace) ? 1 : 0;
  }
  const normalized = normalizeText(query);
  const hints = new Set<MemoryNamespace>();
  if (
    /\b(my|me|user)\b/u.test(normalized) ||
    normalized.includes("\u6211\u7684")
  ) {
    hints.add("user_model");
  }
  if (
    /\b(we|our|together)\b/u.test(normalized) ||
    normalized.includes("\u6211\u4eec") ||
    normalized.includes("\u4e00\u8d77")
  ) {
    hints.add("shared_relationship");
  }
  if (
    /\b(you|your)\b/u.test(normalized) ||
    normalized.includes("\u4f60\u7684")
  ) {
    hints.add("character_self");
  }
  return hints.size === 0 ? 0.5 : hints.has(namespace) ? 1 : 0.25;
}

function memoryTemporal(
  memory: RecallableMemory,
): TemporalMetadata | undefined {
  const temporal = memory.temporalMetadata ?? memory.temporal;
  if (temporal !== undefined) return temporal;
  if (memory.occurredAtUtc === undefined) return undefined;
  return {
    occurredStartAtUtc: memory.occurredAtUtc,
    recordedAtUtc: memory.updatedAtUtc,
    temporalCertainty: "exact",
    temporalStatus: "occurred",
  };
}

function intervalFor(
  temporal: TemporalMetadata,
  statuses: readonly TemporalStatus[] | undefined,
): { start: number; end: number } | undefined {
  const wants = new Set(statuses ?? [temporal.temporalStatus]);
  let startAtUtc: string | undefined;
  let endAtUtc: string | undefined;
  if (wants.has("occurred") && temporal.temporalStatus === "occurred") {
    startAtUtc = temporal.occurredStartAtUtc;
    endAtUtc = temporal.occurredEndAtUtc;
  } else if (
    wants.has("in_progress") &&
    temporal.temporalStatus === "in_progress"
  ) {
    startAtUtc = temporal.occurredStartAtUtc;
  } else if (wants.has("planned") && temporal.plannedStartAtUtc !== undefined) {
    startAtUtc = temporal.plannedStartAtUtc;
    endAtUtc = temporal.plannedEndAtUtc;
  } else if (
    wants.has("cancelled") &&
    temporal.temporalStatus === "cancelled"
  ) {
    startAtUtc = temporal.plannedStartAtUtc;
    endAtUtc = temporal.plannedEndAtUtc;
  }
  if (startAtUtc === undefined) return undefined;
  const start = Date.parse(startAtUtc);
  const end = Date.parse(endAtUtc ?? startAtUtc);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  return { start, end: Math.max(start + 1, end) };
}

function timeScore(
  temporal: TemporalMetadata | undefined,
  range: TemporalQueryRange | undefined,
): number {
  if (range === undefined) return 0.5;
  if (temporal === undefined) return 0;
  const interval = intervalFor(temporal, range.statuses);
  if (interval === undefined) return 0;
  const from = Date.parse(range.fromUtc);
  const to = Date.parse(range.toUtc);
  return interval.start < to && from < interval.end ? 1 : 0;
}

function evidenceFor(
  memory: RecallableMemory,
  evidence: readonly MemoryEvidence[],
): MemoryEvidence[] {
  const byId = new Map<string, MemoryEvidence>();
  for (const item of evidence) {
    if (item.memoryId === memory.id) byId.set(item.id, item);
  }
  for (const item of memory.evidence ?? []) byId.set(item.id, item);

  if (byId.size === 0) {
    for (const sourceId of memory.sourceActivityEventIds ?? []) {
      const item: MemoryEvidence = {
        id: stableId("evidence", `${memory.id}:activity:${sourceId}`),
        memoryId: memory.id,
        sourceType: "activity_event",
        sourceId,
        contextSummary: memory.content,
        recordedAtUtc: memory.updatedAtUtc,
      };
      byId.set(item.id, item);
    }
    for (const sourceId of memory.sourceMessageIds ?? []) {
      const item: MemoryEvidence = {
        id: stableId("evidence", `${memory.id}:message:${sourceId}`),
        memoryId: memory.id,
        sourceType: "message",
        sourceId,
        contextSummary: memory.content,
        recordedAtUtc: memory.updatedAtUtc,
      };
      byId.set(item.id, item);
    }
  }

  return [...byId.values()]
    .filter((item) => isFormalMemoryEvidenceSourceType(item.sourceType))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function modeFor(evidence: MemoryEvidence): EvidenceBundleMode {
  if (evidence.sourceType === "activity_event") return "event_card";
  if (evidence.sourceType === "message" && evidence.quote !== undefined) {
    return "verbatim_quote";
  }
  return "basic_memory";
}

function certaintyFor(memory: RecallableMemory): MemoryCertainty {
  return memory.certainty ?? "inferred";
}

function attributionFor(
  memory: RecallableMemory,
  evidence: MemoryEvidence,
): MemoryAttribution {
  if (memory.attribution !== undefined) return memory.attribution;
  if (evidence.sourceType === "activity_event") return "simulation_event";
  if (memory.origin === "model_inference") return "model_inference";
  return "mixed";
}

function resolve(input: MemoryRecallInput): {
  query: string;
  namespaces: readonly MemoryNamespace[] | undefined;
  range: TemporalQueryRange | undefined;
  threshold: number;
} {
  if (typeof input.query === "string") {
    return {
      query: input.query.trim(),
      namespaces: input.namespaceFilters,
      range: input.temporalRange,
      threshold: clamp(input.minimumScore ?? DEFAULT_MINIMUM_SCORE),
    };
  }
  return {
    query: input.query.query,
    namespaces: input.namespaceFilters ?? input.query.namespaces,
    range: input.temporalRange ?? input.query.timeRange,
    threshold: clamp(
      input.minimumScore ?? input.query.minimumScore ?? DEFAULT_MINIMUM_SCORE,
    ),
  };
}

function abstain(reason: string, score = 0): MemoryRecallResult {
  return MemoryRecallResultSchema.parse({
    mode: "none",
    selectedMemoryIds: [],
    selectedEvidenceIds: [],
    score: roundScore(score),
    abstained: true,
    abstentionReason: reason,
  });
}

export function recallMemory(input: MemoryRecallInput): MemoryRecallResult {
  const query = resolve(input);
  const now = Date.parse(input.nowUtc);
  if (query.query.length === 0) return abstain("empty_query");
  if (!Number.isFinite(now)) return abstain("invalid_recall_time");

  const active = input.memories.filter((memory) => {
    if (memory.status !== "active" || memory.confidence < 0.5) return false;
    if (memory.expiresAtUtc === undefined) return true;
    return Date.parse(memory.expiresAtUtc) > now;
  });
  if (active.length === 0) return abstain("no_active_memories");

  const namespaceMatched = active.filter(
    (memory) =>
      query.namespaces === undefined ||
      query.namespaces.length === 0 ||
      query.namespaces.includes(memoryNamespace(memory)),
  );
  if (namespaceMatched.length === 0) return abstain("no_namespace_match");

  const temporalMatched = namespaceMatched.filter(
    (memory) =>
      query.range === undefined ||
      timeScore(memoryTemporal(memory), query.range) > 0,
  );
  if (temporalMatched.length === 0) return abstain("no_temporal_match");

  let evidenceCount = 0;
  const candidates: ScoredCandidate[] = [];
  for (const memory of temporalMatched) {
    const formal = evidenceFor(memory, input.evidence ?? []);
    if (formal.length === 0) continue;
    evidenceCount += 1;
    const chosen = [...formal].sort((left, right) => {
      const leftScore = lexicalScore(
        left.quote ?? left.contextSummary ?? "",
        query.query,
      );
      const rightScore = lexicalScore(
        right.quote ?? right.contextSummary ?? "",
        query.query,
      );
      return rightScore - leftScore || left.id.localeCompare(right.id);
    })[0];
    if (chosen === undefined) continue;

    const lexical = Math.max(
      lexicalScore(memory.content, query.query),
      lexicalScore(chosen.quote ?? chosen.contextSummary ?? "", query.query),
    );
    const tag = tagScore(memory.tags, query.query);
    if (lexical === 0 && tag === 0 && query.range === undefined) continue;

    const breakdown: RetrievalScoreBreakdown = {
      lexical: roundScore(lexical),
      tag: roundScore(tag),
      importance: roundScore(memory.importance),
      recency: roundScore(recencyScore(memory, input.nowUtc)),
      temporal: roundScore(timeScore(memoryTemporal(memory), query.range)),
      namespace: roundScore(
        namespaceScore(memoryNamespace(memory), query.query, query.namespaces),
      ),
    };
    const weighted =
      breakdown.lexical * 0.4 +
      breakdown.tag * 0.15 +
      breakdown.importance * 0.15 +
      breakdown.recency * 0.1 +
      breakdown.temporal * 0.1 +
      breakdown.namespace * 0.1;
    const reliability =
      (0.7 + clamp(memory.confidence) * 0.3) *
      (certaintyFor(memory) === "uncertain" ? 0.75 : 1);
    const score = roundScore(weighted * reliability);
    const temporal = memoryTemporal(memory);
    candidates.push({
      mode: modeFor(chosen),
      retrieved: {
        memoryId: memory.id,
        memoryContent: memory.content,
        memoryKind: memory.kind,
        namespace: memoryNamespace(memory),
        certainty: certaintyFor(memory),
        attribution: attributionFor(memory, chosen),
        stability: memory.stability ?? "situational",
        ...(temporal === undefined ? {} : { temporalMetadata: temporal }),
        evidence: chosen,
        score,
        scoreBreakdown: breakdown,
      },
    });
  }

  if (evidenceCount === 0) return abstain("no_formal_evidence");
  candidates.sort(
    (left, right) =>
      right.retrieved.score - left.retrieved.score ||
      left.retrieved.memoryId.localeCompare(right.retrieved.memoryId),
  );
  const bestScore = candidates[0]?.retrieved.score ?? 0;
  const selected = candidates
    .filter((candidate) => candidate.retrieved.score >= query.threshold)
    .slice(0, Math.min(3, Math.max(1, input.maxEvidence ?? 3)));
  if (selected.length === 0) {
    return abstain("below_relevance_threshold", bestScore);
  }

  const evidence = selected.map((candidate) => candidate.retrieved);
  const bundle = EvidenceBundleSchema.parse({
    query: query.query,
    mode: selected[0]?.mode ?? "basic_memory",
    generatedAtUtc: input.nowUtc,
    score: evidence[0]?.score ?? 0,
    evidence,
  });
  return MemoryRecallResultSchema.parse({
    mode: bundle.mode,
    selectedMemoryIds: [
      ...new Set(bundle.evidence.map((item) => item.memoryId)),
    ],
    selectedEvidenceIds: bundle.evidence.map((item) => item.evidence.id),
    score: bundle.score,
    abstained: false,
    evidenceBundle: bundle,
  });
}

export const recallMemoryEvidence = recallMemory;
export const selectMemoryEvidence = recallMemory;
