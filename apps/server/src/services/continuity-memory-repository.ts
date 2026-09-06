import { MemorySchema, type Memory } from "@personasim/contracts";

import type { DatabaseStore } from "../db/store.js";

type SqlRow = Record<string, unknown>;

export interface DateDigestFactRow {
  sourceType: string;
  sourceId: string;
  kind: "activity_event" | "shared_memory" | "user_event";
  content: string;
  temporalStatus: "occurred";
  occurredStartAtUtc: string;
  occurredEndAtUtc?: string;
  reliability: "reliable" | "reported";
  sourceEvidenceIds: string[];
}

export interface LifecycleMemoryRecord {
  memory: Memory;
  raw: Record<string, unknown>;
}

export interface LifecycleUserMessageEvidence {
  evidenceId: string;
  sourceId: string;
  content: string;
  quote: string | null;
  createdAtUtc: string;
}

export interface LifecycleMemoryPatch {
  status: Memory["status"];
  updatedAtUtc: string;
  lifecycleUpdatedAtUtc: string;
  supersededById?: string | null;
  mergedIntoId?: string | null;
  lastReinforcedAtUtc?: string;
}

export interface MemoryConflictWrite {
  id: string;
  agentId: string;
  subjectKey: string;
  leftMemoryId: string;
  rightMemoryId: string;
  status: "open" | "resolved";
  resolution?: "superseded" | "merged" | "needs_review" | "dismissed";
  winnerMemoryId?: string;
  reasonCode: string;
  reasonSummary: string;
  evidence: unknown;
  idempotencyKey: string;
  createdAtUtc: string;
  resolvedAtUtc?: string;
}

export interface MemoryMergeHistoryWrite {
  id: string;
  agentId: string;
  targetMemoryId: string;
  sourceMemoryId: string;
  subjectKey?: string;
  reasonCode: string;
  reasonSummary: string;
  sourceSnapshot: unknown;
  targetBefore: unknown;
  targetAfter: unknown;
  evidence: unknown;
  idempotencyKey: string;
  mergedAtUtc: string;
}

export class ContinuityMemoryRepository {
  constructor(readonly store: DatabaseStore) {}

  transaction<T>(work: () => T): T {
    return this.store.transaction(work);
  }

  listDateDigestFacts(input: {
    agentId: string;
    fromUtc: string;
    toUtc: string;
  }): DateDigestFactRow[] {
    const activities = this.store.database
      .prepare(
        `SELECT id, occurred_at_utc, summary
         FROM activity_events
         WHERE agent_id = ? AND occurred_at_utc >= ? AND occurred_at_utc < ?
         ORDER BY occurred_at_utc, rowid`,
      )
      .all(input.agentId, input.fromUtc, input.toUtc) as Array<{
      id: string;
      occurred_at_utc: string;
      summary: string;
    }>;
    const memoryRows = this.store.database
      .prepare(
        `SELECT id, content, namespace, attribution,
          occurred_start_at_utc, occurred_end_at_utc
         FROM memories
         WHERE agent_id = ?
           AND status IN ('active', 'aging')
           AND namespace IN ('shared_relationship', 'user_model')
           AND temporal_status = 'occurred'
           AND certainty = 'explicit'
           AND occurred_start_at_utc IS NOT NULL
           AND occurred_start_at_utc < ?
           AND COALESCE(occurred_end_at_utc, occurred_start_at_utc) >= ?
         ORDER BY occurred_start_at_utc, rowid`,
      )
      .all(input.agentId, input.toUtc, input.fromUtc) as Array<{
      id: string;
      content: string;
      namespace: "shared_relationship" | "user_model";
      attribution: string;
      occurred_start_at_utc: string;
      occurred_end_at_utc: string | null;
    }>;
    const evidenceStatement = this.store.database.prepare(
      `SELECT id FROM memory_evidence
       WHERE memory_id = ? AND source_type IN ('message', 'activity_event')
       ORDER BY recorded_at_utc, id`,
    );
    const memoryFacts: DateDigestFactRow[] = [];
    for (const row of memoryRows) {
      if (
        row.attribution !== "user_explicit" &&
        row.attribution !== "simulation_event" &&
        row.attribution !== "mixed"
      ) {
        continue;
      }
      const evidenceIds = (
        evidenceStatement.all(row.id) as Array<{ id: string }>
      ).map((evidence) => evidence.id);
      if (evidenceIds.length === 0) continue;
      memoryFacts.push({
        sourceType: "memory",
        sourceId: row.id,
        kind:
          row.namespace === "shared_relationship"
            ? "shared_memory"
            : "user_event",
        content: row.content,
        temporalStatus: "occurred",
        occurredStartAtUtc: row.occurred_start_at_utc,
        ...(row.occurred_end_at_utc === null
          ? {}
          : { occurredEndAtUtc: row.occurred_end_at_utc }),
        reliability:
          row.attribution === "simulation_event" ? "reliable" : "reported",
        sourceEvidenceIds: evidenceIds,
      });
    }
    return [
      ...activities.map((row): DateDigestFactRow => ({
        sourceType: "activity_event",
        sourceId: row.id,
        kind: "activity_event",
        content: row.summary,
        temporalStatus: "occurred",
        occurredStartAtUtc: row.occurred_at_utc,
        reliability: "reliable",
        sourceEvidenceIds: [row.id],
      })),
      ...memoryFacts,
    ];
  }

