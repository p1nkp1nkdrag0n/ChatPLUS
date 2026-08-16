ALTER TABLE memories ADD COLUMN memory_json TEXT;

CREATE INDEX IF NOT EXISTS memories_agent_updated_idx
  ON memories(agent_id, created_at_utc DESC, id);
