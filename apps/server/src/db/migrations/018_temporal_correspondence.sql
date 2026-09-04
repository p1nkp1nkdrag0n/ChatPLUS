-- Durable, asynchronous correspondence. Letter bodies written by the character
-- are encrypted at rest and are never persisted in plaintext after sealing.

CREATE TABLE IF NOT EXISTS correspondence_threads (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  root_letter_id TEXT REFERENCES letters(id) ON DELETE SET NULL,
  latest_letter_id TEXT REFERENCES letters(id) ON DELETE SET NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  closed_at_utc TEXT,
  CHECK (created_at_utc <= updated_at_utc),
  CHECK (
    (status = 'open' AND closed_at_utc IS NULL)
    OR (status = 'closed' AND closed_at_utc IS NOT NULL
      AND updated_at_utc <= closed_at_utc)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS correspondence_threads_one_open_agent_idx
  ON correspondence_threads(agent_id) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS correspondence_threads_root_idx
  ON correspondence_threads(root_letter_id) WHERE root_letter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS correspondence_threads_agent_updated_idx
  ON correspondence_threads(agent_id, updated_at_utc DESC, id DESC);

CREATE TABLE IF NOT EXISTS letters (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL
    REFERENCES correspondence_threads(id) ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  create_request_id TEXT,
  create_request_hash TEXT CHECK (
    create_request_hash IS NULL
    OR (length(create_request_hash) = 64
      AND create_request_hash NOT GLOB '*[^0-9a-f]*')
  ),
  seal_request_id TEXT,
  reply_to_letter_id TEXT UNIQUE REFERENCES letters(id) ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  direction TEXT NOT NULL CHECK (
    direction IN ('user_to_agent', 'agent_to_user')
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'draft', 'sealed', 'in_transit', 'delivered_unread', 'read', 'cancelled'
    )
  ),
  subject TEXT,
  body TEXT,
  content_hash TEXT CHECK (
    content_hash IS NULL
    OR (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')
  ),
  encrypted_ciphertext TEXT,
  encrypted_iv TEXT,
  encrypted_auth_tag TEXT,
  encrypted_key_version INTEGER CHECK (
    encrypted_key_version IS NULL OR encrypted_key_version > 0
  ),
  encrypted_aad_hash TEXT CHECK (
    encrypted_aad_hash IS NULL
    OR (
      length(encrypted_aad_hash) = 64
      AND encrypted_aad_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  encrypted_created_at_utc TEXT,
  transit_policy_version TEXT CHECK (
    transit_policy_version IS NULL OR transit_policy_version = 'fixed_5d_v1'
  ),
  transit_timezone TEXT CHECK (
    transit_timezone IS NULL OR length(trim(transit_timezone)) > 0
  ),
  dispatched_at_utc TEXT,
  arrival_due_at_utc TEXT,
  effective_author_time_utc TEXT,
  delivered_effective_at_utc TEXT,
  processed_at_utc TEXT,
  read_at_utc TEXT,
  opened_at_utc TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  CHECK (created_at_utc <= updated_at_utc),
  CHECK (
    (create_request_id IS NULL AND create_request_hash IS NULL)
    OR (create_request_id IS NOT NULL AND create_request_hash IS NOT NULL)
  ),
  CHECK (reply_to_letter_id IS NULL OR reply_to_letter_id <> id),
  CHECK (
    (status IN ('draft', 'cancelled')
      AND content_hash IS NULL
      AND transit_policy_version IS NULL
      AND transit_timezone IS NULL
      AND dispatched_at_utc IS NULL
      AND arrival_due_at_utc IS NULL
      AND effective_author_time_utc IS NULL
      AND delivered_effective_at_utc IS NULL
      AND processed_at_utc IS NULL
      AND read_at_utc IS NULL
      AND opened_at_utc IS NULL)
    OR
    (status IN ('sealed', 'in_transit', 'delivered_unread', 'read')
      AND content_hash IS NOT NULL
      AND transit_policy_version IS NOT NULL
      AND transit_timezone IS NOT NULL
      AND dispatched_at_utc IS NOT NULL
      AND arrival_due_at_utc IS NOT NULL
      AND effective_author_time_utc IS NOT NULL
      AND effective_author_time_utc <= dispatched_at_utc
      AND dispatched_at_utc < arrival_due_at_utc)
  ),
  CHECK (
    (direction = 'user_to_agent'
      AND encrypted_ciphertext IS NULL
      AND encrypted_iv IS NULL
      AND encrypted_auth_tag IS NULL
      AND encrypted_key_version IS NULL
      AND encrypted_aad_hash IS NULL
      AND encrypted_created_at_utc IS NULL
      AND (status IN ('draft', 'cancelled')
        OR (body IS NOT NULL AND length(trim(body)) > 0)))
    OR
    (direction = 'agent_to_user'
      AND subject IS NULL
      AND body IS NULL
      AND ((status IN ('draft', 'cancelled')
        AND encrypted_ciphertext IS NULL
        AND encrypted_iv IS NULL
        AND encrypted_auth_tag IS NULL
        AND encrypted_key_version IS NULL
        AND encrypted_aad_hash IS NULL
        AND encrypted_created_at_utc IS NULL)
      OR (status IN ('sealed', 'in_transit', 'delivered_unread', 'read')
        AND encrypted_ciphertext IS NOT NULL
        AND encrypted_iv IS NOT NULL
        AND encrypted_auth_tag IS NOT NULL
        AND encrypted_key_version IS NOT NULL
        AND encrypted_aad_hash IS NOT NULL
        AND encrypted_created_at_utc IS NOT NULL)))
  ),
  CHECK (
    (status IN ('delivered_unread', 'read')
      AND delivered_effective_at_utc IS NOT NULL
      AND processed_at_utc IS NOT NULL)
    OR (status NOT IN ('delivered_unread', 'read')
      AND delivered_effective_at_utc IS NULL
      AND processed_at_utc IS NULL)
  ),
  CHECK (
    (status = 'read' AND direction = 'user_to_agent'
      AND read_at_utc IS NOT NULL AND opened_at_utc IS NULL)
    OR (status = 'read' AND direction = 'agent_to_user'
      AND opened_at_utc IS NOT NULL AND read_at_utc IS NULL)
    OR (status <> 'read' AND read_at_utc IS NULL AND opened_at_utc IS NULL)
  ),
  CHECK (
    delivered_effective_at_utc IS NULL
    OR delivered_effective_at_utc = arrival_due_at_utc
  ),
  CHECK (
    processed_at_utc IS NULL
    OR processed_at_utc >= delivered_effective_at_utc
  ),
  CHECK (
    read_at_utc IS NULL OR read_at_utc = delivered_effective_at_utc
  ),
  CHECK (
    opened_at_utc IS NULL OR opened_at_utc >= delivered_effective_at_utc
  )
);

CREATE INDEX IF NOT EXISTS letters_thread_created_idx
  ON letters(thread_id, created_at_utc, id);
CREATE INDEX IF NOT EXISTS letters_agent_status_arrival_idx
  ON letters(agent_id, status, arrival_due_at_utc, id);
CREATE INDEX IF NOT EXISTS letters_agent_direction_created_idx
  ON letters(agent_id, direction, created_at_utc DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS letters_create_request_idx
  ON letters(agent_id, create_request_id) WHERE create_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS letters_seal_request_idx
  ON letters(agent_id, seal_request_id) WHERE seal_request_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS letters_immutable_after_draft
BEFORE UPDATE ON letters
WHEN OLD.status <> 'draft' AND (
  NEW.thread_id IS NOT OLD.thread_id
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.create_request_id IS NOT OLD.create_request_id
  OR NEW.create_request_hash IS NOT OLD.create_request_hash
  OR NEW.seal_request_id IS NOT OLD.seal_request_id
  OR NEW.reply_to_letter_id IS NOT OLD.reply_to_letter_id
  OR NEW.direction IS NOT OLD.direction
  OR NEW.subject IS NOT OLD.subject
  OR NEW.body IS NOT OLD.body
  OR NEW.content_hash IS NOT OLD.content_hash
  OR NEW.encrypted_ciphertext IS NOT OLD.encrypted_ciphertext
  OR NEW.encrypted_iv IS NOT OLD.encrypted_iv
  OR NEW.encrypted_auth_tag IS NOT OLD.encrypted_auth_tag
  OR NEW.encrypted_key_version IS NOT OLD.encrypted_key_version
  OR NEW.encrypted_aad_hash IS NOT OLD.encrypted_aad_hash
  OR NEW.encrypted_created_at_utc IS NOT OLD.encrypted_created_at_utc
  OR NEW.transit_policy_version IS NOT OLD.transit_policy_version
  OR NEW.transit_timezone IS NOT OLD.transit_timezone
  OR NEW.dispatched_at_utc IS NOT OLD.dispatched_at_utc
  OR NEW.arrival_due_at_utc IS NOT OLD.arrival_due_at_utc
  OR NEW.effective_author_time_utc IS NOT OLD.effective_author_time_utc
)
BEGIN
  SELECT RAISE(ABORT, 'sealed letter content and transport are immutable');
END;

CREATE TRIGGER IF NOT EXISTS letters_immutable_identity
BEFORE UPDATE ON letters
WHEN NEW.thread_id IS NOT OLD.thread_id
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.create_request_id IS NOT OLD.create_request_id
  OR NEW.create_request_hash IS NOT OLD.create_request_hash
  OR NEW.reply_to_letter_id IS NOT OLD.reply_to_letter_id
  OR NEW.direction IS NOT OLD.direction
BEGIN
  SELECT RAISE(ABORT, 'letter identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS letters_immutable_delivery_facts
BEFORE UPDATE ON letters
WHEN (OLD.delivered_effective_at_utc IS NOT NULL
    AND NEW.delivered_effective_at_utc IS NOT OLD.delivered_effective_at_utc)
  OR (OLD.processed_at_utc IS NOT NULL
    AND NEW.processed_at_utc IS NOT OLD.processed_at_utc)
  OR (OLD.read_at_utc IS NOT NULL
    AND NEW.read_at_utc IS NOT OLD.read_at_utc)
  OR (OLD.opened_at_utc IS NOT NULL
    AND NEW.opened_at_utc IS NOT OLD.opened_at_utc)
BEGIN
  SELECT RAISE(ABORT, 'letter delivery and open facts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS letters_valid_status_transition
BEFORE UPDATE OF status ON letters
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'draft' AND NEW.status IN ('sealed', 'cancelled'))
  OR (OLD.status = 'sealed' AND NEW.status = 'in_transit')
  OR (OLD.status = 'in_transit' AND NEW.status = 'delivered_unread')
  OR (OLD.status = 'delivered_unread' AND NEW.status = 'read')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid letter status transition');
END;

CREATE TRIGGER IF NOT EXISTS letters_validate_thread_agent_insert
BEFORE INSERT ON letters
WHEN NOT EXISTS (
  SELECT 1 FROM correspondence_threads
  WHERE id = NEW.thread_id AND agent_id = NEW.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'letter agent must match correspondence thread');
END;

CREATE TRIGGER IF NOT EXISTS letters_validate_reply_insert
BEFORE INSERT ON letters
WHEN NEW.reply_to_letter_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM letters parent
  WHERE parent.id = NEW.reply_to_letter_id
    AND parent.thread_id = NEW.thread_id
    AND parent.agent_id = NEW.agent_id
    AND parent.direction <> NEW.direction
)
BEGIN
  SELECT RAISE(ABORT, 'reply must target the opposite direction in its thread');
END;

CREATE TRIGGER IF NOT EXISTS letters_one_awaiting_user_reply_insert
BEFORE INSERT ON letters
WHEN NEW.direction = 'user_to_agent' AND EXISTS (
  SELECT 1 FROM letters incoming
  WHERE incoming.thread_id = NEW.thread_id
    AND incoming.direction = 'user_to_agent'
    AND incoming.status <> 'cancelled'
    AND NOT EXISTS (
      SELECT 1 FROM letters reply
      WHERE reply.reply_to_letter_id = incoming.id
        AND reply.direction = 'agent_to_user'
        AND reply.status = 'read'
    )
)
BEGIN
  SELECT RAISE(ABORT, 'thread already has a user letter awaiting reply');
END;

CREATE TRIGGER IF NOT EXISTS letters_protect_durable_delete
BEFORE DELETE ON letters
WHEN OLD.status <> 'draft' AND EXISTS (
  SELECT 1 FROM characters WHERE id = OLD.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'durable letters may only be deleted with their character');
END;

CREATE TABLE IF NOT EXISTS letter_generation_snapshots (
  id TEXT PRIMARY KEY,
  incoming_letter_id TEXT NOT NULL UNIQUE
    REFERENCES letters(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  effective_at_utc TEXT NOT NULL,
  character_version INTEGER NOT NULL CHECK (character_version > 0),
  state_revision INTEGER NOT NULL CHECK (state_revision >= 0),
  context_json TEXT NOT NULL CHECK (
    json_valid(context_json) AND json_type(context_json) = 'object'
  ),
  evidence_ids_json TEXT NOT NULL CHECK (
    json_valid(evidence_ids_json) AND json_type(evidence_ids_json) = 'array'
  ),
  context_hash TEXT NOT NULL CHECK (
    length(context_hash) = 64 AND context_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS letter_generation_snapshots_agent_time_idx
  ON letter_generation_snapshots(agent_id, effective_at_utc DESC, id DESC);

CREATE TRIGGER IF NOT EXISTS letter_generation_snapshots_immutable
BEFORE UPDATE ON letter_generation_snapshots
BEGIN
  SELECT RAISE(ABORT, 'letter generation snapshots are immutable');
END;

CREATE TRIGGER IF NOT EXISTS letter_generation_snapshots_validate_incoming
BEFORE INSERT ON letter_generation_snapshots
WHEN NOT EXISTS (
  SELECT 1 FROM letters
  WHERE id = NEW.incoming_letter_id
    AND agent_id = NEW.agent_id
    AND direction = 'user_to_agent'
    AND status IN ('delivered_unread', 'read')
    AND arrival_due_at_utc = NEW.effective_at_utc
    AND delivered_effective_at_utc = NEW.effective_at_utc
)
BEGIN
  SELECT RAISE(ABORT, 'snapshot requires a delivered incoming letter');
END;

CREATE TRIGGER IF NOT EXISTS letter_generation_snapshots_protect_delete
BEFORE DELETE ON letter_generation_snapshots
WHEN EXISTS (SELECT 1 FROM characters WHERE id = OLD.agent_id)
BEGIN
  SELECT RAISE(ABORT, 'generation snapshots may only be deleted with their character');
END;

CREATE TABLE IF NOT EXISTS letter_generation_runs (
  id TEXT PRIMARY KEY,
  incoming_letter_id TEXT NOT NULL REFERENCES letters(id) ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  snapshot_id TEXT NOT NULL
    REFERENCES letter_generation_snapshots(id) ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  reply_letter_id TEXT REFERENCES letters(id) ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  claim_token TEXT,
  claimed_at_utc TEXT,
  generation_epoch INTEGER NOT NULL CHECK (generation_epoch >= 0),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending', 'generating', 'retryable', 'committed', 'failed', 'discarded'
    )
  ),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  lease_expires_at_utc TEXT,
  provider TEXT,
  model TEXT,
  error_code TEXT,
  result_hash TEXT CHECK (
    result_hash IS NULL
    OR (length(result_hash) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*')
  ),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  committed_at_utc TEXT,
  CHECK (created_at_utc <= updated_at_utc),
  CHECK (
    (status = 'generating'
      AND claim_token IS NOT NULL
      AND claimed_at_utc IS NOT NULL
      AND lease_expires_at_utc IS NOT NULL
      AND reply_letter_id IS NULL
      AND committed_at_utc IS NULL)
    OR (status = 'committed'
      AND claim_token IS NULL
      AND claimed_at_utc IS NULL
      AND lease_expires_at_utc IS NULL
      AND reply_letter_id IS NOT NULL
      AND provider IS NOT NULL
      AND model IS NOT NULL
      AND committed_at_utc IS NOT NULL)
    OR (status IN ('pending', 'retryable', 'failed', 'discarded')
      AND claim_token IS NULL
      AND claimed_at_utc IS NULL
      AND lease_expires_at_utc IS NULL
      AND reply_letter_id IS NULL
      AND committed_at_utc IS NULL)
  ),
  CHECK (
    claimed_at_utc IS NULL OR lease_expires_at_utc > claimed_at_utc
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS letter_generation_runs_epoch_idx
  ON letter_generation_runs(incoming_letter_id, generation_epoch);
CREATE UNIQUE INDEX IF NOT EXISTS letter_generation_runs_claim_idx
  ON letter_generation_runs(claim_token) WHERE claim_token IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS letter_generation_runs_one_commit_idx
  ON letter_generation_runs(incoming_letter_id) WHERE status = 'committed';
CREATE INDEX IF NOT EXISTS letter_generation_runs_claimable_idx
  ON letter_generation_runs(status, lease_expires_at_utc, updated_at_utc, id);

CREATE TRIGGER IF NOT EXISTS letter_generation_runs_validate_snapshot_insert
BEFORE INSERT ON letter_generation_runs
WHEN NOT EXISTS (
  SELECT 1 FROM letter_generation_snapshots snapshot
  WHERE snapshot.id = NEW.snapshot_id
    AND snapshot.incoming_letter_id = NEW.incoming_letter_id
    AND snapshot.agent_id = NEW.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'generation run must match its immutable snapshot');
END;

CREATE TRIGGER IF NOT EXISTS letter_generation_runs_immutable_identity
BEFORE UPDATE ON letter_generation_runs
WHEN NEW.incoming_letter_id IS NOT OLD.incoming_letter_id
  OR NEW.snapshot_id IS NOT OLD.snapshot_id
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.generation_epoch IS NOT OLD.generation_epoch
BEGIN
  SELECT RAISE(ABORT, 'generation run identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS letter_generation_runs_valid_status_transition
BEFORE UPDATE OF status ON letter_generation_runs
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('generating', 'failed', 'discarded'))
  OR (OLD.status = 'generating'
    AND NEW.status IN ('retryable', 'committed', 'failed', 'discarded'))
  OR (OLD.status = 'retryable'
    AND NEW.status IN ('generating', 'failed', 'discarded'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid generation run status transition');
END;

CREATE TRIGGER IF NOT EXISTS letter_generation_runs_protect_delete
BEFORE DELETE ON letter_generation_runs
WHEN EXISTS (SELECT 1 FROM characters WHERE id = OLD.agent_id)
BEGIN
  SELECT RAISE(ABORT, 'generation runs may only be deleted with their character');
END;

CREATE TABLE IF NOT EXISTS temporal_tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'letter.outbound_arrival', 'letter.reply_generation',
      'letter.return_arrival', 'letter.generation_retry'
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
  CHECK (
    claimed_at_utc IS NULL OR lease_expires_at_utc > claimed_at_utc
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS temporal_tasks_claim_idx
  ON temporal_tasks(claim_token) WHERE claim_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS temporal_tasks_due_idx
  ON temporal_tasks(status, due_at_utc, priority, id);
CREATE INDEX IF NOT EXISTS temporal_tasks_agent_status_idx
  ON temporal_tasks(agent_id, status, due_at_utc, id);

CREATE TRIGGER IF NOT EXISTS temporal_tasks_immutable_identity
BEFORE UPDATE ON temporal_tasks
WHEN NEW.agent_id IS NOT OLD.agent_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.entity_id IS NOT OLD.entity_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'temporal task identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS temporal_tasks_valid_status_transition
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
