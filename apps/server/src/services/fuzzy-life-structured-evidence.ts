import type { ActionRecord, OutcomeRecord } from "@personasim/contracts";

import type { Database } from "../db/connection.js";

export interface StructuredLifeEvidenceSources {
  messages: readonly {
    id: string;
    agentId: string;
    sessionId?: string;
    role: string;
    kind: string;
    createdAtUtc: string;
  }[];
  events: readonly {
    agentId: string;
    causationId?: string | null;
    recordedAtUtc: string;
    effectiveAtUtc?: string;
    payload: unknown;
  }[];
}

const MAX_SOURCE_IDS = 256;
const MAX_SOURCE_EVENTS = 512;
const preparedQueries = new WeakMap<
  Database,
  {
    messages: ReturnType<Database["prepare"]>;
    events: ReturnType<Database["prepare"]>;
  }
>();

/** Only fetch sources named by the candidate records, never all agent history. */
export function readStructuredLifeEvidenceSources(input: {
  database: Database;
  agentId: string;
  sourceEvidenceIds: readonly string[];
  atUtc: string;
}): StructuredLifeEvidenceSources {
  const sourceIds = [...new Set(input.sourceEvidenceIds)]
    .filter((id) => id.trim() !== "")
    .slice(0, MAX_SOURCE_IDS);
  if (sourceIds.length === 0 || !Number.isFinite(Date.parse(input.atUtc)))
    return { messages: [], events: [] };

  let queries = preparedQueries.get(input.database);
  if (queries === undefined) {
    queries = {
      messages: input.database.prepare(
        `SELECT id, agent_id AS agentId, session_id AS sessionId,
                role, message_kind AS kind, created_at_utc AS createdAtUtc
         FROM messages
         WHERE agent_id = ? AND role = 'system' AND message_kind = 'system_notice'
           AND id IN (SELECT value FROM json_each(?))
         LIMIT ${String(MAX_SOURCE_IDS)}`,
      ),
      events: input.database.prepare(
        `SELECT agent_id AS agentId, causation_id AS causationId,
                recorded_at_utc AS recordedAtUtc, effective_at_utc AS effectiveAtUtc,
                payload_json AS payloadJson
         FROM domain_events
         WHERE agent_id = ? AND recorded_at_utc <= ?
           AND causation_id IN (SELECT value FROM json_each(?))
         ORDER BY recorded_at_utc DESC, rowid DESC
         LIMIT ${String(MAX_SOURCE_EVENTS)}`,
      ),
    };
    preparedQueries.set(input.database, queries);
  }
  const sourceIdsJson = JSON.stringify(sourceIds);
  const messages = queries.messages.all([
    input.agentId,
    sourceIdsJson,
  ]) as StructuredLifeEvidenceSources["messages"];
  if (messages.length === 0) return { messages, events: [] };
  const noticeIdsJson = JSON.stringify(messages.map((message) => message.id));
  const events = (
    queries.events.all([input.agentId, input.atUtc, noticeIdsJson]) as {
      agentId: string;
      causationId: string | null;
      recordedAtUtc: string;
      effectiveAtUtc: string;
      payloadJson: string;
    }[]
  ).flatMap(({ payloadJson, ...event }) => {
    try {
      return [{ ...event, payload: JSON.parse(payloadJson) as unknown }];
    } catch {
      return [];
    }
  });
  return { messages, events };
}

/**
 * A typed observation needs both a system notice and its causally linked event.
 * Merely giving a chat-derived record a source ID cannot bypass text validation.
 */
export function hasStructuredLifeEvidence(
  record: ActionRecord | OutcomeRecord,
  sources: StructuredLifeEvidenceSources | undefined,
  atUtc: string,
): boolean {
  if (
    sources === undefined ||
    !noLaterThan(record.recordedAtUtc, atUtc) ||
    ("actionIds" in record && record.status === "superseded")
  )
    return false;
  return sources.messages.some(
    (message) =>
      record.sourceEvidenceIds.includes(message.id) &&
      message.agentId === record.agentId &&
      message.role === "system" &&
      message.kind === "system_notice" &&
      (record.sessionId === undefined ||
        message.sessionId === record.sessionId) &&
      noLaterThan(message.createdAtUtc, record.recordedAtUtc) &&
      sources.events.some((event) => {
        if (
          event.agentId !== record.agentId ||
          event.causationId !== message.id ||
          !noLaterThan(message.createdAtUtc, event.recordedAtUtc) ||
          !noLaterThan(event.recordedAtUtc, record.recordedAtUtc) ||
          (event.effectiveAtUtc !== undefined &&
            !noLaterThan(event.effectiveAtUtc, record.recordedAtUtc)) ||
          event.payload === null ||
          typeof event.payload !== "object" ||
          Array.isArray(event.payload)
        )
          return false;
        const payload = event.payload as Record<string, unknown>;
        if (payload["decisionId"] !== record.decisionId) return false;
        if (!("actionIds" in record))
          return (
            payload["actionId"] === record.id &&
            payload["outcomeId"] === undefined
          );
        if (payload["outcomeId"] !== record.id) return false;
        const actionIds = payload["actionIds"];
        const observedActions = Array.isArray(actionIds)
          ? actionIds
          : typeof payload["actionId"] === "string"
            ? [payload["actionId"]]
            : undefined;
        return (
          observedActions !== undefined &&
          observedActions.length === record.actionIds.length &&
          new Set(observedActions).size === observedActions.length &&
          observedActions.every(
            (id) => typeof id === "string" && record.actionIds.includes(id),
          ) &&
          (payload["actionId"] === undefined ||
            (record.actionIds.length === 1 &&
              payload["actionId"] === record.actionIds[0]))
        );
      }),
  );
}

function noLaterThan(value: string, latest: string): boolean {
  const time = Date.parse(value);
  const limit = Date.parse(latest);
  return Number.isFinite(time) && Number.isFinite(limit) && time <= limit;
}
