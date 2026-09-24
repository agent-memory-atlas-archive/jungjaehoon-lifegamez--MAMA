import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RawStore } from '../../src/storage/source-archive.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('raw source provenance', () => {
  it('retains source entity and observation metadata in the stored revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-raw-provenance-'));
    roots.push(root);
    const store = new RawStore(root);
    try {
      store.save('connector-test', [
        {
          source: 'provider-test',
          sourceId: 'source-version-one',
          sourceEntityId: 'entity-test',
          channel: 'channel-test',
          author: 'author-test',
          content: 'source-content',
          timestamp: new Date('2026-09-25T00:00:00Z'),
          type: 'document',
          sourceCursor: 'cursor-test',
          projectId: 'workspace-test',
          observedAt: 1_000,
        },
      ]);
      const row = store.getRevisions('connector-test', 'entity-test').items[0];
      expect(row).toMatchObject({ sourceEntityId: 'entity-test', sourceCursor: 'cursor-test' });
      expect(row.observedAt).toBe(1_000);
    } finally {
      store.close();
    }
  });
});
