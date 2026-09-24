-- 025 rebuilt decisions after 015 installed these triggers. SQLite drops a
-- table's triggers with that table, leaving the external-content FTS index
-- readable from decisions but no longer synchronized with new writes.
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(
  topic, decision, reasoning,
  content='decisions',
  content_rowid='rowid'
);

DROP TRIGGER IF EXISTS decisions_ai;
DROP TRIGGER IF EXISTS decisions_ad;
DROP TRIGGER IF EXISTS decisions_au;
DROP TRIGGER IF EXISTS decisions_au2;

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
INSERT OR IGNORE INTO schema_version(version, description)
VALUES (92, 'Restore decisions FTS synchronization after the table rebuild');
