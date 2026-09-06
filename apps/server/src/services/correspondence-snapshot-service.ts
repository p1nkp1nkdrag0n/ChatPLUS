import { createHash } from "node:crypto";

import {
  CharacterSpecSchema,
  CorrespondenceJsonObjectSchema,
  EntityIdSchema,
  JsonValueSchema,
  LetterGenerationContextV1Schema,
  RuntimeStateSchema,
  UtcDateTimeSchema,
  type JsonValue,
  type Letter,
  type LetterGenerationContextV1,
  type LetterGenerationSnapshot,
  type TemporalTask,
} from "@personasim/contracts";
import {
  canonicalCorrespondenceJson,
  canonicalLetterGenerationSnapshot,
} from "@personasim/features";
import { DateTime } from "luxon";

import type { Database } from "../db/connection.js";
import type { DatabaseStore } from "../db/store.js";
import { registerFuzzyLifeEffectiveAtSqlFunction } from "../domain/fuzzy-life-effective-time.js";
import {
  CorrespondenceRepository,
  type LetterWithEncryptedBody,
} from "../repositories/correspondence-repository.js";
import type {
  ExternalTemporalTaskContext,
  OutboundArrivalHandlerMode,
  OutboundArrivalTaskHandler,
} from "./temporal-catch-up-service.js";

export interface CorrespondenceSnapshotBudgets {
  readonly dailyLifeIntents: number;
  readonly personalIntentions: number;
  readonly scheduleItems: number;
  readonly lifeThreads: number;
  readonly verifiedLifeOutcomes: number;
  readonly dilemmas: number;
  readonly pressureEpisodes: number;
  readonly supportInterventions: number;
  readonly decisions: number;
  readonly actions: number;
  readonly outcomes: number;
  readonly reflections: number;
  readonly relationshipMilestones: number;
  readonly intervalActivityEvents: number;
  readonly intervalLifeOutcomes: number;
  readonly memoryRecords: number;
  readonly eventCards: number;
  readonly conversationMessages: number;
  readonly priorLetters: number;
  readonly readyKeepsakes: number;
}

export const DEFAULT_CORRESPONDENCE_SNAPSHOT_BUDGETS = Object.freeze({
  dailyLifeIntents: 12,
  personalIntentions: 8,
  scheduleItems: 12,
  lifeThreads: 12,
  verifiedLifeOutcomes: 16,
  dilemmas: 8,
  pressureEpisodes: 8,
  supportInterventions: 8,
  decisions: 8,
  actions: 12,
  outcomes: 12,
  reflections: 8,
  relationshipMilestones: 8,
  intervalActivityEvents: 20,
  intervalLifeOutcomes: 20,
  memoryRecords: 24,
  eventCards: 16,
  conversationMessages: 40,
  priorLetters: 20,
  readyKeepsakes: 12,
} satisfies CorrespondenceSnapshotBudgets);

export type CorrespondenceSnapshotErrorCode =
  | "snapshot_invalid_task"
  | "snapshot_context_unavailable"
  | "snapshot_as_of_violation"
  | "snapshot_event_conflict"
  | "snapshot_invalid_budget";

export class CorrespondenceSnapshotError extends Error {
  constructor(
    readonly code: CorrespondenceSnapshotErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CorrespondenceSnapshotError";
  }
}

export interface FreezeOutboundArrivalInput {
  readonly task: Readonly<TemporalTask>;
  readonly observedNowUtc: string;
  readonly mode: OutboundArrivalHandlerMode;
}

export interface FreezeOutboundArrivalResult {
  readonly letter: LetterWithEncryptedBody;
  readonly snapshot: LetterGenerationSnapshot;
  readonly replyGenerationTask: TemporalTask;
}

interface SnapshotBuildResult {
  readonly contextJson: LetterGenerationContextV1;
  readonly evidenceIds: readonly string[];
  readonly characterVersion: number;
  readonly stateRevision: number;
  readonly contextHash: string;
}

type SnapshotObject = Record<string, JsonValue>;

/**
 * Freezes all knowledge available at an incoming letter's effective arrival.
 *
 * This service intentionally issues dedicated as-of SQL. It must not call the
 * ordinary "recent" context helpers because those helpers are allowed to read
 * the current projection and therefore cannot enforce a historical cutoff.
 */
export class CorrespondenceSnapshotService {
  readonly #budgets: CorrespondenceSnapshotBudgets;
  readonly #repository: CorrespondenceRepository;

  constructor(
    private readonly store: DatabaseStore,
    budgets: Partial<CorrespondenceSnapshotBudgets> = {},
  ) {
    // The repository must share this exact connection so all correspondence
    // writes participate in the store.transaction below.
    this.#repository = new CorrespondenceRepository(store.database);
    registerFuzzyLifeEffectiveAtSqlFunction(store.database);
    this.#budgets = validateBudgets({
      ...DEFAULT_CORRESPONDENCE_SNAPSHOT_BUDGETS,
      ...budgets,
    });
  }

  createOutboundArrivalTaskHandler(
    mode: OutboundArrivalHandlerMode,
  ): OutboundArrivalTaskHandler {
    return Object.freeze({
      mode,
      commit: (context: ExternalTemporalTaskContext): void => {
        this.freezeOutboundArrival({ ...context, mode });
      },
    });
  }

  freezeOutboundArrival(
    input: FreezeOutboundArrivalInput,
  ): FreezeOutboundArrivalResult {
    UtcDateTimeSchema.parse(input.observedNowUtc);
    if (input.mode !== "shadow" && input.mode !== "enforced") {
      throw snapshotError(
        "snapshot_invalid_task",
        "Outbound arrival snapshot mode must be shadow or enforced",
        { mode: input.mode },
      );
    }
    validateOutboundTask(input.task, input.observedNowUtc);

    return this.store.transaction(() => {
      const beforeDelivery = requireIncomingLetter(
        this.#repository.getLetter(input.task.entityId),
        input.task,
      );
      const delivered = this.#repository.markDelivered({
        letterId: beforeDelivery.id,
        effectiveAtUtc: input.task.dueAtUtc,
        processedAtUtc: input.observedNowUtc,
      });

      let snapshot = this.#repository.getSnapshotForIncomingLetter(
        delivered.id,
      );
      if (snapshot === undefined) {
        const built = buildSnapshot(
          this.store.database,
          delivered,
          input.task.dueAtUtc,
          this.#budgets,
        );
        snapshot = this.#repository.insertSnapshot({
          incomingLetterId: delivered.id,
          agentId: delivered.agentId,
          effectiveAtUtc: input.task.dueAtUtc,
          characterVersion: built.characterVersion,
          stateRevision: built.stateRevision,
          contextJson: built.contextJson,
          evidenceIds: built.evidenceIds,
          contextHash: built.contextHash,
          createdAtUtc: input.observedNowUtc,
        });
      } else {
        assertExistingSnapshot(snapshot, delivered, input.task.dueAtUtc);
      }

      const read = this.#repository.markRead({
        letterId: delivered.id,
        readAtUtc: input.task.dueAtUtc,
      });
      const replyGenerationTask = this.#repository.createTemporalTask({
        agentId: read.agentId,
        kind: "letter.reply_generation",
        entityId: read.id,
        dueAtUtc: input.task.dueAtUtc,
        priority: 20,
        idempotencyKey: replyGenerationIdempotencyKey(read.id),
        payload: {
          incomingLetterId: read.id,
          snapshotId: snapshot.id,
          generationEpoch: 0,
        },
        maxAttempts: 3,
        createdAtUtc: snapshot.createdAtUtc,
      });

      this.#repository.completeTask({
        taskId: input.task.id,
        claimToken: requiredClaimToken(input.task),
        completedAtUtc: input.observedNowUtc,
      });

      writeArrivalEvents(
        this.store,
        read,
        snapshot,
        input.task,
        replyGenerationTask,
        input.mode,
      );

      return Object.freeze({
        letter: read,
        snapshot,
        replyGenerationTask,
      });
    });
  }
}

