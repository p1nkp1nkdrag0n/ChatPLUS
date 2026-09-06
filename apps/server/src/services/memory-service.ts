import {
  boundedRecallQueryTokens,
  deriveExplicitUserMemoryClaim,
  extractExplicitWeeklyPlanFacts,
  hasExplicitMemoryCorrectionForClaim,
  isExplicitUserMemoryStatement,
  recallExactIdentifierAnchors,
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
import { isConsentDerivedSemanticCandidate } from "./consent-modality.js";
import {
  deriveServerOwnedContinuityMemoryCandidates,
  deriveServerOwnedUserMemoryCandidates,
} from "./turn-decision-service.js";

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
         AND superseded_by_id IS NULL AND merged_into_id IS NULL
         AND (valid_until_utc IS NULL OR valid_until_utc > ?)
       ORDER BY importance DESC, created_at_utc DESC, id ASC LIMIT ?`,
    )
    .all(agentId, nowUtc, safeLimit) as MemoryRow[];
  return rows.map(memoryFromRow);
}

export type RecallCandidatePoolInput = {
  candidateLimit: number;
  query: string;
  keywordLimit?: number;
};

export type StableExplicitUserMemoryScan = {
  memories: Memory[];
  truncated: boolean;
  scanLimit: number;
  truncationWitness?: Memory;
};

/**
 * Reads the complete bounded safety pool used for atomic explicit-fact
 * verification. Unlike the ordinary recall pool, its limit is internal and
 * cannot be reduced by a caller's presentation-oriented candidate limit.
 */
export function readStableExplicitUserMemoryScan(
  store: DatabaseStore,
  agentId: string,
  nowUtc: string,
  input: { searchTerms: readonly string[]; scanLimit: number },
): StableExplicitUserMemoryScan {
  const scanLimit = Math.max(1, Math.min(500, Math.trunc(input.scanLimit)));
  const searchTerms = [
    ...new Set(
      input.searchTerms
        .map((term) => term.normalize("NFKC").trim().toLocaleLowerCase())
        .filter(Boolean),
    ),
  ].slice(0, 80);
  if (searchTerms.length === 0) {
    return { memories: [], truncated: false, scanLimit };
  }
  const termClauses = searchTerms
    .map(
      () => "(instr(lower(content), ?) > 0 OR instr(lower(tags_json), ?) > 0)",
    )
    .join(" OR ");
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
       WHERE agent_id = ? AND type = 'semantic' AND status = 'active'
         AND namespace = 'user_model' AND certainty = 'explicit'
         AND attribution = 'user_explicit' AND stability = 'stable'
         AND superseded_by_id IS NULL AND merged_into_id IS NULL
         AND (claim_disposition IS NULL OR claim_disposition NOT IN ('cancelled', 'completed'))
         AND (valid_until_utc IS NULL OR valid_until_utc > ?)
         AND (${termClauses})
       ORDER BY importance DESC, created_at_utc DESC, id ASC
       LIMIT ?`,
    )
    .all(
      agentId,
      nowUtc,
      ...searchTerms.flatMap((term) => [term, term]),
      scanLimit + 1,
    ) as MemoryRow[];
  const memories = rows.map(memoryFromRow);
  const truncationWitness = memories[scanLimit];
  return {
    memories: memories.slice(0, scanLimit),
    truncated: truncationWitness !== undefined,
    scanLimit,
    ...(truncationWitness === undefined ? {} : { truncationWitness }),
  };
}

/**
 * Builds one bounded, query-aware pool. Keyword matches are ranked ahead of
 * the importance fallback by token rarity and coverage, so a rare relevant
 * memory is not crowded out by many high-importance generic matches.
 */
