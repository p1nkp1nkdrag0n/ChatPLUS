import type {
  AgentAutobiographySnapshot,
  AutobiographyEntry,
  ConversationCheckpoint,
  ContinuityEvidenceRef,
  EventCard,
  JsonValue,
} from "@personasim/contracts";
import {
  boundedRecallHanBigrams,
  boundedRecallQueryTokens,
  recallExactIdentifiers,
} from "@personasim/features";

import type { DatabaseStore } from "../db/store.js";

type SqlRow = Record<string, unknown>;
const HAN_BIGRAM_LIMIT = 64;

export interface ArchivedMessage {
  id: string;
  sessionId: string;
  agentId: string;
  role: "user" | "assistant";
  messageKind: "user" | "assistant_reply" | "assistant_proactive";
  content: string;
  replyToMessageId?: string;
  createdAtUtc: string;
}

export interface SessionRevision {
  sessionId: string;
  agentId: string;
  revision: number;
}

export interface AutobiographyBundle {
  snapshot: AgentAutobiographySnapshot;
  entries: AutobiographyEntry[];
}

export class ContinuityRepository {
  constructor(readonly store: DatabaseStore) {}

  transaction<T>(work: () => T): T {
    return this.store.transaction(work);
  }

  getSessionRevision(sessionId: string): SessionRevision | undefined {
    const row = this.store.database
      .prepare(
        `SELECT id, agent_id, message_revision
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as
      { id: string; agent_id: string; message_revision: number } | undefined;
    return row === undefined
      ? undefined
      : {
          sessionId: row.id,
          agentId: row.agent_id,
          revision: Number(row.message_revision),
        };
  }

  listArchivedMessages(sessionId: string): ArchivedMessage[] {
    return (
      this.store.database
        .prepare(
          `SELECT archive.*, messages.in_reply_to_message_id
           FROM message_archive AS archive
           JOIN messages ON messages.id = archive.id
           WHERE archive.session_id = ?
           ORDER BY archive.source_created_at_utc, messages.rowid`,
        )
        .all(sessionId) as SqlRow[]
    ).map(mapArchivedMessage);
  }

  listArchivedMessageRange(
    sessionId: string,
    fromMessageId: string,
    throughMessageId: string,
  ): ArchivedMessage[] {
    const messages = this.listArchivedMessages(sessionId);
    const start = messages.findIndex((message) => message.id === fromMessageId);
    const end = messages.findIndex(
      (message) => message.id === throughMessageId,
    );
    return start < 0 || end < start ? [] : messages.slice(start, end + 1);
  }

  searchArchivedMessages(input: {
    agentId: string;
    query: string;
    limit?: number;
  }): ArchivedMessage[] {
    const limit = boundedLimit(input.limit, 20);
    const match = ftsMatch(input.query);
    const ftsMatches =
      match === undefined
        ? []
        : (
            this.store.database
              .prepare(
                `SELECT archive.*, messages.in_reply_to_message_id
                 FROM message_archive_fts AS fts
                 JOIN message_archive AS archive ON archive.rowid = fts.rowid
                 JOIN messages ON messages.id = archive.id
                 WHERE archive.agent_id = ? AND message_archive_fts MATCH ?
                 ORDER BY bm25(message_archive_fts), archive.source_created_at_utc DESC
                 LIMIT ?`,
              )
              .all(input.agentId, match, limit) as SqlRow[]
          ).map(mapArchivedMessage);
    const hanTerms = boundedRecallHanBigrams(input.query, HAN_BIGRAM_LIMIT);
    const tailHanAnchor = singleHanTailAnchor(input.query);
    const hanMatches =
      hanTerms.length === 0
        ? []
        : (
            this.store.database
              .prepare(
                `WITH han_terms(term) AS (
                   SELECT value FROM json_each(?)
                 ),
                 tail_anchor(term) AS (VALUES (?))
                 SELECT archive.*, messages.in_reply_to_message_id,
                   EXISTS (
                     SELECT 1 FROM tail_anchor
                     WHERE term <> '' AND instr(archive.content, term) > 0
                   ) AS tail_score,
                   (
                     SELECT COUNT(*) FROM han_terms
                     WHERE instr(archive.content, han_terms.term) > 0
                   ) AS han_score
                 FROM message_archive AS archive
                 JOIN messages ON messages.id = archive.id
                 WHERE archive.agent_id = ?
                   AND (
                     (
                       SELECT COUNT(*) FROM han_terms
                       WHERE instr(archive.content, han_terms.term) > 0
                     ) >= ?
                     OR EXISTS (
                       SELECT 1 FROM tail_anchor
                       WHERE term <> '' AND instr(archive.content, term) > 0
                     )
                   )
                 ORDER BY tail_score DESC, han_score DESC,
                   archive.source_created_at_utc DESC
                 LIMIT ?`,
              )
              .all(
                JSON.stringify(hanTerms),
                tailHanAnchor ?? "",
                input.agentId,
                Math.min(2, hanTerms.length),
                limit,
              ) as SqlRow[]
          ).map(mapArchivedMessage);
    return mergeSearchMatches(input.query, hanMatches, ftsMatches, limit);
  }

  rebuildMessageArchive(agentId: string, indexedAtUtc: string): number {
    this.store.database
      .prepare("DELETE FROM message_archive WHERE agent_id = ?")
      .run(agentId);
    return this.store.database
      .prepare(
        `INSERT INTO message_archive(
          id, session_id, agent_id, role, message_kind, content,
          source_created_at_utc, indexed_at_utc, index_version
        )
        SELECT id, session_id, agent_id, role, message_kind, content,
          created_at_utc, ?, 1
        FROM messages
        WHERE agent_id = ?
          AND role IN ('user', 'assistant')
          AND message_kind IN ('user', 'assistant_reply', 'assistant_proactive')`,
      )
      .run(indexedAtUtc, agentId).changes;
  }

  getLatestCommittedCheckpoint(
    sessionId: string,
  ): ConversationCheckpoint | undefined {
    const row = this.store.database
      .prepare(
        `SELECT * FROM conversation_checkpoints
         WHERE session_id = ? AND status = 'committed'
         ORDER BY committed_at_utc DESC, rowid DESC LIMIT 1`,
      )
      .get(sessionId) as SqlRow | undefined;
    return row === undefined ? undefined : mapCheckpoint(row);
  }

  getPendingCheckpoint(sessionId: string): ConversationCheckpoint | undefined {
    const row = this.store.database
      .prepare(
        `SELECT * FROM conversation_checkpoints
         WHERE session_id = ? AND status = 'pending' LIMIT 1`,
      )
      .get(sessionId) as SqlRow | undefined;
    return row === undefined ? undefined : mapCheckpoint(row);
  }

  getCheckpoint(checkpointId: string): ConversationCheckpoint | undefined {
    const row = this.store.database
      .prepare("SELECT * FROM conversation_checkpoints WHERE id = ?")
      .get(checkpointId) as SqlRow | undefined;
    return row === undefined ? undefined : mapCheckpoint(row);
  }

  listCommittedCheckpoints(agentId: string): ConversationCheckpoint[] {
    return (
      this.store.database
        .prepare(
          `SELECT * FROM conversation_checkpoints
           WHERE agent_id = ? AND status = 'committed'
           ORDER BY committed_at_utc, rowid`,
        )
        .all(agentId) as SqlRow[]
    ).map(mapCheckpoint);
  }

  beginCheckpoint(checkpoint: ConversationCheckpoint): ConversationCheckpoint {
    const prior = this.store.database
      .prepare(
        `SELECT * FROM conversation_checkpoints
         WHERE session_id = ? AND from_message_id = ?
           AND through_message_id = ? AND source_hash = ?`,
      )
      .get(
        checkpoint.sessionId,
        checkpoint.fromMessageId,
        checkpoint.throughMessageId,
        checkpoint.sourceHash,
      ) as SqlRow | undefined;
    if (prior !== undefined) {
      const mapped = mapCheckpoint(prior);
      if (mapped.status === "committed" || mapped.status === "pending") {
        return mapped;
      }
      this.store.database
        .prepare(
          `UPDATE conversation_checkpoints SET
             previous_checkpoint_id = ?, source_revision = ?,
             source_message_count = ?, source_token_estimate = ?,
             autobiography_snapshot_id = NULL, artifact_json = NULL,
             status = 'pending', failure_code = NULL, failure_summary = NULL,
             updated_at_utc = ?, committed_at_utc = NULL,
             invalidated_at_utc = NULL
           WHERE id = ? AND status IN ('invalidated', 'failed')`,
        )
        .run(
          checkpoint.previousCheckpointId ?? null,
          checkpoint.sourceRevision,
          checkpoint.sourceMessageCount,
          checkpoint.sourceTokenEstimate,
          checkpoint.updatedAtUtc,
          mapped.id,
        );
      return this.getCheckpoint(mapped.id) ?? mapped;
    }
    this.store.database
      .prepare(
        `INSERT INTO conversation_checkpoints(
          id, agent_id, session_id, previous_checkpoint_id,
          from_message_id, through_message_id, source_hash, source_revision,
          source_message_count, source_token_estimate,
          autobiography_snapshot_id, artifact_json, status,
          failure_code, failure_summary, created_at_utc, updated_at_utc,
          committed_at_utc, invalidated_at_utc
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'pending',
          NULL, NULL, ?, ?, NULL, NULL
        )`,
      )
      .run(
        checkpoint.id,
        checkpoint.agentId,
        checkpoint.sessionId,
        checkpoint.previousCheckpointId ?? null,
        checkpoint.fromMessageId,
        checkpoint.throughMessageId,
        checkpoint.sourceHash,
        checkpoint.sourceRevision,
        checkpoint.sourceMessageCount,
        checkpoint.sourceTokenEstimate,
        checkpoint.createdAtUtc,
        checkpoint.updatedAtUtc,
      );
    return checkpoint;
  }

  commitCheckpoint(input: {
    checkpointId: string;
    autobiographySnapshotId: string;
    artifact: unknown;
    committedAtUtc: string;
  }): boolean {
    return (
      this.store.database
        .prepare(
          `UPDATE conversation_checkpoints SET
             autobiography_snapshot_id = ?, artifact_json = ?,
             status = 'committed', updated_at_utc = ?, committed_at_utc = ?,
             failure_code = NULL, failure_summary = NULL,
             invalidated_at_utc = NULL
           WHERE id = ? AND status = 'pending'`,
        )
        .run(
          input.autobiographySnapshotId,
          JSON.stringify(input.artifact),
          input.committedAtUtc,
          input.committedAtUtc,
          input.checkpointId,
        ).changes === 1
    );
  }

  invalidateCheckpoint(input: {
    checkpointId: string;
    invalidatedAtUtc: string;
    failureCode: string;
    failureSummary: string;
  }): boolean {
    return (
      this.store.database
        .prepare(
          `UPDATE conversation_checkpoints SET
             status = 'invalidated', updated_at_utc = ?,
             invalidated_at_utc = ?, failure_code = ?, failure_summary = ?
           WHERE id = ? AND status = 'pending'`,
        )
        .run(
          input.invalidatedAtUtc,
          input.invalidatedAtUtc,
          input.failureCode,
          input.failureSummary,
          input.checkpointId,
        ).changes === 1
    );
  }

  failCheckpoint(input: {
    checkpointId: string;
    failedAtUtc: string;
    failureCode: string;
    failureSummary: string;
  }): boolean {
    return (
      this.store.database
        .prepare(
          `UPDATE conversation_checkpoints SET
             status = 'failed', updated_at_utc = ?, failure_code = ?,
             failure_summary = ?, committed_at_utc = NULL,
             invalidated_at_utc = NULL
           WHERE id = ? AND status = 'pending'`,
        )
        .run(
          input.failedAtUtc,
          input.failureCode,
          input.failureSummary,
          input.checkpointId,
        ).changes === 1
    );
  }

  getLatestAutobiography(agentId: string): AutobiographyBundle | undefined {
    const row = this.store.database
      .prepare(
        `SELECT * FROM autobiography_snapshots
         WHERE agent_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(agentId) as SqlRow | undefined;
    if (row === undefined) return undefined;
    const snapshot = mapAutobiographySnapshot(row);
    const entries = (
      this.store.database
        .prepare(
          `SELECT * FROM autobiography_entries
           WHERE snapshot_id = ? ORDER BY ordinal, rowid`,
        )
        .all(snapshot.id) as SqlRow[]
    ).map(mapAutobiographyEntry);
    return { snapshot, entries };
  }

  insertAutobiography(bundle: AutobiographyBundle): void {
    const { snapshot } = bundle;
    this.store.database
      .prepare(
        `INSERT INTO autobiography_snapshots(
          id, agent_id, source_checkpoint_id, previous_snapshot_id, revision,
          summary_first_person, important_experiences_json,
          relationship_changes_json, active_goals_json,
          unresolved_threads_json, commitments_json,
          source_evidence_ids_json, from_utc, through_utc,
          snapshot_json, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.id,
        snapshot.agentId,
        snapshot.sourceCheckpointId,
        snapshot.previousSnapshotId ?? null,
        snapshot.revision,
        snapshot.summaryFirstPerson,
        JSON.stringify(snapshot.importantExperiences),
        JSON.stringify(snapshot.relationshipChanges),
        JSON.stringify(snapshot.activeGoals),
        JSON.stringify(snapshot.unresolvedThreads),
        JSON.stringify(snapshot.commitments),
        JSON.stringify(snapshot.sourceEvidenceIds),
        snapshot.fromUtc,
        snapshot.throughUtc,
        JSON.stringify(snapshot),
        snapshot.createdAtUtc,
      );
    const statement = this.store.database.prepare(
      `INSERT INTO autobiography_entries(
        id, snapshot_id, agent_id, entry_kind, ordinal, content,
        temporal_status, from_utc, through_utc, source_evidence_ids_json,
        evidence_json, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const entry of bundle.entries) {
      statement.run(
        entry.id,
        entry.snapshotId,
        entry.agentId,
        entry.entryKind,
        entry.ordinal,
        entry.content,
        entry.temporalStatus,
        entry.fromUtc ?? null,
        entry.throughUtc ?? null,
        JSON.stringify(entry.sourceEvidenceIds),
        JSON.stringify(entry.evidence),
        entry.createdAtUtc,
      );
    }
  }

  upsertEventCards(cards: readonly EventCard[]): number {
    const statement = this.store.database.prepare(
      `INSERT INTO event_cards(
        id, agent_id, session_id, checkpoint_id, card_kind, source_kind,
        source_id, dedupe_key, title, summary, tags_json, tags_text,
        namespace, certainty, attribution, temporal_status,
        mentioned_at_utc, planned_start_at_utc, planned_end_at_utc,
        occurred_start_at_utc, occurred_end_at_utc, recorded_at_utc,
        importance, status, source_evidence_ids_json, evidence_json,
        card_json, index_version, created_at_utc, updated_at_utc
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT(dedupe_key) DO UPDATE SET
        session_id = excluded.session_id,
        checkpoint_id = excluded.checkpoint_id,
        card_kind = excluded.card_kind,
        source_kind = excluded.source_kind,
        source_id = excluded.source_id,
        title = excluded.title,
        summary = excluded.summary,
        tags_json = excluded.tags_json,
        tags_text = excluded.tags_text,
        namespace = excluded.namespace,
        certainty = excluded.certainty,
        attribution = excluded.attribution,
        temporal_status = excluded.temporal_status,
        mentioned_at_utc = excluded.mentioned_at_utc,
        planned_start_at_utc = excluded.planned_start_at_utc,
        planned_end_at_utc = excluded.planned_end_at_utc,
        occurred_start_at_utc = excluded.occurred_start_at_utc,
        occurred_end_at_utc = excluded.occurred_end_at_utc,
        recorded_at_utc = excluded.recorded_at_utc,
        importance = excluded.importance,
        status = excluded.status,
        source_evidence_ids_json = excluded.source_evidence_ids_json,
        evidence_json = excluded.evidence_json,
        card_json = excluded.card_json,
        index_version = excluded.index_version,
        updated_at_utc = excluded.updated_at_utc
      WHERE event_cards.agent_id = excluded.agent_id`,
    );
    let changed = 0;
    for (const card of cards) {
      const temporal = card.temporalMetadata;
      changed += statement.run(
        card.id,
        card.agentId,
        card.sessionId ?? null,
        card.checkpointId ?? null,
        card.cardKind,
        card.sourceKind,
        card.sourceId,
        card.dedupeKey,
        card.title,
        card.summary,
        JSON.stringify(card.tags),
        card.tags.join(" "),
        card.namespace,
        card.certainty,
        card.attribution,
        temporal.temporalStatus,
        temporal.mentionedAtUtc ?? null,
        temporal.plannedStartAtUtc ?? null,
        temporal.plannedEndAtUtc ?? null,
        temporal.occurredStartAtUtc ?? null,
        temporal.occurredEndAtUtc ?? null,
        temporal.recordedAtUtc,
        card.importance,
        card.status,
        JSON.stringify(card.sourceEvidenceIds),
        JSON.stringify(card.evidence),
        JSON.stringify(card),
        card.indexVersion,
        card.createdAtUtc,
        card.updatedAtUtc,
      ).changes;
    }
    return changed;
  }

  searchEventCards(input: {
    agentId: string;
    query: string;
    limit?: number;
  }): EventCard[] {
    const limit = boundedLimit(input.limit, 20);
    const match = ftsMatch(input.query);
    const ftsMatches =
      match === undefined
        ? []
        : (
            this.store.database
              .prepare(
                `SELECT cards.card_json
                 FROM event_cards_fts AS fts
                 JOIN event_cards AS cards ON cards.rowid = fts.rowid
                 WHERE cards.agent_id = ? AND cards.status = 'active'
                   AND event_cards_fts MATCH ?
                 ORDER BY bm25(event_cards_fts), cards.importance DESC,
                   cards.recorded_at_utc DESC
                 LIMIT ?`,
              )
              .all(input.agentId, match, limit) as Array<{
              card_json: string;
            }>
          ).map((row) => JSON.parse(row.card_json) as EventCard);
    const hanTerms = boundedRecallHanBigrams(input.query, HAN_BIGRAM_LIMIT);
    const tailHanAnchor = singleHanTailAnchor(input.query);
    const hanMatches =
      hanTerms.length === 0
        ? []
        : (
            this.store.database
              .prepare(
                `WITH han_terms(term) AS (
                   SELECT value FROM json_each(?)
                 ),
                 tail_anchor(term) AS (VALUES (?))
                 SELECT cards.card_json,
                   EXISTS (
                     SELECT 1 FROM tail_anchor
                     WHERE term <> ''
                       AND (
                         instr(cards.title, term) > 0
                         OR instr(cards.summary, term) > 0
                         OR instr(cards.tags_text, term) > 0
                       )
                   ) AS tail_score,
                   (
                     SELECT COUNT(*) FROM han_terms
                     WHERE instr(cards.title, han_terms.term) > 0
                       OR instr(cards.summary, han_terms.term) > 0
                       OR instr(cards.tags_text, han_terms.term) > 0
                   ) AS han_score
                 FROM event_cards AS cards
                 WHERE cards.agent_id = ? AND cards.status = 'active'
                   AND (
                     (
                       SELECT COUNT(*) FROM han_terms
                       WHERE instr(cards.title, han_terms.term) > 0
                         OR instr(cards.summary, han_terms.term) > 0
                         OR instr(cards.tags_text, han_terms.term) > 0
                     ) >= ?
                     OR EXISTS (
                       SELECT 1 FROM tail_anchor
                       WHERE term <> ''
                         AND (
                           instr(cards.title, term) > 0
                           OR instr(cards.summary, term) > 0
                           OR instr(cards.tags_text, term) > 0
                         )
                     )
                   )
                 ORDER BY tail_score DESC, han_score DESC, cards.importance DESC,
                   cards.recorded_at_utc DESC
                 LIMIT ?`,
              )
              .all(
                JSON.stringify(hanTerms),
                tailHanAnchor ?? "",
                input.agentId,
                Math.min(2, hanTerms.length),
                limit,
              ) as Array<{ card_json: string }>
          ).map((row) => JSON.parse(row.card_json) as EventCard);
    return mergeSearchMatches(input.query, hanMatches, ftsMatches, limit);
  }

  replaceEventCards(agentId: string, cards: readonly EventCard[]): number {
    this.store.database
      .prepare("DELETE FROM event_cards WHERE agent_id = ?")
      .run(agentId);
    return this.upsertEventCards(cards);
  }

  listAutobiographyEntries(agentId: string): AutobiographyEntry[] {
    return (
      this.store.database
        .prepare(
          `SELECT * FROM autobiography_entries
           WHERE agent_id = ? ORDER BY created_at_utc, ordinal, rowid`,
        )
        .all(agentId) as SqlRow[]
    ).map(mapAutobiographyEntry);
  }

  listActivitiesForIndex(agentId: string): Array<Record<string, unknown>> {
    return this.store.database
      .prepare(
        `SELECT id, event_type, occurred_at_utc, summary,
          outcome_facts_json, origin
         FROM activity_events WHERE agent_id = ?
         ORDER BY occurred_at_utc, rowid`,
      )
      .all(agentId) as Array<Record<string, unknown>>;
  }

  listDomainEventsForIndex(agentId: string): Array<Record<string, unknown>> {
    return this.store.database
      .prepare(
        `SELECT id, event_type, effective_at_utc, recorded_at_utc, payload_json
         FROM domain_events WHERE agent_id = ?
         ORDER BY effective_at_utc, rowid`,
      )
      .all(agentId) as Array<Record<string, unknown>>;
  }
}

function mapArchivedMessage(row: SqlRow): ArchivedMessage {
  const replyToMessageId = optionalString(row["in_reply_to_message_id"]);
  return {
    id: String(row["id"]),
    sessionId: String(row["session_id"]),
    agentId: String(row["agent_id"]),
    role: String(row["role"]) as ArchivedMessage["role"],
    messageKind: String(row["message_kind"]) as ArchivedMessage["messageKind"],
    content: String(row["content"]),
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }),
    createdAtUtc: String(row["source_created_at_utc"]),
  };
}

