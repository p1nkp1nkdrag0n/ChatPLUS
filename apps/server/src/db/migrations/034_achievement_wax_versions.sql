-- Historical image bytes are content-addressed and retained independently of
-- the next drawing's status. Migration only records existing files; no redraw.
CREATE TABLE achievement_badge_versions (
  achievement_id TEXT NOT NULL REFERENCES achievement_unlocks(id) ON DELETE CASCADE,
  sha256 TEXT NOT NULL,
  visual_version INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  thumbnail_storage_key TEXT NOT NULL,
  thumbnail_sha256 TEXT,
  visual_spec_json TEXT CHECK(visual_spec_json IS NULL OR json_valid(visual_spec_json)),
  provider TEXT,
  model TEXT,
  request_id TEXT,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY(achievement_id,sha256)
);
INSERT INTO achievement_badge_versions(
  achievement_id,sha256,visual_version,storage_key,thumbnail_storage_key,
  provider,model,request_id,created_at_utc)
SELECT achievement_id,sha256,visual_version,storage_key,thumbnail_storage_key,
  provider,model,request_id,updated_at_utc FROM achievement_badge_jobs
WHERE storage_key IS NOT NULL AND thumbnail_storage_key IS NOT NULL AND sha256 IS NOT NULL;
CREATE TRIGGER achievement_badge_version_immutable BEFORE UPDATE ON achievement_badge_versions BEGIN
  SELECT RAISE(ABORT,'Achievement image history is immutable');
END;

-- New unlocks explicitly request wax v2. Existing in-flight jobs keep their
-- original version until a deliberate administrator repaint command.
DROP TRIGGER achievement_unlock_created;
CREATE TRIGGER achievement_unlock_created AFTER INSERT ON achievement_unlocks BEGIN
  UPDATE achievement_revision SET revision=revision+1 WHERE id=1;
  INSERT OR IGNORE INTO achievement_visual_profiles(agent_id,profile_json,created_at_utc)
  SELECT NEW.agent_id,
    json_object(
      'name',json_extract(v.spec_json,'$.identity.name'),
      'role',substr(COALESCE(json_extract(v.spec_json,'$.identity.workOrRole'),''),1,200),
      'setting',substr(COALESCE(json_extract(v.spec_json,'$.identity.worldSetting'),''),1,500),
      'traits',json(COALESCE((
        SELECT json_group_array(json_object('name',substr(json_extract(trait.value,'$.name'),1,200)))
        FROM json_each(v.spec_json,'$.persona.traits') trait WHERE CAST(trait.key AS INTEGER)<4
      ),'[]')),
      'appearance',substr(COALESCE(json_extract(v.spec_json,'$.identity.appearance.summary'),''),1,300)
    ), NEW.recorded_at_utc
  FROM characters c JOIN character_versions v ON v.character_id=c.id
    AND v.version=(SELECT max(p.version) FROM character_versions p WHERE p.character_id=c.id AND p.status='published')
  WHERE c.id=NEW.agent_id AND EXISTS(SELECT 1 FROM achievement_definitions WHERE key=NEW.definition_key AND generated=1);
  INSERT OR IGNORE INTO achievement_badge_jobs(achievement_id,visual_version,next_attempt_at_utc,updated_at_utc)
  SELECT NEW.id,2,NEW.recorded_at_utc,NEW.recorded_at_utc
  FROM achievement_definitions WHERE key=NEW.definition_key AND generated=1;
END;
