ALTER TABLE sessions ADD COLUMN message_revision INTEGER NOT NULL DEFAULT 0;

UPDATE sessions
SET message_revision = (
  SELECT COUNT(*)
  FROM messages
  WHERE messages.session_id = sessions.id
    AND messages.message_kind IN ('user', 'assistant_reply', 'assistant_proactive')
);

CREATE TRIGGER IF NOT EXISTS messages_revision_ai
AFTER INSERT ON messages
WHEN NEW.message_kind IN ('user', 'assistant_reply', 'assistant_proactive')
BEGIN
  UPDATE sessions
  SET message_revision = message_revision + 1
  WHERE id = NEW.session_id;
END;

CREATE TRIGGER IF NOT EXISTS messages_revision_au
AFTER UPDATE ON messages
WHEN OLD.message_kind IN ('user', 'assistant_reply', 'assistant_proactive')
  OR NEW.message_kind IN ('user', 'assistant_reply', 'assistant_proactive')
BEGIN
  UPDATE sessions
  SET message_revision = message_revision + 1
  WHERE id IN (OLD.session_id, NEW.session_id);
END;

CREATE TRIGGER IF NOT EXISTS messages_revision_ad
AFTER DELETE ON messages
WHEN OLD.message_kind IN ('user', 'assistant_reply', 'assistant_proactive')
BEGIN
  UPDATE sessions
  SET message_revision = message_revision + 1
  WHERE id = OLD.session_id;
END;

CREATE TABLE IF NOT EXISTS message_archive (
  id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  message_kind TEXT NOT NULL CHECK (
    message_kind IN ('user', 'assistant_reply', 'assistant_proactive')
  ),
  content TEXT NOT NULL,
  source_created_at_utc TEXT NOT NULL,
  indexed_at_utc TEXT NOT NULL,
  index_version INTEGER NOT NULL DEFAULT 1 CHECK (index_version > 0)
);

CREATE INDEX IF NOT EXISTS message_archive_session_time_idx
  ON message_archive(session_id, source_created_at_utc, id);

CREATE INDEX IF NOT EXISTS message_archive_agent_time_idx
  ON message_archive(agent_id, source_created_at_utc DESC, id);