  listLifecycleMemories(agentId: string): LifecycleMemoryRecord[] {
    return (
      this.store.database
        .prepare(
          `SELECT * FROM memories WHERE agent_id = ?
           ORDER BY created_at_utc, rowid`,
        )
        .all(agentId) as SqlRow[]
    ).map(mapLifecycleMemory);
  }

  getLifecycleMemory(memoryId: string): LifecycleMemoryRecord | undefined {
    const row = this.store.database
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(memoryId) as SqlRow | undefined;
    return row === undefined ? undefined : mapLifecycleMemory(row);
  }

  listUserMessageEvidence(memory: Memory): LifecycleUserMessageEvidence[] {
    return (
      this.store.database
        .prepare(
          `SELECT e.id AS evidenceId, m.id AS sourceId, m.content, e.quote,
         m.created_at_utc AS createdAtUtc
       FROM memory_evidence e JOIN messages m ON m.id = e.source_id
       WHERE e.memory_id = ? AND e.source_type = 'message'
         AND m.agent_id = ? AND m.role = 'user'
       ORDER BY m.created_at_utc, e.id`,
        )
        .all(memory.id, memory.agentId) as LifecycleUserMessageEvidence[]
    ).filter(
      (source) =>
        memory.sourceMessageIds.includes(source.sourceId) &&
        (source.quote === null ||
          source.content
            .normalize("NFKC")
            .includes(source.quote.normalize("NFKC"))),
    );
  }

  attachLegacyClaim(
    memoryId: string,
    claim: NonNullable<Memory["claim"]>,
  ): boolean {
    const current = this.getLifecycleMemory(memoryId)?.memory;
    if (current === undefined || current.claim !== undefined) return false;
    const next = MemorySchema.parse({ ...current, claim });
    return (
      this.store.database
        .prepare(
          `UPDATE memories SET claim_subject_key = ?, claim_disposition = ?, memory_json = ?
       WHERE id = ? AND claim_subject_key IS NULL AND claim_disposition IS NULL`,
        )
        .run(
          claim.subjectKey,
          claim.disposition,
          JSON.stringify(next),
          memoryId,
        ).changes === 1
    );
  }

  patchLifecycleMemory(input: {
    memoryId: string;
    expectedStatuses: readonly Memory["status"][];
    patch: LifecycleMemoryPatch;
  }): boolean {
    if (input.expectedStatuses.length === 0) return false;
    const current = this.getLifecycleMemory(input.memoryId);
    if (
      current === undefined ||
      !input.expectedStatuses.includes(current.memory.status)
    ) {
      return false;
    }
    const nextInput: Record<string, unknown> = {
      ...current.memory,
      status: input.patch.status,
      updatedAtUtc: input.patch.updatedAtUtc,
      lifecycleUpdatedAtUtc: input.patch.lifecycleUpdatedAtUtc,
      ...(input.patch.lastReinforcedAtUtc === undefined
        ? {}
        : { lastReinforcedAtUtc: input.patch.lastReinforcedAtUtc }),
    };
    if (input.patch.supersededById === null) {
      delete nextInput["supersededById"];
    } else if (input.patch.supersededById !== undefined) {
      nextInput["supersededById"] = input.patch.supersededById;
    }
    if (input.patch.mergedIntoId === null) {
      delete nextInput["mergedIntoId"];
    } else if (input.patch.mergedIntoId !== undefined) {
      nextInput["mergedIntoId"] = input.patch.mergedIntoId;
    }
    const next = MemorySchema.parse(nextInput);
    const placeholders = input.expectedStatuses.map(() => "?").join(", ");
    const result = this.store.database
      .prepare(
        `UPDATE memories SET status = ?, superseded_by_id = ?,
           merged_into_id = ?, last_reinforced_at_utc = ?,
           lifecycle_updated_at_utc = ?, memory_json = ?
         WHERE id = ? AND status IN (${placeholders})`,
      )
      .run(
        next.status,
        next.supersededById ?? null,
        next.mergedIntoId ?? null,
        next.lastReinforcedAtUtc ?? null,
        next.lifecycleUpdatedAtUtc ?? input.patch.lifecycleUpdatedAtUtc,
        JSON.stringify(next),
        input.memoryId,
        ...input.expectedStatuses,
      );
    return result.changes === 1;
  }