function mapCheckpoint(row: SqlRow): ConversationCheckpoint {
  const previousCheckpointId = optionalString(row["previous_checkpoint_id"]);
  const autobiographySnapshotId = optionalString(
    row["autobiography_snapshot_id"],
  );
  const artifact = parseOptionalJson(row["artifact_json"]) as
    JsonValue | undefined;
  const failureCode = optionalString(row["failure_code"]);
  const failureSummary = optionalString(row["failure_summary"]);
  const committedAtUtc = optionalString(row["committed_at_utc"]);
  const invalidatedAtUtc = optionalString(row["invalidated_at_utc"]);
  return {
    id: String(row["id"]),
    agentId: String(row["agent_id"]),
    sessionId: String(row["session_id"]),
    ...(previousCheckpointId === undefined ? {} : { previousCheckpointId }),
    fromMessageId: String(row["from_message_id"]),
    throughMessageId: String(row["through_message_id"]),
    sourceHash: String(row["source_hash"]),
    sourceRevision: Number(row["source_revision"]),
    sourceMessageCount: Number(row["source_message_count"]),
    sourceTokenEstimate: Number(row["source_token_estimate"]),
    ...(autobiographySnapshotId === undefined
      ? {}
      : { autobiographySnapshotId }),
    ...(artifact === undefined ? {} : { artifact }),
    status: String(row["status"]) as ConversationCheckpoint["status"],
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(failureSummary === undefined ? {} : { failureSummary }),
    createdAtUtc: String(row["created_at_utc"]),
    updatedAtUtc: String(row["updated_at_utc"]),
    ...(committedAtUtc === undefined ? {} : { committedAtUtc }),
    ...(invalidatedAtUtc === undefined ? {} : { invalidatedAtUtc }),
  };
}
function mapAutobiographySnapshot(row: SqlRow): AgentAutobiographySnapshot {
  const previousSnapshotId = optionalString(row["previous_snapshot_id"]);
  return {
    id: String(row["id"]),
    agentId: String(row["agent_id"]),
    sourceCheckpointId: String(row["source_checkpoint_id"]),
    ...(previousSnapshotId === undefined ? {} : { previousSnapshotId }),
    revision: Number(row["revision"]),
    summaryFirstPerson: String(row["summary_first_person"]),
    importantExperiences: parseStringArray(row["important_experiences_json"]),
    relationshipChanges: parseStringArray(row["relationship_changes_json"]),
    activeGoals: parseStringArray(row["active_goals_json"]),
    unresolvedThreads: parseStringArray(row["unresolved_threads_json"]),
    commitments: parseStringArray(row["commitments_json"]),
    sourceEvidenceIds: parseStringArray(row["source_evidence_ids_json"]),
    fromUtc: String(row["from_utc"]),
    throughUtc: String(row["through_utc"]),
    createdAtUtc: String(row["created_at_utc"]),
  };
}

