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

const EXACT_IDENTIFIER_PATTERN = /[A-Za-z0-9]+(?:[-_.:/][A-Za-z0-9]+)*/gu;

function boundedRecallTerms(
  prioritized: readonly string[],
  ordered: readonly string[],
  limit: number,
): string[] {
  const safeLimit = Math.max(0, Math.min(500, Math.trunc(limit)));
  if (safeLimit === 0) return [];

  const selected: string[] = [];
  const seen = new Set<string>();
  const append = (value: string | undefined): void => {
    if (value === undefined || value.length === 0 || seen.has(value)) return;
    seen.add(value);
    selected.push(value);
  };

  // Exact identifiers are selected before any general lexical truncation. If
  // an unusually identifier-heavy query exceeds the bound, alternate between
  // its head and tail so a late identifier still remains visible.
  let priorityHead = 0;
  let priorityTail = prioritized.length - 1;
  while (selected.length < safeLimit && priorityHead <= priorityTail) {
    append(prioritized[priorityHead]);
    priorityHead += 1;
    if (selected.length >= safeLimit || priorityHead > priorityTail) break;
    append(prioritized[priorityTail]);
    priorityTail -= 1;
  }
  if (selected.length >= safeLimit) return selected;

  const rare = ordered
    .map((term, index) => ({ term, index, score: recallTermRarity(term) }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.index - left.index ||
        left.term.localeCompare(right.term),
    );
  let head = 0;
  let tail = ordered.length - 1;
  let rareIndex = 0;
  while (
    selected.length < safeLimit &&
    (head < ordered.length || tail >= 0 || rareIndex < rare.length)
  ) {
    append(ordered[head]);
    head += 1;
    if (selected.length >= safeLimit) break;
    append(ordered[tail]);
    tail -= 1;
    if (selected.length >= safeLimit) break;
    append(rare[rareIndex]?.term);
    rareIndex += 1;
  }
  return selected;
}

function recallTermRarity(term: string): number {
  const hasLetter = /\p{L}/u.test(term);
  const hasNumber = /\p{N}/u.test(term);
  const mixedIdentifier = hasLetter && hasNumber ? 100 : 0;
  const nonHanLength = /\p{Script=Han}/u.test(term) ? 0 : term.length;
  return mixedIdentifier + Math.min(32, nonHanLength);
}

function rawExactIdentifiers(value: string): string[] {
  const candidates = value.normalize("NFKC").match(EXACT_IDENTIFIER_PATTERN);
  if (candidates === null) return [];
  return candidates.filter((candidate) => {
    const normalized = candidate.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
    return (
      normalized.length >= 4 &&
      /[a-z]/u.test(normalized) &&
      /\d/u.test(normalized)
    );
  });
}

/** Exact identifier spellings, normalized for storage prefilters. */
export function recallExactIdentifierAnchors(value: string): string[] {
  return [
    ...new Set(
      rawExactIdentifiers(value).map((identifier) =>
        identifier.toLocaleLowerCase(),
      ),
    ),
  ];
}

/**
 * Returns normalized alphanumeric identifiers that are precise enough to
 * constrain a recall, for example "BGW-7419". Pure dates/numbers and ordinary
 * words are deliberately excluded.
 */
export function recallExactIdentifiers(value: string): string[] {
  const identifiers = new Set<string>();
  for (const candidate of recallExactIdentifierAnchors(value)) {
    const normalized = candidate.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
    if (
      normalized.length >= 4 &&
      /[a-z]/u.test(normalized) &&
      /\d/u.test(normalized)
    ) {
      identifiers.add(normalized);
    }
  }
  return [...identifiers];
}

function exactIdentifierScore(document: string, query: string): number {
  const queryIdentifiers = recallExactIdentifiers(query);
  if (queryIdentifiers.length === 0) return 0;

  const documentIdentifiers = new Set(recallExactIdentifiers(document));
  const matched = queryIdentifiers.filter((identifier) =>
    documentIdentifiers.has(identifier),
  ).length;
  return clamp(matched / queryIdentifiers.length);
}

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

/**
 * Selects a bounded set of storage-prefilter terms without letting a long
 * query prefix hide a precise identifier or a useful tail anchor.
 */
export function boundedRecallQueryTokens(
  query: string,
  limit: number,
): string[] {
  const exactTerms = recallExactIdentifierAnchors(query).flatMap((identifier) =>
    normalizeText(identifier).split(" ").filter(Boolean),
  );
  return boundedRecallTerms(exactTerms, recallQueryTokens(query), limit);
}

/**
 * Selects Han bigrams with the same head/tail/rare bounded policy used by the
 * lexical prefilter. Tail bigrams are deliberately retained for long prompts.
 */
export function boundedRecallHanBigrams(
  query: string,
  limit: number,
): string[] {
  const bigrams: string[] = [];
  const seen = new Set<string>();
  const runs = query.normalize("NFKC").match(/\p{Script=Han}+/gu) ?? [];
  for (const run of runs) {
    const characters = Array.from(run);
    for (let index = 0; index + 1 < characters.length; index += 1) {
      const bigram = characters.slice(index, index + 2).join("");
      if (seen.has(bigram)) continue;
      seen.add(bigram);
      bigrams.push(bigram);
    }
  }
  return boundedRecallTerms([], bigrams, limit);
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
  const exactIdentifier = exactIdentifierScore(document, query);
  const phraseAnchor = hanPhraseAnchorScore(document, query);
  const documentTokens = tokens(document);
  const queryTokens = tokens(query);
  if (documentTokens.size === 0 || queryTokens.size === 0) {
    return Math.max(exactIdentifier, phraseAnchor);
  }
  let intersection = 0;
  for (const token of queryTokens) {
    if (documentTokens.has(token)) intersection += 1;
  }
  const coverage = intersection / queryTokens.size;
  const union = new Set([...documentTokens, ...queryTokens]).size;
  return Math.max(
    exactIdentifier,
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
  candidateQueries: readonly string[];
  evidenceLimit: number;
  namespaces: readonly MemoryNamespace[] | undefined;
  range: TemporalQueryRange | undefined;
  threshold: number;
} {
  if (typeof input.query === "string") {
    return {
      query: input.query.trim(),
      candidateQueries: [input.query.trim()],
      evidenceLimit: 3,
      namespaces: input.namespaceFilters,
      range: input.temporalRange,
      threshold: clamp(input.minimumScore ?? DEFAULT_MINIMUM_SCORE),
    };
  }
  return {
    query: input.query.query,
    candidateQueries: recallCandidateQueries(input.query),
    evidenceLimit: input.query.contextPlan?.maxRecallEvidence ?? 3,
    namespaces: input.namespaceFilters ?? input.query.namespaces,
    range: input.temporalRange ?? input.query.timeRange,
    threshold: clamp(
      input.minimumScore ?? input.query.minimumScore ?? DEFAULT_MINIMUM_SCORE,
    ),
  };
}

/** Candidate discovery only. Consumers must use query.query for intent, time and authority. */
export function recallCandidateQueries(query: MemoryRecallQuery): string[] {
  return [
    ...new Set([query.query, ...(query.contextPlan?.expandedQueries ?? [])]),
  ];
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
      const leftScore = Math.max(
        ...query.candidateQueries.map((text) =>
          lexicalScore(left.quote ?? left.contextSummary ?? "", text),
        ),
      );
      const rightScore = Math.max(
        ...query.candidateQueries.map((text) =>
          lexicalScore(right.quote ?? right.contextSummary ?? "", text),
        ),
      );
      return rightScore - leftScore || left.id.localeCompare(right.id);
    })[0];
    if (chosen === undefined) continue;

    const lexical = Math.max(
      ...query.candidateQueries.map((text) =>
        Math.max(
          lexicalScore(memory.content, text),
          lexicalScore(chosen.quote ?? chosen.contextSummary ?? "", text),
        ),
      ),
    );
    const tag = Math.max(
      ...query.candidateQueries.map((text) => tagScore(memory.tags, text)),
    );
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
    .slice(
      0,
      Math.min(
        query.evidenceLimit,
        Math.max(1, input.maxEvidence ?? query.evidenceLimit),
      ),
    );
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
