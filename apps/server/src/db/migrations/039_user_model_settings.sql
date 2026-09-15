CREATE TABLE user_model_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  onboarding_completed INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_completed IN (0, 1)),
  bindings_json TEXT NOT NULL DEFAULT '{}',
  image_selection_json TEXT,
  updated_at_utc TEXT NOT NULL
);
