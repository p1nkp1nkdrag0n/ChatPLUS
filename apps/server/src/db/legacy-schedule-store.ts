import {
  scheduleItemSchema,
  type ScheduleItem,
  type StateDelta,
} from "../domain/schemas.js";
import { canonicalUtc } from "../domain/time.js";
import type { Database } from "./connection.js";

type SqlRow = Record<string, unknown>;

export type SimulationCursor = {
  agentId: string;
  lastSettledAtUtc: string;
  scheduleHorizonEndUtc: string;
  lastHourlyBucket: string | undefined;
  revision: number;
};

export type StoredActivityEvent = {
  id: string;
  agentId: string;
  scheduleItemId?: string;
  eventType: "started" | "completed" | "partial" | "skipped" | "cancelled";
  occurredAtUtc: string;
  summary: string;
  outcomeFacts: string[];
  stateDelta: StateDelta;
  origin: "deterministic" | "seeded_probability" | "llm_enriched";
  effectTrace?: Record<string, unknown>;
  idempotencyKey: string;
};

export const SCHEDULE_NEGOTIATION_STATUSES = [
  "collecting_details",
  "awaiting_confirmation",
  "committed",
  "declined",
  "withdrawn",
  "expired",
  "conflicted",
] as const;

export type ScheduleNegotiationStatus =
  (typeof SCHEDULE_NEGOTIATION_STATUSES)[number];

export type StoredScheduleNegotiation = {
  id: string;
  agentId: string;
  sessionId: string;
  status: ScheduleNegotiationStatus;
  offerVersion: number;
  record: Record<string, unknown>;
  createdAtUtc: string;
  updatedAtUtc: string;
};

/**
 * Persistence for the retired exact-schedule model.
 *
 * The product runs on fuzzy-life data. These tables and methods stay readable
 * only for migration and explicit legacy regression suites, so they live
 * behind a named compatibility boundary instead of growing DatabaseStore's
 * core persistence surface.
 */
export class LegacyScheduleStore {
  constructor(protected readonly legacyDatabase: Database) {}

  getCursor(agentId: string): SimulationCursor | undefined {
    const row = this.legacyDatabase
      .prepare("SELECT * FROM simulation_cursors WHERE agent_id = ?")
      .get(agentId) as SqlRow | undefined;
    return row
      ? {
          agentId: String(row.agent_id),
          lastSettledAtUtc: String(row.last_settled_at_utc),
          scheduleHorizonEndUtc: String(row.schedule_horizon_end_utc),
          lastHourlyBucket: optionalString(row.last_hourly_bucket),
          revision: Number(row.revision),
        }
      : undefined;
  }

  updateCursor(cursor: SimulationCursor): void {
    this.legacyDatabase
      .prepare(
        `UPDATE simulation_cursors SET last_settled_at_utc = ?, schedule_horizon_end_utc = ?,
          last_hourly_bucket = ?, revision = ? WHERE agent_id = ?`,
      )
      .run(
        cursor.lastSettledAtUtc,
        cursor.scheduleHorizonEndUtc,
        cursor.lastHourlyBucket ?? null,
        cursor.revision,
        cursor.agentId,
      );
  }

  listSchedule(
    agentId: string,
    input: { fromUtc?: string; toUtc?: string } = {},
  ): ScheduleItem[] {
    const clauses = ["agent_id = @agentId"];
    if (input.fromUtc) clauses.push("end_at_utc >= @fromUtc");
    if (input.toUtc) clauses.push("start_at_utc <= @toUtc");
    const query = {
      agentId,
      fromUtc: input.fromUtc ? canonicalUtc(input.fromUtc) : undefined,
      toUtc: input.toUtc ? canonicalUtc(input.toUtc) : undefined,
    };
    return this.legacyDatabase
      .prepare(
        `SELECT item_json FROM schedule_items WHERE ${clauses.join(" AND ")}
         ORDER BY start_at_utc, id`,
      )
      .all(query)
      .map((row) =>
        scheduleItemSchema.parse(JSON.parse(String((row as SqlRow).item_json))),
      );
  }

  getScheduleItem(itemId: string): ScheduleItem | undefined {
    const row = this.legacyDatabase
      .prepare("SELECT item_json FROM schedule_items WHERE id = ?")
      .get(itemId) as { item_json: string } | undefined;
    return row
      ? scheduleItemSchema.parse(JSON.parse(row.item_json))
      : undefined;
  }

