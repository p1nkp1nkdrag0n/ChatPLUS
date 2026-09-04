import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import {
  EntityIdSchema,
  IanaTimezoneSchema,
  RelationshipArchivePageResponseSchema,
  RelationshipArchiveQuerySchema,
  RelationshipRecapSchema,
  RelationshipShareProjectionSchema,
  ShareComposerSelectionSchema,
  UtcDateTimeSchema,
  type RelationshipArchiveEntry,
  type RelationshipArchiveFilter,
  type RelationshipArchiveKeepsakeEntry,
  type RelationshipArchivePageResponse,
  type RelationshipArchiveQuery,
  type RelationshipRecap,
  type RelationshipRecapItem,
  type RelationshipShareEnvelope,
  type RelationshipShareKeepsake,
  type RelationshipShareProjection,
  type ShareComposerSelection,
} from "@personasim/contracts";
import { canonicalLetterContent } from "@personasim/features";
import { DateTime } from "luxon";

import type { Database } from "../db/connection.js";
import { registerFuzzyLifeEffectiveAtSqlFunction } from "../domain/fuzzy-life-effective-time.js";
import type { Clock } from "../runtime/clock.js";
import type { CorrespondenceCryptoService } from "./correspondence-crypto-service.js";

const CURSOR_VERSION = 1;
const MAX_ARCHIVE_LIMIT = 100;
const MAX_RECAP_LIMIT = 40;

export type RelationshipArchiveErrorCode =
  | "not_found"
  | "invalid_archive_cursor"
  | "share_source_not_allowed"
  | "share_excerpt_mismatch"
  | "archive_integrity_error";

export class RelationshipArchiveError extends Error {
  constructor(
    public readonly code: RelationshipArchiveErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RelationshipArchiveError";
  }
}

interface ArchiveCursor {
  readonly version: 1;
  readonly filter: RelationshipArchiveFilter;
  readonly effectiveAtUtc: string;
  readonly cursorId: string;
}

interface ArchiveRow {
  cursor_id: string;
  source_kind:
    | "letter"
    | "relationship_milestone"
    | "life_outcome"
    | "reflection"
    | "domain_event"
    | "keepsake";
  source_id: string;
  agent_id: string;
  effective_at_utc: string;
  recorded_at_utc: string;
  title: string;
  summary: string;
  significance: number | null;
  thread_id: string | null;
  direction: string | null;
  status: string | null;
  preview_text: string | null;
  transit_timezone: string | null;
  dispatched_at_utc: string | null;
  arrival_due_at_utc: string | null;
  period_label: string | null;
  keepsake_kind: string | null;
}

interface LetterShareRow {
  id: string;
  agent_id: string;
  direction: "user_to_agent" | "agent_to_user";
  status: string;
  subject: string | null;
  body: string | null;
  content_hash: string | null;
  encrypted_ciphertext: string | null;
  encrypted_iv: string | null;
  encrypted_auth_tag: string | null;
  encrypted_key_version: number | null;
  encrypted_aad_hash: string | null;
  encrypted_created_at_utc: string | null;
  transit_timezone: string | null;
  dispatched_at_utc: string | null;
  arrival_due_at_utc: string | null;
  effective_author_time_utc: string | null;
}

interface KeepsakeShareRow {
  id: string;
  agent_id: string;
  title: string;
  kind: string;
  status: string;
  primary_asset_id: string | null;
}

