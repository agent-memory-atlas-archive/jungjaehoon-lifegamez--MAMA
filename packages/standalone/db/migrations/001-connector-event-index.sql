-- The connector event index, declared by the package that has connectors.
--
-- It was declared by the core, across seven core migrations, because a migration's
-- identity was a bare version number and no other author could pick one. So every
-- consumer of the core created these tables: the Claude plugin's live database
-- holds eighteen of them and zero rows, and so does the MCP server's.
--
-- Three of the four consumers have no connectors. This is the one that does.
--
-- Declared whole rather than as a chain of seven, because it is being declared
-- for the first time under this source. The statements are the schema those seven
-- produced, read back from a built database rather than transcribed.

CREATE TABLE connector_event_index (
  event_index_id TEXT PRIMARY KEY,
  source_connector TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_locator TEXT,
  channel TEXT,
  author TEXT,
  title TEXT,
  content TEXT NOT NULL,
  event_datetime INTEGER,
  event_date TEXT,
  source_timestamp_ms INTEGER NOT NULL,
  metadata_json TEXT,
  artifact_locator TEXT,
  artifact_title TEXT,
  content_hash BLOB NOT NULL CHECK(length(content_hash) = 32),
  indexed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT
, source_cursor TEXT, tenant_id TEXT, project_id TEXT, memory_scope_kind TEXT, memory_scope_id TEXT, operator_ingest_seq INTEGER CHECK (
    operator_ingest_seq IS NULL OR operator_ingest_seq >= 1
  ), operator_observation_seq INTEGER CHECK (
    operator_observation_seq IS NULL OR operator_observation_seq >= 1
  ), source_entity_id TEXT, current_observation_id TEXT REFERENCES observation_versions(observation_id));

