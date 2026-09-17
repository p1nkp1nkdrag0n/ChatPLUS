-- requires-foreign-keys-off
-- Preserve durable queue identities and all existing foreign-key references.
CREATE TEMP TABLE proactive_temporal_backup AS SELECT * FROM temporal_tasks;
DROP TABLE temporal_tasks;

CREATE TABLE temporal_tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'letter.outbound_arrival', 'letter.reply_generation',
      'letter.return_arrival', 'letter.generation_retry',
      'keepsake.generate', 'proactive.follow_up', 'proactive.activity_review'
    )
  ),
  entity_id TEXT NOT NULL,
  due_at_utc TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'claimed', 'completed', 'retryable', 'dead_letter')
  ),
  claim_token TEXT,
  claimed_at_utc TEXT,
  lease_expires_at_utc TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  last_error_code TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
  ),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  completed_at_utc TEXT,
  CHECK (created_at_utc <= updated_at_utc),
  CHECK (
    (status = 'claimed'
      AND claim_token IS NOT NULL
      AND claimed_at_utc IS NOT NULL
      AND lease_expires_at_utc IS NOT NULL
      AND completed_at_utc IS NULL)
    OR (status = 'completed'
      AND claim_token IS NULL
      AND claimed_at_utc IS NULL
      AND lease_expires_at_utc IS NULL
      AND completed_at_utc IS NOT NULL)
    OR (status IN ('pending', 'retryable', 'dead_letter')
      AND claim_token IS NULL
      AND claimed_at_utc IS NULL
      AND lease_expires_at_utc IS NULL
      AND completed_at_utc IS NULL)
  ),
  CHECK (claimed_at_utc IS NULL OR lease_expires_at_utc > claimed_at_utc)
);

INSERT INTO temporal_tasks SELECT * FROM proactive_temporal_backup;
DROP TABLE proactive_temporal_backup;

CREATE UNIQUE INDEX temporal_tasks_claim_idx
  ON temporal_tasks(claim_token) WHERE claim_token IS NOT NULL;
CREATE INDEX temporal_tasks_due_idx
  ON temporal_tasks(status, due_at_utc, priority, id);
CREATE INDEX temporal_tasks_agent_status_idx
  ON temporal_tasks(agent_id, status, due_at_utc, id);

CREATE TRIGGER temporal_tasks_immutable_identity
BEFORE UPDATE ON temporal_tasks
WHEN NEW.agent_id IS NOT OLD.agent_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.entity_id IS NOT OLD.entity_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'temporal task identity is immutable');
END;

CREATE TRIGGER temporal_tasks_valid_status_transition
BEFORE UPDATE OF status ON temporal_tasks
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('claimed', 'dead_letter'))
  OR (OLD.status = 'claimed'
    AND NEW.status IN ('completed', 'retryable', 'dead_letter'))
  OR (OLD.status = 'retryable' AND NEW.status IN ('claimed', 'dead_letter'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid temporal task status transition');
END;

CREATE INDEX temporal_tasks_entity_kind_status_idx
  ON temporal_tasks(entity_id, kind, status);

CREATE UNIQUE INDEX temporal_tasks_one_active_reply_generation_idx
  ON temporal_tasks(entity_id)
  WHERE kind IN ('letter.reply_generation', 'letter.generation_retry')
    AND status IN ('pending', 'claimed', 'retryable');

CREATE TABLE proactive_task_evaluations (
  task_id TEXT NOT NULL REFERENCES temporal_tasks(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'on')),
  outcome TEXT NOT NULL,
  reason_code TEXT,
  evaluated_at_utc TEXT NOT NULL,
  next_evaluation_at_utc TEXT,
  PRIMARY KEY (task_id, attempt)
);

