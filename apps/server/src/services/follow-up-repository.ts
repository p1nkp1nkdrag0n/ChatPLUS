import type { CareCueLike, FollowUpLike } from "@personasim/features";

import type { Database } from "../db/connection.js";

export interface StoredFollowUpIntent extends FollowUpLike {
  sessionId?: string;
  sourceMessageId: string;
}

export interface StoredCareCue extends CareCueLike {
  agentId: string;
  sessionId?: string;
  sourceMessageId: string;
}

export interface FollowUpInsert {
  id: string;
  agentId: string;
  sessionId?: string;
  subjectType: StoredFollowUpIntent["subjectType"];
  contextSummary: string;
  expectedOutcomeDescription: string;
  sourceMessageId: string;
  earliestAtUtc: string;
  expiresAtUtc: string;
  dedupeKey: string;
  createdAtUtc: string;
}

export interface CareCueInsert {
  id: string;
  agentId: string;
  sessionId?: string;
  contextSummary: string;
  mentionGuidance: string;
  sourceMessageId: string;
  earliestAtUtc?: string;
  expiresAtUtc: string;
  maxMentions: number;
  dedupeKey: string;
  createdAtUtc: string;
}

export interface StoredSourceMessage {
  id: string;
  sessionId: string;
  agentId: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAtUtc: string;
}

type SqlRow = Record<string, unknown>;

export class FollowUpRepository {
  constructor(readonly database: Database) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  getSourceMessage(messageId: string): StoredSourceMessage | undefined {
    const row = this.database
      .prepare(
        `SELECT id, session_id, agent_id, role, content, created_at_utc
         FROM messages WHERE id = ?`,
      )
      .get(messageId) as SqlRow | undefined;
    return row === undefined
      ? undefined
      : {
          id: String(row["id"]),
          sessionId: String(row["session_id"]),
          agentId: String(row["agent_id"]),
          role: parseMessageRole(row["role"]),
          text: String(row["content"]),
          createdAtUtc: String(row["created_at_utc"]),
        };
  }

