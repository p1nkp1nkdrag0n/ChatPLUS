ALTER TABLE llm_calls ADD COLUMN provider_profile TEXT;

UPDATE llm_calls
SET provider_profile = CASE
  WHEN provider = 'fixture' THEN 'fixture'
  ELSE 'legacy'
END
WHERE provider_profile IS NULL;
