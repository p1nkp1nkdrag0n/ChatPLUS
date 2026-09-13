import { createHash } from "node:crypto";
import type {
  DiaryDraft,
  DiarySourceMessage,
  DiaryVolume,
  DiaryVolumesQuery,
} from "@personasim/contracts";
import type { DatabaseStore } from "../db/store.js";
import { createEntityId } from "../domain/id.js";
import { ApiError } from "../domain/errors.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";

export interface DiaryMaterialMessage extends DiarySourceMessage {
  sourceOrder: number;
  sessionId: string;
  inReplyToMessageId: string | null;
  sourceNeedsReview: boolean;
}
export interface DiaryHistoricalState {
  id: string;
  sourceMessageId: string;
  recordedAtUtc: string;
  effectiveAtUtc: string;
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}
export interface DiaryDependency {
  key: string;
  hash: string;
}
export interface DiaryMaterial {
  fromUtc: string;
  toUtc: string;
  sourceMessages: DiaryMaterialMessage[];
  sourceMessageIds: string[];
  historicalStates: DiaryHistoricalState[];
  appraisals: unknown[];
  dependencies: DiaryDependency[];
  sourceHash: string;
}
export interface DiaryHead {
  id: string;
  agentId: string;
  entryDate: string;
  timezone: string;
  currentRevision: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}
export interface DiaryStoredRevision extends DiaryHead {
  revision: number;
  title: string;
  body: string;
  revisionCreatedAtUtc: string;
  sourceHash: string;
  sourceSnapshot: DiaryMaterial;
}
export interface DiaryRun {
  id: string;
  entryId: string;
  requestHash: string;
  status: "pending" | "succeeded" | "failed";
  resultRevision: number | null;
  errorCode: string | null;
  expectedRevision: number;
}

const HEAD_COLUMNS = `id, agent_id AS agentId, entry_date AS entryDate, timezone,
  current_revision AS currentRevision, created_at_utc AS createdAtUtc, updated_at_utc AS updatedAtUtc`;

