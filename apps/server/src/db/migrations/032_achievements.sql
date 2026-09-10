-- Achievement facts are committed by the same SQLite transaction as their
-- source. Definitions stay server-side; public APIs expose unlocked mementos.
CREATE TABLE achievement_definitions (
  key TEXT PRIMARY KEY,
  category TEXT NOT NULL CHECK(category IN ('global','character')),
  trigger_kind TEXT NOT NULL,
  threshold REAL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  badge_key TEXT NOT NULL,
  generated INTEGER NOT NULL DEFAULT 0 CHECK(generated IN (0,1))
);
INSERT INTO achievement_definitions VALUES
 ('visit.1','global','visit',1,'初来乍到','你第一次推开了这里的门。','door',0),
 ('visit.3','global','visit',3,'三日之约','连续三天，你都来过这里。','sprout',0),
 ('visit.7','global','visit',7,'一周相伴','七个连续的日子，留下了你的足迹。','sun',0),
 ('visit.30','global','visit',30,'日常有你','连续三十天，小小的相聚成了日常。','calendar',0),
 ('visit.120','global','visit',120,'长久的回响','一百二十个连续的日子，值得好好珍藏。','tree',0),
 ('visit.365','global','visit',365,'岁岁相伴','连续三百六十五天，又走过一个四季。','orbit',0),
 ('first.character','global','character.published',NULL,'故事的开端','你亲手创造的角色，开始了自己的故事。','quill',0),
 ('first.message','global','conversation.turn_committed',NULL,'第一声问候','你说出的第一句话，得到了回应。','message',0),
 ('first.letter.sent','global','letter.sent',NULL,'见字如面','你将第一封信，交给了时间。','envelope',0),
 ('first.letter.received','global','letter.received',NULL,'远方回音','第一封来信，终于抵达你的身边。','mailbox',0),
 ('first.letter.opened','global','letter.opened',NULL,'亲手启封','你亲手拆开了第一封来信。','letter',0),
 ('relationship.30','character','relationship',0.3,'一些日常','有些平常的时刻，留在了你们之间。','leaf',0),
 ('relationship.50','character','relationship',0.5,'渐成回响','你来过的痕迹，渐渐有了回响。','echo',0),
 ('relationship.70','character','relationship',0.7,'岁月留痕','共同走过的日子，留下了一份纪念。','flower',0),
 ('relationship.90','character','relationship',0.9,'独一份纪念','这一份纪念，只属于你们的故事。','star',1),
 ('relationship.100','character','relationship',1.0,'珍藏此刻','把这个值得珍藏的时刻，留在这里。','constellation',1);

CREATE TABLE achievement_activity_days (
  user_id TEXT NOT NULL DEFAULT 'local-user',
  local_date TEXT NOT NULL,
  first_seen_at_utc TEXT NOT NULL,
  PRIMARY KEY(user_id,local_date)
);
CREATE TABLE achievement_unlocks (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE DEFAULT ('achievement_' || lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL DEFAULT 'local-user',
  definition_key TEXT NOT NULL REFERENCES achievement_definitions(key),
  scope_key TEXT NOT NULL,
  agent_id TEXT,
  agent_name TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  badge_key TEXT NOT NULL,
  unlocked_at_utc TEXT NOT NULL,
  recorded_at_utc TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(evidence_json)),
  notification_read_at_utc TEXT,
  UNIQUE(user_id,definition_key,scope_key)
);
CREATE INDEX achievement_unlocks_agent_idx ON achievement_unlocks(agent_id,sequence DESC);

-- Snapshot visual traits at the first custom memento, so later edits cannot
-- silently change the visual family. Deliberately no source text or messages.
CREATE TABLE achievement_visual_profiles (
  agent_id TEXT PRIMARY KEY,
  profile_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);