const ARCHIVE_QUERY = `
WITH archive AS (
  SELECT
    'letter:' || letter.id AS cursor_id,
    'letter' AS source_kind,
    letter.id AS source_id,
    letter.agent_id,
    CASE
      WHEN letter.direction = 'agent_to_user'
        THEN letter.delivered_effective_at_utc
      ELSE COALESCE(letter.dispatched_at_utc, letter.effective_author_time_utc)
    END AS effective_at_utc,
    letter.created_at_utc AS recorded_at_utc,
    CASE
      WHEN letter.direction = 'agent_to_user'
        AND letter.status = 'delivered_unread'
        THEN '一封尚未启封的回信'
      WHEN letter.direction = 'agent_to_user' THEN '一封已启封的回信'
      ELSE COALESCE(NULLIF(trim(letter.subject), ''), '一封寄出的信')
    END AS title,
    CASE
      WHEN letter.direction = 'agent_to_user'
        AND letter.status = 'delivered_unread'
        THEN '回信已经抵达，仍保持封缄。'
      WHEN letter.direction = 'agent_to_user'
        THEN '这封回信已由你亲自启封。'
      ELSE '这是你在关系中写下并寄出的信。'
    END AS summary,
    NULL AS significance,
    letter.thread_id,
    letter.direction,
    letter.status,
    CASE WHEN letter.direction = 'user_to_agent' THEN letter.body ELSE NULL END
      AS preview_text,
    letter.transit_timezone,
    letter.dispatched_at_utc,
    letter.arrival_due_at_utc,
    NULL AS period_label,
    NULL AS keepsake_kind
  FROM letters letter
  WHERE @includeLetters = 1
    AND letter.agent_id = @agentId
    AND letter.status IN ('sealed', 'in_transit', 'delivered_unread', 'read')
    AND (
      letter.direction = 'user_to_agent'
      OR letter.status IN ('delivered_unread', 'read')
    )

  UNION ALL

  SELECT
    'relationship_milestone:' || milestone.id,
    'relationship_milestone',
    milestone.id,
    milestone.agent_id,
    fuzzy_life_effective_at_utc(
      milestone.effective_local_date,
      milestone.effective_period,
      milestone.temporal_precision,
      @characterTimezone
    ),
    milestone.recorded_at_utc,
    milestone.title,
    milestone.summary,
    milestone.significance,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    milestone.effective_local_date,
    NULL
  FROM relationship_milestones milestone
  WHERE @includeTurning = 1 AND milestone.agent_id = @agentId

  UNION ALL

  SELECT
    'outcome_record:' || outcome.id,
    'life_outcome',
    outcome.id,
    outcome.agent_id,
    fuzzy_life_effective_at_utc(
      outcome.effective_local_date,
      outcome.effective_period,
      outcome.temporal_precision,
      @characterTimezone
    ),
    outcome.recorded_at_utc,
    '一次结果',
    outcome.summary,
    outcome.confidence,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    outcome.effective_local_date,
    NULL
  FROM outcome_records outcome
  WHERE @includeTurning = 1
    AND outcome.agent_id = @agentId
    AND outcome.status IN ('observed', 'confirmed')

  UNION ALL

  SELECT
    'life_outcome:' || outcome.id,
    'life_outcome',
    outcome.id,
    outcome.agent_id,
    fuzzy_life_effective_at_utc(
      outcome.effective_local_date,
      outcome.effective_period,
      outcome.temporal_precision,
      @characterTimezone
    ),
    outcome.recorded_at_utc,
    '一段生活有了结果',
    outcome.summary,
    outcome.importance,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    outcome.effective_local_date,
    NULL
  FROM life_outcomes outcome
  WHERE @includeTurning = 1 AND outcome.agent_id = @agentId

  UNION ALL

  SELECT
    'reflection:' || reflection.id,
    'reflection',
    reflection.id,
    reflection.agent_id,
    fuzzy_life_effective_at_utc(
      reflection.effective_local_date,
      reflection.effective_period,
      reflection.temporal_precision,
      @characterTimezone
    ),
    reflection.recorded_at_utc,
    CASE WHEN reflection.changed_interpretation = 1
      THEN '一次改变理解的回望' ELSE '一次回望' END,
    reflection.summary,
    CASE WHEN reflection.changed_interpretation = 1 THEN 0.75 ELSE 0.55 END,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    reflection.effective_local_date,
    NULL
  FROM reflection_records reflection
  WHERE @includeTurning = 1 AND reflection.agent_id = @agentId

  UNION ALL

  SELECT
    'domain_event:' || event.id,
    'domain_event',
    event.id,
    event.agent_id,
    event.effective_at_utc,
    event.recorded_at_utc,
    event.event_type,
    '这项变化已记录在关系时间线中。',
    NULL,
    NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    substr(event.effective_at_utc, 1, 10),
    NULL
  FROM domain_events event
  WHERE @includeLife = 1
    AND event.agent_id = @agentId
    AND event.stream_type NOT IN (
      'correspondence_letter', 'correspondence_thread', 'keepsake'
    )

  UNION ALL

  SELECT
    'keepsake:' || keepsake.id,
    'keepsake',
    keepsake.id,
    keepsake.agent_id,
    keepsake.created_effective_at_utc,
    keepsake.created_at_utc,
    keepsake.title,
    keepsake.description,
    NULL,
    NULL, NULL, keepsake.status, NULL, NULL, NULL, NULL,
    substr(keepsake.created_effective_at_utc, 1, 10),
    keepsake.kind
  FROM keepsakes keepsake
  WHERE @includeKeepsakes = 1
    AND keepsake.agent_id = @agentId
    AND keepsake.status = 'ready'
)
SELECT *
FROM archive
WHERE effective_at_utc IS NOT NULL
  AND effective_at_utc <= @throughUtc
  AND (@fromUtc IS NULL OR effective_at_utc >= @fromUtc)
  AND (@entryId IS NULL OR cursor_id = @entryId)
  AND (
    @cursorEffectiveAtUtc IS NULL
    OR effective_at_utc < @cursorEffectiveAtUtc
    OR (
      effective_at_utc = @cursorEffectiveAtUtc
      AND cursor_id < @cursorId
    )
  )
ORDER BY effective_at_utc DESC, cursor_id DESC
LIMIT @limit
`;

