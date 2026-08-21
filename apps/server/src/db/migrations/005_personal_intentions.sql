CREATE TABLE IF NOT EXISTS personal_intentions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  activity TEXT NOT NULL,
  category TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes BETWEEN 5 AND 1440),
  earliest_at_utc TEXT,
  latest_at_utc TEXT,
  basis_kind TEXT NOT NULL CHECK (
    basis_kind IN ('goal', 'preference', 'routine', 'chat', 'spontaneous')
  ),
  priority REAL NOT NULL CHECK (priority BETWEEN 0 AND 1),
  freshness REAL NOT NULL CHECK (freshness BETWEEN 0 AND 1),
  record_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'planned', 'consumed', 'expired', 'rejected', 'superseded')
  ),
  dedupe_key TEXT NOT NULL,
  spec_version INTEGER NOT NULL CHECK (spec_version > 0),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at_utc TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS personal_intentions_agent_status_idx
  ON personal_intentions(agent_id, status, priority DESC, created_at_utc);

CREATE INDEX IF NOT EXISTS personal_intentions_agent_earliest_idx
  ON personal_intentions(agent_id, earliest_at_utc);

CREATE UNIQUE INDEX IF NOT EXISTS personal_intentions_active_dedupe_unique
  ON personal_intentions(agent_id, dedupe_key)
  WHERE status IN ('pending', 'planned');