CREATE TABLE achievement_badge_jobs (
  achievement_id TEXT PRIMARY KEY REFERENCES achievement_unlocks(id) ON DELETE CASCADE,
  visual_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','generating','ready','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at_utc TEXT NOT NULL,
  claim_token TEXT,
  lease_until_utc TEXT,
  error_code TEXT,
  provider TEXT,
  model TEXT,
  request_id TEXT,
  storage_key TEXT,
  thumbnail_storage_key TEXT,
  sha256 TEXT,
  updated_at_utc TEXT NOT NULL
);
CREATE TABLE achievement_image_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  protocol TEXT NOT NULL DEFAULT 'openai-compatible',
  base_url TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  credential_json TEXT
);
INSERT INTO achievement_image_settings(id) VALUES(1);
CREATE TABLE achievement_revision (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO achievement_revision VALUES(1,0);

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
  INSERT OR IGNORE INTO achievement_badge_jobs(achievement_id,next_attempt_at_utc,updated_at_utc)
  SELECT NEW.id,NEW.recorded_at_utc,NEW.recorded_at_utc
  FROM achievement_definitions WHERE key=NEW.definition_key AND generated=1;
END;
CREATE TRIGGER achievement_unlock_read AFTER UPDATE OF notification_read_at_utc ON achievement_unlocks BEGIN
  UPDATE achievement_revision SET revision=revision+1 WHERE id=1;
END;
CREATE TRIGGER achievement_badge_changed AFTER UPDATE ON achievement_badge_jobs BEGIN
  UPDATE achievement_revision SET revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER achievement_domain_fact AFTER INSERT ON domain_events
WHEN NEW.event_type IN ('character.published','conversation.turn_committed') BEGIN
  INSERT OR IGNORE INTO achievement_unlocks(
    definition_key,scope_key,agent_id,agent_name,title,description,category,badge_key,
    unlocked_at_utc,recorded_at_utc,evidence_kind,evidence_id)
  SELECT d.key,'global',c.id,c.name,d.title,d.description,d.category,d.badge_key,
    NEW.effective_at_utc,NEW.recorded_at_utc,'domain_event',NEW.id
  FROM achievement_definitions d JOIN characters c ON c.id=NEW.agent_id
  WHERE d.trigger_kind=NEW.event_type
    AND (NEW.event_type<>'character.published' OR c.creation_origin='user');
END;

CREATE TRIGGER achievement_relationship_fact AFTER UPDATE OF state_json ON runtime_states BEGIN
  INSERT OR IGNORE INTO achievement_unlocks(
    definition_key,scope_key,agent_id,agent_name,title,description,category,badge_key,
    unlocked_at_utc,recorded_at_utc,evidence_kind,evidence_id,evidence_json)
  SELECT d.key,c.id,c.id,c.name,d.title,d.description,d.category,d.badge_key,
    NEW.updated_at_utc,NEW.updated_at_utc,'runtime_state',c.id || ':' || NEW.revision,
    json_object('beforeCloseness',json_extract(OLD.state_json,'$.relationship.closeness'),
      'afterCloseness',json_extract(NEW.state_json,'$.relationship.closeness'),
      'threshold',d.threshold,'revision',NEW.revision)
  FROM achievement_definitions d JOIN characters c ON c.id=NEW.agent_id
  WHERE d.trigger_kind='relationship' AND c.tier<>'lightweight'
    AND json_extract(OLD.state_json,'$.relationship.closeness') < d.threshold
    AND json_extract(NEW.state_json,'$.relationship.closeness') >= d.threshold;
END;

CREATE TRIGGER achievement_letter_sent AFTER UPDATE OF dispatched_at_utc ON letters
WHEN NEW.direction='user_to_agent' AND OLD.dispatched_at_utc IS NULL AND NEW.dispatched_at_utc IS NOT NULL BEGIN
  INSERT OR IGNORE INTO achievement_unlocks(
    definition_key,scope_key,agent_id,agent_name,title,description,category,badge_key,
    unlocked_at_utc,recorded_at_utc,evidence_kind,evidence_id)
  SELECT d.key,'global',c.id,c.name,d.title,d.description,d.category,d.badge_key,
    NEW.dispatched_at_utc,NEW.dispatched_at_utc,'letter',NEW.id
  FROM achievement_definitions d JOIN characters c ON c.id=NEW.agent_id WHERE d.trigger_kind='letter.sent';
END;
CREATE TRIGGER achievement_letter_received AFTER UPDATE OF delivered_effective_at_utc ON letters
WHEN NEW.direction='agent_to_user' AND OLD.delivered_effective_at_utc IS NULL AND NEW.delivered_effective_at_utc IS NOT NULL BEGIN
  INSERT OR IGNORE INTO achievement_unlocks(
    definition_key,scope_key,agent_id,agent_name,title,description,category,badge_key,
    unlocked_at_utc,recorded_at_utc,evidence_kind,evidence_id)
  SELECT d.key,'global',c.id,c.name,d.title,d.description,d.category,d.badge_key,
    NEW.delivered_effective_at_utc,COALESCE(NEW.processed_at_utc,NEW.delivered_effective_at_utc),'letter',NEW.id
  FROM achievement_definitions d JOIN characters c ON c.id=NEW.agent_id WHERE d.trigger_kind='letter.received';
END;
CREATE TRIGGER achievement_letter_opened AFTER UPDATE OF opened_at_utc ON letters
WHEN NEW.direction='agent_to_user' AND OLD.opened_at_utc IS NULL AND NEW.opened_at_utc IS NOT NULL BEGIN
  INSERT OR IGNORE INTO achievement_unlocks(
    definition_key,scope_key,agent_id,agent_name,title,description,category,badge_key,
    unlocked_at_utc,recorded_at_utc,evidence_kind,evidence_id)
  SELECT d.key,'global',c.id,c.name,d.title,d.description,d.category,d.badge_key,
    NEW.opened_at_utc,NEW.opened_at_utc,'letter',NEW.id
  FROM achievement_definitions d JOIN characters c ON c.id=NEW.agent_id WHERE d.trigger_kind='letter.opened';
END;
