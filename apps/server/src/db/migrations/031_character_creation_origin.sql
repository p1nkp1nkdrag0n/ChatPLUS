ALTER TABLE characters ADD COLUMN creation_origin TEXT NOT NULL DEFAULT 'user'
  CHECK (creation_origin IN ('user', 'demo'));

UPDATE characters SET creation_origin = 'demo'
WHERE id IN (SELECT character_id FROM demo_conversations);
