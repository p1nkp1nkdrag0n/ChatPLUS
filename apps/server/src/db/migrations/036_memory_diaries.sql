-- Diaries are derived reading artifacts; they never write memories or affinity.
CREATE TABLE diary_entries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 0 CHECK (current_revision >= 0),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  UNIQUE(agent_id, entry_date)
);
CREATE TABLE diary_revisions (
  entry_id TEXT NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  source_snapshot_json TEXT NOT NULL CHECK (json_valid(source_snapshot_json)),
  generation_metadata_json TEXT NOT NULL CHECK (json_valid(generation_metadata_json)),
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY(entry_id, revision)
);
CREATE INDEX diary_entries_agent_date_idx ON diary_entries(agent_id, entry_date DESC);
CREATE TABLE diary_generation_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  entry_id TEXT NOT NULL REFERENCES diary_entries(id) ON DELETE CASCADE,
  client_request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  expected_revision INTEGER NOT NULL,
  result_revision INTEGER,
  source_hash TEXT NOT NULL,
  error_code TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  UNIQUE(agent_id, client_request_id)
);
CREATE UNIQUE INDEX diary_one_pending_idx ON diary_generation_runs(entry_id) WHERE status = 'pending';
