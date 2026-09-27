import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RawStore } from '../../src/storage/source-archive.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RawStore revisions', () => {
  it('keeps changed content as revisions and does not duplicate an unchanged retry', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-raw-revisions-'));
    roots.push(root);
    const store = new RawStore(root);
    try {
      const base = {
        source: 'connector-test',
        sourceId: 'entity-test',
        sourceEntityId: 'entity-test',
        channel: 'channel-test',
        author: 'author-test',
        timestamp: new Date('2026-09-25T00:00:00Z'),
        type: 'document' as const,
      };
      store.save('connector-test', [{ ...base, content: 'content-a' }]);
      store.save('connector-test', [{ ...base, content: 'content-b' }]);
      store.save('connector-test', [{ ...base, content: 'content-b' }]);
      expect(
        store.getRevisions('connector-test', 'entity-test').items.map((row) => row.content)
      ).toEqual(['content-a', 'content-b']);
    } finally {
      store.close();
    }
  });
});
