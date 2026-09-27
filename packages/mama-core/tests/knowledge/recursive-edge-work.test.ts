import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { visibleTwinRefKeysRecursive } from '../../src/knowledge/access.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';

describe('recursive edge preload work', () => {
  it.each([false, true])('visits a reconverging DAG by edge, including a cycle=%s', (cycle) => {
    const db = new Database(':memory:');
    let reads = 0;
    // Count real SQLite endpoint reads rather than wall time: the old path-expanded
    // CTE exceeds this budget with only 25 edges. Cycles must terminate as well.
    db.function('read_endpoint', (value) => {
      if (++reads > 2_000) throw new Error('recursive edge read budget exceeded');
      return value;
    });
    db.exec(`CREATE TABLE edge_records (
      edge_id TEXT PRIMARY KEY, edge_type TEXT, subject_kind TEXT, subject_id TEXT,
      object_kind TEXT, object_id TEXT, source TEXT, content_hash BLOB, created_at INTEGER
    );
    CREATE VIEW twin_edges AS SELECT edge_id, edge_type, subject_kind,
      read_endpoint(subject_id) AS subject_id, object_kind, object_id, source, content_hash,
      created_at FROM edge_records;`);
    const insert = db.prepare(
      "INSERT INTO edge_records VALUES (?, 'mentions', ?, ?, ?, ?, 'code', ?, 100)"
    );
    try {
      insert.run(
        'leaf',
        cycle ? 'edge' : 'report',
        cycle ? 'a-11' : 'report-leaf',
        'report',
        'report-leaf',
        Buffer.alloc(32)
      );
      for (let level = 0; level < 12; level++) {
        for (const side of ['a', 'b']) {
          insert.run(
            `${side}-${level}`,
            'edge',
            level === 0 ? 'leaf' : `a-${level - 1}`,
            'edge',
            level === 0 ? 'leaf' : `b-${level - 1}`,
            Buffer.alloc(32)
          );
        }
      }
      const visible = visibleTwinRefKeysRecursive(
        db as unknown as DatabaseAdapter,
        [{ kind: 'edge', id: 'a-11' }],
        {}
      );
      expect([...visible]).toEqual(cycle ? [] : ['edge\0a-11']);
      expect(reads).toBeLessThan(2_000);
    } finally {
      db.close();
    }
  });

  it('decides each edge once while evaluating a deep reconverging DAG', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE twin_edges (
      edge_id TEXT PRIMARY KEY, edge_type TEXT, subject_kind TEXT, subject_id TEXT,
      object_kind TEXT, object_id TEXT, source TEXT, content_hash BLOB, created_at INTEGER
    );`);
    const insert = db.prepare(
      "INSERT INTO twin_edges VALUES (?, 'mentions', ?, ?, ?, ?, 'code', ?, 100)"
    );
    try {
      insert.run('leaf', 'report', 'report-leaf', 'report', 'report-leaf', Buffer.alloc(32));
      // 24 levels: a path-by-path evaluation visits about 2^25 edges; memoized, about 50.
      for (let level = 0; level < 24; level++) {
        for (const side of ['a', 'b']) {
          insert.run(
            `${side}-${level}`,
            'edge',
            level === 0 ? 'leaf' : `a-${level - 1}`,
            'edge',
            level === 0 ? 'leaf' : `b-${level - 1}`,
            Buffer.alloc(32)
          );
        }
      }
      const started = Date.now();
      const visible = visibleTwinRefKeysRecursive(
        db as unknown as DatabaseAdapter,
        [{ kind: 'edge', id: 'a-23' }],
        {}
      );
      expect([...visible]).toEqual(['edge\0a-23']);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      db.close();
    }
  });
});
