-- Consumer-owned input data. NULL denotes an old input with no preserved payload;
-- a JSON null is the text 'null'. Never reconstruct missing data from a preview.
ALTER TABLE mailbox_inputs ADD COLUMN payload_json TEXT;
CREATE INDEX IF NOT EXISTS idx_mailbox_inputs_identity
  ON mailbox_inputs(principal_id, stimulus_id);