function buildSnapshot(
  database: Database,
  incoming: Readonly<Letter>,
  effectiveAtUtc: string,
  budgets: CorrespondenceSnapshotBudgets,
): SnapshotBuildResult {
  const dispatchedAtUtc = incoming.dispatchedAtUtc;
  const timezone = incoming.transitTimezone;
  if (dispatchedAtUtc === undefined || timezone === undefined) {
    throw snapshotError(
      "snapshot_as_of_violation",
      "Incoming letter is missing its frozen dispatch window",
      { incomingLetterId: incoming.id },
    );
  }
  const effectiveLocalDate = localDateAt(effectiveAtUtc, timezone);
  const character = selectPublishedCharacter(
    database,
    incoming.agentId,
    effectiveAtUtc,
  );
  const runtime = selectRuntimeState(
    database,
    incoming.agentId,
    effectiveAtUtc,
  );
  const { relationship, ...runtimeWithoutRelationship } = runtime;

  const dailyContext = selectDailyLifeContext(
    database,
    incoming.agentId,
    effectiveAtUtc,
    effectiveLocalDate,
  );
  const dailyLifeIntents = selectJsonProjectionRows(
    database,
    `SELECT id, local_date AS temporalKey, created_at_utc AS createdAtUtc,
            updated_at_utc AS updatedAtUtc, intent_json AS recordJson
       FROM daily_life_intents
      WHERE agent_id = ? AND local_date <= ?
        AND julianday(created_at_utc) <= julianday(?)
        AND julianday(updated_at_utc) <= julianday(?)
      ORDER BY local_date DESC, updated_at_utc DESC, id
      LIMIT ?`,
    [
      incoming.agentId,
      effectiveLocalDate,
      effectiveAtUtc,
      effectiveAtUtc,
      budgets.dailyLifeIntents,
    ],
    "daily_life_intent",
  );
  const personalIntentions = selectJsonProjectionRows(
    database,
    `SELECT id, created_at_utc AS createdAtUtc,
            updated_at_utc AS updatedAtUtc, record_json AS recordJson
       FROM personal_intentions
      WHERE agent_id = ?
        AND julianday(created_at_utc) <= julianday(?)
        AND julianday(updated_at_utc) <= julianday(?)
      ORDER BY updated_at_utc DESC, id
      LIMIT ?`,
    [
      incoming.agentId,
      effectiveAtUtc,
      effectiveAtUtc,
      budgets.personalIntentions,
    ],
    "personal_intention",
  );
  const scheduleItems = selectJsonProjectionRows(
    database,
    `SELECT id, created_at_utc AS createdAtUtc,
            updated_at_utc AS updatedAtUtc, item_json AS recordJson
       FROM schedule_items
      WHERE agent_id = ?
        AND julianday(created_at_utc) <= julianday(?)
        AND julianday(updated_at_utc) <= julianday(?)
      ORDER BY start_at_utc, id
      LIMIT ?`,
    [incoming.agentId, effectiveAtUtc, effectiveAtUtc, budgets.scheduleItems],
    "schedule_item",
  );
  const lifeThreads = selectJsonProjectionRows(
    database,
    `SELECT id, created_at_utc AS createdAtUtc,
            updated_at_utc AS updatedAtUtc, thread_json AS recordJson
       FROM life_threads
      WHERE agent_id = ?
        AND julianday(created_at_utc) <= julianday(?)
        AND julianday(updated_at_utc) <= julianday(?)
      ORDER BY updated_at_utc DESC, id
      LIMIT ?`,
    [incoming.agentId, effectiveAtUtc, effectiveAtUtc, budgets.lifeThreads],
    "life_thread",
  );
  const verifiedOutcomes = selectLifeOutcomes(
    database,
    incoming.agentId,
    undefined,
    effectiveAtUtc,
    effectiveLocalDate,
    timezone,
    budgets.verifiedLifeOutcomes,
    "verified_life_outcome",
  );
  const causalRecords = [
    ...selectMutableCausalRows(
      database,
      "dilemma_episodes",
      "episode_json",
      "dilemma",
      incoming.agentId,
      effectiveAtUtc,
      effectiveLocalDate,
      timezone,
      budgets.dilemmas,
    ),
    ...selectMutableCausalRows(
      database,
      "pressure_episodes",
      "episode_json",
      "pressure_episode",
      incoming.agentId,
      effectiveAtUtc,
      effectiveLocalDate,
      timezone,
      budgets.pressureEpisodes,
    ),
    ...selectImmutableCausalRows(
      database,
      "support_interventions",
      "intervention_json",
      "support_intervention",
      incoming.agentId,
      effectiveAtUtc,
      effectiveLocalDate,
      timezone,
      budgets.supportInterventions,
    ),
    ...selectImmutableCausalRows(
      database,
      "decision_records",
      "decision_json",
      "decision",
      incoming.agentId,
      effectiveAtUtc,
      effectiveLocalDate,
      timezone,
      budgets.decisions,
    ),
    ...selectImmutableCausalRows(
      database,
      "action_records",
      "action_json",
      "action",
      incoming.agentId,
      effectiveAtUtc,
      effectiveLocalDate,
      timezone,
      budgets.actions,
    ),
    ...selectImmutableCausalRows(
      database,
      "outcome_records",
      "outcome_json",
      "outcome",
      incoming.agentId,
      effectiveAtUtc,
      effectiveLocalDate,
      timezone,
      budgets.outcomes,
    ),
    ...selectImmutableCausalRows(
      database,
      "reflection_records",
      "reflection_json",
      "reflection",
      incoming.agentId,
      effectiveAtUtc,
      effectiveLocalDate,
      timezone,
      budgets.reflections,
    ),
    ...selectImmutableCausalRows(
      database,
      "relationship_milestones",
      "milestone_json",
      "relationship_milestone",
      incoming.agentId,
      effectiveAtUtc,
      effectiveLocalDate,
      timezone,
      budgets.relationshipMilestones,
    ),
  ];
  const activityEvents = selectActivityEvents(
    database,
    incoming.agentId,
    dispatchedAtUtc,
    effectiveAtUtc,
    budgets.intervalActivityEvents,
  );
  const intervalLifeOutcomes = selectLifeOutcomes(
    database,
    incoming.agentId,
    dispatchedAtUtc,
    effectiveAtUtc,
    effectiveLocalDate,
    timezone,
    budgets.intervalLifeOutcomes,
    "interval_life_outcome",
  );
  const memoryEvidence = [
    ...selectMemoryEvidence(
      database,
      incoming.agentId,
      effectiveAtUtc,
      budgets.memoryRecords,
    ),
    ...selectEventCards(
      database,
      incoming.agentId,
      effectiveAtUtc,
      budgets.eventCards,
    ),
  ];
  const conversationTail = selectConversationTail(
    database,
    incoming.agentId,
    effectiveAtUtc,
    budgets.conversationMessages,
  );
  const priorCorrespondence = selectPriorCorrespondence(
    database,
    incoming,
    effectiveAtUtc,
    budgets.priorLetters,
  );
  const readyKeepsakes = selectReadyKeepsakes(
    database,
    incoming.agentId,
    effectiveAtUtc,
    budgets.readyKeepsakes,
  );

  const contextJson = LetterGenerationContextV1Schema.parse({
    schemaVersion: 1,
    effectiveAtUtc,
    sourceWindow: {
      fromUtc: dispatchedAtUtc,
      throughUtc: effectiveAtUtc,
    },
    character: {
      version: character.version,
      identity: character.identity,
      persona: character.persona,
      dialogue: character.dialogue,
      userRelationship: character.userRelationship,
      knowledge: character.knowledge,
    },
    runtimeState: runtimeWithoutRelationship,
    relationship: {
      ...relationship,
      stateRevision: runtime.revision,
      asOfUtc: runtime.asOfUtc,
    },
    fuzzyLife: {
      dailyContext,
      intents: [...dailyLifeIntents, ...personalIntentions, ...scheduleItems],
      threads: lifeThreads,
      verifiedOutcomes,
      causalRecords,
    },
    intervalDigest: {
      activityEvents,
      lifeOutcomes: intervalLifeOutcomes,
    },
    memoryEvidence,
    conversationTail,
    priorCorrespondence,
    readyKeepsakes,
    budgets: { ...budgets },
  });
  const evidenceIds = collectEvidenceIds(contextJson);
  const contextHash = createHash("sha256")
    .update(
      canonicalLetterGenerationSnapshot({ contextJson, evidenceIds }),
      "utf8",
    )
    .digest("hex");

  return {
    contextJson,
    evidenceIds,
    characterVersion: character.version,
    stateRevision: runtime.revision,
    contextHash,
  };
}

