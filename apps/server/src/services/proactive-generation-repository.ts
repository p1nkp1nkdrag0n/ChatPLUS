import type { ProactiveDeliverySubjectLike } from "@personasim/features";

import type { Database } from "../db/connection.js";
import { createEntityId } from "../domain/id.js";
import { FollowUpRepository } from "./follow-up-repository.js";

export type ProactiveSubjectRef =
  | { kind: "activity_candidate"; id: string }
  | { kind: "follow_up"; id: string };

export type ProactiveSubjectRecord =
  | (ProactiveDeliverySubjectLike & {
      kind: "activity_candidate";
      id: string;
      agentId: string;
      revision: number;
      generationEpoch: number;
      priority: number;
      triggerEventId: string;
      summary: string;
      draftMessage?: string;
    })
  | (ProactiveDeliverySubjectLike & {
      kind: "follow_up";
      id: string;
      agentId: string;
      revision: number;
      generationEpoch: number;
      contextSummary: string;
      expectedOutcomeDescription: string;
    });

export type GenerationRunStatus =
  "generating" | "committed" | "stale_discarded" | "failed";

export interface StoredGenerationRun {
  id: string;
  agentId: string;
  sourceKind: ProactiveSubjectRef["kind"];
  sourceId: string;
  generationEpoch: number;
  claimToken: string;
  status: GenerationRunStatus;
  sessionId: string;
  preflightSpecVersion: number;
  preflightStateRevision: number;
  preflightSourceRevision: number;
  preflightMessageRowid: number;
  preflightLastUserMessageRowid: number;
  preflightUserArrivalEpoch: number;
  snapshot: Record<string, unknown>;
  generatedContent?: string;
  messageId?: string;
  reasonCode?: string;
  startedAtUtc: string;
  completedAtUtc?: string;
}

export interface ClaimedGeneration {
  run: StoredGenerationRun;
  subject: ProactiveSubjectRecord;
}

export interface StoredProactiveMessage {
  id: string;
  sessionId: string;
  agentId: string;
  content: string;
  triggerEventId?: string;
  triggerFollowUpIntentId?: string;
  metadata: Record<string, unknown>;
  createdAtUtc: string;
}

type SqlRow = Record<string, unknown>;

export class ProactiveGenerationRepository {
  constructor(readonly database: Database) {}

  transaction<T>(operation: () => T): T {
    return this.database.transaction(operation)();
  }

  hasGeneratingRun(agentId: string): boolean {
    return (
      this.database
        .prepare(
          `SELECT 1 FROM proactive_generation_runs
           WHERE agent_id = ? AND status = 'generating' LIMIT 1`,
        )
        .get(agentId) !== undefined
    );
  }

  recoverExpiredGeneratingRuns(input: {
    agentId: string;
    leaseCutoffUtc: string;
    completedAtUtc: string;
  }): number {
    const expired = this.database
      .prepare(
        `SELECT id, claim_token
         FROM proactive_generation_runs
         WHERE agent_id = ?
           AND status = 'generating'
           AND started_at_utc <= ?
         ORDER BY started_at_utc, rowid`,
      )
      .all(input.agentId, input.leaseCutoffUtc) as Array<{
      id: string;
      claim_token: string;
    }>;
    let recovered = 0;
    for (const run of expired) {
      if (
        this.discardGeneration({
          runId: run.id,
          claimToken: run.claim_token,
          reasonCode: "generation_lease_expired",
          completedAtUtc: input.completedAtUtc,
        })
      ) {
        recovered += 1;
      }
    }
    return recovered;
  }

  readAgentRevisions(
    agentId: string,
  ): { specVersion: number; stateRevision: number } | undefined {
    const row = this.database
      .prepare(
        `SELECT c.current_version AS spec_version,
                rs.revision AS state_revision
         FROM characters c
         JOIN runtime_states rs ON rs.agent_id = c.id
         WHERE c.id = ?`,
      )
      .get(agentId) as
      { spec_version: number; state_revision: number } | undefined;
    return row === undefined
      ? undefined
      : {
          specVersion: Number(row.spec_version),
          stateRevision: Number(row.state_revision),
        };
  }

