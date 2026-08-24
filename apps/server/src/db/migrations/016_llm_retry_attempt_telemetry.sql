ALTER TABLE llm_calls
  ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 1
  CHECK (attempt_count >= 0);

ALTER TABLE llm_calls
  ADD COLUMN failed_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (
    failed_attempt_count >= 0
    AND failed_attempt_count <= attempt_count
  );

-- Rows created before physical-attempt telemetry represent one legacy
-- provider attempt. Preserve their logical success/failure outcome.
UPDATE llm_calls
SET failed_attempt_count = 1
WHERE success = 0;
