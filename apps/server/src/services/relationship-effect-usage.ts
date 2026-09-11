import { DateTime } from "luxon";
import type { RelationshipDailyUsage } from "@personasim/features";
import type { DatabaseStore } from "../db/store.js";

export const RELATIONSHIP_BASELINE_COOLDOWN_SECONDS = 60;

/** Chat and activity settlement share this persisted local-day net budget. */
export function loadDailyRelationshipUsage(
  store: DatabaseStore,
  agentId: string,
  timezone: string,
  atUtc: string,
): RelationshipDailyUsage {
  const { fromUtc, toUtc } = localDayBounds(timezone, atUtc);
  const usage = { closeness: 0, baselineCloseness: 0 };
  const rows = store.database
    .prepare(
      `
    SELECT payload_json AS json FROM domain_events
    WHERE agent_id = ? AND effective_at_utc >= ? AND effective_at_utc < ?
      AND event_type IN ('conversation.world_effects_committed', 'conversation.world_effects_shadow_evaluated')
    UNION ALL
    SELECT event_json AS json FROM activity_events
    WHERE agent_id = ? AND occurred_at_utc >= ? AND occurred_at_utc < ?
  `,
    )
    .all(agentId, fromUtc, toUtc, agentId, fromUtc, toUtc) as Array<{
    json: string;
  }>;
  for (const row of rows) {
    const delta = parseRelationshipUsage(row.json);
    usage.closeness += delta.closeness ?? 0;
    usage.baselineCloseness += delta.baselineCloseness ?? 0;
  }
  return {
    closeness: stable(usage.closeness),
    baselineCloseness: stable(usage.baselineCloseness),
  };
}

export type RelationshipEvidenceKind =
  | "neutral"
  | "rupture_or_boundary"
  | "temporary_boundary"
  | "unconfirmed_repair"
  | "explicit_repair";

export type RelationshipBaselineEligibility = {
  eligible: boolean;
  reason:
    | "eligible"
    | "fallback"
    | "rupture_or_boundary"
    | "temporary_boundary"
    | "unconfirmed_repair"
    | "explicit_repair"
    | "empty_or_repetitive"
    | "duplicate_content"
    | "cooldown";
};

/** Successful delivery is checked by the caller. Repeated content and rapid
 * reward claims are checked across all sessions and survive server restarts. */
export function relationshipBaselineEligibility(input: {
  store: DatabaseStore;
  agentId: string;
  timezone: string;
  atUtc: string;
  userText: string;
  usedFallback: boolean;
  evidence: RelationshipEvidenceKind;
}): RelationshipBaselineEligibility {
  if (input.usedFallback) return { eligible: false, reason: "fallback" };
  if (input.evidence !== "neutral")
    return { eligible: false, reason: input.evidence };
  const normalized = normalizeInteractionText(input.userText);
  if (Array.from(normalized).length < 2 || /^(.)\1+$/u.test(normalized))
    return { eligible: false, reason: "empty_or_repetitive" };
  const { fromUtc, toUtc } = localDayBounds(input.timezone, input.atUtc);
  const messages = input.store.database
    .prepare(
      `SELECT content FROM messages
    WHERE agent_id = ? AND role = 'user' AND message_kind = 'user'
      AND created_at_utc >= ? AND created_at_utc < ?`,
    )
    .all(input.agentId, fromUtc, toUtc) as Array<{ content: string }>;
  if (
    messages.some(
      ({ content }) => normalizeInteractionText(content) === normalized,
    )
  )
    return { eligible: false, reason: "duplicate_content" };
  const recent = input.store.database
    .prepare(
      `SELECT effective_at_utc AS atUtc, payload_json AS json FROM domain_events
    WHERE agent_id = ? AND effective_at_utc >= ? AND effective_at_utc <= ?
      AND event_type IN ('conversation.world_effects_committed', 'conversation.world_effects_shadow_evaluated')
    ORDER BY effective_at_utc DESC`,
    )
    .all(input.agentId, fromUtc, input.atUtc) as Array<{
    atUtc: string;
    json: string;
  }>;
  const lastAward = recent.find(
    ({ json }) => (parseRelationshipUsage(json).baselineCloseness ?? 0) > 0,
  );
  if (
    lastAward !== undefined &&
    Date.parse(input.atUtc) - Date.parse(lastAward.atUtc) <
      RELATIONSHIP_BASELINE_COOLDOWN_SECONDS * 1000
  )
    return { eligible: false, reason: "cooldown" };
  return { eligible: true, reason: "eligible" };
}

function normalizeInteractionText(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

function parseRelationshipUsage(json: string): RelationshipDailyUsage {
  try {
    const payload: unknown = JSON.parse(json);
    if (!isRecord(payload)) return {};
    const effectTrace = isRecord(payload.effectTrace)
      ? payload.effectTrace
      : undefined;
    const relationship = isRecord(payload.relationship)
      ? payload.relationship
      : effectTrace !== undefined && isRecord(effectTrace.relationship)
        ? effectTrace.relationship
        : undefined;
    if (
      relationship !== undefined &&
      (isRecord(relationship.baselineDelta) ||
        isRecord(relationship.appliedProposalDelta))
    ) {
      const baseline = isRecord(relationship.baselineDelta)
        ? finite(relationship.baselineDelta.closeness)
        : 0;
      const proposed = isRecord(relationship.appliedProposalDelta)
        ? finite(relationship.appliedProposalDelta.closeness)
        : 0;
      return {
        closeness: baseline + proposed,
        baselineCloseness: Math.max(0, baseline),
      };
    }
    // Generic audit summaries may not retain the split trace. Only closeness
    // is a relationship value; budget metadata is read if explicitly present.
    const applied = isRecord(payload.applied) ? payload.applied : undefined;
    const delta =
      applied !== undefined && isRecord(applied.relationshipDelta)
        ? applied.relationshipDelta
        : undefined;
    if (delta !== undefined) return { closeness: finite(delta.closeness) };
    const usage =
      effectTrace !== undefined &&
      isRecord(effectTrace.relationshipDailyUsageApplied)
        ? effectTrace.relationshipDailyUsageApplied
        : isRecord(payload.relationshipDailyUsageApplied)
          ? payload.relationshipDailyUsageApplied
          : undefined;
    return usage === undefined
      ? {}
      : {
          closeness: finite(usage.closeness),
          baselineCloseness: Math.max(0, finite(usage.baselineCloseness)),
        };
  } catch {
    return {};
  }
}

function localDayBounds(
  timezone: string,
  atUtc: string,
): { fromUtc: string; toUtc: string } {
  const instant = DateTime.fromISO(atUtc, { setZone: true });
  if (!instant.isValid) throw new RangeError(`Invalid UTC instant: ${atUtc}`);
  const localDay = instant.setZone(timezone).startOf("day");
  if (!localDay.isValid) throw new RangeError(`Invalid timezone: ${timezone}`);
  const fromUtc = localDay.toUTC().toISO();
  const toUtc = localDay.plus({ days: 1 }).toUTC().toISO();
  if (fromUtc === null || toUtc === null)
    throw new RangeError(`Cannot resolve relationship day for ${atUtc}`);
  return { fromUtc, toUtc };
}
function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function stable(value: number): number {
  return Number(value.toFixed(12));
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
