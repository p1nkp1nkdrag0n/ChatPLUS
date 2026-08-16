-- Durable state for schedule negotiations that span multiple chat turns.
-- record_json is the authoritative representation; scalar columns support
-- lookup and enforce lifecycle invariants without constraining future detail
-- fields stored in the record.
CREATE TABLE IF NOT EXISTS schedule_negotiations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (
    status IN (
      'collecting_details',
      'awaiting_confirmation',
      'committed',
      'declined',
      'withdrawn',
      'expired',
      'conflicted'
    )
  ),
  offer_version INTEGER NOT NULL CHECK (offer_version >= 0),
  record_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS schedule_negotiations_session_active_unique
  ON schedule_negotiations(session_id)
  WHERE status IN ('collecting_details', 'awaiting_confirmation');

CREATE INDEX IF NOT EXISTS schedule_negotiations_agent_updated_idx
  ON schedule_negotiations(agent_id, updated_at_utc DESC);

CREATE INDEX IF NOT EXISTS schedule_negotiations_session_updated_idx
  ON schedule_negotiations(session_id, updated_at_utc DESC);
