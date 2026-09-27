import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const homes = [];
afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe('F3.19 configure database precedence', () => {
  it('documents the overrides in the same order the plugin resolves them', () => {
    const text = readFileSync(resolve('commands/configure.md'), 'utf8');
    const paragraph = text.split('1. **Database.**')[1].split('2. **Embedding model.**')[0];
    const names = [...paragraph.matchAll(/`(MAMA_(?:DB|DATABASE)_PATH)`/g)].map(
      (match) => match[1]
    );
    expect(names).toEqual(['MAMA_DB_PATH', 'MAMA_DATABASE_PATH']);
  });
  it.each(['both', 'database-only', 'default'])('resolves %s under an isolated HOME', (mode) => {
    const home = mkdtempSync(join(tmpdir(), 'plugin-db-path-'));
    homes.push(home);
    const env = { ...process.env, HOME: home, NODE_ENV: 'test' };
    delete env.MAMA_DB_PATH;
    delete env.MAMA_DATABASE_PATH;
    if (mode === 'both') {
      env.MAMA_DB_PATH = join(home, 'first.db');
    }
    if (mode !== 'default') {
      env.MAMA_DATABASE_PATH = join(home, 'second.db');
    }
    const value = execFileSync(
      process.execPath,
      ['-e', "process.stdout.write(require('./scripts/db-path.js').usePluginDatabase())"],
      { env, encoding: 'utf8' }
    );
    expect(value).toBe(
      mode === 'both'
        ? join(home, 'first.db')
        : mode === 'database-only'
          ? join(home, 'second.db')
          : join(home, '.claude', 'mama-memory.db')
    );
  });
});
