CREATE TABLE agent_memory_revisions (
  agent_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE TABLE memory_derived_validity (
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  derived_type TEXT NOT NULL,
  derived_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'needs_review')),
  validator_version TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY (agent_id, derived_type, derived_id)
);

CREATE TABLE memory_derivation_dependencies (
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  derived_type TEXT NOT NULL,
  derived_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('memory', 'message', 'activity_event', 'domain_event')),
  source_id TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY (agent_id, derived_type, derived_id, source_type, source_id),
  FOREIGN KEY (agent_id, derived_type, derived_id)
    REFERENCES memory_derived_validity(agent_id, derived_type, derived_id) ON DELETE CASCADE
);
CREATE INDEX memory_derivation_source_idx
  ON memory_derivation_dependencies(agent_id, source_type, source_id);

-- Old artifacts remain available as historical records; they have no receipt
-- from the complete-source validator and cannot silently become current facts.
INSERT INTO memory_derived_validity
SELECT agent_id, 'autobiography_entry', id, 'needs_review', 'legacy_unverified', created_at_utc
FROM autobiography_entries;
INSERT INTO memory_derived_validity
SELECT agent_id, 'event_card', id, 'needs_review', 'legacy_unverified', updated_at_utc
FROM event_cards;
UPDATE event_cards SET status = 'superseded', card_json = json_set(card_json, '$.status', 'superseded');

CREATE TRIGGER memories_revision_insert AFTER INSERT ON memories BEGIN
  INSERT INTO agent_memory_revisions(agent_id, revision) VALUES (NEW.agent_id, 1)
  ON CONFLICT(agent_id) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER memories_derivation_update AFTER UPDATE OF content, namespace, certainty, attribution, stability, status, claim_subject_key, claim_disposition, superseded_by_id, merged_into_id, valid_until_utc, memory_json ON memories WHEN OLD.content IS NOT NEW.content OR OLD.namespace IS NOT NEW.namespace OR OLD.certainty IS NOT NEW.certainty OR OLD.attribution IS NOT NEW.attribution OR OLD.stability IS NOT NEW.stability OR OLD.status IS NOT NEW.status OR OLD.claim_subject_key IS NOT NEW.claim_subject_key OR OLD.claim_disposition IS NOT NEW.claim_disposition OR OLD.superseded_by_id IS NOT NEW.superseded_by_id OR OLD.merged_into_id IS NOT NEW.merged_into_id OR OLD.valid_until_utc IS NOT NEW.valid_until_utc OR OLD.memory_json IS NOT NEW.memory_json
BEGIN
  INSERT INTO agent_memory_revisions(agent_id, revision) SELECT OLD.agent_id, 1 FROM characters WHERE id = OLD.agent_id
  ON CONFLICT(agent_id) DO UPDATE SET revision = revision + 1;
  UPDATE memory_derived_validity SET state = 'needs_review', updated_at_utc = COALESCE(NEW.lifecycle_updated_at_utc, NEW.recorded_at_utc, NEW.created_at_utc)
  WHERE agent_id = OLD.agent_id AND EXISTS (
    SELECT 1 FROM memory_derivation_dependencies d
    WHERE d.agent_id = memory_derived_validity.agent_id
      AND d.derived_type = memory_derived_validity.derived_type
      AND d.derived_id = memory_derived_validity.derived_id
      AND d.source_type = 'memory' AND d.source_id = OLD.id
  );
  UPDATE event_cards SET status = 'superseded',
    card_json = json_set(card_json, '$.status', 'superseded')
  WHERE agent_id = OLD.agent_id AND id IN (
    SELECT derived_id FROM memory_derived_validity
    WHERE agent_id = OLD.agent_id AND derived_type = 'event_card' AND state = 'needs_review'
  );
END;

