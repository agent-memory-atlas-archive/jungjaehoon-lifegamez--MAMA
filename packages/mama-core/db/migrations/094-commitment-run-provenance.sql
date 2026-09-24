-- A commitment's current head and each historical revision retain the run and
-- agent that authored them. Existing rows remain unknown; do not infer origins.
ALTER TABLE commitments ADD COLUMN agent_id TEXT;
ALTER TABLE commitments ADD COLUMN model_run_id TEXT;
ALTER TABLE commitment_assignments ADD COLUMN agent_id TEXT;
ALTER TABLE commitment_assignments ADD COLUMN model_run_id TEXT;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (94, 'Commitment run and agent provenance');
