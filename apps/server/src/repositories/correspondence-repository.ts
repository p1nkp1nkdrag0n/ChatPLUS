import { createHash } from "node:crypto";

import {
  CorrespondenceThreadSchema,
  EncryptedLetterBodySchema,
  EntityIdSchema,
  IanaTimezoneSchema,
  LetterGenerationRunSchema,
  LetterGenerationSnapshotSchema,
  LetterDirectionSchema,
  LetterSchema,
  ReasonCodeSchema,
  RevisionSchema,
  ShortTextSchema,
  TemporalTaskKindSchema,
  TemporalTaskSchema,
  UtcDateTimeSchema,
  type CorrespondenceThread,
  type CorrespondenceThreadStatus,
  type EncryptedLetterBody,
  type Letter,
  type LetterDirection,
  type LetterGenerationRun,
  type LetterGenerationRunStatus,
  type LetterGenerationSnapshot,
  type LetterStatus,
  type TemporalTask,
  type TemporalTaskKind,
  type TemporalTaskStatus,
} from "@personasim/contracts";
import {
  calculateLetterArrivalDueAtUtc,
  canonicalCorrespondenceJson,
  canonicalLetterGenerationSnapshot,
} from "@personasim/features";

import type { Database } from "../db/connection.js";
import { createEntityId } from "../domain/id.js";

export type {
  CorrespondenceThread,
  CorrespondenceThreadStatus,
  EncryptedLetterBody,
  Letter,
  LetterDirection,
  LetterGenerationRun,
  LetterGenerationRunStatus,
  LetterGenerationSnapshot,
  LetterStatus,
  TemporalTask,
  TemporalTaskKind,
  TemporalTaskStatus,
} from "@personasim/contracts";

export type LetterWithEncryptedBody = Letter & {
  encryptedBody?: EncryptedLetterBody;
};

export type CorrespondenceRepositoryErrorCode =
  | "not_found"
  | "immutable_letter"
  | "invalid_state"
  | "idempotency_conflict"
  | "claim_conflict"
  | "lease_expired"
  | "invariant_violation";

export class CorrespondenceRepositoryError extends Error {
  constructor(
    public readonly code: CorrespondenceRepositoryErrorCode,
    message: string,
    public readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "CorrespondenceRepositoryError";
  }
}

export interface CreateThreadOptions {
  id?: string;
  nowUtc?: string;
}

export interface CreateDraftLetterInput {
  id?: string;
  threadId: string;
  agentId: string;
  direction?: LetterDirection;
  replyToLetterId?: string;
  subject?: string;
  body: string;
  clientRequestId?: string;
  nowUtc?: string;
}

export interface UpdateDraftLetterInput {
  subject?: string | null;
  body?: string;
  updatedAtUtc?: string;
}

export interface SealLetterInput {
  letterId: string;
  contentHash: string;
  transitPolicyVersion: string;
  transitTimezone: string;
  dispatchedAtUtc: string;
  arrivalDueAtUtc: string;
  effectiveAuthorTimeUtc?: string;
  taskId?: string;
  taskPriority?: number;
  clientRequestId?: string;
}

export interface SealLetterResult {
  letter: LetterWithEncryptedBody;
  task: TemporalTask;
  replayed: boolean;
}

export interface LetterListFilters {
  threadId?: string;
  direction?: LetterDirection;
  status?: LetterStatus | readonly LetterStatus[];
  limit?: number;
}

export interface LetterPageCursor {
  readonly createdAtUtc: string;
  readonly rowId: number;
}

export interface LetterPageOptions extends LetterListFilters {
  readonly cursor?: LetterPageCursor;
}

export interface LetterPage {
  readonly items: LetterWithEncryptedBody[];
  readonly nextCursor?: LetterPageCursor;
}

export interface MarkDeliveredInput {
  letterId: string;
  effectiveAtUtc: string;
  processedAtUtc: string;
}

export interface MarkReadInput {
  letterId: string;
  readAtUtc: string;
}

export interface MarkOpenedInput {
  letterId: string;
  openedAtUtc: string;
}

export interface InsertSnapshotInput {
  id?: string;
  incomingLetterId: string;
  agentId: string;
  effectiveAtUtc: string;
  characterVersion: number;
  stateRevision: number;
  contextJson: LetterGenerationSnapshot["contextJson"];
  evidenceIds: readonly string[];
  contextHash: string;
  createdAtUtc?: string;
}

export interface ClaimGenerationRunInput {
  id?: string;
  incomingLetterId: string;
  snapshotId: string;
  snapshotHash: string;
  agentId: string;
  generationEpoch: number;
  claimToken: string;
  nowUtc: string;
  leaseExpiresAtUtc: string;
  provider?: string;
  model?: string;
}

export interface CommitGenerationRunInput {
  runId: string;
  claimToken: string;
  generationEpoch: number;
  snapshotHash: string;
  nowUtc: string;
  replyLetterId?: string;
  contentHash: string;
  transitPolicyVersion: string;
  transitTimezone: string;
  effectiveAuthorTimeUtc: string;
  arrivalDueAtUtc: string;
  encryptedBody: Omit<EncryptedLetterBody, "letterId">;
  provider?: string;
  model?: string;
  resultHash?: string;
  taskId?: string;
  taskPriority?: number;
}

export interface CommitGenerationRunResult {
  run: LetterGenerationRun;
  reply: LetterWithEncryptedBody;
  task: TemporalTask;
  replayed: boolean;
}

export interface RetryGenerationRunInput {
  runId: string;
  claimToken: string;
  generationEpoch: number;
  errorCode: string;
  resultHash?: string;
  nowUtc: string;
  retryable?: boolean;
}

export interface CreateTemporalTaskInput {
  id?: string;
  agentId: string;
  kind: TemporalTaskKind;
  entityId: string;
  dueAtUtc: string;
  priority: number;
  idempotencyKey: string;
  payload?: Readonly<Record<string, unknown>>;
  maxAttempts?: number;
  createdAtUtc?: string;
}

export interface ClaimDueTaskInput {
  taskId?: string;
  nowUtc: string;
  leaseExpiresAtUtc: string;
  claimToken: string;
  agentId?: string;
  kinds?: readonly TemporalTaskKind[];
}

export interface CompleteTaskInput {
  taskId: string;
  claimToken: string;
  completedAtUtc: string;
}

export interface RetryTaskInput {
  taskId: string;
  claimToken: string;
  errorCode: string;
  nowUtc: string;
  nextDueAtUtc?: string;
  retryable?: boolean;
}

interface ThreadRow {
  id: string;
  agent_id: string;
  status: CorrespondenceThreadStatus;
  root_letter_id: string | null;
  latest_letter_id: string | null;
  created_at_utc: string;
  updated_at_utc: string;
  closed_at_utc: string | null;
}

interface LetterRow {
  id: string;
  thread_id: string;
  agent_id: string;
  create_request_id: string | null;
  create_request_hash: string | null;
  seal_request_id: string | null;
  reply_to_letter_id: string | null;
  direction: LetterDirection;
  status: LetterStatus;
  subject: string | null;
  body: string | null;
  content_hash: string | null;
  encrypted_ciphertext: string | null;
  encrypted_iv: string | null;
  encrypted_auth_tag: string | null;
  encrypted_key_version: number | null;
  encrypted_aad_hash: string | null;
  encrypted_created_at_utc: string | null;
  transit_policy_version: string | null;
  transit_timezone: string | null;
  dispatched_at_utc: string | null;
  arrival_due_at_utc: string | null;
  effective_author_time_utc: string | null;
  delivered_effective_at_utc: string | null;
  processed_at_utc: string | null;
  read_at_utc: string | null;
  opened_at_utc: string | null;
  created_at_utc: string;
  updated_at_utc: string;
}

interface LetterPageRow extends LetterRow {
  pagination_row_id: number;
}

interface SnapshotRow {
  id: string;
  incoming_letter_id: string;
  agent_id: string;
  effective_at_utc: string;
  character_version: number;
  state_revision: number;
  context_json: string;
  evidence_ids_json: string;
  context_hash: string;
  created_at_utc: string;
}

interface RunRow {
  id: string;
  incoming_letter_id: string;
  snapshot_id: string;
  agent_id: string;
  reply_letter_id: string | null;
  claim_token: string | null;
  generation_epoch: number;
  status: LetterGenerationRunStatus;
  attempt: number;
  claimed_at_utc: string | null;
  lease_expires_at_utc: string | null;
  provider: string | null;
  model: string | null;
  error_code: string | null;
  result_hash: string | null;
  created_at_utc: string;
  updated_at_utc: string;
  committed_at_utc: string | null;
}

interface TaskRow {
  id: string;
  agent_id: string;
  kind: TemporalTaskKind;
  entity_id: string;
  due_at_utc: string;
  priority: number;
  status: TemporalTaskStatus;
  claim_token: string | null;
  claimed_at_utc: string | null;
  lease_expires_at_utc: string | null;
  attempt: number;
  max_attempts: number;
  idempotency_key: string;
  last_error_code: string | null;
  payload_json: string;
  created_at_utc: string;
  updated_at_utc: string;
  completed_at_utc: string | null;
}

export class CorrespondenceRepository {
  constructor(private readonly database: Database) {}

  createThread(
    agentId: string,
    options: CreateThreadOptions = {},
  ): CorrespondenceThread {
    assertEntityId(agentId, "agentId");
    if (options.id !== undefined) assertEntityId(options.id, "threadId");
    if (options.nowUtc !== undefined) assertUtc(options.nowUtc, "nowUtc");
    const existing = this.findOpenThread(agentId);
    if (existing !== undefined) return existing;
    const nowUtc = options.nowUtc ?? new Date().toISOString();
    const id = options.id ?? createEntityId("correspondence_thread");
    try {
      this.database
        .prepare(
          `INSERT INTO correspondence_threads(
             id, agent_id, status, created_at_utc, updated_at_utc
           ) VALUES (?, ?, 'open', ?, ?)`,
        )
        .run(id, agentId, nowUtc, nowUtc);
    } catch (error) {
      const raced = this.findOpenThread(agentId);
      if (raced !== undefined) return raced;
      throw translateSqlError(error, "Unable to create correspondence thread");
    }
    return this.requireThread(id);
  }

  openThread(
    agentId: string,
    options: CreateThreadOptions = {},
  ): CorrespondenceThread {
    return this.createThread(agentId, options);
  }

