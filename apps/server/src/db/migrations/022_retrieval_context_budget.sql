DROP TRIGGER IF EXISTS retrieval_runs_immutable_update;
DROP TRIGGER IF EXISTS retrieval_runs_immutable_delete;
DROP INDEX IF EXISTS retrieval_runs_agent_created_idx;
DROP INDEX IF EXISTS retrieval_runs_session_created_idx;
DROP INDEX IF EXISTS retrieval_runs_source_message_idx;

CREATE TABLE retrieval_runs_v024 (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL
    REFERENCES characters(id) ON DELETE RESTRICT,
  session_id TEXT
    REFERENCES sessions(id) ON DELETE RESTRICT,
  source_message_id TEXT
    REFERENCES messages(id) ON DELETE RESTRICT,
  mode TEXT NOT NULL CHECK (
    mode IN (
      'event_card',
      'verbatim_quote',
      'date_digest',
      'basic_memory',
      'none'
    )
  ),
  candidate_count INTEGER NOT NULL CHECK (
    candidate_count BETWEEN 0 AND 500
  ),
  selected_count INTEGER NOT NULL CHECK (
    selected_count BETWEEN 0 AND 8
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
    selected_count <= 3
    OR COALESCE(json_extract(input_snapshot_json, '$.strategyVersion'), '') = 'continuity_context_v2'
  ),
  CHECK (
    (mode = 'none' AND selected_count = 0 AND evidence_bundle_json IS NULL)
    OR
    (
      mode <> 'none'
      AND selected_count BETWEEN 1 AND 8
      AND evidence_bundle_json IS NOT NULL
    )
  )
);

INSERT INTO retrieval_runs_v024(
  rowid,
  id, agent_id, session_id, source_message_id, mode, candidate_count,
  selected_count, query_json, input_snapshot_json, stages_json,
  candidates_json, result_json, evidence_bundle_json,
  config_snapshot_json, rendered_prompt_fragment, created_at_utc
)
SELECT
  rowid, id, agent_id, session_id, source_message_id, mode, candidate_count,
  selected_count, query_json, input_snapshot_json, stages_json,
  candidates_json, result_json, evidence_bundle_json,
  config_snapshot_json, rendered_prompt_fragment, created_at_utc
FROM retrieval_runs ORDER BY rowid;

DROP TABLE retrieval_runs;
ALTER TABLE retrieval_runs_v024 RENAME TO retrieval_runs;

CREATE INDEX retrieval_runs_agent_created_idx
  ON retrieval_runs(agent_id, created_at_utc DESC, id);

CREATE INDEX retrieval_runs_session_created_idx
  ON retrieval_runs(session_id, created_at_utc DESC, id)
  WHERE session_id IS NOT NULL;

CREATE INDEX retrieval_runs_source_message_idx
  ON retrieval_runs(source_message_id)
  WHERE source_message_id IS NOT NULL;

CREATE TRIGGER retrieval_runs_immutable_update
BEFORE UPDATE ON retrieval_runs
BEGIN
  SELECT RAISE(ABORT, 'retrieval_runs are immutable');
END;

CREATE TRIGGER retrieval_runs_immutable_delete
BEFORE DELETE ON retrieval_runs
BEGIN
  SELECT RAISE(ABORT, 'retrieval_runs are immutable');
END;
