import { DateTime } from "luxon";

import type {
  RelationshipDailyUsage,
  RelationshipDeltaField,
} from "@personasim/features";

import type { DatabaseStore } from "../db/store.js";

const RELATIONSHIP_FIELDS = [
  "closeness",
  "trust",
  "familiarity",
  "recentInteractionValence",
] as const satisfies readonly RelationshipDeltaField[];

export interface RelationshipDailySignedUsage {
  net: Partial<Record<RelationshipDeltaField, number>>;
}

/**
 * Rebuilds the current local-day relationship movement budget from committed
 * traces. Keeping this derived from the append-only audit log makes restart
 * behavior deterministic and avoids a second mutable counter.
 */
export function loadDailyRelationshipUsage(
  store: DatabaseStore,
  agentId: string,
  timezone: string,
  atUtc: string,
): RelationshipDailyUsage {
  const instant = DateTime.fromISO(atUtc, { setZone: true });
  if (!instant.isValid) throw new RangeError(`Invalid UTC instant: ${atUtc}`);
  const localDay = instant.setZone(timezone).startOf("day");
  if (!localDay.isValid) throw new RangeError(`Invalid timezone: ${timezone}`);
  const fromUtc = localDay.toUTC().toISO();
  const toUtc = localDay.plus({ days: 1 }).toUTC().toISO();
  if (fromUtc === null || toUtc === null) {
    throw new RangeError(`Cannot resolve relationship day for ${atUtc}`);
  }

  const usage: RelationshipDailyUsage = {};
  const domainRows = store.database
    .prepare(
      `SELECT payload_json AS payloadJson
       FROM domain_events
       WHERE agent_id = ? AND effective_at_utc >= ? AND effective_at_utc < ?
         AND event_type IN (
           'conversation.world_effects_committed',
           'conversation.world_effects_shadow_evaluated'
         )`,
    )
    .all(agentId, fromUtc, toUtc) as Array<{ payloadJson: string }>;
  for (const row of domainRows) {
    addUsage(usage, parseUsage(row.payloadJson));
  }
  const activityRows = store.database
    .prepare(
      `SELECT event_json AS eventJson
       FROM activity_events
       WHERE agent_id = ? AND occurred_at_utc >= ? AND occurred_at_utc < ?`,
    )
    .all(agentId, fromUtc, toUtc) as Array<{ eventJson: string }>;
  for (const row of activityRows) {
    addUsage(usage, parseUsage(row.eventJson));
  }

  return usage;
}

/**
 * Rebuilds signed movement for the local day from committed relationship
 * traces. The relationship engine still receives a non-negative usage budget,
 * but callers can choose the outstanding movement in the proposed direction.
 * A rupture therefore releases room for an evidenced repair back toward the
 * day's starting point instead of both directions consuming one absolute cap.
 */
export function loadDailyRelationshipSignedUsage(
  store: DatabaseStore,
  agentId: string,
  timezone: string,
  atUtc: string,
): RelationshipDailySignedUsage {
  const instant = DateTime.fromISO(atUtc, { setZone: true });
  if (!instant.isValid) throw new RangeError(`Invalid UTC instant: ${atUtc}`);
  const localDay = instant.setZone(timezone).startOf("day");
  if (!localDay.isValid) throw new RangeError(`Invalid timezone: ${timezone}`);
  const fromUtc = localDay.toUTC().toISO();
  const toUtc = localDay.plus({ days: 1 }).toUTC().toISO();
  if (fromUtc === null || toUtc === null) {
    throw new RangeError(`Cannot resolve relationship day for ${atUtc}`);
  }

  const usage: RelationshipDailySignedUsage = { net: {} };
  const domainRows = store.database
    .prepare(
      `SELECT payload_json AS payloadJson
       FROM domain_events
       WHERE agent_id = ? AND effective_at_utc >= ? AND effective_at_utc < ?
         AND event_type IN (
           'conversation.world_effects_committed',
           'conversation.world_effects_shadow_evaluated'
         )`,
    )
    .all(agentId, fromUtc, toUtc) as Array<{ payloadJson: string }>;
  for (const row of domainRows) {
    addSignedUsage(usage, parseBudgetedRelationshipDelta(row.payloadJson));
  }
  const activityRows = store.database
    .prepare(
      `SELECT event_json AS eventJson
       FROM activity_events
       WHERE agent_id = ? AND occurred_at_utc >= ? AND occurred_at_utc < ?`,
    )
    .all(agentId, fromUtc, toUtc) as Array<{ eventJson: string }>;
  for (const row of activityRows) {
    addSignedUsage(usage, parseBudgetedRelationshipDelta(row.eventJson));
  }
  return usage;
}

