-- One final native response belongs to the turn receipt, even when several
-- accepted mailbox inputs shared that turn. Keep it beyond mailbox pruning so
-- a later input can reconcile without replaying the model or external effects.
CREATE TABLE IF NOT EXISTS native_turn_results (
  receipt_json TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  primary_stimulus_id TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (receipt_json, principal_id)
);