  insertScheduleItem(item: ScheduleItem): void {
    const normalized = normalizeScheduleItemTimes(item);
    this.legacyDatabase
      .prepare(
        `INSERT INTO schedule_items(
          id, agent_id, title, category, start_at_utc, end_at_utc, status, rigidity,
          source, shareable, narrative_importance, revision, source_intent_id,
          correlation_id, causation_id, item_json, created_at_utc, updated_at_utc
        ) VALUES (
          @id, @agentId, @title, @category, @startAtUtc, @endAtUtc, @status, @rigidity,
          @source, @shareable, @narrativeImportance, @revision, @sourceIntentId,
          @correlationId, @causationId, @itemJson, @createdAtUtc, @updatedAtUtc
        )`,
      )
      .run({
        ...normalized,
        sourceIntentId: normalized.sourceIntentId ?? null,
        correlationId: normalized.correlationId ?? null,
        causationId: normalized.causationId ?? null,
        shareable: normalized.shareable ? 1 : 0,
        itemJson: JSON.stringify(normalized),
      });
  }

  updateScheduleItem(item: ScheduleItem): void {
    const normalized = normalizeScheduleItemTimes(item);
    this.legacyDatabase
      .prepare(
        `UPDATE schedule_items SET title = @title, category = @category,
          start_at_utc = @startAtUtc, end_at_utc = @endAtUtc, status = @status,
          rigidity = @rigidity, source = @source, shareable = @shareable,
          narrative_importance = @narrativeImportance, revision = @revision,
          source_intent_id = @sourceIntentId, correlation_id = @correlationId,
          causation_id = @causationId, item_json = @itemJson,
          updated_at_utc = @updatedAtUtc WHERE id = @id`,
      )
      .run({
        ...normalized,
        sourceIntentId: normalized.sourceIntentId ?? null,
        correlationId: normalized.correlationId ?? null,
        causationId: normalized.causationId ?? null,
        shareable: normalized.shareable ? 1 : 0,
        itemJson: JSON.stringify(normalized),
      });
  }

  getActiveScheduleNegotiation(
    sessionId: string,
  ): StoredScheduleNegotiation | undefined {
    const row = this.legacyDatabase
      .prepare(
        `SELECT record_json FROM schedule_negotiations
         WHERE session_id = ?
           AND status IN ('collecting_details', 'awaiting_confirmation')
         ORDER BY updated_at_utc DESC, rowid DESC
         LIMIT 1`,
      )
      .get(sessionId) as { record_json: string } | undefined;
    return row ? mapScheduleNegotiation(row) : undefined;
  }

  getScheduleNegotiationById(
    negotiationId: string,
  ): StoredScheduleNegotiation | undefined {
    const row = this.legacyDatabase
      .prepare("SELECT record_json FROM schedule_negotiations WHERE id = ?")
      .get(negotiationId) as { record_json: string } | undefined;
    return row ? mapScheduleNegotiation(row) : undefined;
  }

  upsertScheduleNegotiation(
    negotiation: StoredScheduleNegotiation,
  ): StoredScheduleNegotiation {
    const existing = this.getScheduleNegotiationById(negotiation.id);
    const normalized: StoredScheduleNegotiation = {
      ...negotiation,
      createdAtUtc: canonicalUtc(
        existing?.createdAtUtc ?? negotiation.createdAtUtc,
      ),
      updatedAtUtc: canonicalUtc(negotiation.updatedAtUtc),
    };
    this.legacyDatabase
      .prepare(
        `INSERT INTO schedule_negotiations(
          id, agent_id, session_id, status, offer_version, record_json,
          created_at_utc, updated_at_utc
        ) VALUES (
          @id, @agentId, @sessionId, @status, @offerVersion, @recordJson,
          @createdAtUtc, @updatedAtUtc
        )
        ON CONFLICT(id) DO UPDATE SET
          agent_id = excluded.agent_id,
          session_id = excluded.session_id,
          status = excluded.status,
          offer_version = excluded.offer_version,
          record_json = excluded.record_json,
          created_at_utc = excluded.created_at_utc,
          updated_at_utc = excluded.updated_at_utc`,
      )
      .run({
        ...normalized,
        recordJson: JSON.stringify(normalized),
      });
    return normalized;
  }

