import { describe, expect, it } from 'vitest';
import { createStoredSourceReader } from '../../src/api/stored-source-reader.js';

describe('stored source reader', () => {
  it('uses the owner connector grant to read a bounded stored page', () => {
    const reader = createStoredSourceReader({
      adapter: {
        prepare: (sql: string) => ({
          get: () => (sql.includes('COUNT(*)') ? { count: 0, channel_count: 0 } : undefined),
          all: () => [],
        }),
      } as never,
      ownerPrincipalId: () => 'owner-test',
    });
    expect(
      reader.search(
        'connector-test',
        { query: 'term', limit: 10 },
        {
          principalId: 'owner-test',
          agentId: 'agent-test',
          actions: ['source.search'],
          connectors: ['connector-test'],
          scopes: [],
        }
      )
    ).toMatchObject({ source: 'connector-test', mode: 'stored', hits: [] });
  });
});