  insertFollowUp(input: FollowUpInsert): {
    record: StoredFollowUpIntent;
    inserted: boolean;
  } {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO follow_up_intents(
          id, agent_id, session_id, subject_type, context_summary,
          expected_outcome_description, source_message_id, earliest_at_utc,
          expires_at_utc, status, max_attempts, attempt_count, dedupe_key,
          revision, generation_epoch, created_at_utc, updated_at_utc
        ) VALUES (
          @id, @agentId, @sessionId, @subjectType, @contextSummary,
          @expectedOutcomeDescription, @sourceMessageId, @earliestAtUtc,
          @expiresAtUtc, 'pending', 1, 0, @dedupeKey, 0, 0,
          @createdAtUtc, @createdAtUtc
        )`,
      )
      .run({
        ...input,
        sessionId: input.sessionId ?? null,
      });
    const record =
      this.getFollowUp(input.id) ??
      this.findFollowUpByDedupe(input.agentId, input.dedupeKey);
    if (record === undefined) {
      throw new Error("Follow-up insert was ignored without a matching record");
    }
    return { record, inserted: result.changes === 1 };
  }

  getFollowUp(id: string): StoredFollowUpIntent | undefined {
    const row = this.database
      .prepare("SELECT * FROM follow_up_intents WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row === undefined ? undefined : mapFollowUp(row);
  }

  findFollowUpByDedupe(
    agentId: string,
    dedupeKey: string,
  ): StoredFollowUpIntent | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM follow_up_intents WHERE agent_id = ? AND dedupe_key = ?",
      )
      .get(agentId, dedupeKey) as SqlRow | undefined;
    return row === undefined ? undefined : mapFollowUp(row);
  }

  listOpenFollowUps(agentId: string): StoredFollowUpIntent[] {
    return this.database
      .prepare(
        `SELECT * FROM follow_up_intents
         WHERE agent_id = ? AND status IN ('pending', 'sent')
         ORDER BY earliest_at_utc, created_at_utc, rowid`,
      )
      .all(agentId)
      .map((row) => mapFollowUp(row as SqlRow));
  }

  transitionFollowUp(input: {
    id: string;
    expectedRevision: number;
    outcome: "resolved" | "cancelled";
    resolutionMessageId: string;
    updatedAtUtc: string;
  }): StoredFollowUpIntent | undefined {
    const result = this.database
      .prepare(
        `UPDATE follow_up_intents
         SET status = @outcome,
             resolution_message_id = @resolutionMessageId,
             revision = revision + 1,
             updated_at_utc = @updatedAtUtc
         WHERE id = @id
           AND revision = @expectedRevision
           AND status IN ('pending', 'sent')`,
      )
      .run(input);
    return result.changes === 1 ? this.getFollowUp(input.id) : undefined;
  }

  expireFollowUps(agentId: string, nowUtc: string): number {
    return this.database
      .prepare(
        `UPDATE follow_up_intents
         SET status = 'expired',
             revision = revision + 1,
             updated_at_utc = ?
         WHERE agent_id = ?
           AND status IN ('pending', 'sent')
           AND expires_at_utc <= ?`,
      )
      .run(nowUtc, agentId, nowUtc).changes;
  }

  insertCareCue(input: CareCueInsert): {
    record: StoredCareCue;
    inserted: boolean;
  } {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO care_cues(
          id, agent_id, session_id, context_summary, mention_guidance,
          source_message_id, earliest_at_utc, expires_at_utc, status,
          max_mentions, mention_count, dedupe_key, revision,
          created_at_utc, updated_at_utc
        ) VALUES (
          @id, @agentId, @sessionId, @contextSummary, @mentionGuidance,
          @sourceMessageId, @earliestAtUtc, @expiresAtUtc, 'active',
          @maxMentions, 0, @dedupeKey, 0, @createdAtUtc, @createdAtUtc
        )`,
      )
      .run({
        ...input,
        sessionId: input.sessionId ?? null,
        earliestAtUtc: input.earliestAtUtc ?? null,
      });
    const record =
      this.getCareCue(input.id) ??
      this.findCareCueByDedupe(input.agentId, input.dedupeKey);
    if (record === undefined) {
      throw new Error("Care cue insert was ignored without a matching record");
    }
    return { record, inserted: result.changes === 1 };
  }

  getCareCue(id: string): StoredCareCue | undefined {
    const row = this.database
      .prepare("SELECT * FROM care_cues WHERE id = ?")
      .get(id) as SqlRow | undefined;
    return row === undefined ? undefined : mapCareCue(row);
  }

  findCareCueByDedupe(
    agentId: string,
    dedupeKey: string,
  ): StoredCareCue | undefined {
    const row = this.database
      .prepare("SELECT * FROM care_cues WHERE agent_id = ? AND dedupe_key = ?")
      .get(agentId, dedupeKey) as SqlRow | undefined;
    return row === undefined ? undefined : mapCareCue(row);
  }

  listActiveCareCues(agentId: string): StoredCareCue[] {
    return this.database
      .prepare(
        `SELECT * FROM care_cues
         WHERE agent_id = ? AND status = 'active'
         ORDER BY expires_at_utc, created_at_utc, rowid`,
      )
      .all(agentId)
      .map((row) => mapCareCue(row as SqlRow));
  }

  recordCareCueMention(input: {
    id: string;
    expectedRevision: number;
    messageId: string;
    updatedAtUtc: string;
  }): StoredCareCue | undefined {
    const result = this.database
      .prepare(
        `UPDATE care_cues
         SET mention_count = mention_count + 1,
             status = CASE
               WHEN mention_count + 1 >= max_mentions THEN 'exhausted'
               ELSE 'active'
             END,
             last_mentioned_message_id = @messageId,
             revision = revision + 1,
             updated_at_utc = @updatedAtUtc
         WHERE id = @id
           AND revision = @expectedRevision
           AND status = 'active'
           AND mention_count < max_mentions
           AND expires_at_utc > @updatedAtUtc`,
      )
      .run(input);
    return result.changes === 1 ? this.getCareCue(input.id) : undefined;
  }

  dismissCareCue(input: {
    id: string;
    expectedRevision: number;
    messageId: string;
    updatedAtUtc: string;
  }): StoredCareCue | undefined {
    const result = this.database
      .prepare(
        `UPDATE care_cues
         SET status = 'dismissed',
             dismissed_by_message_id = @messageId,
             revision = revision + 1,
             updated_at_utc = @updatedAtUtc
         WHERE id = @id
           AND revision = @expectedRevision
           AND status = 'active'`,
      )
      .run(input);
    return result.changes === 1 ? this.getCareCue(input.id) : undefined;
  }

  expireCareCues(agentId: string, nowUtc: string): number {
    return this.database
      .prepare(
        `UPDATE care_cues
         SET status = 'expired',
             revision = revision + 1,
             updated_at_utc = ?
         WHERE agent_id = ?
           AND status = 'active'
           AND expires_at_utc <= ?`,
      )
      .run(nowUtc, agentId, nowUtc).changes;
  }
}

