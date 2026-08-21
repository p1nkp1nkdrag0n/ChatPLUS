import {
  judgeMemoryCandidate,
  mergeMemoryProposal,
  memoryDedupeKey,
  stableId,
  validateMemoryProposal,
  type MemoryLike,
  type MemoryProposalLike,
} from "@personasim/features";
import {
  MemoryCandidateSchema,
  MemoryEvidenceSchema,
  MemorySchema,
  TemporalMetadataSchema,
  type Memory,
  type MemoryCandidate,
  type MemoryEvidence,
  type MemoryEvidenceInput,
  type TemporalMetadata,
} from "@personasim/contracts";

import type { DatabaseStore } from "../db/store.js";

export type PersistMemoryInput = {
  store: DatabaseStore;
  agentId: string;
  candidates: readonly MemoryCandidate[];
  nowUtc: string;
  maxCandidates: number;
  authoritativeMessageId?: string;
  authoritativeActivityEventId?: string;
};

export function readActiveMemoryRecords(
  store: DatabaseStore,
  agentId: string,
  nowUtc: string,
  limit = 20,
): Memory[] {
  const safeLimit = Math.max(0, Math.min(500, Math.trunc(limit)));
  if (safeLimit === 0) return [];
  const rows = store.database
    .prepare(
      `SELECT id, agent_id, type, content, tags_json, importance, confidence,
        source_message_id, source_event_id, created_at_utc, valid_until_utc,
        memory_json, namespace, certainty, attribution, stability, status,
        claim_subject_key, claim_disposition, superseded_by_id,
        merged_into_id, last_reinforced_at_utc,
        lifecycle_updated_at_utc,
        mentioned_at_utc, planned_start_at_utc, planned_end_at_utc,
        occurred_start_at_utc, occurred_end_at_utc, recorded_at_utc,
        temporal_certainty, temporal_status
       FROM memories
       WHERE agent_id = ? AND status = 'active'
         AND (valid_until_utc IS NULL OR valid_until_utc > ?)
       ORDER BY importance DESC, created_at_utc DESC LIMIT ?`,
    )
    .all(agentId, nowUtc, safeLimit) as MemoryRow[];
  return rows.map(memoryFromRow);
}

export type RecallCandidatePoolInput = {
  importanceLimit: number;
  keywordTokens: readonly string[];
  keywordLimit?: number;
};

/**
 * Recall candidate pool: the importance-ordered head plus keyword-matched
 * memories from the whole active set. The keyword prefilter keeps a highly
 * relevant but low-importance memory recallable instead of being structurally
 * truncated by the importance-ordered LIMIT.
 */
export function readRecallCandidateRecords(
  store: DatabaseStore,
  agentId: string,
  nowUtc: string,
  input: RecallCandidatePoolInput,
): Memory[] {
  const importanceLimit = Math.max(
    0,
    Math.min(500, Math.trunc(input.importanceLimit)),
  );
  if (importanceLimit === 0) return [];
  const pool = readActiveMemoryRecords(
    store,
    agentId,
    nowUtc,
    importanceLimit,
  );
  // recallQueryTokens only emits word characters and Han bigrams, so the LIKE
  // patterns below never need SQL wildcard escaping.
  const keywordTokens = [...new Set(input.keywordTokens)]
    .filter((token) => /^[\p{L}\p{N}]+$/u.test(token) && token.length >= 2)
    .slice(0, 40);
  if (keywordTokens.length === 0) return pool;
  const keywordLimit = Math.max(
    0,
    Math.min(500, Math.trunc(input.keywordLimit ?? 50)),
  );
  if (keywordLimit === 0) return pool;
  const poolIds = new Set(pool.map((memory) => memory.id));
  const keywordClauses = keywordTokens
    .flatMap(() => ["content LIKE ?", "tags_json LIKE ?"])
    .join(" OR ");
  const keywordParams = keywordTokens.flatMap((token) => [
    `%${token}%`,
    `%${token}%`,
  ]);
  const keywordRows = store.database
    .prepare(
      `SELECT id, agent_id, type, content, tags_json, importance, confidence,
        source_message_id, source_event_id, created_at_utc, valid_until_utc,
        memory_json, namespace, certainty, attribution, stability, status,
        claim_subject_key, claim_disposition, superseded_by_id,
        merged_into_id, last_reinforced_at_utc,
        lifecycle_updated_at_utc,
        mentioned_at_utc, planned_start_at_utc, planned_end_at_utc,
        occurred_start_at_utc, occurred_end_at_utc, recorded_at_utc,
        temporal_certainty, temporal_status
       FROM memories
       WHERE agent_id = ? AND status = 'active'
         AND (valid_until_utc IS NULL OR valid_until_utc > ?)
         AND (${keywordClauses})
       ORDER BY importance DESC, created_at_utc DESC
       LIMIT ?`,
    )
    .all(
      agentId,
      nowUtc,
      ...keywordParams,
      keywordLimit + pool.length,
    ) as MemoryRow[];
  const extras = keywordRows
    .filter((row) => !poolIds.has(row.id))
    .slice(0, keywordLimit)
    .map(memoryFromRow);
  return [...pool, ...extras];
}

