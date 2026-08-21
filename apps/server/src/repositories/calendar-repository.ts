import {
  CalendarEntrySchema,
  CalendarScopeSchema,
  CalendarStatusSchema,
  type CalendarEntry,
  type CalendarScope,
  type CalendarStatus,
} from "@personasim/contracts";

import type { Database } from "../db/connection.js";

export interface CalendarEntryListInput {
  agentId?: string;
  scopes?: readonly CalendarScope[];
  status?: CalendarStatus;
  startLocalDateInclusive?: string;
  endLocalDateExclusive?: string;
  limit?: number;
}

interface CalendarEntryRow {
  id: string;
  dedupe_key: string;
  revision: number;
  created_at_utc: string;
  record_json: string;
}

export class CalendarRepository {
  constructor(private readonly database: Database) {}

  insert(entry: CalendarEntry): CalendarEntry {
    const parsed = CalendarEntrySchema.parse(entry);
    this.database
      .prepare(
        `INSERT INTO calendar_entries(
          id, agent_id, scope, title, description, local_date, timezone,
          all_day, start_local_time, end_local_time, recurrence, source,
          status, dedupe_key, revision, record_json, created_at_utc,
          updated_at_utc
        ) VALUES (
          @id, @agentId, @scope, @title, @description, @localDate, @timezone,
          @allDay, @startLocalTime, @endLocalTime, @recurrence, @source,
          @status, @dedupeKey, @revision, @recordJson, @createdAtUtc,
          @updatedAtUtc
        )`,
      )
      .run(toParameters(parsed));
    return parsed;
  }

  findById(id: string): CalendarEntry | undefined {
    const row = this.database
      .prepare(
        `SELECT id, dedupe_key, revision, created_at_utc, record_json
         FROM calendar_entries
         WHERE id = ?`,
      )
      .get(id) as CalendarEntryRow | undefined;
    return row === undefined ? undefined : parseRow(row);
  }

  findByDedupeKey(dedupeKey: string): CalendarEntry | undefined {
    const row = this.database
      .prepare(
        `SELECT id, dedupe_key, revision, created_at_utc, record_json
         FROM calendar_entries
         WHERE dedupe_key = ?`,
      )
      .get(dedupeKey) as CalendarEntryRow | undefined;
    return row === undefined ? undefined : parseRow(row);
  }

  listVisible(input: CalendarEntryListInput = {}): CalendarEntry[] {
    const scopes = normalizeScopes(input.scopes);
    const status =
      input.status === undefined
        ? undefined
        : CalendarStatusSchema.parse(input.status);
    assertDateRange(input.startLocalDateInclusive, input.endLocalDateExclusive);

    const clauses = [
      input.agentId === undefined
        ? "scope = 'public_system'"
        : "(scope = 'public_system' OR agent_id = @agentId)",
    ];
    const parameters: Record<string, unknown> = {
      agentId: input.agentId ?? null,
      limit: boundedLimit(input.limit),
    };
    if (scopes.length > 0) {
      const placeholders = scopes.map((scope, index) => {
        const name = "scope" + index;
        parameters[name] = scope;
        return "@" + name;
      });
      clauses.push("scope IN (" + placeholders.join(", ") + ")");
    }
    if (status !== undefined) {
      clauses.push("status = @status");
      parameters.status = status;
    }
    if (input.startLocalDateInclusive !== undefined) {
      clauses.push(
        "(recurrence = 'yearly' OR local_date >= @startLocalDateInclusive)",
      );
      parameters.startLocalDateInclusive = input.startLocalDateInclusive;
    }
    if (input.endLocalDateExclusive !== undefined) {
      clauses.push(
        "(recurrence = 'yearly' OR local_date < @endLocalDateExclusive)",
      );
      parameters.endLocalDateExclusive = input.endLocalDateExclusive;
    }

    return (
      this.database
        .prepare(
          `SELECT id, dedupe_key, revision, created_at_utc, record_json
           FROM calendar_entries
           WHERE ${clauses.join(" AND ")}
           ORDER BY
             local_date,
             CASE scope
               WHEN 'public_system' THEN 0
               WHEN 'character_world' THEN 1
               ELSE 2
             END,
             title,
             id
           LIMIT @limit`,
        )
        .all(parameters) as CalendarEntryRow[]
    ).map(parseRow);
  }

  compareAndSet(entry: CalendarEntry, expectedRevision: number): boolean {
    const parsed = CalendarEntrySchema.parse(entry);
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
      throw new TypeError("expectedRevision must be a non-negative integer");
    }
    if (parsed.revision !== expectedRevision + 1) {
      throw new TypeError(
        "Calendar entry revision must increment expectedRevision by one",
      );
    }
    const result = this.database
      .prepare(
        `UPDATE calendar_entries SET
          agent_id = @agentId,
          scope = @scope,
          title = @title,
          description = @description,
          local_date = @localDate,
          timezone = @timezone,
          all_day = @allDay,
          start_local_time = @startLocalTime,
          end_local_time = @endLocalTime,
          recurrence = @recurrence,
          source = @source,
          status = @status,
          dedupe_key = @dedupeKey,
          revision = @revision,
          record_json = @recordJson,
          updated_at_utc = @updatedAtUtc
         WHERE id = @id
           AND revision = @expectedRevision
           AND created_at_utc = @createdAtUtc`,
      )
      .run({
        ...toParameters(parsed),
        expectedRevision,
      });
    return result.changes === 1;
  }
}

function toParameters(entry: CalendarEntry): Record<string, unknown> {
  return {
    ...entry,
    agentId: entry.agentId ?? null,
    description: entry.description ?? null,
    allDay: entry.allDay ? 1 : 0,
    startLocalTime: entry.startLocalTime ?? null,
    endLocalTime: entry.endLocalTime ?? null,
    recordJson: JSON.stringify(entry),
  };
}

function parseRow(row: CalendarEntryRow): CalendarEntry {
  const parsed = CalendarEntrySchema.parse(
    JSON.parse(row.record_json) as unknown,
  );
  if (
    parsed.id !== row.id ||
    parsed.dedupeKey !== row.dedupe_key ||
    parsed.revision !== row.revision ||
    parsed.createdAtUtc !== row.created_at_utc
  ) {
    throw new TypeError("Calendar entry columns do not match record_json");
  }
  return parsed;
}

function normalizeScopes(
  scopes: readonly CalendarScope[] | undefined,
): CalendarScope[] {
  if (scopes === undefined) return [];
  return [...new Set(scopes.map((scope) => CalendarScopeSchema.parse(scope)))];
}

function assertDateRange(
  startLocalDateInclusive: string | undefined,
  endLocalDateExclusive: string | undefined,
): void {
  if (
    startLocalDateInclusive !== undefined &&
    endLocalDateExclusive !== undefined &&
    startLocalDateInclusive >= endLocalDateExclusive
  ) {
    throw new TypeError("Calendar date range must be increasing");
  }
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 500;
  if (!Number.isFinite(value)) {
    throw new TypeError("Calendar list limit must be finite");
  }
  return Math.max(1, Math.min(500, Math.trunc(value)));
}