CREATE TABLE connector_event_index_cursors (
  connector_name TEXT PRIMARY KEY,
  last_seen_timestamp_ms INTEGER NOT NULL DEFAULT 0,
  last_seen_source_id TEXT NOT NULL DEFAULT '',
  last_sweep_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  last_error_at TEXT,
  indexed_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE connector_event_index_observation_cursors (
  source_connector TEXT PRIMARY KEY,
  next_seq INTEGER NOT NULL CHECK (next_seq >= 1)
);

CREATE TABLE connector_event_index_operator_seq_cursors (
  source_connector TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT '',
  next_seq INTEGER NOT NULL CHECK (next_seq >= 1),
  PRIMARY KEY (source_connector, channel)
);

CREATE INDEX idx_connector_event_index_artifact_locator
  ON connector_event_index(artifact_locator)
  WHERE artifact_locator IS NOT NULL;

CREATE INDEX idx_connector_event_index_cursor_order
  ON connector_event_index(source_connector, source_timestamp_ms, source_id);

CREATE INDEX idx_connector_event_index_event_date
  ON connector_event_index(event_date, event_datetime, event_index_id);

CREATE INDEX idx_connector_event_index_event_datetime
  ON connector_event_index(event_datetime, event_index_id);

CREATE INDEX idx_connector_event_index_expires_at
  ON connector_event_index(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE UNIQUE INDEX idx_connector_event_index_observation_seq
  ON connector_event_index(source_connector, operator_observation_seq)
  WHERE operator_observation_seq IS NOT NULL;

CREATE INDEX idx_connector_event_index_operator_cursor_order
  ON connector_event_index(source_connector, channel, operator_ingest_seq);

CREATE UNIQUE INDEX idx_connector_event_index_operator_scope_seq
  ON connector_event_index(source_connector, COALESCE(channel, ''), operator_ingest_seq)
  WHERE operator_ingest_seq IS NOT NULL;

CREATE UNIQUE INDEX idx_connector_event_index_source_identity
  ON connector_event_index(source_connector, source_id);

CREATE INDEX idx_connector_event_scope
  ON connector_event_index(tenant_id, project_id, memory_scope_kind, memory_scope_id);

CREATE INDEX idx_connector_event_source_cursor
  ON connector_event_index(source_connector, source_cursor);

CREATE INDEX idx_connector_event_source_entity
  ON connector_event_index(source_connector, source_entity_id);

CREATE TRIGGER trg_connector_event_index_legacy_content_refresh_au
AFTER UPDATE OF content_hash, metadata_json, source_timestamp_ms, source_type, channel
ON connector_event_index
WHEN (
  OLD.content_hash IS NOT NEW.content_hash
  OR OLD.metadata_json IS NOT NEW.metadata_json
  OR OLD.source_timestamp_ms IS NOT NEW.source_timestamp_ms
  OR OLD.source_type IS NOT NEW.source_type
  OR OLD.channel IS NOT NEW.channel
) AND (
  NEW.operator_ingest_seq IS OLD.operator_ingest_seq
  OR NEW.operator_observation_seq IS OLD.operator_observation_seq
)
BEGIN
  UPDATE connector_event_index
  SET operator_ingest_seq = CASE
        WHEN NEW.operator_ingest_seq IS OLD.operator_ingest_seq THEN NULL
        ELSE NEW.operator_ingest_seq
      END,
      operator_observation_seq = CASE
        WHEN NEW.operator_observation_seq IS OLD.operator_observation_seq THEN NULL
        ELSE NEW.operator_observation_seq
      END
  WHERE event_index_id = NEW.event_index_id;
END;

CREATE TRIGGER trg_connector_event_index_observation_seq_ai
AFTER INSERT ON connector_event_index
WHEN NEW.operator_observation_seq IS NULL
BEGIN
  INSERT INTO connector_event_index_observation_cursors
    (source_connector, next_seq)
  VALUES (NEW.source_connector, 1)
  ON CONFLICT(source_connector) DO NOTHING;
  UPDATE connector_event_index
  SET operator_observation_seq = (
    SELECT next_seq FROM connector_event_index_observation_cursors
    WHERE source_connector = NEW.source_connector
  )
  WHERE event_index_id = NEW.event_index_id;
  UPDATE connector_event_index_observation_cursors
  SET next_seq = next_seq + 1
  WHERE source_connector = NEW.source_connector;
END;

CREATE TRIGGER trg_connector_event_index_observation_seq_au
AFTER UPDATE OF operator_observation_seq ON connector_event_index
WHEN NEW.operator_observation_seq IS NULL AND OLD.operator_observation_seq IS NOT NULL
BEGIN
  INSERT INTO connector_event_index_observation_cursors
    (source_connector, next_seq)
  VALUES (NEW.source_connector, 1)
  ON CONFLICT(source_connector) DO NOTHING;
  UPDATE connector_event_index
  SET operator_observation_seq = (
    SELECT next_seq FROM connector_event_index_observation_cursors
    WHERE source_connector = NEW.source_connector
  )
  WHERE event_index_id = NEW.event_index_id;
  UPDATE connector_event_index_observation_cursors
  SET next_seq = next_seq + 1
  WHERE source_connector = NEW.source_connector;
END;

CREATE TRIGGER trg_connector_event_index_observation_seq_explicit_ai
AFTER INSERT ON connector_event_index
WHEN NEW.operator_observation_seq IS NOT NULL
BEGIN
  INSERT INTO connector_event_index_observation_cursors
    (source_connector, next_seq)
  VALUES (NEW.source_connector, 1)
  ON CONFLICT(source_connector) DO NOTHING;
  UPDATE connector_event_index_observation_cursors
  SET next_seq = CASE
    WHEN next_seq <= NEW.operator_observation_seq THEN NEW.operator_observation_seq + 1
    ELSE next_seq
  END
  WHERE source_connector = NEW.source_connector;
END;

CREATE TRIGGER trg_connector_event_index_operator_ingest_seq_ai
AFTER INSERT ON connector_event_index
WHEN NEW.operator_ingest_seq IS NULL
BEGIN
  INSERT OR IGNORE INTO connector_event_index_operator_seq_cursors (
    source_connector,
    channel,
    next_seq
  )
  VALUES (NEW.source_connector, COALESCE(NEW.channel, ''), 1);

UPDATE connector_event_index
  SET operator_ingest_seq = (
    SELECT next_seq
    FROM connector_event_index_operator_seq_cursors
    WHERE source_connector = NEW.source_connector
      AND channel = COALESCE(NEW.channel, '')
  )
  WHERE event_index_id = NEW.event_index_id;

UPDATE connector_event_index_operator_seq_cursors
  SET next_seq = next_seq + 1
  WHERE source_connector = NEW.source_connector
    AND channel = COALESCE(NEW.channel, '');
END;

CREATE TRIGGER trg_connector_event_index_operator_ingest_seq_au
AFTER UPDATE OF operator_ingest_seq ON connector_event_index
WHEN NEW.operator_ingest_seq IS NULL AND OLD.operator_ingest_seq IS NOT NULL
BEGIN
  INSERT INTO connector_event_index_operator_seq_cursors
    (source_connector, channel, next_seq)
  VALUES (NEW.source_connector, COALESCE(NEW.channel, ''), 1)
  ON CONFLICT(source_connector, channel) DO NOTHING;
  UPDATE connector_event_index
  SET operator_ingest_seq = (
    SELECT next_seq FROM connector_event_index_operator_seq_cursors
    WHERE source_connector = NEW.source_connector
      AND channel = COALESCE(NEW.channel, '')
  )
  WHERE event_index_id = NEW.event_index_id;
  UPDATE connector_event_index_operator_seq_cursors
  SET next_seq = next_seq + 1
  WHERE source_connector = NEW.source_connector
    AND channel = COALESCE(NEW.channel, '');
END;

CREATE TRIGGER trg_connector_event_index_operator_ingest_seq_explicit_ai
AFTER INSERT ON connector_event_index
WHEN NEW.operator_ingest_seq IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO connector_event_index_operator_seq_cursors (
    source_connector,
    channel,
    next_seq
  )
  VALUES (NEW.source_connector, COALESCE(NEW.channel, ''), 1);

UPDATE connector_event_index_operator_seq_cursors
  SET next_seq = CASE
    WHEN next_seq <= NEW.operator_ingest_seq THEN NEW.operator_ingest_seq + 1
    ELSE next_seq
  END
  WHERE source_connector = NEW.source_connector
    AND channel = COALESCE(NEW.channel, '');
END;

INSERT OR IGNORE INTO schema_version (source, version, description)
VALUES ('standalone', 1, 'The connector event index belongs to the package with connectors');
