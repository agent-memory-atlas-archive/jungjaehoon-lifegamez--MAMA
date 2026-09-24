import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { upsertConnectorEventIndex } from '../../src/connectors/framework/event-index.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

describe('observation/index pairing', () => {
  it('uses the current observation as the index citation and keeps its hash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-observation-index-'));
    const path = join(root, 'memory.db');
    const previous = process.env.MAMA_DB_PATH;
    process.env.MAMA_DB_PATH = path;
    const handle = await openCoreDatabase({ path });
    try {
      const record = upsertConnectorEventIndex(handle.adapter, {
        source_connector: 'connector-test',
        source_type: 'message',
        source_id: 'source-one',
        channel: 'channel-test',
        content: 'source-content',
        event_datetime: 1_000,
        observation: { observed_at: 1_100 },
        content_hash: createHash('sha256').update('source-content').digest(),
      });
      expect(record.current_observation_id).toBeTruthy();
      expect(
        handle.adapter
          .prepare('SELECT content_hash FROM observation_versions WHERE observation_id = ?')
          .get(record.current_observation_id)
      ).toEqual({ content_hash: createHash('sha256').update('source-content').digest('hex') });
    } finally {
      await handle.close();
      if (previous === undefined) delete process.env.MAMA_DB_PATH;
      else process.env.MAMA_DB_PATH = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
