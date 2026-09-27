-- A model run's first accepted input names its native turn. Every later steer
-- shares that turn receipt, so membership is projected from the durable journal
-- instead of copied into a second queue or fabricated for historical runs.
CREATE INDEX IF NOT EXISTS idx_mailbox_inputs_identity
  ON mailbox_inputs(principal_id, stimulus_id);

CREATE VIEW IF NOT EXISTS model_run_native_inputs AS
SELECT
  mr.model_run_id,
  child.id AS input_id,
  child.stimulus_id,
  child.kind,
  child.principal_id,
  child.channel_key,
  child.occurred_at,
  child.status,
  child_delivery.state AS native_state
FROM model_runs mr
JOIN mailbox_inputs root
  ON root.stimulus_id = CASE WHEN json_valid(mr.input_refs_json)
    THEN json_extract(mr.input_refs_json, '$.sourceMessageRef') ELSE NULL END
 AND root.principal_id = CASE WHEN json_valid(mr.input_refs_json)
    THEN json_extract(mr.input_refs_json, '$.principalId') ELSE NULL END
JOIN native_input_deliveries root_delivery
  ON root_delivery.input_id = root.id AND root_delivery.receipt_json IS NOT NULL
JOIN native_input_deliveries child_delivery
  ON child_delivery.receipt_json = root_delivery.receipt_json
JOIN mailbox_inputs child
  ON child.id = child_delivery.input_id AND child.principal_id = root.principal_id;
