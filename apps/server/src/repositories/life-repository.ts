import {
  ActionRecordSchema,
  DailyLifeContextSchema,
  DailyLifeIntentSchema,
  DecisionRecordSchema,
  DilemmaEpisodeSchema,
  LifeOutcomeSchema,
  LifeThreadSchema,
  OutcomeRecordSchema,
  PressureEpisodeSchema,
  ReflectionRecordSchema,
  RelationshipMilestoneSchema,
  SupportInterventionSchema,
  type ActionRecord,
  type DailyLifeContext,
  type DailyLifeIntent,
  type DecisionRecord,
  type DilemmaEpisode,
  type LifeOutcome,
  type LifeThread,
  type OutcomeRecord,
  type PressureEpisode,
  type ReflectionRecord,
  type RelationshipMilestone,
  type SupportIntervention,
} from "@personasim/contracts";

import type { Database } from "../db/connection.js";

type JsonRow = Record<string, unknown>;

/**
 * SQLite projection for the fuzzy-life domain. Every table stores a complete,
 * schema-validated JSON document; scalar columns exist only for constraints
 * and bounded queries. That keeps the causal record readable while the old
 * schedule tables remain immutable compatibility history.
 */
export class LifeRepository {
  constructor(private readonly database: Database) {}

  findDailyContext(
    agentId: string,
    localDate: string,
  ): DailyLifeContext | undefined {
    return parseOptional(
      this.database
        .prepare(
          `SELECT context_json AS json
           FROM daily_life_contexts
           WHERE agent_id = ? AND local_date = ?`,
        )
        .get(agentId, localDate),
      DailyLifeContextSchema,
    );
  }