export function readActiveMemories(
  store: DatabaseStore,
  agentId: string,
  nowUtc: string,
  limit = 20,
): MemoryLike[] {
  return readActiveMemoryRecords(store, agentId, nowUtc, limit).map(
    toFeatureMemory,
  );
}

export function readMemoryEvidence(
  store: DatabaseStore,
  memoryIds: readonly string[],
): MemoryEvidence[] {
  const uniqueIds = [...new Set(memoryIds)].slice(0, 500);
  if (uniqueIds.length === 0) return [];
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = store.database
    .prepare(
      `SELECT id, memory_id, source_type, source_id, quote,
        context_summary, recorded_at_utc, evidence_json
       FROM memory_evidence WHERE memory_id IN (${placeholders})
       ORDER BY recorded_at_utc DESC, id`,
    )
    .all(...uniqueIds) as MemoryEvidenceRow[];
  return rows.flatMap((row) => {
    const fromJson = parseJson(row.evidence_json);
    const parsed = MemoryEvidenceSchema.safeParse(
      fromJson ?? {
        id: row.id,
        memoryId: row.memory_id,
        sourceType: row.source_type,
        sourceId: row.source_id,
        ...(row.quote === null ? {} : { quote: row.quote }),
        ...(row.context_summary === null
          ? {}
          : { contextSummary: row.context_summary }),
        recordedAtUtc: row.recorded_at_utc,
      },
    );
    return parsed.success ? [parsed.data] : [];
  });
}

export function validateMergeAndPersistMemories(
  input: PersistMemoryInput,
): Memory[] {
  if (input.maxCandidates <= 0 || input.candidates.length === 0) return [];
  const catalog = loadEvidenceCatalog(input.store, input.agentId);
  const existingRecords = readActiveMemoryRecords(
    input.store,
    input.agentId,
    input.nowUtc,
    500,
  );
  const existing = existingRecords.map(toFeatureMemory);
  const persisted: Memory[] = [];

  for (const rawCandidate of input.candidates.slice(0, input.maxCandidates)) {
    const parsedCandidate = MemoryCandidateSchema.safeParse(rawCandidate);
    if (!parsedCandidate.success) continue;
    const candidate = normalizeCandidateForJudge(
      parsedCandidate.data,
      catalog,
      input.nowUtc,
      input.authoritativeMessageId,
      input.authoritativeActivityEventId,
    );
    if (candidate === undefined) continue;
    const judgement = judgeMemoryCandidate(candidate);
    if (!judgement.accepted) continue;

    const proposal = toRuntimeProposal(candidate);
    const validation = validateMemoryProposal(proposal);
    if (!validation.accepted || validation.proposal === undefined) continue;
    const merged = mergeMemoryProposal(
      input.agentId,
      validation.proposal,
      existing,
      input.nowUtc,
    );
    if (merged === undefined) continue;

    const prior = existingRecords.find((item) => item.id === merged.memory.id);
    const temporalMetadata =
      candidate.temporalMetadata ??
      candidate.temporal ??
      defaultTemporalMetadata(candidate, catalog, input.nowUtc);
    const memory = MemorySchema.parse({
      ...merged.memory,
      namespace:
        prior?.namespace ?? candidate.namespace ?? "runtime_simulation",
      certainty: strongerCertainty(prior?.certainty, candidate.certainty),
      attribution:
        prior?.attribution ?? candidate.attribution ?? "model_inference",
      stability: strongerStability(prior?.stability, candidate.stability),
      temporalMetadata,
      status: "active",
    });
    upsertMemory(input.store, memory);
    persistMemoryEvidence(
      input.store,
      memory.id,
      candidate.evidence ?? [],
      input.nowUtc,
    );

    const featureMemory = toFeatureMemory(memory);
    const existingIndex = existing.findIndex((item) => item.id === memory.id);
    if (existingIndex >= 0) existing[existingIndex] = featureMemory;
    else existing.push(featureMemory);
    const recordIndex = existingRecords.findIndex(
      (item) => item.id === memory.id,
    );
    if (recordIndex >= 0) existingRecords[recordIndex] = memory;
    else existingRecords.push(memory);
    persisted.push(memory);
  }
  return persisted;
}

