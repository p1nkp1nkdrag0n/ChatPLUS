CREATE TABLE persona_runtime_heads (
  agent_id TEXT PRIMARY KEY REFERENCES characters(id) ON DELETE RESTRICT,
  base_character_version INTEGER NOT NULL CHECK (base_character_version >= 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  memory_revision INTEGER NOT NULL DEFAULT 0 CHECK (memory_revision >= 0),
  updated_at_utc TEXT NOT NULL,
  UNIQUE (agent_id, revision)
);

CREATE TABLE persona_observations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64),
  proposal_json TEXT NOT NULL CHECK (json_valid(proposal_json) AND json_type(proposal_json) = 'object'),
  status TEXT NOT NULL CHECK (status IN ('captured', 'accepted', 'rejected')),
  reason_code TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  UNIQUE (agent_id, dedupe_key)
);

CREATE TABLE persona_adaptations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  source_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  scope_key TEXT NOT NULL,
  base_character_version INTEGER NOT NULL CHECK (base_character_version >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'superseded', 'retracted', 'needs_review')),
  record_json TEXT NOT NULL CHECK (json_valid(record_json) AND json_type(record_json) = 'object'),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  UNIQUE (agent_id, source_message_id, scope_key)
);
CREATE INDEX persona_adaptations_current_idx ON persona_adaptations(agent_id, status, revision);

-- Capture the first effective invalidation even when no later conversation or
-- checkpoint reconciles the persona head. Later writes cannot move this cutoff.
CREATE TABLE persona_evidence_invalidations (
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  adaptation_id TEXT NOT NULL REFERENCES persona_adaptations(id) ON DELETE RESTRICT,
  effective_at_utc TEXT NOT NULL,
  memory_revision INTEGER NOT NULL CHECK (memory_revision >= 0),
  PRIMARY KEY (agent_id, adaptation_id)
);
CREATE TRIGGER persona_capture_evidence_invalidation
AFTER UPDATE OF state, updated_at_utc ON memory_derived_validity
WHEN NEW.derived_type = 'persona_adaptation' AND NEW.state = 'needs_review'
BEGIN
  INSERT OR IGNORE INTO persona_evidence_invalidations
    (agent_id, adaptation_id, effective_at_utc, memory_revision)
  SELECT NEW.agent_id, NEW.derived_id, NEW.updated_at_utc,
    COALESCE((SELECT revision FROM agent_memory_revisions WHERE agent_id = NEW.agent_id), 0)
  WHERE EXISTS (SELECT 1 FROM persona_adaptations WHERE id = NEW.derived_id AND agent_id = NEW.agent_id);
END;
CREATE TRIGGER persona_evidence_invalidations_immutable_update BEFORE UPDATE ON persona_evidence_invalidations
BEGIN SELECT RAISE(ABORT, 'persona_evidence_invalidations are immutable'); END;
CREATE TRIGGER persona_evidence_invalidations_immutable_delete BEFORE DELETE ON persona_evidence_invalidations
BEGIN SELECT RAISE(ABORT, 'persona_evidence_invalidations are immutable'); END;

CREATE TABLE persona_revision_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  from_revision INTEGER NOT NULL CHECK (from_revision >= 0),
  to_revision INTEGER NOT NULL CHECK (to_revision = from_revision + 1),
  operation_json TEXT NOT NULL CHECK (json_valid(operation_json) AND json_type(operation_json) = 'object'),
  reason_code TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  UNIQUE (agent_id, to_revision),
  UNIQUE (agent_id, idempotency_key)
);
CREATE TRIGGER persona_revision_events_immutable_update BEFORE UPDATE ON persona_revision_events
BEGIN SELECT RAISE(ABORT, 'persona_revision_events are immutable'); END;
CREATE TRIGGER persona_revision_events_immutable_delete BEFORE DELETE ON persona_revision_events
BEGIN SELECT RAISE(ABORT, 'persona_revision_events are immutable'); END;
