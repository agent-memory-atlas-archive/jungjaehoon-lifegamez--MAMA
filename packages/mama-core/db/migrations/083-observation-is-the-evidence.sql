-- An observation becomes the whole evidence record, and stops naming a connector.
--
-- Migration 030 built `connector_event_index` as the memory substrate, because at
-- the time the only producer of evidence was a connector. Migration 072 introduced
-- the neutral primitive, `observation_versions`, but attached it as a satellite --
-- `connector_event_index.current_observation_id` -- and left the old table as the
-- entry point. The foreign key has pointed the right way ever since; the reads did
-- not follow it.
--
-- Two things change here, both so the reads can. The observation gains the evidence
-- columns that only lived on the connector index, and the scope it carries as one
-- JSON blob becomes columns a visibility filter can index. What stays behind on
-- that index is what a polling loop needs to know about itself -- cursors,
-- sequences, sweep times -- which is the connector framework's business and not the
-- core's.
--
-- The column that named a connector is now `source`: the pair is (namespace,
-- id-within-it), the same shape as source_id/source_at/source_locator beside it. A
-- deployment with no connectors still has observations. That rename is made in 072
-- itself rather than here, because the driver carries its own copy of this table's
-- schema and rebuilds the table when the two disagree -- so a rename applied after
-- the fact is undone before the next statement runs. Editing a shipped migration is
-- only available because this store holds test data; see the owner's note that
-- MAMA is a testbed and kagemusha keeps the real corpus.

-- Evidence the connector index held alone. All of it describes what was observed.
ALTER TABLE observation_versions ADD COLUMN source_type TEXT;
ALTER TABLE observation_versions ADD COLUMN source_locator TEXT;
ALTER TABLE observation_versions ADD COLUMN title TEXT;
ALTER TABLE observation_versions ADD COLUMN artifact_locator TEXT;
ALTER TABLE observation_versions ADD COLUMN artifact_title TEXT;
ALTER TABLE observation_versions ADD COLUMN event_date TEXT;
ALTER TABLE observation_versions ADD COLUMN source_entity_id TEXT;

-- Scope out of the JSON blob. Raw visibility is decided against these four, and a
-- filter that cannot reach a column cannot be a WHERE clause.
ALTER TABLE observation_versions ADD COLUMN channel TEXT;
ALTER TABLE observation_versions ADD COLUMN project_id TEXT;
ALTER TABLE observation_versions ADD COLUMN tenant_id TEXT;
ALTER TABLE observation_versions ADD COLUMN memory_scope_kind TEXT;
ALTER TABLE observation_versions ADD COLUMN memory_scope_id TEXT;

CREATE INDEX IF NOT EXISTS idx_observation_visibility
  ON observation_versions(source, channel, project_id, tenant_id);
CREATE INDEX IF NOT EXISTS idx_observation_artifact
  ON observation_versions(artifact_locator);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (83, 'An observation is the whole evidence record and names no connector');