type EvidenceCatalog = {
  messages: Map<string, MessageSourceRow>;
  activities: Map<string, ActivitySourceRow>;
  characterSources: Map<string, CharacterSourceRow>;
};

function loadEvidenceCatalog(
  store: DatabaseStore,
  agentId: string,
): EvidenceCatalog {
  const messages = store.database
    .prepare(
      `SELECT id, role, content, created_at_utc
       FROM messages WHERE agent_id = ?`,
    )
    .all(agentId) as MessageSourceRow[];
  const activities = store.database
    .prepare(
      `SELECT id, summary, occurred_at_utc
       FROM activity_events WHERE agent_id = ?`,
    )
    .all(agentId) as ActivitySourceRow[];
  const characterSources = store.database
    .prepare(
      `SELECT id, content_excerpt, created_at_utc
       FROM character_sources WHERE character_id = ?`,
    )
    .all(agentId) as CharacterSourceRow[];
  return {
    messages: new Map(messages.map((row) => [row.id, row])),
    activities: new Map(activities.map((row) => [row.id, row])),
    characterSources: new Map(characterSources.map((row) => [row.id, row])),
  };
}

function normalizeCandidateForJudge(
  candidate: MemoryCandidate,
  catalog: EvidenceCatalog,
  nowUtc: string,
  authoritativeMessageId?: string,
  authoritativeActivityEventId?: string,
): MemoryCandidate | undefined {
  const evidence = collectVerifiedEvidence(
    candidate,
    catalog,
    nowUtc,
    authoritativeMessageId,
    authoritativeActivityEventId,
  );
  if (
    isSharedExperienceCandidate(candidate) &&
    !hasQualifyingSharedExperienceEvidence(candidate, evidence, catalog)
  ) {
    return undefined;
  }
  const sourceMessageIds = evidence
    .filter((item) => item.sourceType === "message")
    .map((item) => item.sourceId);
  const sourceActivityEventIds = evidence
    .filter((item) => item.sourceType === "activity_event")
    .map((item) => item.sourceId);
  const hasActivity = sourceActivityEventIds.length > 0;
  const hasMessage = sourceMessageIds.length > 0;
  const hasUserMessage = sourceMessageIds.some(
    (sourceId) => catalog.messages.get(sourceId)?.role === "user",
  );
  if (candidate.attribution === "user_explicit" && !hasUserMessage) {
    return undefined;
  }
  const namespace =
    candidate.namespace ??
    (hasActivity
      ? "runtime_simulation"
      : candidate.kind === "relationship" || candidate.kind === "commitment"
        ? "shared_relationship"
        : hasUserMessage
          ? "user_model"
          : "character_self");
  const attribution =
    candidate.attribution ??
    (hasActivity
      ? "simulation_event"
      : hasUserMessage &&
          candidate.kind !== "relationship" &&
          candidate.kind !== "commitment" &&
          candidate.confidence >= 0.85
        ? "user_explicit"
        : hasMessage
          ? "mixed"
          : "model_inference");
  const certainty =
    candidate.certainty ??
    (hasActivity || attribution === "user_explicit" ? "explicit" : "inferred");
  const stability =
    candidate.stability ??
    (hasActivity || candidate.kind === "episodic" ? "one_off" : "situational");
  const suppliedTemporal = candidate.temporalMetadata ?? candidate.temporal;
  const temporalMetadata = TemporalMetadataSchema.parse({
    ...(suppliedTemporal ??
      defaultTemporalMetadata(candidate, catalog, nowUtc, evidence)),
    recordedAtUtc: nowUtc,
  });
  const normalizedInput: Record<string, unknown> = {
    ...candidate,
    sourceMessageIds: [...new Set(sourceMessageIds)],
    sourceActivityEventIds: [...new Set(sourceActivityEventIds)],
    namespace,
    certainty,
    attribution,
    stability,
    temporalMetadata,
    evidence,
    shouldWrite: candidate.shouldWrite ?? true,
    forbiddenOverclaims: candidate.forbiddenOverclaims ?? [],
  };
  delete normalizedInput["temporal"];
  const normalized = MemoryCandidateSchema.safeParse(normalizedInput);
  return normalized.success ? normalized.data : undefined;
}