  compareAndSetScheduleNegotiation(
    negotiation: StoredScheduleNegotiation,
    expected: {
      status: ScheduleNegotiationStatus;
      offerVersion: number;
    },
  ): boolean {
    const existing = this.getScheduleNegotiationById(negotiation.id);
    if (existing === undefined) return false;
    const normalized: StoredScheduleNegotiation = {
      ...negotiation,
      createdAtUtc: canonicalUtc(existing.createdAtUtc),
      updatedAtUtc: canonicalUtc(negotiation.updatedAtUtc),
    };
    const result = this.legacyDatabase
      .prepare(
        `UPDATE schedule_negotiations SET
          agent_id = @agentId,
          session_id = @sessionId,
          status = @status,
          offer_version = @offerVersion,
          record_json = @recordJson,
          created_at_utc = @createdAtUtc,
          updated_at_utc = @updatedAtUtc
         WHERE id = @id
           AND agent_id = @agentId
           AND session_id = @sessionId
           AND status = @expectedStatus
           AND offer_version = @expectedOfferVersion`,
      )
      .run({
        ...normalized,
        recordJson: JSON.stringify(normalized),
        expectedStatus: expected.status,
        expectedOfferVersion: expected.offerVersion,
      });
    return result.changes === 1;
  }

  listScheduleNegotiations(
    input: {
      agentId?: string;
      sessionId?: string;
      status?: ScheduleNegotiationStatus;
      limit?: number;
    } = {},
  ): StoredScheduleNegotiation[] {
    const clauses: string[] = [];
    const parameters: Record<string, unknown> = {
      limit: Math.max(1, Math.min(input.limit ?? 100, 500)),
    };
    if (input.agentId !== undefined) {
      clauses.push("agent_id = @agentId");
      parameters.agentId = input.agentId;
    }
    if (input.sessionId !== undefined) {
      clauses.push("session_id = @sessionId");
      parameters.sessionId = input.sessionId;
    }
    if (input.status !== undefined) {
      clauses.push("status = @status");
      parameters.status = input.status;
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.legacyDatabase
      .prepare(
        `SELECT record_json FROM schedule_negotiations ${where}
         ORDER BY updated_at_utc DESC, rowid DESC LIMIT @limit`,
      )
      .all(parameters)
      .map((row) => mapScheduleNegotiation(row as SqlRow));
  }

  insertActivityEvent(event: StoredActivityEvent): boolean {
    const result = this.legacyDatabase
      .prepare(
        `INSERT OR IGNORE INTO activity_events(
          id, agent_id, schedule_item_id, event_type, occurred_at_utc, summary,
          outcome_facts_json, state_delta_json, origin, idempotency_key, event_json
        ) VALUES (
          @id, @agentId, @scheduleItemId, @eventType, @occurredAtUtc, @summary,
          @outcomeFactsJson, @stateDeltaJson, @origin, @idempotencyKey, @eventJson
        )`,
      )
      .run({
        ...event,
        scheduleItemId: event.scheduleItemId ?? null,
        outcomeFactsJson: JSON.stringify(event.outcomeFacts),
        stateDeltaJson: JSON.stringify(event.stateDelta),
        eventJson: JSON.stringify(event),
      });
    return result.changes > 0;
  }

  listActivityEvents(agentId: string, limit = 100): StoredActivityEvent[] {
    return this.legacyDatabase
      .prepare(
        `SELECT event_json FROM activity_events WHERE agent_id = ?
         ORDER BY occurred_at_utc DESC, rowid DESC LIMIT ?`,
      )
      .all(agentId, limit)
      .map(
        (row) =>
          JSON.parse(String((row as SqlRow).event_json)) as StoredActivityEvent,
      );
  }
}

function mapScheduleNegotiation(row: SqlRow): StoredScheduleNegotiation {
  return JSON.parse(String(row.record_json)) as StoredScheduleNegotiation;
}

function normalizeScheduleItemTimes(item: ScheduleItem): ScheduleItem {
  return scheduleItemSchema.parse({
    ...item,
    startAtUtc: canonicalUtc(item.startAtUtc),
    endAtUtc: canonicalUtc(item.endAtUtc),
    createdAtUtc: canonicalUtc(item.createdAtUtc),
    updatedAtUtc: canonicalUtc(item.updatedAtUtc),
  });
}

function optionalString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "bigint" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return undefined;
}
