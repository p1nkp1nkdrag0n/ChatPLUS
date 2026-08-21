CREATE TABLE IF NOT EXISTS memory_evidence (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (
    source_type IN ('message', 'activity_event', 'schedule_event', 'character_source', 'manual')
  ),
  source_id TEXT NOT NULL,
  quote TEXT,
  context_summary TEXT,
  recorded_at_utc TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  UNIQUE(memory_id, source_type, source_id)
);

CREATE INDEX IF NOT EXISTS memory_evidence_memory_idx
  ON memory_evidence(memory_id, recorded_at_utc);

CREATE INDEX IF NOT EXISTS memory_evidence_source_idx
  ON memory_evidence(source_type, source_id);

INSERT OR IGNORE INTO memory_evidence(
  id, memory_id, source_type, source_id, recorded_at_utc, evidence_json
)
SELECT
  'evidence_' || id || '_message', id, 'message', source_message_id,
  created_at_utc,
  json_object(
    'id', 'evidence_' || id || '_message', 'memoryId', id,
    'sourceType', 'message', 'sourceId', source_message_id,
    'recordedAtUtc', created_at_utc
  )
FROM memories
WHERE source_message_id IS NOT NULL;

INSERT OR IGNORE INTO memory_evidence(
  id, memory_id, source_type, source_id, recorded_at_utc, evidence_json
)
SELECT
  'evidence_' || id || '_activity', id, 'activity_event', source_event_id,
  created_at_utc,
  json_object(
    'id', 'evidence_' || id || '_activity', 'memoryId', id,
    'sourceType', 'activity_event', 'sourceId', source_event_id,
    'recordedAtUtc', created_at_utc
  )
FROM memories
WHERE source_event_id IS NOT NULL;
