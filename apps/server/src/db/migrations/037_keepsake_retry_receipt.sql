-- Waiting for another image attempt keeps the received base artifact pending.
-- A terminal image failure remains failed, without revoking the gift.
DROP TRIGGER keepsakes_valid_status_transition;

UPDATE keepsakes
SET status = 'pending'
WHERE status = 'failed' AND EXISTS (
  SELECT 1 FROM temporal_tasks task
  WHERE task.entity_id = keepsakes.id AND task.kind = 'keepsake.generate'
    AND task.status = 'retryable'
);

-- Prior versions delivered image assets independently from opening a letter.
-- Recover gifts from already-open replies even if an image never completed.
-- The existing event key keeps recovery idempotent across older ready rows.
UPDATE keepsakes
SET given_to = NULL, gifted_at_utc = NULL
WHERE gifted_at_utc IS NOT NULL AND EXISTS (
  SELECT 1 FROM keepsake_letter_links link
  JOIN letters reply ON reply.id = link.reply_letter_id
  WHERE link.keepsake_id = keepsakes.id
    AND (reply.status <> 'read' OR reply.opened_at_utc IS NULL)
);

UPDATE keepsakes
SET gifted_at_utc = (
      SELECT MAX(keepsakes.created_at_utc, reply.opened_at_utc)
      FROM keepsake_letter_links link
      JOIN letters reply ON reply.id = link.reply_letter_id
      WHERE link.keepsake_id = keepsakes.id
    ),
    updated_at_utc = MAX(updated_at_utc, (
      SELECT reply.opened_at_utc FROM keepsake_letter_links link
      JOIN letters reply ON reply.id = link.reply_letter_id
      WHERE link.keepsake_id = keepsakes.id
    ))
WHERE gifted_at_utc IS NOT NULL AND EXISTS (
  SELECT 1 FROM keepsake_letter_links link
  JOIN letters reply ON reply.id = link.reply_letter_id
  WHERE link.keepsake_id = keepsakes.id AND reply.status = 'read'
    AND reply.opened_at_utc IS NOT NULL AND keepsakes.gifted_at_utc < reply.opened_at_utc
);

INSERT OR IGNORE INTO domain_events(
  id, agent_id, stream_type, stream_id, stream_version, event_type,
  recorded_at_utc, effective_at_utc, payload_json,
  correlation_id, causation_id, idempotency_key
)
SELECT 'event_' || lower(hex(randomblob(16))), keepsake.agent_id,
  'keepsake', keepsake.id,
  (SELECT COALESCE(MAX(event.stream_version), 0) + 1 FROM domain_events event
    WHERE event.stream_type = 'keepsake' AND event.stream_id = keepsake.id),
  'keepsake.created',
  MAX(keepsake.updated_at_utc, reply.opened_at_utc),
  MAX(keepsake.created_at_utc, reply.opened_at_utc),
  json_object('keepsakeId', keepsake.id, 'sourceIds',
    json((SELECT json_group_array(value) FROM (
      SELECT value FROM json_each(keepsake.source_event_ids_json)
      UNION ALL SELECT value FROM json_each(keepsake.source_memory_ids_json)
      UNION ALL SELECT value FROM json_each(keepsake.source_letter_ids_json)
    )))),
  keepsake.id, keepsake.id, 'keepsake-created:' || keepsake.id || ':v1'
FROM keepsakes keepsake
JOIN keepsake_letter_links link ON link.keepsake_id = keepsake.id
JOIN letters reply ON reply.id = link.reply_letter_id
WHERE keepsake.gifted_at_utc IS NULL
  AND reply.direction = 'agent_to_user' AND reply.status = 'read'
  AND reply.opened_at_utc IS NOT NULL;

UPDATE keepsakes
SET given_to = 'user',
    gifted_at_utc = MAX(created_at_utc, (
      SELECT reply.opened_at_utc FROM keepsake_letter_links link
      JOIN letters reply ON reply.id = link.reply_letter_id
      WHERE link.keepsake_id = keepsakes.id
    )),
    updated_at_utc = MAX(updated_at_utc, (
      SELECT reply.opened_at_utc FROM keepsake_letter_links link
      JOIN letters reply ON reply.id = link.reply_letter_id
      WHERE link.keepsake_id = keepsakes.id
    ))
WHERE gifted_at_utc IS NULL AND EXISTS (
  SELECT 1 FROM keepsake_letter_links link
  JOIN letters reply ON reply.id = link.reply_letter_id
  WHERE link.keepsake_id = keepsakes.id AND reply.direction = 'agent_to_user'
    AND reply.status = 'read' AND reply.opened_at_utc IS NOT NULL
);

CREATE TRIGGER keepsakes_valid_status_transition
BEFORE UPDATE OF status ON keepsakes
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('generating', 'failed'))
  OR (OLD.status = 'generating' AND NEW.status IN ('pending', 'ready', 'failed'))
  OR (OLD.status = 'failed' AND NEW.status = 'generating')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid keepsake status transition');
END;
