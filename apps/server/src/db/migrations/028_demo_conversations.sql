CREATE TABLE IF NOT EXISTS demo_conversations (
  entry_key TEXT PRIMARY KEY,
  character_id TEXT NOT NULL UNIQUE REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL
);
