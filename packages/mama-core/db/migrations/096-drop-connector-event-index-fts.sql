-- Stored source search scans literal substrings in connector_event_index.
-- Other core consumers never created this product index, so absence is expected.
DROP TRIGGER IF EXISTS trg_connector_event_index_ai;
DROP TRIGGER IF EXISTS trg_connector_event_index_au;
DROP TRIGGER IF EXISTS trg_connector_event_index_ad;
DROP TABLE IF EXISTS connector_event_index_fts;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (96, 'Drop the unused connector event full-text index');
