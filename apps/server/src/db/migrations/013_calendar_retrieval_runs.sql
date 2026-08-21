CREATE TABLE IF NOT EXISTS calendar_entries (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES characters(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (
    scope IN ('public_system', 'user_private', 'character_world')
  ),
  title TEXT NOT NULL CHECK (
    length(trim(title)) BETWEEN 1 AND 240
  ),
  description TEXT CHECK (
    description IS NULL
    OR length(trim(description)) BETWEEN 1 AND 2000
  ),
  local_date TEXT NOT NULL CHECK (
    length(local_date) = 10
    AND local_date GLOB
      '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  timezone TEXT NOT NULL CHECK (
    length(trim(timezone)) BETWEEN 1 AND 120
  ),
  all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
  start_local_time TEXT CHECK (
    start_local_time IS NULL
    OR (
      length(start_local_time) = 5
      AND start_local_time GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(substr(start_local_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
    )
  ),
  end_local_time TEXT CHECK (
    end_local_time IS NULL
    OR (
      length(end_local_time) = 5
      AND end_local_time GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(substr(end_local_time, 1, 2) AS INTEGER) BETWEEN 0 AND 23
    )
  ),
  recurrence TEXT NOT NULL CHECK (recurrence IN ('none', 'yearly')),
  source TEXT NOT NULL CHECK (
    source IN ('manual', 'system_dataset', 'character_spec', 'plugin')
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  dedupe_key TEXT NOT NULL UNIQUE CHECK (
    length(trim(dedupe_key)) BETWEEN 1 AND 512
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  record_json TEXT NOT NULL CHECK (
    json_valid(record_json)
    AND json_type(record_json) = 'object'
  ),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  CHECK (scope = 'public_system' OR agent_id IS NOT NULL),
  CHECK (all_day = 1 OR start_local_time IS NOT NULL),
  CHECK (end_local_time IS NULL OR start_local_time IS NOT NULL),
  CHECK (
    end_local_time IS NULL
    OR end_local_time > start_local_time
  ),
  CHECK (updated_at_utc >= created_at_utc)
);

CREATE INDEX IF NOT EXISTS calendar_entries_agent_scope_date_idx
  ON calendar_entries(
    agent_id,
    scope,
    status,
    local_date,
    updated_at_utc DESC
  );

CREATE INDEX IF NOT EXISTS calendar_entries_public_date_idx
  ON calendar_entries(status, local_date, updated_at_utc DESC)
  WHERE scope = 'public_system';

CREATE TABLE IF NOT EXISTS retrieval_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL
    REFERENCES characters(id) ON DELETE RESTRICT,
  session_id TEXT
    REFERENCES sessions(id) ON DELETE RESTRICT,
  source_message_id TEXT
    REFERENCES messages(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (
    mode IN ('event_card', 'verbatim_quote', 'basic_memory', 'none')
  ),
  candidate_count INTEGER NOT NULL CHECK (
    candidate_count BETWEEN 0 AND 500
  ),
  selected_count INTEGER NOT NULL CHECK (
    selected_count BETWEEN 0 AND 3
  ),
  query_json TEXT NOT NULL CHECK (
    json_valid(query_json)
    AND json_type(query_json) = 'object'
  ),
  input_snapshot_json TEXT NOT NULL CHECK (
    json_valid(input_snapshot_json)
    AND json_type(input_snapshot_json) = 'object'
  ),
  stages_json TEXT NOT NULL CHECK (
    json_valid(stages_json)
    AND json_type(stages_json) = 'array'
  ),
  candidates_json TEXT NOT NULL CHECK (
    json_valid(candidates_json)
    AND json_type(candidates_json) = 'array'
  ),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json)
    AND json_type(result_json) = 'object'
  ),
  evidence_bundle_json TEXT CHECK (
    evidence_bundle_json IS NULL
    OR (
      json_valid(evidence_bundle_json)
      AND json_type(evidence_bundle_json) = 'object'
    )
  ),
  config_snapshot_json TEXT NOT NULL CHECK (
    json_valid(config_snapshot_json)
    AND json_type(config_snapshot_json) = 'object'
  ),
  rendered_prompt_fragment TEXT,
  created_at_utc TEXT NOT NULL,
  CHECK (
    (mode = 'none' AND selected_count = 0 AND evidence_bundle_json IS NULL)
    OR
    (
      mode <> 'none'
      AND selected_count BETWEEN 1 AND 3
      AND evidence_bundle_json IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS retrieval_runs_agent_created_idx
  ON retrieval_runs(agent_id, created_at_utc DESC, id);

CREATE INDEX IF NOT EXISTS retrieval_runs_session_created_idx
  ON retrieval_runs(session_id, created_at_utc DESC, id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS retrieval_runs_source_message_idx
  ON retrieval_runs(source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS retrieval_runs_immutable_update
BEFORE UPDATE ON retrieval_runs
BEGIN
  SELECT RAISE(ABORT, 'retrieval_runs are immutable');
END;

CREATE TRIGGER IF NOT EXISTS retrieval_runs_immutable_delete
BEFORE DELETE ON retrieval_runs
BEGIN
  SELECT RAISE(ABORT, 'retrieval_runs are immutable');
END;