export function diaryHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class DiaryRepository {
  constructor(readonly store: DatabaseStore) {}

  head(agentId: string, entryDate: string): DiaryHead | undefined {
    return this.store.database
      .prepare(
        `SELECT ${HEAD_COLUMNS} FROM diary_entries WHERE agent_id = ? AND entry_date = ?`,
      )
      .get(agentId, entryDate) as DiaryHead | undefined;
  }

  list(agentId: string, month?: string): DiaryStoredRevision[] {
    const heads = this.store.database
      .prepare(
        `SELECT ${HEAD_COLUMNS} FROM diary_entries
      WHERE agent_id = ? AND current_revision > 0 AND (? IS NULL OR substr(entry_date,1,7) = ?)
      ORDER BY entry_date DESC`,
      )
      .all(agentId, month ?? null, month ?? null) as DiaryHead[];
    return heads.map((head) => this.revision(head, head.currentRevision)!);
  }

  volumes(query: DiaryVolumesQuery): DiaryVolume[] {
    return this.store.database
      .prepare(
        `SELECT d.agent_id AS agentId, c.name AS characterName,
      substr(d.entry_date,1,7) AS month, COUNT(*) AS entryCount, MAX(d.entry_date) AS latestEntryDate,
      MAX(d.updated_at_utc) AS updatedAtUtc
      FROM diary_entries d JOIN characters c ON c.id = d.agent_id
      WHERE d.current_revision > 0 AND (? IS NULL OR d.agent_id = ?)
        AND (? IS NULL OR CAST(substr(d.entry_date,1,4) AS INTEGER) = ?)
        AND (? IS NULL OR CAST(substr(d.entry_date,6,2) AS INTEGER) = ?)
      GROUP BY d.agent_id, substr(d.entry_date,1,7) ORDER BY month DESC, characterName, agentId`,
      )
      .all(
        query.agentId ?? null,
        query.agentId ?? null,
        query.year ?? null,
        query.year ?? null,
        query.month ?? null,
        query.month ?? null,
      ) as DiaryVolume[];
  }

  revision(head: DiaryHead, revision: number): DiaryStoredRevision | undefined {
    const row = this.store.database
      .prepare(
        `SELECT revision, title, body, source_hash AS sourceHash,
      source_snapshot_json AS sourceSnapshotJson, created_at_utc AS revisionCreatedAtUtc
      FROM diary_revisions WHERE entry_id = ? AND revision = ?`,
      )
      .get(head.id, revision) as
      | {
          revision: number;
          title: string;
          body: string;
          sourceHash: string;
          sourceSnapshotJson: string;
          revisionCreatedAtUtc: string;
        }
      | undefined;
    if (!row) return undefined;
    const { sourceSnapshotJson, ...fields } = row;
    return {
      ...head,
      ...fields,
      sourceSnapshot: JSON.parse(sourceSnapshotJson) as DiaryMaterial,
    };
  }

  run(agentId: string, clientRequestId: string): DiaryRun | undefined {
    return this.store.database
      .prepare(
        `SELECT id, entry_id AS entryId, request_hash AS requestHash,
      status, result_revision AS resultRevision, error_code AS errorCode, expected_revision AS expectedRevision
      FROM diary_generation_runs WHERE agent_id = ? AND client_request_id = ?`,
      )
      .get(agentId, clientRequestId) as DiaryRun | undefined;
  }

  begin(input: {
    agentId: string;
    entryDate: string;
    timezone: string;
    nowUtc: string;
    clientRequestId: string;
    requestHash: string;
    expectedRevision: number;
    sourceHash: string;
  }): DiaryRun {
    return this.store.transaction(() => {
      const head = this.head(input.agentId, input.entryDate);
      if ((head?.currentRevision ?? 0) !== input.expectedRevision)
        throw new ApiError(
          409,
          "diary_revision_conflict",
          "日记已更新，请刷新后重试。",
        );
      const entryId = head?.id ?? createEntityId("diary");
      if (!head)
        this.store.database
          .prepare(
            `INSERT INTO diary_entries
        (id,agent_id,entry_date,timezone,current_revision,created_at_utc,updated_at_utc) VALUES (?,?,?,?,0,?,?)`,
          )
          .run(
            entryId,
            input.agentId,
            input.entryDate,
            input.timezone,
            input.nowUtc,
            input.nowUtc,
          );
      // A crashed generation may release its slot, but its request is never silently replayed.
      this.store.database
        .prepare(
          `UPDATE diary_generation_runs SET status = 'failed',
        error_code = 'diary_generation_interrupted', updated_at_utc = ?
        WHERE entry_id = ? AND status = 'pending' AND created_at_utc < ?`,
        )
        .run(
          input.nowUtc,
          entryId,
          new Date(Date.parse(input.nowUtc) - 15 * 60_000).toISOString(),
        );
      if (
        this.store.database
          .prepare(
            `SELECT 1 FROM diary_generation_runs WHERE entry_id = ? AND status = 'pending'`,
          )
          .get(entryId)
      )
        throw new ApiError(
          409,
          "diary_generation_in_progress",
          "这一天的日记正在生成，请稍后查看。",
        );
      const id = createEntityId("diary_run");
      this.store.database
        .prepare(
          `INSERT INTO diary_generation_runs
        (id,agent_id,entry_id,client_request_id,request_hash,status,expected_revision,source_hash,created_at_utc,updated_at_utc)
        VALUES (?,?,?,?,?,'pending',?,?,?,?)`,
        )
        .run(
          id,
          input.agentId,
          entryId,
          input.clientRequestId,
          input.requestHash,
          input.expectedRevision,
          input.sourceHash,
          input.nowUtc,
          input.nowUtc,
        );
      return this.run(input.agentId, input.clientRequestId)!;
    });
  }

  commit(
    run: DiaryRun,
    draft: DiaryDraft,
    material: DiaryMaterial,
    nowUtc: string,
    generationMetadata: Record<string, unknown>,
  ): void {
    const revision = run.expectedRevision + 1;
    const pending = this.store.database
      .prepare(`SELECT status FROM diary_generation_runs WHERE id = ?`)
      .get(run.id) as { status: string } | undefined;
    if (pending?.status !== "pending")
      throw new ApiError(
        409,
        "diary_generation_interrupted",
        "本次生成已失效，请重新发起。",
      );
    const updated = this.store.database
      .prepare(
        `UPDATE diary_entries SET current_revision = ?, updated_at_utc = ?
      WHERE id = ? AND current_revision = ?`,
      )
      .run(revision, nowUtc, run.entryId, run.expectedRevision);
    if (updated.changes !== 1)
      throw new ApiError(
        409,
        "diary_revision_conflict",
        "日记已更新，请刷新后重试。",
      );
    this.store.database
      .prepare(
        `INSERT INTO diary_revisions
      (entry_id,revision,title,body,draft_json,source_hash,source_snapshot_json,created_at_utc,generation_metadata_json) VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        run.entryId,
        revision,
        draft.title,
        draft.paragraphs.map((p) => p.text).join("\n\n"),
        JSON.stringify(draft),
        material.sourceHash,
        JSON.stringify(material),
        nowUtc,
        JSON.stringify(generationMetadata),
      );
    this.store.database
      .prepare(
        `UPDATE diary_generation_runs SET status = 'succeeded', result_revision = ?, updated_at_utc = ?
      WHERE id = ? AND status = 'pending'`,
      )
      .run(revision, nowUtc, run.id);
  }

  fail(runId: string, code: string, nowUtc: string): void {
    this.store.database
      .prepare(
        `UPDATE diary_generation_runs SET status = 'failed', error_code = ?, updated_at_utc = ?
      WHERE id = ? AND status = 'pending'`,
      )
      .run(code, nowUtc, runId);
  }

  material(
    agentId: string,
    fromUtc: string,
    toUtc: string,
    appraisals: unknown[],
  ): DiaryMaterial {
    const rows = this.store.database
      .prepare(
        `SELECT m.id, m.rowid AS sourceOrder, m.session_id AS sessionId, m.role, m.content,
      m.created_at_utc AS createdAtUtc, m.in_reply_to_message_id AS inReplyToMessageId,
      a.content AS archivedContent FROM messages m
      LEFT JOIN message_archive a ON a.id = m.id AND a.agent_id = m.agent_id
      WHERE m.agent_id = ? AND m.role IN ('user','assistant')
        AND m.message_kind IN ('user','assistant_reply','assistant_proactive')
        AND ((m.created_at_utc >= ? AND m.created_at_utc < ?)
          OR m.in_reply_to_message_id IN (SELECT id FROM messages WHERE agent_id = ? AND role = 'user'
            AND message_kind = 'user' AND created_at_utc >= ? AND created_at_utc < ?))
      ORDER BY m.created_at_utc, m.rowid`,
      )
      .all(agentId, fromUtc, toUtc, agentId, fromUtc, toUtc) as Array<
      Omit<
        DiaryMaterialMessage,
        "includedAsDaySource" | "sourceNeedsReview"
      > & { archivedContent: string | null }
    >;
    const dayUsers = rows.filter(
      (m) =>
        m.role === "user" &&
        m.createdAtUtc >= fromUtc &&
        m.createdAtUtc < toUtc,
    );
    const userIds = dayUsers.map((m) => m.id);
    const relevantSessions = new Set(dayUsers.map((m) => m.sessionId));
    // Archives are a trigger-maintained projection whose FK points to retained messages.
    // Checkpoints prune the prompt window, never the message rows. Read all historical days here.
    // Anchor context to the most recent preceding user, then retain the complete remainder
    // of that turn (including multi-bubble replies), rather than an arbitrary two messages.
    const context = [...relevantSessions].flatMap((sessionId) => {
      const previous = this.store.database
        .prepare(
          `SELECT created_at_utc AS atUtc FROM messages
        WHERE agent_id = ? AND session_id = ? AND role = 'user' AND message_kind = 'user'
          AND created_at_utc < ? ORDER BY created_at_utc DESC,rowid DESC LIMIT 1`,
        )
        .get(agentId, sessionId, fromUtc) as { atUtc: string } | undefined;
      if (!previous) return [];
      return this.store.database
        .prepare(
          `
      SELECT m.id, m.rowid AS sourceOrder, m.session_id AS sessionId, m.role, m.content, m.created_at_utc AS createdAtUtc,
        m.in_reply_to_message_id AS inReplyToMessageId, a.content AS archivedContent
      FROM messages m LEFT JOIN message_archive a ON a.id = m.id AND a.agent_id = m.agent_id
      WHERE m.agent_id = ? AND m.session_id = ? AND m.role IN ('user','assistant')
        AND m.message_kind IN ('user','assistant_reply','assistant_proactive') AND m.created_at_utc >= ? AND m.created_at_utc < ?
      ORDER BY m.created_at_utc, m.rowid`,
        )
        .all(agentId, sessionId, previous.atUtc, fromUtc) as typeof rows;
    });
    const validity = new MemoryValidityRepository(this.store);
    const unique = new Map(
      [
        ...context,
        ...rows.filter((m) => relevantSessions.has(m.sessionId)),
      ].map((m) => [m.id, m]),
    );
    const sourceMessages: DiaryMaterialMessage[] = [...unique.values()]
      .map((m) => ({
        id: m.id,
        sessionId: m.sessionId,
        sourceOrder: m.sourceOrder,
        role: m.role,
        content: m.content,
        createdAtUtc: m.createdAtUtc,
        inReplyToMessageId: m.inReplyToMessageId,
        includedAsDaySource: userIds.includes(m.id),
        sourceNeedsReview: validity.messageSourceNeedsReview(agentId, m.id),
      }))
      .sort(
        (a, b) =>
          a.createdAtUtc.localeCompare(b.createdAtUtc) ||
          a.sourceOrder - b.sourceOrder,
      );
    const eventRows =
      userIds.length === 0
        ? []
        : (this.store.database
            .prepare(
              `
      SELECT id, causation_id AS sourceMessageId, recorded_at_utc AS recordedAtUtc,
        effective_at_utc AS effectiveAtUtc, payload_json AS payloadJson
      FROM domain_events WHERE agent_id = ? AND event_type = 'conversation.world_effects_committed'
        AND causation_id IN (SELECT value FROM json_each(?)) ORDER BY effective_at_utc,id`,
            )
            .all(agentId, JSON.stringify(userIds)) as Array<{
            id: string;
            sourceMessageId: string;
            recordedAtUtc: string;
            effectiveAtUtc: string;
            payloadJson: string;
          }>);
    const historicalStates: DiaryHistoricalState[] = eventRows.flatMap(
      ({ payloadJson, ...event }) => {
        const payload = JSON.parse(payloadJson) as Record<string, unknown>;
        if (
          payload["interactionStatus"] !== "committed" ||
          !record(payload["before"]) ||
          !record(payload["after"])
        )
          return [];
        return [
          { ...event, before: payload["before"], after: payload["after"] },
        ];
      },
    );
    const dependencies: DiaryDependency[] = [
      ...sourceMessages.map((m) => ({
        key: `message:${m.id}`,
        hash: diaryHash({
          id: m.id,
          sessionId: m.sessionId,
          role: m.role,
          content: m.content,
          createdAtUtc: m.createdAtUtc,
          inReplyToMessageId: m.inReplyToMessageId,
          includedAsDaySource: m.includedAsDaySource,
          sourceNeedsReview: m.sourceNeedsReview,
          archiveConflict:
            unique.get(m.id)?.archivedContent != null &&
            unique.get(m.id)?.archivedContent !== m.content
              ? unique.get(m.id)?.archivedContent
              : null,
        }),
      })),
      ...eventRows.map((e) => ({
        key: `domain_event:${e.id}`,
        hash: diaryHash(e),
      })),
      ...appraisals.map((a) => ({
        key: `appraisal:${record(a) ? String(a["id"]) : diaryHash(a)}`,
        hash: diaryHash(a),
      })),
    ].sort((a, b) => a.key.localeCompare(b.key));
    return {
      fromUtc,
      toUtc,
      sourceMessages,
      sourceMessageIds: userIds,
      historicalStates,
      appraisals,
      dependencies,
      sourceHash: diaryHash(dependencies),
    };
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