export class RelationshipArchiveService {
  constructor(
    private readonly database: Database,
    private readonly clock: Clock,
    private readonly crypto?: CorrespondenceCryptoService,
  ) {
    registerFuzzyLifeEffectiveAtSqlFunction(database);
  }

  listPage(
    agentId: string,
    input: Partial<RelationshipArchiveQuery> = {},
  ): RelationshipArchivePageResponse {
    assertEntityId(agentId);
    const characterTimezone = this.requireCharacterTimezone(agentId);
    const query = RelationshipArchiveQuerySchema.parse(input);
    const cursor =
      query.cursor === undefined
        ? undefined
        : decodeArchiveCursor(query.cursor, query.filter);
    const rows = this.selectRows({
      agentId,
      characterTimezone,
      filter: query.filter,
      limit: query.entryId === undefined ? query.limit + 1 : 1,
      throughUtc: this.clock.nowUtc(),
      ...(query.entryId === undefined ? {} : { entryId: query.entryId }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    const hasNext = query.entryId === undefined && rows.length > query.limit;
    const pageRows = hasNext ? rows.slice(0, query.limit) : rows;
    const last = pageRows.at(-1);
    return RelationshipArchivePageResponseSchema.parse({
      items: pageRows.map((row) =>
        this.mapArchiveEntry(row, query.includePreviewText),
      ),
      ...(hasNext && last !== undefined
        ? {
            nextCursor: encodeArchiveCursor({
              version: CURSOR_VERSION,
              filter: query.filter,
              effectiveAtUtc: last.effective_at_utc,
              cursorId: last.cursor_id,
            }),
          }
        : {}),
      serverTimeUtc: this.clock.nowUtc(),
    });
  }

  buildRecap(input: {
    agentId: string;
    fromUtc: string;
    toUtc: string;
    limit?: number;
  }): RelationshipRecap {
    assertEntityId(input.agentId);
    assertUtc(input.fromUtc);
    assertUtc(input.toUtc);
    if (Date.parse(input.fromUtc) >= Date.parse(input.toUtc)) {
      throw new RelationshipArchiveError(
        "archive_integrity_error",
        "A relationship recap period must increase",
      );
    }
    const characterTimezone = this.requireCharacterTimezone(input.agentId);
    const limit = Math.max(
      1,
      Math.min(MAX_RECAP_LIMIT, Math.trunc(input.limit ?? 20)),
    );
    const throughUtc =
      Date.parse(input.toUtc) < Date.parse(this.clock.nowUtc())
        ? input.toUtc
        : this.clock.nowUtc();
    const rows = this.selectRows({
      agentId: input.agentId,
      characterTimezone,
      filter: "all",
      limit,
      fromUtc: input.fromUtc,
      throughUtc,
    });
    const items = rows.map((row) => this.mapRecapItem(row));
    if (items.length === 0) {
      throw new RelationshipArchiveError(
        "not_found",
        "No durable relationship evidence exists in that period",
      );
    }
    return this.validateRecapProjection(
      RelationshipRecapSchema.parse({
        version: "relationship_recap_v1",
        agentId: input.agentId,
        periodStartUtc: input.fromUtc,
        periodEndUtc: input.toUtc,
        items,
        generatedAtUtc: this.clock.nowUtc(),
      }),
    );
  }

  validateRecapProjection(recap: RelationshipRecap): RelationshipRecap {
    const parsed = RelationshipRecapSchema.parse(recap);
    this.requireCharacter(parsed.agentId);
    for (const item of parsed.items) {
      for (const sourceId of item.sourceIds) {
        if (!this.sourceExists(parsed.agentId, item.sourceType, sourceId)) {
          throw new RelationshipArchiveError(
            "archive_integrity_error",
            "A recap item cites evidence that does not belong to this relationship",
          );
        }
      }
    }
    return parsed;
  }

  buildShareProjection(
    agentId: string,
    selectionInput: ShareComposerSelection,
  ): RelationshipShareProjection {
    assertEntityId(agentId);
    this.requireCharacter(agentId);
    const selection = ShareComposerSelectionSchema.parse(selectionInput);
    const sourceIds: string[] = [];
    let envelope: RelationshipShareEnvelope | undefined;
    let keepsake: RelationshipShareKeepsake | undefined;
    let redactedExcerpt: string | undefined;

    const needsLetter =
      selection.letterId !== undefined &&
      (selection.includeEnvelope ||
        selection.includePostmark ||
        selection.includeWaitingDays ||
        selection.includeExcerpt);
    if (needsLetter && selection.letterId !== undefined) {
      const letter = this.requireShareLetter(agentId, selection.letterId);
      sourceIds.push(letter.id);
      if (
        selection.includeEnvelope ||
        selection.includePostmark ||
        selection.includeWaitingDays
      ) {
        envelope = {
          letterId: letter.id,
          direction: letter.direction,
          status: letter.status as RelationshipShareEnvelope["status"],
          envelope: selection.includeEnvelope,
          ...(selection.includePostmark
            ? { postmark: formatPostmark(letter) }
            : {}),
          ...(selection.includeWaitingDays
            ? { waitingDays: calculateWaitingDays(letter) }
            : {}),
        };
      }
      if (selection.includeExcerpt) {
        const sourceBody = this.readShareableLetterBody(letter);
        const excerpt = selection.excerpt;
        if (excerpt === undefined || !sourceBody.includes(excerpt)) {
          throw new RelationshipArchiveError(
            "share_excerpt_mismatch",
            "The selected excerpt is not an exact part of the selected letter",
          );
        }
        redactedExcerpt = applyRedactions(excerpt, selection.redactions);
      }
    }

    if (selection.includeKeepsake) {
      if (selection.keepsakeId === undefined) {
        throw new RelationshipArchiveError(
          "share_source_not_allowed",
          "A local share projection requires an explicitly selected keepsake",
        );
      }
      const row = this.database
        .prepare(
          `SELECT id, agent_id, title, kind, status, primary_asset_id
           FROM keepsakes WHERE id = ? AND agent_id = ?`,
        )
        .get(selection.keepsakeId, agentId) as KeepsakeShareRow | undefined;
      if (
        row === undefined ||
        row.status !== "ready" ||
        row.primary_asset_id === null
      ) {
        throw new RelationshipArchiveError(
          "share_source_not_allowed",
          "Only a ready keepsake from this relationship may be shared",
        );
      }
      sourceIds.push(row.id);
      keepsake = {
        keepsakeId: row.id,
        title: row.title,
        kind: row.kind as RelationshipShareKeepsake["kind"],
        assetUrl: `/api/keepsakes/${encodeURIComponent(row.id)}/asset`,
      };
    }

    const uniqueSourceIds = [...new Set(sourceIds)];
    if (uniqueSourceIds.length === 0) {
      throw new RelationshipArchiveError(
        "share_source_not_allowed",
        "A local share projection requires an explicit letter or keepsake",
      );
    }
    return RelationshipShareProjectionSchema.parse({
      version: "relationship_share_projection_v1",
      templateVersion: selection.templateVersion,
      exportMode: "local_png",
      agentId,
      generatedAtUtc: this.clock.nowUtc(),
      ...(envelope === undefined ? {} : { envelope }),
      ...(keepsake === undefined ? {} : { keepsake }),
      ...(redactedExcerpt === undefined ? {} : { redactedExcerpt }),
      sourceIds: uniqueSourceIds,
    });
  }

  private selectRows(input: {
    agentId: string;
    characterTimezone: string;
    filter: RelationshipArchiveFilter;
    limit: number;
    throughUtc: string;
    fromUtc?: string;
    cursor?: ArchiveCursor;
    entryId?: string;
  }): ArchiveRow[] {
    const include = archiveFilterFlags(input.filter);
    const limit = Math.max(
      1,
      Math.min(MAX_ARCHIVE_LIMIT + 1, Math.trunc(input.limit)),
    );
    return this.database.prepare(ARCHIVE_QUERY).all({
      agentId: input.agentId,
      characterTimezone: input.characterTimezone,
      ...include,
      throughUtc: input.throughUtc,
      fromUtc: input.fromUtc ?? null,
      entryId: input.entryId ?? null,
      cursorEffectiveAtUtc: input.cursor?.effectiveAtUtc ?? null,
      cursorId: input.cursor?.cursorId ?? null,
      limit,
    }) as ArchiveRow[];
  }

  private mapArchiveEntry(
    row: ArchiveRow,
    includePreviewText: boolean,
  ): RelationshipArchiveEntry {
    const base = {
      id: row.source_id,
      agentId: row.agent_id,
      title: truncateRequired(row.title, 240),
      summary: truncateRequired(row.summary, 2_000),
      effectiveAtUtc: row.effective_at_utc,
      recordedAtUtc: row.recorded_at_utc,
      sourceIds: [row.source_id],
    };
    if (row.source_kind === "letter") {
      const direction = required(row.direction, "letter direction");
      const status = required(row.status, "letter status");
      const threadId = required(row.thread_id, "letter thread");
      const previewText =
        includePreviewText &&
        direction === "user_to_agent" &&
        row.preview_text !== null
          ? truncateOptional(row.preview_text, 240)
          : undefined;
      return {
        ...base,
        entryType: "letter",
        href: `/letters/${encodeURIComponent(row.source_id)}?agentId=${encodeURIComponent(row.agent_id)}`,
        letterId: row.source_id,
        threadId,
        direction: direction as "user_to_agent" | "agent_to_user",
        status: status as "sealed" | "in_transit" | "delivered_unread" | "read",
        postmark: formatPostmark(row),
        waitingDays: calculateWaitingDays(row),
        ...(previewText === undefined ? {} : { previewText }),
      };
    }
    if (row.source_kind === "keepsake") {
      return {
        ...base,
        entryType: "keepsake",
        href: `/keepsakes/${encodeURIComponent(row.source_id)}`,
        keepsakeId: row.source_id,
        keepsakeKind: required(
          row.keepsake_kind,
          "keepsake kind",
        ) as RelationshipArchiveKeepsakeEntry["keepsakeKind"],
        thumbnailUrl: `/api/keepsakes/${encodeURIComponent(row.source_id)}/thumbnail`,
      };
    }
    if (row.source_kind === "domain_event") {
      return {
        ...base,
        entryType: "life",
        href: sourceHref(row.agent_id, row.cursor_id),
        periodLabel: required(row.period_label, "domain event period"),
      };
    }
    return {
      ...base,
      entryType: "turning_point",
      href: sourceHref(row.agent_id, row.cursor_id),
      sourceType: row.source_kind,
      significance: row.significance ?? 0.5,
    };
  }

  private mapRecapItem(row: ArchiveRow): RelationshipRecapItem {
    return {
      title: truncateRequired(row.title, 240),
      summary: truncateRequired(row.summary, 1_000),
      sourceType: row.source_kind,
      sourceIds: [row.source_id],
    };
  }

  private requireShareLetter(
    agentId: string,
    letterId: string,
  ): LetterShareRow {
    const row = this.database
      .prepare("SELECT * FROM letters WHERE id = ? AND agent_id = ?")
      .get(letterId, agentId) as LetterShareRow | undefined;
    if (
      row === undefined ||
      row.status === "draft" ||
      row.status === "cancelled"
    ) {
      throw new RelationshipArchiveError(
        "share_source_not_allowed",
        "The selected letter does not belong to the shareable relationship archive",
      );
    }
    return row;
  }

  private readShareableLetterBody(letter: LetterShareRow): string {
    if (letter.direction === "user_to_agent") {
      if (
        letter.body === null ||
        letter.content_hash === null ||
        createHash("sha256")
          .update(
            canonicalLetterContent({
              ...(letter.subject === null ? {} : { subject: letter.subject }),
              body: letter.body,
            }),
            "utf8",
          )
          .digest("hex") !== letter.content_hash
      ) {
        throw archiveIntegrityError();
      }
      return letter.body;
    }
    if (letter.status !== "read") {
      throw new RelationshipArchiveError(
        "share_source_not_allowed",
        "An unopened agent reply cannot be used as an excerpt source",
      );
    }
    if (
      this.crypto === undefined ||
      letter.content_hash === null ||
      letter.arrival_due_at_utc === null ||
      letter.effective_author_time_utc === null ||
      letter.encrypted_ciphertext === null ||
      letter.encrypted_iv === null ||
      letter.encrypted_auth_tag === null ||
      letter.encrypted_key_version === null ||
      letter.encrypted_aad_hash === null ||
      letter.encrypted_created_at_utc === null
    ) {
      throw archiveIntegrityError();
    }
    return this.crypto
      .decryptReply({
        letterId: letter.id,
        direction: "agent_to_user",
        contentHash: letter.content_hash,
        authoredEffectiveAtUtc: letter.effective_author_time_utc,
        arrivalDueAtUtc: letter.arrival_due_at_utc,
        encryptedBody: {
          letterId: letter.id,
          ciphertext: letter.encrypted_ciphertext,
          iv: letter.encrypted_iv,
          authTag: letter.encrypted_auth_tag,
          keyVersion: letter.encrypted_key_version,
          aadHash: letter.encrypted_aad_hash,
          createdAtUtc: letter.encrypted_created_at_utc,
        },
      })
      .paragraphs.join("\n\n");
  }

  private sourceExists(
    agentId: string,
    sourceType: RelationshipRecapItem["sourceType"],
    sourceId: string,
  ): boolean {
    const table =
      sourceType === "letter"
        ? "letters"
        : sourceType === "keepsake"
          ? "keepsakes"
          : sourceType === "relationship_milestone"
            ? "relationship_milestones"
            : sourceType === "reflection"
              ? "reflection_records"
              : sourceType === "domain_event"
                ? "domain_events"
                : undefined;
    if (table !== undefined) {
      return (
        this.database
          .prepare(`SELECT 1 FROM ${table} WHERE id = ? AND agent_id = ?`)
          .get(sourceId, agentId) !== undefined
      );
    }
    return (
      this.database
        .prepare(
          `SELECT 1 FROM outcome_records WHERE id = ? AND agent_id = ?
           UNION ALL
           SELECT 1 FROM life_outcomes WHERE id = ? AND agent_id = ?
           LIMIT 1`,
        )
        .get(sourceId, agentId, sourceId, agentId) !== undefined
    );
  }

  private requireCharacter(agentId: string): void {
    if (
      this.database
        .prepare("SELECT 1 FROM characters WHERE id = ?")
        .get(agentId) === undefined
    ) {
      throw new RelationshipArchiveError(
        "not_found",
        "The relationship archive was not found",
      );
    }
  }

  private requireCharacterTimezone(agentId: string): string {
    const row = this.database
      .prepare(
        `SELECT json_extract(version.spec_json, '$.identity.timezone') AS timezone
           FROM characters character
           JOIN character_versions version
             ON version.character_id = character.id
            AND version.version = character.current_version
          WHERE character.id = ?`,
      )
      .get(agentId) as { timezone: unknown } | undefined;
    if (row === undefined) {
      this.requireCharacter(agentId);
      throw archiveIntegrityError();
    }
    const parsed = IanaTimezoneSchema.safeParse(row.timezone);
    if (!parsed.success) throw archiveIntegrityError();
    return parsed.data;
  }
}

function archiveFilterFlags(filter: RelationshipArchiveFilter): {
  includeLetters: 0 | 1;
  includeTurning: 0 | 1;
  includeLife: 0 | 1;
  includeKeepsakes: 0 | 1;
} {
  return {
    includeLetters: filter === "all" || filter === "correspondence" ? 1 : 0,
    includeTurning: filter === "all" || filter === "turning_points" ? 1 : 0,
    includeLife: filter === "all" || filter === "life" ? 1 : 0,
    includeKeepsakes: filter === "all" || filter === "keepsakes" ? 1 : 0,
  };
}

function encodeArchiveCursor(cursor: ArchiveCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeArchiveCursor(
  value: string,
  expectedFilter: RelationshipArchiveFilter,
): ArchiveCursor {
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as unknown;
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      !("version" in decoded) ||
      decoded.version !== CURSOR_VERSION ||
      !("filter" in decoded) ||
      decoded.filter !== expectedFilter ||
      !("effectiveAtUtc" in decoded) ||
      !UtcDateTimeSchema.safeParse(decoded.effectiveAtUtc).success ||
      !("cursorId" in decoded) ||
      typeof decoded.cursorId !== "string" ||
      decoded.cursorId.length === 0 ||
      decoded.cursorId.length > 300
    ) {
      throw new Error("invalid cursor payload");
    }
    return decoded as ArchiveCursor;
  } catch {
    throw new RelationshipArchiveError(
      "invalid_archive_cursor",
      "The relationship archive cursor is invalid or belongs to another filter",
    );
  }
}

function sourceHref(agentId: string, entryId: string): string {
  return `/characters/${encodeURIComponent(agentId)}/relationship-archive?entryId=${encodeURIComponent(entryId)}`;
}

function formatPostmark(input: {
  dispatched_at_utc: string | null;
  transit_timezone: string | null;
}): string {
  if (input.dispatched_at_utc === null || input.transit_timezone === null) {
    return "未记录邮戳";
  }
  const local = DateTime.fromISO(input.dispatched_at_utc, {
    zone: "utc",
  }).setZone(input.transit_timezone);
  if (!local.isValid) throw archiveIntegrityError();
  return `${local.toFormat("yyyy-LL-dd")} · ${input.transit_timezone}`;
}

function calculateWaitingDays(input: {
  dispatched_at_utc: string | null;
  arrival_due_at_utc: string | null;
  transit_timezone: string | null;
}): number {
  if (
    input.dispatched_at_utc === null ||
    input.arrival_due_at_utc === null ||
    input.transit_timezone === null
  ) {
    return 0;
  }
  const dispatched = DateTime.fromISO(input.dispatched_at_utc, {
    zone: "utc",
  })
    .setZone(input.transit_timezone)
    .startOf("day");
  const due = DateTime.fromISO(input.arrival_due_at_utc, { zone: "utc" })
    .setZone(input.transit_timezone)
    .startOf("day");
  if (!dispatched.isValid || !due.isValid) throw archiveIntegrityError();
  return Math.max(0, Math.round(due.diff(dispatched, "days").days));
}

function applyRedactions(
  excerpt: string,
  redactions: readonly { start: number; end: number }[],
): string {
  let result = "";
  let offset = 0;
  for (const redaction of redactions) {
    if (
      redaction.start < offset ||
      redaction.end > excerpt.length ||
      redaction.start >= redaction.end
    ) {
      throw new RelationshipArchiveError(
        "share_source_not_allowed",
        "A redaction range is outside the selected excerpt",
      );
    }
    result += excerpt.slice(offset, redaction.start);
    result += "█".repeat(redaction.end - redaction.start);
    offset = redaction.end;
  }
  return result + excerpt.slice(offset);
}

function assertEntityId(value: string): void {
  if (!EntityIdSchema.safeParse(value).success) {
    throw new RelationshipArchiveError(
      "not_found",
      "The relationship archive was not found",
    );
  }
}

function assertUtc(value: string): void {
  if (!UtcDateTimeSchema.safeParse(value).success) {
    throw new RelationshipArchiveError(
      "archive_integrity_error",
      "The relationship archive time range is invalid",
    );
  }
}

function required<T>(value: T | null, name: string): T {
  if (value === null) {
    throw new RelationshipArchiveError(
      "archive_integrity_error",
      `The persisted ${name} is missing`,
    );
  }
  return value;
}

function truncateRequired(value: string, max: number): string {
  const trimmed = value.trim();
  return (trimmed.length === 0 ? "已记录的关系片段" : trimmed).slice(0, max);
}

function truncateOptional(value: string, max: number): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed.slice(0, max);
}

function archiveIntegrityError(): RelationshipArchiveError {
  return new RelationshipArchiveError(
    "archive_integrity_error",
    "The selected relationship evidence failed its integrity check",
  );
}
