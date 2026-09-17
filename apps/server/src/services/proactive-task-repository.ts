import type { TemporalTask, TemporalTaskKind } from "@personasim/contracts";
import { createHash } from "node:crypto";

import type { Database } from "../db/connection.js";
import { createEntityId } from "../domain/id.js";
import { CorrespondenceRepository } from "../repositories/correspondence-repository.js";
import type { ProactiveSubjectRef } from "./proactive-generation-repository.js";

export type ProactiveMode = "off" | "shadow" | "on";
export const PROACTIVE_TASK_KINDS = [
  "proactive.follow_up",
  "proactive.activity_review",
] as const satisfies readonly TemporalTaskKind[];

interface SourceRow {
  id: string;
  agent_id: string;
  source_kind: ProactiveSubjectRef["kind"];
  revision: number;
  earliest_at_utc: string;
  expires_at_utc: string;
  semantic_content: string;
}

/** A durable projection of source intent revisions, independent of SSE presence. */
export class ProactiveTaskRepository {
  private readonly tasks: CorrespondenceRepository;
  private lastDiscoveryAtUtc: string | undefined;

  constructor(
    readonly database: Database,
    readonly mode: ProactiveMode,
    private readonly discover?: (agentId: string, nowUtc: string) => void,
  ) {
    this.tasks = new CorrespondenceRepository(database);
  }

  synchronize(nowUtc: string): void {
    if (this.mode === "off") return;
    // Advance each offline character once per scan instant, not once per task.
    // The normal life reducer creates only evidence-backed activity candidates.
    if (this.lastDiscoveryAtUtc !== nowUtc) {
      this.lastDiscoveryAtUtc = nowUtc;
      const agents = this.database
        .prepare(
          "SELECT id FROM characters WHERE status = 'published' AND tier = 'high_fidelity' ORDER BY id",
        )
        .all() as Array<{ id: string }>;
      for (const agent of agents) this.discover?.(agent.id, nowUtc);
    }
    this.database
      .transaction(() => {
        // Persist the freshness deadline on the source too, so a provider
        // response crossing this boundary is rejected by generation postflight.
        this.database
          .prepare(
            `UPDATE follow_up_intents SET
             expires_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', earliest_at_utc, '+48 hours'),
             revision = revision + 1, updated_at_utc = ?
           WHERE status = 'pending' AND expires_at_utc >
             strftime('%Y-%m-%dT%H:%M:%fZ', earliest_at_utc, '+48 hours')`,
          )
          .run(nowUtc);
        this.database
          .prepare(
            `UPDATE proactive_candidates SET
             expires_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', created_at_utc, '+6 hours'),
             revision = revision + 1
           WHERE status = 'pending' AND expires_at_utc >
             strftime('%Y-%m-%dT%H:%M:%fZ', created_at_utc, '+6 hours')`,
          )
          .run();
        this.database
          .prepare(
            `UPDATE follow_up_intents SET status = 'expired', revision = revision + 1,
           updated_at_utc = ? WHERE status = 'pending' AND expires_at_utc <= ?`,
          )
          .run(nowUtc, nowUtc);
        this.database
          .prepare(
            `UPDATE proactive_candidates SET status = 'expired', revision = revision + 1
         WHERE status = 'pending' AND expires_at_utc <= ?`,
          )
          .run(nowUtc);
        for (const source of this.pendingSources()) {
          // A missed activity share becomes stale after six hours. A follow-up
          // may survive a short outage, but never replays after a two-day gap.
          const maxAgeMs =
            source.source_kind === "follow_up" ? 48 * 3_600_000 : 6 * 3_600_000;
          const expiresAtUtc = new Date(
            Math.min(
              Date.parse(source.expires_at_utc),
              Date.parse(source.earliest_at_utc) + maxAgeMs,
            ),
          ).toISOString();
          const sourceFingerprint = fingerprint(source);
          const key = `proactive:${this.mode}:${source.source_kind}:${source.id}:${sourceFingerprint}`;
          if (this.tasks.getTaskByIdempotencyKey(key) !== undefined) continue;
          this.tasks.createTemporalTask({
            agentId: source.agent_id,
            entityId: source.id,
            kind:
              source.source_kind === "follow_up"
                ? "proactive.follow_up"
                : "proactive.activity_review",
            dueAtUtc: source.earliest_at_utc,
            priority: source.source_kind === "follow_up" ? 10 : 20,
            maxAttempts: 64,
            idempotencyKey: key,
            createdAtUtc: nowUtc,
            payload: {
              mode: this.mode,
              sourceKind: source.source_kind,
              sourceRevision: source.revision,
              sourceFingerprint,
              expiresAtUtc,
            },
          });
        }
      })
      .immediate();
  }

  findNextTemporalTask(
    nowUtc: string,
    _kinds?: readonly TemporalTaskKind[],
    excludedAgentIds: readonly string[] = [],
  ): TemporalTask | undefined {
    if (this.mode === "off") return undefined;
    this.synchronize(nowUtc);
    const exclusions =
      excludedAgentIds.length === 0
        ? ""
        : `AND agent_id NOT IN (${excludedAgentIds.map(() => "?").join(",")})`;
    const row = this.database
      .prepare(
        `SELECT id FROM temporal_tasks
       WHERE kind IN ('proactive.follow_up', 'proactive.activity_review')
         AND json_extract(payload_json, '$.mode') = ?
         AND status IN ('pending', 'retryable', 'claimed') ${exclusions}
       ORDER BY CASE WHEN status = 'claimed' AND lease_expires_at_utc > ?
         THEN lease_expires_at_utc ELSE due_at_utc END, priority, due_at_utc, id LIMIT 1`,
      )
      .get(this.mode, ...excludedAgentIds, nowUtc) as
      { id: string } | undefined;
    return row === undefined ? undefined : this.tasks.getTask(row.id);
  }

