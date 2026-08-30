-- Pure fuzzy-life planning and evidence-backed decision causality.
-- Existing minute-level schedule tables remain intact for backward compatibility.

CREATE TABLE IF NOT EXISTS daily_life_contexts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL CHECK (
    length(local_date) = 10
    AND local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  timezone TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'superseded')),
  current_period TEXT NOT NULL CHECK (
    current_period IN (
      'early_morning', 'morning', 'midday', 'afternoon',
      'evening', 'late_night'
    )
  ),
  availability TEXT NOT NULL CHECK (
    availability IN ('free', 'interruptible', 'occupied')
  ),
  availability_confidence TEXT NOT NULL CHECK (
    availability_confidence IN ('observed', 'inferred')
  ),
  theme TEXT,
  current_focus TEXT,
  today_focus_json TEXT NOT NULL CHECK (
    json_valid(today_focus_json)
    AND json_type(today_focus_json) = 'array'
    AND json_array_length(today_focus_json) BETWEEN 1 AND 6
  ),
  intent_ids_json TEXT NOT NULL CHECK (
    json_valid(intent_ids_json)
    AND json_type(intent_ids_json) = 'array'
    AND json_array_length(intent_ids_json) BETWEEN 1 AND 8
  ),
  active_thread_ids_json TEXT NOT NULL CHECK (
    json_valid(active_thread_ids_json)
    AND json_type(active_thread_ids_json) = 'array'
  ),
  current_pressure_episode_ids_json TEXT NOT NULL CHECK (
    json_valid(current_pressure_episode_ids_json)
    AND json_type(current_pressure_episode_ids_json) = 'array'
  ),
  recent_outcome_ids_json TEXT NOT NULL CHECK (
    json_valid(recent_outcome_ids_json)
    AND json_type(recent_outcome_ids_json) = 'array'
  ),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  context_json TEXT NOT NULL CHECK (json_valid(context_json)),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  UNIQUE(agent_id, local_date),
  CHECK (created_at_utc <= updated_at_utc)
);

CREATE INDEX IF NOT EXISTS daily_life_contexts_agent_status_idx
  ON daily_life_contexts(agent_id, status, local_date DESC);

CREATE TABLE IF NOT EXISTS daily_life_intents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  context_id TEXT NOT NULL
    REFERENCES daily_life_contexts(id) ON DELETE CASCADE,
  local_date TEXT NOT NULL CHECK (
    length(local_date) = 10
    AND local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (
    domain IN (
      'work', 'study', 'creative', 'health', 'rest', 'social',
      'household', 'errand', 'leisure', 'self_reflection',
      'relationship', 'identity', 'other'
    )
  ),
  period TEXT NOT NULL CHECK (
    period IN (
      'early_morning', 'morning', 'midday', 'afternoon',
      'evening', 'late_night', 'anytime'
    )
  ),
  duration_band TEXT NOT NULL CHECK (
    duration_band IN ('brief', 'part_of_period', 'most_of_period', 'open_ended')
  ),
  commitment_level TEXT NOT NULL CHECK (
    commitment_level IN ('anchor', 'priority', 'optional')
  ),
  status TEXT NOT NULL CHECK (
    status IN ('intended', 'deferred', 'cancelled', 'superseded')
  ),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN (
      'routine', 'goal', 'life_thread', 'chat', 'spontaneous', 'carryover'
    )
  ),
  shareable INTEGER NOT NULL CHECK (shareable IN (0, 1)),
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  thread_ids_json TEXT NOT NULL CHECK (
    json_valid(thread_ids_json) AND json_type(thread_ids_json) = 'array'
  ),
  goal_ref_ids_json TEXT NOT NULL CHECK (
    json_valid(goal_ref_ids_json) AND json_type(goal_ref_ids_json) = 'array'
  ),
  evidence_message_ids_json TEXT NOT NULL CHECK (
    json_valid(evidence_message_ids_json)
    AND json_type(evidence_message_ids_json) = 'array'
  ),
  deferred_to_local_date TEXT CHECK (
    deferred_to_local_date IS NULL
    OR (
      length(deferred_to_local_date) = 10
      AND deferred_to_local_date GLOB
        '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    )
  ),
  idempotency_key TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  intent_json TEXT NOT NULL CHECK (json_valid(intent_json)),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  CHECK (created_at_utc <= updated_at_utc),
  CHECK (
    (status = 'deferred' AND deferred_to_local_date > local_date)
    OR (status <> 'deferred' AND deferred_to_local_date IS NULL)
  ),
  CHECK (
    source_kind <> 'chat'
    OR json_array_length(evidence_message_ids_json) > 0
  )
);

