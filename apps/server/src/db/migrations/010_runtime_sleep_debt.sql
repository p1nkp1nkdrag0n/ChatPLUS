ALTER TABLE runtime_states ADD COLUMN sleep_debt_minutes INTEGER NOT NULL DEFAULT 0
  CHECK (sleep_debt_minutes BETWEEN 0 AND 720);
