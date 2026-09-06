-- Digital keepsakes are deliberately migrated separately from correspondence.
-- This migration also widens the shared temporal queue without changing the
-- correspondence catch-up handler's explicit allow-list.

CREATE TABLE temporal_tasks_v2 (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (
    kind IN (
      'letter.outbound_arrival', 'letter.reply_generation',
      'letter.return_arrival', 'letter.generation_retry',
      'keepsake.generate'
    )
  ),
  entity_id TEXT NOT NULL,
  due_at_utc TEXT NOT NULL,
  priority INTEGER NOT NULL CHECK (priority >= 0),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'claimed', 'completed', 'retryable', 'dead_letter')
  ),
  claim_token TEXT,
  claimed_at_utc TEXT,
  lease_expires_at_utc TEXT,
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  last_error_code TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
  ),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  completed_at_utc TEXT,
  CHECK (created_at_utc <= updated_at_utc),
  CHECK (
    (status = 'claimed'
      AND claim_token IS NOT NULL
      AND claimed_at_utc IS NOT NULL
      AND lease_expires_at_utc IS NOT NULL
      AND completed_at_utc IS NULL)
    OR (status = 'completed'
      AND claim_token IS NULL
      AND claimed_at_utc IS NULL
      AND lease_expires_at_utc IS NULL
      AND completed_at_utc IS NOT NULL)
    OR (status IN ('pending', 'retryable', 'dead_letter')
      AND claim_token IS NULL
      AND claimed_at_utc IS NULL
      AND lease_expires_at_utc IS NULL
      AND completed_at_utc IS NULL)
  ),
  CHECK (claimed_at_utc IS NULL OR lease_expires_at_utc > claimed_at_utc)
);

INSERT INTO temporal_tasks_v2(
  id, agent_id, kind, entity_id, due_at_utc, priority, status,
  claim_token, claimed_at_utc, lease_expires_at_utc, attempt, max_attempts,
  idempotency_key, last_error_code, payload_json, created_at_utc,
  updated_at_utc, completed_at_utc
)
SELECT
  id, agent_id, kind, entity_id, due_at_utc, priority, status,
  claim_token, claimed_at_utc, lease_expires_at_utc, attempt, max_attempts,
  idempotency_key, last_error_code, payload_json, created_at_utc,
  updated_at_utc, completed_at_utc
FROM temporal_tasks;

DROP TABLE temporal_tasks;
ALTER TABLE temporal_tasks_v2 RENAME TO temporal_tasks;

CREATE UNIQUE INDEX temporal_tasks_claim_idx
  ON temporal_tasks(claim_token) WHERE claim_token IS NOT NULL;
CREATE INDEX temporal_tasks_due_idx
  ON temporal_tasks(status, due_at_utc, priority, id);
CREATE INDEX temporal_tasks_agent_status_idx
  ON temporal_tasks(agent_id, status, due_at_utc, id);

CREATE TRIGGER temporal_tasks_immutable_identity
BEFORE UPDATE ON temporal_tasks
WHEN NEW.agent_id IS NOT OLD.agent_id
  OR NEW.kind IS NOT OLD.kind
  OR NEW.entity_id IS NOT OLD.entity_id
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
BEGIN
  SELECT RAISE(ABORT, 'temporal task identity is immutable');
END;

