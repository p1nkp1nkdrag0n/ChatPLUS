-- Reclassify the known old extractor's impossible item and ongoing-action
-- projections. Keep content and evidence for audit. Existing validity triggers
-- invalidate dependent cards/autobiography and advance the recall revision.
UPDATE memories SET status = 'needs_review',
  lifecycle_updated_at_utc = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  memory_json = CASE WHEN memory_json IS NULL THEN NULL ELSE
    json_set(memory_json, '$.status', 'needs_review',
      '$.lifecycleUpdatedAtUtc', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) END
WHERE status IN ('active', 'aging')
  AND claim_subject_key IN ('user_fact:item:也:storage', 'user_fact:item:我也:storage');