CREATE TRIGGER memories_derivation_delete AFTER DELETE ON memories
BEGIN
  INSERT INTO agent_memory_revisions(agent_id, revision) SELECT OLD.agent_id, 1 FROM characters WHERE id = OLD.agent_id
  ON CONFLICT(agent_id) DO UPDATE SET revision = revision + 1;
  UPDATE memory_derived_validity SET state = 'needs_review', updated_at_utc = COALESCE(OLD.lifecycle_updated_at_utc, OLD.recorded_at_utc, OLD.created_at_utc)
  WHERE agent_id = OLD.agent_id AND EXISTS (
    SELECT 1 FROM memory_derivation_dependencies d
    WHERE d.agent_id = memory_derived_validity.agent_id
      AND d.derived_type = memory_derived_validity.derived_type
      AND d.derived_id = memory_derived_validity.derived_id
      AND d.source_type = 'memory' AND d.source_id = OLD.id
  );
  UPDATE event_cards SET status = 'superseded',
    card_json = json_set(card_json, '$.status', 'superseded')
  WHERE agent_id = OLD.agent_id AND id IN (
    SELECT derived_id FROM memory_derived_validity
    WHERE agent_id = OLD.agent_id AND derived_type = 'event_card' AND state = 'needs_review'
  );
END;

CREATE TRIGGER messages_derivation_update AFTER UPDATE OF content, role ON messages WHEN OLD.content IS NOT NEW.content OR OLD.role IS NOT NEW.role
BEGIN
  INSERT INTO agent_memory_revisions(agent_id, revision) SELECT OLD.agent_id, 1 FROM characters WHERE id = OLD.agent_id
  ON CONFLICT(agent_id) DO UPDATE SET revision = revision + 1;
  UPDATE memory_derived_validity SET state = 'needs_review', updated_at_utc = NEW.created_at_utc
  WHERE agent_id = OLD.agent_id AND EXISTS (
    SELECT 1 FROM memory_derivation_dependencies d
    WHERE d.agent_id = memory_derived_validity.agent_id
      AND d.derived_type = memory_derived_validity.derived_type
      AND d.derived_id = memory_derived_validity.derived_id
      AND d.source_type = 'message' AND d.source_id = OLD.id
  );
  UPDATE event_cards SET status = 'superseded',
    card_json = json_set(card_json, '$.status', 'superseded')
  WHERE agent_id = OLD.agent_id AND id IN (
    SELECT derived_id FROM memory_derived_validity
    WHERE agent_id = OLD.agent_id AND derived_type = 'event_card' AND state = 'needs_review'
  );
END;

CREATE TRIGGER messages_derivation_delete AFTER DELETE ON messages
BEGIN
  INSERT INTO agent_memory_revisions(agent_id, revision) SELECT OLD.agent_id, 1 FROM characters WHERE id = OLD.agent_id
  ON CONFLICT(agent_id) DO UPDATE SET revision = revision + 1;
  UPDATE memory_derived_validity SET state = 'needs_review', updated_at_utc = OLD.created_at_utc
  WHERE agent_id = OLD.agent_id AND EXISTS (
    SELECT 1 FROM memory_derivation_dependencies d
    WHERE d.agent_id = memory_derived_validity.agent_id
      AND d.derived_type = memory_derived_validity.derived_type
      AND d.derived_id = memory_derived_validity.derived_id
      AND d.source_type = 'message' AND d.source_id = OLD.id
  );
  UPDATE event_cards SET status = 'superseded',
    card_json = json_set(card_json, '$.status', 'superseded')
  WHERE agent_id = OLD.agent_id AND id IN (
    SELECT derived_id FROM memory_derived_validity
    WHERE agent_id = OLD.agent_id AND derived_type = 'event_card' AND state = 'needs_review'
  );
END;

CREATE TRIGGER activity_events_derivation_update AFTER UPDATE OF summary ON activity_events WHEN OLD.summary IS NOT NEW.summary
BEGIN
  INSERT INTO agent_memory_revisions(agent_id, revision) SELECT OLD.agent_id, 1 FROM characters WHERE id = OLD.agent_id
  ON CONFLICT(agent_id) DO UPDATE SET revision = revision + 1;
  UPDATE memory_derived_validity SET state = 'needs_review', updated_at_utc = NEW.occurred_at_utc
  WHERE agent_id = OLD.agent_id AND EXISTS (
    SELECT 1 FROM memory_derivation_dependencies d
    WHERE d.agent_id = memory_derived_validity.agent_id
      AND d.derived_type = memory_derived_validity.derived_type
      AND d.derived_id = memory_derived_validity.derived_id
      AND d.source_type = 'activity_event' AND d.source_id = OLD.id
  );
  UPDATE event_cards SET status = 'superseded',
    card_json = json_set(card_json, '$.status', 'superseded')
  WHERE agent_id = OLD.agent_id AND id IN (
    SELECT derived_id FROM memory_derived_validity
    WHERE agent_id = OLD.agent_id AND derived_type = 'event_card' AND state = 'needs_review'
  );