function collectVerifiedEvidence(
  candidate: MemoryCandidate,
  catalog: EvidenceCatalog,
  nowUtc: string,
  authoritativeMessageId?: string,
  authoritativeActivityEventId?: string,
): MemoryEvidenceInput[] {
  const result = new Map<string, MemoryEvidenceInput>();
  const addMessage = (sourceId: string, requestedQuote?: string): void => {
    const source = catalog.messages.get(sourceId);
    if (
      source === undefined ||
      !messageRoleCanSupportCandidate(candidate, source.role)
    )
      return;
    if (
      requestedQuote !== undefined &&
      !groundedQuote(source.content, requestedQuote)
    ) {
      return;
    }
    const supportingText = requestedQuote ?? source.content;
    if (!memoryContentGrounded(candidate, supportingText)) return;

    const quote = (requestedQuote ?? source.content).trim().slice(0, 2_000);
    if (quote.length === 0) return;
    result.set(`message:${sourceId}`, {
      sourceType: "message",
      sourceId,
      quote,
      recordedAtUtc: nowUtc,
    });
  };
  const addActivity = (sourceId: string): void => {
    const source = catalog.activities.get(sourceId);
    if (
      source === undefined ||
      !memoryContentGrounded(candidate, source.summary)
    )
      return;
    result.set(`activity_event:${sourceId}`, {
      sourceType: "activity_event",
      sourceId,
      contextSummary: source.summary.trim().slice(0, 1_000),
      recordedAtUtc: nowUtc,
    });
  };
  const addCharacterSource = (sourceId: string): void => {
    const source = catalog.characterSources.get(sourceId);
    if (
      source === undefined ||
      !memoryContentGrounded(candidate, source.content_excerpt)
    )
      return;
    result.set(`character_source:${sourceId}`, {
      sourceType: "character_source",
      sourceId,
      contextSummary: source.content_excerpt.trim().slice(0, 1_000),
      recordedAtUtc: nowUtc,
    });
  };

  if (authoritativeMessageId !== undefined) addMessage(authoritativeMessageId);
  if (authoritativeActivityEventId !== undefined) {
    addActivity(authoritativeActivityEventId);
  }
  for (const item of candidate.evidence ?? []) {
    if (item.sourceType === "message") addMessage(item.sourceId, item.quote);
    else if (item.sourceType === "activity_event") addActivity(item.sourceId);
    else if (item.sourceType === "character_source") {
      addCharacterSource(item.sourceId);
    }
  }
  return [...result.values()];
}

function groundedQuote(source: string, quote: string): boolean {
  const normalize = (value: string): string =>
    value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  const normalizedQuote = normalize(quote);
  return (
    normalizedQuote.length > 0 && normalize(source).includes(normalizedQuote)
  );
}

function isSharedExperienceCandidate(candidate: MemoryCandidate): boolean {
  return (
    (candidate.namespace === "shared_relationship" &&
      (candidate.kind === "episodic" || candidate.kind === "relationship")) ||
    candidate.tags.some(
      (tag) =>
        tag.normalize("NFKC").trim().toLocaleLowerCase() ===
        "shared_experience",
    )
  );
}

