CREATE TABLE IF NOT EXISTS correspondence_key_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  fingerprint_version INTEGER NOT NULL CHECK (fingerprint_version = 1),
  fingerprint TEXT NOT NULL CHECK (
    length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  key_version INTEGER NOT NULL CHECK (key_version = 1),
  created_at_utc TEXT NOT NULL
);

CREATE TRIGGER IF NOT EXISTS correspondence_key_metadata_immutable
BEFORE UPDATE ON correspondence_key_metadata
BEGIN
  SELECT RAISE(ABORT, 'correspondence key metadata is immutable');
END;

CREATE TRIGGER IF NOT EXISTS correspondence_key_metadata_protect_delete
BEFORE DELETE ON correspondence_key_metadata
BEGIN
  SELECT RAISE(ABORT, 'correspondence key metadata cannot be deleted');
END;