function mapAutobiographyEntry(row: SqlRow): AutobiographyEntry {
  const fromUtc = optionalString(row["from_utc"]);
  const throughUtc = optionalString(row["through_utc"]);
  return {
    id: String(row["id"]),
    snapshotId: String(row["snapshot_id"]),
    agentId: String(row["agent_id"]),
    entryKind: String(row["entry_kind"]) as AutobiographyEntry["entryKind"],
    ordinal: Number(row["ordinal"]),
    content: String(row["content"]),
    temporalStatus: String(
      row["temporal_status"],
    ) as AutobiographyEntry["temporalStatus"],
    ...(fromUtc === undefined ? {} : { fromUtc }),
    ...(throughUtc === undefined ? {} : { throughUtc }),
    sourceEvidenceIds: parseStringArray(row["source_evidence_ids_json"]),
    evidence: parseOptionalJson(
      row["evidence_json"],
    ) as ContinuityEvidenceRef[],
    createdAtUtc: String(row["created_at_utc"]),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOptionalJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: unknown): string[] {
  const parsed = typeof value === "string" ? parseOptionalJson(value) : value;
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(100, Math.trunc(value ?? fallback)));
}

function singleHanTailAnchor(query: string): string | undefined {
  const runs = query.normalize("NFKC").match(/\p{Script=Han}+/gu) ?? [];
  const characters = Array.from(runs.at(-1) ?? "");
  return characters.length === 2 ? characters.join("") : undefined;
}

function mergeSearchMatches<T extends { id: string }>(
  query: string,
  hanMatches: readonly T[],
  ftsMatches: readonly T[],
  limit: number,
): T[] {
  return recallExactIdentifiers(query).length > 0
    ? mergeUniqueById(ftsMatches, hanMatches, limit)
    : mergeUniqueById(hanMatches, ftsMatches, limit);
}

function mergeUniqueById<T extends { id: string }>(
  prioritized: readonly T[],
  fallback: readonly T[],
  limit: number,
): T[] {
  const merged: T[] = [];
  const seen = new Set<string>();
  for (const item of [...prioritized, ...fallback]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
    if (merged.length >= limit) break;
  }
  return merged;
}

function ftsMatch(query: string): string | undefined {
  const terms = boundedRecallQueryTokens(query, 12).filter((term) =>
    /^[\p{L}\p{N}_]+$/u.test(term),
  );
  return terms.length === 0
    ? undefined
    : terms.map((term) => `"${term}"`).join(" OR ");
}
