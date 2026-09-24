import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import {
  getConnectorEventIndexRecord,
  upsertConnectorEventIndex,
} from '../../src/connectors/framework/event-index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('connector event index', () => {
  it('writes and reads the collector, channel, and observation reference', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-index-'));
    roots.push(root);
    const handle = await openCoreDatabase({ path: join(root, 'core.db') });
    try {
      const saved = upsertConnectorEventIndex(handle.adapter, {
        source_connector: 'kagemusha',
        source_type: 'message',
        source_id: 'source-key',
        channel: 'kagemusha:chatwork:room-key',
        author: 'actor-key',
        content: 'source-content',
        event_datetime: 1_704_067_201_000,
        observation: { observed_at: 1_704_067_202_000 },
      });
      expect(getConnectorEventIndexRecord(handle.adapter, 'kagemusha', 'source-key')).toMatchObject(
        {
          event_index_id: saved.event_index_id,
          channel: 'kagemusha:chatwork:room-key',
          current_observation_id: saved.current_observation_id,
        }
      );
    } finally {
      await handle.close();
    }
  });
});
