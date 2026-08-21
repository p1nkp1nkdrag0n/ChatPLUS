ALTER TABLE proactive_candidates ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE proactive_candidates ADD COLUMN claim_token TEXT;
ALTER TABLE proactive_candidates ADD COLUMN claimed_at_utc TEXT;
ALTER TABLE proactive_candidates ADD COLUMN last_error TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS proactive_candidates_claim_token_unique
  ON proactive_candidates(claim_token) WHERE claim_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS proactive_candidates_claimable_idx
  ON proactive_candidates(agent_id, status, revision, earliest_at_utc, expires_at_utc);
