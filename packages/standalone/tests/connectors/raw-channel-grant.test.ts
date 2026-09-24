import { describe, expect, it } from 'vitest';
import { createStoredSourceReader } from '../../src/api/stored-source-reader.js';

describe('stored source channel grants', () => {
  it('requires a connector grant and a channel grant for non-owner reads', () => {
    const reader = createStoredSourceReader({
      adapter: {
        prepare: () => ({ get: () => undefined, all: () => [] }),
      } as never,
      ownerPrincipalId: () => 'owner-test',
    });
    expect(() =>
      reader.search(
        'connector-test',
        { query: 'term' },
        {
          principalId: 'member-test',
          agentId: 'agent-test',
          actions: ['source.search'],
          connectors: ['connector-test'],
          scopes: [],
        }
      )
    ).toThrow(/granted connector and channel scope/);
  });
});
