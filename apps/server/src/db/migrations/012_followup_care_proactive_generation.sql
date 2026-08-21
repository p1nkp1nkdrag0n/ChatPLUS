CREATE TABLE IF NOT EXISTS follow_up_intents (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL
    REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT
    REFERENCES sessions(id) ON DELETE SET NULL,
  subject_type TEXT NOT NULL CHECK (
    subject_type IN (
      'user_goal',
      'user_event',
      'shared_commitment',
      'character_commitment'
    )
  ),
  context_summary TEXT NOT NULL,
  expected_outcome_description TEXT NOT NULL,
  source_message_id TEXT NOT NULL
    REFERENCES messages(id) ON DELETE RESTRICT,
  earliest_at_utc TEXT NOT NULL,
  expires_at_utc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'resolved',
      'sent',
      'expired',
      'cancelled'
    )
  ),
  max_attempts INTEGER NOT NULL DEFAULT 1 CHECK (max_attempts = 1),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (
    attempt_count BETWEEN 0 AND max_attempts
  ),
  dedupe_key TEXT NOT NULL,
  sent_message_id TEXT
    REFERENCES messages(id) ON DELETE SET NULL,
  resolution_message_id TEXT
    REFERENCES messages(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  generation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (
    generation_epoch >= 0
  ),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  CHECK (expires_at_utc > earliest_at_utc),
  CHECK (updated_at_utc >= created_at_utc),
  CHECK (
    (attempt_count = 0 AND sent_message_id IS NULL)
    OR
    (attempt_count = 1 AND sent_message_id IS NOT NULL)
  ),
  CHECK (status <> 'sent' OR attempt_count = 1),
  CHECK (
    status NOT IN ('resolved', 'cancelled')
    OR resolution_message_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS follow_up_intents_dedupe_unique
  ON follow_up_intents(agent_id, dedupe_key);

CREATE INDEX IF NOT EXISTS follow_up_intents_due_idx
  ON follow_up_intents(
    agent_id,
    status,
    earliest_at_utc,
    expires_at_utc
  );

CREATE TABLE IF NOT EXISTS care_cues (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL
    REFERENCES characters(id) ON DELETE CASCADE,
  session_id TEXT
    REFERENCES sessions(id) ON DELETE SET NULL,
  context_summary TEXT NOT NULL,
  mention_guidance TEXT NOT NULL,
  source_message_id TEXT NOT NULL
    REFERENCES messages(id) ON DELETE RESTRICT,
  earliest_at_utc TEXT,
  expires_at_utc TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('active', 'dismissed', 'expired', 'exhausted')
  ),
  max_mentions INTEGER NOT NULL DEFAULT 1 CHECK (
    max_mentions BETWEEN 1 AND 3
  ),
  mention_count INTEGER NOT NULL DEFAULT 0 CHECK (
    mention_count BETWEEN 0 AND max_mentions
  ),
  dedupe_key TEXT NOT NULL,
  last_mentioned_message_id TEXT
    REFERENCES messages(id) ON DELETE SET NULL,
  dismissed_by_message_id TEXT
    REFERENCES messages(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  CHECK (
    earliest_at_utc IS NULL
    OR expires_at_utc > earliest_at_utc
  ),
  CHECK (expires_at_utc > created_at_utc),
  CHECK (updated_at_utc >= created_at_utc),
  CHECK (
    status <> 'active'
    OR mention_count < max_mentions
  ),
  CHECK (
    status <> 'exhausted'
    OR mention_count = max_mentions
  ),
  CHECK (
    status <> 'dismissed'
    OR dismissed_by_message_id IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS care_cues_dedupe_unique
  ON care_cues(agent_id, dedupe_key);

CREATE INDEX IF NOT EXISTS care_cues_active_idx
  ON care_cues(agent_id, status, expires_at_utc);

ALTER TABLE proactive_candidates
  ADD COLUMN generation_epoch INTEGER NOT NULL DEFAULT 0
  CHECK (generation_epoch >= 0);

ALTER TABLE proactive_candidates
  ADD COLUMN sent_message_id TEXT
  REFERENCES messages(id) ON DELETE SET NULL;

ALTER TABLE messages
  ADD COLUMN trigger_follow_up_intent_id TEXT
  REFERENCES follow_up_intents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_follow_up_trigger_idx
  ON messages(trigger_follow_up_intent_id)
  WHERE trigger_follow_up_intent_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS proactive_generation_runs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL
    REFERENCES characters(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK (
    source_kind IN ('activity_candidate', 'follow_up')
  ),
  proactive_candidate_id TEXT
    REFERENCES proactive_candidates(id) ON DELETE CASCADE,
  follow_up_intent_id TEXT
    REFERENCES follow_up_intents(id) ON DELETE CASCADE,
  generation_epoch INTEGER NOT NULL CHECK (generation_epoch > 0),
  claim_token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (
    status IN (
      'generating',
      'committed',
      'stale_discarded',
      'failed'
    )
  ),
  session_id TEXT NOT NULL
    REFERENCES sessions(id) ON DELETE CASCADE,
  preflight_spec_version INTEGER NOT NULL CHECK (
    preflight_spec_version > 0
  ),
  preflight_state_revision INTEGER NOT NULL CHECK (
    preflight_state_revision >= 0
  ),
  preflight_source_revision INTEGER NOT NULL CHECK (
    preflight_source_revision >= 0
  ),
  preflight_message_rowid INTEGER NOT NULL CHECK (
    preflight_message_rowid >= 0
  ),
  preflight_last_user_message_rowid INTEGER NOT NULL CHECK (
    preflight_last_user_message_rowid >= 0
  ),
  preflight_user_arrival_epoch INTEGER NOT NULL CHECK (
    preflight_user_arrival_epoch >= 0
  ),
  snapshot_json TEXT NOT NULL DEFAULT '{}',
  generated_content TEXT,
  message_id TEXT
    REFERENCES messages(id) ON DELETE SET NULL,
  reason_code TEXT,
  started_at_utc TEXT NOT NULL,
  completed_at_utc TEXT,
  CHECK (
    (
      source_kind = 'activity_candidate'
      AND proactive_candidate_id IS NOT NULL
      AND follow_up_intent_id IS NULL
    )
    OR
    (
      source_kind = 'follow_up'
      AND proactive_candidate_id IS NULL
      AND follow_up_intent_id IS NOT NULL
    )
  ),
  CHECK (
    (status = 'generating' AND completed_at_utc IS NULL)
    OR
    (status <> 'generating' AND completed_at_utc IS NOT NULL)
  ),
  CHECK (status <> 'committed' OR message_id IS NOT NULL),
  CHECK (
    status NOT IN ('stale_discarded', 'failed')
    OR reason_code IS NOT NULL
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS proactive_generation_candidate_epoch_unique
  ON proactive_generation_runs(
    proactive_candidate_id,
    generation_epoch
  )
  WHERE proactive_candidate_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS proactive_generation_follow_up_epoch_unique
  ON proactive_generation_runs(
    follow_up_intent_id,
    generation_epoch
  )
  WHERE follow_up_intent_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS proactive_generation_one_active_agent_unique
  ON proactive_generation_runs(agent_id)
  WHERE status = 'generating';

CREATE INDEX IF NOT EXISTS proactive_generation_status_idx
  ON proactive_generation_runs(
    agent_id,
    status,
    started_at_utc
  );
