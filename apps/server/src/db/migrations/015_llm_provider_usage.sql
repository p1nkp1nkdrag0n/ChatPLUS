ALTER TABLE llm_calls
  ADD COLUMN provider_input_tokens INTEGER
  CHECK (provider_input_tokens IS NULL OR provider_input_tokens >= 0);

ALTER TABLE llm_calls
  ADD COLUMN provider_output_tokens INTEGER
  CHECK (provider_output_tokens IS NULL OR provider_output_tokens >= 0);

ALTER TABLE llm_calls
  ADD COLUMN usage_source TEXT NOT NULL DEFAULT 'estimated'
  CHECK (
    (usage_source = 'estimated'
      AND provider_input_tokens IS NULL
      AND provider_output_tokens IS NULL)
    OR
    (usage_source = 'provider'
      AND (provider_input_tokens IS NOT NULL OR provider_output_tokens IS NOT NULL))
  );
