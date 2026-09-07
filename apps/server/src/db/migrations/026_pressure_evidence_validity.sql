-- A source can be rejected for a pressure episode without invalidating the
-- other facts in the same message or pretending the pressure was resolved.
CREATE TABLE pressure_evidence_invalidations (
  agent_id TEXT NOT NULL,
  pressure_episode_id TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (subject IN ('user', 'character', 'shared')),
  source_message_id TEXT NOT NULL,
  source_hash TEXT,
  reason TEXT NOT NULL,
  attribution_version TEXT NOT NULL,
  invalidated_at_utc TEXT NOT NULL,
  PRIMARY KEY (agent_id, pressure_episode_id, source_message_id)
);
CREATE INDEX pressure_invalidated_source ON pressure_evidence_invalidations(agent_id, subject, source_message_id);

CREATE TABLE pressure_projection_validity (
  agent_id TEXT NOT NULL,
  pressure_episode_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active', 'invalidated')),
  updated_at_utc TEXT NOT NULL,
  PRIMARY KEY (agent_id, pressure_episode_id)
);

CREATE TABLE pressure_contribution_journal (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  pressure_episode_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_hash TEXT,
  before_json TEXT,
  after_json TEXT NOT NULL,
  recorded_at_utc TEXT NOT NULL
);
CREATE INDEX pressure_contribution_lookup ON pressure_contribution_journal(agent_id, pressure_episode_id, sequence);

CREATE TABLE pressure_evidence_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,
  pressure_episode_id TEXT NOT NULL,
  source_message_ids_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  before_json TEXT NOT NULL,
  after_json TEXT,
  dependencies_json TEXT NOT NULL,
  recorded_at_utc TEXT NOT NULL
);

CREATE TRIGGER pressure_invalid_source_insert BEFORE INSERT ON pressure_episodes
WHEN EXISTS (SELECT 1 FROM pressure_evidence_invalidations i, json_each(NEW.source_message_ids_json) s
  WHERE i.agent_id = NEW.agent_id AND i.subject = NEW.subject AND i.source_message_id = s.value)
BEGIN SELECT RAISE(ABORT, 'pressure source evidence is invalidated'); END;

CREATE TRIGGER pressure_invalid_source_update BEFORE UPDATE ON pressure_episodes
WHEN EXISTS (SELECT 1 FROM pressure_evidence_invalidations i, json_each(NEW.source_message_ids_json) s
  WHERE i.agent_id = NEW.agent_id AND i.subject = NEW.subject AND i.source_message_id = s.value)
BEGIN SELECT RAISE(ABORT, 'pressure source evidence is invalidated'); END;