function selectPublishedCharacter(
  database: Database,
  agentId: string,
  effectiveAtUtc: string,
) {
  const row = database
    .prepare(
      `SELECT cv.spec_json AS specJson
         FROM character_versions cv
         JOIN domain_events published
           ON published.agent_id = cv.character_id
          AND published.stream_type = 'character'
          AND published.stream_id = cv.character_id
          AND published.event_type = 'character.published'
          AND CAST(json_extract(published.payload_json, '$.version') AS INTEGER)
              = cv.version
        WHERE cv.character_id = ?
          AND julianday(cv.created_at_utc) <= julianday(?)
          AND julianday(published.effective_at_utc) <= julianday(?)
          AND julianday(published.recorded_at_utc) <= julianday(?)
        ORDER BY julianday(published.recorded_at_utc) DESC, cv.version DESC
        LIMIT 1`,
    )
    .get(agentId, effectiveAtUtc, effectiveAtUtc, effectiveAtUtc) as
    { specJson: string } | undefined;
  if (row === undefined) {
    throw snapshotError(
      "snapshot_context_unavailable",
      "No character version was provably published by the arrival cutoff",
      { agentId, effectiveAtUtc },
    );
  }
  return parseContractJson(CharacterSpecSchema, row.specJson, {
    source: "character_versions.spec_json",
    agentId,
  });
}

function selectRuntimeState(
  database: Database,
  agentId: string,
  effectiveAtUtc: string,
) {
  const row = database
    .prepare(
      `SELECT state_json AS stateJson, revision,
              updated_at_utc AS updatedAtUtc
         FROM runtime_states WHERE agent_id = ?`,
    )
    .get(agentId) as
    { stateJson: string; revision: number; updatedAtUtc: string } | undefined;
  if (row === undefined) {
    throw snapshotError(
      "snapshot_context_unavailable",
      "Runtime state is unavailable at the arrival cutoff",
      { agentId, effectiveAtUtc },
    );
  }
  const state = parseContractJson(RuntimeStateSchema, row.stateJson, {
    source: "runtime_states.state_json",
    agentId,
  });
  if (
    state.agentId !== agentId ||
    state.revision !== row.revision ||
    afterCutoff(state.asOfUtc, effectiveAtUtc) ||
    afterCutoff(row.updatedAtUtc, effectiveAtUtc) ||
    (state.relationship.lastInteractionAtUtc !== undefined &&
      afterCutoff(state.relationship.lastInteractionAtUtc, effectiveAtUtc))
  ) {
    throw snapshotError(
      "snapshot_as_of_violation",
      "Current runtime projection is newer than the arrival cutoff",
      {
        agentId,
        effectiveAtUtc,
        stateAsOfUtc: state.asOfUtc,
        storedUpdatedAtUtc: row.updatedAtUtc,
        relationshipLastInteractionAtUtc:
          state.relationship.lastInteractionAtUtc,
        stateRevision: state.revision,
        storedRevision: row.revision,
      },
    );
  }
  return state;
}

function selectDailyLifeContext(
  database: Database,
  agentId: string,
  effectiveAtUtc: string,
  effectiveLocalDate: string,
): JsonValue {
  const row = database
    .prepare(
      `SELECT id, local_date AS localDate, created_at_utc AS createdAtUtc,
              updated_at_utc AS updatedAtUtc, context_json AS contextJson
         FROM daily_life_contexts
        WHERE agent_id = ? AND local_date <= ?
          AND julianday(created_at_utc) <= julianday(?)
          AND julianday(updated_at_utc) <= julianday(?)
        ORDER BY local_date DESC, revision DESC, id
        LIMIT 1`,
    )
    .get(agentId, effectiveLocalDate, effectiveAtUtc, effectiveAtUtc) as
    | {
        id: string;
        localDate: string;
        createdAtUtc: string;
        updatedAtUtc: string;
        contextJson: string;
      }
    | undefined;
  if (row === undefined) return null;
  return asSnapshotObject({
    id: row.id,
    recordType: "daily_life_context",
    localDate: row.localDate,
    createdAtUtc: row.createdAtUtc,
    updatedAtUtc: row.updatedAtUtc,
    record: parseJsonValue(row.contextJson, "daily_life_contexts.context_json"),
  });
}