function messageRoleCanSupportCandidate(
  candidate: MemoryCandidate,
  role: MessageSourceRow["role"],
): boolean {
  if (role === "system") return false;
  if (role === "assistant") {
    return (
      candidate.namespace !== "user_model" &&
      candidate.attribution !== "user_explicit"
    );
  }
  return (
    candidate.namespace === "user_model" ||
    candidate.attribution === "user_explicit" ||
    isSharedExperienceCandidate(candidate) ||
    /\b(?:the\s+user|user(?:'s)?)\b|\u7528\u6237|\u5bf9\u65b9/iu.test(
      candidate.content,
    )
  );
}

function hasQualifyingSharedExperienceEvidence(
  candidate: MemoryCandidate,
  evidence: readonly MemoryEvidenceInput[],
  catalog: EvidenceCatalog,
): boolean {
  if (evidence.some((item) => item.sourceType === "activity_event"))
    return true;
  const temporal = candidate.temporalMetadata ?? candidate.temporal;
  if (temporal?.temporalStatus !== "occurred") return false;
  return evidence.some((item) => {
    if (item.sourceType !== "message") return false;
    const source = catalog.messages.get(item.sourceId);
    if (source === undefined || source.role === "system") return false;
    return /\b(?:we|us|our|together|you\s+and\s+i|both\s+of\s+us)\b|\u6211\u4eec|\u54b1\u4eec|\u4e00\u8d77|\u5171\u540c|\u4f60\u548c\u6211/iu.test(
      item.quote ?? source.content,
    );
  });
}

const MEMORY_GROUNDING_STOP_WORDS = new Set([
  "and",
  "character",
  "current",
  "from",
  "have",
  "memory",
  "message",
  "now",
  "said",
  "that",
  "the",
  "their",
  "this",
  "time",
  "today",
  "user",
  "was",
  "were",
  "what",
  "with",
  "your",
]);

function memoryGroundingFeatures(value: string): Set<string> {
  const features = new Set<string>();
  const normalized = value.normalize("NFKC").toLocaleLowerCase();
  for (const word of normalized.match(/[a-z0-9]{3,}/gu) ?? []) {
    const stem =
      word.length > 4 && word.endsWith("s") ? word.slice(0, -1) : word;
    if (!MEMORY_GROUNDING_STOP_WORDS.has(stem) && !/^\d+$/u.test(stem)) {
      features.add(stem);
    }
  }
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) {
      features.add(run.slice(index, index + 2));
    }
  }
  return features;
}

function memoryContentGrounded(
  candidate: MemoryCandidate,
  evidenceText: string,
): boolean {
  const normalizedContent = candidate.content
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  const normalizedEvidence = evidenceText
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  if (
    normalizedContent.length >= 2 &&
    normalizedEvidence.includes(normalizedContent) &&
    (/\p{Script=Han}/u.test(normalizedContent) || normalizedContent.length >= 4)
  ) {
    return true;
  }
  const candidateFeatures = memoryGroundingFeatures(candidate.content);
  const shared = [...memoryGroundingFeatures(evidenceText)].filter((feature) =>
    candidateFeatures.has(feature),
  );
  if (shared.length >= 2) return true;
  return (
    shared.some((feature) => feature.length >= 6) &&
    (candidate.namespace === "user_model" ||
      candidate.attribution === "user_explicit")
  );
}
function defaultTemporalMetadata(
  candidate: MemoryCandidate,
  catalog: EvidenceCatalog,
  nowUtc: string,
  evidence: readonly MemoryEvidenceInput[] = candidate.evidence ?? [],
): TemporalMetadata {
  const activityEvidence = evidence.find(
    (item) => item.sourceType === "activity_event",
  );
  if (activityEvidence !== undefined) {
    const occurredAtUtc =
      catalog.activities.get(activityEvidence.sourceId)?.occurred_at_utc ??
      candidate.occurredAtUtc ??
      nowUtc;
    return {
      occurredStartAtUtc: occurredAtUtc,
      recordedAtUtc: nowUtc,
      temporalCertainty: "exact",
      temporalStatus: "occurred",
    };
  }
  const messageEvidence = evidence.find(
    (item) => item.sourceType === "message",
  );
  if (messageEvidence !== undefined) {
    const mentionedAtUtc =
      catalog.messages.get(messageEvidence.sourceId)?.created_at_utc ?? nowUtc;
    return {
      mentionedAtUtc,
      recordedAtUtc: nowUtc,
      temporalCertainty: "exact",
      temporalStatus: "unknown",
    };
  }
  return {
    recordedAtUtc: nowUtc,
    temporalCertainty: "unknown",
    temporalStatus: "unknown",
  };
}

function toRuntimeProposal(candidate: MemoryCandidate): MemoryProposalLike {
  return {
    kind: candidate.kind,
    content: candidate.content,
    importance: candidate.importance,
    confidence: candidate.confidence,
    ...(candidate.occurredAtUtc === undefined
      ? {}
      : { occurredAtUtc: candidate.occurredAtUtc }),
    ...(candidate.expiresAtUtc === undefined
      ? {}
      : { expiresAtUtc: candidate.expiresAtUtc }),
    tags: candidate.tags,
    sourceMessageIds: candidate.sourceMessageIds,
    sourceActivityEventIds: candidate.sourceActivityEventIds,
    origin: "runtime_simulation",
    ...(candidate.claim === undefined ? {} : { claim: candidate.claim }),
    reasonCode: candidate.reasonCode,
    reasonSummary: candidate.reasonSummary,
  };
}

