-- A migration belongs to whoever wrote it.
--
-- `schema_version` keyed migrations on a number alone, and progress was
-- `MAX(version)`. Both assume one author. With the core at 084, no other package
-- can number a migration: 085 is the core's next, and a package that picked 200
-- would make every later core migration look already applied.
--
-- So there was nowhere for a package's own table to live except inside the core,
-- and that is why the connector tables -- which one of four consumers has any use
-- for -- are declared by core migrations and created in every consumer's database.
--
-- Identity becomes (source, version). Rows written before this belong to the core,
-- which is the only author there has been.

PRAGMA foreign_keys = OFF;

CREATE TABLE schema_version_085 (
  source TEXT NOT NULL DEFAULT 'core' CHECK (length(trim(source)) > 0),
  version INTEGER NOT NULL,
  applied_at INTEGER DEFAULT (unixepoch()),
  description TEXT,
  PRIMARY KEY (source, version)
);

-- Only (version, description) carry over. `applied_at` is not copied: a database
-- old enough to predate it does not have the column, and when it ran is not a fact
-- anything reads. The new table defaults it.
INSERT INTO schema_version_085 (source, version, description)
  SELECT 'core', version, description FROM schema_version;

DROP TABLE schema_version;
ALTER TABLE schema_version_085 RENAME TO schema_version;

PRAGMA foreign_keys = ON;

INSERT OR IGNORE INTO schema_version (source, version, description)
VALUES ('core', 85, 'A migration is identified by (source, version)');
