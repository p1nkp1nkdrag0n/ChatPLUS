import {
  mergeMemoryProposal,
  memoryDedupeKey,
  validateMemoryProposal,
  type MemoryLike,
  type MemoryProposalLike,
} from "@personasim/features";
import {
  MemoryCandidateSchema,
  MemorySchema,
  type Memory,
  type MemoryCandidate,
} from "@personasim/contracts";

import type { DatabaseStore } from "../db/store.js";

type PersistMemoryInput = {
  store: DatabaseStore;
  agentId: string;
  candidates: readonly MemoryCandidate[];
  nowUtc: string;
  maxCandidates: number;
  authoritativeMessageId?: string;
  authoritativeActivityEventId?: string;
};

export function readActiveMemories(
  store: DatabaseStore,
  agentId: string,
  nowUtc: string,
  limit = 20,
): MemoryLike[] {
  const rows = store.database
    .prepare(
      `SELECT id, agent_id, type, content, tags_json, importance, confidence,
        source_message_id, source_event_id, created_at_utc, valid_until_utc, memory_json
       FROM memories
       WHERE agent_id = ? AND (valid_until_utc IS NULL OR valid_until_utc > ?)
       ORDER BY importance DESC, created_at_utc DESC LIMIT ?`,
    )
    .all(agentId, nowUtc, limit) as MemoryRow[];
  return rows.map((row) => {
    if (row.memory_json) {
      const parsed: unknown = JSON.parse(row.memory_json);
      return toFeatureMemory(MemorySchema.parse(parsed));
    }
    const kind = legacyKind(row.type);
    return toFeatureMemory(
      MemorySchema.parse({
        id: row.id,
        agentId: row.agent_id,
        kind,
        content: row.content,
        importance: row.importance,
        confidence: row.confidence,
        occurredAtUtc: row.created_at_utc,
        ...(row.valid_until_utc ? { expiresAtUtc: row.valid_until_utc } : {}),
        tags: parseTags(row.tags_json),
        sourceMessageIds: row.source_message_id ? [row.source_message_id] : [],
        sourceActivityEventIds: row.source_event_id
          ? [row.source_event_id]
          : [],
        origin: "runtime_simulation",
        status: "active",
        dedupeKey: memoryDedupeKey(row.agent_id, kind, row.content),
        createdAtUtc: row.created_at_utc,
        updatedAtUtc: row.created_at_utc,
      }),
    );
  });
}

export function validateMergeAndPersistMemories(
  input: PersistMemoryInput,
): Memory[] {
  if (input.maxCandidates <= 0 || input.candidates.length === 0) return [];
  const knownMessageIds = new Set(
    (
      input.store.database
        .prepare("SELECT id FROM messages WHERE agent_id = ?")
        .all(input.agentId) as Array<{ id: string }>
    ).map((row) => row.id),
  );
  const knownActivityIds = new Set(
    (
      input.store.database
        .prepare("SELECT id FROM activity_events WHERE agent_id = ?")
        .all(input.agentId) as Array<{ id: string }>
    ).map((row) => row.id),
  );
  if (input.authoritativeMessageId)
    knownMessageIds.add(input.authoritativeMessageId);
  if (input.authoritativeActivityEventId)
    knownActivityIds.add(input.authoritativeActivityEventId);

  const existing = readActiveMemories(
    input.store,
    input.agentId,
    input.nowUtc,
    500,
  );
  const persisted: Memory[] = [];
  for (const rawCandidate of input.candidates.slice(0, input.maxCandidates)) {
    const candidate = MemoryCandidateSchema.parse(rawCandidate);
    const proposal = normalizeRuntimeProposal(
      candidate,
      knownMessageIds,
      knownActivityIds,
      input.authoritativeMessageId,
      input.authoritativeActivityEventId,
    );
    const validation = validateMemoryProposal(proposal);
    if (!validation.accepted || !validation.proposal) continue;
    const merged = mergeMemoryProposal(
      input.agentId,
      validation.proposal,
      existing,
      input.nowUtc,
    );
    if (!merged) continue;
    const memory = MemorySchema.parse(merged.memory);
    upsertMemory(input.store, memory);
    const existingIndex = existing.findIndex((item) => item.id === memory.id);
    const featureMemory = toFeatureMemory(memory);
    if (existingIndex >= 0) existing[existingIndex] = featureMemory;
    else existing.push(featureMemory);
    persisted.push(memory);
  }
  return persisted;
}

function normalizeRuntimeProposal(
  candidate: MemoryCandidate,
  knownMessageIds: ReadonlySet<string>,
  knownActivityIds: ReadonlySet<string>,
  authoritativeMessageId?: string,
  authoritativeActivityEventId?: string,
): MemoryProposalLike {
  const sourceMessageIds = candidate.sourceMessageIds.filter((id) =>
    knownMessageIds.has(id),
  );
  const sourceActivityEventIds = candidate.sourceActivityEventIds.filter((id) =>
    knownActivityIds.has(id),
  );
  if (authoritativeMessageId) sourceMessageIds.push(authoritativeMessageId);
  if (authoritativeActivityEventId)
    sourceActivityEventIds.push(authoritativeActivityEventId);
  return {
    kind: candidate.kind,
    content: candidate.content,
    importance: candidate.importance,
    confidence: candidate.confidence,
    ...(candidate.occurredAtUtc
      ? { occurredAtUtc: candidate.occurredAtUtc }
      : {}),
    ...(candidate.expiresAtUtc ? { expiresAtUtc: candidate.expiresAtUtc } : {}),
    tags: candidate.tags,
    sourceMessageIds: [...new Set(sourceMessageIds)],
    sourceActivityEventIds: [...new Set(sourceActivityEventIds)],
    origin: "runtime_simulation",
    reasonCode: candidate.reasonCode,
    reasonSummary: candidate.reasonSummary,
  };
}

function upsertMemory(store: DatabaseStore, memory: Memory): void {
  store.database
    .prepare(
      `INSERT INTO memories(
        id, agent_id, type, content, tags_json, importance, confidence,
        source_message_id, source_event_id, created_at_utc, valid_until_utc, memory_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        tags_json = excluded.tags_json,
        importance = excluded.importance,
        confidence = excluded.confidence,
        source_message_id = excluded.source_message_id,
        source_event_id = excluded.source_event_id,
        valid_until_utc = excluded.valid_until_utc,
        memory_json = excluded.memory_json`,
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
    );
}

function parseTags(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed)
    ? parsed.filter((tag): tag is string => typeof tag === "string")
    : [];
}

function legacyKind(value: string): Memory["kind"] {
  if (
    value === "semantic" ||
    value === "relationship" ||
    value === "commitment"
  )
    return value;
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
    ...(memory.supersededById === undefined
      ? {}
      : { supersededById: memory.supersededById }),
    createdAtUtc: memory.createdAtUtc,
    updatedAtUtc: memory.updatedAtUtc,
  };
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
};
