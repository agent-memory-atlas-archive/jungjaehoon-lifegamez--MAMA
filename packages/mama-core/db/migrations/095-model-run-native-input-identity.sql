-- A model run's native invocation ID is the core-owned identity of its first
-- accepted input. sourceMessageRef may be a product effect occurrence, not the
-- mailbox stimulus ID. Preserve the old ref join only for historical rows that
-- predate nativeInputId; never fall back from a stated but unmatched native ID.
DROP VIEW IF EXISTS model_run_native_inputs;
CREATE VIEW model_run_native_inputs AS
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
JOIN native_input_deliveries root_delivery
  ON root_delivery.input_id = CASE WHEN json_valid(mr.input_refs_json) THEN
    CASE WHEN json_type(mr.input_refs_json, '$.nativeInputId') IS NOT NULL THEN
      (SELECT input_id FROM native_input_deliveries
       WHERE invocation_id = json_extract(mr.input_refs_json, '$.nativeInputId'))
    ELSE
      (SELECT id FROM mailbox_inputs
       WHERE principal_id = json_extract(mr.input_refs_json, '$.principalId')
         AND stimulus_id = json_extract(mr.input_refs_json, '$.sourceMessageRef'))
    END
  ELSE NULL END
 AND root_delivery.receipt_json IS NOT NULL
JOIN mailbox_inputs root
  ON root.id = root_delivery.input_id
 AND root.principal_id = json_extract(mr.input_refs_json, '$.principalId')
JOIN native_input_deliveries child_delivery
  ON child_delivery.receipt_json = root_delivery.receipt_json
JOIN mailbox_inputs child
  ON child.id = child_delivery.input_id AND child.principal_id = root.principal_id;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (95, 'Model-run cohort follows accepted native input identity');