interface JsonProjectionRow {
  id: string;
  temporalKey?: string | null;
  createdAtUtc?: string | null;
  updatedAtUtc?: string | null;
  recordJson: string;
}

function selectJsonProjectionRows(
  database: Database,
  sql: string,
  parameters: readonly unknown[],
  recordType: string,
): SnapshotObject[] {
  const rows = database.prepare(sql).all(...parameters) as JsonProjectionRow[];
  return rows.map((row) =>
    asSnapshotObject({
      id: row.id,
      recordType,
      ...(row.temporalKey === undefined || row.temporalKey === null
        ? {}
        : { temporalKey: row.temporalKey }),
      ...(row.createdAtUtc === undefined || row.createdAtUtc === null
        ? {}
        : { createdAtUtc: row.createdAtUtc }),
      ...(row.updatedAtUtc === undefined || row.updatedAtUtc === null
        ? {}
        : { updatedAtUtc: row.updatedAtUtc }),
      record: parseJsonValue(row.recordJson, `${recordType}.record_json`),
    }),
  );
}

function selectLifeOutcomes(
  database: Database,
  agentId: string,
  fromRecordedAtUtc: string | undefined,
  effectiveAtUtc: string,
  effectiveLocalDate: string,
  timezone: string,
  limit: number,
  recordType: string,
): SnapshotObject[] {
  const rows = database
    .prepare(
      `SELECT id, effective_local_date AS effectiveLocalDate,
              effective_period AS effectivePeriod,
              recorded_at_utc AS recordedAtUtc,
              outcome_json AS recordJson
         FROM life_outcomes
        WHERE agent_id = ? AND effective_local_date <= ?
          AND julianday(recorded_at_utc) <= julianday(?)
          AND (? IS NULL OR julianday(recorded_at_utc) >= julianday(?))
          AND julianday(fuzzy_life_effective_at_utc(
                effective_local_date, effective_period,
                temporal_precision, ?
              )) <= julianday(?)
        ORDER BY effective_local_date DESC, recorded_at_utc DESC, id
        LIMIT ?`,
    )
    .all(
      agentId,
      effectiveLocalDate,
      effectiveAtUtc,
      fromRecordedAtUtc ?? null,
      fromRecordedAtUtc ?? null,
      timezone,
      effectiveAtUtc,
      limit,
    ) as Array<{
    id: string;
    effectiveLocalDate: string;
    effectivePeriod: string | null;
    recordedAtUtc: string;
    recordJson: string;
  }>;
  return rows.map((row) =>
    asSnapshotObject({
      id: row.id,
      recordType,
      effectiveLocalDate: row.effectiveLocalDate,
      ...(row.effectivePeriod === null
        ? {}
        : { effectivePeriod: row.effectivePeriod }),
      recordedAtUtc: row.recordedAtUtc,
      record: parseJsonValue(row.recordJson, "life_outcomes.outcome_json"),
    }),
  );
}

function selectMutableCausalRows(
  database: Database,
  table: "dilemma_episodes" | "pressure_episodes",
  jsonColumn: "episode_json",
  recordType: string,
  agentId: string,
  effectiveAtUtc: string,
  effectiveLocalDate: string,
  timezone: string,
  limit: number,
): SnapshotObject[] {
  const sql = `SELECT id, effective_local_date AS effectiveLocalDate,
                      effective_period AS effectivePeriod,
                      recorded_at_utc AS recordedAtUtc,
                      updated_at_utc AS updatedAtUtc,
                      ${jsonColumn} AS recordJson
                 FROM ${table}
                WHERE agent_id = ? AND effective_local_date <= ?
                  AND julianday(recorded_at_utc) <= julianday(?)
                  AND julianday(updated_at_utc) <= julianday(?)
                  AND julianday(fuzzy_life_effective_at_utc(
                        effective_local_date, effective_period,
                        temporal_precision, ?
                      )) <= julianday(?)
                ORDER BY recorded_at_utc DESC, id LIMIT ?`;
  return mapCausalRows(
    database
      .prepare(sql)
      .all(
        agentId,
        effectiveLocalDate,
        effectiveAtUtc,
        effectiveAtUtc,
        timezone,
        effectiveAtUtc,
        limit,
      ) as CausalRow[],
    recordType,
  );
}

function selectImmutableCausalRows(
  database: Database,
  table:
    | "support_interventions"
    | "decision_records"
    | "action_records"
    | "outcome_records"
    | "reflection_records"
    | "relationship_milestones",
  jsonColumn:
    | "intervention_json"
    | "decision_json"
    | "action_json"
    | "outcome_json"
    | "reflection_json"
    | "milestone_json",
  recordType: string,
  agentId: string,
  effectiveAtUtc: string,
  effectiveLocalDate: string,
  timezone: string,
  limit: number,
): SnapshotObject[] {
  const sql = `SELECT id, effective_local_date AS effectiveLocalDate,
                      effective_period AS effectivePeriod,
                      recorded_at_utc AS recordedAtUtc,
                      NULL AS updatedAtUtc,
                      ${jsonColumn} AS recordJson
                 FROM ${table}
                WHERE agent_id = ? AND effective_local_date <= ?
                  AND julianday(recorded_at_utc) <= julianday(?)
                  AND julianday(fuzzy_life_effective_at_utc(
                        effective_local_date, effective_period,
                        temporal_precision, ?
                      )) <= julianday(?)
                ORDER BY recorded_at_utc DESC, id LIMIT ?`;
  return mapCausalRows(
    database
      .prepare(sql)
      .all(
        agentId,
        effectiveLocalDate,
        effectiveAtUtc,
        timezone,
        effectiveAtUtc,
        limit,
      ) as CausalRow[],
    recordType,
  );
}

interface CausalRow {
  id: string;
  effectiveLocalDate: string;
  effectivePeriod: string | null;
  recordedAtUtc: string;
  updatedAtUtc: string | null;
  recordJson: string;
}

function mapCausalRows(
  rows: readonly CausalRow[],
  recordType: string,
): SnapshotObject[] {
  return rows.map((row) =>
    asSnapshotObject({
      id: row.id,
      recordType,
      effectiveLocalDate: row.effectiveLocalDate,
      ...(row.effectivePeriod === null
        ? {}
        : { effectivePeriod: row.effectivePeriod }),
      recordedAtUtc: row.recordedAtUtc,
      ...(row.updatedAtUtc === null ? {} : { updatedAtUtc: row.updatedAtUtc }),
      record: parseJsonValue(row.recordJson, `${recordType}.record_json`),
    }),
  );
}

