-- A scope kind is the consumer's word, not the core's list.
--
-- `memory_scopes` had it right in shape: a scope is a (kind, id) pair, and the
-- pair is what the core reasons about. Then it also enumerated the kinds --
-- global, user, channel, project -- which is a statement about one deployment's
-- world. `channel` is a chat concept; a consumer with no chat has to satisfy a
-- constraint naming it, and a consumer with a kind of its own cannot store one at
-- all.
--
-- The core defines the question. It must not also answer it. What is kept is the
-- only part that is the core's: a kind is nonblank text.
--
-- SQLite cannot drop a CHECK, so the table is rebuilt. The rows carry over.

PRAGMA foreign_keys = OFF;

CREATE TABLE memory_scopes_084 (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (length(trim(kind)) > 0),
  external_id TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch() * 1000),
  UNIQUE(kind, external_id)
);

INSERT INTO memory_scopes_084 (id, kind, external_id, created_at)
  SELECT id, kind, external_id, created_at FROM memory_scopes;

DROP TABLE memory_scopes;
ALTER TABLE memory_scopes_084 RENAME TO memory_scopes;

PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (84, 'A scope kind is the consumer word, not a list the core keeps');
