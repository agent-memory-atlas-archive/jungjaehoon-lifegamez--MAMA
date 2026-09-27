-- The commitments rowid was called task_id.
--
-- A commitment is what this core knows how to hold: a record plus a revision
-- history. "Task" is one product's word for what it puts in one. Naming the rowid
-- after that product's word meant every other product installing this core read a
-- column about work it does not have.
--
-- RENAME COLUMN keeps the data, the AUTOINCREMENT sequence (sqlite_sequence is
-- keyed by table, not column) and every existing row id. Nothing is renumbered.
ALTER TABLE commitments RENAME COLUMN task_id TO row_id;
INSERT OR IGNORE INTO schema_version (version, description)
VALUES (82, 'Rename commitments.task_id to row_id');