export function readRecallCandidateRecords(
  store: DatabaseStore,
  agentId: string,
  nowUtc: string,
  input: RecallCandidatePoolInput,
): Memory[] {
  const candidateLimit = Math.max(
    0,
    Math.min(500, Math.trunc(input.candidateLimit)),
  );
  if (candidateLimit === 0) return [];
  const importancePool = readActiveMemoryRecords(
    store,
    agentId,
    nowUtc,
    candidateLimit,
  );
  const exactAnchors = recallExactIdentifierAnchors(input.query);
  const exactRows =
    exactAnchors.length === 0
      ? []
      : (store.database
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
               AND superseded_by_id IS NULL AND merged_into_id IS NULL
               AND (valid_until_utc IS NULL OR valid_until_utc > ?)
               AND (${exactAnchors
                 .flatMap(() => [
                   "(' ' || lower(content) || ' ') GLOB ?",
                   "(' ' || lower(tags_json) || ' ') GLOB ?",
                 ])
                 .join(" OR ")})
             ORDER BY importance DESC, created_at_utc DESC, id ASC
             LIMIT ?`,
          )
          .all(
            agentId,
            nowUtc,
            ...exactAnchors.flatMap((anchor) => {
              const pattern = `*[^a-z0-9_.:/-]${anchor}[^a-z0-9_.:/-]*`;
              return [pattern, pattern];
            }),
            candidateLimit,
          ) as MemoryRow[]);
  const keywordTokens = boundedRecallQueryTokens(input.query, 40).filter(
    (token) =>
      /^[\p{L}\p{N}]+$/u.test(token) &&
      (token.length >= 2 || /^\p{Script=Han}$/u.test(token)),
  );
  if (keywordTokens.length === 0) {
    const selected = new Map(
      exactRows.map((row) => [row.id, memoryFromRow(row)]),
    );
    for (const memory of importancePool) {
      if (selected.size >= candidateLimit) break;
      selected.set(memory.id, memory);
    }
    return [...selected.values()].slice(0, candidateLimit);
  }
  const keywordLimit = Math.max(
    0,
    Math.min(
      candidateLimit,
      Math.min(500, Math.trunc(input.keywordLimit ?? 50)),
    ),
  );
  if (keywordLimit === 0) {
    const selected = new Map(
      exactRows.map((row) => [row.id, memoryFromRow(row)]),
    );
    for (const memory of importancePool) {
      if (selected.size >= candidateLimit) break;
      selected.set(memory.id, memory);
    }
    return [...selected.values()].slice(0, candidateLimit);
  }
  const keywordClauses = keywordTokens
    .flatMap(() => ["content LIKE ?", "tags_json LIKE ?"])
    .join(" OR ");
  const keywordParams = keywordTokens.flatMap((token) => [
    `%${token}%`,
    `%${token}%`,
  ]);
  const frequencyColumns = keywordTokens
    .map(
      (_, index) =>
        `SUM(CASE WHEN content LIKE ? OR tags_json LIKE ? THEN 1 ELSE 0 END) AS token_${index}`,
    )
    .join(", ");
  const frequencyRow = store.database
    .prepare(
      `SELECT ${frequencyColumns}
       FROM memories
       WHERE agent_id = ? AND status = 'active'
         AND superseded_by_id IS NULL AND merged_into_id IS NULL
         AND (valid_until_utc IS NULL OR valid_until_utc > ?)`,
    )
    .get(...keywordParams, agentId, nowUtc) as
    Record<string, number | null> | undefined;
  const scoreExpression = keywordTokens
    .map((_, index) => {
      const frequency = Number(frequencyRow?.[`token_${index}`] ?? 0);
      const weight = Math.max(
        1,
        Math.round(1_000_000 / (Math.max(0, frequency) + 1)),
      );
      return `(CASE WHEN content LIKE ? THEN ${weight} ELSE 0 END + CASE WHEN tags_json LIKE ? THEN ${weight} ELSE 0 END)`;
    })
    .join(" + ");
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
         AND superseded_by_id IS NULL AND merged_into_id IS NULL
         AND (valid_until_utc IS NULL OR valid_until_utc > ?)
         AND (${keywordClauses})
       ORDER BY (${scoreExpression}) DESC, importance DESC, created_at_utc DESC, id ASC
       LIMIT ?`,
    )
    .all(
      agentId,
      nowUtc,
      ...keywordParams,
      ...keywordParams,
      keywordLimit,
    ) as MemoryRow[];
  const selected = new Map(
    exactRows.map((row) => [row.id, memoryFromRow(row)]),
  );
  for (const row of keywordRows) {
    if (selected.size >= candidateLimit) break;
    selected.set(row.id, memoryFromRow(row));
  }
  for (const memory of importancePool) {
    if (selected.size >= candidateLimit) break;
    selected.set(memory.id, memory);
  }
  return [...selected.values()].slice(0, candidateLimit);
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
    const evidence = memoryEvidenceFromRow(row);
    return evidence === undefined ? [] : [evidence];
  });
}