function selectActivityEvents(
  database: Database,
  agentId: string,
  fromUtc: string,
  throughUtc: string,
  limit: number,
): SnapshotObject[] {
  const rows = database
    .prepare(
      `SELECT activity.id, activity.occurred_at_utc AS occurredAtUtc,
              activity.event_json AS recordJson,
              MIN(audit.recorded_at_utc) AS recordedAtUtc
         FROM activity_events activity
         JOIN domain_events audit
           ON audit.agent_id = activity.agent_id
          AND audit.event_type = 'simulation.settled'
          AND json_valid(audit.payload_json)
         JOIN json_each(audit.payload_json, '$.activityEventIds') evidence
           ON CAST(evidence.value AS TEXT) = activity.id
        WHERE activity.agent_id = ?
          AND julianday(activity.occurred_at_utc) >= julianday(?)
          AND julianday(activity.occurred_at_utc) <= julianday(?)
          AND julianday(audit.effective_at_utc) <= julianday(?)
          AND julianday(audit.recorded_at_utc) <= julianday(?)
        GROUP BY activity.id
        ORDER BY activity.occurred_at_utc DESC, activity.id
        LIMIT ?`,
    )
    .all(agentId, fromUtc, throughUtc, throughUtc, throughUtc, limit) as Array<{
    id: string;
    occurredAtUtc: string;
    recordedAtUtc: string;
    recordJson: string;
  }>;
  return rows.map((row) =>
    asSnapshotObject({
      id: row.id,
      recordType: "activity_event",
      occurredAtUtc: row.occurredAtUtc,
      recordedAtUtc: row.recordedAtUtc,
      record: parseJsonValue(row.recordJson, "activity_events.event_json"),
    }),
  );
}

function selectMemoryEvidence(
  database: Database,
  agentId: string,
  effectiveAtUtc: string,
  limit: number,
): SnapshotObject[] {
  const rows = database
    .prepare(
      `SELECT evidence.id, evidence.memory_id AS memoryId,
              evidence.source_type AS sourceType,
              evidence.source_id AS sourceId,
              evidence.recorded_at_utc AS evidenceRecordedAtUtc,
              evidence.evidence_json AS evidenceJson,
              memory.content, memory.memory_json AS memoryJson,
              memory.created_at_utc AS memoryCreatedAtUtc,
              COALESCE(memory.recorded_at_utc, memory.created_at_utc)
                AS memoryRecordedAtUtc,
              COALESCE(memory.lifecycle_updated_at_utc, memory.created_at_utc)
                AS memoryUpdatedAtUtc
         FROM memories memory
         JOIN memory_evidence evidence ON evidence.memory_id = memory.id
        WHERE memory.agent_id = ?
          AND julianday(memory.created_at_utc) <= julianday(?)
          AND julianday(COALESCE(memory.recorded_at_utc, memory.created_at_utc))
              <= julianday(?)
          AND julianday(COALESCE(memory.lifecycle_updated_at_utc,
                                 memory.created_at_utc)) <= julianday(?)
          AND (memory.mentioned_at_utc IS NULL
               OR julianday(memory.mentioned_at_utc) <= julianday(?))
          AND (memory.occurred_start_at_utc IS NULL
               OR julianday(memory.occurred_start_at_utc) <= julianday(?))
          AND (memory.occurred_end_at_utc IS NULL
               OR julianday(memory.occurred_end_at_utc) <= julianday(?))
          AND julianday(evidence.recorded_at_utc) <= julianday(?)
          AND (
            (evidence.source_type = 'message' AND EXISTS (
              SELECT 1 FROM messages source
               WHERE source.id = evidence.source_id
                 AND julianday(source.created_at_utc) <= julianday(?)
            ))
            OR (evidence.source_type = 'activity_event' AND EXISTS (
              SELECT 1 FROM activity_events source
              JOIN domain_events audit
                ON audit.agent_id = source.agent_id
               AND audit.event_type = 'simulation.settled'
               AND json_valid(audit.payload_json)
              JOIN json_each(audit.payload_json, '$.activityEventIds') item
                ON CAST(item.value AS TEXT) = source.id
               WHERE source.id = evidence.source_id
                 AND julianday(source.occurred_at_utc) <= julianday(?)
                 AND julianday(audit.effective_at_utc) <= julianday(?)
                 AND julianday(audit.recorded_at_utc) <= julianday(?)
            ))
            OR (evidence.source_type = 'character_source' AND EXISTS (
              SELECT 1 FROM character_sources source
               WHERE source.id = evidence.source_id
                 AND julianday(source.created_at_utc) <= julianday(?)
            ))
            OR (evidence.source_type = 'schedule_event' AND EXISTS (
              SELECT 1 FROM schedule_items source
               WHERE source.id = evidence.source_id
                 AND julianday(source.created_at_utc) <= julianday(?)
                 AND julianday(source.updated_at_utc) <= julianday(?)
            ))
            OR evidence.source_type = 'manual'
          )
        ORDER BY memory.importance DESC, evidence.recorded_at_utc DESC,
                 evidence.id
        LIMIT ?`,
    )
    .all(
      agentId,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      limit,
    ) as Array<{
    id: string;
    memoryId: string;
    sourceType: string;
    sourceId: string;
    evidenceRecordedAtUtc: string;
    evidenceJson: string;
    content: string;
    memoryJson: string | null;
    memoryCreatedAtUtc: string;
    memoryRecordedAtUtc: string;
    memoryUpdatedAtUtc: string;
  }>;
  return rows.map((row) =>
    asSnapshotObject({
      id: row.id,
      recordType: "memory_evidence",
      memoryId: row.memoryId,
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      content: row.content,
      evidenceRecordedAtUtc: row.evidenceRecordedAtUtc,
      memoryCreatedAtUtc: row.memoryCreatedAtUtc,
      memoryRecordedAtUtc: row.memoryRecordedAtUtc,
      memoryUpdatedAtUtc: row.memoryUpdatedAtUtc,
      evidence: parseJsonValue(
        row.evidenceJson,
        "memory_evidence.evidence_json",
      ),
      ...(row.memoryJson === null
        ? {}
        : {
            memory: parseJsonValue(row.memoryJson, "memories.memory_json"),
          }),
    }),
  );
}

