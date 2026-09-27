import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RawStore } from '../../src/storage/source-archive.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function item(sourceId: string, content = 'source-content') {
  return {
    source: 'connector-test',
    sourceId,
    channel: 'channel-test',
    author: 'author-test',
    content,
    timestamp: new Date('2026-09-25T00:00:00Z'),
    type: 'message' as const,
  };
}

describe('RawStore', () => {
  it('stores connector-isolated observations and durable pending projections', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-raw-store-'));
    roots.push(root);
    const store = new RawStore(root);
    try {
      const [saved] = store.save('connector-test', [item('source-one')]);
      expect(saved?.sourceId).toBe('source-one');
      expect(store.query('connector-test', new Date(0))).toHaveLength(1);
      expect(store.query('other-connector', new Date(0))).toEqual([]);
      expect(store.listPendingProjections('connector-test')).toHaveLength(1);
      store.acknowledgeProjections(
        'connector-test',
        store.listPendingProjections('connector-test').map((projection) => ({
          revisionSourceId: projection.sourceId,
          pendingProjectionId: projection.pendingProjectionId,
        }))
      );
      expect(store.listPendingProjections('connector-test')).toEqual([]);
    } finally {
      store.close();
    }
  });
});