  findOpenThread(agentId: string): CorrespondenceThread | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM correspondence_threads WHERE agent_id = ? AND status = 'open'",
      )
      .get(agentId) as ThreadRow | undefined;
    return row === undefined ? undefined : mapThread(row);
  }

  getThread(threadId: string): CorrespondenceThread | undefined {
    const row = this.database
      .prepare("SELECT * FROM correspondence_threads WHERE id = ?")
      .get(threadId) as ThreadRow | undefined;
    return row === undefined ? undefined : mapThread(row);
  }

  listThreads(agentId: string, limit = 100): CorrespondenceThread[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM correspondence_threads
           WHERE agent_id = ?
           ORDER BY updated_at_utc DESC, rowid DESC
           LIMIT ?`,
        )
        .all(agentId, boundedLimit(limit)) as ThreadRow[]
    ).map(mapThread);
  }

  listThreadsByIds(
    agentId: string,
    threadIds: readonly string[],
  ): CorrespondenceThread[] {
    assertEntityId(agentId, "agentId");
    const uniqueThreadIds = [...new Set(threadIds)];
    if (uniqueThreadIds.length === 0) return [];
    for (const threadId of uniqueThreadIds) {
      assertEntityId(threadId, "threadId");
    }
    return (
      this.database
        .prepare(
          `SELECT * FROM correspondence_threads
           WHERE agent_id = ?
             AND id IN (${uniqueThreadIds.map(() => "?").join(", ")})
           ORDER BY updated_at_utc DESC, rowid DESC`,
        )
        .all(agentId, ...uniqueThreadIds) as ThreadRow[]
    ).map(mapThread);
  }

  closeThread(threadId: string, closedAtUtc: string): CorrespondenceThread {
    assertEntityId(threadId, "threadId");
    assertUtc(closedAtUtc, "closedAtUtc");
    const current = this.requireThread(threadId);
    if (Date.parse(closedAtUtc) < Date.parse(current.updatedAtUtc)) {
      throw domainError(
        "invariant_violation",
        "closedAtUtc cannot precede the latest thread update",
      );
    }
    const result = this.database
      .prepare(
        `UPDATE correspondence_threads
         SET status = 'closed', updated_at_utc = ?, closed_at_utc = ?
         WHERE id = ? AND status = 'open'`,
      )
      .run(closedAtUtc, closedAtUtc, threadId);
    if (result.changes === 0) {
      const thread = this.requireThread(threadId);
      if (thread.status === "closed") return thread;
    }
    return this.requireThread(threadId);
  }

  createDraftLetter(input: CreateDraftLetterInput): LetterWithEncryptedBody {
    assertEntityId(input.threadId, "threadId");
    assertEntityId(input.agentId, "agentId");
    if (input.id !== undefined) assertEntityId(input.id, "letterId");
    if (input.replyToLetterId !== undefined)
      assertEntityId(input.replyToLetterId, "replyToLetterId");
    if (input.direction !== undefined)
      assertSchemaValue(LetterDirectionSchema, input.direction, "direction");
    if (input.nowUtc !== undefined) assertUtc(input.nowUtc, "nowUtc");
    if (input.body.length === 0) {
      throw domainError("invariant_violation", "A letter body cannot be empty");
    }
    const requestHash =
      input.clientRequestId === undefined
        ? undefined
        : draftCreateRequestHash(input);
    if (input.clientRequestId !== undefined) {
      const replay = this.findLetterRowByCreateRequest(
        input.agentId,
        input.clientRequestId,
      );
      if (replay !== undefined) {
        if (
          replay.create_request_hash === requestHash &&
          (input.id === undefined || replay.id === input.id)
        ) {
          return mapLetter(replay);
        }
        throw domainError(
          "idempotency_conflict",
          "Draft creation request was reused with different letter data",
          { clientRequestId: input.clientRequestId },
        );
      }
    }
    const id = input.id ?? createEntityId("letter");
    const nowUtc = input.nowUtc ?? new Date().toISOString();
    const transaction = this.database.transaction(() => {
      const thread = this.requireThread(input.threadId);
      if (thread.status !== "open" || thread.agentId !== input.agentId) {
        throw domainError(
          "invalid_state",
          "Draft letters require an open thread owned by the same agent",
          { threadId: input.threadId, agentId: input.agentId },
        );
      }
      this.database
        .prepare(
          `INSERT INTO letters(
             id, thread_id, agent_id, create_request_id, create_request_hash,
             reply_to_letter_id, direction, status, subject, body,
             created_at_utc, updated_at_utc
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.threadId,
          input.agentId,
          input.clientRequestId ?? null,
          requestHash ?? null,
          input.replyToLetterId ?? null,
          input.direction ?? "user_to_agent",
          input.subject ?? null,
          input.body,
          nowUtc,
          nowUtc,
        );
      this.database
        .prepare(
          `UPDATE correspondence_threads
           SET root_letter_id = COALESCE(root_letter_id, ?),
               latest_letter_id = ?, updated_at_utc = ?
           WHERE id = ?`,
        )
        .run(id, id, nowUtc, input.threadId);
      return this.requireLetter(id);
    });
    try {
      return transaction();
    } catch (error) {
      if (error instanceof CorrespondenceRepositoryError) throw error;
      if (input.clientRequestId !== undefined) {
        const replay = this.findLetterRowByCreateRequest(
          input.agentId,
          input.clientRequestId,
        );
        if (
          replay !== undefined &&
          replay.create_request_hash === requestHash &&
          (input.id === undefined || replay.id === input.id)
        ) {
          return mapLetter(replay);
        }
      }
      throw translateSqlError(error, "Unable to create draft letter");
    }
  }

  updateDraftLetter(
    letterId: string,
    patch: UpdateDraftLetterInput,
  ): LetterWithEncryptedBody {
    assertEntityId(letterId, "letterId");
    if (patch.updatedAtUtc !== undefined)
      assertUtc(patch.updatedAtUtc, "updatedAtUtc");
    const current = this.requireLetter(letterId);
    if (current.status !== "draft") {
      throw domainError(
        "immutable_letter",
        `Letter ${letterId} is sealed and cannot be edited`,
        { letterId, status: current.status },
      );
    }
    if (patch.body !== undefined && patch.body.length === 0) {
      throw domainError("invariant_violation", "A letter body cannot be empty");
    }
    const updatedAtUtc = patch.updatedAtUtc ?? new Date().toISOString();
    const currentLetter = parseLetterContract(current);
    const hasSubject = Object.prototype.hasOwnProperty.call(patch, "subject");
    parseLetterContract({
      ...currentLetter,
      ...(hasSubject
        ? patch.subject === null
          ? { subject: undefined }
          : { subject: patch.subject }
        : {}),
      ...(patch.body === undefined ? {} : { body: patch.body }),
      updatedAtUtc,
    });
    this.database
      .prepare(
        `UPDATE letters
         SET subject = CASE WHEN @hasSubject = 1 THEN @subject ELSE subject END,
             body = COALESCE(@body, body), updated_at_utc = @updatedAtUtc
         WHERE id = @letterId AND status = 'draft'`,
      )
      .run({
        hasSubject: hasSubject ? 1 : 0,
        subject: patch.subject ?? null,
        body: patch.body ?? null,
        updatedAtUtc,
        letterId,
      });
    return this.requireLetter(letterId);
  }

  sealLetter(input: SealLetterInput): SealLetterResult {
    assertEntityId(input.letterId, "letterId");
    if (input.taskId !== undefined) assertEntityId(input.taskId, "taskId");
    assertSha256(input.contentHash, "contentHash");
    assertUtc(input.dispatchedAtUtc, "dispatchedAtUtc");
    assertUtc(input.arrivalDueAtUtc, "arrivalDueAtUtc");
    if (input.effectiveAuthorTimeUtc !== undefined)
      assertUtc(input.effectiveAuthorTimeUtc, "effectiveAuthorTimeUtc");
    if (
      input.effectiveAuthorTimeUtc !== undefined &&
      Date.parse(input.effectiveAuthorTimeUtc) >
        Date.parse(input.dispatchedAtUtc)
    ) {
      throw domainError(
        "invariant_violation",
        "effectiveAuthorTimeUtc cannot be later than dispatchedAtUtc",
      );
    }
    assertSchemaValue(
      IanaTimezoneSchema,
      input.transitTimezone,
      "transitTimezone",
    );
    const transaction = this.database.transaction((): SealLetterResult => {
      const current = this.requireLetter(input.letterId);
      const currentRow = this.requireLetterRow(input.letterId);
      if (input.clientRequestId !== undefined) {
        const requestOwner = this.findLetterRowBySealRequest(
          current.agentId,
          input.clientRequestId,
        );
        if (requestOwner !== undefined && requestOwner.id !== current.id) {
          throw domainError(
            "idempotency_conflict",
            "Seal request was already used for another letter",
            { clientRequestId: input.clientRequestId },
          );
        }
      }
      if (current.status !== "draft") {
        if (
          sameSeal(current, input) &&
          (input.clientRequestId === undefined ||
            currentRow.seal_request_id === input.clientRequestId)
        ) {
          return {
            letter: current,
            task: this.requireTaskByIdempotencyKey(
              arrivalIdempotencyKey(current.id),
            ),
            replayed: true,
          };
        }
        throw domainError(
          "immutable_letter",
          `Letter ${current.id} has already left draft state`,
          { letterId: current.id, status: current.status },
        );
      }
      const effectiveAuthorTimeUtc =
        input.effectiveAuthorTimeUtc ?? input.dispatchedAtUtc;
      if (input.transitPolicyVersion !== "fixed_5d_v1") {
        throw domainError(
          "invariant_violation",
          "Only the frozen fixed_5d_v1 transit policy may be persisted",
        );
      }
      assertTransitSchedule(
        current.direction,
        input.dispatchedAtUtc,
        input.transitTimezone,
        input.arrivalDueAtUtc,
      );
      try {
        this.database
          .prepare(
            `UPDATE letters
             SET status = 'sealed', content_hash = ?,
                 seal_request_id = ?, transit_policy_version = ?,
                 transit_timezone = ?,
                 dispatched_at_utc = ?,
                 arrival_due_at_utc = ?, effective_author_time_utc = ?,
                 updated_at_utc = ?
             WHERE id = ? AND status = 'draft'`,
          )
          .run(
            input.contentHash,
            input.clientRequestId ?? null,
            input.transitPolicyVersion,
            input.transitTimezone,
            input.dispatchedAtUtc,
            input.arrivalDueAtUtc,
            effectiveAuthorTimeUtc,
            input.dispatchedAtUtc,
            input.letterId,
          );
        this.database
          .prepare(
            `UPDATE letters SET status = 'in_transit', updated_at_utc = ?
             WHERE id = ? AND status = 'sealed'`,
          )
          .run(input.dispatchedAtUtc, input.letterId);
      } catch (error) {
        throw translateSqlError(error, "Unable to seal letter");
      }
      const task = this.createTemporalTask({
        ...(input.taskId === undefined ? {} : { id: input.taskId }),
        agentId: current.agentId,
        kind:
          current.direction === "user_to_agent"
            ? "letter.outbound_arrival"
            : "letter.return_arrival",
        entityId: current.id,
        dueAtUtc: input.arrivalDueAtUtc,
        priority:
          input.taskPriority ??
          (current.direction === "user_to_agent" ? 10 : 30),
        idempotencyKey: arrivalIdempotencyKey(current.id),
        payload: {
          letterId: current.id,
          ...(input.clientRequestId === undefined
            ? {}
            : { clientRequestId: input.clientRequestId }),
        },
        createdAtUtc: input.dispatchedAtUtc,
      });
      return { letter: this.requireLetter(current.id), task, replayed: false };
    });
    return transaction();
  }

  getLetter(letterId: string): LetterWithEncryptedBody | undefined {
    const row = this.database
      .prepare("SELECT * FROM letters WHERE id = ?")
      .get(letterId) as LetterRow | undefined;
    return row === undefined ? undefined : mapLetter(row);
  }

  listLetters(
    agentId: string,
    filters: LetterListFilters = {},
  ): LetterWithEncryptedBody[] {
    const clauses = ["agent_id = ?"];
    const parameters: unknown[] = [agentId];
    if (filters.threadId !== undefined) {
      clauses.push("thread_id = ?");
      parameters.push(filters.threadId);
    }
    if (filters.direction !== undefined) {
      clauses.push("direction = ?");
      parameters.push(filters.direction);
    }
    if (filters.status !== undefined) {
      const statuses: readonly LetterStatus[] =
        typeof filters.status === "string" ? [filters.status] : filters.status;
      if (statuses.length === 0) return [];
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      parameters.push(...statuses);
    }
    parameters.push(boundedLimit(filters.limit ?? 100));
    return (
      this.database
        .prepare(
          `SELECT * FROM letters WHERE ${clauses.join(" AND ")}
           ORDER BY created_at_utc DESC, rowid DESC LIMIT ?`,
        )
        .all(...parameters) as LetterRow[]
    ).map(mapLetter);
  }

  /**
   * Reads one stable keyset page in the same order as listLetters. `rowid` is
   * used only as the immutable tie-breaker and is returned as an internal
   * anchor for the service's opaque, agent-bound cursor.
   */
  listLetterPage(agentId: string, options: LetterPageOptions = {}): LetterPage {
    assertEntityId(agentId, "agentId");
    const clauses = ["agent_id = ?"];
    const parameters: unknown[] = [agentId];
    if (options.threadId !== undefined) {
      assertEntityId(options.threadId, "threadId");
      clauses.push("thread_id = ?");
      parameters.push(options.threadId);
    }
    if (options.direction !== undefined) {
      clauses.push("direction = ?");
      parameters.push(options.direction);
    }
    if (options.status !== undefined) {
      const statuses: readonly LetterStatus[] =
        typeof options.status === "string" ? [options.status] : options.status;
      if (statuses.length === 0) return { items: [] };
      clauses.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      parameters.push(...statuses);
    }
    if (options.cursor !== undefined) {
      assertUtc(options.cursor.createdAtUtc, "cursor.createdAtUtc");
      if (
        !Number.isSafeInteger(options.cursor.rowId) ||
        options.cursor.rowId <= 0
      ) {
        throw domainError(
          "invariant_violation",
          "cursor.rowId must be a positive safe integer",
        );
      }
      clauses.push(
        "(created_at_utc < ? OR (created_at_utc = ? AND rowid < ?))",
      );
      parameters.push(
        options.cursor.createdAtUtc,
        options.cursor.createdAtUtc,
        options.cursor.rowId,
      );
    }
    const limit = boundedLimit(options.limit ?? 100);
    parameters.push(limit + 1);
    const rows = this.database
      .prepare(
        `SELECT *, rowid AS pagination_row_id
         FROM letters
         WHERE ${clauses.join(" AND ")}
         ORDER BY created_at_utc DESC, rowid DESC
         LIMIT ?`,
      )
      .all(...parameters) as LetterPageRow[];
    const pageRows = rows.slice(0, limit);
    const items = pageRows.map(mapLetter);
    if (rows.length <= limit) return { items };
    const finalRow = pageRows.at(-1);
    if (finalRow === undefined) return { items };
    return {
      items,
      nextCursor: {
        createdAtUtc: finalRow.created_at_utc,
        rowId: finalRow.pagination_row_id,
      },
    };
  }

  markDelivered(
    letterOrInput: string | MarkDeliveredInput,
    effectiveAtUtc?: string,
    processedAtUtc?: string,
  ): LetterWithEncryptedBody {
    const input: MarkDeliveredInput =
      typeof letterOrInput === "string"
        ? {
            letterId: letterOrInput,
            effectiveAtUtc: requiredArgument(effectiveAtUtc, "effectiveAtUtc"),
            processedAtUtc: requiredArgument(processedAtUtc, "processedAtUtc"),
          }
        : letterOrInput;
    assertEntityId(input.letterId, "letterId");
    assertUtc(input.effectiveAtUtc, "effectiveAtUtc");
    assertUtc(input.processedAtUtc, "processedAtUtc");
    const current = this.requireLetter(input.letterId);
    if (current.arrivalDueAtUtc !== input.effectiveAtUtc) {
      throw domainError(
        "invariant_violation",
        "A letter must be delivered at its frozen effective arrival time",
        {
          letterId: current.id,
          arrivalDueAtUtc: current.arrivalDueAtUtc,
          effectiveAtUtc: input.effectiveAtUtc,
        },
      );
    }
    if (Date.parse(input.processedAtUtc) < Date.parse(input.effectiveAtUtc)) {
      throw domainError(
        "invariant_violation",
        "processedAtUtc cannot precede effectiveAtUtc",
      );
    }
    if (current.status === "delivered_unread" || current.status === "read") {
      return current;
    }
    if (current.status !== "in_transit") {
      throw domainError(
        "invalid_state",
        `Letter ${current.id} is not in transit`,
        { letterId: current.id, status: current.status },
      );
    }
    this.database
      .prepare(
        `UPDATE letters
         SET status = 'delivered_unread', delivered_effective_at_utc = ?,
             processed_at_utc = ?, updated_at_utc = ?
         WHERE id = ? AND status = 'in_transit'`,
      )
      .run(
        input.effectiveAtUtc,
        input.processedAtUtc,
        input.processedAtUtc,
        input.letterId,
      );
    return this.requireLetter(input.letterId);
  }

  markRead(
    letterOrInput: string | MarkReadInput,
    readAtUtc?: string,
  ): LetterWithEncryptedBody {
    const input: MarkReadInput =
      typeof letterOrInput === "string"
        ? {
            letterId: letterOrInput,
            readAtUtc: requiredArgument(readAtUtc, "readAtUtc"),
          }
        : letterOrInput;
    assertEntityId(input.letterId, "letterId");
    assertUtc(input.readAtUtc, "readAtUtc");
    const current = this.requireLetter(input.letterId);
    if (current.direction !== "user_to_agent") {
      throw domainError(
        "invalid_state",
        "Agent replies are opened by the user, not marked read by the agent",
        { letterId: current.id, direction: current.direction },
      );
    }
    if (current.status === "read") {
      return current;
    }
    if (current.status !== "delivered_unread") {
      throw domainError(
        "invalid_state",
        `Letter ${current.id} is not ready to read`,
        { letterId: current.id, status: current.status },
      );
    }
    if (current.deliveredEffectiveAtUtc !== input.readAtUtc) {
      throw domainError(
        "invariant_violation",
        "An incoming letter is read at its effective arrival time",
        {
          letterId: current.id,
          deliveredEffectiveAtUtc: current.deliveredEffectiveAtUtc,
          readAtUtc: input.readAtUtc,
        },
      );
    }
    this.database
      .prepare(
        `UPDATE letters SET status = 'read', read_at_utc = ?, updated_at_utc = ?
         WHERE id = ? AND status = 'delivered_unread'`,
      )
      .run(input.readAtUtc, input.readAtUtc, input.letterId);
    return this.requireLetter(input.letterId);
  }

  markOpened(
    letterOrInput: string | MarkOpenedInput,
    openedAtUtc?: string,
  ): LetterWithEncryptedBody {
    const input: MarkOpenedInput =
      typeof letterOrInput === "string"
        ? {
            letterId: letterOrInput,
            openedAtUtc: requiredArgument(openedAtUtc, "openedAtUtc"),
          }
        : letterOrInput;
    assertEntityId(input.letterId, "letterId");
    assertUtc(input.openedAtUtc, "openedAtUtc");
    const current = this.requireLetter(input.letterId);
    if (current.direction !== "agent_to_user") {
      throw domainError(
        "invalid_state",
        "User letters are read by the agent, not opened by the user",
        { letterId: current.id, direction: current.direction },
      );
    }
    if (current.status === "read") {
      return current;
    }
    if (current.status !== "delivered_unread") {
      throw domainError(
        "invalid_state",
        `Letter ${current.id} is not ready to open`,
        { letterId: current.id, status: current.status },
      );
    }
    if (
      current.deliveredEffectiveAtUtc === undefined ||
      current.processedAtUtc === undefined ||
      Date.parse(current.processedAtUtc) <
        Date.parse(current.deliveredEffectiveAtUtc)
    ) {
      throw domainError(
        "invariant_violation",
        "A delivered letter requires ordered effective and processed times",
      );
    }
    const effectiveOpenedAtUtc = [
      input.openedAtUtc,
      current.deliveredEffectiveAtUtc,
      current.processedAtUtc,
      current.updatedAtUtc,
    ].reduce((latest, candidate) =>
      Date.parse(candidate) > Date.parse(latest) ? candidate : latest,
    );
    this.database
      .prepare(
        `UPDATE letters SET status = 'read', opened_at_utc = ?, updated_at_utc = ?
         WHERE id = ? AND status = 'delivered_unread'`,
      )
      .run(effectiveOpenedAtUtc, effectiveOpenedAtUtc, input.letterId);
    return this.requireLetter(input.letterId);
  }

  insertSnapshot(input: InsertSnapshotInput): LetterGenerationSnapshot {
    if (input.id !== undefined) assertEntityId(input.id, "snapshotId");
    assertEntityId(input.incomingLetterId, "incomingLetterId");
    assertEntityId(input.agentId, "agentId");
    assertUtc(input.effectiveAtUtc, "effectiveAtUtc");
    if (input.createdAtUtc !== undefined)
      assertUtc(input.createdAtUtc, "createdAtUtc");
    assertSha256(input.contextHash, "contextHash");
    const existing = this.getSnapshotForIncomingLetter(input.incomingLetterId);
    const id = input.id ?? existing?.id ?? createEntityId("letter_snapshot");
    const createdAtUtc = input.createdAtUtc ?? new Date().toISOString();
    const snapshot = parseSnapshotContract({
      id,
      incomingLetterId: input.incomingLetterId,
      agentId: input.agentId,
      effectiveAtUtc: input.effectiveAtUtc,
      characterVersion: input.characterVersion,
      stateRevision: input.stateRevision,
      contextJson: input.contextJson,
      evidenceIds: [...input.evidenceIds],
      contextHash: input.contextHash,
      createdAtUtc,
    });
    const incoming = this.requireLetter(input.incomingLetterId);
    if (
      incoming.agentId !== input.agentId ||
      incoming.direction !== "user_to_agent" ||
      !["delivered_unread", "read"].includes(incoming.status) ||
      incoming.deliveredEffectiveAtUtc !== snapshot.effectiveAtUtc
    ) {
      throw domainError(
        "invariant_violation",
        "Snapshot must match the effective delivery of an incoming user letter",
        { incomingLetterId: input.incomingLetterId },
      );
    }
    if (existing !== undefined) {
      if (
        (input.id === undefined || input.id === existing.id) &&
        sameSnapshot(existing, snapshot)
      ) {
        return existing;
      }
      throw domainError(
        "idempotency_conflict",
        "A different snapshot already exists for this incoming letter",
        { incomingLetterId: input.incomingLetterId },
      );
    }
    try {
      this.database
        .prepare(
          `INSERT INTO letter_generation_snapshots(
             id, incoming_letter_id, agent_id, effective_at_utc,
             character_version, state_revision, context_json,
             evidence_ids_json, context_hash, created_at_utc
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          snapshot.incomingLetterId,
          input.agentId,
          snapshot.effectiveAtUtc,
          snapshot.characterVersion,
          snapshot.stateRevision,
          JSON.stringify(snapshot.contextJson),
          JSON.stringify(snapshot.evidenceIds),
          snapshot.contextHash,
          snapshot.createdAtUtc,
        );
    } catch (error) {
      const raced = this.getSnapshotForIncomingLetter(input.incomingLetterId);
      if (raced !== undefined && sameSnapshot(raced, snapshot)) return raced;
      throw translateSqlError(error, "Unable to persist generation snapshot");
    }
    return this.requireSnapshot(id);
  }

  getSnapshot(snapshotId: string): LetterGenerationSnapshot | undefined {
    const row = this.database
      .prepare("SELECT * FROM letter_generation_snapshots WHERE id = ?")
      .get(snapshotId) as SnapshotRow | undefined;
    return row === undefined ? undefined : mapSnapshot(row);
  }

  getSnapshotForIncomingLetter(
    incomingLetterId: string,
  ): LetterGenerationSnapshot | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM letter_generation_snapshots WHERE incoming_letter_id = ?",
      )
      .get(incomingLetterId) as SnapshotRow | undefined;
    return row === undefined ? undefined : mapSnapshot(row);
  }

  claimGenerationRun(
    input: ClaimGenerationRunInput,
  ): LetterGenerationRun | undefined {
    if (input.id !== undefined) assertEntityId(input.id, "runId");
    assertEntityId(input.incomingLetterId, "incomingLetterId");
    assertEntityId(input.snapshotId, "snapshotId");
    assertEntityId(input.agentId, "agentId");
    assertEntityId(input.claimToken, "claimToken");
    assertSha256(input.snapshotHash, "snapshotHash");
    assertRevision(input.generationEpoch, "generationEpoch");
    assertUtc(input.nowUtc, "nowUtc");
    assertUtc(input.leaseExpiresAtUtc, "leaseExpiresAtUtc");
    assertLaterThan(
      input.leaseExpiresAtUtc,
      input.nowUtc,
      "leaseExpiresAtUtc",
      "nowUtc",
    );
    if (input.provider !== undefined)
      assertSchemaValue(ShortTextSchema, input.provider, "provider");
    if (input.model !== undefined)
      assertSchemaValue(ShortTextSchema, input.model, "model");
    const transaction = this.database.transaction(
      (): LetterGenerationRun | undefined => {
        const snapshot = this.requireSnapshot(input.snapshotId);
        const incoming = this.requireLetter(input.incomingLetterId);
        if (
          snapshot.incomingLetterId !== input.incomingLetterId ||
          snapshot.contextHash !== input.snapshotHash ||
          incoming.agentId !== input.agentId ||
          incoming.direction !== "user_to_agent" ||
          incoming.status !== "read"
        ) {
          throw domainError(
            "invariant_violation",
            "Generation claim does not match a read incoming letter and its frozen snapshot",
            {
              incomingLetterId: input.incomingLetterId,
              snapshotId: input.snapshotId,
            },
          );
        }
        const committed = this.findCommittedRun(input.incomingLetterId);
        if (committed !== undefined) return committed;
        this.database
          .prepare(
            `UPDATE letter_generation_runs
             SET status = 'failed', claim_token = NULL, claimed_at_utc = NULL,
                 lease_expires_at_utc = NULL,
                 error_code = COALESCE(error_code, 'generation_attempts_exhausted'),
                 updated_at_utc = ?
             WHERE incoming_letter_id = ? AND generation_epoch = ?
               AND status = 'generating' AND attempt >= 3
               AND lease_expires_at_utc <= ?`,
          )
          .run(
            input.nowUtc,
            input.incomingLetterId,
            input.generationEpoch,
            input.nowUtc,
          );
        const existing = this.findRunByEpoch(
          input.incomingLetterId,
          input.generationEpoch,
        );
        if (existing === undefined) {
          try {
            this.database
              .prepare(
                `INSERT INTO letter_generation_runs(
                   id, incoming_letter_id, snapshot_id, agent_id, claim_token,
                   generation_epoch, status, attempt, claimed_at_utc,
                   lease_expires_at_utc, provider, model, created_at_utc,
                   updated_at_utc
                 ) VALUES (?, ?, ?, ?, ?, ?, 'generating', 1, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                input.id ?? createEntityId("letter_generation_run"),
                input.incomingLetterId,
                input.snapshotId,
                input.agentId,
                input.claimToken,
                input.generationEpoch,
                input.nowUtc,
                input.leaseExpiresAtUtc,
                input.provider ?? null,
                input.model ?? null,
                input.nowUtc,
                input.nowUtc,
              );
          } catch (error) {
            throw translateSqlError(error, "Unable to claim generation run");
          }
          return this.findRunByEpoch(
            input.incomingLetterId,
            input.generationEpoch,
          );
        }
        if (existing.snapshotId !== input.snapshotId) {
          throw domainError(
            "idempotency_conflict",
            "Generation epoch is already bound to a different snapshot",
            { runId: existing.id },
          );
        }
        if (
          existing.status === "generating" &&
          existing.leaseExpiresAtUtc !== undefined &&
          existing.leaseExpiresAtUtc > input.nowUtc
        ) {
          return existing.claimToken === input.claimToken
            ? existing
            : undefined;
        }
        if (!["pending", "retryable", "generating"].includes(existing.status)) {
          return undefined;
        }
        const updated = this.database
          .prepare(
            `UPDATE letter_generation_runs
             SET status = 'generating', claim_token = ?,
                 claimed_at_utc = ?, lease_expires_at_utc = ?,
                 attempt = attempt + 1,
                 provider = COALESCE(?, provider), model = COALESCE(?, model),
                 error_code = NULL, updated_at_utc = ?
             WHERE id = ? AND (
               status IN ('pending', 'retryable')
               OR (status = 'generating' AND lease_expires_at_utc <= ?)
             )`,
          )
          .run(
            input.claimToken,
            input.nowUtc,
            input.leaseExpiresAtUtc,
            input.provider ?? null,
            input.model ?? null,
            input.nowUtc,
            existing.id,
            input.nowUtc,
          );
        return updated.changes === 0 ? undefined : this.requireRun(existing.id);
      },
    );
    return transaction();
  }

  commitGenerationRun(
    input: CommitGenerationRunInput,
  ): CommitGenerationRunResult {
    assertEntityId(input.runId, "runId");
    assertEntityId(input.claimToken, "claimToken");
    if (input.replyLetterId !== undefined)
      assertEntityId(input.replyLetterId, "replyLetterId");
    if (input.taskId !== undefined) assertEntityId(input.taskId, "taskId");
    assertRevision(input.generationEpoch, "generationEpoch");
    assertSha256(input.snapshotHash, "snapshotHash");
    assertSha256(input.contentHash, "contentHash");
    assertUtc(input.nowUtc, "nowUtc");
    assertUtc(input.effectiveAuthorTimeUtc, "effectiveAuthorTimeUtc");
    assertUtc(input.arrivalDueAtUtc, "arrivalDueAtUtc");
    assertSchemaValue(
      IanaTimezoneSchema,
      input.transitTimezone,
      "transitTimezone",
    );
    if (input.provider !== undefined)
      assertSchemaValue(ShortTextSchema, input.provider, "provider");
    if (input.model !== undefined)
      assertSchemaValue(ShortTextSchema, input.model, "model");
    EncryptedLetterBodySchema.parse({
      letterId: input.replyLetterId ?? "reply-validation-placeholder",
      ...input.encryptedBody,
    });
    const transaction = this.database.transaction(
      (): CommitGenerationRunResult => {
        const runRow = this.requireRunRow(input.runId);
        const snapshot = this.requireSnapshot(runRow.snapshot_id);
        if (
          snapshot.incomingLetterId !== runRow.incoming_letter_id ||
          snapshot.contextHash !== input.snapshotHash
        ) {
          throw domainError(
            "invariant_violation",
            "Generation commit snapshot hash does not match the frozen preflight snapshot",
            { runId: input.runId, snapshotId: runRow.snapshot_id },
          );
        }
        if (runRow.status === "committed") {
          if (runRow.generation_epoch !== input.generationEpoch) {
            throw domainError(
              "idempotency_conflict",
              "Committed generation was replayed with another generation epoch",
              { runId: input.runId },
            );
          }
          const reply = this.requireLetter(
            requiredArgument(
              runRow.reply_letter_id ?? undefined,
              "replyLetterId",
            ),
          );
          assertCommitReplay(reply, input);
          return {
            run: mapRun(runRow),
            reply,
            task: this.requireTaskByIdempotencyKey(
              arrivalIdempotencyKey(reply.id),
            ),
            replayed: true,
          };
        }
        if (
          runRow.status !== "generating" ||
          runRow.claim_token !== input.claimToken ||
          runRow.generation_epoch !== input.generationEpoch
        ) {
          throw domainError(
            "claim_conflict",
            "Generation commit does not own the active fenced claim",
            { runId: input.runId },
          );
        }
        if (
          runRow.lease_expires_at_utc === null ||
          runRow.lease_expires_at_utc < input.nowUtc
        ) {
          throw domainError(
            "lease_expired",
            "Generation claim lease expired before commit",
            { runId: input.runId },
          );
        }
        if (input.transitPolicyVersion !== "fixed_5d_v1") {
          throw domainError(
            "invariant_violation",
            "Only the frozen fixed_5d_v1 transit policy may be persisted",
          );
        }
        if (input.resultHash !== undefined)
          assertSha256(input.resultHash, "resultHash");
        const provider = input.provider ?? runRow.provider;
        const model = input.model ?? runRow.model;
        if (provider === null || model === null) {
          throw domainError(
            "invariant_violation",
            "A committed generation run requires provider and model",
            { runId: input.runId },
          );
        }
        if (input.effectiveAuthorTimeUtc !== snapshot.effectiveAtUtc) {
          throw domainError(
            "invariant_violation",
            "Reply effective author time must equal the frozen incoming arrival time",
            { runId: input.runId, snapshotId: snapshot.id },
          );
        }
        assertTransitSchedule(
          "agent_to_user",
          input.effectiveAuthorTimeUtc,
          input.transitTimezone,
          input.arrivalDueAtUtc,
        );
        const incoming = this.requireLetter(runRow.incoming_letter_id);
        if (
          incoming.status !== "read" ||
          incoming.direction !== "user_to_agent"
        ) {
          throw domainError(
            "invalid_state",
            "A reply can only commit for a read incoming user letter",
            { incomingLetterId: incoming.id, status: incoming.status },
          );
        }
        const replyId =
          input.replyLetterId ?? stableReplyId(runRow.incoming_letter_id);
        try {
          this.database
            .prepare(
              `INSERT INTO letters(
                 id, thread_id, agent_id, reply_to_letter_id, direction, status,
                 subject, body, content_hash, encrypted_ciphertext,
                 encrypted_iv, encrypted_auth_tag, encrypted_key_version,
                 encrypted_aad_hash, encrypted_created_at_utc,
                 transit_policy_version, transit_timezone, dispatched_at_utc,
                 arrival_due_at_utc, effective_author_time_utc,
                 created_at_utc, updated_at_utc
               ) VALUES (
                 ?, ?, ?, ?, 'agent_to_user', 'in_transit', NULL, NULL, ?, ?, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
               )`,
            )
            .run(
              replyId,
              incoming.threadId,
              incoming.agentId,
              incoming.id,
              input.contentHash,
              input.encryptedBody.ciphertext,
              input.encryptedBody.iv,
              input.encryptedBody.authTag,
              input.encryptedBody.keyVersion,
              input.encryptedBody.aadHash,
              input.encryptedBody.createdAtUtc,
              input.transitPolicyVersion,
              input.transitTimezone,
              input.effectiveAuthorTimeUtc,
              input.arrivalDueAtUtc,
              input.effectiveAuthorTimeUtc,
              input.nowUtc,
              input.nowUtc,
            );
        } catch (error) {
          throw translateSqlError(error, "Unable to persist encrypted reply");
        }
        this.database
          .prepare(
            `UPDATE correspondence_threads
             SET latest_letter_id = ?, updated_at_utc = ? WHERE id = ?`,
          )
          .run(replyId, input.nowUtc, incoming.threadId);
        const task = this.createTemporalTask({
          ...(input.taskId === undefined ? {} : { id: input.taskId }),
          agentId: incoming.agentId,
          kind: "letter.return_arrival",
          entityId: replyId,
          dueAtUtc: input.arrivalDueAtUtc,
          priority: input.taskPriority ?? 30,
          idempotencyKey: arrivalIdempotencyKey(replyId),
          payload: { letterId: replyId },
          createdAtUtc: input.nowUtc,
        });
        const updated = this.database
          .prepare(
            `UPDATE letter_generation_runs
             SET status = 'committed', reply_letter_id = ?, claim_token = NULL,
                 claimed_at_utc = NULL, lease_expires_at_utc = NULL,
                 provider = ?, model = ?, result_hash = COALESCE(?, result_hash),
                 error_code = NULL,
                 updated_at_utc = ?, committed_at_utc = ?
             WHERE id = ? AND status = 'generating' AND claim_token = ?
               AND generation_epoch = ?`,
          )
          .run(
            replyId,
            provider,
            model,
            input.resultHash ?? null,
            input.nowUtc,
            input.nowUtc,
            input.runId,
            input.claimToken,
            input.generationEpoch,
          );
        if (updated.changes !== 1) {
          throw domainError(
            "claim_conflict",
            "Generation claim changed during commit",
            { runId: input.runId },
          );
        }
        return {
          run: this.requireRun(input.runId),
          reply: this.requireLetter(replyId),
          task,
          replayed: false,
        };
      },
    );
    return transaction();
  }

  retryGenerationRun(input: RetryGenerationRunInput): LetterGenerationRun {
    assertEntityId(input.runId, "runId");
    assertEntityId(input.claimToken, "claimToken");
    assertRevision(input.generationEpoch, "generationEpoch");
    assertSchemaValue(ReasonCodeSchema, input.errorCode, "errorCode");
    assertUtc(input.nowUtc, "nowUtc");
    const current = this.requireRun(input.runId);
    if (current.generationEpoch !== input.generationEpoch) {
      throw domainError(
        "idempotency_conflict",
        "Generation retry was replayed with another generation epoch",
        { runId: input.runId },
      );
    }
    if (input.resultHash !== undefined)
      assertSha256(input.resultHash, "resultHash");
    const nextStatus: LetterGenerationRunStatus =
      input.retryable === false || current.attempt >= 3
        ? "failed"
        : "retryable";
    if (current.status === "retryable" || current.status === "failed") {
      if (
        current.status !== nextStatus ||
        current.errorCode !== input.errorCode ||
        (input.resultHash !== undefined &&
          current.resultHash !== input.resultHash)
      ) {
        throw domainError(
          "idempotency_conflict",
          "Generation retry was already recorded with another error",
          { runId: input.runId },
        );
      }
      return current;
    }
    const result = this.database
      .prepare(
        `UPDATE letter_generation_runs
         SET status = ?, claim_token = NULL, claimed_at_utc = NULL,
             lease_expires_at_utc = NULL, error_code = ?,
             result_hash = COALESCE(?, result_hash), updated_at_utc = ?
         WHERE id = ? AND status = 'generating' AND claim_token = ?
           AND generation_epoch = ?`,
      )
      .run(
        nextStatus,
        input.errorCode,
        input.resultHash ?? null,
        input.nowUtc,
        input.runId,
        input.claimToken,
        input.generationEpoch,
      );
    if (result.changes !== 1) {
      throw domainError(
        "claim_conflict",
        "Only the active fenced generation claim may be retried",
        { runId: input.runId },
      );
    }
    return this.requireRun(input.runId);
  }

  getGenerationRun(runId: string): LetterGenerationRun | undefined {
    const row = this.database
      .prepare("SELECT * FROM letter_generation_runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    return row === undefined ? undefined : mapRun(row);
  }

  getGenerationRunForEpoch(
    incomingLetterId: string,
    generationEpoch: number,
  ): LetterGenerationRun | undefined {
    return this.findRunByEpoch(incomingLetterId, generationEpoch);
  }

  findCommittedRun(incomingLetterId: string): LetterGenerationRun | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM letter_generation_runs
         WHERE incoming_letter_id = ? AND status = 'committed'`,
      )
      .get(incomingLetterId) as RunRow | undefined;
    return row === undefined ? undefined : mapRun(row);
  }

  findReplyToLetter(
    incomingLetterId: string,
  ): LetterWithEncryptedBody | undefined {
    assertEntityId(incomingLetterId, "incomingLetterId");
    const row = this.database
      .prepare(
        `SELECT * FROM letters
         WHERE reply_to_letter_id = ? AND direction = 'agent_to_user'`,
      )
      .get(incomingLetterId) as LetterRow | undefined;
    return row === undefined ? undefined : mapLetter(row);
  }

  findLatestGenerationTask(incomingLetterId: string): TemporalTask | undefined {
    assertEntityId(incomingLetterId, "incomingLetterId");
    const row = this.database
      .prepare(
        `SELECT * FROM temporal_tasks
         WHERE entity_id = ?
           AND kind IN ('letter.reply_generation', 'letter.generation_retry')
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get(incomingLetterId) as TaskRow | undefined;
    return row === undefined ? undefined : mapTask(row);
  }

  createTemporalTask(input: CreateTemporalTaskInput): TemporalTask {
    if (input.id !== undefined) assertEntityId(input.id, "taskId");
    assertEntityId(input.agentId, "agentId");
    assertEntityId(input.entityId, "entityId");
    assertSchemaValue(TemporalTaskKindSchema, input.kind, "kind");
    assertUtc(input.dueAtUtc, "dueAtUtc");
    if (input.createdAtUtc !== undefined)
      assertUtc(input.createdAtUtc, "createdAtUtc");
    const existing = this.findTaskRowByIdempotencyKey(input.idempotencyKey);
    const createdAtUtc = input.createdAtUtc ?? new Date().toISOString();
    const id = input.id ?? existing?.id ?? createEntityId("temporal_task");
    const task = parseTaskContract({
      id,
      agentId: input.agentId,
      kind: input.kind,
      entityId: input.entityId,
      dueAtUtc: input.dueAtUtc,
      priority: input.priority,
      status: "pending",
      attempt: 0,
      maxAttempts: input.maxAttempts ?? 3,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload ?? {},
      createdAtUtc,
      updatedAtUtc: createdAtUtc,
    });
    if (existing !== undefined) {
      if (
        (input.id === undefined || input.id === existing.id) &&
        sameTaskRow(existing, input)
      ) {
        return mapTask(existing);
      }
      throw domainError(
        "idempotency_conflict",
        "Temporal task idempotency key was reused with different parameters",
        { idempotencyKey: input.idempotencyKey },
      );
    }
    try {
      this.database
        .prepare(
          `INSERT INTO temporal_tasks(
             id, agent_id, kind, entity_id, due_at_utc, priority, status,
             attempt, max_attempts, idempotency_key, payload_json,
             created_at_utc, updated_at_utc
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          task.agentId,
          task.kind,
          task.entityId,
          task.dueAtUtc,
          task.priority,
          task.maxAttempts,
          task.idempotencyKey,
          JSON.stringify(task.payload),
          task.createdAtUtc,
          task.updatedAtUtc,
        );
    } catch (error) {
      const raced = this.findTaskRowByIdempotencyKey(input.idempotencyKey);
      if (
        raced !== undefined &&
        (input.id === undefined || input.id === raced.id) &&
        sameTaskRow(raced, input)
      )
        return mapTask(raced);
      throw translateSqlError(error, "Unable to create temporal task");
    }
    return this.requireTask(id);
  }

  claimDueTask(input: ClaimDueTaskInput): TemporalTask | undefined {
    if (input.taskId !== undefined) assertEntityId(input.taskId, "taskId");
    if (input.agentId !== undefined) assertEntityId(input.agentId, "agentId");
    assertEntityId(input.claimToken, "claimToken");
    assertUtc(input.nowUtc, "nowUtc");
    assertUtc(input.leaseExpiresAtUtc, "leaseExpiresAtUtc");
    assertLaterThan(
      input.leaseExpiresAtUtc,
      input.nowUtc,
      "leaseExpiresAtUtc",
      "nowUtc",
    );
    input.kinds?.forEach((kind) =>
      assertSchemaValue(TemporalTaskKindSchema, kind, "kind"),
    );
    if (input.kinds !== undefined && input.kinds.length === 0) return undefined;
    const scopeFilters: string[] = [];
    const aliasedScopeFilters: string[] = [];
    const filters = [
      "due_at_utc <= @nowUtc",
      "attempt < max_attempts",
      "(status IN ('pending', 'retryable') OR (status = 'claimed' AND lease_expires_at_utc <= @nowUtc))",
    ];
    const parameters: Record<string, unknown> = {
      nowUtc: input.nowUtc,
      leaseExpiresAtUtc: input.leaseExpiresAtUtc,
      claimToken: input.claimToken,
    };
    if (input.taskId !== undefined) {
      scopeFilters.push("id = @taskId");
      aliasedScopeFilters.push("task.id = @taskId");
      parameters.taskId = input.taskId;
    }
    if (input.agentId !== undefined) {
      scopeFilters.push("agent_id = @agentId");
      aliasedScopeFilters.push("task.agent_id = @agentId");
      parameters.agentId = input.agentId;
    }
    if (input.kinds !== undefined) {
      const placeholders = input.kinds.map((kind, index) => {
        const key = `kind${index}`;
        parameters[key] = kind;
        return `@${key}`;
      });
      scopeFilters.push(`kind IN (${placeholders.join(", ")})`);
      aliasedScopeFilters.push(`task.kind IN (${placeholders.join(", ")})`);
    }
    filters.push(...scopeFilters);
    const claim = this.database.transaction((): TemporalTask | undefined => {
      const replay = this.getTaskByClaimToken(input.claimToken);
      if (replay !== undefined) {
        const matchesScope =
          (input.taskId === undefined || replay.id === input.taskId) &&
          (input.agentId === undefined || replay.agentId === input.agentId) &&
          (input.kinds === undefined || input.kinds.includes(replay.kind));
        if (!matchesScope) {
          throw domainError(
            "idempotency_conflict",
            "Task claim token was reused outside its original claim scope",
            { claimToken: input.claimToken, taskId: replay.id },
          );
        }
        return replay;
      }

      this.database
        .prepare(
          `UPDATE letter_generation_runs
           SET status = 'failed', claim_token = NULL, claimed_at_utc = NULL,
               lease_expires_at_utc = NULL,
               error_code = 'generation_attempts_exhausted',
               updated_at_utc = @nowUtc
           WHERE status = 'generating' AND attempt >= 3
             AND lease_expires_at_utc <= @nowUtc
             AND EXISTS (
               SELECT 1 FROM temporal_tasks AS task
               WHERE task.entity_id = letter_generation_runs.incoming_letter_id
                 AND task.agent_id = letter_generation_runs.agent_id
                 AND task.kind IN (
                   'letter.reply_generation', 'letter.generation_retry'
                 )
                 AND task.due_at_utc <= @nowUtc
                 AND task.attempt >= task.max_attempts
                 AND (task.status IN ('pending', 'retryable')
                   OR (task.status = 'claimed'
                     AND task.lease_expires_at_utc <= @nowUtc))
                 ${
                   aliasedScopeFilters.length === 0
                     ? ""
                     : `AND ${aliasedScopeFilters.join(" AND ")}`
                 }
             )`,
        )
        .run(parameters);
      this.database
        .prepare(
          `UPDATE temporal_tasks
           SET status = 'dead_letter', claim_token = NULL,
               claimed_at_utc = NULL, lease_expires_at_utc = NULL,
               updated_at_utc = @nowUtc
           WHERE due_at_utc <= @nowUtc AND attempt >= max_attempts
             AND (status IN ('pending', 'retryable')
               OR (status = 'claimed' AND lease_expires_at_utc <= @nowUtc))
             ${scopeFilters.length === 0 ? "" : `AND ${scopeFilters.join(" AND ")}`}`,
        )
        .run(parameters);
      try {
        const row = this.database
          .prepare(
            `UPDATE temporal_tasks
             SET status = 'claimed', claim_token = @claimToken,
                 claimed_at_utc = @nowUtc,
                 lease_expires_at_utc = @leaseExpiresAtUtc,
                 attempt = attempt + 1, last_error_code = NULL,
                 updated_at_utc = @nowUtc
             WHERE id = (
               SELECT id FROM temporal_tasks
               WHERE ${filters.join(" AND ")}
               ORDER BY due_at_utc, priority, id LIMIT 1
             )
             RETURNING *`,
          )
          .get(parameters) as TaskRow | undefined;
        return row === undefined ? undefined : mapTask(row);
      } catch (error) {
        throw translateSqlError(error, "Unable to claim due temporal task");
      }
    });
    return claim.immediate();
  }

  findEarliestDueTask(
    agentId: string,
    observedNowUtc: string,
    kinds?: readonly TemporalTaskKind[],
  ): TemporalTask | undefined {
    if (kinds !== undefined && kinds.length === 0) return undefined;
    const parameters: unknown[] = [agentId, observedNowUtc];
    const kindClause =
      kinds === undefined
        ? ""
        : `AND kind IN (${kinds.map(() => "?").join(", ")})`;
    if (kinds !== undefined) parameters.push(...kinds);
    const row = this.database
      .prepare(
        `SELECT * FROM temporal_tasks
         WHERE agent_id = ? AND due_at_utc <= ?
           AND status IN ('pending', 'retryable', 'claimed')
           ${kindClause}
         ORDER BY due_at_utc, priority, id LIMIT 1`,
      )
      .get(...parameters) as TaskRow | undefined;
    return row === undefined ? undefined : mapTask(row);
  }

  /**
   * Returns the next globally actionable correspondence task without relying
   * on browser/SSE activity. A live claim wakes at its lease boundary rather
   * than its (already elapsed) due time so resident workers do not spin on a
   * task currently owned by another process.
   */
  findNextTemporalTask(
    observedNowUtc: string,
    kinds?: readonly TemporalTaskKind[],
    excludedAgentIds: readonly string[] = [],
  ): TemporalTask | undefined {
    if (kinds !== undefined && kinds.length === 0) return undefined;
    const parameters: Record<string, unknown> = { observedNowUtc };
    const filters = ["status IN ('pending', 'retryable', 'claimed')"];
    if (kinds !== undefined) {
      const placeholders = kinds.map((kind, index) => {
        const key = `kind${index}`;
        parameters[key] = kind;
        return `@${key}`;
      });
      filters.push(`kind IN (${placeholders.join(", ")})`);
    }
    if (excludedAgentIds.length > 0) {
      const placeholders = excludedAgentIds.map((agentId, index) => {
        const key = `excludedAgent${index}`;
        parameters[key] = agentId;
        return `@${key}`;
      });
      filters.push(`agent_id NOT IN (${placeholders.join(", ")})`);
    }
    const row = this.database
      .prepare(
        `SELECT * FROM temporal_tasks
         WHERE ${filters.join(" AND ")}
         ORDER BY
           CASE
             WHEN status = 'claimed'
               AND lease_expires_at_utc > @observedNowUtc
             THEN lease_expires_at_utc
             ELSE due_at_utc
           END,
           due_at_utc, priority, id
         LIMIT 1`,
      )
      .get(parameters) as TaskRow | undefined;
    return row === undefined ? undefined : mapTask(row);
  }

  completeTask(input: CompleteTaskInput): TemporalTask {
    assertEntityId(input.taskId, "taskId");
    assertEntityId(input.claimToken, "claimToken");
    assertUtc(input.completedAtUtc, "completedAtUtc");
    const current = this.requireTask(input.taskId);
    if (current.status === "completed") return current;
    const result = this.database
      .prepare(
        `UPDATE temporal_tasks
         SET status = 'completed', claim_token = NULL, claimed_at_utc = NULL,
             lease_expires_at_utc = NULL, updated_at_utc = ?,
             completed_at_utc = ?
         WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
      )
      .run(
        input.completedAtUtc,
        input.completedAtUtc,
        input.taskId,
        input.claimToken,
      );
    if (result.changes !== 1) {
      throw domainError(
        "claim_conflict",
        "Only the active task claim may complete this task",
        { taskId: input.taskId },
      );
    }
    return this.requireTask(input.taskId);
  }

  retryTask(input: RetryTaskInput): TemporalTask {
    assertEntityId(input.taskId, "taskId");
    assertEntityId(input.claimToken, "claimToken");
    assertSchemaValue(ReasonCodeSchema, input.errorCode, "errorCode");
    assertUtc(input.nowUtc, "nowUtc");
    if (input.nextDueAtUtc !== undefined)
      assertUtc(input.nextDueAtUtc, "nextDueAtUtc");
    const current = this.requireTask(input.taskId);
    const nextStatus: TemporalTaskStatus =
      input.retryable === false || current.attempt >= current.maxAttempts
        ? "dead_letter"
        : "retryable";
    const nextDueAtUtc =
      nextStatus === "dead_letter"
        ? current.dueAtUtc
        : requiredRetryDueAtUtc(input);
    if (current.status === "retryable" || current.status === "dead_letter") {
      if (
        current.status !== nextStatus ||
        current.lastErrorCode !== input.errorCode ||
        current.dueAtUtc !== nextDueAtUtc
      ) {
        throw domainError(
          "idempotency_conflict",
          "Task retry was already recorded with another error",
          { taskId: input.taskId },
        );
      }
      return current;
    }
    const result = this.database
      .prepare(
        `UPDATE temporal_tasks
         SET status = ?, claim_token = NULL, claimed_at_utc = NULL,
             lease_expires_at_utc = NULL, due_at_utc = ?,
             last_error_code = ?, updated_at_utc = ?
         WHERE id = ? AND status = 'claimed' AND claim_token = ?`,
      )
      .run(
        nextStatus,
        nextDueAtUtc,
        input.errorCode,
        input.nowUtc,
        input.taskId,
        input.claimToken,
      );
    if (result.changes !== 1) {
      throw domainError(
        "claim_conflict",
        "Only the active task claim may retry this task",
        { taskId: input.taskId },
      );
    }
    return this.requireTask(input.taskId);
  }

  getTask(taskId: string): TemporalTask | undefined {
    const row = this.database
      .prepare("SELECT * FROM temporal_tasks WHERE id = ?")
      .get(taskId) as TaskRow | undefined;
    return row === undefined ? undefined : mapTask(row);
  }

  getTaskByIdempotencyKey(idempotencyKey: string): TemporalTask | undefined {
    const row = this.findTaskRowByIdempotencyKey(idempotencyKey);
    return row === undefined ? undefined : mapTask(row);
  }

  getTaskByClaimToken(claimToken: string): TemporalTask | undefined {
    const row = this.database
      .prepare("SELECT * FROM temporal_tasks WHERE claim_token = ?")
      .get(claimToken) as TaskRow | undefined;
    return row === undefined ? undefined : mapTask(row);
  }

  listTasks(agentId: string, limit = 100): TemporalTask[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM temporal_tasks WHERE agent_id = ?
           ORDER BY due_at_utc, priority, id LIMIT ?`,
        )
        .all(agentId, boundedLimit(limit)) as TaskRow[]
    ).map(mapTask);
  }

  private requireThread(threadId: string): CorrespondenceThread {
    const thread = this.getThread(threadId);
    if (thread === undefined) {
      throw domainError(
        "not_found",
        `Correspondence thread ${threadId} was not found`,
      );
    }
    return thread;
  }

  private requireLetter(letterId: string): LetterWithEncryptedBody {
    const letter = this.getLetter(letterId);
    if (letter === undefined) {
      throw domainError("not_found", `Letter ${letterId} was not found`);
    }
    return letter;
  }

  private requireLetterRow(letterId: string): LetterRow {
    const row = this.database
      .prepare("SELECT * FROM letters WHERE id = ?")
      .get(letterId) as LetterRow | undefined;
    if (row === undefined) {
      throw domainError("not_found", `Letter ${letterId} was not found`);
    }
    return row;
  }

  private findLetterRowByCreateRequest(
    agentId: string,
    clientRequestId: string,
  ): LetterRow | undefined {
    return this.database
      .prepare(
        "SELECT * FROM letters WHERE agent_id = ? AND create_request_id = ?",
      )
      .get(agentId, clientRequestId) as LetterRow | undefined;
  }

  private findLetterRowBySealRequest(
    agentId: string,
    clientRequestId: string,
  ): LetterRow | undefined {
    return this.database
      .prepare(
        "SELECT * FROM letters WHERE agent_id = ? AND seal_request_id = ?",
      )
      .get(agentId, clientRequestId) as LetterRow | undefined;
  }

  private requireSnapshot(snapshotId: string): LetterGenerationSnapshot {
    const snapshot = this.getSnapshot(snapshotId);
    if (snapshot === undefined) {
      throw domainError(
        "not_found",
        `Generation snapshot ${snapshotId} was not found`,
      );
    }
    return snapshot;
  }

  private findRunByEpoch(
    incomingLetterId: string,
    generationEpoch: number,
  ): LetterGenerationRun | undefined {
    const row = this.database
      .prepare(
        `SELECT * FROM letter_generation_runs
         WHERE incoming_letter_id = ? AND generation_epoch = ?`,
      )
      .get(incomingLetterId, generationEpoch) as RunRow | undefined;
    return row === undefined ? undefined : mapRun(row);
  }

  private requireRun(runId: string): LetterGenerationRun {
    const run = this.getGenerationRun(runId);
    if (run === undefined) {
      throw domainError("not_found", `Generation run ${runId} was not found`);
    }
    return run;
  }

  private requireRunRow(runId: string): RunRow {
    const row = this.database
      .prepare("SELECT * FROM letter_generation_runs WHERE id = ?")
      .get(runId) as RunRow | undefined;
    if (row === undefined) {
      throw domainError("not_found", `Generation run ${runId} was not found`);
    }
    return row;
  }

  private requireTask(taskId: string): TemporalTask {
    const task = this.getTask(taskId);
    if (task === undefined) {
      throw domainError("not_found", `Temporal task ${taskId} was not found`);
    }
    return task;
  }

  private findTaskRowByIdempotencyKey(
    idempotencyKey: string,
  ): TaskRow | undefined {
    return this.database
      .prepare("SELECT * FROM temporal_tasks WHERE idempotency_key = ?")
      .get(idempotencyKey) as TaskRow | undefined;
  }

  private requireTaskByIdempotencyKey(idempotencyKey: string): TemporalTask {
    const task = this.getTaskByIdempotencyKey(idempotencyKey);
    if (task === undefined) {
      throw domainError(
        "invariant_violation",
        `Temporal task ${idempotencyKey} is missing`,
      );
    }
    return task;
  }
}

function mapThread(row: ThreadRow): CorrespondenceThread {
  return CorrespondenceThreadSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    ...(row.root_letter_id === null
      ? {}
      : { rootLetterId: row.root_letter_id }),
    ...(row.latest_letter_id === null
      ? {}
      : { latestLetterId: row.latest_letter_id }),
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
    ...(row.closed_at_utc === null ? {} : { closedAtUtc: row.closed_at_utc }),
  });
}

function mapLetter(row: LetterRow): LetterWithEncryptedBody {
  const letter: LetterWithEncryptedBody = LetterSchema.parse({
    id: row.id,
    threadId: row.thread_id,
    agentId: row.agent_id,
    ...(row.reply_to_letter_id === null
      ? {}
      : { replyToLetterId: row.reply_to_letter_id }),
    direction: row.direction,
    status: row.status,
    ...(row.subject === null ? {} : { subject: row.subject }),
    ...(row.body === null ? {} : { body: row.body }),
    ...(row.content_hash === null ? {} : { contentHash: row.content_hash }),
    ...(row.transit_policy_version === null
      ? {}
      : { transitPolicyVersion: row.transit_policy_version }),
    ...(row.transit_timezone === null
      ? {}
      : { transitTimezone: row.transit_timezone }),
    ...(row.dispatched_at_utc === null
      ? {}
      : { dispatchedAtUtc: row.dispatched_at_utc }),
    ...(row.arrival_due_at_utc === null
      ? {}
      : { arrivalDueAtUtc: row.arrival_due_at_utc }),
    ...(row.effective_author_time_utc === null
      ? {}
      : { effectiveAuthorTimeUtc: row.effective_author_time_utc }),
    ...(row.delivered_effective_at_utc === null
      ? {}
      : { deliveredEffectiveAtUtc: row.delivered_effective_at_utc }),
    ...(row.processed_at_utc === null
      ? {}
      : { processedAtUtc: row.processed_at_utc }),
    ...(row.read_at_utc === null ? {} : { readAtUtc: row.read_at_utc }),
    ...(row.opened_at_utc === null ? {} : { openedAtUtc: row.opened_at_utc }),
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
  });
  if (row.encrypted_ciphertext !== null) {
    letter.encryptedBody = EncryptedLetterBodySchema.parse({
      letterId: row.id,
      ciphertext: row.encrypted_ciphertext,
      iv: requiredColumn(row.encrypted_iv, "encrypted_iv"),
      authTag: requiredColumn(row.encrypted_auth_tag, "encrypted_auth_tag"),
      keyVersion: requiredColumn(
        row.encrypted_key_version,
        "encrypted_key_version",
      ),
      aadHash: requiredColumn(row.encrypted_aad_hash, "encrypted_aad_hash"),
      createdAtUtc: requiredColumn(
        row.encrypted_created_at_utc,
        "encrypted_created_at_utc",
      ),
    });
  }
  return letter;
}

function mapSnapshot(row: SnapshotRow): LetterGenerationSnapshot {
  const evidenceIds = JSON.parse(row.evidence_ids_json) as unknown;
  if (
    !Array.isArray(evidenceIds) ||
    !evidenceIds.every((item): item is string => typeof item === "string")
  ) {
    throw new TypeError("Snapshot evidence_ids_json is not a string array");
  }
  return LetterGenerationSnapshotSchema.parse({
    id: row.id,
    incomingLetterId: row.incoming_letter_id,
    agentId: row.agent_id,
    effectiveAtUtc: row.effective_at_utc,
    characterVersion: row.character_version,
    stateRevision: row.state_revision,
    contextJson: JSON.parse(row.context_json) as unknown,
    evidenceIds,
    contextHash: row.context_hash,
    createdAtUtc: row.created_at_utc,
  });
}

function parseSnapshotContract(value: unknown): LetterGenerationSnapshot {
  const parsed = LetterGenerationSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    throw domainError(
      "invariant_violation",
      "Generation snapshot violates the correspondence contract",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

function parseLetterContract(value: unknown): Letter {
  const parsed = LetterSchema.safeParse(value);
  if (!parsed.success) {
    throw domainError(
      "invariant_violation",
      "Letter violates the correspondence contract",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

function parseTaskContract(value: unknown): TemporalTask {
  const parsed = TemporalTaskSchema.safeParse(value);
  if (!parsed.success) {
    throw domainError(
      "invariant_violation",
      "Temporal task violates the correspondence contract",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

function mapRun(row: RunRow): LetterGenerationRun {
  return LetterGenerationRunSchema.parse({
    id: row.id,
    incomingLetterId: row.incoming_letter_id,
    snapshotId: row.snapshot_id,
    agentId: row.agent_id,
    ...(row.reply_letter_id === null
      ? {}
      : { replyLetterId: row.reply_letter_id }),
    ...(row.claim_token === null ? {} : { claimToken: row.claim_token }),
    generationEpoch: row.generation_epoch,
    status: row.status,
    attempt: row.attempt,
    ...(row.claimed_at_utc === null
      ? {}
      : { claimedAtUtc: row.claimed_at_utc }),
    ...(row.lease_expires_at_utc === null
      ? {}
      : { leaseExpiresAtUtc: row.lease_expires_at_utc }),
    ...(row.provider === null ? {} : { provider: row.provider }),
    ...(row.model === null ? {} : { model: row.model }),
    ...(row.error_code === null ? {} : { errorCode: row.error_code }),
    ...(row.result_hash === null ? {} : { resultHash: row.result_hash }),
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
    ...(row.committed_at_utc === null
      ? {}
      : { committedAtUtc: row.committed_at_utc }),
  });
}

function mapTask(row: TaskRow): TemporalTask {
  return TemporalTaskSchema.parse({
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    entityId: row.entity_id,
    dueAtUtc: row.due_at_utc,
    priority: row.priority,
    status: row.status,
    ...(row.claim_token === null ? {} : { claimToken: row.claim_token }),
    ...(row.claimed_at_utc === null
      ? {}
      : { claimedAtUtc: row.claimed_at_utc }),
    ...(row.lease_expires_at_utc === null
      ? {}
      : { leaseExpiresAtUtc: row.lease_expires_at_utc }),
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload_json) as unknown,
    ...(row.last_error_code === null
      ? {}
      : { lastErrorCode: row.last_error_code }),
    createdAtUtc: row.created_at_utc,
    updatedAtUtc: row.updated_at_utc,
    ...(row.completed_at_utc === null
      ? {}
      : { completedAtUtc: row.completed_at_utc }),
  });
}

function sameSeal(letter: Letter, input: SealLetterInput): boolean {
  return (
    ["sealed", "in_transit", "delivered_unread", "read"].includes(
      letter.status,
    ) &&
    letter.contentHash === input.contentHash &&
    letter.transitPolicyVersion === input.transitPolicyVersion &&
    letter.transitTimezone === input.transitTimezone &&
    letter.dispatchedAtUtc === input.dispatchedAtUtc &&
    letter.arrivalDueAtUtc === input.arrivalDueAtUtc &&
    letter.effectiveAuthorTimeUtc ===
      (input.effectiveAuthorTimeUtc ?? input.dispatchedAtUtc)
  );
}

function sameSnapshot(
  snapshot: LetterGenerationSnapshot,
  input: Pick<
    LetterGenerationSnapshot,
    | "effectiveAtUtc"
    | "characterVersion"
    | "stateRevision"
    | "contextJson"
    | "evidenceIds"
    | "contextHash"
  >,
): boolean {
  return (
    snapshot.effectiveAtUtc === input.effectiveAtUtc &&
    snapshot.characterVersion === input.characterVersion &&
    snapshot.stateRevision === input.stateRevision &&
    snapshot.contextHash === input.contextHash &&
    canonicalLetterGenerationSnapshot({
      contextJson: snapshot.contextJson,
      evidenceIds: snapshot.evidenceIds,
    }) ===
      canonicalLetterGenerationSnapshot({
        contextJson: input.contextJson,
        evidenceIds: input.evidenceIds,
      })
  );
}

function sameTaskRow(task: TaskRow, input: CreateTemporalTaskInput): boolean {
  return (
    task.agent_id === input.agentId &&
    task.kind === input.kind &&
    task.entity_id === input.entityId &&
    task.due_at_utc === input.dueAtUtc &&
    task.priority === input.priority &&
    task.max_attempts === (input.maxAttempts ?? 3) &&
    canonicalCorrespondenceJson(JSON.parse(task.payload_json) as unknown) ===
      canonicalCorrespondenceJson(input.payload ?? {})
  );
}

function assertCommitReplay(
  reply: LetterWithEncryptedBody,
  input: CommitGenerationRunInput,
): void {
  if (
    (input.replyLetterId !== undefined && reply.id !== input.replyLetterId) ||
    reply.contentHash !== input.contentHash ||
    reply.transitPolicyVersion !== input.transitPolicyVersion ||
    reply.transitTimezone !== input.transitTimezone ||
    reply.effectiveAuthorTimeUtc !== input.effectiveAuthorTimeUtc ||
    reply.arrivalDueAtUtc !== input.arrivalDueAtUtc ||
    reply.encryptedBody?.ciphertext !== input.encryptedBody.ciphertext ||
    reply.encryptedBody.iv !== input.encryptedBody.iv ||
    reply.encryptedBody.authTag !== input.encryptedBody.authTag ||
    reply.encryptedBody.keyVersion !== input.encryptedBody.keyVersion ||
    reply.encryptedBody.aadHash !== input.encryptedBody.aadHash ||
    reply.encryptedBody.createdAtUtc !== input.encryptedBody.createdAtUtc
  ) {
    throw domainError(
      "idempotency_conflict",
      "Committed generation was replayed with different reply data",
      { runId: input.runId },
    );
  }
}

function arrivalIdempotencyKey(letterId: string): string {
  return `letter-arrival:${letterId}`;
}

function stableReplyId(incomingLetterId: string): string {
  const digest = createHash("sha256")
    .update(`letter-reply:${incomingLetterId}:v1`, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `letter_reply_${digest}`;
}

function draftCreateRequestHash(input: CreateDraftLetterInput): string {
  return createHash("sha256")
    .update(
      canonicalCorrespondenceJson({
        threadId: input.threadId,
        agentId: input.agentId,
        direction: input.direction ?? "user_to_agent",
        replyToLetterId: input.replyToLetterId ?? null,
        subject: input.subject ?? null,
        body: input.body,
      }),
      "utf8",
    )
    .digest("hex");
}

function assertTransitSchedule(
  direction: LetterDirection,
  dispatchedAtUtc: string,
  transitTimezone: string,
  arrivalDueAtUtc: string,
): void {
  let expected: string;
  try {
    expected = calculateLetterArrivalDueAtUtc(
      dispatchedAtUtc,
      transitTimezone,
      direction,
    );
  } catch (error) {
    throw domainError(
      "invariant_violation",
      `Invalid frozen transit schedule: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (expected !== arrivalDueAtUtc) {
    throw domainError(
      "invariant_violation",
      "Arrival due time must be calculated by fixed_5d_v1 in the persisted transit timezone",
      { expectedArrivalDueAtUtc: expected, arrivalDueAtUtc },
    );
  }
}

function assertEntityId(value: string, field: string): void {
  assertSchemaValue(EntityIdSchema, value, field);
}

function assertUtc(value: string, field: string): void {
  assertSchemaValue(UtcDateTimeSchema, value, field);
}

function assertRevision(value: number, field: string): void {
  assertSchemaValue(RevisionSchema, value, field);
}

function assertSchemaValue(
  schema: { safeParse(value: unknown): { success: boolean } },
  value: unknown,
  field: string,
): void {
  if (!schema.safeParse(value).success) {
    throw domainError("invariant_violation", `${field} is invalid`);
  }
}

function assertLaterThan(
  laterUtc: string,
  earlierUtc: string,
  laterField: string,
  earlierField: string,
): void {
  if (Date.parse(laterUtc) <= Date.parse(earlierUtc)) {
    throw domainError(
      "invariant_violation",
      `${laterField} must be later than ${earlierField}`,
    );
  }
}

function assertSha256(value: string, field: string): void {
  if (!/^[a-f0-9]{64}$/u.test(value)) {
    throw domainError(
      "invariant_violation",
      `${field} must be a lowercase SHA-256 digest`,
    );
  }
}

function domainError(
  code: CorrespondenceRepositoryErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): CorrespondenceRepositoryError {
  return new CorrespondenceRepositoryError(code, message, details);
}

function translateSqlError(error: unknown, context: string): Error {
  if (error instanceof CorrespondenceRepositoryError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/UNIQUE constraint failed/iu.test(message)) {
    return domainError("idempotency_conflict", `${context}: ${message}`);
  }
  if (/immutable/iu.test(message)) {
    return domainError("immutable_letter", `${context}: ${message}`);
  }
  if (
    /CHECK constraint failed|FOREIGN KEY constraint failed|must match|requires|awaiting reply|invalid .* transition|identity is immutable/iu.test(
      message,
    )
  ) {
    return domainError("invariant_violation", `${context}: ${message}`);
  }
  return error instanceof Error ? error : new Error(message);
}

function requiredArgument<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw domainError("invariant_violation", `${name} is required`);
  }
  return value;
}

function requiredRetryDueAtUtc(input: RetryTaskInput): string {
  if (input.nextDueAtUtc === undefined) {
    throw domainError(
      "invariant_violation",
      "nextDueAtUtc is required for a retryable temporal task",
      { taskId: input.taskId },
    );
  }
  return input.nextDueAtUtc;
}

function requiredColumn<T>(value: T | null, name: string): T {
  if (value === null)
    throw new TypeError(`Required database column ${name} is null`);
  return value;
}

function boundedLimit(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.max(1, Math.min(500, Math.trunc(value)));
}