CREATE VIRTUAL TABLE IF NOT EXISTS message_archive_fts USING fts5(
  content,
  content = 'message_archive',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS message_archive_fts_ai
AFTER INSERT ON message_archive
BEGIN
  INSERT INTO message_archive_fts(rowid, content)
  VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS message_archive_fts_ad
AFTER DELETE ON message_archive
BEGIN
  INSERT INTO message_archive_fts(message_archive_fts, rowid, content)
  VALUES ('delete', OLD.rowid, OLD.content);
END;

CREATE TRIGGER IF NOT EXISTS message_archive_fts_au
AFTER UPDATE ON message_archive
BEGIN
  INSERT INTO message_archive_fts(message_archive_fts, rowid, content)
  VALUES ('delete', OLD.rowid, OLD.content);
  INSERT INTO message_archive_fts(rowid, content)
  VALUES (NEW.rowid, NEW.content);
END;

INSERT OR IGNORE INTO message_archive(
  id, session_id, agent_id, role, message_kind, content,
  source_created_at_utc, indexed_at_utc, index_version
)
SELECT
  id, session_id, agent_id, role, message_kind, content,
  created_at_utc, created_at_utc, 1
FROM messages
WHERE message_kind IN ('user', 'assistant_reply', 'assistant_proactive')
  AND role IN ('user', 'assistant');

CREATE TRIGGER IF NOT EXISTS messages_archive_ai
AFTER INSERT ON messages
WHEN NEW.message_kind IN ('user', 'assistant_reply', 'assistant_proactive')
  AND NEW.role IN ('user', 'assistant')
BEGIN
  INSERT INTO message_archive(
    id, session_id, agent_id, role, message_kind, content,
    source_created_at_utc, indexed_at_utc, index_version
  ) VALUES (
    NEW.id, NEW.session_id, NEW.agent_id, NEW.role, NEW.message_kind,
    NEW.content, NEW.created_at_utc, NEW.created_at_utc, 1
  );
END;

CREATE TRIGGER IF NOT EXISTS messages_archive_au_hidden
AFTER UPDATE ON messages
WHEN NOT (
  NEW.message_kind IN ('user', 'assistant_reply', 'assistant_proactive')
  AND NEW.role IN ('user', 'assistant')
)
BEGIN
  DELETE FROM message_archive WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS messages_archive_au_visible
AFTER UPDATE ON messages
WHEN NEW.message_kind IN ('user', 'assistant_reply', 'assistant_proactive')
  AND NEW.role IN ('user', 'assistant')
BEGIN
  DELETE FROM message_archive
  WHERE id = OLD.id AND OLD.id <> NEW.id;
  INSERT INTO message_archive(
    id, session_id, agent_id, role, message_kind, content,
    source_created_at_utc, indexed_at_utc, index_version
  ) VALUES (
    NEW.id, NEW.session_id, NEW.agent_id, NEW.role, NEW.message_kind,
    NEW.content, NEW.created_at_utc, NEW.created_at_utc, 1
  )
  ON CONFLICT(id) DO UPDATE SET
    session_id = excluded.session_id,
    agent_id = excluded.agent_id,
    role = excluded.role,
    message_kind = excluded.message_kind,
    content = excluded.content,
    source_created_at_utc = excluded.source_created_at_utc,
    indexed_at_utc = excluded.indexed_at_utc,
    index_version = excluded.index_version;
END;

CREATE TABLE IF NOT EXISTS conversation_checkpoints (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  previous_checkpoint_id TEXT REFERENCES conversation_checkpoints(id),
  from_message_id TEXT NOT NULL REFERENCES messages(id),
  through_message_id TEXT NOT NULL REFERENCES messages(id),
  source_hash TEXT NOT NULL CHECK (
    length(source_hash) = 64
    AND source_hash NOT GLOB '*[^0-9a-f]*'
  ),
  source_revision INTEGER NOT NULL CHECK (source_revision >= 0),
  source_message_count INTEGER NOT NULL CHECK (source_message_count > 0),
  source_token_estimate INTEGER NOT NULL CHECK (source_token_estimate > 0),
  autobiography_snapshot_id TEXT,
  artifact_json TEXT CHECK (artifact_json IS NULL OR json_valid(artifact_json)),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'committed', 'invalidated', 'failed')
  ),
  failure_code TEXT,
  failure_summary TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  committed_at_utc TEXT,
  invalidated_at_utc TEXT,
  UNIQUE(session_id, from_message_id, through_message_id, source_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS conversation_checkpoints_one_pending_idx
  ON conversation_checkpoints(session_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS conversation_checkpoints_latest_idx
  ON conversation_checkpoints(session_id, status, created_at_utc DESC);

CREATE TABLE IF NOT EXISTS autobiography_snapshots (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  source_checkpoint_id TEXT NOT NULL UNIQUE
    REFERENCES conversation_checkpoints(id),
  previous_snapshot_id TEXT REFERENCES autobiography_snapshots(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  summary_first_person TEXT NOT NULL,
  important_experiences_json TEXT NOT NULL CHECK (
    json_valid(important_experiences_json)
  ),
  relationship_changes_json TEXT NOT NULL CHECK (
    json_valid(relationship_changes_json)
  ),
  active_goals_json TEXT NOT NULL CHECK (json_valid(active_goals_json)),
  unresolved_threads_json TEXT NOT NULL CHECK (
    json_valid(unresolved_threads_json)
  ),
  commitments_json TEXT NOT NULL CHECK (json_valid(commitments_json)),
  source_evidence_ids_json TEXT NOT NULL CHECK (
    json_valid(source_evidence_ids_json)
    AND json_array_length(source_evidence_ids_json) > 0
  ),
  from_utc TEXT NOT NULL,
  through_utc TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  created_at_utc TEXT NOT NULL,
  UNIQUE(agent_id, revision)
);

CREATE INDEX IF NOT EXISTS autobiography_snapshots_agent_idx
  ON autobiography_snapshots(agent_id, revision DESC);

CREATE TABLE IF NOT EXISTS autobiography_entries (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL
    REFERENCES autobiography_snapshots(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  entry_kind TEXT NOT NULL CHECK (
    entry_kind IN (
      'important_experience',
      'relationship_change',
      'active_goal',
      'unresolved_thread',
      'commitment'
    )
  ),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  content TEXT NOT NULL,
  temporal_status TEXT NOT NULL CHECK (
    temporal_status IN (
      'planned', 'in_progress', 'occurred', 'cancelled', 'unknown'
    )
  ),
  from_utc TEXT,
  through_utc TEXT,
  source_evidence_ids_json TEXT NOT NULL CHECK (
    json_valid(source_evidence_ids_json)
    AND json_array_length(source_evidence_ids_json) > 0
  ),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  created_at_utc TEXT NOT NULL,
  UNIQUE(snapshot_id, entry_kind, ordinal),
  CHECK (through_utc IS NULL OR from_utc IS NOT NULL),
  CHECK (through_utc IS NULL OR from_utc < through_utc)
);

CREATE INDEX IF NOT EXISTS autobiography_entries_agent_kind_idx
  ON autobiography_entries(agent_id, entry_kind, created_at_utc DESC);

CREATE TABLE IF NOT EXISTS event_cards (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  checkpoint_id TEXT REFERENCES conversation_checkpoints(id) ON DELETE CASCADE,
  card_kind TEXT NOT NULL CHECK (
    card_kind IN (
      'conversation',
      'activity',
      'user_event',
      'shared_experience',
      'relationship_change',
      'goal',
      'commitment'
    )
  ),
  source_kind TEXT NOT NULL CHECK (
    source_kind IN (
      'checkpoint',
      'activity_event',
      'memory',
      'autobiography_entry',
      'domain_event'
    )
  ),
  source_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
  tags_text TEXT NOT NULL,
  namespace TEXT NOT NULL CHECK (
    namespace IN (
      'canon',
      'character_self',
      'user_model',
      'shared_relationship',
      'runtime_simulation'
    )
  ),
  certainty TEXT NOT NULL CHECK (
    certainty IN ('explicit', 'inferred', 'uncertain')
  ),
  attribution TEXT NOT NULL CHECK (
    attribution IN (
      'user_explicit',
      'character_decision',
      'simulation_event',
      'model_inference',
      'mixed'
    )
  ),
  temporal_status TEXT NOT NULL CHECK (
    temporal_status IN (
      'planned', 'in_progress', 'occurred', 'cancelled', 'unknown'
    )
  ),
  mentioned_at_utc TEXT,
  planned_start_at_utc TEXT,
  planned_end_at_utc TEXT,
  occurred_start_at_utc TEXT,
  occurred_end_at_utc TEXT,
  recorded_at_utc TEXT NOT NULL,
  importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'archived')),
  source_evidence_ids_json TEXT NOT NULL CHECK (
    json_valid(source_evidence_ids_json)
    AND json_array_length(source_evidence_ids_json) > 0
  ),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  card_json TEXT NOT NULL CHECK (json_valid(card_json)),
  index_version INTEGER NOT NULL DEFAULT 1 CHECK (index_version > 0),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  CHECK (planned_end_at_utc IS NULL OR planned_start_at_utc IS NOT NULL),
  CHECK (occurred_end_at_utc IS NULL OR occurred_start_at_utc IS NOT NULL),
  CHECK (
    temporal_status <> 'planned'
    OR (occurred_start_at_utc IS NULL AND occurred_end_at_utc IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS event_cards_agent_status_time_idx
  ON event_cards(
    agent_id, status, occurred_start_at_utc, mentioned_at_utc, recorded_at_utc
  );

CREATE INDEX IF NOT EXISTS event_cards_source_idx
  ON event_cards(agent_id, source_kind, source_id);

CREATE VIRTUAL TABLE IF NOT EXISTS event_cards_fts USING fts5(
  title,
  summary,
  tags_text,
  content = 'event_cards',
  content_rowid = 'rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS event_cards_fts_ai
AFTER INSERT ON event_cards
BEGIN
  INSERT INTO event_cards_fts(rowid, title, summary, tags_text)
  VALUES (NEW.rowid, NEW.title, NEW.summary, NEW.tags_text);
END;

CREATE TRIGGER IF NOT EXISTS event_cards_fts_ad
AFTER DELETE ON event_cards
BEGIN
  INSERT INTO event_cards_fts(
    event_cards_fts, rowid, title, summary, tags_text
  ) VALUES (
    'delete', OLD.rowid, OLD.title, OLD.summary, OLD.tags_text
  );
END;

CREATE TRIGGER IF NOT EXISTS event_cards_fts_au
AFTER UPDATE ON event_cards
BEGIN
  INSERT INTO event_cards_fts(
    event_cards_fts, rowid, title, summary, tags_text
  ) VALUES (
    'delete', OLD.rowid, OLD.title, OLD.summary, OLD.tags_text
  );
  INSERT INTO event_cards_fts(rowid, title, summary, tags_text)
  VALUES (NEW.rowid, NEW.title, NEW.summary, NEW.tags_text);
END;

ALTER TABLE memories ADD COLUMN claim_subject_key TEXT;
ALTER TABLE memories ADD COLUMN claim_disposition TEXT;
ALTER TABLE memories ADD COLUMN superseded_by_id TEXT;
ALTER TABLE memories ADD COLUMN merged_into_id TEXT;
ALTER TABLE memories ADD COLUMN last_reinforced_at_utc TEXT;
ALTER TABLE memories ADD COLUMN lifecycle_updated_at_utc TEXT;

UPDATE memories
SET status = 'archived',
    memory_json = CASE
      WHEN memory_json IS NOT NULL AND json_valid(memory_json)
      THEN json_set(memory_json, '$.status', 'archived')
      ELSE memory_json
    END
WHERE status = 'forgotten';

UPDATE memories
SET claim_subject_key = CASE
      WHEN memory_json IS NOT NULL AND json_valid(memory_json)
      THEN json_extract(memory_json, '$.claim.subjectKey')
      ELSE NULL
    END,
    claim_disposition = CASE
      WHEN memory_json IS NOT NULL AND json_valid(memory_json)
      THEN json_extract(memory_json, '$.claim.disposition')
      ELSE NULL
    END,
    superseded_by_id = CASE
      WHEN memory_json IS NOT NULL AND json_valid(memory_json)
      THEN json_extract(memory_json, '$.supersededById')
      ELSE NULL
    END,
    merged_into_id = CASE
      WHEN memory_json IS NOT NULL AND json_valid(memory_json)
      THEN json_extract(memory_json, '$.mergedIntoId')
      ELSE NULL
    END,
    last_reinforced_at_utc = created_at_utc,
    lifecycle_updated_at_utc = created_at_utc;

CREATE INDEX IF NOT EXISTS memories_agent_lifecycle_idx
  ON memories(agent_id, status, claim_subject_key, created_at_utc DESC);

CREATE TABLE IF NOT EXISTS memory_conflicts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  subject_key TEXT NOT NULL,
  left_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  right_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
  resolution TEXT CHECK (
    resolution IS NULL
    OR resolution IN ('superseded', 'merged', 'needs_review', 'dismissed')
  ),
  winner_memory_id TEXT REFERENCES memories(id),
  reason_code TEXT NOT NULL,
  reason_summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at_utc TEXT NOT NULL,
  resolved_at_utc TEXT,
  CHECK (left_memory_id < right_memory_id),
  UNIQUE(agent_id, subject_key, left_memory_id, right_memory_id)
);

CREATE INDEX IF NOT EXISTS memory_conflicts_agent_status_idx
  ON memory_conflicts(agent_id, status, created_at_utc DESC);

CREATE TABLE IF NOT EXISTS memory_merge_history (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  target_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_memory_id TEXT REFERENCES memories(id) ON DELETE SET NULL,
  subject_key TEXT,
  reason_code TEXT NOT NULL,
  reason_summary TEXT NOT NULL,
  source_snapshot_json TEXT NOT NULL CHECK (json_valid(source_snapshot_json)),
  target_before_json TEXT NOT NULL CHECK (json_valid(target_before_json)),
  target_after_json TEXT NOT NULL CHECK (json_valid(target_after_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  merged_at_utc TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS memory_merge_history_agent_idx
  ON memory_merge_history(agent_id, merged_at_utc DESC);