  sessionBelongsToAgent(sessionId: string, agentId: string): boolean {
    return (
      this.database
        .prepare("SELECT 1 FROM sessions WHERE id = ? AND agent_id = ?")
        .get(sessionId, agentId) !== undefined
    );
  }

  countSentToday(
    agentId: string,
    dayStartUtc: string,
    dayEndUtc: string,
  ): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE agent_id = ?
           AND message_kind = 'assistant_proactive'
           AND created_at_utc >= ?
           AND created_at_utc <= ?`,
      )
      .get(agentId, dayStartUtc, dayEndUtc) as { count: number };
    return Number(row.count);
  }

  countUnanswered(agentId: string): number {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM messages
         WHERE agent_id = ?
           AND message_kind = 'assistant_proactive'
           AND rowid > COALESCE((
             SELECT MAX(rowid) FROM messages
             WHERE agent_id = ? AND role = 'user'
           ), 0)`,
      )
      .get(agentId, agentId) as { count: number };
    return Number(row.count);
  }

  expirePendingSources(agentId: string, nowUtc: string): void {
    this.database
      .prepare(
        `UPDATE proactive_candidates
         SET status = 'expired', revision = revision + 1
         WHERE agent_id = ?
           AND status = 'pending'
           AND expires_at_utc <= ?
           AND NOT EXISTS (
             SELECT 1 FROM proactive_generation_runs pgr
             WHERE pgr.proactive_candidate_id = proactive_candidates.id
               AND pgr.status = 'generating'
           )`,
      )
      .run(agentId, nowUtc);
    this.database
      .prepare(
        `UPDATE follow_up_intents
         SET status = 'expired',
             revision = revision + 1,
             updated_at_utc = ?
         WHERE agent_id = ?
           AND status = 'pending'
           AND expires_at_utc <= ?
           AND NOT EXISTS (
             SELECT 1 FROM proactive_generation_runs pgr
             WHERE pgr.follow_up_intent_id = follow_up_intents.id
               AND pgr.status = 'generating'
           )`,
      )
      .run(nowUtc, agentId, nowUtc);
  }

  findNextDueSubject(
    agentId: string,
    nowUtc: string,
  ): ProactiveSubjectRecord | undefined {
    const followUps = this.database
      .prepare(
        `SELECT fui.*,
           EXISTS(
             SELECT 1 FROM messages m
             WHERE m.trigger_follow_up_intent_id = fui.id
                OR m.id = fui.resolution_message_id
           ) AS already_discussed
         FROM follow_up_intents fui
         WHERE fui.agent_id = ?
           AND fui.status = 'pending'
           AND fui.attempt_count < fui.max_attempts
           AND fui.earliest_at_utc <= ?
           AND fui.expires_at_utc > ?
           AND NOT EXISTS (
             SELECT 1 FROM proactive_generation_runs pgr
             WHERE pgr.follow_up_intent_id = fui.id
               AND pgr.status = 'generating'
           )
         ORDER BY fui.earliest_at_utc, fui.created_at_utc, fui.rowid
         `,
      )
      .all(agentId, nowUtc, nowUtc) as SqlRow[];
    const evidence = new FollowUpRepository(this.database);
    const followUp = followUps.find((row) =>
      evidence.isFollowUpEvidenceCurrent(String(row["id"])),
    );
    if (followUp !== undefined) return mapFollowUpSubject(followUp);

    const candidate = this.database
      .prepare(
        `SELECT pc.*,
           EXISTS(
             SELECT 1 FROM messages m
             WHERE m.trigger_event_id = pc.trigger_event_id
                OR m.id = pc.sent_message_id
           ) AS already_discussed
         FROM proactive_candidates pc
         WHERE pc.agent_id = ?
           AND pc.status = 'pending'
           AND pc.earliest_at_utc <= ?
           AND pc.expires_at_utc > ?
           AND NOT EXISTS (
             SELECT 1 FROM proactive_generation_runs pgr
             WHERE pgr.proactive_candidate_id = pc.id
               AND pgr.status = 'generating'
           )
         ORDER BY pc.priority DESC, pc.created_at_utc, pc.rowid
         LIMIT 1`,
      )
      .get(agentId, nowUtc, nowUtc) as SqlRow | undefined;
    return candidate === undefined ? undefined : mapActivitySubject(candidate);
  }

  getSubject(ref: ProactiveSubjectRef): ProactiveSubjectRecord | undefined {
    if (ref.kind === "follow_up") {
      if (
        !new FollowUpRepository(this.database).isFollowUpEvidenceCurrent(ref.id)
      )
        return undefined;
      const row = this.database
        .prepare(
          `SELECT fui.*,
             EXISTS(
               SELECT 1 FROM messages m
               WHERE m.trigger_follow_up_intent_id = fui.id
                  OR m.id = fui.resolution_message_id
             ) AS already_discussed
           FROM follow_up_intents fui WHERE fui.id = ?`,
        )
        .get(ref.id) as SqlRow | undefined;
      return row === undefined ? undefined : mapFollowUpSubject(row);
    }
    const row = this.database
      .prepare(
        `SELECT pc.*,
           EXISTS(
             SELECT 1 FROM messages m
             WHERE m.trigger_event_id = pc.trigger_event_id
                OR m.id = pc.sent_message_id
           ) AS already_discussed
         FROM proactive_candidates pc WHERE pc.id = ?`,
      )
      .get(ref.id) as SqlRow | undefined;
    return row === undefined ? undefined : mapActivitySubject(row);
  }

  claimSubject(input: {
    runId: string;
    claimToken: string;
    subject: ProactiveSubjectRecord;
    sessionId: string;
    specVersion: number;
    stateRevision: number;
    messageRowid: number;
    lastUserMessageRowid: number;
    userArrivalEpoch: number;
    snapshot: Record<string, unknown>;
    startedAtUtc: string;
  }): ClaimedGeneration | undefined {
    if (
      input.subject.kind === "follow_up" &&
      !new FollowUpRepository(this.database).isFollowUpEvidenceCurrent(
        input.subject.id,
      )
    )
      return undefined;
    const nextEpoch = input.subject.generationEpoch + 1;
    const nextRevision = input.subject.revision + 1;
    const claimed =
      input.subject.kind === "activity_candidate"
        ? this.database
            .prepare(
              `UPDATE proactive_candidates
               SET generation_epoch = generation_epoch + 1,
                   revision = revision + 1,
                   claim_token = @claimToken,
                   claimed_at_utc = @startedAtUtc
               WHERE id = @subjectId
                 AND agent_id = @agentId
                 AND status = 'pending'
                 AND revision = @expectedRevision
                 AND generation_epoch = @expectedEpoch`,
            )
            .run({
              claimToken: input.claimToken,
              startedAtUtc: input.startedAtUtc,
              subjectId: input.subject.id,
              agentId: input.subject.agentId,
              expectedRevision: input.subject.revision,
              expectedEpoch: input.subject.generationEpoch,
            })
        : this.database
            .prepare(
              `UPDATE follow_up_intents
               SET generation_epoch = generation_epoch + 1,
                   revision = revision + 1,
                   updated_at_utc = @startedAtUtc
               WHERE id = @subjectId
                 AND agent_id = @agentId
                 AND status = 'pending'
                 AND attempt_count < max_attempts
                 AND revision = @expectedRevision
                 AND generation_epoch = @expectedEpoch`,
            )
            .run({
              startedAtUtc: input.startedAtUtc,
              subjectId: input.subject.id,
              agentId: input.subject.agentId,
              expectedRevision: input.subject.revision,
              expectedEpoch: input.subject.generationEpoch,
            });
    if (claimed.changes !== 1) return undefined;

    this.database
      .prepare(
        `INSERT INTO proactive_generation_runs(
          id, agent_id, source_kind, proactive_candidate_id,
          follow_up_intent_id, generation_epoch, claim_token, status,
          session_id, preflight_spec_version, preflight_state_revision,
          preflight_source_revision, preflight_message_rowid,
          preflight_last_user_message_rowid, preflight_user_arrival_epoch,
          snapshot_json, started_at_utc
        ) VALUES (
          @id, @agentId, @sourceKind, @candidateId, @followUpId,
          @generationEpoch, @claimToken, 'generating', @sessionId,
          @specVersion, @stateRevision, @sourceRevision, @messageRowid,
          @lastUserMessageRowid, @userArrivalEpoch, @snapshotJson,
          @startedAtUtc
        )`,
      )
      .run({
        id: input.runId,
        agentId: input.subject.agentId,
        sourceKind: input.subject.kind,
        candidateId:
          input.subject.kind === "activity_candidate" ? input.subject.id : null,
        followUpId:
          input.subject.kind === "follow_up" ? input.subject.id : null,
        generationEpoch: nextEpoch,
        claimToken: input.claimToken,
        sessionId: input.sessionId,
        specVersion: input.specVersion,
        stateRevision: input.stateRevision,
        sourceRevision: nextRevision,
        messageRowid: input.messageRowid,
        lastUserMessageRowid: input.lastUserMessageRowid,
        userArrivalEpoch: input.userArrivalEpoch,
        snapshotJson: JSON.stringify(input.snapshot),
        startedAtUtc: input.startedAtUtc,
      });
    this.insertDomainEvent({
      agentId: input.subject.agentId,
      streamType: "proactive",
      streamId: input.subject.id,
      eventType: "proactive.claimed",
      recordedAtUtc: input.startedAtUtc,
      payload: {
        runId: input.runId,
        sourceKind: input.subject.kind,
        sourceId: input.subject.id,
        generationEpoch: nextEpoch,
        claimToken: input.claimToken,
        triggerEventId:
          input.subject.kind === "activity_candidate"
            ? input.subject.triggerEventId
            : null,
        proactiveCandidateId:
          input.subject.kind === "activity_candidate" ? input.subject.id : null,
        followUpIntentId:
          input.subject.kind === "follow_up" ? input.subject.id : null,
      },
      correlationId: input.runId,
      causationId:
        input.subject.kind === "activity_candidate"
          ? input.subject.triggerEventId
          : input.subject.id,
      idempotencyKey: `proactive:${input.subject.id}:${nextEpoch}:claimed`,
    });
    const run = this.getRun(input.runId);
    const subject = this.getSubject({
      kind: input.subject.kind,
      id: input.subject.id,
    });
    if (run === undefined || subject === undefined) {
      throw new Error("Claimed generation could not be reloaded");
    }
    return { run, subject };
  }

  getRun(runId: string): StoredGenerationRun | undefined {
    const row = this.database
      .prepare("SELECT * FROM proactive_generation_runs WHERE id = ?")
      .get(runId) as SqlRow | undefined;
    return row === undefined ? undefined : mapGenerationRun(row);
  }

  discardGeneration(input: {
    runId: string;
    claimToken: string;
    reasonCode: string;
    completedAtUtc: string;
    generatedContent?: string;
  }): boolean {
    return this.finishWithoutCommit({
      ...input,
      status: "stale_discarded",
    });
  }

  failGeneration(input: {
    runId: string;
    claimToken: string;
    reasonCode: string;
    completedAtUtc: string;
  }): boolean {
    return this.finishWithoutCommit({
      ...input,
      status: "failed",
    });
  }

  isSourceClaimed(run: StoredGenerationRun): boolean {
    if (run.sourceKind === "activity_candidate") {
      return (
        this.database
          .prepare(
            `SELECT 1 FROM proactive_candidates
             WHERE id = ?
               AND status = 'pending'
               AND generation_epoch = ?
               AND claim_token = ?`,
          )
          .get(run.sourceId, run.generationEpoch, run.claimToken) !== undefined
      );
    }
    if (
      !new FollowUpRepository(this.database).isFollowUpEvidenceCurrent(
        run.sourceId,
      )
    )
      return false;
    return (
      this.database
        .prepare(
          `SELECT 1 FROM follow_up_intents
           WHERE id = ?
             AND status = 'pending'
             AND attempt_count < max_attempts
             AND generation_epoch = ?`,
        )
        .get(run.sourceId, run.generationEpoch) !== undefined
    );
  }

  commitGeneration(input: {
    run: StoredGenerationRun;
    subject: ProactiveSubjectRecord;
    messageId: string;
    content: string;
    completedAtUtc: string;
  }): StoredProactiveMessage {
    if (
      input.subject.kind === "follow_up" &&
      !new FollowUpRepository(this.database).isFollowUpEvidenceCurrent(
        input.subject.id,
      )
    ) {
      throw new Error("Follow-up evidence became invalid before delivery");
    }
    const triggerEventId =
      input.subject.kind === "activity_candidate"
        ? input.subject.triggerEventId
        : undefined;
    const followUpId =
      input.subject.kind === "follow_up" ? input.subject.id : undefined;
    const metadata = {
      proactiveGenerationRunId: input.run.id,
      claimToken: input.run.claimToken,
      sourceKind: input.subject.kind,
      sourceId: input.subject.id,
    };
    this.database
      .prepare(
        `INSERT INTO messages(
          id, session_id, agent_id, role, content, message_kind,
          trigger_event_id, metadata_json, created_at_utc,
          trigger_follow_up_intent_id
        ) VALUES (
          @id, @sessionId, @agentId, 'assistant', @content,
          'assistant_proactive', @triggerEventId, @metadataJson,
          @createdAtUtc, @followUpId
        )`,
      )
      .run({
        id: input.messageId,
        sessionId: input.run.sessionId,
        agentId: input.run.agentId,
        content: input.content,
        triggerEventId: triggerEventId ?? null,
        metadataJson: JSON.stringify(metadata),
        createdAtUtc: input.completedAtUtc,
        followUpId: followUpId ?? null,
      });

    const sourceUpdated =
      input.subject.kind === "activity_candidate"
        ? this.database
            .prepare(
              `UPDATE proactive_candidates
               SET status = 'sent',
                   sent_message_id = @messageId,
                   revision = revision + 1
               WHERE id = @sourceId
                 AND status = 'pending'
                 AND generation_epoch = @generationEpoch
                 AND revision = @sourceRevision
                 AND claim_token = @claimToken`,
            )
            .run({
              messageId: input.messageId,
              sourceId: input.subject.id,
              generationEpoch: input.run.generationEpoch,
              sourceRevision: input.run.preflightSourceRevision,
              claimToken: input.run.claimToken,
            })
        : this.database
            .prepare(
              `UPDATE follow_up_intents
               SET status = 'sent',
                   attempt_count = 1,
                   sent_message_id = @messageId,
                   revision = revision + 1,
                   updated_at_utc = @completedAtUtc
               WHERE id = @sourceId
                 AND status = 'pending'
                 AND attempt_count = 0
                 AND max_attempts = 1
                 AND generation_epoch = @generationEpoch
                 AND revision = @sourceRevision`,
            )
            .run({
              messageId: input.messageId,
              sourceId: input.subject.id,
              generationEpoch: input.run.generationEpoch,
              sourceRevision: input.run.preflightSourceRevision,
              completedAtUtc: input.completedAtUtc,
            });
    if (sourceUpdated.changes !== 1) {
      throw new Error("Proactive generation source became stale during commit");
    }

    const runUpdated = this.database
      .prepare(
        `UPDATE proactive_generation_runs
         SET status = 'committed',
             generated_content = @content,
             message_id = @messageId,
             completed_at_utc = @completedAtUtc
         WHERE id = @runId
           AND claim_token = @claimToken
           AND status = 'generating'`,
      )
      .run({
        content: input.content,
        messageId: input.messageId,
        completedAtUtc: input.completedAtUtc,
        runId: input.run.id,
        claimToken: input.run.claimToken,
      });
    if (runUpdated.changes !== 1) {
      throw new Error("Proactive generation run became stale during commit");
    }
    this.database
      .prepare("UPDATE sessions SET updated_at_utc = ? WHERE id = ?")
      .run(input.completedAtUtc, input.run.sessionId);
    this.insertDomainEvent({
      agentId: input.run.agentId,
      streamType: "conversation",
      streamId: input.run.sessionId,
      eventType: "conversation.proactive_message_sent",
      recordedAtUtc: input.completedAtUtc,
      payload: {
        messageId: input.messageId,
        triggerEventId: triggerEventId ?? null,
        proactiveCandidateId:
          input.subject.kind === "activity_candidate" ? input.subject.id : null,
        followUpIntentId: followUpId ?? null,
        proactiveGenerationRunId: input.run.id,
        sourceKind: input.subject.kind,
        sourceId: input.subject.id,
      },
      correlationId: input.run.id,
      causationId: input.subject.id,
      idempotencyKey: `proactive:${input.subject.id}:${input.run.generationEpoch}:sent`,
    });
    return {
      id: input.messageId,
      sessionId: input.run.sessionId,
      agentId: input.run.agentId,
      content: input.content,
      metadata,
      createdAtUtc: input.completedAtUtc,
      ...(triggerEventId === undefined ? {} : { triggerEventId }),
      ...(followUpId === undefined
        ? {}
        : { triggerFollowUpIntentId: followUpId }),
    };
  }

  private insertDomainEvent(input: {
    agentId: string;
    streamType: string;
    streamId: string;
    eventType: string;
    recordedAtUtc: string;
    payload: Record<string, unknown>;
    correlationId: string;
    causationId: string;
    idempotencyKey: string;
  }): void {
    const version = this.database
      .prepare(
        `SELECT COALESCE(MAX(stream_version), 0) + 1 AS next_version
         FROM domain_events
         WHERE stream_type = ? AND stream_id = ?`,
      )
      .get(input.streamType, input.streamId) as { next_version: number };
    const inserted = this.database
      .prepare(
        `INSERT OR IGNORE INTO domain_events(
          id, agent_id, stream_type, stream_id, stream_version, event_type,
          recorded_at_utc, effective_at_utc, payload_json, correlation_id,
          causation_id, idempotency_key
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createEntityId("event"),
        input.agentId,
        input.streamType,
        input.streamId,
        Number(version.next_version),
        input.eventType,
        input.recordedAtUtc,
        input.recordedAtUtc,
        JSON.stringify(input.payload),
        input.correlationId,
        input.causationId,
        input.idempotencyKey,
      );
    if (inserted.changes !== 1) {
      throw new Error(
        `Duplicate proactive audit event: ${input.idempotencyKey}`,
      );
    }
  }

  private finishWithoutCommit(input: {
    runId: string;
    claimToken: string;
    status: "stale_discarded" | "failed";
    reasonCode: string;
    completedAtUtc: string;
    generatedContent?: string;
  }): boolean {
    const run = this.getRun(input.runId);
    if (
      run === undefined ||
      run.claimToken !== input.claimToken ||
      run.status !== "generating"
    ) {
      return false;
    }
    const result = this.database
      .prepare(
        `UPDATE proactive_generation_runs
         SET status = @status,
             reason_code = @reasonCode,
             generated_content = @generatedContent,
             completed_at_utc = @completedAtUtc
         WHERE id = @runId
           AND claim_token = @claimToken
           AND status = 'generating'`,
      )
      .run({
        ...input,
        generatedContent: input.generatedContent ?? null,
      });
    if (result.changes !== 1) return false;
    if (run.sourceKind === "activity_candidate") {
      this.database
        .prepare(
          `UPDATE proactive_candidates
           SET claim_token = NULL, claimed_at_utc = NULL
           WHERE id = ?
             AND generation_epoch = ?
             AND claim_token = ?
             AND status = 'pending'`,
        )
        .run(run.sourceId, run.generationEpoch, run.claimToken);
    }
    return true;
  }
}

function mapActivitySubject(row: SqlRow): ProactiveSubjectRecord {
  const draftMessage = nullableString(row["draft_message"]);
  return {
    kind: "activity_candidate",
    id: String(row["id"]),
    agentId: String(row["agent_id"]),
    status: String(row["status"]),
    earliestAtUtc: String(row["earliest_at_utc"]),
    expiresAtUtc: String(row["expires_at_utc"]),
    alreadyDiscussed: Number(row["already_discussed"]) !== 0,
    revision: Number(row["revision"]),
    generationEpoch: Number(row["generation_epoch"]),
    priority: Number(row["priority"]),
    triggerEventId: String(row["trigger_event_id"]),
    summary: String(row["summary"]),
    ...(draftMessage === undefined ? {} : { draftMessage }),
  };
}

function mapFollowUpSubject(row: SqlRow): ProactiveSubjectRecord {
  return {
    kind: "follow_up",
    id: String(row["id"]),
    agentId: String(row["agent_id"]),
    status: String(row["status"]),
    earliestAtUtc: String(row["earliest_at_utc"]),
    expiresAtUtc: String(row["expires_at_utc"]),
    alreadyDiscussed: Number(row["already_discussed"]) !== 0,
    attemptCount: Number(row["attempt_count"]),
    maxAttempts: 1,
    revision: Number(row["revision"]),
    generationEpoch: Number(row["generation_epoch"]),
    contextSummary: String(row["context_summary"]),
    expectedOutcomeDescription: String(row["expected_outcome_description"]),
  };
}

function mapGenerationRun(row: SqlRow): StoredGenerationRun {
  const candidateId = nullableString(row["proactive_candidate_id"]);
  const followUpId = nullableString(row["follow_up_intent_id"]);
  const generatedContent = nullableString(row["generated_content"]);
  const messageId = nullableString(row["message_id"]);
  const reasonCode = nullableString(row["reason_code"]);
  const completedAtUtc = nullableString(row["completed_at_utc"]);
  const sourceKind = parseSourceKind(row["source_kind"]);
  const sourceId =
    sourceKind === "activity_candidate" ? candidateId : followUpId;
  if (sourceId === undefined)
    throw new Error("Generation run source is missing");
  return {
    id: String(row["id"]),
    agentId: String(row["agent_id"]),
    sourceKind,
    sourceId,
    generationEpoch: Number(row["generation_epoch"]),
    claimToken: String(row["claim_token"]),
    status: parseRunStatus(row["status"]),
    sessionId: String(row["session_id"]),
    preflightSpecVersion: Number(row["preflight_spec_version"]),
    preflightStateRevision: Number(row["preflight_state_revision"]),
    preflightSourceRevision: Number(row["preflight_source_revision"]),
    preflightMessageRowid: Number(row["preflight_message_rowid"]),
    preflightLastUserMessageRowid: Number(
      row["preflight_last_user_message_rowid"],
    ),
    preflightUserArrivalEpoch: Number(row["preflight_user_arrival_epoch"]),
    snapshot: parseSnapshot(row["snapshot_json"]),
    startedAtUtc: String(row["started_at_utc"]),
    ...(generatedContent === undefined ? {} : { generatedContent }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(reasonCode === undefined ? {} : { reasonCode }),
    ...(completedAtUtc === undefined ? {} : { completedAtUtc }),
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

function parseSourceKind(value: unknown): ProactiveSubjectRef["kind"] {
  if (value === "activity_candidate" || value === "follow_up") return value;
  throw new Error("Unknown generation source kind: " + String(value));
}

function parseRunStatus(value: unknown): GenerationRunStatus {
  if (
    value === "generating" ||
    value === "committed" ||
    value === "stale_discarded" ||
    value === "failed"
  ) {
    return value;
  }
  throw new Error("Unknown generation status: " + String(value));
}

function parseSnapshot(value: unknown): Record<string, unknown> {
  const parsed: unknown = JSON.parse(String(value));
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : {};
}
