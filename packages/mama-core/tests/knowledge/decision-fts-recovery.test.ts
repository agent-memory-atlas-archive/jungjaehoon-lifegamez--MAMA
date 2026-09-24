import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('Story R4: legacy decision FTS survives a decisions table rebuild', () => {
  it('reindexes populated history and follows later insert, update and delete', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE schema_version(version INTEGER PRIMARY KEY, description TEXT);
        CREATE TABLE decisions (
          id TEXT PRIMARY KEY, topic TEXT, decision TEXT, reasoning TEXT
        );
        CREATE VIRTUAL TABLE decisions_fts USING fts5(
          topic, decision, reasoning, content='decisions', content_rowid='rowid'
        );
      `);
      const insert = db.prepare(
        'INSERT INTO decisions(id,topic,decision,reasoning) VALUES(?,?,?,?)'
      );
      const find = (terms: string): string[] =>
        db
          .prepare(
            `SELECT d.id FROM decisions_fts
             JOIN decisions d ON decisions_fts.rowid = d.rowid
             WHERE decisions_fts MATCH ?`
          )
          .all(terms)
          .map((row) => String(row.id));
      insert.run('old', 'alpha unrelated beta', 'historical decision', 'original reason');
      expect(find('"alpha" AND "beta"')).toEqual([]);

      db.exec(
        readFileSync(join(__dirname, '../../db/migrations/092-restore-decision-fts.sql'), 'utf8')
      );
      expect(find('"alpha" AND "beta"')).toEqual(['old']);
      insert.run('new', 'gamma delta', 'new decision', 'new reason');
      expect(find('"gamma" AND "delta"')).toEqual(['new']);
      db.prepare('UPDATE decisions SET topic = ? WHERE id = ?').run('epsilon beta', 'old');
      expect(find('"alpha" AND "beta"')).toEqual([]);
      expect(find('"epsilon" AND "beta"')).toEqual(['old']);
      db.prepare('DELETE FROM decisions WHERE id = ?').run('new');
      expect(find('"gamma" AND "delta"')).toEqual([]);
      expect(
        db.prepare('SELECT version FROM schema_version WHERE version = 92').get()
      ).toBeTruthy();
    } finally {
      db.close();
    }
  });
});
