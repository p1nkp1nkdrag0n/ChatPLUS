ALTER TABLE memories ADD COLUMN namespace TEXT NOT NULL DEFAULT 'runtime_simulation';
ALTER TABLE memories ADD COLUMN certainty TEXT NOT NULL DEFAULT 'uncertain';
ALTER TABLE memories ADD COLUMN attribution TEXT NOT NULL DEFAULT 'mixed';
ALTER TABLE memories ADD COLUMN stability TEXT NOT NULL DEFAULT 'situational';
ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'needs_review';
ALTER TABLE memories ADD COLUMN mentioned_at_utc TEXT;
ALTER TABLE memories ADD COLUMN planned_start_at_utc TEXT;
ALTER TABLE memories ADD COLUMN planned_end_at_utc TEXT;
ALTER TABLE memories ADD COLUMN occurred_start_at_utc TEXT;
ALTER TABLE memories ADD COLUMN occurred_end_at_utc TEXT;
ALTER TABLE memories ADD COLUMN recorded_at_utc TEXT;
ALTER TABLE memories ADD COLUMN temporal_certainty TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE memories ADD COLUMN temporal_status TEXT NOT NULL DEFAULT 'unknown';

UPDATE memories SET recorded_at_utc = created_at_utc
WHERE recorded_at_utc IS NULL;

UPDATE memories
SET occurred_start_at_utc = (
      SELECT activity_events.occurred_at_utc FROM activity_events
      WHERE activity_events.id = memories.source_event_id
    ),
    temporal_certainty = 'exact', temporal_status = 'occurred',
    status = 'active', certainty = 'explicit', attribution = 'simulation_event'
WHERE source_event_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM activity_events
    WHERE activity_events.id = memories.source_event_id
  );

UPDATE memories
SET mentioned_at_utc = (
      SELECT messages.created_at_utc FROM messages
      WHERE messages.id = memories.source_message_id
    ),
    temporal_certainty = 'exact', temporal_status = 'unknown',
    status = 'active', certainty = 'explicit',
    attribution = 'user_explicit', namespace = 'user_model'
WHERE source_message_id IS NOT NULL AND source_event_id IS NULL
  AND EXISTS (
    SELECT 1 FROM messages
    WHERE messages.id = memories.source_message_id AND messages.role = 'user'
  );

UPDATE memories
SET mentioned_at_utc = (
      SELECT messages.created_at_utc FROM messages
      WHERE messages.id = memories.source_message_id
    ),
    temporal_certainty = 'exact', temporal_status = 'unknown',
    status = 'needs_review',
    certainty = CASE
      WHEN (SELECT role FROM messages WHERE messages.id = memories.source_message_id) = 'assistant'
      THEN 'inferred' ELSE 'uncertain' END,
    attribution = CASE
      WHEN (SELECT role FROM messages WHERE messages.id = memories.source_message_id) = 'assistant'
      THEN 'character_decision'
      WHEN (SELECT role FROM messages WHERE messages.id = memories.source_message_id) = 'system'
      THEN 'model_inference' ELSE 'mixed' END,
    namespace = CASE
      WHEN (SELECT role FROM messages WHERE messages.id = memories.source_message_id) = 'assistant'
      THEN 'character_self' ELSE 'runtime_simulation' END
WHERE source_message_id IS NOT NULL AND source_event_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM messages
    WHERE messages.id = memories.source_message_id AND messages.role = 'user'
  );

CREATE INDEX IF NOT EXISTS memories_agent_namespace_status_idx
  ON memories(agent_id, namespace, status, importance DESC, created_at_utc DESC);

CREATE INDEX IF NOT EXISTS memories_agent_temporal_idx
  ON memories(agent_id, temporal_status, occurred_start_at_utc, mentioned_at_utc);
