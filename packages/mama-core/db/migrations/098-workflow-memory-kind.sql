-- Workflow is a core memory kind. Rebuild the constrained projection while
-- retaining every column, rowid, index, and full-text index trigger.
DROP TABLE IF EXISTS decisions_w14;
CREATE TABLE decisions_w14 (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  decision TEXT NOT NULL,
  reasoning TEXT,
  outcome TEXT,
  failure_reason TEXT,
  limitation TEXT,
  user_involvement TEXT,
  session_id TEXT,
  supersedes TEXT,
  superseded_by TEXT,
  refined_from TEXT,
  confidence REAL DEFAULT 0.5 CHECK (confidence >= 0.0 AND confidence <= 1.0),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
  needs_validation INTEGER DEFAULT 0 CHECK (needs_validation IN (0, 1)),
  validation_attempts INTEGER DEFAULT 0,
  last_validated_at INTEGER,
  usage_count INTEGER DEFAULT 0,
  trust_context TEXT,
  usage_success INTEGER DEFAULT 0,
  usage_failure INTEGER DEFAULT 0,
  time_saved INTEGER DEFAULT 0,
  evidence TEXT,
  alternatives TEXT,
  risks TEXT,
  event_date TEXT,
  kind TEXT DEFAULT 'decision'
    CHECK (kind IN ('decision', 'preference', 'constraint', 'lesson', 'fact', 'task', 'schedule', 'workflow')),
  status TEXT DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'contradicted', 'stale')),
  summary TEXT,
  is_static INTEGER DEFAULT 0,
  event_datetime INTEGER,
  agent_id TEXT,
  model_run_id TEXT,
  envelope_hash TEXT,
  gateway_call_id TEXT,
  source_refs_json TEXT,
  provenance_json TEXT,
  item_id TEXT,
  record_kind TEXT NOT NULL DEFAULT 'legacy'
    CHECK (record_kind IN ('legacy', 'judgment', 'commitment')),
  payload_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(payload_json)),
  applies_from INTEGER,
  applies_until INTEGER,
  duration_days INTEGER
);

INSERT INTO decisions_w14 (
  rowid, id, topic, decision, reasoning, outcome, failure_reason, limitation,
  user_involvement, session_id, supersedes, superseded_by, refined_from, confidence,
  created_at, updated_at, needs_validation, validation_attempts, last_validated_at,
  usage_count, trust_context, usage_success, usage_failure, time_saved, evidence,
  alternatives, risks, event_date, kind, status, summary, is_static, event_datetime,
  agent_id, model_run_id, envelope_hash, gateway_call_id, source_refs_json,
  provenance_json, item_id, record_kind, payload_json, applies_from, applies_until,
  duration_days
)
SELECT
  rowid, id, topic, decision, reasoning, outcome, failure_reason, limitation,
  user_involvement, session_id, supersedes, superseded_by, refined_from, confidence,
  created_at, updated_at, needs_validation, validation_attempts, last_validated_at,
  usage_count, trust_context, usage_success, usage_failure, time_saved, evidence,
  alternatives, risks, event_date, kind, status, summary, is_static, event_datetime,
  agent_id, model_run_id, envelope_hash, gateway_call_id, source_refs_json,
  provenance_json, item_id, record_kind, payload_json, applies_from, applies_until,
  duration_days
FROM decisions;

DROP TABLE decisions;
ALTER TABLE decisions_w14 RENAME TO decisions;

CREATE INDEX idx_decisions_event_datetime ON decisions(event_datetime);
CREATE INDEX idx_decisions_event_datetime_backfill ON decisions(event_datetime);
CREATE INDEX idx_decisions_envelope_hash ON decisions(envelope_hash);
CREATE INDEX idx_decisions_model_run_id ON decisions(model_run_id);
CREATE INDEX idx_decisions_gateway_call_id ON decisions(gateway_call_id);
CREATE INDEX idx_decisions_item ON decisions(item_id);

CREATE TRIGGER decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, topic, decision, reasoning)
  VALUES (new.rowid, new.topic, new.decision, new.reasoning);
END;
CREATE TRIGGER decisions_ad BEFORE DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, topic, decision, reasoning)
  VALUES ('delete', old.rowid, old.topic, old.decision, old.reasoning);
END;
CREATE TRIGGER decisions_au BEFORE UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, topic, decision, reasoning)
  VALUES ('delete', old.rowid, old.topic, old.decision, old.reasoning);
END;
CREATE TRIGGER decisions_au2 AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, topic, decision, reasoning)
  VALUES (new.rowid, new.topic, new.decision, new.reasoning);
END;
INSERT INTO decisions_fts(decisions_fts) VALUES ('rebuild');

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (98, 'Add workflow as a memory kind');