export type ExplicitFactMemoryEvidenceScan = {
  evidence: MemoryEvidence[];
  truncatedMemoryIds: string[];
  perMemoryLimit: number;
};

/**
 * Reads up to N+1 evidence rows per memory for the explicit-fact safety path.
 * The extra row is never returned; it only makes evidence saturation visible
 * so a late contradiction cannot be hidden behind a presentation cap.
 */
export function readExplicitFactMemoryEvidenceScan(
  store: DatabaseStore,
  memoryIds: readonly string[],
  perMemoryLimit: number,
): ExplicitFactMemoryEvidenceScan {
  const uniqueIds = [...new Set(memoryIds)].slice(0, 500);
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(perMemoryLimit)));
  if (uniqueIds.length === 0) {
    return { evidence: [], truncatedMemoryIds: [], perMemoryLimit: safeLimit };
  }
  const placeholders = uniqueIds.map(() => "?").join(", ");
  const rows = store.database
    .prepare(
      `WITH ranked AS (
         SELECT id, memory_id, source_type, source_id, quote,
           context_summary, recorded_at_utc, evidence_json,
           ROW_NUMBER() OVER (
             PARTITION BY memory_id
             ORDER BY recorded_at_utc DESC, id
           ) AS evidence_rank
         FROM memory_evidence
         WHERE memory_id IN (${placeholders})
       )
       SELECT id, memory_id, source_type, source_id, quote,
         context_summary, recorded_at_utc, evidence_json, evidence_rank
       FROM ranked
       WHERE evidence_rank <= ?
       ORDER BY memory_id, evidence_rank`,
    )
    .all(...uniqueIds, safeLimit + 1) as Array<
    MemoryEvidenceRow & { evidence_rank: number }
  >;
  const truncatedMemoryIds = [
    ...new Set(
      rows
        .filter((row) => row.evidence_rank > safeLimit)
        .map((row) => row.memory_id),
    ),
  ].sort();
  return {
    evidence: rows.flatMap((row) => {
      if (row.evidence_rank > safeLimit) return [];
      const evidence = memoryEvidenceFromRow(row);
      return evidence === undefined ? [] : [evidence];
    }),
    truncatedMemoryIds,
    perMemoryLimit: safeLimit,
  };
}

