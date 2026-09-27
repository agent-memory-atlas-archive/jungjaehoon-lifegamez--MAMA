import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/embedding/embedder.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/embedding/embedder.js')>(
    '../../src/embedding/embedder.js'
  );
  return {
    ...actual,
    generateEmbedding: vi.fn(async () => queryVector()),
  };
});

import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import { fts5Search, vectorSearch } from '../../src/knowledge/search.js';
import { recallMemory } from '../../src/memory/api.js';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'db', 'migrations');
const tempPaths = new Set<string>();

function queryVector(): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = 1;
  return vector;
}

function weakerVector(): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = 0.95;
  vector[1] = Math.sqrt(1 - vector[0] * vector[0]);
  return vector;
}

function tempDbPath(): string {
  const path = join(os.tmpdir(), `mama-memory-kind-${randomUUID()}.db`);
  tempPaths.add(path);
  return path;
}

function setupAdapter(): NodeSQLiteAdapter {
  const adapter = new NodeSQLiteAdapter({ dbPath: tempDbPath() });
  adapter.connect();
  adapter.runMigrations(MIGRATIONS_DIR);
  return adapter;
}

function seed(
  adapter: NodeSQLiteAdapter,
  input: {
    id: string;
    kind: 'decision' | 'lesson';
    decision: string;
    embedding: Float32Array;
  }
): void {
  adapter
    .prepare(
      `INSERT INTO decisions (
         id, topic, decision, reasoning, confidence, created_at, updated_at,
         kind, status, summary
       ) VALUES (?, ?, ?, ?, 0.9, ?, ?, ?, 'active', ?)`
    )
    .run(
      input.id,
      input.id,
      input.decision,
      input.decision,
      Date.now(),
      Date.now(),
      input.kind,
      input.decision
    );
  const row = adapter.prepare('SELECT rowid FROM decisions WHERE id = ?').get(input.id) as {
    rowid: number;
  };
  adapter.insertEmbedding(row.rowid, input.embedding);
}

afterEach(() => {
  for (const path of tempPaths) {
    for (const file of [path, `${path}-journal`, `${path}-wal`, `${path}-shm`]) {
      try {
        fs.unlinkSync(file);
      } catch {
        // best effort cleanup for the temporary database
      }
    }
  }
  tempPaths.clear();
});

describe('memory kind filtering', () => {
  it('filters vector candidates by kind before the limit and preserves the stored kind', async () => {
    const adapter = setupAdapter();
    seed(adapter, {
      id: 'decision-kind-filter',
      kind: 'decision',
      decision: 'kind filter probe',
      embedding: queryVector(),
    });
    seed(adapter, {
      id: 'lesson-kind-filter',
      kind: 'lesson',
      decision: 'kind filter probe lesson',
      embedding: weakerVector(),
    });

    const hits = await vectorSearch(adapter, queryVector(), 1, 0, undefined, undefined, 'lesson');

    expect(hits.map((hit) => hit.id)).toEqual(['lesson-kind-filter']);
    expect((hits[0] as unknown as { kind: string }).kind).toBe('lesson');
    adapter.disconnect();
  });

  it('filters FTS candidates by kind before the limit', async () => {
    const adapter = setupAdapter();
    seed(adapter, {
      id: 'decision-fts-kind-filter',
      kind: 'decision',
      decision: 'ftsprobe ftsprobe ftsprobe',
      embedding: queryVector(),
    });
    seed(adapter, {
      id: 'lesson-fts-kind-filter',
      kind: 'lesson',
      decision: 'ftsprobe',
      embedding: weakerVector(),
    });
    adapter.prepare("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')").run();

    const hits = await fts5Search(adapter, 'ftsprobe', 1, 'lesson');

    expect(hits.map((hit) => hit.id)).toEqual(['lesson-fts-kind-filter']);
    adapter.disconnect();
  });

  it('applies the kind filter through recallMemory', async () => {
    const adapter = setupAdapter();
    seed(adapter, {
      id: 'decision-recall-kind-filter',
      kind: 'decision',
      decision: 'recallprobe',
      embedding: queryVector(),
    });
    seed(adapter, {
      id: 'lesson-recall-kind-filter',
      kind: 'lesson',
      decision: 'recallprobe lesson',
      embedding: weakerVector(),
    });
    adapter.prepare("INSERT INTO decisions_fts(decisions_fts) VALUES('rebuild')").run();

    const bundle = await recallMemory(adapter, 'recallprobe', {
      kind: 'lesson',
      limit: 1,
      threshold: 0,
      includeRelated: false,
      disableRecency: true,
    });

    expect(bundle.memories.map((memory) => [memory.id, memory.kind])).toEqual([
      ['lesson-recall-kind-filter', 'lesson'],
    ]);
    adapter.disconnect();
  });
});
