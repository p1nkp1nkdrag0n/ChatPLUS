import {
  characterSpecSchema,
  runtimeStateSchema,
  scheduleItemSchema,
  type CharacterSpec,
  type RuntimeState,
  type ScheduleItem,
  type StateDelta,
} from "../domain/schemas.js";
import { createEntityId } from "../domain/id.js";
import { canonicalUtc } from "../domain/time.js";
import type { Database } from "./connection.js";

type SqlRow = Record<string, unknown>;

export type CharacterSummary = {
  id: string;
  currentVersion: number;
  status: CharacterSpec["status"];
  tier: CharacterSpec["tier"];
  name: string;
  sourceType: CharacterSpec["sourceType"];
  createdAtUtc: string;
  updatedAtUtc: string;
};

export type StoredSession = {
  id: string;
  agentId: string;
  title: string;
  createdAtUtc: string;
  updatedAtUtc: string;
};

export type StoredMessage = {
  id: string;
  sessionId: string;
  agentId: string;
  role: "user" | "assistant" | "system";
  content: string;
  messageKind:
    "user" | "assistant_reply" | "assistant_proactive" | "system_notice";
  triggerEventId?: string | undefined;
  clientMessageId?: string | undefined;
  inReplyToMessageId?: string | undefined;
  metadata: Record<string, unknown>;
  createdAtUtc: string;
};

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

export interface HistoricalScheduleReadAuthorization extends Record<
  string,
  unknown
> {
  authorizedItemId: string;
  scheduleCommandEventId: string;
  negotiationId: string;
  offerVersion: number;
  negotiationStatus: string;
}

export interface AuthorizedHistoricalSharedSchedule {
  item: ScheduleItem;
  authorization: HistoricalScheduleReadAuthorization;
}

export class DatabaseStore {
  constructor(readonly database: Database) {}

  transaction<T>(work: () => T): T {
    return this.database.transaction(work)();
  }

