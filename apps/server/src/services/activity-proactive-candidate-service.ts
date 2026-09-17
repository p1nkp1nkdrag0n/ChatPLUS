import type { DailyLifeIntent, LifeOutcome } from "@personasim/contracts";
import {
  createCompletedActivityCandidate,
  normalizeText,
  projectCharacterTime,
  stableId,
  type CreateCompletedActivityCandidateInput,
  type ProactiveCandidateLike,
} from "@personasim/features";
import { DateTime } from "luxon";

import type { DatabaseStore, StoredActivityEvent } from "../db/store.js";
import type { CharacterSpec, ScheduleItem } from "../domain/schemas.js";

/** Stores factual material only. The delivery service composes text at send time. */
export function persistActivityProactiveCandidate(input: {
  store: DatabaseStore;
  spec: CharacterSpec;
  source: CreateCompletedActivityCandidateInput["source"];
  nowUtc: string;
  userRelevance?: number;
  eventProjection?: StoredActivityEvent;
}): boolean {
  const { store, spec, source, nowUtc } = input;
  if (spec.status !== "published") return false;
  const state = store.getRuntimeState(spec.id);
  if (state === undefined) return false;
  const topicKey = `${spec.id}:${normalizeText(source.category)}:${normalizeText(source.title)}`;
  const rows = store.database
    .prepare(
      `SELECT pc.*, m.created_at_utc AS sent_at_utc
     FROM proactive_candidates pc
     LEFT JOIN messages m ON m.id = pc.sent_message_id
     WHERE pc.agent_id = ? AND (pc.trigger_event_id = ? OR
       (pc.cooldown_key = ? AND pc.status IN ('pending', 'sent')))`,
    )
    .all(spec.id, source.id, topicKey) as Array<{
    id: string;
    trigger_event_id: string;
    status: ProactiveCandidateLike["status"];
    summary: string;
    priority: number;
    earliest_at_utc: string;
    expires_at_utc: string;
    cooldown_key: string;
    created_at_utc: string;
    sent_at_utc: string | null;
    revision: number;
  }>;
  const candidate = createCompletedActivityCandidate({
    tier: spec.tier,
    agentId: spec.id,
    source,
    policy: spec.proactivePolicy,
    relationshipCloseness: state.relationship.closeness,
    nowUtc,
    ttlHours: 6,
    topicCooldownHours: 24,
    ...(input.userRelevance === undefined
      ? {}
      : { userRelevance: input.userRelevance }),
    existingCandidates: rows.map((row) => ({
      id: row.id,
      agentId: spec.id,
      activityEventId: row.trigger_event_id,
      category: source.category,
      status: row.status,
      summary: row.summary,
      importance: row.priority,
      earliestSendAtUtc: row.earliest_at_utc,
      expiresAtUtc: row.expires_at_utc,
      dedupeKey: row.cooldown_key,
      createdAtUtc: row.created_at_utc,
      updatedAtUtc: row.sent_at_utc ?? row.created_at_utc,
      revision: row.revision,
    })),
  });
  if (candidate === undefined) return false;
  return store.transaction(() => {
    if (input.eventProjection !== undefined)
      store.insertActivityEvent(input.eventProjection);
    return (
      store.database
        .prepare(
          `INSERT OR IGNORE INTO proactive_candidates(
        id, agent_id, trigger_event_id, intent, summary, draft_message,
        earliest_at_utc, expires_at_utc, priority, cooldown_key, status, created_at_utc
      ) SELECT ?, ?, ?, 'share_experience', ?, NULL, ?, ?, ?, ?, 'pending', ?
      WHERE NOT EXISTS (
        SELECT 1 FROM proactive_candidates WHERE agent_id = ? AND trigger_event_id = ?
      )`,
        )
        .run(
          candidate.id,
          spec.id,
          source.id,
          candidate.summary,
          candidate.earliestSendAtUtc,
          candidate.expiresAtUtc,
          candidate.importance,
          candidate.dedupeKey,
          nowUtc,
          spec.id,
          source.id,
        ).changes > 0
    );
  });
}

export function persistSettledActivityCandidate(input: {
  store: DatabaseStore;
  spec: CharacterSpec;
  item: ScheduleItem;
  event: StoredActivityEvent;
  nowUtc: string;
}): boolean {
  return persistActivityProactiveCandidate({
    store: input.store,
    spec: input.spec,
    nowUtc: input.nowUtc,
    ...(input.item.source === "user_invitation" ? { userRelevance: 1 } : {}),
    source: {
      id: input.event.id,
      agentId: input.event.agentId,
      completed: input.event.eventType === "completed",
      title: input.item.title,
      category: input.item.category,
      summary: input.event.summary,
      shareable: input.item.shareable,
      narrativeImportance: input.item.narrativeImportance,
      recordedAtUtc: input.event.occurredAtUtc,
    },
  });
}

/** Compatibility event preserves the settled life's precision and evidence. */
export function persistFuzzyLifeActivityCandidate(input: {
  store: DatabaseStore;
  spec: CharacterSpec;
  intent: DailyLifeIntent;
  outcome: LifeOutcome;
  nowUtc: string;
}): boolean {
  const { store, spec, intent, outcome, nowUtc } = input;
  if (
    outcome.outcomeKind !== "completed" ||
    outcome.sourceEvidenceIds.length === 0 ||
    outcome.agentId !== spec.id ||
    intent.agentId !== spec.id ||
    outcome.intentId !== intent.id
  )
    return false;
  // Reconnecting after a long absence must not queue old life results as fresh news.
  const localDate = projectCharacterTime(spec.identity, nowUtc).localDate;
  const ageDays = DateTime.fromISO(localDate).diff(
    DateTime.fromISO(outcome.effectiveLocalDate),
    "days",
  ).days;
  if (ageDays < 0 || ageDays > 1) return false;
  const eventId = stableId("life_activity", `${spec.id}:${outcome.id}`);
  const summary = `${outcome.effectiveLocalDate}（${outcome.temporalPrecision === "day" ? "当天" : outcome.effectivePeriod}）：${outcome.summary}`;
  const event: StoredActivityEvent = {
    id: eventId,
    agentId: spec.id,
    eventType: "completed",
    occurredAtUtc: outcome.recordedAtUtc,
    summary,
    outcomeFacts: outcome.outcomeFacts,
    stateDelta: {},
    origin:
      outcome.origin === "simulation" ? "seeded_probability" : "deterministic",
    effectTrace: {
      source: "fuzzy_life_outcome",
      lifeOutcomeId: outcome.id,
      lifeIntentId: intent.id,
      sourceEvidenceIds: outcome.sourceEvidenceIds,
      origin: outcome.origin,
      effectiveLocalDate: outcome.effectiveLocalDate,
      temporalPrecision: outcome.temporalPrecision,
      ...(outcome.effectivePeriod === undefined
        ? {}
        : { effectivePeriod: outcome.effectivePeriod }),
      occurredAtIsAuditTimestamp: true,
    },
    idempotencyKey: `life-activity:${spec.id}:${outcome.id}`,
  };
  return persistActivityProactiveCandidate({
    store,
    spec,
    nowUtc,
    eventProjection: event,
    ...(intent.evidenceMessageIds.length > 0 ? { userRelevance: 1 } : {}),
    source: {
      id: eventId,
      agentId: spec.id,
      completed: true,
      title: intent.title,
      category: intent.domain,
      summary,
      shareable: intent.shareable,
      narrativeImportance: outcome.importance,
      recordedAtUtc: outcome.recordedAtUtc,
    },
  });
}
