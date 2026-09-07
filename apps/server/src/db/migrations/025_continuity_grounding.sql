-- NULL denotes a legacy record awaiting evidence review, not user cancellation.
-- Creation and delivery validate this server-owned basis against current sources.
ALTER TABLE follow_up_intents ADD COLUMN grounding_json TEXT
  CHECK (grounding_json IS NULL OR json_valid(grounding_json));
ALTER TABLE care_cues ADD COLUMN grounding_json TEXT
  CHECK (grounding_json IS NULL OR json_valid(grounding_json));