CREATE TRIGGER temporal_tasks_valid_status_transition
BEFORE UPDATE OF status ON temporal_tasks
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('claimed', 'dead_letter'))
  OR (OLD.status = 'claimed'
    AND NEW.status IN ('completed', 'retryable', 'dead_letter'))
  OR (OLD.status = 'retryable' AND NEW.status IN ('claimed', 'dead_letter'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid temporal task status transition');
END;

CREATE TABLE character_visual_profiles (
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  character_version INTEGER NOT NULL CHECK (character_version > 0),
  stable_appearance_traits_json TEXT NOT NULL CHECK (
    json_valid(stable_appearance_traits_json)
    AND json_type(stable_appearance_traits_json) = 'array'
  ),
  period_and_setting TEXT NOT NULL CHECK (length(trim(period_and_setting)) > 0),
  material_language_json TEXT NOT NULL CHECK (
    json_valid(material_language_json)
    AND json_type(material_language_json) = 'array'
    AND json_array_length(material_language_json) > 0
  ),
  image_language_json TEXT NOT NULL CHECK (
    json_valid(image_language_json)
    AND json_type(image_language_json) = 'array'
    AND json_array_length(image_language_json) > 0
  ),
  forbidden_elements_json TEXT NOT NULL CHECK (
    json_valid(forbidden_elements_json)
    AND json_type(forbidden_elements_json) = 'array'
  ),
  profile_hash TEXT NOT NULL CHECK (
    length(profile_hash) = 64 AND profile_hash NOT GLOB '*[^0-9a-f]*'
  ),
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY(agent_id, version),
  UNIQUE(agent_id, profile_hash)
);

CREATE TRIGGER character_visual_profiles_immutable
BEFORE UPDATE ON character_visual_profiles
BEGIN
  SELECT RAISE(ABORT, 'character visual profiles are immutable');
END;

CREATE TABLE keepsakes (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'postcard', 'ticket_stub', 'polaroid', 'sketch',
      'pressed_flower', 'recipe_or_note_card'
    )
  ),
  description TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 2000),
  created_by TEXT NOT NULL CHECK (created_by IN ('user', 'agent')),
  owned_by TEXT NOT NULL CHECK (owned_by IN ('user', 'agent')),
  given_to TEXT CHECK (given_to IN ('user', 'agent')),
  source_event_ids_json TEXT NOT NULL CHECK (
    json_valid(source_event_ids_json)
    AND json_type(source_event_ids_json) = 'array'
  ),
  source_memory_ids_json TEXT NOT NULL CHECK (
    json_valid(source_memory_ids_json)
    AND json_type(source_memory_ids_json) = 'array'
  ),
  source_letter_ids_json TEXT NOT NULL CHECK (
    json_valid(source_letter_ids_json)
    AND json_type(source_letter_ids_json) = 'array'
  ),
  semantic_key TEXT NOT NULL CHECK (length(trim(semantic_key)) > 0),
  semantic_signature TEXT NOT NULL CHECK (
    length(semantic_signature) = 64
    AND semantic_signature NOT GLOB '*[^0-9a-f]*'
  ),
  canonicality TEXT NOT NULL CHECK (
    canonicality IN ('canonical', 'evidence_derived')
  ),
  status TEXT NOT NULL CHECK (status IN ('pending', 'generating', 'ready', 'failed')),
  visual_spec_json TEXT NOT NULL CHECK (
    json_valid(visual_spec_json) AND json_type(visual_spec_json) = 'object'
  ),
  visual_spec_hash TEXT NOT NULL CHECK (
    length(visual_spec_hash) = 64
    AND visual_spec_hash NOT GLOB '*[^0-9a-f]*'
  ),
  primary_asset_id TEXT,
  created_effective_at_utc TEXT NOT NULL,
  gifted_at_utc TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  CHECK (created_at_utc <= updated_at_utc),
  CHECK (gifted_at_utc IS NULL OR given_to IS NOT NULL),
  CHECK (gifted_at_utc IS NULL OR gifted_at_utc >= created_effective_at_utc),
  CHECK (
    json_array_length(source_event_ids_json)
    + json_array_length(source_memory_ids_json)
    + json_array_length(source_letter_ids_json) > 0
  ),
  CHECK (
    (status = 'ready' AND primary_asset_id IS NOT NULL)
    OR (status <> 'ready' AND primary_asset_id IS NULL)
  ),
  UNIQUE(agent_id, semantic_signature)
);

CREATE INDEX keepsakes_agent_time_idx
  ON keepsakes(agent_id, created_effective_at_utc DESC, id DESC);
CREATE INDEX keepsakes_agent_kind_time_idx
  ON keepsakes(agent_id, kind, created_effective_at_utc DESC, id DESC);

