import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RawStore } from '../../src/storage/source-archive.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RawStore exact version reads', () => {
  it('returns the body only when the expected content hash matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-raw-version-'));
    roots.push(root);
    const store = new RawStore(root);
    try {
      const body = 'source-body';
      const [saved] = store.save('connector-test', [
        {
          source: 'connector-test',
          sourceId: 'source-one',
          channel: 'channel-test',
          author: 'author-test',
          content: body,
          timestamp: new Date('2026-09-25T00:00:00Z'),
          type: 'message',
        },
      ]);
      const hash = saved!.contentHash!;
      expect(store.readVersion('connector-test', saved!.sourceId, hash)).toEqual({
        status: 'available',
        body,
        contentHash: hash,
      });
      expect(
        store.readVersion(
          'connector-test',
          saved!.sourceId,
          createHash('sha256').update('other').digest('hex')
        )
      ).toEqual({
        status: 'version_unavailable',
        reason: 'HASH_MISMATCH',
      });
    } finally {
      store.close();
    }
  });
});
