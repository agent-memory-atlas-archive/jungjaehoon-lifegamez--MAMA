-- One native turn may accept several independently journaled inputs.
CREATE INDEX IF NOT EXISTS idx_native_input_receipt_lookup
  ON native_input_deliveries(receipt_json, input_id);
