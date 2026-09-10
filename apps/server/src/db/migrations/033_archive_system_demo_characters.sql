-- Retire only identities with an explicit system origin or durable demo
-- registration. Display names are deliberately not used as evidence.
UPDATE characters SET creation_origin = 'demo'
WHERE id IN (SELECT character_id FROM demo_conversations);

-- Archive the current version in the same way as the character archive
-- operation. Earlier versions, sources, sessions and messages are preserved.
UPDATE character_versions
SET status = 'archived',
    spec_json = json_set(
      spec_json,
      '$.status', 'archived',
      '$.updatedAtUtc', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
WHERE EXISTS (
  SELECT 1 FROM characters
  WHERE characters.id = character_versions.character_id
    AND characters.current_version = character_versions.version
    AND characters.creation_origin = 'demo'
    AND characters.status <> 'archived'
);

UPDATE characters
SET status = 'archived',
    updated_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE creation_origin = 'demo' AND status <> 'archived';