function selectEventCards(
  database: Database,
  agentId: string,
  effectiveAtUtc: string,
  limit: number,
): SnapshotObject[] {
  const rows = database
    .prepare(
      `SELECT id, temporal_status AS temporalStatus,
              recorded_at_utc AS recordedAtUtc,
              created_at_utc AS createdAtUtc,
              updated_at_utc AS updatedAtUtc, card_json AS recordJson
         FROM event_cards
        WHERE agent_id = ?
          AND julianday(recorded_at_utc) <= julianday(?)
          AND julianday(created_at_utc) <= julianday(?)
          AND julianday(updated_at_utc) <= julianday(?)
          AND (mentioned_at_utc IS NULL
               OR julianday(mentioned_at_utc) <= julianday(?))
          AND (occurred_start_at_utc IS NULL
               OR julianday(occurred_start_at_utc) <= julianday(?))
          AND (occurred_end_at_utc IS NULL
               OR julianday(occurred_end_at_utc) <= julianday(?))
        ORDER BY importance DESC, recorded_at_utc DESC, id
        LIMIT ?`,
    )
    .all(
      agentId,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      limit,
    ) as Array<{
    id: string;
    temporalStatus: string;
    recordedAtUtc: string;
    createdAtUtc: string;
    updatedAtUtc: string;
    recordJson: string;
  }>;
  return rows.map((row) =>
    asSnapshotObject({
      id: row.id,
      recordType: "event_card",
      temporalStatus: row.temporalStatus,
      recordedAtUtc: row.recordedAtUtc,
      createdAtUtc: row.createdAtUtc,
      updatedAtUtc: row.updatedAtUtc,
      record: parseJsonValue(row.recordJson, "event_cards.card_json"),
    }),
  );
}

function selectConversationTail(
  database: Database,
  agentId: string,
  effectiveAtUtc: string,
  limit: number,
): SnapshotObject[] {
  const rows = database
    .prepare(
      `SELECT id, session_id AS sessionId, role,
              message_kind AS messageKind, content,
              created_at_utc AS createdAtUtc
         FROM messages
        WHERE agent_id = ?
          AND julianday(created_at_utc) <= julianday(?)
        ORDER BY created_at_utc DESC, id DESC
        LIMIT ?`,
    )
    .all(agentId, effectiveAtUtc, limit) as Array<{
    id: string;
    sessionId: string;
    role: string;
    messageKind: string;
    content: string;
    createdAtUtc: string;
  }>;
  return rows.reverse().map((row) => asSnapshotObject(row));
}

function selectPriorCorrespondence(
  database: Database,
  incoming: Readonly<Letter>,
  effectiveAtUtc: string,
  limit: number,
): SnapshotObject[] {
  const rows = database
    .prepare(
      `SELECT id, direction, status, subject, body,
              effective_author_time_utc AS effectiveAuthorTimeUtc,
              dispatched_at_utc AS dispatchedAtUtc,
              arrival_due_at_utc AS arrivalDueAtUtc,
              delivered_effective_at_utc AS deliveredEffectiveAtUtc,
              read_at_utc AS readAtUtc, opened_at_utc AS openedAtUtc,
              created_at_utc AS createdAtUtc, updated_at_utc AS updatedAtUtc
         FROM letters
        WHERE thread_id = ? AND agent_id = ? AND id <> ?
          AND julianday(created_at_utc) <= julianday(?)
          AND julianday(updated_at_utc) <= julianday(?)
          AND (
            (direction = 'user_to_agent' AND status = 'read'
              AND julianday(delivered_effective_at_utc) <= julianday(?)
              AND julianday(read_at_utc) <= julianday(?))
            OR
            (direction = 'agent_to_user'
              AND status IN ('in_transit', 'delivered_unread', 'read')
              AND julianday(effective_author_time_utc) <= julianday(?)
              AND julianday(dispatched_at_utc) <= julianday(?))
          )
        ORDER BY effective_author_time_utc DESC, id DESC
        LIMIT ?`,
    )
    .all(
      incoming.threadId,
      incoming.agentId,
      incoming.id,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      limit,
    ) as Array<{
    id: string;
    direction: "user_to_agent" | "agent_to_user";
    status: string;
    subject: string | null;
    body: string | null;
    effectiveAuthorTimeUtc: string;
    dispatchedAtUtc: string;
    arrivalDueAtUtc: string;
    deliveredEffectiveAtUtc: string | null;
    readAtUtc: string | null;
    openedAtUtc: string | null;
    createdAtUtc: string;
    updatedAtUtc: string;
  }>;
  return rows.reverse().map((row) =>
    asSnapshotObject({
      id: row.id,
      direction: row.direction,
      status: row.status,
      ...(row.subject === null ? {} : { subject: row.subject }),
      ...(row.direction === "user_to_agent" && row.body !== null
        ? { body: row.body }
        : {}),
      effectiveAuthorTimeUtc: row.effectiveAuthorTimeUtc,
      dispatchedAtUtc: row.dispatchedAtUtc,
      arrivalDueAtUtc: row.arrivalDueAtUtc,
      ...(row.deliveredEffectiveAtUtc === null
        ? {}
        : { deliveredEffectiveAtUtc: row.deliveredEffectiveAtUtc }),
      ...(row.readAtUtc === null ? {} : { readAtUtc: row.readAtUtc }),
      ...(row.openedAtUtc === null ? {} : { openedAtUtc: row.openedAtUtc }),
      createdAtUtc: row.createdAtUtc,
      updatedAtUtc: row.updatedAtUtc,
    }),
  );
}

function selectReadyKeepsakes(
  database: Database,
  agentId: string,
  effectiveAtUtc: string,
  limit: number,
): SnapshotObject[] {
  const rows = database
    .prepare(
      `SELECT keepsake.id, keepsake.title, keepsake.kind,
              keepsake.description,
              keepsake.source_event_ids_json AS sourceEventIdsJson,
              keepsake.source_memory_ids_json AS sourceMemoryIdsJson,
              keepsake.source_letter_ids_json AS sourceLetterIdsJson,
              keepsake.created_effective_at_utc AS createdEffectiveAtUtc,
              asset.created_at_utc AS readyAtUtc
         FROM keepsakes keepsake
         JOIN keepsake_assets asset ON asset.id = keepsake.primary_asset_id
        WHERE keepsake.agent_id = ? AND keepsake.status = 'ready'
          AND julianday(keepsake.created_at_utc) <= julianday(?)
          AND julianday(keepsake.created_effective_at_utc) <= julianday(?)
          AND julianday(asset.created_at_utc) <= julianday(?)
        ORDER BY keepsake.created_effective_at_utc DESC,
                 asset.created_at_utc DESC, keepsake.id
        LIMIT ?`,
    )
    .all(
      agentId,
      effectiveAtUtc,
      effectiveAtUtc,
      effectiveAtUtc,
      limit,
    ) as Array<{
    id: string;
    title: string;
    kind: string;
    description: string;
    sourceEventIdsJson: string;
    sourceMemoryIdsJson: string;
    sourceLetterIdsJson: string;
    createdEffectiveAtUtc: string;
    readyAtUtc: string;
  }>;
  return rows.reverse().map((row) =>
    asSnapshotObject({
      id: row.id,
      recordType: "keepsake",
      title: row.title,
      kind: row.kind,
      description: row.description,
      sourceEventIds: parseEntityIdArray(
        row.sourceEventIdsJson,
        "keepsakes.source_event_ids_json",
      ),
      sourceMemoryIds: parseEntityIdArray(
        row.sourceMemoryIdsJson,
        "keepsakes.source_memory_ids_json",
      ),
      sourceLetterIds: parseEntityIdArray(
        row.sourceLetterIdsJson,
        "keepsakes.source_letter_ids_json",
      ),
      createdEffectiveAtUtc: row.createdEffectiveAtUtc,
      readyAtUtc: row.readyAtUtc,
    }),
  );
}

