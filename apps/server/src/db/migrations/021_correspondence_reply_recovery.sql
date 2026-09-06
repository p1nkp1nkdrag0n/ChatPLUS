-- Explicit reply recovery is append-only. A client request is recorded in a
-- dedicated ledger, while the generated temporal task keeps its epoch-based
-- execution identity. No original dead task or failed generation run is
-- revived or rewritten.

CREATE INDEX temporal_tasks_entity_kind_status_idx
  ON temporal_tasks(entity_id, kind, status);

CREATE UNIQUE INDEX temporal_tasks_one_active_reply_generation_idx
  ON temporal_tasks(entity_id)
  WHERE kind IN ('letter.reply_generation', 'letter.generation_retry')
    AND status IN ('pending', 'claimed', 'retryable');

CREATE TABLE correspondence_reply_retry_requests (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  incoming_letter_id TEXT NOT NULL REFERENCES letters(id) ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  request_hash TEXT NOT NULL CHECK (
    length(request_hash) = 64
    AND request_hash NOT GLOB '*[^0-9a-f]*'
  ),
  generation_epoch INTEGER NOT NULL CHECK (generation_epoch > 0),
  snapshot_id TEXT NOT NULL REFERENCES letter_generation_snapshots(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  previous_task_id TEXT NOT NULL REFERENCES temporal_tasks(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  previous_run_id TEXT NOT NULL REFERENCES letter_generation_runs(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  task_id TEXT NOT NULL UNIQUE REFERENCES temporal_tasks(id)
    ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  source TEXT NOT NULL CHECK (source IN ('local_user', 'developer_operator')),
  requested_at_utc TEXT NOT NULL,
  UNIQUE(agent_id, request_hash),
  UNIQUE(incoming_letter_id, generation_epoch)
);

CREATE TRIGGER correspondence_reply_retry_requests_validate_insert
BEFORE INSERT ON correspondence_reply_retry_requests
WHEN NOT EXISTS (
  SELECT 1 FROM letters AS incoming
  WHERE incoming.id = NEW.incoming_letter_id
    AND incoming.agent_id = NEW.agent_id
    AND incoming.direction = 'user_to_agent'
    AND incoming.status = 'read'
)
OR NOT EXISTS (
  SELECT 1 FROM letter_generation_snapshots AS snapshot
  WHERE snapshot.id = NEW.snapshot_id
    AND snapshot.incoming_letter_id = NEW.incoming_letter_id
    AND snapshot.agent_id = NEW.agent_id
)
OR NOT EXISTS (
  SELECT 1 FROM temporal_tasks AS previous_task
  WHERE previous_task.id = NEW.previous_task_id
    AND previous_task.agent_id = NEW.agent_id
    AND previous_task.entity_id = NEW.incoming_letter_id
    AND previous_task.kind IN (
      'letter.reply_generation', 'letter.generation_retry'
    )
    AND previous_task.max_attempts = 3
    AND (
      (NEW.generation_epoch = 1
        AND previous_task.kind = 'letter.reply_generation')
      OR (NEW.generation_epoch > 1
        AND previous_task.kind = 'letter.generation_retry')
    )
    AND previous_task.status = 'dead_letter'
    AND json_extract(previous_task.payload_json, '$.incomingLetterId')
      = NEW.incoming_letter_id
    AND json_extract(previous_task.payload_json, '$.snapshotId')
      = NEW.snapshot_id
    AND json_extract(previous_task.payload_json, '$.generationEpoch')
      = NEW.generation_epoch - 1
)
OR NOT EXISTS (
  SELECT 1 FROM letter_generation_runs AS previous_run
  WHERE previous_run.id = NEW.previous_run_id
    AND previous_run.agent_id = NEW.agent_id
    AND previous_run.incoming_letter_id = NEW.incoming_letter_id
    AND previous_run.snapshot_id = NEW.snapshot_id
    AND previous_run.generation_epoch = NEW.generation_epoch - 1
    AND previous_run.status = 'failed'
)
OR NOT EXISTS (
  SELECT 1 FROM temporal_tasks AS retry_task
  WHERE retry_task.id = NEW.task_id
    AND retry_task.agent_id = NEW.agent_id
    AND retry_task.entity_id = NEW.incoming_letter_id
    AND retry_task.kind = 'letter.generation_retry'
    AND retry_task.status = 'pending'
    AND retry_task.max_attempts = 3
    AND json_extract(retry_task.payload_json, '$.incomingLetterId')
      = NEW.incoming_letter_id
    AND json_extract(retry_task.payload_json, '$.snapshotId') = NEW.snapshot_id
    AND json_extract(retry_task.payload_json, '$.generationEpoch')
      = NEW.generation_epoch
)
BEGIN
  SELECT RAISE(ABORT, 'reply retry request must match its immutable recovery chain');
END;

CREATE TRIGGER correspondence_reply_retry_requests_immutable
BEFORE UPDATE ON correspondence_reply_retry_requests
BEGIN
  SELECT RAISE(ABORT, 'reply retry requests are immutable');
END;

CREATE TRIGGER correspondence_reply_retry_requests_protect_delete
BEFORE DELETE ON correspondence_reply_retry_requests
WHEN EXISTS (SELECT 1 FROM characters WHERE id = OLD.agent_id)
BEGIN
  SELECT RAISE(ABORT, 'reply retry requests may only be deleted with their character');
END;
