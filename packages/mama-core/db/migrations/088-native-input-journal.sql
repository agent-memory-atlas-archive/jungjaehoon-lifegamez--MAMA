-- Native input facts are separate from both work judgments and external effects.
CREATE TABLE IF NOT EXISTS native_input_deliveries (
  input_id INTEGER PRIMARY KEY REFERENCES mailbox_inputs(id) ON DELETE CASCADE,
  invocation_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('prepared','dispatching','accepted','settled','uncertain')),
  dispatch_json TEXT,
  receipt_json TEXT,
  error TEXT,
  updated_at INTEGER NOT NULL
);
-- Earlier claims did not record whether native execution had begun. Do not replay them on a guess.
INSERT OR IGNORE INTO native_input_deliveries (input_id, state, error, updated_at)
  SELECT id, 'uncertain', 'Legacy input has no native dispatch record', created_at
  FROM mailbox_inputs WHERE status = 'claimed' OR (status = 'pending' AND attempts > 0);