function collectEvidenceIds(
  context: Readonly<LetterGenerationContextV1>,
): string[] {
  const ids = new Set<string>();
  const collect = (items: readonly SnapshotObject[]): void => {
    for (const item of items) {
      if (typeof item.id === "string") ids.add(item.id);
    }
  };
  if (
    context.fuzzyLife.dailyContext !== null &&
    typeof context.fuzzyLife.dailyContext === "object" &&
    !Array.isArray(context.fuzzyLife.dailyContext) &&
    typeof context.fuzzyLife.dailyContext.id === "string"
  ) {
    ids.add(context.fuzzyLife.dailyContext.id);
  }
  collect(context.fuzzyLife.intents);
  collect(context.fuzzyLife.threads);
  collect(context.fuzzyLife.verifiedOutcomes);
  collect(context.fuzzyLife.causalRecords);
  collect(context.intervalDigest.activityEvents);
  collect(context.intervalDigest.lifeOutcomes);
  collect(context.memoryEvidence);
  collect(context.conversationTail);
  collect(context.priorCorrespondence);
  const readyKeepsakes =
    "readyKeepsakes" in context ? context.readyKeepsakes : [];
  collect(readyKeepsakes);
  for (const keepsake of readyKeepsakes) {
    for (const id of [
      ...keepsake.sourceEventIds,
      ...keepsake.sourceMemoryIds,
      ...keepsake.sourceLetterIds,
    ]) {
      ids.add(id);
    }
  }
  return [...ids].sort(compareCodeUnits);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function writeArrivalEvents(
  store: DatabaseStore,
  letter: Readonly<Letter>,
  snapshot: Readonly<LetterGenerationSnapshot>,
  outboundTask: Readonly<TemporalTask>,
  replyGenerationTask: Readonly<TemporalTask>,
  mode: OutboundArrivalHandlerMode,
): void {
  const processedAtUtc = letter.processedAtUtc;
  if (processedAtUtc === undefined) {
    throw snapshotError(
      "snapshot_as_of_violation",
      "Delivered incoming letter has no processing time",
      { incomingLetterId: letter.id },
    );
  }
  insertIdempotentEvent(store, {
    agentId: letter.agentId,
    streamType: "correspondence_letter",
    streamId: letter.id,
    streamVersion: 1,
    eventType: "letter.arrived",
    recordedAtUtc: processedAtUtc,
    effectiveAtUtc: snapshot.effectiveAtUtc,
    payload: {
      letterId: letter.id,
      direction: letter.direction,
      effectiveAtUtc: snapshot.effectiveAtUtc,
      processedAtUtc,
    },
    correlationId: letter.id,
    causationId: outboundTask.id,
    idempotencyKey: `letter-arrival:${letter.id}`,
  });
  insertIdempotentEvent(store, {
    agentId: letter.agentId,
    streamType: "correspondence_letter",
    streamId: letter.id,
    streamVersion: 2,
    eventType: "letter.snapshot_frozen",
    recordedAtUtc: snapshot.createdAtUtc,
    effectiveAtUtc: snapshot.effectiveAtUtc,
    payload: {
      incomingLetterId: letter.id,
      snapshotId: snapshot.id,
      snapshotHash: snapshot.contextHash,
      evidenceIds: snapshot.evidenceIds,
      characterVersion: snapshot.characterVersion,
      stateRevision: snapshot.stateRevision,
    },
    correlationId: letter.id,
    causationId: outboundTask.id,
    idempotencyKey: `letter-snapshot:${letter.id}:v1`,
  });
  insertIdempotentEvent(store, {
    agentId: letter.agentId,
    streamType: "correspondence_letter",
    streamId: letter.id,
    streamVersion: 3,
    eventType: "letter.read",
    recordedAtUtc: snapshot.createdAtUtc,
    effectiveAtUtc: snapshot.effectiveAtUtc,
    payload: {
      letterId: letter.id,
      readAtUtc: snapshot.effectiveAtUtc,
      snapshotId: snapshot.id,
    },
    correlationId: letter.id,
    causationId: outboundTask.id,
    idempotencyKey: `letter-read:${letter.id}:v1`,
  });
  if (mode === "shadow") {
    insertIdempotentEvent(store, {
      agentId: letter.agentId,
      streamType: "correspondence_letter",
      streamId: letter.id,
      streamVersion: 4,
      eventType: "letter.reply_generation_shadow_observed",
      recordedAtUtc: snapshot.createdAtUtc,
      effectiveAtUtc: snapshot.effectiveAtUtc,
      payload: {
        incomingLetterId: letter.id,
        taskId: replyGenerationTask.id,
        snapshotId: snapshot.id,
        snapshotHash: snapshot.contextHash,
      },
      correlationId: letter.id,
      causationId: outboundTask.id,
      idempotencyKey: `letter-reply-shadow:${letter.id}:v1`,
    });
  }
}

interface DomainEventInput {
  readonly agentId: string;
  readonly streamType: string;
  readonly streamId: string;
  readonly streamVersion: number;
  readonly eventType: string;
  readonly recordedAtUtc: string;
  readonly effectiveAtUtc: string;
  readonly payload: unknown;
  readonly correlationId?: string;
  readonly causationId?: string;
  readonly idempotencyKey: string;
}

function insertIdempotentEvent(
  store: DatabaseStore,
  input: DomainEventInput,
): void {
  if (store.insertDomainEvent(input)) return;
  const existing = store.getDomainEventByIdempotencyKey(input.idempotencyKey);
  const expected = {
    agentId: input.agentId,
    streamType: input.streamType,
    streamId: input.streamId,
    streamVersion: input.streamVersion,
    eventType: input.eventType,
    recordedAtUtc: input.recordedAtUtc,
    effectiveAtUtc: input.effectiveAtUtc,
    payload: input.payload,
    idempotencyKey: input.idempotencyKey,
  };
  if (
    existing === undefined ||
    canonicalCorrespondenceJson(existing) !==
      canonicalCorrespondenceJson(expected)
  ) {
    throw snapshotError(
      "snapshot_event_conflict",
      "Correspondence event idempotency key has different content",
      { idempotencyKey: input.idempotencyKey },
    );
  }
}

function assertExistingSnapshot(
  snapshot: Readonly<LetterGenerationSnapshot>,
  incoming: Readonly<Letter>,
  effectiveAtUtc: string,
): void {
  if (
    snapshot.incomingLetterId !== incoming.id ||
    snapshot.agentId !== incoming.agentId ||
    snapshot.effectiveAtUtc !== effectiveAtUtc
  ) {
    throw snapshotError(
      "snapshot_as_of_violation",
      "Existing snapshot does not match the incoming arrival boundary",
      { incomingLetterId: incoming.id, snapshotId: snapshot.id },
    );
  }
  const expectedHash = createHash("sha256")
    .update(
      canonicalLetterGenerationSnapshot({
        contextJson: snapshot.contextJson,
        evidenceIds: snapshot.evidenceIds,
      }),
      "utf8",
    )
    .digest("hex");
  if (expectedHash !== snapshot.contextHash) {
    throw snapshotError(
      "snapshot_as_of_violation",
      "Existing snapshot hash does not match its canonical evidence",
      { incomingLetterId: incoming.id, snapshotId: snapshot.id },
    );
  }
}

function validateOutboundTask(
  task: Readonly<TemporalTask>,
  observedNowUtc: string,
): void {
  if (
    task.kind !== "letter.outbound_arrival" ||
    task.status !== "claimed" ||
    task.entityId.length === 0 ||
    task.claimToken === undefined ||
    afterCutoff(task.dueAtUtc, observedNowUtc)
  ) {
    throw snapshotError(
      "snapshot_invalid_task",
      "Snapshot freeze requires a due, actively claimed outbound arrival task",
      {
        taskId: task.id,
        kind: task.kind,
        status: task.status,
        dueAtUtc: task.dueAtUtc,
        observedNowUtc,
      },
    );
  }
}

function requireIncomingLetter(
  letter: LetterWithEncryptedBody | undefined,
  task: Readonly<TemporalTask>,
): LetterWithEncryptedBody {
  if (
    letter === undefined ||
    letter.id !== task.entityId ||
    letter.agentId !== task.agentId ||
    letter.direction !== "user_to_agent" ||
    letter.arrivalDueAtUtc !== task.dueAtUtc
  ) {
    throw snapshotError(
      "snapshot_invalid_task",
      "Outbound arrival task does not match an incoming user letter",
      { taskId: task.id, letterId: task.entityId },
    );
  }
  return letter;
}

function requiredClaimToken(task: Readonly<TemporalTask>): string {
  if (task.claimToken !== undefined) return task.claimToken;
  throw snapshotError(
    "snapshot_invalid_task",
    "Outbound arrival task has no claim token",
    { taskId: task.id },
  );
}

function replyGenerationIdempotencyKey(incomingLetterId: string): string {
  return `letter-reply-run:${incomingLetterId}:v1`;
}

function localDateAt(valueUtc: string, timezone: string): string {
  const value = DateTime.fromISO(valueUtc, { zone: "utc" }).setZone(timezone);
  const localDate = value.isValid ? value.toISODate() : null;
  if (localDate === null) {
    throw snapshotError(
      "snapshot_as_of_violation",
      "Letter transit timezone cannot define the arrival source window",
      { valueUtc, timezone },
    );
  }
  return localDate;
}

function parseJsonValue(serialized: string, source: string): JsonValue {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw snapshotError(
      "snapshot_context_unavailable",
      `Invalid JSON in ${source}`,
      { source },
      error,
    );
  }
  const parsed = JsonValueSchema.safeParse(raw);
  if (!parsed.success) {
    throw snapshotError(
      "snapshot_context_unavailable",
      `Non-JSON evidence in ${source}`,
      { source },
      parsed.error,
    );
  }
  return parsed.data;
}

