import { createHash } from "node:crypto";

import type {
  CareCueLike,
  FollowUpLike,
  FollowUpGroundingBasis,
} from "@personasim/features";

import type { Database } from "../db/connection.js";
import { DatabaseStore } from "../db/store.js";
import { MemoryValidityRepository } from "../repositories/memory-validity-repository.js";

export interface StoredFollowUpIntent extends FollowUpLike {
  sessionId?: string;
  sourceMessageId: string;
  grounding?: StoredContinuityGrounding;
}

export interface StoredCareCue extends CareCueLike {
  agentId: string;
  sessionId?: string;
  sourceMessageId: string;
  grounding?: StoredContinuityGrounding;
}

export interface StoredContinuityGrounding {
  version: 1;
  basis: FollowUpGroundingBasis | { basisKind: "user_context"; matter: string };
  contextSummary: string;
  guidance: string;
  sources: Array<{
    id: string;
    role: string;
    hash: string;
    sessionId: string;
    createdAtUtc: string;
  }>;
}

export function sourceTextHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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
  grounding?: StoredContinuityGrounding;
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
  grounding?: StoredContinuityGrounding;
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
  private readonly validity: MemoryValidityRepository;
  constructor(readonly database: Database) {
    this.validity = new MemoryValidityRepository(new DatabaseStore(database));
  }

  isSourceEvidenceUsable(agentId: string, sourceId: string): boolean {
    return !this.validity.messageSourceNeedsReview(agentId, sourceId);
  }

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

  getAdjacentTurnMessages(source: StoredSourceMessage): StoredSourceMessage[] {
    // Only the same immediately adjacent exchange can support a shared promise;
    // callers and model output cannot supply arbitrary IDs from other sessions.
    const rows = this.database
      .prepare(
        `SELECT id FROM messages
      WHERE session_id = ? AND agent_id = ? AND role IN ('user', 'assistant')
        AND rowid <= (SELECT rowid + 1 FROM messages WHERE id = ?)
      ORDER BY rowid DESC LIMIT 3`,
      )
      .all(source.sessionId, source.agentId, source.id) as Array<{
      id: string;
    }>;
    return rows
      .map((row) => this.getSourceMessage(row.id)!)
      .filter((message) => message.id !== source.id);
  }

  isFollowUpEvidenceCurrent(id: string): boolean {
    const record = this.getFollowUp(id);
    return (
      record !== undefined &&
      this.groundingIsCurrent(
        record.agentId,
        record.sourceMessageId,
        record.contextSummary,
        record.expectedOutcomeDescription,
        record.grounding,
      )
    );
  }

  isCareCueEvidenceCurrent(id: string): boolean {
    const record = this.getCareCue(id);
    return (
      record !== undefined &&
      this.groundingIsCurrent(
        record.agentId,
        record.sourceMessageId,
        record.contextSummary,
        record.mentionGuidance,
        record.grounding,
      )
    );
  }

  private groundingIsCurrent(
    agentId: string,
    sourceMessageId: string,
    contextSummary: string,
    guidance: string,
    grounding: StoredContinuityGrounding | undefined,
  ): boolean {
    if (
      grounding?.version !== 1 ||
      grounding.contextSummary !== contextSummary ||
      grounding.guidance !== guidance ||
      !Array.isArray(grounding.sources) ||
      !grounding.sources.some((source) => source.id === sourceMessageId)
    )
      return false;
    return grounding.sources.every((reference) => {
      const source = this.getSourceMessage(reference.id);
      return (
        source !== undefined &&
        source.agentId === agentId &&
        source.role === reference.role &&
        source.sessionId === reference.sessionId &&
        source.createdAtUtc === reference.createdAtUtc &&
        this.isSourceEvidenceUsable(agentId, source.id) &&
        sourceTextHash(source.text) === reference.hash
      );
    });
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
          revision, generation_epoch, created_at_utc, updated_at_utc, grounding_json
        ) VALUES (
          @id, @agentId, @sessionId, @subjectType, @contextSummary,
          @expectedOutcomeDescription, @sourceMessageId, @earliestAtUtc,
          @expiresAtUtc, 'pending', 1, 0, @dedupeKey, 0, 0,
          @createdAtUtc, @createdAtUtc, @groundingJson
        )`,
      )
      .run({
        ...input,
        sessionId: input.sessionId ?? null,
        groundingJson:
          input.grounding === undefined
            ? null
            : JSON.stringify(input.grounding),
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

  restoreFollowUpGrounding(input: {
    id: string;
    expectedRevision: number;
    contextSummary: string;
    expectedOutcomeDescription: string;
    earliestAtUtc: string;
    expiresAtUtc: string;
    dedupeKey: string;
    grounding: StoredContinuityGrounding;
    updatedAtUtc: string;
  }): StoredFollowUpIntent | undefined {
    const result = this.database
      .prepare(
        `UPDATE OR IGNORE follow_up_intents
      SET context_summary = @contextSummary, expected_outcome_description = @expectedOutcomeDescription,
          earliest_at_utc = @earliestAtUtc, expires_at_utc = @expiresAtUtc, dedupe_key = @dedupeKey,
          grounding_json = @groundingJson, revision = revision + 1, updated_at_utc = @updatedAtUtc
      WHERE id = @id AND revision = @expectedRevision AND status = 'pending'
        AND attempt_count = 0 AND sent_message_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM proactive_generation_runs run WHERE run.follow_up_intent_id = follow_up_intents.id AND run.status = 'generating')`,
      )
      .run({ ...input, groundingJson: JSON.stringify(input.grounding) });
    return result.changes === 1 ? this.getFollowUp(input.id) : undefined;
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
          created_at_utc, updated_at_utc, grounding_json
        ) VALUES (
          @id, @agentId, @sessionId, @contextSummary, @mentionGuidance,
          @sourceMessageId, @earliestAtUtc, @expiresAtUtc, 'active',
          @maxMentions, 0, @dedupeKey, 0, @createdAtUtc, @createdAtUtc, @groundingJson
        )`,
      )
      .run({
        ...input,
        sessionId: input.sessionId ?? null,
        earliestAtUtc: input.earliestAtUtc ?? null,
        groundingJson:
          input.grounding === undefined
            ? null
            : JSON.stringify(input.grounding),
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
    ...mapGrounding(row),
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
    ...mapGrounding(row),
  };
}

function mapGrounding(row: SqlRow): { grounding?: StoredContinuityGrounding } {
  const value = row["grounding_json"];
  if (typeof value !== "string") return {};
  return { grounding: JSON.parse(value) as StoredContinuityGrounding };
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
