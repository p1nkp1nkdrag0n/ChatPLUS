-- Supports bounded historical shared-schedule lineage lookup without scanning
-- unrelated domain-event kinds for the character.
CREATE INDEX IF NOT EXISTS domain_events_agent_type_recorded_idx
  ON domain_events(agent_id, event_type, recorded_at_utc DESC);