function mapFollowUp(row: SqlRow): StoredFollowUpIntent {
  const sessionId = nullableString(row["session_id"]);
  const sentMessageId = nullableString(row["sent_message_id"]);
  const resolutionMessageId = nullableString(row["resolution_message_id"]);
  return {
    id: String(row["id"]),
    agentId: String(row["agent_id"]),
    subjectType: parseFollowUpSubjectType(row["subject_type"]),
    contextSummary: String(row["context_summary"]),
    expectedOutcomeDescription: String(row["expected_outcome_description"]),
    sourceMessageId: String(row["source_message_id"]),
    earliestAtUtc: String(row["earliest_at_utc"]),
    expiresAtUtc: String(row["expires_at_utc"]),
    status: parseFollowUpStatus(row["status"]),
    maxAttempts: 1,
    attemptCount: Number(row["attempt_count"]),
    dedupeKey: String(row["dedupe_key"]),
    revision: Number(row["revision"]),
    generationEpoch: Number(row["generation_epoch"]),
    createdAtUtc: String(row["created_at_utc"]),
    updatedAtUtc: String(row["updated_at_utc"]),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(sentMessageId === undefined ? {} : { sentMessageId }),
    ...(resolutionMessageId === undefined ? {} : { resolutionMessageId }),
  };
}

function mapCareCue(row: SqlRow): StoredCareCue {
  const sessionId = nullableString(row["session_id"]);
  const earliestAtUtc = nullableString(row["earliest_at_utc"]);
  const lastMentionedMessageId = nullableString(
    row["last_mentioned_message_id"],
  );
  const dismissedByMessageId = nullableString(row["dismissed_by_message_id"]);
  return {
    id: String(row["id"]),
    agentId: String(row["agent_id"]),
    contextSummary: String(row["context_summary"]),
    mentionGuidance: String(row["mention_guidance"]),
    sourceMessageId: String(row["source_message_id"]),
    expiresAtUtc: String(row["expires_at_utc"]),
    status: parseCareCueStatus(row["status"]),
    maxMentions: Number(row["max_mentions"]),
    mentionCount: Number(row["mention_count"]),
    dedupeKey: String(row["dedupe_key"]),
    revision: Number(row["revision"]),
    createdAtUtc: String(row["created_at_utc"]),
    updatedAtUtc: String(row["updated_at_utc"]),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(earliestAtUtc === undefined ? {} : { earliestAtUtc }),
    ...(lastMentionedMessageId === undefined ? {} : { lastMentionedMessageId }),
    ...(dismissedByMessageId === undefined ? {} : { dismissedByMessageId }),
  };
}

function nullableString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  throw new Error("Expected a primitive database value");
}

function parseMessageRole(value: unknown): StoredSourceMessage["role"] {
  if (value === "user" || value === "assistant" || value === "system") {
    return value;
  }
  throw new Error("Unknown message role: " + String(value));
}

function parseFollowUpSubjectType(
  value: unknown,
): StoredFollowUpIntent["subjectType"] {
  if (
    value === "user_goal" ||
    value === "user_event" ||
    value === "shared_commitment" ||
    value === "character_commitment"
  ) {
    return value;
  }
  throw new Error("Unknown follow-up subject type: " + String(value));
}

function parseFollowUpStatus(value: unknown): StoredFollowUpIntent["status"] {
  if (
    value === "pending" ||
    value === "resolved" ||
    value === "sent" ||
    value === "expired" ||
    value === "cancelled"
  ) {
    return value;
  }
  throw new Error("Unknown follow-up status: " + String(value));
}

function parseCareCueStatus(value: unknown): StoredCareCue["status"] {
  if (
    value === "active" ||
    value === "dismissed" ||
    value === "expired" ||
    value === "exhausted"
  ) {
    return value;
  }
  throw new Error("Unknown care cue status: " + String(value));
}
