import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('connector event index schema', () => {
  it('belongs to the standalone migration source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-schema-'));
    roots.push(root);
    const handle = await openCoreDatabase({ path: join(root, 'core.db') });
    try {
      expect(
        handle.adapter
          .prepare("SELECT version FROM schema_version WHERE source = 'standalone'")
          .get()
      ).toEqual({ version: 1 });
      expect(
        handle.adapter
          .prepare("SELECT name FROM sqlite_master WHERE name = 'connector_event_index'")
          .get()
      ).toEqual({ name: 'connector_event_index' });
      expect(
        handle.adapter
          .prepare("SELECT name FROM sqlite_master WHERE name = 'connector_event_index_fts'")
          .get()
      ).toEqual({ name: 'connector_event_index_fts' });
    } finally {
      await handle.close();
    }
  });
});