export function validateMergeAndPersistMemories(
  input: PersistMemoryInput,
): Memory[] {
  if (input.maxCandidates <= 0) return [];
  const catalog = loadEvidenceCatalog(input.store, input.agentId);
  const authoritativeMessage =
    input.authoritativeMessageId === undefined
      ? undefined
      : catalog.messages.get(input.authoritativeMessageId);
  const serverOwnedCandidates =
    authoritativeMessage?.role === "user"
      ? [
          ...deriveServerOwnedUserMemoryCandidates(
            authoritativeMessage.content,
            input.nowUtc,
          ),
          ...deriveServerOwnedContinuityMemoryCandidates(
            authoritativeMessage.content,
            input.nowUtc,
          ),
        ]
      : [];
  let modelCandidates = input.candidates;
  if (authoritativeMessage?.role === "user") {
    modelCandidates = blocksUnverifiedModelMemoryCandidates(
      authoritativeMessage.content,
    )
      ? []
      : input.candidates.flatMap((candidate) => {
          if (
            isConsentDerivedSemanticCandidate({
              authoritativeText: authoritativeMessage.content,
              candidateText: candidate.content,
            })
          ) {
            return [];
          }
          const tags = candidate.tags.filter(
            (tag) =>
              !isConsentDerivedSemanticCandidate({
                authoritativeText: authoritativeMessage.content,
                candidateText: tag,
              }),
          );
          return [{ ...candidate, tags }];
        });
  }
  const candidates = [...serverOwnedCandidates, ...modelCandidates];
  if (candidates.length === 0) return [];
  const existingRecords = readActiveMemoryRecords(
    input.store,
    input.agentId,
    input.nowUtc,
    500,
  );
  const existing = existingRecords.map(toFeatureMemory);
  const persisted: Memory[] = [];
  const acceptedClaimSubjects = new Set<string>();
  const acceptedContents = new Set<string>();

  for (const rawCandidate of candidates) {
    if (persisted.length >= input.maxCandidates) break;
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
    const normalizedContent = candidate.content
      .normalize("NFKC")
      .replace(/\s+/gu, " ")
      .trim()
      .toLocaleLowerCase();
    if (
      acceptedContents.has(normalizedContent) ||
      (candidate.claim !== undefined &&
        acceptedClaimSubjects.has(candidate.claim.subjectKey))
    ) {
      continue;
    }
    const judgement = judgeMemoryCandidate(candidate);
    if (!judgement.accepted) continue;

    const proposal = toRuntimeProposal(candidate);
    const validation = validateMemoryProposal(proposal);
    if (!validation.accepted || validation.proposal === undefined) continue;
    // Stable claim slots are ownership boundaries. Similar wording from two
    // different relationship facets (for example a stop boundary and a later
    // repair principle) must not collapse into one memory merely because the
    // generic content similarity heuristic considers them duplicates.
    const mergeExisting =
      candidate.claim === undefined
        ? existing
        : existing.filter(
            (memory) =>
              memory.claim?.subjectKey === candidate.claim?.subjectKey,
          );
    const merged = mergeMemoryProposal(
      input.agentId,
      validation.proposal,
      mergeExisting,
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
    acceptedContents.add(normalizedContent);
    if (candidate.claim !== undefined) {
      acceptedClaimSubjects.add(candidate.claim.subjectKey);
    }
  }
  return persisted;
}

/**
 * A question, explicit uncertainty, or an unfinished plan is not independent
 * evidence for a model-proposed durable fact. Narrow server-owned extractors
 * may still emit a typed planned commitment for supported lifecycle flows;
 * untrusted model additions are discarded for these turns.
 */
function blocksUnverifiedModelMemoryCandidates(text: string): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!isExplicitUserMemoryStatement(normalized)) return true;
  // A current-turn accusation is evidence that the user made the statement,
  // not evidence that the attributed coercion or action ownership is true.
  // Only the narrow server-owned correction extractor may create a durable
  // causal record from these turns; model prose must not promote the premise
  // into an explicit user fact before canonical causality can verify it.
  if (containsUnverifiedCausalAccusation(normalized)) return true;
  if (/(?:不知道|不清楚|无法确认|没有信息|尚未确认|未确认)/u.test(normalized)) {
    return true;
  }
  const planning = /(?:打算|计划|准备|想找时间|以后想|将来想)/u.test(
    normalized,
  );
  const explicitlyUnfinished =
    /(?:还没|尚未|并未|没有)(?:开始|完成|整理|执行|行动|发生|确认)|(?:还没|尚未|并未).{0,20}(?:做|完成|发生|行动)/u.test(
      normalized,
    );
  return planning && explicitlyUnfinished;
}

