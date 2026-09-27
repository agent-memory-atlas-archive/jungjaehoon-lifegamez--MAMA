import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

vi.mock('../../src/embedding/embedder.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/embedding/embedder.js')>()),
  generateEmbedding: vi.fn(async () => queryVector()),
}));

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import { recallMemory } from '../../src/memory/api.js';
import { MEMORY_KINDS } from '../../src/memory/types.js';

function queryVector(): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = 1;
  return vector;
}

const adapters: NodeSQLiteAdapter[] = [];
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.disconnect();
});

describe('recall kind arrays', () => {
  it.each(['vector', 'fts5', 'lexical'] as const)(
    'returns every requested kind and excludes other kinds through %s',
    async (path) => {
      const adapter = new NodeSQLiteAdapter({ dbPath: ':memory:' });
      adapters.push(adapter);
      adapter.connect();
      adapter.runMigrations(join(__dirname, '../../db/migrations'));
      for (const kind of MEMORY_KINDS) {
        adapter
          .prepare(
            `INSERT INTO decisions
             (id, topic, decision, reasoning, confidence, created_at, updated_at, kind, status, summary)
             VALUES (?, ?, 'recallprobe rule', 'recallprobe evidence', 0.9, 100, 100, ?, 'active', 'recallprobe rule')`
          )
          .run(kind, `fixture-${kind}`, kind);
        if (path === 'vector') {
          const row = adapter.prepare('SELECT rowid FROM decisions WHERE id = ?').get(kind) as {
            rowid: number;
          };
          adapter.insertEmbedding(row.rowid, queryVector());
        }
      }
      if (path === 'lexical') {
        adapter.prepare('DROP TABLE decisions_fts').run();
      } else {
        adapter.prepare("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')").run();
      }

      const bundle = await recallMemory(
        adapter,
        path === 'vector' ? 'semanticprobe' : 'recallprobe',
        {
          kind: ['lesson', 'preference', 'constraint'],
          limit: 5,
          threshold: 0,
          includeRelated: false,
          skipGraphExpansion: true,
          disableRecency: true,
          diagnostics: true,
        }
      );

      expect(bundle.memories.map(({ id, kind }) => [id, kind]).sort()).toEqual([
        ['constraint', 'constraint'],
        ['lesson', 'lesson'],
        ['preference', 'preference'],
      ]);
      expect(bundle.search_meta.diagnostics?.candidate_counts).toMatchObject({
        vector: path === 'vector' ? 3 : 0,
        lexical: path === 'vector' ? 0 : 3,
      });
      expect([...new Set(bundle.memories.map((memory) => memory.source.source_type))]).toEqual([
        path === 'vector' ? 'vector_search' : path === 'fts5' ? 'fts5' : 'db',
      ]);
    }
  );
});
