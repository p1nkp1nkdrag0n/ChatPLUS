ALTER TABLE schedule_items ADD COLUMN source_intent_id TEXT
  REFERENCES personal_intentions(id) ON DELETE SET NULL;

ALTER TABLE schedule_items ADD COLUMN correlation_id TEXT;
ALTER TABLE schedule_items ADD COLUMN causation_id TEXT;

CREATE INDEX IF NOT EXISTS schedule_items_source_intent_idx
  ON schedule_items(source_intent_id);

CREATE UNIQUE INDEX IF NOT EXISTS schedule_items_source_intent_unique
  ON schedule_items(agent_id, source_intent_id)
  WHERE source_intent_id IS NOT NULL AND status <> 'cancelled';