  claimNext(agentId: string, nowUtc: string): TemporalTask | undefined {
    if (this.mode === "off") return undefined;
    const row = this.database
      .prepare(
        `SELECT id FROM temporal_tasks WHERE agent_id = ?
       AND kind IN ('proactive.follow_up', 'proactive.activity_review')
       AND json_extract(payload_json, '$.mode') = ? AND due_at_utc <= ?
       AND (status IN ('pending', 'retryable') OR
         (status = 'claimed' AND lease_expires_at_utc <= ?))
       ORDER BY priority, due_at_utc, id LIMIT 1`,
      )
      .get(agentId, this.mode, nowUtc, nowUtc) as { id: string } | undefined;
    if (row === undefined) return undefined;
    return this.tasks.claimDueTask({
      taskId: row.id,
      agentId,
      kinds: PROACTIVE_TASK_KINDS,
      nowUtc,
      claimToken: createEntityId("proactive_task_claim"),
      // Matches the generation service's bounded provider retry envelope.
      leaseExpiresAtUtc: new Date(
        Date.parse(nowUtc) + 30 * 60_000,
      ).toISOString(),
    });
  }

  source(task: TemporalTask): ProactiveSubjectRef {
    return {
      kind:
        task.kind === "proactive.follow_up"
          ? "follow_up"
          : "activity_candidate",
      id: task.entityId,
    };
  }

  failedExecutionCount(taskId: string): number {
    const row = this.database
      .prepare(
        "SELECT COUNT(*) AS count FROM proactive_task_evaluations WHERE task_id = ? AND outcome = 'failed'",
      )
      .get(taskId) as { count: number };
    return row.count;
  }

  isCurrent(task: TemporalTask): boolean {
    return this.pendingSources(task.agentId).some(
      (source) =>
        source.id === task.entityId &&
        source.source_kind === this.source(task).kind &&
        fingerprint(source) === task.payload.sourceFingerprint,
    );
  }

  finish(
    task: TemporalTask,
    input: {
      nowUtc: string;
      outcome: string;
      reasonCode?: string;
      nextEvaluationAtUtc?: string;
      terminal?: boolean;
    },
  ): void {
    this.database
      .transaction(() => {
        // Late work from a worker whose lease was replaced cannot overwrite
        // the new owner's durable schedule or audit outcome.
        const current = this.tasks.getTask(task.id);
        if (
          current?.claimToken !== task.claimToken ||
          current?.status !== "claimed"
        )
          return;
        if (
          input.nextEvaluationAtUtc !== undefined ||
          input.terminal === true
        ) {
          this.tasks.retryTask({
            taskId: task.id,
            claimToken: task.claimToken!,
            nowUtc: input.nowUtc,
            errorCode: input.reasonCode ?? "proactive_deferred",
            ...(input.nextEvaluationAtUtc === undefined
              ? {}
              : { nextDueAtUtc: input.nextEvaluationAtUtc }),
            retryable: input.terminal !== true,
          });
        } else {
          this.tasks.completeTask({
            taskId: task.id,
            claimToken: task.claimToken!,
            completedAtUtc: input.nowUtc,
          });
        }
        this.database
          .prepare(
            `INSERT INTO proactive_task_evaluations(task_id, attempt, mode, outcome,
           reason_code, evaluated_at_utc, next_evaluation_at_utc)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            task.id,
            task.attempt,
            this.mode,
            input.outcome,
            input.reasonCode ?? null,
            input.nowUtc,
            input.nextEvaluationAtUtc ?? null,
          );
      })
      .immediate();
  }

  private pendingSources(agentId?: string): SourceRow[] {
    return this.database
      .prepare(
        `SELECT source.* FROM (
         SELECT id, agent_id, 'follow_up' AS source_kind, revision, earliest_at_utc, expires_at_utc,
           json_array(context_summary, expected_outcome_description, grounding_json) AS semantic_content
         FROM follow_up_intents WHERE status = 'pending'
         UNION ALL
         SELECT id, agent_id, 'activity_candidate' AS source_kind, revision, earliest_at_utc, expires_at_utc,
           json_array(summary, intent, trigger_event_id) AS semantic_content
         FROM proactive_candidates WHERE status = 'pending'
       ) source JOIN characters ON characters.id = source.agent_id
       WHERE characters.status = 'published' ${agentId === undefined ? "" : "AND source.agent_id = ?"}
         AND NOT EXISTS (SELECT 1 FROM proactive_intent_decisions decision
           WHERE decision.source_kind = source.source_kind AND decision.source_id = source.id
             AND decision.source_revision = source.revision)
       ORDER BY source.earliest_at_utc, source.id`,
      )
      .all(...(agentId === undefined ? [] : [agentId])) as SourceRow[];
  }
}

function fingerprint(source: SourceRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        source.earliest_at_utc,
        source.expires_at_utc,
        source.semantic_content,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}
