-- Immutable source observations. The current event index points at the exact captured version;
-- retention of the mutable index never deletes the historical observation.
CREATE TABLE IF NOT EXISTS observation_versions (
  observation_id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (length(trim(source)) > 0),
  source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
  producer_version_id TEXT,
  body TEXT,
  body_location_json TEXT,
  author TEXT,
  source_at INTEGER,
  observed_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL CHECK (length(trim(content_hash)) > 0),
  metadata_json TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  CHECK ((body IS NOT NULL AND body_location_json IS NULL)
      OR (body IS NULL AND body_location_json IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS observation_source_versions
  ON observation_versions(source, source_id, observed_at, observation_id);

-- `connector_event_index.current_observation_id` was added here. The index belongs
-- to the package that has connectors and declares that column itself; the core no
-- longer knows the table exists. The direction it records is unchanged, and it was
-- always the right one: the index points at the observation.

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (72, 'Immutable connector and owner observation versions');