function parseUsage(json: string): RelationshipDailyUsage | undefined {
  try {
    const payload = JSON.parse(json) as unknown;
    if (!isRecord(payload)) return undefined;
    const relationship = isRecord(payload["relationship"])
      ? payload["relationship"]
      : undefined;
    if (relationship !== undefined) {
      return usageRecord(relationship["dailyUsageApplied"]);
    }
    const effectTrace = isRecord(payload["effectTrace"])
      ? payload["effectTrace"]
      : undefined;
    if (effectTrace !== undefined) {
      return usageRecord(effectTrace["relationshipDailyUsageApplied"]);
    }
    return usageRecord(payload["relationshipDailyUsageApplied"]);
  } catch {
    return undefined;
  }
}

function parseBudgetedRelationshipDelta(
  json: string,
): Partial<Record<RelationshipDeltaField, number>> | undefined {
  try {
    const payload = JSON.parse(json) as unknown;
    if (!isRecord(payload)) return undefined;
    const relationship = isRecord(payload["relationship"])
      ? payload["relationship"]
      : undefined;
    if (relationship !== undefined) {
      const traced = signedBudgetedDelta(relationship);
      if (traced !== undefined) return traced;
    }

    const effectTrace = isRecord(payload["effectTrace"])
      ? payload["effectTrace"]
      : undefined;
    const tracedRelationship =
      effectTrace !== undefined && isRecord(effectTrace["relationship"])
        ? effectTrace["relationship"]
        : undefined;
    if (tracedRelationship !== undefined) {
      const traced = signedBudgetedDelta(tracedRelationship);
      if (traced !== undefined) return traced;
    }

    // Compatibility fallback for older traces which did not split baseline,
    // proposal and valence decay. New traces always take the paths above.
    const applied = isRecord(payload["applied"])
      ? payload["applied"]
      : undefined;
    return applied !== undefined && isRecord(applied["relationshipDelta"])
      ? signedDeltaRecord(applied["relationshipDelta"])
      : undefined;
  } catch {
    return undefined;
  }
}

function signedDeltaRecord(
  value: Record<string, unknown>,
): Partial<Record<RelationshipDeltaField, number>> {
  const delta: Partial<Record<RelationshipDeltaField, number>> = {};
  for (const field of RELATIONSHIP_FIELDS) {
    const amount = value[field];
    if (typeof amount === "number" && Number.isFinite(amount) && amount !== 0) {
      delta[field] = amount;
    }
  }
  return delta;
}

function signedBudgetedDelta(
  relationship: Record<string, unknown>,
): Partial<Record<RelationshipDeltaField, number>> | undefined {
  const baseline = isRecord(relationship["baselineDelta"])
    ? signedDeltaRecord(relationship["baselineDelta"])
    : undefined;
  const proposal = isRecord(relationship["appliedProposalDelta"])
    ? signedDeltaRecord(relationship["appliedProposalDelta"])
    : undefined;
  if (baseline === undefined && proposal === undefined) return undefined;
  const combined: Partial<Record<RelationshipDeltaField, number>> = {};
  for (const field of RELATIONSHIP_FIELDS) {
    const amount = (baseline?.[field] ?? 0) + (proposal?.[field] ?? 0);
    if (amount !== 0) combined[field] = amount;
  }
  return combined;
}

function addSignedUsage(
  target: RelationshipDailySignedUsage,
  delta: Partial<Record<RelationshipDeltaField, number>> | undefined,
): void {
  if (delta === undefined) return;
  for (const field of RELATIONSHIP_FIELDS) {
    const amount = delta[field];
    if (amount === undefined || amount === 0) continue;
    target.net[field] = (target.net[field] ?? 0) + amount;
  }
}

function usageRecord(value: unknown): RelationshipDailyUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: RelationshipDailyUsage = {};
  for (const field of RELATIONSHIP_FIELDS) {
    const amount = value[field];
    if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
      usage[field] = amount;
    }
  }
  return usage;
}

function addUsage(
  target: RelationshipDailyUsage,
  addition: RelationshipDailyUsage | undefined,
): void {
  if (addition === undefined) return;
  for (const field of RELATIONSHIP_FIELDS) {
    const amount = addition[field];
    if (amount !== undefined) target[field] = (target[field] ?? 0) + amount;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
