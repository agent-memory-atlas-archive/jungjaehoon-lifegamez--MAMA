import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function applyAllMigrations(db: Database.Database): number {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}-.+\.sql$/.test(file))
    .sort((left, right) => left.localeCompare(right));
  for (const file of files) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  return Number(files[files.length - 1].slice(0, 3));
}

/**
 * The registry tables exactly as the FIRST published 069 wrote them: five alias
 * columns and `PRIMARY KEY (kind, alias)`, with no scope columns and no scope
 * index. This DDL is written out verbatim rather than derived from the current
 * migration, because deriving it is what hid the same defect in the operator
 * rebuild -- a fixture assembled by substituting today's schema always carries
 * today's constraint spellings, so it can never reproduce an older database.
 */
const PRE_SCOPE_069_DDL = `
DROP INDEX IF EXISTS idx_registry_aliases_scope;
DROP INDEX IF EXISTS idx_registry_scope_lookup;
DROP TABLE IF EXISTS registry_scope_bindings;
DROP TABLE IF EXISTS registry_aliases;
CREATE TABLE registry_aliases (
  node_id TEXT NOT NULL REFERENCES registry_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('item', 'person', 'client')),
  -- Case- and space-normalised at write time; the display form stays in \`alias_display\`.
  alias TEXT NOT NULL,
  alias_display TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, alias)
);
CREATE INDEX IF NOT EXISTS idx_registry_aliases_node ON registry_aliases(node_id);
`;

describe('migration 069 recovery on a database that received the pre-scope shape', () => {
  it('reopens a database whose registry_aliases still has PRIMARY KEY (kind, alias)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'mama-registry-069-'));
    const dbPath = join(tempDir, 'pre-scope.db');

    const seed = new Database(dbPath);
    const latest = applyAllMigrations(seed);
    seed.exec(PRE_SCOPE_069_DDL);
    seed.exec('INSERT OR IGNORE INTO schema_version (version) VALUES (' + latest + ')');
    seed.close();

    // The daemon opening its own older database. Before the fix this throws
    // `table "registry_aliases" has more than one primary key`, because the
    // rebuild kept the old table constraint it did not recognise and then added
    // the new one alongside it.
    const adapter = new NodeSQLiteAdapter({ dbPath });
    adapter.connect();
    expect(() => adapter.runMigrations(MIGRATIONS_DIR)).not.toThrow();

    const sql = String(
      (
        adapter
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='registry_aliases'")
          .get() as { sql?: string }
      )?.sql ?? ''
    );
    expect(sql.toLowerCase().split('primary key').length - 1).toBe(1);
    expect(sql).toContain('scope_kind');

    adapter.disconnect();
  });
});