  countCharacters(): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS count FROM characters")
      .get() as {
      count: number;
    };
    return row.count;
  }

  listCharacters(includeArchived = false): CharacterSummary[] {
    const where = includeArchived ? "" : "WHERE status <> 'archived'";
    return (
      this.database
        .prepare(
          `SELECT * FROM characters ${where} ORDER BY updated_at_utc DESC`,
        )
        .all() as SqlRow[]
    ).map(mapCharacterSummary);
  }

  getCharacterSummary(agentId: string): CharacterSummary | undefined {
    const row = this.database
      .prepare("SELECT * FROM characters WHERE id = ?")
      .get(agentId) as SqlRow | undefined;
    return row ? mapCharacterSummary(row) : undefined;
  }

  getCharacterSpec(
    agentId: string,
    version?: number,
  ): CharacterSpec | undefined {
    const selectedVersion =
      version ??
      (
        this.database
          .prepare("SELECT current_version FROM characters WHERE id = ?")
          .get(agentId) as { current_version: number } | undefined
      )?.current_version;
    if (selectedVersion === undefined) return undefined;
    const row = this.database
      .prepare(
        "SELECT spec_json FROM character_versions WHERE character_id = ? AND version = ?",
      )
      .get(agentId, selectedVersion) as { spec_json: string } | undefined;
    return row
      ? characterSpecSchema.parse(JSON.parse(row.spec_json))
      : undefined;
  }

  listCharacterVersions(agentId: string): Array<{
    version: number;
    status: CharacterSpec["status"];
    createdAtUtc: string;
    spec: CharacterSpec;
  }> {
    return (
      this.database
        .prepare(
          `SELECT version, status, created_at_utc, spec_json
           FROM character_versions WHERE character_id = ? ORDER BY version DESC`,
        )
        .all(agentId) as SqlRow[]
    ).map((row) => ({
      version: Number(row.version),
      status: String(row.status) as CharacterSpec["status"],
      createdAtUtc: String(row.created_at_utc),
      spec: characterSpecSchema.parse(JSON.parse(String(row.spec_json))),
    }));
  }

  insertCharacter(spec: CharacterSpec): void {
    this.database
      .prepare(
        `INSERT INTO characters(
          id, current_version, status, tier, name, source_type, created_at_utc, updated_at_utc
        ) VALUES (@id, @version, @status, @tier, @name, @sourceType, @createdAtUtc, @updatedAtUtc)`,
      )
      .run({
        id: spec.id,
        version: spec.version,
        status: spec.status,
        tier: spec.tier,
        name: spec.identity.name,
        sourceType: spec.sourceType,
        createdAtUtc: spec.createdAtUtc,
        updatedAtUtc: spec.updatedAtUtc,
      });
    this.insertCharacterVersion(spec);
  }

  insertCharacterVersion(spec: CharacterSpec): void {
    this.database
      .prepare(
        `INSERT INTO character_versions(character_id, version, status, spec_json, created_at_utc)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        spec.id,
        spec.version,
        spec.status,
        JSON.stringify(spec),
        spec.createdAtUtc,
      );
  }

  updateCharacterHead(spec: CharacterSpec): void {
    this.database
      .prepare(
        `UPDATE characters SET current_version = ?, status = ?, tier = ?, name = ?,
          source_type = ?, updated_at_utc = ? WHERE id = ?`,
      )
      .run(
        spec.version,
        spec.status,
        spec.tier,
        spec.identity.name,
        spec.sourceType,
        spec.updatedAtUtc,
        spec.id,
      );
  }

  replaceVersion(spec: CharacterSpec): void {
    this.database
      .prepare(
        `UPDATE character_versions SET status = ?, spec_json = ?
         WHERE character_id = ? AND version = ?`,
      )
      .run(spec.status, JSON.stringify(spec), spec.id, spec.version);
  }

  markOtherVersionsNotPublished(agentId: string, exceptVersion: number): void {
    const rows = this.database
      .prepare(
        `SELECT version, spec_json FROM character_versions
         WHERE character_id = ? AND version <> ? AND status = 'published'`,
      )
      .all(agentId, exceptVersion) as Array<{
      version: number;
      spec_json: string;
    }>;
    for (const row of rows) {
      const spec = characterSpecSchema.parse(JSON.parse(row.spec_json));
      spec.status = "archived";
      this.database
        .prepare(
          `UPDATE character_versions SET status = 'archived', spec_json = ?
           WHERE character_id = ? AND version = ?`,
        )
        .run(JSON.stringify(spec), agentId, row.version);
    }
  }

  insertCharacterSource(input: {
    id: string;
    characterId: string;
    sourceType: string;
    title: string;
    contentExcerpt: string;
    sourceHash: string;
    createdAtUtc: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO character_sources(
          id, character_id, source_type, title, content_excerpt, source_hash, created_at_utc
        ) VALUES (@id, @characterId, @sourceType, @title, @contentExcerpt, @sourceHash, @createdAtUtc)`,
      )
      .run(input);
  }

  listCharacterSources(agentId: string): Array<Record<string, unknown>> {
    return this.database
      .prepare(
        `SELECT id, source_type AS sourceType, title, content_excerpt AS contentExcerpt,
          source_hash AS sourceHash, created_at_utc AS createdAtUtc
         FROM character_sources WHERE character_id = ? ORDER BY created_at_utc`,
      )
      .all(agentId) as Array<Record<string, unknown>>;
  }

  insertInitialState(state: RuntimeState, horizonEndUtc: string): void {
    this.database
      .prepare(
        `INSERT INTO runtime_states(agent_id, state_json, revision, updated_at_utc, sleep_debt_minutes)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        state.agentId,
        JSON.stringify(state),
        state.revision,
        state.asOfUtc,
        state.sleepDebtMinutes,
      );
    this.database
      .prepare(
        `INSERT INTO simulation_cursors(
          agent_id, last_settled_at_utc, schedule_horizon_end_utc, last_hourly_bucket, revision
        ) VALUES (?, ?, ?, NULL, 0)`,
      )
      .run(state.agentId, state.asOfUtc, horizonEndUtc);
  }

  getRuntimeState(agentId: string): RuntimeState | undefined {
    const row = this.database
      .prepare("SELECT state_json FROM runtime_states WHERE agent_id = ?")
      .get(agentId) as { state_json: string } | undefined;
    return row
      ? runtimeStateSchema.parse(JSON.parse(row.state_json))
      : undefined;
  }

  updateRuntimeState(state: RuntimeState): void {
    this.database
      .prepare(
        `UPDATE runtime_states SET state_json = ?, revision = ?, updated_at_utc = ?, sleep_debt_minutes = ?
         WHERE agent_id = ?`,
      )
      .run(
        JSON.stringify(state),
        state.revision,
        state.asOfUtc,
        state.sleepDebtMinutes,
        state.agentId,
      );
  }

  compareAndSetRuntimeState(
    state: RuntimeState,
    expectedRevision: number,
  ): boolean {
    const result = this.database
      .prepare(
        `UPDATE runtime_states SET state_json = ?, revision = ?, updated_at_utc = ?, sleep_debt_minutes = ?
         WHERE agent_id = ? AND revision = ?`,
      )
      .run(
        JSON.stringify(state),
        state.revision,
        state.asOfUtc,
        state.sleepDebtMinutes,
        state.agentId,
        expectedRevision,
      );
    return result.changes === 1;
  }

  runtimeStateRevisionMatches(
    agentId: string,
    expectedRevision: number,
  ): boolean {
    const row = this.database
      .prepare(
        `SELECT 1 AS matches FROM runtime_states
         WHERE agent_id = ? AND revision = ?`,
      )
      .get(agentId, expectedRevision) as { matches: number } | undefined;
    return row !== undefined;
  }

  getCursor(agentId: string): SimulationCursor | undefined {
    const row = this.database
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
    this.database
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
    return this.database
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
    const row = this.database
      .prepare("SELECT item_json FROM schedule_items WHERE id = ?")
      .get(itemId) as { item_json: string } | undefined;
    return row
      ? scheduleItemSchema.parse(JSON.parse(row.item_json))
      : undefined;
  }

  listAuthorizedHistoricalSharedSchedulesByEntity(input: {
    agentId: string;
    entityText: string;
    nowUtc: string;
    limit?: number;
  }): AuthorizedHistoricalSharedSchedule[] {
    const entity = normalizeHistoricalScheduleEntity(input.entityText);
    if (!isSpecificHistoricalScheduleEntityText(input.entityText)) return [];
    const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 3), 3));
    const rows = this.database
      .prepare(
        `SELECT si.item_json AS itemJson,
                de.id AS scheduleCommandEventId,
                json_extract(de.payload_json, '$.negotiationId') AS negotiationId,
                json_extract(de.payload_json, '$.offerVersion') AS offerVersion,
                sn.status AS negotiationStatus
         FROM domain_events AS de
         JOIN json_each(de.payload_json, '$.changedItemIds') AS changed
           ON changed.type = 'text'
         JOIN schedule_items AS si
           ON si.id = changed.value
          AND si.agent_id = de.agent_id
         JOIN schedule_negotiations AS sn
           ON sn.id = json_extract(de.payload_json, '$.negotiationId')
          AND sn.agent_id = de.agent_id
          AND sn.status = 'committed'
          AND sn.offer_version = json_extract(de.payload_json, '$.offerVersion')
         WHERE de.agent_id = @agentId
           AND de.event_type = 'schedule.command_committed'
           AND de.recorded_at_utc <= @nowUtc
           AND json_type(de.payload_json, '$.negotiationId') = 'text'
           AND json_type(de.payload_json, '$.offerVersion') = 'integer'
           AND json_extract(de.payload_json, '$.operation') = 'create'
           AND si.end_at_utc < @nowUtc
           AND si.status <> 'cancelled'
           AND si.rigidity = 'committed'
           AND si.source = 'user_invitation'
           AND si.shareable = 1
         ORDER BY si.start_at_utc DESC, de.recorded_at_utc DESC, de.id DESC`,
      )
      .all({
        agentId: input.agentId,
        nowUtc: canonicalUtc(input.nowUtc),
      }) as Array<{
      itemJson: string;
      scheduleCommandEventId: string;
      negotiationId: string;
      offerVersion: number;
      negotiationStatus: string;
    }>;

    const seen = new Set<string>();
    return rows
      .map((row) => {
        const item = scheduleItemSchema.parse(JSON.parse(row.itemJson));
        return {
          item,
          authorization: {
            authorizedItemId: item.id,
            scheduleCommandEventId: String(row.scheduleCommandEventId),
            negotiationId: String(row.negotiationId),
            offerVersion: Number(row.offerVersion),
            negotiationStatus: row.negotiationStatus,
          },
        };
      })
      .filter((candidate) => {
        if (!Number.isSafeInteger(candidate.authorization.offerVersion)) {
          return false;
        }
        if (seen.has(candidate.item.id)) return false;
        if (
          !normalizeHistoricalScheduleEntity(candidate.item.title).includes(
            entity,
          )
        ) {
          return false;
        }
        seen.add(candidate.item.id);
        return true;
      })
      .sort((left, right) => {
        const leftSurplus =
          normalizeHistoricalScheduleEntity(left.item.title).length -
          entity.length;
        const rightSurplus =
          normalizeHistoricalScheduleEntity(right.item.title).length -
          entity.length;
        return leftSurplus !== rightSurplus
          ? leftSurplus - rightSurplus
          : right.item.startAtUtc.localeCompare(left.item.startAtUtc);
      })
      .slice(0, limit);
  }

  insertScheduleItem(item: ScheduleItem): void {
    const normalized = normalizeScheduleItemTimes(item);
    this.database
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
    this.database
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

  createSession(agentId: string, title: string, nowUtc: string): StoredSession {
    const session: StoredSession = {
      id: createEntityId("session"),
      agentId,
      title,
      createdAtUtc: nowUtc,
      updatedAtUtc: nowUtc,
    };
    this.database
      .prepare(
        `INSERT INTO sessions(id, agent_id, title, created_at_utc, updated_at_utc)
         VALUES (@id, @agentId, @title, @createdAtUtc, @updatedAtUtc)`,
      )
      .run(session);
    return session;
  }

  getSession(sessionId: string): StoredSession | undefined {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId) as SqlRow | undefined;
    return row ? mapSession(row) : undefined;
  }

  listSessions(agentId: string): StoredSession[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at_utc DESC",
        )
        .all(agentId) as SqlRow[]
    ).map(mapSession);
  }

  listMessages(sessionId: string, limit = 100): StoredMessage[] {
    return (
      this.database
        .prepare(
          `SELECT * FROM (
             SELECT *, rowid AS sort_order FROM messages
             WHERE session_id = ? ORDER BY created_at_utc DESC, rowid DESC LIMIT ?
           ) ORDER BY created_at_utc, sort_order`,
        )
        .all(sessionId, limit) as SqlRow[]
    ).map(mapMessage);
  }

  listMessagesForContext(sessionId: string): StoredMessage[] {
    return (
      this.database
        .prepare(
          `SELECT *, rowid AS sort_order FROM messages
           WHERE session_id = ? ORDER BY created_at_utc, rowid`,
        )
        .all(sessionId) as SqlRow[]
    ).map(mapMessage);
  }

  findTurnByClientMessageId(
    sessionId: string,
    clientMessageId: string,
  ):
    | { userMessage: StoredMessage; assistantMessage?: StoredMessage }
    | undefined {
    const userRow = this.database
      .prepare(
        `SELECT * FROM messages
         WHERE session_id = ? AND client_message_id = ? AND message_kind = 'user'`,
      )
      .get(sessionId, clientMessageId) as SqlRow | undefined;
    if (!userRow) return undefined;
    const userMessage = mapMessage(userRow);
    const replyRow = this.database
      .prepare(
        `SELECT * FROM messages WHERE in_reply_to_message_id = ?
         ORDER BY created_at_utc, rowid LIMIT 1`,
      )
      .get(userMessage.id) as SqlRow | undefined;
    return replyRow
      ? { userMessage, assistantMessage: mapMessage(replyRow) }
      : { userMessage };
  }

  insertMessage(message: StoredMessage): void {
    this.database
      .prepare(
        `INSERT INTO messages(
          id, session_id, agent_id, role, content, message_kind, trigger_event_id,
          client_message_id, in_reply_to_message_id, metadata_json, created_at_utc
        ) VALUES (
          @id, @sessionId, @agentId, @role, @content, @messageKind, @triggerEventId,
          @clientMessageId, @inReplyToMessageId, @metadataJson, @createdAtUtc
        )`,
      )
      .run({
        ...message,
        triggerEventId: message.triggerEventId ?? null,
        clientMessageId: message.clientMessageId ?? null,
        inReplyToMessageId: message.inReplyToMessageId ?? null,
        metadataJson: JSON.stringify(message.metadata),
      });
    this.database
      .prepare("UPDATE sessions SET updated_at_utc = ? WHERE id = ?")
      .run(message.createdAtUtc, message.sessionId);
  }

  getActiveScheduleNegotiation(
    sessionId: string,
  ): StoredScheduleNegotiation | undefined {
    const row = this.database
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
    const row = this.database
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
    this.database
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
    const result = this.database
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
    return this.database
      .prepare(
        `SELECT record_json FROM schedule_negotiations ${where}
         ORDER BY updated_at_utc DESC, rowid DESC LIMIT @limit`,
      )
      .all(parameters)
      .map((row) => mapScheduleNegotiation(row as SqlRow));
  }

  insertActivityEvent(event: StoredActivityEvent): boolean {
    const result = this.database
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
    return this.database
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

  insertDomainEvent(input: {
    agentId: string;
    streamType: string;
    streamId: string;
    streamVersion: number;
    eventType: string;
    recordedAtUtc: string;
    effectiveAtUtc?: string;
    payload: unknown;
    correlationId?: string;
    causationId?: string;
    idempotencyKey: string;
  }): boolean {
    const result = this.database
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
        input.streamVersion,
        input.eventType,
        input.recordedAtUtc,
        input.effectiveAtUtc ?? input.recordedAtUtc,
        JSON.stringify(input.payload),
        input.correlationId ?? null,
        input.causationId ?? null,
        input.idempotencyKey,
      );
    return result.changes > 0;
  }

  nextDomainEventStreamVersion(streamType: string, streamId: string): number {
    const row = this.database
      .prepare(
        `SELECT COALESCE(MAX(stream_version), 0) + 1 AS next_version
         FROM domain_events
         WHERE stream_type = ? AND stream_id = ?`,
      )
      .get(streamType, streamId) as { next_version: number };
    return Number(row.next_version);
  }

  listDomainEvents(
    agentId?: string,
    limit = 100,
  ): Array<Record<string, unknown>> {
    const where = agentId ? "WHERE agent_id = ?" : "";
    const params = agentId ? [agentId, limit] : [limit];
    return this.database
      .prepare(
        `SELECT id, agent_id AS agentId, stream_type AS streamType, stream_id AS streamId,
          stream_version AS streamVersion, event_type AS eventType,
          recorded_at_utc AS recordedAtUtc, effective_at_utc AS effectiveAtUtc,
          payload_json AS payloadJson, correlation_id AS correlationId,
          causation_id AS causationId, idempotency_key AS idempotencyKey
         FROM domain_events ${where} ORDER BY recorded_at_utc DESC, rowid DESC LIMIT ?`,
      )
      .all(...params)
      .map((row) => {
        const value = row as Record<string, unknown>;
        const { payloadJson, ...rest } = value;
        return { ...rest, payload: parseJsonValue(payloadJson) };
      });
  }

  recordLlmCall(input: {
    agentId?: string;
    purpose: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    providerInputTokens?: number;
    providerOutputTokens?: number;
    usageSource?: "estimated" | "provider";
    attemptCount: number;
    failedAttemptCount: number;
    providerInputUsageAttemptCount: number;
    providerOutputUsageAttemptCount: number;
    attemptTelemetrySource: "exact" | "inferred";
    latencyMs: number;
    success: boolean;
    errorCode?: string;
    createdAtUtc: string;
  }): void {
    const usageSource =
      input.usageSource ??
      (input.providerInputTokens !== undefined ||
      input.providerOutputTokens !== undefined
        ? "provider"
        : "estimated");
    this.database
      .prepare(
        `INSERT INTO llm_calls(
          id, agent_id, purpose, provider, model, input_tokens, output_tokens,
          provider_input_tokens, provider_output_tokens, usage_source,
          attempt_count, failed_attempt_count,
          provider_input_usage_attempt_count,
          provider_output_usage_attempt_count, attempt_telemetry_source,
          latency_ms, success, error_code, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createEntityId("llmcall"),
        input.agentId ?? null,
        input.purpose,
        input.provider,
        input.model,
        input.inputTokens,
        input.outputTokens,
        input.providerInputTokens ?? null,
        input.providerOutputTokens ?? null,
        usageSource,
        input.attemptCount,
        input.failedAttemptCount,
        input.providerInputUsageAttemptCount,
        input.providerOutputUsageAttemptCount,
        input.attemptTelemetrySource,
        input.latencyMs,
        input.success ? 1 : 0,
        input.errorCode ?? null,
        input.createdAtUtc,
      );
  }

  listLlmCalls(limit = 100): Array<Record<string, unknown>> {
    return this.database
      .prepare(
        `SELECT id, agent_id AS agentId, purpose, provider, model,
          input_tokens AS inputTokens, output_tokens AS outputTokens,
          provider_input_tokens AS providerInputTokens,
          provider_output_tokens AS providerOutputTokens,
          usage_source AS usageSource,
          attempt_count AS attemptCount,
          failed_attempt_count AS failedAttemptCount,
          provider_input_usage_attempt_count AS providerInputUsageAttemptCount,
          provider_output_usage_attempt_count AS providerOutputUsageAttemptCount,
          attempt_telemetry_source AS attemptTelemetrySource,
          latency_ms AS latencyMs, success, error_code AS errorCode,
          created_at_utc AS createdAtUtc
         FROM llm_calls ORDER BY created_at_utc DESC, rowid DESC LIMIT ?`,
      )
      .all(limit)
      .map((row) => ({
        ...(row as Record<string, unknown>),
        success: Boolean((row as SqlRow).success),
      }));
  }

  insertRejectedProposal(input: {
    agentId: string;
    sessionId?: string;
    purpose: string;
    reasonCode: string;
    reasonSummary: string;
    raw: unknown;
    correlationId?: string;
    createdAtUtc: string;
  }): void {
    this.database
      .prepare(
        `INSERT INTO rejected_proposals(
          id, agent_id, session_id, purpose, reason_code, reason_summary,
          raw_json, correlation_id, created_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        createEntityId("rejection"),
        input.agentId,
        input.sessionId ?? null,
        input.purpose,
        input.reasonCode,
        input.reasonSummary,
        JSON.stringify(input.raw ?? null),
        input.correlationId ?? null,
        input.createdAtUtc,
      );
  }

  listRejectedProposals(
    agentId?: string,
    limit = 100,
  ): Array<Record<string, unknown>> {
    const where = agentId ? "WHERE agent_id = ?" : "";
    const params = agentId ? [agentId, limit] : [limit];
    return this.database
      .prepare(
        `SELECT id, agent_id AS agentId, session_id AS sessionId, purpose,
          reason_code AS reasonCode, reason_summary AS reasonSummary,
          raw_json AS rawJson, correlation_id AS correlationId,
          created_at_utc AS createdAtUtc
         FROM rejected_proposals ${where}
         ORDER BY created_at_utc DESC, rowid DESC LIMIT ?`,
      )
      .all(...params)
      .map((row) => {
        const value = row as Record<string, unknown>;
        const { rawJson, ...rest } = value;
        return { ...rest, raw: parseJsonValue(rawJson) };
      });
  }

  getSettings(): Record<string, unknown> {
    const output: Record<string, unknown> = {};
    for (const row of this.database
      .prepare("SELECT key, value_json FROM settings")
      .all() as Array<{
      key: string;
      value_json: string;
    }>) {
      output[row.key] = JSON.parse(row.value_json);
    }
    return output;
  }

  setSettings(values: Record<string, unknown>, nowUtc: string): void {
    const statement = this.database.prepare(
      `INSERT INTO settings(key, value_json, updated_at_utc) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json,
         updated_at_utc = excluded.updated_at_utc`,
    );
    this.transaction(() => {
      for (const [key, value] of Object.entries(values)) {
        statement.run(key, JSON.stringify(value), nowUtc);
      }
    });
  }

  tableCounts(): Record<string, number> {
    const tables = [
      "characters",
      "character_versions",
      "character_sources",
      "sessions",
      "messages",
      "runtime_states",
      "schedule_items",
      "activity_events",
      "memories",
      "proactive_candidates",
      "settlements",
      "domain_events",
      "schedule_negotiations",
      "llm_calls",
    ];
    return Object.fromEntries(
      tables.map((table) => {
        const row = this.database
          .prepare(`SELECT COUNT(*) AS count FROM ${table}`)
          .get() as {
          count: number;
        };
        return [table, row.count];
      }),
    );
  }
}

const GENERIC_HISTORICAL_SCHEDULE_ENTITIES = new Set([
  "书店",
  "公园",
  "咖啡馆",
  "咖啡店",
  "茶馆",
  "餐厅",
  "饭店",
  "影院",
  "电影院",
  "健身房",
  "图书馆",
  "博物馆",
  "展馆",
  "商场",
]);

export function normalizeHistoricalScheduleEntity(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{Z}\s]/gu, "");
}

export function isSpecificHistoricalScheduleEntityText(value: string): boolean {
  const entity = normalizeHistoricalScheduleEntity(value);
  return (
    Array.from(entity).length >= 3 &&
    !GENERIC_HISTORICAL_SCHEDULE_ENTITIES.has(entity)
  );
}

function mapCharacterSummary(row: SqlRow): CharacterSummary {
  return {
    id: String(row.id),
    currentVersion: Number(row.current_version),
    status: String(row.status) as CharacterSpec["status"],
    tier: String(row.tier) as CharacterSpec["tier"],
    name: String(row.name),
    sourceType: String(row.source_type) as CharacterSpec["sourceType"],
    createdAtUtc: String(row.created_at_utc),
    updatedAtUtc: String(row.updated_at_utc),
  };
}

function mapSession(row: SqlRow): StoredSession {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    title: String(row.title),
    createdAtUtc: String(row.created_at_utc),
    updatedAtUtc: String(row.updated_at_utc),
  };
}

function mapMessage(row: SqlRow): StoredMessage {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    agentId: String(row.agent_id),
    role: String(row.role) as StoredMessage["role"],
    content: String(row.content),
    messageKind: String(row.message_kind) as StoredMessage["messageKind"],
    triggerEventId: optionalString(row.trigger_event_id),
    clientMessageId: optionalString(row.client_message_id),
    inReplyToMessageId: optionalString(row.in_reply_to_message_id),
    metadata: recordValue(parseJsonValue(row.metadata_json ?? "{}")),
    createdAtUtc: String(row.created_at_utc),
  };
}

function mapScheduleNegotiation(row: SqlRow): StoredScheduleNegotiation {
  return parseJsonValue(row.record_json) as StoredScheduleNegotiation;
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

function parseJsonValue(value: unknown): unknown {
  const text = optionalString(value);
  if (text === undefined) return undefined;
  return JSON.parse(text) as unknown;
}

function recordValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
