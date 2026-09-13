-- requires-foreign-keys-off
-- Rebuild the constrained letters table while retaining every existing letter,
-- foreign-key target, index and durability trigger. Separate letters in one
-- correspondence thread may now travel and receive their own replies concurrently.
CREATE TEMP TABLE letters_delivery_backup AS SELECT rowid AS legacy_rowid, * FROM letters;
DROP TABLE letters;

CREATE TABLE IF NOT EXISTS letters (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL
    REFERENCES correspondence_threads(id) ON DELETE NO ACTION
      DEFERRABLE INITIALLY DEFERRED,
  agent_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  create_request_id TEXT,
  create_request_hash TEXT CHECK (
    create_request_hash IS NULL
    OR (length(create_request_hash) = 64
      AND create_request_hash NOT GLOB '*[^0-9a-f]*')
  ),
  seal_request_id TEXT,
  reply_to_letter_id TEXT UNIQUE REFERENCES letters(id) ON DELETE NO ACTION
    DEFERRABLE INITIALLY DEFERRED,
  direction TEXT NOT NULL CHECK (
    direction IN ('user_to_agent', 'agent_to_user')
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'draft', 'sealed', 'in_transit', 'delivered_unread', 'read', 'cancelled'
    )
  ),
  delivery_method TEXT NOT NULL DEFAULT 'standard'
    CHECK (delivery_method IN ('standard', 'express', 'priority')),
  subject TEXT,
  body TEXT,
  content_hash TEXT CHECK (
    content_hash IS NULL
    OR (length(content_hash) = 64 AND content_hash NOT GLOB '*[^0-9a-f]*')
  ),
  encrypted_ciphertext TEXT,
  encrypted_iv TEXT,
  encrypted_auth_tag TEXT,
  encrypted_key_version INTEGER CHECK (
    encrypted_key_version IS NULL OR encrypted_key_version > 0
  ),
  encrypted_aad_hash TEXT CHECK (
    encrypted_aad_hash IS NULL
    OR (
      length(encrypted_aad_hash) = 64
      AND encrypted_aad_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  encrypted_created_at_utc TEXT,
  transit_policy_version TEXT CHECK (
    transit_policy_version IS NULL
    OR transit_policy_version IN ('fixed_5d_v1', 'fixed_2d_v1', 'fixed_1d_v1')
  ),
  transit_timezone TEXT CHECK (
    transit_timezone IS NULL OR length(trim(transit_timezone)) > 0
  ),
  dispatched_at_utc TEXT,
  arrival_due_at_utc TEXT,
  effective_author_time_utc TEXT,
  delivered_effective_at_utc TEXT,
  processed_at_utc TEXT,
  read_at_utc TEXT,
  opened_at_utc TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  CHECK (created_at_utc <= updated_at_utc),
  CHECK (transit_policy_version IS NULL OR
    (delivery_method = 'standard' AND transit_policy_version = 'fixed_5d_v1') OR
    (delivery_method = 'express' AND transit_policy_version = 'fixed_2d_v1') OR
    (delivery_method = 'priority' AND transit_policy_version = 'fixed_1d_v1')),
  CHECK (
    (create_request_id IS NULL AND create_request_hash IS NULL)
    OR (create_request_id IS NOT NULL AND create_request_hash IS NOT NULL)
  ),
  CHECK (reply_to_letter_id IS NULL OR reply_to_letter_id <> id),
  CHECK (
    (status IN ('draft', 'cancelled')
      AND content_hash IS NULL
      AND transit_policy_version IS NULL
      AND transit_timezone IS NULL
      AND dispatched_at_utc IS NULL
      AND arrival_due_at_utc IS NULL
      AND effective_author_time_utc IS NULL
      AND delivered_effective_at_utc IS NULL
      AND processed_at_utc IS NULL
      AND read_at_utc IS NULL
      AND opened_at_utc IS NULL)
    OR
    (status IN ('sealed', 'in_transit', 'delivered_unread', 'read')
      AND content_hash IS NOT NULL
      AND transit_policy_version IS NOT NULL
      AND transit_timezone IS NOT NULL
      AND dispatched_at_utc IS NOT NULL
      AND arrival_due_at_utc IS NOT NULL
      AND effective_author_time_utc IS NOT NULL
      AND effective_author_time_utc <= dispatched_at_utc
      AND dispatched_at_utc < arrival_due_at_utc)
  ),
  CHECK (
    (direction = 'user_to_agent'
      AND encrypted_ciphertext IS NULL
      AND encrypted_iv IS NULL
      AND encrypted_auth_tag IS NULL
      AND encrypted_key_version IS NULL
      AND encrypted_aad_hash IS NULL
      AND encrypted_created_at_utc IS NULL
      AND (status IN ('draft', 'cancelled')
        OR (body IS NOT NULL AND length(trim(body)) > 0)))
    OR
    (direction = 'agent_to_user'
      AND subject IS NULL
      AND body IS NULL
      AND ((status IN ('draft', 'cancelled')
        AND encrypted_ciphertext IS NULL
        AND encrypted_iv IS NULL
        AND encrypted_auth_tag IS NULL
        AND encrypted_key_version IS NULL
        AND encrypted_aad_hash IS NULL
        AND encrypted_created_at_utc IS NULL)
      OR (status IN ('sealed', 'in_transit', 'delivered_unread', 'read')
        AND encrypted_ciphertext IS NOT NULL
        AND encrypted_iv IS NOT NULL
        AND encrypted_auth_tag IS NOT NULL
        AND encrypted_key_version IS NOT NULL
        AND encrypted_aad_hash IS NOT NULL
        AND encrypted_created_at_utc IS NOT NULL)))
  ),
  CHECK (
    (status IN ('delivered_unread', 'read')
      AND delivered_effective_at_utc IS NOT NULL
      AND processed_at_utc IS NOT NULL)
    OR (status NOT IN ('delivered_unread', 'read')
      AND delivered_effective_at_utc IS NULL
      AND processed_at_utc IS NULL)
  ),
  CHECK (
    (status = 'read' AND direction = 'user_to_agent'
      AND read_at_utc IS NOT NULL AND opened_at_utc IS NULL)
    OR (status = 'read' AND direction = 'agent_to_user'
      AND opened_at_utc IS NOT NULL AND read_at_utc IS NULL)
    OR (status <> 'read' AND read_at_utc IS NULL AND opened_at_utc IS NULL)
  ),
  CHECK (
    delivered_effective_at_utc IS NULL
    OR delivered_effective_at_utc = arrival_due_at_utc
  ),
  CHECK (
    processed_at_utc IS NULL
    OR processed_at_utc >= delivered_effective_at_utc
  ),
  CHECK (
    read_at_utc IS NULL OR read_at_utc = delivered_effective_at_utc
  ),
  CHECK (
    opened_at_utc IS NULL OR opened_at_utc >= delivered_effective_at_utc
  )
);

INSERT INTO letters (rowid, id, thread_id, agent_id, create_request_id, create_request_hash, seal_request_id, reply_to_letter_id, direction, status, subject, body, content_hash, encrypted_ciphertext, encrypted_iv, encrypted_auth_tag, encrypted_key_version, encrypted_aad_hash, encrypted_created_at_utc, transit_policy_version, transit_timezone, dispatched_at_utc, arrival_due_at_utc, effective_author_time_utc, delivered_effective_at_utc, processed_at_utc, read_at_utc, opened_at_utc, created_at_utc, updated_at_utc)
SELECT legacy_rowid, id, thread_id, agent_id, create_request_id, create_request_hash, seal_request_id, reply_to_letter_id, direction, status, subject, body, content_hash, encrypted_ciphertext, encrypted_iv, encrypted_auth_tag, encrypted_key_version, encrypted_aad_hash, encrypted_created_at_utc, transit_policy_version, transit_timezone, dispatched_at_utc, arrival_due_at_utc, effective_author_time_utc, delivered_effective_at_utc, processed_at_utc, read_at_utc, opened_at_utc, created_at_utc, updated_at_utc FROM letters_delivery_backup;
DROP TABLE letters_delivery_backup;

CREATE INDEX IF NOT EXISTS letters_thread_created_idx
  ON letters(thread_id, created_at_utc, id);
CREATE INDEX IF NOT EXISTS letters_agent_status_arrival_idx
  ON letters(agent_id, status, arrival_due_at_utc, id);
CREATE INDEX IF NOT EXISTS letters_agent_direction_created_idx
  ON letters(agent_id, direction, created_at_utc DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS letters_create_request_idx
  ON letters(agent_id, create_request_id) WHERE create_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS letters_seal_request_idx
  ON letters(agent_id, seal_request_id) WHERE seal_request_id IS NOT NULL;

CREATE TRIGGER IF NOT EXISTS letters_immutable_after_draft
BEFORE UPDATE ON letters
WHEN OLD.status <> 'draft' AND (
  NEW.thread_id IS NOT OLD.thread_id
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.create_request_id IS NOT OLD.create_request_id
  OR NEW.create_request_hash IS NOT OLD.create_request_hash
  OR NEW.seal_request_id IS NOT OLD.seal_request_id
  OR NEW.reply_to_letter_id IS NOT OLD.reply_to_letter_id
  OR NEW.direction IS NOT OLD.direction
  OR NEW.delivery_method IS NOT OLD.delivery_method
  OR NEW.subject IS NOT OLD.subject
  OR NEW.body IS NOT OLD.body
  OR NEW.content_hash IS NOT OLD.content_hash
  OR NEW.encrypted_ciphertext IS NOT OLD.encrypted_ciphertext
  OR NEW.encrypted_iv IS NOT OLD.encrypted_iv
  OR NEW.encrypted_auth_tag IS NOT OLD.encrypted_auth_tag
  OR NEW.encrypted_key_version IS NOT OLD.encrypted_key_version
  OR NEW.encrypted_aad_hash IS NOT OLD.encrypted_aad_hash
  OR NEW.encrypted_created_at_utc IS NOT OLD.encrypted_created_at_utc
  OR NEW.transit_policy_version IS NOT OLD.transit_policy_version
  OR NEW.transit_timezone IS NOT OLD.transit_timezone
  OR NEW.dispatched_at_utc IS NOT OLD.dispatched_at_utc
  OR NEW.arrival_due_at_utc IS NOT OLD.arrival_due_at_utc
  OR NEW.effective_author_time_utc IS NOT OLD.effective_author_time_utc
)
BEGIN
  SELECT RAISE(ABORT, 'sealed letter content and transport are immutable');
END;

CREATE TRIGGER IF NOT EXISTS letters_immutable_identity
BEFORE UPDATE ON letters
WHEN NEW.thread_id IS NOT OLD.thread_id
  OR NEW.agent_id IS NOT OLD.agent_id
  OR NEW.create_request_id IS NOT OLD.create_request_id
  OR NEW.create_request_hash IS NOT OLD.create_request_hash
  OR NEW.reply_to_letter_id IS NOT OLD.reply_to_letter_id
  OR NEW.direction IS NOT OLD.direction
BEGIN
  SELECT RAISE(ABORT, 'letter identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS letters_immutable_delivery_facts
BEFORE UPDATE ON letters
WHEN (OLD.delivered_effective_at_utc IS NOT NULL
    AND NEW.delivered_effective_at_utc IS NOT OLD.delivered_effective_at_utc)
  OR (OLD.processed_at_utc IS NOT NULL
    AND NEW.processed_at_utc IS NOT OLD.processed_at_utc)
  OR (OLD.read_at_utc IS NOT NULL
    AND NEW.read_at_utc IS NOT OLD.read_at_utc)
  OR (OLD.opened_at_utc IS NOT NULL
    AND NEW.opened_at_utc IS NOT OLD.opened_at_utc)
BEGIN
  SELECT RAISE(ABORT, 'letter delivery and open facts are immutable');
END;

CREATE TRIGGER IF NOT EXISTS letters_valid_status_transition
BEFORE UPDATE OF status ON letters
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'draft' AND NEW.status IN ('sealed', 'cancelled'))
  OR (OLD.status = 'sealed' AND NEW.status = 'in_transit')
  OR (OLD.status = 'in_transit' AND NEW.status = 'delivered_unread')
  OR (OLD.status = 'delivered_unread' AND NEW.status = 'read')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid letter status transition');
END;

CREATE TRIGGER IF NOT EXISTS letters_validate_thread_agent_insert
BEFORE INSERT ON letters
WHEN NOT EXISTS (
  SELECT 1 FROM correspondence_threads
  WHERE id = NEW.thread_id AND agent_id = NEW.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'letter agent must match correspondence thread');
END;

CREATE TRIGGER IF NOT EXISTS letters_validate_reply_insert
BEFORE INSERT ON letters
WHEN NEW.reply_to_letter_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM letters parent
  WHERE parent.id = NEW.reply_to_letter_id
    AND parent.thread_id = NEW.thread_id
    AND parent.agent_id = NEW.agent_id
    AND parent.direction <> NEW.direction
)
BEGIN
  SELECT RAISE(ABORT, 'reply must target the opposite direction in its thread');
END;

CREATE TRIGGER IF NOT EXISTS letters_protect_durable_delete
BEFORE DELETE ON letters
WHEN OLD.status <> 'draft' AND EXISTS (
  SELECT 1 FROM characters WHERE id = OLD.agent_id
)
BEGIN
  SELECT RAISE(ABORT, 'durable letters may only be deleted with their character');
END;


-- Restore achievement hooks attached to the rebuilt letters table.
CREATE TRIGGER achievement_letter_sent AFTER UPDATE OF dispatched_at_utc ON letters
WHEN NEW.direction='user_to_agent' AND OLD.dispatched_at_utc IS NULL AND NEW.dispatched_at_utc IS NOT NULL BEGIN
  INSERT OR IGNORE INTO achievement_unlocks(
    definition_key,scope_key,agent_id,agent_name,title,description,category,badge_key,
    unlocked_at_utc,recorded_at_utc,evidence_kind,evidence_id)
  SELECT d.key,'global',c.id,c.name,d.title,d.description,d.category,d.badge_key,
    NEW.dispatched_at_utc,NEW.dispatched_at_utc,'letter',NEW.id
  FROM achievement_definitions d JOIN characters c ON c.id=NEW.agent_id WHERE d.trigger_kind='letter.sent';
END;
CREATE TRIGGER achievement_letter_received AFTER UPDATE OF delivered_effective_at_utc ON letters
WHEN NEW.direction='agent_to_user' AND OLD.delivered_effective_at_utc IS NULL AND NEW.delivered_effective_at_utc IS NOT NULL BEGIN
  INSERT OR IGNORE INTO achievement_unlocks(
    definition_key,scope_key,agent_id,agent_name,title,description,category,badge_key,
    unlocked_at_utc,recorded_at_utc,evidence_kind,evidence_id)
  SELECT d.key,'global',c.id,c.name,d.title,d.description,d.category,d.badge_key,
    NEW.delivered_effective_at_utc,COALESCE(NEW.processed_at_utc,NEW.delivered_effective_at_utc),'letter',NEW.id
  FROM achievement_definitions d JOIN characters c ON c.id=NEW.agent_id WHERE d.trigger_kind='letter.received';
END;
CREATE TRIGGER achievement_letter_opened AFTER UPDATE OF opened_at_utc ON letters
WHEN NEW.direction='agent_to_user' AND OLD.opened_at_utc IS NULL AND NEW.opened_at_utc IS NOT NULL BEGIN
  INSERT OR IGNORE INTO achievement_unlocks(
    definition_key,scope_key,agent_id,agent_name,title,description,category,badge_key,
    unlocked_at_utc,recorded_at_utc,evidence_kind,evidence_id)
  SELECT d.key,'global',c.id,c.name,d.title,d.description,d.category,d.badge_key,
    NEW.opened_at_utc,NEW.opened_at_utc,'letter',NEW.id
  FROM achievement_definitions d JOIN characters c ON c.id=NEW.agent_id WHERE d.trigger_kind='letter.opened';
END;
