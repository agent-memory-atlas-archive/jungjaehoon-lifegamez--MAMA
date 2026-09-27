import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RawStore } from '../../../src/storage/source-archive.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('connector raw store', () => {
  it('persists one connector namespace and a pending projection', () => {
    const root = mkdtempSync(join(tmpdir(), 'raw-store-framework-'));
    roots.push(root);
    const store = new RawStore(root);
    store.save('slack', [
      {
        source: 'slack',
        sourceId: 'source-key',
        channel: 'channel-key',
        author: 'actor-key',
        content: 'source-content',
        timestamp: new Date(1_704_067_201_000),
        type: 'message',
      },
    ]);
    expect(store.query('slack', new Date(0))).toHaveLength(1);
    expect(store.query('trello', new Date(0))).toEqual([]);
    expect(store.listPendingProjections('slack')).toHaveLength(1);
    store.close();
  });
});
