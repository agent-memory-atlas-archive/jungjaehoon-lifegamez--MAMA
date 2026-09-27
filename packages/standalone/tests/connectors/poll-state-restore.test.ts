import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PollingScheduler } from '../../src/connectors/framework/polling-scheduler.js';
import { RawStore } from '../../src/storage/source-archive.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('poll state restore', () => {
  it('restores a valid cursor and ignores an invalid one', () => {
    const root = mkdtempSync(join(tmpdir(), 'poll-state-restore-'));
    roots.push(root);
    writeFileSync(
      join(root, 'poll-state.json'),
      JSON.stringify({
        slack: '2024-01-01T00:00:00.000Z',
        trello: 'not-a-date',
      }),
      'utf8'
    );
    const store = new RawStore(root);
    const scheduler = new PollingScheduler(store, root, {
      now: () => Date.parse('2024-01-02T00:00:00.000Z'),
    });
    expect(scheduler.getLastPollTime('slack')?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    expect(scheduler.getLastPollTime('trello')).toBeUndefined();
    store.close();
  });
});