  insertMemoryConflict(conflict: MemoryConflictWrite): boolean {
    return (
      this.store.database
        .prepare(
          `INSERT OR IGNORE INTO memory_conflicts(
            id, agent_id, subject_key, left_memory_id, right_memory_id,
            status, resolution, winner_memory_id, reason_code,
            reason_summary, evidence_json, idempotency_key,
            created_at_utc, resolved_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          conflict.id,
          conflict.agentId,
          conflict.subjectKey,
          conflict.leftMemoryId,
          conflict.rightMemoryId,
          conflict.status,
          conflict.resolution ?? null,
          conflict.winnerMemoryId ?? null,
          conflict.reasonCode,
          conflict.reasonSummary,
          JSON.stringify(conflict.evidence),
          conflict.idempotencyKey,
          conflict.createdAtUtc,
          conflict.resolvedAtUtc ?? null,
        ).changes === 1
    );
  }

  insertMemoryMergeHistory(history: MemoryMergeHistoryWrite): boolean {
    return (
      this.store.database
        .prepare(
          `INSERT OR IGNORE INTO memory_merge_history(
            id, agent_id, target_memory_id, source_memory_id, subject_key,
            reason_code, reason_summary, source_snapshot_json,
            target_before_json, target_after_json, evidence_json,
            idempotency_key, merged_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          history.id,
          history.agentId,
          history.targetMemoryId,
          history.sourceMemoryId,
          history.subjectKey ?? null,
          history.reasonCode,
          history.reasonSummary,
          JSON.stringify(history.sourceSnapshot),
          JSON.stringify(history.targetBefore),
          JSON.stringify(history.targetAfter),
          JSON.stringify(history.evidence),
          history.idempotencyKey,
          history.mergedAtUtc,
        ).changes === 1
    );
  }

  insertDomainEvent(
    input: Parameters<DatabaseStore["insertDomainEvent"]>[0],
  ): boolean {
    return this.store.insertDomainEvent(input);
  }
}

function mapLifecycleMemory(row: SqlRow): LifecycleMemoryRecord {
  const raw = parseObject(row["memory_json"]);
  const temporalMetadata =
    raw["temporalMetadata"] ?? raw["temporal"] ?? temporalFromRow(row);
  const claimSubjectKey = optionalString(row["claim_subject_key"]);
  const claimDisposition = optionalString(row["claim_disposition"]);
  const rawClaim = parseObject(raw["claim"]);
  const claimRevisionIntent = optionalString(rawClaim["revisionIntent"]);
  const claimRecordedAtUtc =
    optionalString(rawClaim["recordedAtUtc"]) ??
    optionalString(row["recorded_at_utc"]) ??
    String(row["created_at_utc"]);
  const input: Record<string, unknown> = {
    ...raw,
    id: String(row["id"]),
    agentId: String(row["agent_id"]),
    kind: normalizeMemoryKind(String(row["type"])),
    content: String(row["content"]),
    importance: Number(row["importance"]),
    confidence: Number(row["confidence"]),
    tags: parseStringArray(row["tags_json"]),
    sourceMessageIds: Array.isArray(raw["sourceMessageIds"])
      ? parseStringArray(raw["sourceMessageIds"])
      : optionalString(row["source_message_id"]) === undefined
        ? []
        : [String(row["source_message_id"])],
    sourceActivityEventIds: Array.isArray(raw["sourceActivityEventIds"])
      ? parseStringArray(raw["sourceActivityEventIds"])
      : optionalString(row["source_event_id"]) === undefined
        ? []
        : [String(row["source_event_id"])],
    origin:
      typeof raw["origin"] === "string" ? raw["origin"] : "runtime_simulation",
    namespace: String(row["namespace"]),
    certainty: String(row["certainty"]),
    attribution: String(row["attribution"]),
    stability: String(row["stability"]),
    status: String(row["status"]),
    dedupeKey:
      typeof raw["dedupeKey"] === "string"
        ? raw["dedupeKey"]
        : `legacy:${String(row["id"])}`,
    ...(claimSubjectKey === undefined || claimDisposition === undefined
      ? {}
      : {
          claim: {
            subjectKey: claimSubjectKey,
            disposition: claimDisposition,
            recordedAtUtc: claimRecordedAtUtc,
            ...(claimRevisionIntent === undefined
              ? {}
              : { revisionIntent: claimRevisionIntent }),
          },
        }),
    ...(optionalString(row["valid_until_utc"]) === undefined
      ? {}
      : { expiresAtUtc: String(row["valid_until_utc"]) }),
    ...(temporalMetadata === undefined ? {} : { temporalMetadata }),
    ...(optionalString(row["superseded_by_id"]) === undefined
      ? {}
      : { supersededById: String(row["superseded_by_id"]) }),
    ...(optionalString(row["merged_into_id"]) === undefined
      ? {}
      : { mergedIntoId: String(row["merged_into_id"]) }),
    ...(optionalString(row["last_reinforced_at_utc"]) === undefined
      ? {}
      : { lastReinforcedAtUtc: String(row["last_reinforced_at_utc"]) }),
    ...(optionalString(row["lifecycle_updated_at_utc"]) === undefined
      ? {}
      : { lifecycleUpdatedAtUtc: String(row["lifecycle_updated_at_utc"]) }),
    createdAtUtc: String(row["created_at_utc"]),
    updatedAtUtc:
      typeof raw["updatedAtUtc"] === "string"
        ? raw["updatedAtUtc"]
        : String(row["created_at_utc"]),
  };
  delete input["temporal"];
  if (
    input["occurredAtUtc"] === undefined &&
    isObject(temporalMetadata) &&
    temporalMetadata["temporalStatus"] === "occurred" &&
    typeof temporalMetadata["occurredStartAtUtc"] === "string"
  ) {
    input["occurredAtUtc"] = temporalMetadata["occurredStartAtUtc"];
  }
  const memory = MemorySchema.parse(input);
  return { memory, raw };
}

function temporalFromRow(row: SqlRow): Record<string, unknown> | undefined {
  const recordedAtUtc = optionalString(row["recorded_at_utc"]);
  if (recordedAtUtc === undefined) return undefined;
  return {
    ...(optionalString(row["mentioned_at_utc"]) === undefined
      ? {}
      : { mentionedAtUtc: String(row["mentioned_at_utc"]) }),
    ...(optionalString(row["planned_start_at_utc"]) === undefined
      ? {}
      : { plannedStartAtUtc: String(row["planned_start_at_utc"]) }),
    ...(optionalString(row["planned_end_at_utc"]) === undefined
      ? {}
      : { plannedEndAtUtc: String(row["planned_end_at_utc"]) }),
    ...(optionalString(row["occurred_start_at_utc"]) === undefined
      ? {}
      : { occurredStartAtUtc: String(row["occurred_start_at_utc"]) }),
    ...(optionalString(row["occurred_end_at_utc"]) === undefined
      ? {}
      : { occurredEndAtUtc: String(row["occurred_end_at_utc"]) }),
    recordedAtUtc,
    temporalCertainty: String(row["temporal_certainty"]),
    temporalStatus: String(row["temporal_status"]),
  };
}

function normalizeMemoryKind(value: string): Memory["kind"] {
  return value === "semantic" ||
    value === "relationship" ||
    value === "commitment"
    ? value
    : "episodic";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(value: unknown): Record<string, unknown> {
  const parsed = parseJson(value);
  return isObject(parsed) ? parsed : {};
}

function parseStringArray(value: unknown): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === "string")
    : [];
}