function containsUnverifiedCausalAccusation(text: string): boolean {
  return (
    /(?:你|角色).{0,16}(?:逼|强迫|迫使|害得).{0,24}(?:我|用户)?.{0,12}(?:辞职|离职|分手|搬家|转行|放弃|接受|拒绝|决定|选择|行动)/u.test(
      text,
    ) ||
    /(?:你|角色).{0,16}(?:替我|代替我).{0,12}(?:决定|选择|行动).{0,24}(?:害得|导致|所以|以后)/u.test(
      text,
    )
  );
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
  const claim = materializeVerifiedClaim({
    candidate,
    evidence,
    catalog,
    nowUtc,
    namespace,
    attribution,
  });
  const weeklyPlan =
    candidate.kind === "semantic" &&
    namespace === "user_model" &&
    attribution === "user_explicit" &&
    claim?.subjectKey.startsWith("user_fact:weekly_plan:") === true;
  if (
    (candidate.claim?.subjectKey.startsWith("user_fact:weekly_plan:") ===
      true ||
      (candidate.claim === undefined &&
        extractExplicitWeeklyPlanFacts(candidate.content).length > 0)) &&
    (!weeklyPlan ||
      candidate.occurredAtUtc !== undefined ||
      (candidate.temporalMetadata ?? candidate.temporal)?.temporalStatus ===
        "occurred")
  ) {
    return undefined;
  }
  if (
    candidate.kind === "semantic" &&
    namespace === "user_model" &&
    attribution === "user_explicit" &&
    !evidence.some((item) => {
      if (item.sourceType !== "message") return false;
      const message = catalog.messages.get(item.sourceId);
      return (
        message?.role === "user" &&
        (isExplicitUserMemoryStatement(message.content) || weeklyPlan)
      );
    })
  ) {
    return undefined;
  }
  const suppliedTemporal = candidate.temporalMetadata ?? candidate.temporal;
  const temporalMetadata = TemporalMetadataSchema.parse({
    ...(weeklyPlan
      ? {
          mentionedAtUtc: nowUtc,
          temporalCertainty: "unknown",
          temporalStatus: "planned",
        }
      : (suppliedTemporal ??
        defaultTemporalMetadata(candidate, catalog, nowUtc, evidence))),
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
    ...(claim === undefined ? {} : { claim }),
    temporalMetadata,
    evidence,
    shouldWrite: candidate.shouldWrite ?? true,
    forbiddenOverclaims: candidate.forbiddenOverclaims ?? [],
  };
  if (claim === undefined) delete normalizedInput["claim"];
  delete normalizedInput["temporal"];
  const normalized = MemoryCandidateSchema.safeParse(normalizedInput);
  return normalized.success ? normalized.data : undefined;
}

function materializeVerifiedClaim(input: {
  candidate: MemoryCandidate;
  evidence: readonly MemoryEvidenceInput[];
  catalog: EvidenceCatalog;
  nowUtc: string;
  namespace: NonNullable<Memory["namespace"]>;
  attribution: NonNullable<Memory["attribution"]>;
}): MemoryCandidate["claim"] {
  const { candidate, evidence, catalog, nowUtc, namespace, attribution } =
    input;
  if (
    candidate.kind !== "semantic" ||
    namespace !== "user_model" ||
    attribution !== "user_explicit"
  ) {
    return candidate.claim;
  }
  const userEvidenceTexts = evidence.flatMap((item) => {
    if (item.sourceType !== "message") return [];
    const message = catalog.messages.get(item.sourceId);
    return message?.role === "user" ? [message.content] : [];
  });
  if (
    candidate.claim?.subjectKey.startsWith("user_fact:weekly_plan:") === true ||
    (candidate.claim === undefined &&
      extractExplicitWeeklyPlanFacts(candidate.content).length > 0)
  ) {
    for (const evidenceText of userEvidenceTexts) {
      const derived = deriveExplicitUserMemoryClaim({
        category: "user_fact",
        evidenceText,
        candidateContent: candidate.content,
      });
      if (
        derived === undefined ||
        !derived.subjectKey.startsWith("user_fact:weekly_plan:") ||
        (candidate.claim !== undefined &&
          candidate.claim.subjectKey !== derived.subjectKey)
      )
        continue;
      return {
        ...derived,
        recordedAtUtc: nowUtc,
        ...(hasExplicitMemoryCorrectionForClaim({
          category: "user_fact",
          evidenceText,
          subjectKey: derived.subjectKey,
          candidateContent: candidate.content,
        })
          ? { revisionIntent: "explicit_correction" as const }
          : {}),
      };
    }
    return undefined;
  }
  const assertiveEvidenceTexts = userEvidenceTexts.filter(
    isExplicitUserMemoryStatement,
  );
  if (assertiveEvidenceTexts.length === 0) return undefined;

  const categories = memoryClaimCategories(candidate);
  if (candidate.claim !== undefined) {
    const correctionApplies = verifiedCorrectionAppliesToClaim(
      assertiveEvidenceTexts,
      categories,
      candidate.claim.subjectKey,
      candidate.content,
    );
    return {
      subjectKey: candidate.claim.subjectKey,
      disposition: candidate.claim.disposition,
      recordedAtUtc: nowUtc,
      ...(correctionApplies ? { revisionIntent: "explicit_correction" } : {}),
    };
  }

  for (const evidenceText of assertiveEvidenceTexts) {
    for (const category of categories) {
      const derived = deriveExplicitUserMemoryClaim({
        category,
        evidenceText,
        candidateContent: candidate.content,
      });
      if (derived === undefined) continue;
      const correctionApplies = verifiedCorrectionAppliesToClaim(
        assertiveEvidenceTexts,
        categories,
        derived.subjectKey,
        candidate.content,
      );
      return {
        ...derived,
        recordedAtUtc: nowUtc,
        ...(correctionApplies ? { revisionIntent: "explicit_correction" } : {}),
      };
    }
  }
  return undefined;
}

function verifiedCorrectionAppliesToClaim(
  evidenceTexts: readonly string[],
  categories: readonly ("user_fact" | "user_preference")[],
  subjectKey: string,
  candidateContent: string,
): boolean {
  return evidenceTexts.some((evidenceText) =>
    categories.some((category) =>
      hasExplicitMemoryCorrectionForClaim({
        category,
        evidenceText,
        subjectKey,
        candidateContent,
      }),
    ),
  );
}

function memoryClaimCategories(
  candidate: MemoryCandidate,
): readonly ("user_fact" | "user_preference")[] {
  const tags = new Set(
    candidate.tags.map((tag) =>
      tag.normalize("NFKC").trim().toLocaleLowerCase(),
    ),
  );
  const preference = [
    "user_preference",
    "preference",
    "care_preference",
    "personal_preference",
  ].some((tag) => tags.has(tag));
  const fact = ["user_fact", "fact"].some((tag) => tags.has(tag));
  if (preference && fact) return ["user_preference", "user_fact"];
  if (preference) return ["user_preference"];
  if (fact) return ["user_fact"];
  // A trusted semantic user-memory may still use an application-authored tag.
  // Both parsers are conservative and return nothing for unsupported language.
  return ["user_preference", "user_fact"];
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

    const completeQuote = source.content.trim().slice(0, 2_000);
    const quote = requestedQuote?.trim().slice(0, 2_000) ?? completeQuote;
    if (quote.length === 0) return;
    const evidenceKey = `message:${sourceId}`;
    const existing = result.get(evidenceKey);
    if (
      existing?.quote !== undefined &&
      normalizedEvidenceText(existing.quote) ===
        normalizedEvidenceText(completeQuote)
    ) {
      return;
    }
    result.set(evidenceKey, {
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
  const normalizedQuote = normalizedEvidenceText(quote);
  return (
    normalizedQuote.length > 0 &&
    normalizedEvidenceText(source).includes(normalizedQuote)
  );
}

function normalizedEvidenceText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase();
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
  if (candidate.reasonCode === "server_owned_relationship_evidence") {
    return evidence.some((item) => {
      if (item.sourceType !== "message") return false;
      const source = catalog.messages.get(item.sourceId);
      return (
        source?.role === "user" &&
        isExplicitUserMemoryStatement(source.content) &&
        memoryContentGrounded(candidate, item.quote ?? source.content)
      );
    });
  }
  return evidence.some((item) => {
    if (item.sourceType !== "message") return false;
    const source = catalog.messages.get(item.sourceId);
    if (source === undefined || source.role === "system") return false;
    if (!messageDirectlyAssertsOccurredSharedExperience(source.content)) {
      return false;
    }
    return /\b(?:we|us|our|together|you\s+and\s+i|both\s+of\s+us)\b|\u6211\u4eec|\u54b1\u4eec|\u4e00\u8d77|\u5171\u540c|\u4f60\u548c\u6211/iu.test(
      item.quote ?? source.content,
    );
  });
}

function messageDirectlyAssertsOccurredSharedExperience(text: string): boolean {
  const normalized = text.normalize("NFKC").replace(/\s+/gu, " ").trim();
  if (!isExplicitUserMemoryStatement(normalized)) return false;
  if (
    /(?:打算|计划|准备|以后|将来|想要).{0,40}(?:一起|共同)/u.test(normalized)
  ) {
    return false;
  }
  if (
    /(?:没有|没|并未|从未|未曾).{0,24}(?:一起|共同|见面|吃饭|活动|看展)/u.test(
      normalized,
    )
  ) {
    return false;
  }
  return true;
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

function memoryEvidenceFromRow(
  row: MemoryEvidenceRow,
): MemoryEvidence | undefined {
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
  return parsed.success ? parsed.data : undefined;
}

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
