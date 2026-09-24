-- The reply owner may be a background input, not a messenger message. Preserve
-- the producer-stated kind beyond mailbox pruning so recovery never invents a
-- Telegram shared-reply target from a source delta or scheduled turn.
ALTER TABLE native_turn_results ADD COLUMN primary_kind TEXT
  CHECK (primary_kind IS NULL OR primary_kind IN
    ('owner_message', 'source_delta', 'scheduled', 'native_event'));

UPDATE native_turn_results
SET primary_kind = (
  SELECT m.kind FROM mailbox_inputs m
  WHERE m.stimulus_id = native_turn_results.primary_stimulus_id
    AND m.principal_id = native_turn_results.principal_id
  ORDER BY m.id ASC LIMIT 1
);
