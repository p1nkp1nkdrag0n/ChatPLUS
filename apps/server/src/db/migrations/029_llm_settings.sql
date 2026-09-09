CREATE TABLE llm_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL CHECK (protocol IN ('openai-compatible', 'anthropic', 'gemini')),
  base_url TEXT NOT NULL,
  timeout_ms INTEGER NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  models_json TEXT NOT NULL,
  credential_json TEXT,
  discovered_at_utc TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
CREATE TABLE llm_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  default_selection_json TEXT
);
INSERT INTO llm_settings(id) VALUES (1);
CREATE TABLE llm_session_models (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  selection_json TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);
CREATE TABLE llm_probe_results (
  provider_id TEXT NOT NULL REFERENCES llm_providers(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY(provider_id, model_id)
);
CREATE TABLE llm_key_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fingerprint TEXT NOT NULL,
  key_version INTEGER NOT NULL CHECK (key_version = 1)
);
