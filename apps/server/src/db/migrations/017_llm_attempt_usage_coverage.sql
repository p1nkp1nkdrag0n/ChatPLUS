ALTER TABLE llm_calls
  ADD COLUMN provider_input_usage_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (
    provider_input_usage_attempt_count >= 0
    AND provider_input_usage_attempt_count <= attempt_count
  );

ALTER TABLE llm_calls
  ADD COLUMN provider_output_usage_attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK (
    provider_output_usage_attempt_count >= 0
    AND provider_output_usage_attempt_count <= attempt_count
  );

-- Existing rows cannot prove how many physical attempts were observed. New
-- writers explicitly opt into exact telemetry after recording every attempt.
ALTER TABLE llm_calls
  ADD COLUMN attempt_telemetry_source TEXT NOT NULL DEFAULT 'inferred'
  CHECK (attempt_telemetry_source IN ('exact', 'inferred'));

-- Preserve compatibility with a legacy writer that inserts a failed logical
-- call using the post-016 defaults. The resulting row stays visibly inferred.
CREATE TRIGGER llm_calls_legacy_failure_insert_017
AFTER INSERT ON llm_calls
WHEN NEW.attempt_telemetry_source = 'inferred'
  AND NEW.success = 0
  AND NEW.attempt_count = 1
  AND NEW.failed_attempt_count = 0
BEGIN
  UPDATE llm_calls
  SET failed_attempt_count = 1
  WHERE id = NEW.id;
END;

CREATE TRIGGER llm_calls_exact_attempt_insert_017
BEFORE INSERT ON llm_calls
WHEN NEW.attempt_telemetry_source = 'exact'
  AND NOT (
    (NEW.success = 1
      AND NEW.attempt_count >= 1
      AND NEW.failed_attempt_count < NEW.attempt_count)
    OR
    (NEW.success = 0
      AND NEW.failed_attempt_count = NEW.attempt_count)
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid exact llm attempt telemetry');
END;

CREATE TRIGGER llm_calls_exact_attempt_update_017
BEFORE UPDATE OF success, attempt_count, failed_attempt_count,
  attempt_telemetry_source ON llm_calls
WHEN NEW.attempt_telemetry_source = 'exact'
  AND NOT (
    (NEW.success = 1
      AND NEW.attempt_count >= 1
      AND NEW.failed_attempt_count < NEW.attempt_count)
    OR
    (NEW.success = 0
      AND NEW.failed_attempt_count = NEW.attempt_count)
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid exact llm attempt telemetry');
END;