function strongerCertainty(
  prior: Memory["certainty"],
  next: MemoryCandidate["certainty"],
): NonNullable<Memory["certainty"]> {
  const rank = { uncertain: 0, inferred: 1, explicit: 2 } as const;
  const priorValue = prior ?? "uncertain";
  const nextValue = next ?? "uncertain";
  return rank[priorValue] >= rank[nextValue] ? priorValue : nextValue;
}

function strongerStability(
  prior: Memory["stability"],
  next: MemoryCandidate["stability"],
): NonNullable<Memory["stability"]> {
  const rank = { one_off: 0, situational: 1, stable: 2 } as const;
  const priorValue = prior ?? "one_off";
  const nextValue = next ?? "situational";
  return rank[priorValue] >= rank[nextValue] ? priorValue : nextValue;
}

function upsertMemory(store: DatabaseStore, memory: Memory): void {
  const temporal = memory.temporalMetadata ?? memory.temporal;
  store.database
    .prepare(
      `INSERT INTO memories(
        id, agent_id, type, content, tags_json, importance, confidence,
        source_message_id, source_event_id, created_at_utc, valid_until_utc,
        memory_json, namespace, certainty, attribution, stability, status,
        claim_subject_key, claim_disposition, superseded_by_id,
        merged_into_id, last_reinforced_at_utc, lifecycle_updated_at_utc,
        mentioned_at_utc, planned_start_at_utc, planned_end_at_utc,
        occurred_start_at_utc, occurred_end_at_utc, recorded_at_utc,
        temporal_certainty, temporal_status
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        tags_json = excluded.tags_json,
        importance = excluded.importance,
        confidence = excluded.confidence,
        source_message_id = excluded.source_message_id,
        source_event_id = excluded.source_event_id,
        valid_until_utc = excluded.valid_until_utc,
        memory_json = excluded.memory_json,
        namespace = excluded.namespace,
        certainty = excluded.certainty,
        attribution = excluded.attribution,
        stability = excluded.stability,
        status = excluded.status,
        claim_subject_key = excluded.claim_subject_key,
        claim_disposition = excluded.claim_disposition,
        superseded_by_id = excluded.superseded_by_id,
        merged_into_id = excluded.merged_into_id,
        last_reinforced_at_utc = excluded.last_reinforced_at_utc,
        lifecycle_updated_at_utc = excluded.lifecycle_updated_at_utc,
        mentioned_at_utc = excluded.mentioned_at_utc,
        planned_start_at_utc = excluded.planned_start_at_utc,
        planned_end_at_utc = excluded.planned_end_at_utc,
        occurred_start_at_utc = excluded.occurred_start_at_utc,
        occurred_end_at_utc = excluded.occurred_end_at_utc,
        recorded_at_utc = excluded.recorded_at_utc,
        temporal_certainty = excluded.temporal_certainty,
        temporal_status = excluded.temporal_status`,
    )
    .run(
      memory.id,
      memory.agentId,
      memory.kind,
      memory.content,
      JSON.stringify(memory.tags),
      memory.importance,
      memory.confidence,
      memory.sourceMessageIds[0] ?? null,
      memory.sourceActivityEventIds[0] ?? null,
      memory.createdAtUtc,
      memory.expiresAtUtc ?? null,
      JSON.stringify(memory),
      memory.namespace ?? "runtime_simulation",
      memory.certainty ?? "uncertain",
      memory.attribution ?? "mixed",
      memory.stability ?? "situational",
      memory.status,
      memory.claim?.subjectKey ?? null,
      memory.claim?.disposition ?? null,
      memory.supersededById ?? null,
      memory.mergedIntoId ?? null,
      memory.lastReinforcedAtUtc ?? memory.updatedAtUtc,
      memory.lifecycleUpdatedAtUtc ?? memory.updatedAtUtc,
      temporal?.mentionedAtUtc ?? null,
      temporal?.plannedStartAtUtc ?? null,
      temporal?.plannedEndAtUtc ?? null,
      temporal?.occurredStartAtUtc ?? null,
      temporal?.occurredEndAtUtc ?? null,
      temporal?.recordedAtUtc ?? memory.updatedAtUtc,
      temporal?.temporalCertainty ?? "unknown",
      temporal?.temporalStatus ?? "unknown",
    );
}

