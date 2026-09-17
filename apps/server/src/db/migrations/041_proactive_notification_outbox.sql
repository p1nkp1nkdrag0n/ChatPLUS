-- Contact decisions are separate from the underlying event's lifecycle.
CREATE TABLE proactive_intent_decisions (
  source_kind TEXT NOT NULL CHECK(source_kind IN ('activity_candidate', 'follow_up')),
  source_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  reason_code TEXT NOT NULL,
  decided_at_utc TEXT NOT NULL,
  PRIMARY KEY(source_kind, source_id, source_revision)
);

-- One durable notification per committed chat message; retrying this never
-- invokes the model or inserts another message.
CREATE TABLE proactive_notification_outbox (
  message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_utc TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  processed_at_utc TEXT
);
CREATE INDEX proactive_notification_due_idx
  ON proactive_notification_outbox(status, next_attempt_at_utc);

-- Arrival epochs and leases also fence a separate worker before the user
-- message has reached the actor queue or been inserted into messages.
CREATE TABLE proactive_user_activity_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  arrival_epoch INTEGER NOT NULL DEFAULT 0
);
INSERT INTO proactive_user_activity_state(singleton) VALUES (1);
CREATE TABLE proactive_user_turn_leases (
  token TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  expires_at_utc TEXT NOT NULL
);