CREATE INDEX IF NOT EXISTS daily_life_intents_agent_day_idx
  ON daily_life_intents(agent_id, local_date, status, commitment_level);

CREATE INDEX IF NOT EXISTS daily_life_intents_context_idx
  ON daily_life_intents(context_id, status);

CREATE TABLE IF NOT EXISTS life_threads (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  subject TEXT NOT NULL CHECK (subject IN ('user', 'character', 'shared')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (
    domain IN (
      'work', 'study', 'creative', 'health', 'rest', 'social',
      'household', 'errand', 'leisure', 'self_reflection',
      'relationship', 'identity', 'other'
    )
  ),
  status TEXT NOT NULL CHECK (
    status IN ('active', 'paused', 'resolved', 'abandoned')
  ),
  current_stage TEXT NOT NULL,
  progress_note TEXT,
  next_step_hint TEXT,
  started_local_date TEXT NOT NULL CHECK (
    length(started_local_date) = 10
    AND started_local_date GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  last_advanced_local_date TEXT,
  closed_local_date TEXT,
  source_message_ids_json TEXT NOT NULL CHECK (
    json_valid(source_message_ids_json)
    AND json_type(source_message_ids_json) = 'array'
  ),
  parent_thread_id TEXT REFERENCES life_threads(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  thread_json TEXT NOT NULL CHECK (json_valid(thread_json)),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  CHECK (created_at_utc <= updated_at_utc),
  CHECK (
    last_advanced_local_date IS NULL
    OR last_advanced_local_date >= started_local_date
  ),
  CHECK (
    (status IN ('resolved', 'abandoned')
      AND closed_local_date >= started_local_date)
    OR (status IN ('active', 'paused') AND closed_local_date IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS life_threads_agent_status_idx
  ON life_threads(agent_id, subject, status, updated_at_utc DESC);

CREATE TABLE IF NOT EXISTS life_outcomes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  intent_id TEXT NOT NULL UNIQUE
    REFERENCES daily_life_intents(id) ON DELETE CASCADE,
  outcome_kind TEXT NOT NULL CHECK (
    outcome_kind IN ('completed', 'partial', 'skipped', 'deferred', 'cancelled')
  ),
  summary TEXT NOT NULL,
  outcome_facts_json TEXT NOT NULL CHECK (
    json_valid(outcome_facts_json)
    AND json_type(outcome_facts_json) = 'array'
    AND json_array_length(outcome_facts_json) > 0
  ),
  origin TEXT NOT NULL CHECK (
    origin IN (
      'simulation', 'conversation_evidence', 'user_report', 'character_report'
    )
  ),
  thread_ids_json TEXT NOT NULL CHECK (
    json_valid(thread_ids_json) AND json_type(thread_ids_json) = 'array'
  ),
  source_evidence_ids_json TEXT NOT NULL CHECK (
    json_valid(source_evidence_ids_json)
    AND json_type(source_evidence_ids_json) = 'array'
    AND json_array_length(source_evidence_ids_json) > 0
  ),
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  state_effects_json TEXT CHECK (
    state_effects_json IS NULL
    OR (json_valid(state_effects_json) AND json_type(state_effects_json) = 'object')
  ),
  effective_local_date TEXT NOT NULL CHECK (
    length(effective_local_date) = 10
    AND effective_local_date GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  effective_period TEXT,
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('day', 'period')
  ),
  recorded_at_utc TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
  CHECK (
    (temporal_precision = 'day' AND effective_period IS NULL)
    OR (
      temporal_precision = 'period'
      AND effective_period IN (
        'early_morning', 'morning', 'midday', 'afternoon',
        'evening', 'late_night'
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS life_outcomes_agent_time_idx
  ON life_outcomes(agent_id, effective_local_date DESC, recorded_at_utc DESC);

CREATE TABLE IF NOT EXISTS dilemma_episodes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  thread_id TEXT REFERENCES life_threads(id) ON DELETE SET NULL,
  subject TEXT NOT NULL CHECK (subject IN ('user', 'character', 'shared')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  domain TEXT NOT NULL CHECK (
    domain IN (
      'work', 'study', 'creative', 'health', 'rest', 'social',
      'household', 'errand', 'leisure', 'self_reflection',
      'relationship', 'identity', 'other'
    )
  ),
  options_json TEXT NOT NULL CHECK (
    json_valid(options_json)
    AND json_type(options_json) = 'array'
    AND json_array_length(options_json) BETWEEN 2 AND 12
  ),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'abandoned')),
  closure_kind TEXT CHECK (
    closure_kind IS NULL
    OR closure_kind IN ('decision', 'circumstance', 'abandoned')
  ),
  closure_summary TEXT,
  closing_decision_id TEXT,
  source_message_ids_json TEXT NOT NULL CHECK (
    json_valid(source_message_ids_json)
    AND json_type(source_message_ids_json) = 'array'
    AND json_array_length(source_message_ids_json) > 0
  ),
  effective_local_date TEXT NOT NULL CHECK (
    length(effective_local_date) = 10
    AND effective_local_date GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  effective_period TEXT,
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('day', 'period')
  ),
  recorded_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  episode_json TEXT NOT NULL CHECK (json_valid(episode_json)),
  CHECK (recorded_at_utc <= updated_at_utc),
  CHECK (
    (temporal_precision = 'day' AND effective_period IS NULL)
    OR (
      temporal_precision = 'period'
      AND effective_period IN (
        'early_morning', 'morning', 'midday', 'afternoon',
        'evening', 'late_night'
      )
    )
  ),
  CHECK (
    (status = 'open' AND closure_kind IS NULL
      AND closure_summary IS NULL AND closing_decision_id IS NULL)
    OR (status = 'closed' AND closure_kind IN ('decision', 'circumstance')
      AND closure_summary IS NOT NULL
      AND ((closure_kind = 'decision' AND closing_decision_id IS NOT NULL)
        OR (closure_kind = 'circumstance' AND closing_decision_id IS NULL)))
    OR (status = 'abandoned' AND closure_kind = 'abandoned'
      AND closure_summary IS NOT NULL AND closing_decision_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS dilemma_episodes_agent_status_idx
  ON dilemma_episodes(agent_id, subject, status, recorded_at_utc DESC);

CREATE TABLE IF NOT EXISTS pressure_episodes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  thread_id TEXT REFERENCES life_threads(id) ON DELETE SET NULL,
  dilemma_id TEXT REFERENCES dilemma_episodes(id) ON DELETE SET NULL,
  subject TEXT NOT NULL CHECK (subject IN ('user', 'character', 'shared')),
  pressure_kind TEXT NOT NULL CHECK (
    pressure_kind IN (
      'work', 'relationship', 'identity', 'health', 'grief', 'decision', 'other'
    )
  ),
  trigger_summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('open', 'improving', 'worsening', 'resolved')
  ),
  initial_pressure REAL NOT NULL CHECK (initial_pressure BETWEEN 0 AND 1),
  current_pressure REAL NOT NULL CHECK (current_pressure BETWEEN 0 AND 1),
  initial_clarity REAL NOT NULL CHECK (initial_clarity BETWEEN 0 AND 1),
  current_clarity REAL NOT NULL CHECK (current_clarity BETWEEN 0 AND 1),
  initial_felt_understood REAL NOT NULL CHECK (
    initial_felt_understood BETWEEN 0 AND 1
  ),
  current_felt_understood REAL NOT NULL CHECK (
    current_felt_understood BETWEEN 0 AND 1
  ),
  intervention_ids_json TEXT NOT NULL CHECK (
    json_valid(intervention_ids_json)
    AND json_type(intervention_ids_json) = 'array'
  ),
  outcome_ids_json TEXT NOT NULL CHECK (
    json_valid(outcome_ids_json) AND json_type(outcome_ids_json) = 'array'
  ),
  source_message_ids_json TEXT NOT NULL CHECK (
    json_valid(source_message_ids_json)
    AND json_type(source_message_ids_json) = 'array'
    AND json_array_length(source_message_ids_json) > 0
  ),
  latest_evidence_message_id TEXT NOT NULL
    REFERENCES messages(id) ON DELETE RESTRICT,
  resolution_evidence_message_id TEXT
    REFERENCES messages(id) ON DELETE RESTRICT,
  effective_local_date TEXT NOT NULL CHECK (
    length(effective_local_date) = 10
    AND effective_local_date GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  effective_period TEXT,
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('day', 'period')
  ),
  recorded_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  episode_json TEXT NOT NULL CHECK (json_valid(episode_json)),
  CHECK (recorded_at_utc <= updated_at_utc),
  CHECK (
    (status = 'resolved' AND resolution_evidence_message_id IS NOT NULL)
    OR (status <> 'resolved' AND resolution_evidence_message_id IS NULL)
  ),
  CHECK (
    (temporal_precision = 'day' AND effective_period IS NULL)
    OR (
      temporal_precision = 'period'
      AND effective_period IN (
        'early_morning', 'morning', 'midday', 'afternoon',
        'evening', 'late_night'
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS pressure_episodes_agent_status_idx
  ON pressure_episodes(agent_id, subject, status, updated_at_utc DESC);

CREATE TABLE IF NOT EXISTS support_interventions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  dilemma_id TEXT REFERENCES dilemma_episodes(id) ON DELETE SET NULL,
  pressure_episode_id TEXT REFERENCES pressure_episodes(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK (
    mode IN ('listen_only', 'deliberate', 'recommend', 'delegated_decision')
  ),
  offered_by TEXT NOT NULL CHECK (offered_by IN ('user', 'character')),
  received_by TEXT NOT NULL CHECK (received_by IN ('user', 'character')),
  summary TEXT NOT NULL,
  intended_effect TEXT NOT NULL,
  recommendation_option_id TEXT,
  source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  effective_local_date TEXT NOT NULL CHECK (
    length(effective_local_date) = 10
    AND effective_local_date GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  effective_period TEXT,
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('day', 'period')
  ),
  recorded_at_utc TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  intervention_json TEXT NOT NULL CHECK (json_valid(intervention_json)),
  CHECK (dilemma_id IS NOT NULL OR pressure_episode_id IS NOT NULL),
  CHECK (offered_by <> received_by),
  CHECK (
    (mode IN ('recommend', 'delegated_decision')
      AND recommendation_option_id IS NOT NULL)
    OR (mode IN ('listen_only', 'deliberate')
      AND recommendation_option_id IS NULL)
  ),
  CHECK (
    (temporal_precision = 'day' AND effective_period IS NULL)
    OR (
      temporal_precision = 'period'
      AND effective_period IN (
        'early_morning', 'morning', 'midday', 'afternoon',
        'evening', 'late_night'
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS support_interventions_dilemma_idx
  ON support_interventions(agent_id, dilemma_id, recorded_at_utc);

CREATE INDEX IF NOT EXISTS support_interventions_pressure_idx
  ON support_interventions(agent_id, pressure_episode_id, recorded_at_utc);

CREATE TABLE IF NOT EXISTS decision_records (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  dilemma_id TEXT NOT NULL
    REFERENCES dilemma_episodes(id) ON DELETE RESTRICT,
  subject TEXT NOT NULL CHECK (subject IN ('user', 'character', 'shared')),
  support_mode TEXT NOT NULL CHECK (
    support_mode IN (
      'listen_only', 'deliberate', 'recommend', 'delegated_decision'
    )
  ),
  authority TEXT NOT NULL CHECK (
    authority IN ('subject', 'shared', 'delegated')
  ),
  decided_by TEXT NOT NULL CHECK (decided_by IN ('user', 'character', 'joint')),
  selected_option_id TEXT NOT NULL,
  selection_summary TEXT NOT NULL,
  reasoning_summary TEXT NOT NULL,
  support_intervention_ids_json TEXT NOT NULL CHECK (
    json_valid(support_intervention_ids_json)
    AND json_type(support_intervention_ids_json) = 'array'
  ),
  source_message_ids_json TEXT NOT NULL CHECK (
    json_valid(source_message_ids_json)
    AND json_type(source_message_ids_json) = 'array'
    AND json_array_length(source_message_ids_json) > 0
  ),
  authorized_by_message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL CHECK (status IN ('current', 'superseded', 'retracted')),
  supersedes_decision_id TEXT REFERENCES decision_records(id) ON DELETE SET NULL,
  superseded_by_decision_id TEXT REFERENCES decision_records(id) ON DELETE RESTRICT,
  retracted_by_message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT,
  effective_local_date TEXT NOT NULL CHECK (
    length(effective_local_date) = 10
    AND effective_local_date GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  effective_period TEXT,
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('day', 'period')
  ),
  recorded_at_utc TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  decision_json TEXT NOT NULL CHECK (json_valid(decision_json)),
  CHECK (
    (temporal_precision = 'day' AND effective_period IS NULL)
    OR (
      temporal_precision = 'period'
      AND effective_period IN (
        'early_morning', 'morning', 'midday', 'afternoon',
        'evening', 'late_night'
      )
    )
  ),
  CHECK (
    (authority = 'delegated' AND support_mode = 'delegated_decision'
      AND authorized_by_message_id IS NOT NULL
      AND ((subject = 'user' AND decided_by = 'character')
        OR (subject = 'character' AND decided_by = 'user')
        OR (subject = 'shared' AND decided_by IN ('user', 'character'))))
    OR (authority = 'shared' AND support_mode <> 'delegated_decision'
      AND authorized_by_message_id IS NULL AND decided_by = 'joint')
    OR (authority = 'subject' AND support_mode <> 'delegated_decision'
      AND authorized_by_message_id IS NULL
      AND ((subject = 'user' AND decided_by = 'user')
        OR (subject = 'character' AND decided_by = 'character')
        OR (subject = 'shared' AND decided_by = 'joint')))
  ),
  CHECK (
    (status = 'superseded' AND superseded_by_decision_id IS NOT NULL)
    OR (status <> 'superseded' AND superseded_by_decision_id IS NULL)
  ),
  CHECK (
    (status = 'retracted' AND retracted_by_message_id IS NOT NULL)
    OR (status <> 'retracted' AND retracted_by_message_id IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS decision_records_dilemma_idx
  ON decision_records(agent_id, dilemma_id, recorded_at_utc DESC);

CREATE UNIQUE INDEX IF NOT EXISTS decision_records_one_current_idx
  ON decision_records(dilemma_id)
  WHERE status = 'current';

CREATE TABLE IF NOT EXISTS action_records (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  decision_id TEXT NOT NULL REFERENCES decision_records(id) ON DELETE RESTRICT,
  subject TEXT NOT NULL CHECK (subject IN ('user', 'character', 'shared')),
  performed_by TEXT NOT NULL CHECK (
    performed_by IN ('user', 'character', 'joint')
  ),
  action_kind TEXT NOT NULL CHECK (
    action_kind IN ('initiated', 'advanced', 'completed', 'abandoned')
  ),
  summary TEXT NOT NULL,
  source_evidence_ids_json TEXT NOT NULL CHECK (
    json_valid(source_evidence_ids_json)
    AND json_type(source_evidence_ids_json) = 'array'
    AND json_array_length(source_evidence_ids_json) > 0
  ),
  effective_local_date TEXT NOT NULL CHECK (
    length(effective_local_date) = 10
    AND effective_local_date GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  effective_period TEXT,
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('day', 'period')
  ),
  recorded_at_utc TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  action_json TEXT NOT NULL CHECK (json_valid(action_json)),
  CHECK (
    (temporal_precision = 'day' AND effective_period IS NULL)
    OR (
      temporal_precision = 'period'
      AND effective_period IN (
        'early_morning', 'morning', 'midday', 'afternoon',
        'evening', 'late_night'
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS action_records_decision_idx
  ON action_records(agent_id, decision_id, effective_local_date, recorded_at_utc);

CREATE TABLE IF NOT EXISTS outcome_records (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  decision_id TEXT NOT NULL REFERENCES decision_records(id) ON DELETE RESTRICT,
  action_ids_json TEXT NOT NULL CHECK (
    json_valid(action_ids_json) AND json_type(action_ids_json) = 'array'
  ),
  cause_kind TEXT NOT NULL CHECK (cause_kind IN ('action', 'external', 'mixed')),
  valence TEXT NOT NULL CHECK (
    valence IN ('positive', 'negative', 'mixed', 'neutral')
  ),
  summary TEXT NOT NULL,
  consequence_facts_json TEXT NOT NULL CHECK (
    json_valid(consequence_facts_json)
    AND json_type(consequence_facts_json) = 'array'
    AND json_array_length(consequence_facts_json) > 0
  ),
  source_evidence_ids_json TEXT NOT NULL CHECK (
    json_valid(source_evidence_ids_json)
    AND json_type(source_evidence_ids_json) = 'array'
    AND json_array_length(source_evidence_ids_json) > 0
  ),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  status TEXT NOT NULL CHECK (status IN ('observed', 'confirmed', 'superseded')),
  superseded_by_outcome_id TEXT REFERENCES outcome_records(id) ON DELETE RESTRICT,
  effective_local_date TEXT NOT NULL CHECK (
    length(effective_local_date) = 10
    AND effective_local_date GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  effective_period TEXT,
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('day', 'period')
  ),
  recorded_at_utc TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
  CHECK (
    (cause_kind IN ('action', 'mixed') AND json_array_length(action_ids_json) > 0)
    OR (cause_kind = 'external' AND json_array_length(action_ids_json) = 0)
  ),
  CHECK (
    (status = 'superseded' AND superseded_by_outcome_id IS NOT NULL)
    OR (status <> 'superseded' AND superseded_by_outcome_id IS NULL)
  ),
  CHECK (
    (temporal_precision = 'day' AND effective_period IS NULL)
    OR (
      temporal_precision = 'period'
      AND effective_period IN (
        'early_morning', 'morning', 'midday', 'afternoon',
        'evening', 'late_night'
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS outcome_records_decision_idx
  ON outcome_records(agent_id, decision_id, effective_local_date, recorded_at_utc);

CREATE TABLE IF NOT EXISTS reflection_records (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  subject TEXT NOT NULL CHECK (subject IN ('user', 'character', 'shared')),
  reflected_by TEXT NOT NULL CHECK (
    reflected_by IN ('user', 'character', 'joint')
  ),
  decision_id TEXT REFERENCES decision_records(id) ON DELETE SET NULL,
  outcome_id TEXT REFERENCES outcome_records(id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  lessons_json TEXT NOT NULL CHECK (
    json_valid(lessons_json)
    AND json_type(lessons_json) = 'array'
    AND json_array_length(lessons_json) > 0
  ),
  stance_toward_decision TEXT NOT NULL CHECK (
    stance_toward_decision IN ('affirm', 'question', 'reverse', 'mixed', 'unclear')
  ),
  changed_interpretation INTEGER NOT NULL CHECK (changed_interpretation IN (0, 1)),
  source_message_ids_json TEXT NOT NULL CHECK (
    json_valid(source_message_ids_json)
    AND json_type(source_message_ids_json) = 'array'
    AND json_array_length(source_message_ids_json) > 0
  ),
  effective_local_date TEXT NOT NULL CHECK (
    length(effective_local_date) = 10
    AND effective_local_date GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  effective_period TEXT,
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('day', 'period')
  ),
  recorded_at_utc TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  reflection_json TEXT NOT NULL CHECK (json_valid(reflection_json)),
  CHECK (decision_id IS NOT NULL OR outcome_id IS NOT NULL),
  CHECK (
    (temporal_precision = 'day' AND effective_period IS NULL)
    OR (
      temporal_precision = 'period'
      AND effective_period IN (
        'early_morning', 'morning', 'midday', 'afternoon',
        'evening', 'late_night'
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS reflection_records_cause_idx
  ON reflection_records(agent_id, decision_id, outcome_id, recorded_at_utc DESC);

CREATE TABLE IF NOT EXISTS relationship_milestones (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'meaningful_support', 'shared_decision', 'disagreement', 'repair',
      'turning_point', 'mutual_vulnerability', 'other'
    )
  ),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  significance REAL NOT NULL CHECK (significance BETWEEN 0 AND 1),
  relationship_delta_json TEXT CHECK (
    relationship_delta_json IS NULL OR json_valid(relationship_delta_json)
  ),
  intervention_ids_json TEXT NOT NULL CHECK (
    json_valid(intervention_ids_json)
    AND json_type(intervention_ids_json) = 'array'
  ),
  decision_ids_json TEXT NOT NULL CHECK (
    json_valid(decision_ids_json) AND json_type(decision_ids_json) = 'array'
  ),
  outcome_ids_json TEXT NOT NULL CHECK (
    json_valid(outcome_ids_json) AND json_type(outcome_ids_json) = 'array'
  ),
  reflection_ids_json TEXT NOT NULL CHECK (
    json_valid(reflection_ids_json) AND json_type(reflection_ids_json) = 'array'
  ),
  source_message_ids_json TEXT NOT NULL CHECK (
    json_valid(source_message_ids_json)
    AND json_type(source_message_ids_json) = 'array'
    AND json_array_length(source_message_ids_json) > 0
  ),
  effective_local_date TEXT NOT NULL CHECK (
    length(effective_local_date) = 10
    AND effective_local_date GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  effective_period TEXT,
  temporal_precision TEXT NOT NULL CHECK (
    temporal_precision IN ('day', 'period')
  ),
  recorded_at_utc TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  milestone_json TEXT NOT NULL CHECK (json_valid(milestone_json)),
  CHECK (
    json_array_length(intervention_ids_json)
    + json_array_length(decision_ids_json)
    + json_array_length(outcome_ids_json)
    + json_array_length(reflection_ids_json) > 0
  ),
  CHECK (
    (temporal_precision = 'day' AND effective_period IS NULL)
    OR (
      temporal_precision = 'period'
      AND effective_period IN (
        'early_morning', 'morning', 'midday', 'afternoon',
        'evening', 'late_night'
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS relationship_milestones_agent_time_idx
  ON relationship_milestones(
    agent_id, effective_local_date DESC, significance DESC, recorded_at_utc DESC
  );