CREATE TABLE keepsake_sources (
  keepsake_id TEXT NOT NULL REFERENCES keepsakes(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (
    source_type IN ('life_outcome', 'relationship_milestone', 'reflection', 'letter')
  ),
  source_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (length(trim(label)) > 0),
  effective_at_utc TEXT,
  source_snapshot_json TEXT NOT NULL CHECK (
    json_valid(source_snapshot_json) AND json_type(source_snapshot_json) = 'object'
  ),
  PRIMARY KEY(keepsake_id, source_type, source_id)
);

CREATE INDEX keepsake_sources_source_idx
  ON keepsake_sources(agent_id, source_type, source_id);

-- A reply may carry at most one keepsake. The link is created while the
-- artifact is pending and becomes visible only after the artifact is ready.
CREATE TABLE keepsake_letter_links (
  reply_letter_id TEXT PRIMARY KEY REFERENCES letters(id) ON DELETE RESTRICT,
  incoming_letter_id TEXT NOT NULL REFERENCES letters(id) ON DELETE RESTRICT,
  keepsake_id TEXT NOT NULL UNIQUE REFERENCES keepsakes(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  created_at_utc TEXT NOT NULL
);

CREATE TRIGGER keepsake_letter_links_validate
BEFORE INSERT ON keepsake_letter_links
WHEN NOT EXISTS (
  SELECT 1
  FROM letters reply
  JOIN letters incoming ON incoming.id = NEW.incoming_letter_id
  JOIN keepsakes artifact ON artifact.id = NEW.keepsake_id
  WHERE reply.id = NEW.reply_letter_id
    AND reply.reply_to_letter_id = incoming.id
    AND reply.direction = 'agent_to_user'
    AND incoming.direction = 'user_to_agent'
    AND reply.agent_id = NEW.agent_id
    AND incoming.agent_id = NEW.agent_id
    AND artifact.agent_id = NEW.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'keepsake letter link provenance mismatch');
END;

CREATE TRIGGER keepsake_letter_links_immutable
BEFORE UPDATE ON keepsake_letter_links
BEGIN
  SELECT RAISE(ABORT, 'keepsake letter links are immutable');
END;

CREATE TABLE keepsake_generation_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE REFERENCES temporal_tasks(id) ON DELETE RESTRICT,
  keepsake_id TEXT NOT NULL REFERENCES keepsakes(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  generation_epoch INTEGER NOT NULL CHECK (generation_epoch >= 0),
  visual_spec_hash TEXT NOT NULL CHECK (
    length(visual_spec_hash) = 64
    AND visual_spec_hash NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'generating', 'retryable', 'committed', 'failed')
  ),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  provider TEXT,
  model TEXT,
  error_code TEXT,
  result_hash TEXT CHECK (
    result_hash IS NULL
    OR (length(result_hash) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*')
  ),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  committed_at_utc TEXT,
  CHECK (created_at_utc <= updated_at_utc),
  CHECK (
    (status = 'committed' AND committed_at_utc IS NOT NULL
      AND provider IS NOT NULL AND model IS NOT NULL)
    OR (status <> 'committed' AND committed_at_utc IS NULL)
  ),
  UNIQUE(keepsake_id, generation_epoch)
);

CREATE INDEX keepsake_generation_runs_status_idx
  ON keepsake_generation_runs(agent_id, status, updated_at_utc, id);

CREATE TABLE keepsake_assets (
  id TEXT PRIMARY KEY,
  keepsake_id TEXT NOT NULL UNIQUE REFERENCES keepsakes(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  thumbnail_storage_key TEXT NOT NULL,
  mime_type TEXT NOT NULL CHECK (mime_type = 'image/webp'),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 8192),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 8192),
  sha256 TEXT NOT NULL CHECK (
    length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  thumbnail_sha256 TEXT NOT NULL CHECK (
    length(thumbnail_sha256) = 64
    AND thumbnail_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_spec_hash TEXT NOT NULL CHECK (
    length(prompt_spec_hash) = 64
    AND prompt_spec_hash NOT GLOB '*[^0-9a-f]*'
  ),
  generation_run_id TEXT NOT NULL UNIQUE
    REFERENCES keepsake_generation_runs(id) ON DELETE RESTRICT,
  created_at_utc TEXT NOT NULL,
  UNIQUE(agent_id, storage_key),
  UNIQUE(agent_id, thumbnail_storage_key)
);

CREATE TRIGGER keepsake_assets_validate_owner
BEFORE INSERT ON keepsake_assets
WHEN NOT EXISTS (
  SELECT 1 FROM keepsakes
  WHERE id = NEW.keepsake_id AND agent_id = NEW.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'keepsake asset owner mismatch');
END;

CREATE TRIGGER keepsake_assets_immutable
BEFORE UPDATE ON keepsake_assets
BEGIN
  SELECT RAISE(ABORT, 'keepsake assets are immutable');
END;

CREATE TRIGGER keepsakes_validate_primary_asset
BEFORE UPDATE OF status, primary_asset_id ON keepsakes
WHEN NEW.status = 'ready' AND NOT EXISTS (
  SELECT 1 FROM keepsake_assets asset
  WHERE asset.id = NEW.primary_asset_id
    AND asset.keepsake_id = NEW.id
    AND asset.agent_id = NEW.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'ready keepsake requires its own primary asset');
END;

CREATE TRIGGER keepsakes_immutable_story
BEFORE UPDATE ON keepsakes
WHEN NEW.agent_id IS NOT OLD.agent_id
  OR NEW.title IS NOT OLD.title
  OR NEW.kind IS NOT OLD.kind
  OR NEW.description IS NOT OLD.description
  OR NEW.created_by IS NOT OLD.created_by
  OR NEW.owned_by IS NOT OLD.owned_by
  OR NEW.source_event_ids_json IS NOT OLD.source_event_ids_json
  OR NEW.source_memory_ids_json IS NOT OLD.source_memory_ids_json
  OR NEW.source_letter_ids_json IS NOT OLD.source_letter_ids_json
  OR NEW.semantic_key IS NOT OLD.semantic_key
  OR NEW.semantic_signature IS NOT OLD.semantic_signature
  OR NEW.canonicality IS NOT OLD.canonicality
  OR NEW.visual_spec_json IS NOT OLD.visual_spec_json
  OR NEW.visual_spec_hash IS NOT OLD.visual_spec_hash
  OR NEW.created_effective_at_utc IS NOT OLD.created_effective_at_utc
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR NEW.created_at_utc IS NOT OLD.created_at_utc
BEGIN
  SELECT RAISE(ABORT, 'keepsake story and provenance are immutable');
END;

CREATE TRIGGER keepsakes_valid_status_transition
BEFORE UPDATE OF status ON keepsakes
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('generating', 'failed'))
  OR (OLD.status = 'generating' AND NEW.status IN ('ready', 'failed'))
  OR (OLD.status = 'failed' AND NEW.status = 'generating')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid keepsake status transition');
END;

CREATE TRIGGER keepsake_sources_immutable
BEFORE UPDATE ON keepsake_sources
BEGIN
  SELECT RAISE(ABORT, 'keepsake sources are immutable');
END;

CREATE TRIGGER keepsake_generation_runs_immutable_identity
BEFORE UPDATE ON keepsake_generation_runs
WHEN NEW.task_id IS NOT OLD.task_id
  OR NEW.keepsake_id IS NOT OLD.keepsake_id
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.generation_epoch IS NOT OLD.generation_epoch
  OR NEW.visual_spec_hash IS NOT OLD.visual_spec_hash
BEGIN
  SELECT RAISE(ABORT, 'keepsake generation identity is immutable');
END;

CREATE TRIGGER keepsake_generation_runs_valid_status_transition
BEFORE UPDATE OF status ON keepsake_generation_runs
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('generating', 'failed'))
  OR (OLD.status = 'generating'
    AND NEW.status IN ('retryable', 'committed', 'failed'))
  OR (OLD.status = 'retryable' AND NEW.status IN ('generating', 'failed'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid keepsake generation status transition');
END;

CREATE TRIGGER keepsakes_protect_delete
BEFORE DELETE ON keepsakes
WHEN EXISTS (SELECT 1 FROM characters WHERE id = OLD.agent_id)
BEGIN
  SELECT RAISE(ABORT, 'durable keepsakes may only be deleted with their character');
END;

CREATE TRIGGER keepsake_assets_protect_delete
BEFORE DELETE ON keepsake_assets
WHEN EXISTS (SELECT 1 FROM characters WHERE id = OLD.agent_id)
BEGIN
  SELECT RAISE(ABORT, 'durable keepsake assets may only be deleted with their character');
END;
