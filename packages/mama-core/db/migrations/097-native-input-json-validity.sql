-- Each JSON expression must be guarded independently: SQLite may reorder joins.
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
 AND root.principal_id = CASE WHEN json_valid(mr.input_refs_json)
   THEN json_extract(mr.input_refs_json, '$.principalId') ELSE NULL END
JOIN native_input_deliveries child_delivery
  ON child_delivery.receipt_json = root_delivery.receipt_json
JOIN mailbox_inputs child
  ON child.id = child_delivery.input_id AND child.principal_id = root.principal_id;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (97, 'Guard native input view joins against malformed historical JSON');
