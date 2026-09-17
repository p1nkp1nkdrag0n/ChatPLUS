import { UtcDateTimeSchema, type TemporalTask } from "@personasim/contracts";
import { DateTime } from "luxon";

import type { DatabaseStore } from "../db/store.js";
import type { Clock } from "../runtime/clock.js";
import type { ProactiveDeliveryService } from "./proactive-delivery-service.js";
import type { ProactiveTaskRepository } from "./proactive-task-repository.js";

const TERMINAL_REASONS = new Set([
  "source_not_pending",
  "source_expired",
  "subject_not_found",
  "subject_agent_mismatch",
  "agent_state_missing",
  "session_mismatch",
  "max_attempts_reached",
  "already_discussed",
  "no_delivery_subject",
  "follow_up_evidence_invalid",
  "source_evidence_invalid",
]);

/** Claims a persisted evaluation, then executes outside any database transaction. */
export class ProactiveTaskService {
  constructor(
    private readonly repository: ProactiveTaskRepository,
    private readonly delivery: ProactiveDeliveryService,
    private readonly store: DatabaseStore,
    private readonly clock: Clock,
  ) {}

  async catchUpAgent(
    agentId: string,
    observedNowUtc = this.clock.nowUtc(),
  ): Promise<void> {
    if (this.repository.mode === "off") return;
    this.repository.synchronize(observedNowUtc);
    const task = this.repository.claimNext(agentId, observedNowUtc);
    if (task === undefined) return;
    const expiresAtUtc = taskExpiry(task);
    if (expiresAtUtc <= observedNowUtc || !this.repository.isCurrent(task)) {
      this.repository.finish(task, {
        nowUtc: observedNowUtc,
        outcome: "suppressed",
        reasonCode:
          expiresAtUtc <= observedNowUtc
            ? "source_expired"
            : "source_changed_or_closed",
        terminal: true,
      });
      return;
    }
    try {
      const subject = this.repository.source(task);
      if (this.repository.mode === "shadow") {
        const decision = this.delivery.inspect(agentId, subject);
        if (decision.allowed) {
          this.repository.finish(task, {
            nowUtc: this.clock.nowUtc(),
            outcome: "shadow_eligible",
          });
        } else {
          this.defer(
            task,
            decision.reasonCode ?? "shadow_ineligible",
            "shadow_suppressed",
          );
        }
        return;
      }
      const outcome = await this.delivery.deliverNext(agentId, subject);
      if (outcome.status === "committed" || outcome.status === "skipped") {
        this.repository.finish(task, {
          nowUtc: this.clock.nowUtc(),
          outcome: outcome.status,
          ...(outcome.status === "skipped"
            ? { reasonCode: outcome.reasonCode }
            : {}),
        });
      } else {
        this.defer(task, outcome.reasonCode, outcome.status);
      }
    } catch {
      this.defer(task, "proactive_execution_failed", "failed");
    }
  }

  private defer(task: TemporalTask, reasonCode: string, outcome: string): void {
    const nowUtc = this.clock.nowUtc();
    const nextEvaluationAtUtc = this.nextEvaluation(
      task.agentId,
      reasonCode,
      task.attempt,
      nowUtc,
    );
    const exhausted =
      task.attempt >= task.maxAttempts ||
      (outcome === "failed" &&
        this.repository.failedExecutionCount(task.id) + 1 >= 3);
    const terminal =
      exhausted ||
      TERMINAL_REASONS.has(reasonCode) ||
      nextEvaluationAtUtc >= taskExpiry(task);
    this.repository.finish(task, {
      nowUtc,
      outcome: terminal ? "suppressed" : outcome,
      reasonCode: exhausted ? "proactive_attempts_exhausted" : reasonCode,
      ...(terminal ? { terminal: true } : { nextEvaluationAtUtc }),
    });
  }

  private nextEvaluation(
    agentId: string,
    reason: string,
    attempt: number,
    nowUtc: string,
  ): string {
    const spec = this.store.getCharacterSpec(agentId);
    const now = DateTime.fromISO(nowUtc, { setZone: true });
    const local = now.setZone(spec?.identity.timezone ?? "UTC");
    if (reason === "user_daily_cap_reached") {
      const oldest = this.store.database
        .prepare(
          `SELECT MIN(created_at_utc) AS created_at_utc FROM messages
         WHERE message_kind = 'assistant_proactive' AND created_at_utc > ?`,
        )
        .get(now.minus({ hours: 24 }).toUTC().toISO()) as {
        created_at_utc: string | null;
      };
      if (oldest.created_at_utc !== null) {
        return DateTime.fromISO(oldest.created_at_utc, { setZone: true })
          .plus({ hours: 24, seconds: 1 })
          .toUTC()
          .toISO()!;
      }
    }
    if (reason === "daily_cap_reached") {
      return local.plus({ days: 1 }).startOf("day").toUTC().toISO()!;
    }
    if (reason === "quiet_hours" && spec !== undefined) {
      const [hour, minute] = spec.proactivePolicy.quietHours.endLocal
        .split(":")
        .map(Number);
      let end = local.set({
        hour: hour!,
        minute: minute!,
        second: 0,
        millisecond: 0,
      });
      if (end <= local) end = end.plus({ days: 1 });
      return end.toUTC().toISO()!;
    }
    if (reason === "cooldown_active") {
      const until = this.delivery.loadPolicy(agentId, nowUtc).cooldownUntilUtc;
      if (until !== undefined && until > nowUtc) return until;
    }
    const minutes =
      reason === "active_conversation" ||
      reason === "user_returned" ||
      reason === "new_message_arrived"
        ? 2
        : reason === "user_cooldown_active" ||
            reason === "generation_in_progress"
          ? 30
          : reason === "unanswered_limit_reached" ||
              reason === "relationship_below_minimum" ||
              reason === "policy_disabled" ||
              reason === "tier_not_supported" ||
              reason === "no_session"
            ? 120
            : Math.min(60, 5 * 2 ** Math.min(attempt - 1, 4));
    return now.plus({ minutes }).toUTC().toISO()!;
  }
}

function taskExpiry(task: TemporalTask): string {
  const parsed = UtcDateTimeSchema.safeParse(task.payload.expiresAtUtc);
  // Corrupt or legacy missing payloads fail closed instead of being retried.
  return parsed.success ? parsed.data : "1970-01-01T00:00:00.000Z";
}
