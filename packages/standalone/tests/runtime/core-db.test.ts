import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

const roots: string[] = [];
const previous = new Map<string, string | undefined>();

afterEach(() => {
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previous.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(name: string, value: string): void {
  if (!previous.has(name)) previous.set(name, process.env[name]);
  process.env[name] = value;
}

describe('standalone core database', () => {
  it('opens core and standalone migrations in the product-owned path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-core-db-'));
    roots.push(root);
    const path = join(root, 'memory.db');
    setEnv('MAMA_DB_PATH', path);

    const handle = await openCoreDatabase({ path });
    try {
      expect(handle.dbPath).toBe(path);
      expect(
        handle.adapter
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'decisions'")
          .get()
      ).toEqual({ name: 'decisions' });
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
    } finally {
      await handle.close();
    }
  });
});