function persistMemoryEvidence(
  store: DatabaseStore,
  memoryId: string,
  evidenceInputs: readonly MemoryEvidenceInput[],
  nowUtc: string,
): void {
  const statement = store.database.prepare(
    `INSERT INTO memory_evidence(
      id, memory_id, source_type, source_id, quote, context_summary,
      recorded_at_utc, evidence_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id, source_type, source_id) DO UPDATE SET
      quote = excluded.quote,
      context_summary = excluded.context_summary,
      recorded_at_utc = excluded.recorded_at_utc,
      evidence_json = excluded.evidence_json`,
  );
  for (const input of evidenceInputs) {
    const evidence = MemoryEvidenceSchema.parse({
      id: stableId(
        "evidence",
        `${memoryId}:${input.sourceType}:${input.sourceId}`,
      ),
      memoryId,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      ...(input.quote === undefined ? {} : { quote: input.quote }),
      ...(input.contextSummary === undefined
        ? {}
        : { contextSummary: input.contextSummary }),
      recordedAtUtc: input.recordedAtUtc ?? nowUtc,
    });
    statement.run(
      evidence.id,
      evidence.memoryId,
      evidence.sourceType,
      evidence.sourceId,
      evidence.quote ?? null,
      evidence.contextSummary ?? null,
      evidence.recordedAtUtc,
      JSON.stringify(evidence),
    );
  }
}

function memoryFromRow(row: MemoryRow): Memory {
  const parsedJson = parseJson(row.memory_json);
  const parsedStored = MemorySchema.safeParse(parsedJson);
  const stored = parsedStored.success ? parsedStored.data : undefined;
  const temporalMetadata = temporalFromRow(row);
  const input: Record<string, unknown> = {
    ...(stored ?? {}),
    id: row.id,
    agentId: row.agent_id,
    kind: legacyKind(row.type),
    content: row.content,
    importance: row.importance,
    confidence: row.confidence,
    tags: parseTags(row.tags_json),
    sourceMessageIds:
      stored?.sourceMessageIds ??
      (row.source_message_id === null ? [] : [row.source_message_id]),
    sourceActivityEventIds:
      stored?.sourceActivityEventIds ??
      (row.source_event_id === null ? [] : [row.source_event_id]),
    origin: stored?.origin ?? "runtime_simulation",
    namespace: row.namespace,
    certainty: row.certainty,
    attribution: row.attribution,
    stability: row.stability,
    status: row.status,
    claim:
      stored?.claim ??
      (row.claim_subject_key === null || row.claim_disposition === null
        ? undefined
        : {
            subjectKey: row.claim_subject_key,
            disposition: row.claim_disposition,
            recordedAtUtc:
              temporalMetadata?.recordedAtUtc ?? row.created_at_utc,
          }),
    supersededById: row.superseded_by_id ?? stored?.supersededById,
    mergedIntoId: row.merged_into_id ?? stored?.mergedIntoId,
    lastReinforcedAtUtc:
      row.last_reinforced_at_utc ?? stored?.lastReinforcedAtUtc,
    lifecycleUpdatedAtUtc:
      row.lifecycle_updated_at_utc ?? stored?.lifecycleUpdatedAtUtc,
    dedupeKey:
      stored?.dedupeKey ??
      memoryDedupeKey(row.agent_id, legacyKind(row.type), row.content),
    createdAtUtc: row.created_at_utc,
    updatedAtUtc:
      stored?.updatedAtUtc ??
      row.lifecycle_updated_at_utc ??
      row.created_at_utc,
    ...(row.valid_until_utc === null
      ? {}
      : { expiresAtUtc: row.valid_until_utc }),
    ...(temporalMetadata === undefined ? {} : { temporalMetadata }),
  };
  delete input["temporal"];
  if (stored?.occurredAtUtc !== undefined) {
    input["occurredAtUtc"] = stored.occurredAtUtc;
  } else if (temporalMetadata?.temporalStatus === "occurred") {
    input["occurredAtUtc"] = temporalMetadata.occurredStartAtUtc;
  } else {
    delete input["occurredAtUtc"];
  }
  return MemorySchema.parse(input);
}

