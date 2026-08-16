CREATE TABLE IF NOT EXISTS characters (
  id TEXT PRIMARY KEY,
  current_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  tier TEXT NOT NULL CHECK (tier IN ('lightweight', 'daily', 'high_fidelity')),
  name TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('original', 'imported_character')),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS character_versions (
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  spec_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY (character_id, version)
);

CREATE TABLE IF NOT EXISTS character_sources (
  id TEXT PRIMARY KEY,
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content_excerpt TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS character_sources_character_idx
  ON character_sources(character_id, created_at_utc DESC);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS sessions_agent_idx ON sessions(agent_id, updated_at_utc DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  message_kind TEXT NOT NULL CHECK (
    message_kind IN ('user', 'assistant_reply', 'assistant_proactive', 'system_notice')
  ),
  trigger_event_id TEXT,
  client_message_id TEXT,
  in_reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at_utc TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id_unique
  ON messages(session_id, client_message_id)
  WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, created_at_utc, id);
CREATE INDEX IF NOT EXISTS messages_agent_kind_idx
  ON messages(agent_id, message_kind, created_at_utc DESC);

CREATE TABLE IF NOT EXISTS runtime_states (
  agent_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schedule_items (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  start_at_utc TEXT NOT NULL,
  end_at_utc TEXT NOT NULL,
  status TEXT NOT NULL,
  rigidity TEXT NOT NULL,
  source TEXT NOT NULL,
  shareable INTEGER NOT NULL,
  narrative_importance REAL NOT NULL,
  revision INTEGER NOT NULL,
  item_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS schedule_items_agent_time_idx
  ON schedule_items(agent_id, start_at_utc, end_at_utc);
CREATE INDEX IF NOT EXISTS schedule_items_agent_status_idx
  ON schedule_items(agent_id, status, end_at_utc);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  schedule_item_id TEXT REFERENCES schedule_items(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  occurred_at_utc TEXT NOT NULL,
  summary TEXT NOT NULL,
  outcome_facts_json TEXT NOT NULL,
  state_delta_json TEXT NOT NULL,
  origin TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  event_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS activity_events_agent_idx
  ON activity_events(agent_id, occurred_at_utc DESC);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  importance REAL NOT NULL,
  confidence REAL NOT NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  source_event_id TEXT REFERENCES activity_events(id) ON DELETE SET NULL,
  created_at_utc TEXT NOT NULL,
  valid_until_utc TEXT
);

CREATE INDEX IF NOT EXISTS memories_agent_rank_idx
  ON memories(agent_id, importance DESC, created_at_utc DESC);

CREATE TABLE IF NOT EXISTS proactive_candidates (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  trigger_event_id TEXT NOT NULL REFERENCES activity_events(id) ON DELETE CASCADE,
  intent TEXT NOT NULL,
  summary TEXT NOT NULL,
  draft_message TEXT,
  earliest_at_utc TEXT NOT NULL,
  expires_at_utc TEXT NOT NULL,
  priority REAL NOT NULL,
  cooldown_key TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  UNIQUE(agent_id, trigger_event_id, cooldown_key)
);

CREATE INDEX IF NOT EXISTS proactive_candidates_pending_idx
  ON proactive_candidates(agent_id, status, earliest_at_utc, expires_at_utc, priority DESC);

CREATE TABLE IF NOT EXISTS simulation_cursors (
  agent_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  last_settled_at_utc TEXT NOT NULL,
  schedule_horizon_end_utc TEXT NOT NULL,
  last_hourly_bucket TEXT,
  revision INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  from_utc TEXT NOT NULL,
  to_utc TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  result_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS settlements_agent_idx
  ON settlements(agent_id, to_utc DESC);

CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  stream_type TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  recorded_at_utc TEXT NOT NULL,
  effective_at_utc TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  correlation_id TEXT,
  causation_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS domain_events_agent_idx
  ON domain_events(agent_id, recorded_at_utc DESC);

CREATE TABLE IF NOT EXISTS llm_calls (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES characters(id) ON DELETE SET NULL,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL,
  success INTEGER NOT NULL,
  error_code TEXT,
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS llm_calls_created_idx ON llm_calls(created_at_utc DESC);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

