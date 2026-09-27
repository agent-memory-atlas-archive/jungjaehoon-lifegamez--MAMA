import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getRawById,
  getRawHistory,
  listRaw,
  searchRaw,
} from '../../src/connectors/framework/raw-query.js';
import { upsertConnectorEventIndex } from '../../src/connectors/framework/event-index.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

const roots: string[] = [];
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];

afterEach(async () => {
  for (const database of databases.splice(0).reverse()) await database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('replay source-time ceiling', () => {
  it('bounds search, list, exact reads, history, and cursors by source time', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-replay-ceiling-'));
    roots.push(root);
    const database = await openCoreDatabase({ path: join(root, 'core.db') });
    databases.push(database);
    const before = upsertConnectorEventIndex(database.adapter, {
      source_connector: 'connector-test',
      source_type: 'message',
      source_id: 'source-before',
      source_entity_id: 'entity-test',
      channel: 'channel-test',
      author: 'actor-test',
      content: 'earlier source evidence',
      event_datetime: 1_000,
      observation: { observed_at: 10_000, source_at: 1_000 },
    });
    const after = upsertConnectorEventIndex(database.adapter, {
      source_connector: 'connector-test',
      source_type: 'message',
      source_id: 'source-after',
      source_entity_id: 'entity-test',
      channel: 'channel-test',
      author: 'actor-test',
      content: 'later source evidence',
      event_datetime: 2_000,
      observation: { observed_at: 10_000, source_at: 2_000 },
    });
    upsertConnectorEventIndex(database.adapter, {
      source_connector: 'connector-test',
      source_type: 'message',
      source_id: 'source-older',
      source_entity_id: 'entity-test',
      channel: 'channel-test',
      author: 'actor-test',
      content: 'old source evidence',
      event_datetime: 500,
      observation: { observed_at: 10_000, source_at: 500 },
    });
    const visibility = { connectors: ['connector-test'], maxSourceMs: 1_500 };

    expect(searchRaw(database.adapter, { query: 'earlier', ...visibility }).hits).toHaveLength(1);
    expect(
      searchRaw(database.adapter, { query: 'earlier', ...visibility }).hits[0]?.source_id
    ).toBe('source-before');
    expect(listRaw(database.adapter, { query: '', ...visibility }).hits).toHaveLength(2);
    expect(getRawById(database.adapter, before.current_observation_id!, visibility)).not.toBeNull();
    expect(getRawById(database.adapter, after.current_observation_id!, visibility)).toBeNull();
    expect(
      getRawHistory(database.adapter, {
        entityId: 'entity-test',
        connectors: ['connector-test'],
        maxSourceMs: 1_500,
      }).hits
    ).toHaveLength(2);

    const page = listRaw(database.adapter, { query: '', limit: 1, ...visibility });
    expect(page.next_cursor).toBeTruthy();
    expect(() =>
      listRaw(database.adapter, {
        query: '',
        cursor: page.next_cursor!,
        connectors: ['connector-test'],
        maxSourceMs: 2_500,
      })
    ).toThrow(/source-time ceiling/i);
  });
});