END;

CREATE TRIGGER activity_events_derivation_delete AFTER DELETE ON activity_events
BEGIN
  INSERT INTO agent_memory_revisions(agent_id, revision) SELECT OLD.agent_id, 1 FROM characters WHERE id = OLD.agent_id
  ON CONFLICT(agent_id) DO UPDATE SET revision = revision + 1;
  UPDATE memory_derived_validity SET state = 'needs_review', updated_at_utc = OLD.occurred_at_utc
  WHERE agent_id = OLD.agent_id AND EXISTS (
    SELECT 1 FROM memory_derivation_dependencies d
    WHERE d.agent_id = memory_derived_validity.agent_id
      AND d.derived_type = memory_derived_validity.derived_type
      AND d.derived_id = memory_derived_validity.derived_id
      AND d.source_type = 'activity_event' AND d.source_id = OLD.id
  );
  UPDATE event_cards SET status = 'superseded',
    card_json = json_set(card_json, '$.status', 'superseded')
  WHERE agent_id = OLD.agent_id AND id IN (
    SELECT derived_id FROM memory_derived_validity
    WHERE agent_id = OLD.agent_id AND derived_type = 'event_card' AND state = 'needs_review'
  );
END;

CREATE TRIGGER domain_events_derivation_update AFTER UPDATE OF payload_json ON domain_events WHEN OLD.payload_json IS NOT NEW.payload_json
BEGIN
  INSERT INTO agent_memory_revisions(agent_id, revision) SELECT OLD.agent_id, 1 FROM characters WHERE id = OLD.agent_id
  ON CONFLICT(agent_id) DO UPDATE SET revision = revision + 1;
  UPDATE memory_derived_validity SET state = 'needs_review', updated_at_utc = NEW.recorded_at_utc
  WHERE agent_id = OLD.agent_id AND EXISTS (
    SELECT 1 FROM memory_derivation_dependencies d
    WHERE d.agent_id = memory_derived_validity.agent_id
      AND d.derived_type = memory_derived_validity.derived_type
      AND d.derived_id = memory_derived_validity.derived_id
      AND d.source_type = 'domain_event' AND d.source_id = OLD.id
  );
  UPDATE event_cards SET status = 'superseded',
    card_json = json_set(card_json, '$.status', 'superseded')
  WHERE agent_id = OLD.agent_id AND id IN (
    SELECT derived_id FROM memory_derived_validity
    WHERE agent_id = OLD.agent_id AND derived_type = 'event_card' AND state = 'needs_review'
  );
END;

CREATE TRIGGER domain_events_derivation_delete AFTER DELETE ON domain_events
BEGIN
  INSERT INTO agent_memory_revisions(agent_id, revision) SELECT OLD.agent_id, 1 FROM characters WHERE id = OLD.agent_id
  ON CONFLICT(agent_id) DO UPDATE SET revision = revision + 1;
  UPDATE memory_derived_validity SET state = 'needs_review', updated_at_utc = OLD.recorded_at_utc
  WHERE agent_id = OLD.agent_id AND EXISTS (
    SELECT 1 FROM memory_derivation_dependencies d
    WHERE d.agent_id = memory_derived_validity.agent_id
      AND d.derived_type = memory_derived_validity.derived_type
      AND d.derived_id = memory_derived_validity.derived_id
      AND d.source_type = 'domain_event' AND d.source_id = OLD.id
  );
  UPDATE event_cards SET status = 'superseded',
    card_json = json_set(card_json, '$.status', 'superseded')
  WHERE agent_id = OLD.agent_id AND id IN (
    SELECT derived_id FROM memory_derived_validity
    WHERE agent_id = OLD.agent_id AND derived_type = 'event_card' AND state = 'needs_review'
  );
END;
