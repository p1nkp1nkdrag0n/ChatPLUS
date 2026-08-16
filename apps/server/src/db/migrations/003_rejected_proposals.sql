-- Audit trail for model-proposed effects that were dropped by validation.
-- A rejected proposal never blocks the conversational reply; it is recorded
-- so intent-hallucination and structural failures stay measurable.
CREATE TABLE IF NOT EXISTS rejected_proposals (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT,
  purpose TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_summary TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  correlation_id TEXT,
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rejected_proposals_agent
  ON rejected_proposals(agent_id, created_at_utc DESC);
