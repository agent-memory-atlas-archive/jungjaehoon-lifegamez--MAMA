import { describe, expect, it, vi } from 'vitest';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';
import { sourceActionRegistrations } from '../../src/api/source-actions.js';

const access: ActionContext['access'] = {
  principalId: 'owner-test',
  agentId: 'agent-test',
  actions: ['source.search', 'source.read'],
  connectors: ['connector-test'],
  scopes: [],
};

describe('minimal source actions', () => {
  it('registers only source.search and source.read with bounded read fields', () => {
    const catalog = createCatalog(sourceActionRegistrations({}));
    expect(
      catalog
        .list()
        .map((contract) => contract.name)
        .sort()
    ).toEqual(['source.read', 'source.search']);
    expect(catalog.describe('source.read').inputSchema.properties?.content_limit).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 4_000,
    });
  });

  it('dispatches stored search/read and refuses an ungranted connector', async () => {
    const stored = {
      search: vi.fn().mockReturnValue({ hits: [], next_cursor: null }),
      read: vi.fn().mockReturnValue({ content: 'source-content' }),
      has: vi.fn().mockReturnValue(true),
      isOwner: vi.fn().mockReturnValue(true),
    };
    const dispatch = createDispatcher(createCatalog(sourceActionRegistrations({ stored })));
    const searched = await dispatch(
      {
        action: 'source.search',
        input: { source: 'connector-test', query: 'term' },
      },
      { access }
    );
    expect(searched).toMatchObject({ status: 'completed', data: { hits: [] } });
    expect(stored.search).toHaveBeenCalledWith(
      'connector-test',
      { source: 'connector-test', query: 'term' },
      access
    );

    const read = await dispatch(
      {
        action: 'source.read',
        input: {
          source: 'connector-test',
          observationRef: 'observation-test',
          content_offset: 0,
          content_limit: 100,
        },
      },
      { access }
    );
    expect(read).toMatchObject({ status: 'completed', data: { content: 'source-content' } });

    const denied = await dispatch(
      { action: 'source.search', input: { source: 'other-connector', query: 'term' } },
      { access }
    );
    expect(denied).toMatchObject({
      status: 'failed',
      error: { kind: 'denied', code: 'connector_out_of_scope' },
    });
    expect(stored.search).toHaveBeenCalledTimes(1);
  });
});
