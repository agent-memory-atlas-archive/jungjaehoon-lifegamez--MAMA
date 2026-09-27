import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAdapter } from '../../src/db-manager.js';
import { openDatabase, type DatabaseHandle } from '../../src/storage/database.js';
import { recallMemory } from '../../src/memory/api.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

// Exercise actual FTS and graph queries; the model is irrelevant to DB identity.
vi.mock('../../src/embedding/embedder.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/embedding/embedder.js')>()),
  generateEmbedding: async () => new Float32Array(1024),
  generateEnhancedEmbedding: async () => new Float32Array(1024),
  isForceTier3Enabled: () => false,
}));

describe('F3.3 instance-bound recall graph expansion', () => {
  let globalPath: string;
  let dir: string;
  let local: DatabaseHandle;
  beforeAll(async () => {
    globalPath = await initTestDB('recall-global');
    dir = mkdtempSync(join(tmpdir(), 'recall-local-'));
    local = await openDatabase({ path: join(dir, 'local.db') });
    for (const [db, label] of [
      [getAdapter(), 'foreign'],
      [local.adapter, 'local'],
    ] as const) {
      const insert =
        db.prepare(`INSERT INTO decisions (id,topic,decision,reasoning,confidence,status,kind,created_at,updated_at)
        VALUES (?, ?, ?, 'fixture', 0.9, 'active', 'decision', 1000, 1000)`);
      insert.run('anchor', 'needle', 'needle');
      insert.run('related', 'other', `${label} graph content`);
      db.prepare(
        "INSERT INTO decision_edges (from_id,to_id,relationship,approved_by_user) VALUES ('anchor','related','builds_on',1)"
      ).run();
    }
  });
  afterAll(async () => {
    await local.close();
    await cleanupTestDB(globalPath);
    rmSync(dir, { recursive: true, force: true });
  });
  it('expands from the supplied adapter even when the global DB has the same IDs', async () => {
    const bundle = await recallMemory(local.adapter, 'needle', { limit: 1, includeRelated: true });
    expect(bundle.memories.map((row) => row.id)).toEqual(['anchor']);
    expect(bundle.graph_context.expanded.map((row) => row.summary)).toEqual([
      'local graph content',
    ]);
  });
  it('skips expansion when requested', async () => {
    const bundle = await recallMemory(local.adapter, 'needle', {
      limit: 1,
      skipGraphExpansion: true,
    });
    expect(bundle.memories.map((row) => row.id)).toEqual(['anchor']);
    expect(bundle.graph_context.expanded).toEqual([]);
  });
});
