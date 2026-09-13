-- Retrieval runs are replay diagnostics, not the source of message or memory
-- truth. Permit bounded retention while keeping existing rows update-immutable.
-- No historical data is deleted by the migration itself.
DROP TRIGGER IF EXISTS retrieval_runs_immutable_delete;