function temporalFromRow(row: MemoryRow): TemporalMetadata | undefined {
  if (row.recorded_at_utc === null) return undefined;
  const parsed = TemporalMetadataSchema.safeParse({
    ...(row.mentioned_at_utc === null
      ? {}
      : { mentionedAtUtc: row.mentioned_at_utc }),
    ...(row.planned_start_at_utc === null
      ? {}
      : { plannedStartAtUtc: row.planned_start_at_utc }),
    ...(row.planned_end_at_utc === null
      ? {}
      : { plannedEndAtUtc: row.planned_end_at_utc }),
    ...(row.occurred_start_at_utc === null
      ? {}
      : { occurredStartAtUtc: row.occurred_start_at_utc }),
    ...(row.occurred_end_at_utc === null
      ? {}
      : { occurredEndAtUtc: row.occurred_end_at_utc }),
    recordedAtUtc: row.recorded_at_utc,
    temporalCertainty: row.temporal_certainty,
    temporalStatus: row.temporal_status,
  });
  if (parsed.success) return parsed.data;
  return {
    recordedAtUtc: row.recorded_at_utc,
    temporalCertainty: "unknown",
    temporalStatus: "unknown",
  };
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseTags(value: string): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((tag): tag is string => typeof tag === "string")
    : [];
}

function legacyKind(value: string): Memory["kind"] {
  if (
    value === "semantic" ||
    value === "relationship" ||
    value === "commitment"
  ) {
    return value;
  }
  return "episodic";
}

function toFeatureMemory(memory: Memory): MemoryLike {
  return {
    id: memory.id,
    agentId: memory.agentId,
    kind: memory.kind,
    content: memory.content,
    importance: memory.importance,
    confidence: memory.confidence,
    ...(memory.occurredAtUtc === undefined
      ? {}
      : { occurredAtUtc: memory.occurredAtUtc }),
    ...(memory.expiresAtUtc === undefined
      ? {}
      : { expiresAtUtc: memory.expiresAtUtc }),
    tags: memory.tags,
    sourceMessageIds: memory.sourceMessageIds,
    sourceActivityEventIds: memory.sourceActivityEventIds,
    origin: memory.origin,
    status: memory.status,
    dedupeKey: memory.dedupeKey,
    ...(memory.claim === undefined ? {} : { claim: memory.claim }),
    ...(memory.supersededById === undefined
      ? {}
      : { supersededById: memory.supersededById }),
    ...(memory.mergedIntoId === undefined
      ? {}
      : { mergedIntoId: memory.mergedIntoId }),
    ...(memory.lastReinforcedAtUtc === undefined
      ? {}
      : { lastReinforcedAtUtc: memory.lastReinforcedAtUtc }),
    ...(memory.lifecycleUpdatedAtUtc === undefined
      ? {}
      : { lifecycleUpdatedAtUtc: memory.lifecycleUpdatedAtUtc }),
    createdAtUtc: memory.createdAtUtc,
    updatedAtUtc: memory.updatedAtUtc,
  };
}

type MessageSourceRow = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  created_at_utc: string;
};

type ActivitySourceRow = {
  id: string;
  summary: string;
  occurred_at_utc: string;
};

type CharacterSourceRow = {
  id: string;
  content_excerpt: string;
  created_at_utc: string;
};

type MemoryEvidenceRow = {
  id: string;
  memory_id: string;
  source_type: string;
  source_id: string;
  quote: string | null;
  context_summary: string | null;
  recorded_at_utc: string;
  evidence_json: string;
};

type MemoryRow = {
  id: string;
  agent_id: string;
  type: string;
  content: string;
  tags_json: string;
  importance: number;
  confidence: number;
  source_message_id: string | null;
  source_event_id: string | null;
  created_at_utc: string;
  valid_until_utc: string | null;
  memory_json: string | null;
  namespace: string;
  certainty: string;
  attribution: string;
  stability: string;
  status: string;
  claim_subject_key: string | null;
  claim_disposition: string | null;
  superseded_by_id: string | null;
  merged_into_id: string | null;
  last_reinforced_at_utc: string | null;
  lifecycle_updated_at_utc: string | null;
  mentioned_at_utc: string | null;
  planned_start_at_utc: string | null;
  planned_end_at_utc: string | null;
  occurred_start_at_utc: string | null;
  occurred_end_at_utc: string | null;
  recorded_at_utc: string | null;
  temporal_certainty: string;
  temporal_status: string;
};