function parseEntityIdArray(serialized: string, source: string): string[] {
  const value = parseJsonValue(serialized, source);
  if (!Array.isArray(value)) {
    throw snapshotError(
      "snapshot_context_unavailable",
      `Expected an entity ID array in ${source}`,
      { source },
    );
  }
  try {
    return value.map((item) => EntityIdSchema.parse(item));
  } catch (error) {
    throw snapshotError(
      "snapshot_context_unavailable",
      `Invalid entity ID array in ${source}`,
      { source },
      error,
    );
  }
}

function parseContractJson<T>(
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: unknown };
  },
  serialized: string,
  details: Readonly<Record<string, unknown>>,
): T {
  let raw: unknown;
  try {
    raw = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw snapshotError(
      "snapshot_context_unavailable",
      "Stored snapshot source JSON is invalid",
      details,
      error,
    );
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw snapshotError(
      "snapshot_context_unavailable",
      "Stored snapshot source violates its domain contract",
      details,
      parsed.error,
    );
  }
  return parsed.data;
}

function asSnapshotObject(value: unknown): SnapshotObject {
  const parsed = CorrespondenceJsonObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw snapshotError(
      "snapshot_context_unavailable",
      "Snapshot evidence is not a JSON object",
      {},
      parsed.error,
    );
  }
  return parsed.data;
}

function afterCutoff(valueUtc: string, cutoffUtc: string): boolean {
  return Date.parse(valueUtc) > Date.parse(cutoffUtc);
}

function validateBudgets(
  budgets: CorrespondenceSnapshotBudgets,
): CorrespondenceSnapshotBudgets {
  for (const [field, value] of Object.entries(budgets)) {
    if (!Number.isInteger(value) || value < 0 || value > 2_000) {
      throw snapshotError(
        "snapshot_invalid_budget",
        "Correspondence snapshot budgets must be integers from 0 through 2000",
        { field, value },
      );
    }
  }
  const intents =
    budgets.dailyLifeIntents +
    budgets.personalIntentions +
    budgets.scheduleItems;
  const causal =
    budgets.dilemmas +
    budgets.pressureEpisodes +
    budgets.supportInterventions +
    budgets.decisions +
    budgets.actions +
    budgets.outcomes +
    budgets.reflections +
    budgets.relationshipMilestones;
  if (
    intents > 1_000 ||
    causal > 2_000 ||
    budgets.memoryRecords + budgets.eventCards > 2_000 ||
    budgets.conversationMessages > 500 ||
    budgets.priorLetters > 500 ||
    budgets.readyKeepsakes > 100
  ) {
    throw snapshotError(
      "snapshot_invalid_budget",
      "Combined snapshot budgets exceed the strict context contract",
      { intents, causal },
    );
  }
  return Object.freeze({ ...budgets });
}

function snapshotError(
  code: CorrespondenceSnapshotErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): CorrespondenceSnapshotError {
  return new CorrespondenceSnapshotError(code, message, details, { cause });
}