  listDailyContextsBefore(
    agentId: string,
    beforeLocalDate: string,
  ): DailyLifeContext[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT context_json AS json
           FROM daily_life_contexts
           WHERE agent_id = ? AND local_date < ? AND status = 'active'
           ORDER BY local_date`,
        )
        .all(agentId, beforeLocalDate),
      DailyLifeContextSchema,
    );
  }

  insertDailyContext(context: DailyLifeContext): boolean {
    const value = DailyLifeContextSchema.parse(context);
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO daily_life_contexts(
             id, agent_id, local_date, timezone, status, current_period,
             availability, availability_confidence, theme, current_focus,
             today_focus_json, intent_ids_json, active_thread_ids_json,
             current_pressure_episode_ids_json, recent_outcome_ids_json,
             revision, schema_version, context_json, created_at_utc,
             updated_at_utc
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.agentId,
          value.localDate,
          value.timezone,
          value.status,
          value.currentPeriod,
          value.availability,
          value.availabilityConfidence,
          value.theme ?? null,
          value.currentFocus ?? null,
          JSON.stringify(value.todayFocus),
          JSON.stringify(value.intentIds),
          JSON.stringify(value.activeThreadIds),
          JSON.stringify(value.currentPressureEpisodeIds),
          JSON.stringify(value.recentOutcomeIds),
          value.revision,
          value.schemaVersion,
          JSON.stringify(value),
          value.createdAtUtc,
          value.updatedAtUtc,
        ).changes > 0
    );
  }

  updateDailyContext(context: DailyLifeContext): void {
    const value = DailyLifeContextSchema.parse(context);
    const result = this.database
      .prepare(
        `UPDATE daily_life_contexts SET
           status = ?, current_period = ?, availability = ?,
           availability_confidence = ?, theme = ?, current_focus = ?,
           today_focus_json = ?, intent_ids_json = ?,
           active_thread_ids_json = ?, current_pressure_episode_ids_json = ?,
           recent_outcome_ids_json = ?, revision = ?, schema_version = ?,
           context_json = ?, updated_at_utc = ?
         WHERE id = ? AND agent_id = ?`,
      )
      .run(
        value.status,
        value.currentPeriod,
        value.availability,
        value.availabilityConfidence,
        value.theme ?? null,
        value.currentFocus ?? null,
        JSON.stringify(value.todayFocus),
        JSON.stringify(value.intentIds),
        JSON.stringify(value.activeThreadIds),
        JSON.stringify(value.currentPressureEpisodeIds),
        JSON.stringify(value.recentOutcomeIds),
        value.revision,
        value.schemaVersion,
        JSON.stringify(value),
        value.updatedAtUtc,
        value.id,
        value.agentId,
      );
    if (result.changes !== 1)
      throw new Error("Daily life context was not updated");
  }

  listDailyIntents(contextId: string): DailyLifeIntent[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT intent_json AS json
           FROM daily_life_intents
           WHERE context_id = ?
           ORDER BY importance DESC, rowid`,
        )
        .all(contextId),
      DailyLifeIntentSchema,
    );
  }

  insertDailyIntent(intent: DailyLifeIntent): boolean {
    const value = DailyLifeIntentSchema.parse(intent);
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO daily_life_intents(
             id, agent_id, context_id, local_date, title, summary, domain,
             period, duration_band, commitment_level, status, source_kind,
             shareable, importance, thread_ids_json, goal_ref_ids_json,
             evidence_message_ids_json, deferred_to_local_date,
             idempotency_key, revision, schema_version, intent_json,
             created_at_utc, updated_at_utc
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.agentId,
          value.contextId,
          value.localDate,
          value.title,
          value.summary,
          value.domain,
          value.period,
          value.durationBand,
          value.commitmentLevel,
          value.status,
          value.sourceKind,
          value.shareable ? 1 : 0,
          value.importance,
          JSON.stringify(value.threadIds),
          JSON.stringify(value.goalRefIds),
          JSON.stringify(value.evidenceMessageIds),
          value.deferredToLocalDate ?? null,
          value.idempotencyKey,
          value.revision,
          value.schemaVersion,
          JSON.stringify(value),
          value.createdAtUtc,
          value.updatedAtUtc,
        ).changes > 0
    );
  }

  findThreadByIdempotencyKey(key: string): LifeThread | undefined {
    return parseOptional(
      this.database
        .prepare(
          "SELECT thread_json AS json FROM life_threads WHERE idempotency_key = ?",
        )
        .get(key),
      LifeThreadSchema,
    );
  }

  listActiveThreads(agentId: string, limit = 8): LifeThread[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT thread_json AS json FROM life_threads
           WHERE agent_id = ? AND status = 'active'
           ORDER BY updated_at_utc DESC LIMIT ?`,
        )
        .all(agentId, limit),
      LifeThreadSchema,
    );
  }

  insertThread(thread: LifeThread): boolean {
    const value = LifeThreadSchema.parse(thread);
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO life_threads(
             id, agent_id, subject, title, summary, domain, status,
             current_stage, progress_note, next_step_hint, started_local_date,
             last_advanced_local_date, closed_local_date,
             source_message_ids_json, parent_thread_id, idempotency_key,
             revision, schema_version, thread_json, created_at_utc,
             updated_at_utc
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.agentId,
          value.subject,
          value.title,
          value.summary,
          value.domain,
          value.status,
          value.currentStage,
          value.progressNote ?? null,
          value.nextStepHint ?? null,
          value.startedLocalDate,
          value.lastAdvancedLocalDate ?? null,
          value.closedLocalDate ?? null,
          JSON.stringify(value.sourceMessageIds),
          value.parentThreadId ?? null,
          value.idempotencyKey,
          value.revision,
          value.schemaVersion,
          JSON.stringify(value),
          value.createdAtUtc,
          value.updatedAtUtc,
        ).changes > 0
    );
  }

  findLifeOutcomeForIntent(intentId: string): LifeOutcome | undefined {
    return parseOptional(
      this.database
        .prepare(
          "SELECT outcome_json AS json FROM life_outcomes WHERE intent_id = ?",
        )
        .get(intentId),
      LifeOutcomeSchema,
    );
  }

  listRecentLifeOutcomes(agentId: string, limit = 8): LifeOutcome[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT outcome_json AS json FROM life_outcomes
           WHERE agent_id = ?
           ORDER BY effective_local_date DESC, recorded_at_utc DESC LIMIT ?`,
        )
        .all(agentId, limit),
      LifeOutcomeSchema,
    );
  }

  insertLifeOutcome(outcome: LifeOutcome): boolean {
    const value = LifeOutcomeSchema.parse(outcome);
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO life_outcomes(
             id, agent_id, intent_id, outcome_kind, summary,
             outcome_facts_json, origin, thread_ids_json,
             source_evidence_ids_json, importance, state_effects_json,
             effective_local_date, effective_period, temporal_precision,
             recorded_at_utc, idempotency_key, schema_version, outcome_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          value.id,
          value.agentId,
          value.intentId,
          value.outcomeKind,
          value.summary,
          JSON.stringify(value.outcomeFacts),
          value.origin,
          JSON.stringify(value.threadIds),
          JSON.stringify(value.sourceEvidenceIds),
          value.importance,
          value.stateEffects === undefined
            ? null
            : JSON.stringify(value.stateEffects),
          value.effectiveLocalDate,
          value.effectivePeriod ?? null,
          value.temporalPrecision,
          value.recordedAtUtc,
          value.idempotencyKey,
          value.schemaVersion,
          JSON.stringify(value),
        ).changes > 0
    );
  }

  insertDilemma(value: DilemmaEpisode): boolean {
    const episode = DilemmaEpisodeSchema.parse(value);
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO dilemma_episodes(
             id, agent_id, session_id, thread_id, subject, title, summary,
             domain, options_json, status, closure_kind, closure_summary,
             closing_decision_id, source_message_ids_json,
             effective_local_date, effective_period, temporal_precision,
             recorded_at_utc, updated_at_utc, idempotency_key,
             schema_version, episode_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          episode.id,
          episode.agentId,
          episode.sessionId ?? null,
          episode.threadId ?? null,
          episode.subject,
          episode.title,
          episode.summary,
          episode.domain,
          JSON.stringify(episode.options),
          episode.status,
          episode.closureKind ?? null,
          episode.closureSummary ?? null,
          episode.closingDecisionId ?? null,
          JSON.stringify(episode.sourceMessageIds),
          episode.effectiveLocalDate,
          episode.effectivePeriod ?? null,
          episode.temporalPrecision,
          episode.recordedAtUtc,
          episode.updatedAtUtc,
          episode.idempotencyKey,
          episode.schemaVersion,
          JSON.stringify(episode),
        ).changes > 0
    );
  }

  updateDilemma(value: DilemmaEpisode): void {
    const episode = DilemmaEpisodeSchema.parse(value);
    const result = this.database
      .prepare(
        `UPDATE dilemma_episodes SET title = ?, summary = ?, domain = ?,
           options_json = ?, status = ?, closure_kind = ?,
           closure_summary = ?, closing_decision_id = ?,
           source_message_ids_json = ?, updated_at_utc = ?, episode_json = ?
         WHERE id = ? AND agent_id = ?`,
      )
      .run(
        episode.title,
        episode.summary,
        episode.domain,
        JSON.stringify(episode.options),
        episode.status,
        episode.closureKind ?? null,
        episode.closureSummary ?? null,
        episode.closingDecisionId ?? null,
        JSON.stringify(episode.sourceMessageIds),
        episode.updatedAtUtc,
        JSON.stringify(episode),
        episode.id,
        episode.agentId,
      );
    if (result.changes !== 1)
      throw new Error("Dilemma episode was not updated");
  }

  listOpenDilemmas(agentId: string, limit = 6): DilemmaEpisode[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT episode_json AS json FROM dilemma_episodes
           WHERE agent_id = ? AND status = 'open'
           ORDER BY recorded_at_utc DESC LIMIT ?`,
        )
        .all(agentId, limit),
      DilemmaEpisodeSchema,
    );
  }

  insertPressure(value: PressureEpisode): boolean {
    const episode = PressureEpisodeSchema.parse(value);
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO pressure_episodes(
             id, agent_id, session_id, thread_id, dilemma_id, subject,
             pressure_kind, trigger_summary, status, initial_pressure,
             current_pressure, initial_clarity, current_clarity,
             initial_felt_understood, current_felt_understood,
             intervention_ids_json, outcome_ids_json, source_message_ids_json,
             latest_evidence_message_id, resolution_evidence_message_id,
             effective_local_date, effective_period, temporal_precision,
             recorded_at_utc, updated_at_utc, idempotency_key,
             schema_version, episode_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          episode.id,
          episode.agentId,
          episode.sessionId ?? null,
          episode.threadId ?? null,
          episode.dilemmaId ?? null,
          episode.subject,
          episode.pressureKind,
          episode.triggerSummary,
          episode.status,
          episode.initialPressure,
          episode.currentPressure,
          episode.initialClarity,
          episode.currentClarity,
          episode.initialFeltUnderstood,
          episode.currentFeltUnderstood,
          JSON.stringify(episode.interventionIds),
          JSON.stringify(episode.outcomeIds),
          JSON.stringify(episode.sourceMessageIds),
          episode.latestEvidenceMessageId,
          episode.resolutionEvidenceMessageId ?? null,
          episode.effectiveLocalDate,
          episode.effectivePeriod ?? null,
          episode.temporalPrecision,
          episode.recordedAtUtc,
          episode.updatedAtUtc,
          episode.idempotencyKey,
          episode.schemaVersion,
          JSON.stringify(episode),
        ).changes > 0
    );
  }

  updatePressure(value: PressureEpisode): void {
    const episode = PressureEpisodeSchema.parse(value);
    const result = this.database
      .prepare(
        `UPDATE pressure_episodes SET status = ?, initial_pressure = ?,
           current_pressure = ?, initial_clarity = ?, current_clarity = ?,
           initial_felt_understood = ?, current_felt_understood = ?,
           intervention_ids_json = ?, outcome_ids_json = ?,
           source_message_ids_json = ?, latest_evidence_message_id = ?,
           resolution_evidence_message_id = ?, updated_at_utc = ?,
           episode_json = ? WHERE id = ? AND agent_id = ?`,
      )
      .run(
        episode.status,
        episode.initialPressure,
        episode.currentPressure,
        episode.initialClarity,
        episode.currentClarity,
        episode.initialFeltUnderstood,
        episode.currentFeltUnderstood,
        JSON.stringify(episode.interventionIds),
        JSON.stringify(episode.outcomeIds),
        JSON.stringify(episode.sourceMessageIds),
        episode.latestEvidenceMessageId,
        episode.resolutionEvidenceMessageId ?? null,
        episode.updatedAtUtc,
        JSON.stringify(episode),
        episode.id,
        episode.agentId,
      );
    if (result.changes !== 1)
      throw new Error("Pressure episode was not updated");
  }

  listOpenPressures(agentId: string, limit = 6): PressureEpisode[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT episode_json AS json FROM pressure_episodes
           WHERE agent_id = ? AND status IN ('open', 'improving', 'worsening')
           ORDER BY updated_at_utc DESC LIMIT ?`,
        )
        .all(agentId, limit),
      PressureEpisodeSchema,
    );
  }

  insertIntervention(value: SupportIntervention): boolean {
    const intervention = SupportInterventionSchema.parse(value);
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO support_interventions(
             id, agent_id, session_id, dilemma_id, pressure_episode_id,
             mode, offered_by, received_by, summary, intended_effect,
             recommendation_option_id, source_message_id,
             effective_local_date, effective_period, temporal_precision,
             recorded_at_utc, idempotency_key, schema_version,
             intervention_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          intervention.id,
          intervention.agentId,
          intervention.sessionId,
          intervention.dilemmaId ?? null,
          intervention.pressureEpisodeId ?? null,
          intervention.mode,
          intervention.offeredBy,
          intervention.receivedBy,
          intervention.summary,
          intervention.intendedEffect,
          intervention.recommendationOptionId ?? null,
          intervention.sourceMessageId,
          intervention.effectiveLocalDate,
          intervention.effectivePeriod ?? null,
          intervention.temporalPrecision,
          intervention.recordedAtUtc,
          intervention.idempotencyKey,
          intervention.schemaVersion,
          JSON.stringify(intervention),
        ).changes > 0
    );
  }

  listRecentInterventions(agentId: string, limit = 8): SupportIntervention[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT intervention_json AS json FROM support_interventions
           WHERE agent_id = ?
           ORDER BY recorded_at_utc DESC, rowid DESC LIMIT ?`,
        )
        .all(agentId, limit),
      SupportInterventionSchema,
    );
  }

  insertDecision(value: DecisionRecord): boolean {
    const decision = DecisionRecordSchema.parse(value);
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO decision_records(
             id, agent_id, session_id, dilemma_id, subject, support_mode,
             authority, decided_by, selected_option_id, selection_summary,
             reasoning_summary, support_intervention_ids_json,
             source_message_ids_json, authorized_by_message_id, confidence,
             status, supersedes_decision_id, superseded_by_decision_id,
             retracted_by_message_id, effective_local_date, effective_period,
             temporal_precision, recorded_at_utc, idempotency_key,
             schema_version, decision_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          decision.id,
          decision.agentId,
          decision.sessionId,
          decision.dilemmaId,
          decision.subject,
          decision.supportMode,
          decision.authority,
          decision.decidedBy,
          decision.selectedOptionId,
          decision.selectionSummary,
          decision.reasoningSummary,
          JSON.stringify(decision.supportInterventionIds),
          JSON.stringify(decision.sourceMessageIds),
          decision.authorizedByMessageId ?? null,
          decision.confidence,
          decision.status,
          decision.supersedesDecisionId ?? null,
          decision.supersededByDecisionId ?? null,
          decision.retractedByMessageId ?? null,
          decision.effectiveLocalDate,
          decision.effectivePeriod ?? null,
          decision.temporalPrecision,
          decision.recordedAtUtc,
          decision.idempotencyKey,
          decision.schemaVersion,
          JSON.stringify(decision),
        ).changes > 0
    );
  }

  listCurrentDecisions(agentId: string, limit = 8): DecisionRecord[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT decision_json AS json FROM decision_records
           WHERE agent_id = ? AND status = 'current'
           ORDER BY recorded_at_utc DESC LIMIT ?`,
        )
        .all(agentId, limit),
      DecisionRecordSchema,
    );
  }

  insertAction(value: ActionRecord): boolean {
    const action = ActionRecordSchema.parse(value);
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO action_records(
             id, agent_id, session_id, decision_id, subject, performed_by,
             action_kind, summary, source_evidence_ids_json,
             effective_local_date, effective_period, temporal_precision,
             recorded_at_utc, idempotency_key, schema_version, action_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          action.id,
          action.agentId,
          action.sessionId ?? null,
          action.decisionId,
          action.subject,
          action.performedBy,
          action.actionKind,
          action.summary,
          JSON.stringify(action.sourceEvidenceIds),
          action.effectiveLocalDate,
          action.effectivePeriod ?? null,
          action.temporalPrecision,
          action.recordedAtUtc,
          action.idempotencyKey,
          action.schemaVersion,
          JSON.stringify(action),
        ).changes > 0
    );
  }

  listActionsForDecision(decisionId: string, limit = 12): ActionRecord[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT action_json AS json FROM action_records
           WHERE decision_id = ?
           ORDER BY recorded_at_utc DESC LIMIT ?`,
        )
        .all(decisionId, limit),
      ActionRecordSchema,
    );
  }

  listRecentActions(agentId: string, limit = 8): ActionRecord[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT action_json AS json FROM action_records
           WHERE agent_id = ?
           ORDER BY recorded_at_utc DESC LIMIT ?`,
        )
        .all(agentId, limit),
      ActionRecordSchema,
    );
  }

  insertOutcomeRecord(value: OutcomeRecord): boolean {
    const outcome = OutcomeRecordSchema.parse(value);
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO outcome_records(
             id, agent_id, session_id, decision_id, action_ids_json,
             cause_kind, valence, summary, consequence_facts_json,
             source_evidence_ids_json, confidence, status,
             superseded_by_outcome_id, effective_local_date, effective_period,
             temporal_precision, recorded_at_utc, idempotency_key,
             schema_version, outcome_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          outcome.id,
          outcome.agentId,
          outcome.sessionId ?? null,
          outcome.decisionId,
          JSON.stringify(outcome.actionIds),
          outcome.causeKind,
          outcome.valence,
          outcome.summary,
          JSON.stringify(outcome.consequenceFacts),
          JSON.stringify(outcome.sourceEvidenceIds),
          outcome.confidence,
          outcome.status,
          outcome.supersededByOutcomeId ?? null,
          outcome.effectiveLocalDate,
          outcome.effectivePeriod ?? null,
          outcome.temporalPrecision,
          outcome.recordedAtUtc,
          outcome.idempotencyKey,
          outcome.schemaVersion,
          JSON.stringify(outcome),
        ).changes > 0
    );
  }

  listRecentOutcomeRecords(agentId: string, limit = 8): OutcomeRecord[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT outcome_json AS json FROM outcome_records
           WHERE agent_id = ? AND status <> 'superseded'
           ORDER BY recorded_at_utc DESC LIMIT ?`,
        )
        .all(agentId, limit),
      OutcomeRecordSchema,
    );
  }

  insertReflection(value: ReflectionRecord): boolean {
    const reflection = ReflectionRecordSchema.parse(value);
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO reflection_records(
             id, agent_id, session_id, subject, reflected_by, decision_id,
             outcome_id, summary, lessons_json, stance_toward_decision,
             changed_interpretation, source_message_ids_json,
             effective_local_date, effective_period, temporal_precision,
             recorded_at_utc, idempotency_key, schema_version, reflection_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          reflection.id,
          reflection.agentId,
          reflection.sessionId ?? null,
          reflection.subject,
          reflection.reflectedBy,
          reflection.decisionId ?? null,
          reflection.outcomeId ?? null,
          reflection.summary,
          JSON.stringify(reflection.lessons),
          reflection.stanceTowardDecision,
          reflection.changedInterpretation ? 1 : 0,
          JSON.stringify(reflection.sourceMessageIds),
          reflection.effectiveLocalDate,
          reflection.effectivePeriod ?? null,
          reflection.temporalPrecision,
          reflection.recordedAtUtc,
          reflection.idempotencyKey,
          reflection.schemaVersion,
          JSON.stringify(reflection),
        ).changes > 0
    );
  }

  listRecentReflections(agentId: string, limit = 8): ReflectionRecord[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT reflection_json AS json FROM reflection_records
           WHERE agent_id = ?
           ORDER BY recorded_at_utc DESC LIMIT ?`,
        )
        .all(agentId, limit),
      ReflectionRecordSchema,
    );
  }

  insertMilestone(value: RelationshipMilestone): boolean {
    const milestone = RelationshipMilestoneSchema.parse(value);
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO relationship_milestones(
             id, agent_id, session_id, kind, title, summary, significance,
             relationship_delta_json, intervention_ids_json,
             decision_ids_json, outcome_ids_json, reflection_ids_json,
             source_message_ids_json, effective_local_date, effective_period,
             temporal_precision, recorded_at_utc, idempotency_key,
             schema_version, milestone_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          milestone.id,
          milestone.agentId,
          milestone.sessionId ?? null,
          milestone.kind,
          milestone.title,
          milestone.summary,
          milestone.significance,
          milestone.relationshipDelta === undefined
            ? null
            : JSON.stringify(milestone.relationshipDelta),
          JSON.stringify(milestone.interventionIds),
          JSON.stringify(milestone.decisionIds),
          JSON.stringify(milestone.outcomeIds),
          JSON.stringify(milestone.reflectionIds),
          JSON.stringify(milestone.sourceMessageIds),
          milestone.effectiveLocalDate,
          milestone.effectivePeriod ?? null,
          milestone.temporalPrecision,
          milestone.recordedAtUtc,
          milestone.idempotencyKey,
          milestone.schemaVersion,
          JSON.stringify(milestone),
        ).changes > 0
    );
  }

  listRecentMilestones(agentId: string, limit = 6): RelationshipMilestone[] {
    return parseRows(
      this.database
        .prepare(
          `SELECT milestone_json AS json FROM relationship_milestones
           WHERE agent_id = ?
           ORDER BY effective_local_date DESC, significance DESC LIMIT ?`,
        )
        .all(agentId, limit),
      RelationshipMilestoneSchema,
    );
  }
}

function parseOptional<T>(
  row: unknown,
  schema: { parse(value: unknown): T },
): T | undefined {
  if (row === undefined) return undefined;
  return schema.parse(JSON.parse(String((row as JsonRow)["json"])));
}

function parseRows<T>(
  rows: unknown[],
  schema: { parse(value: unknown): T },
): T[] {
  return rows.map((row) =>
    schema.parse(JSON.parse(String((row as JsonRow)["json"]))),
  );
}
