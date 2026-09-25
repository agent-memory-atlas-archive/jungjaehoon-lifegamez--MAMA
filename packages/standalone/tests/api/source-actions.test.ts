import { describe, expect, it, vi } from 'vitest';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';
import { sourceActionRegistrations } from '../../src/api/source-actions.js';
import { minimalWorkActionRegistrations } from '../../src/api/work-actions.js';

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
      description: 'Maximum characters returned by a read; at most 4000.',
    });
    expect(catalog.describe('source.read').inputSchema.required).toEqual([
      'source',
      'observationRef',
    ]);
  });

  it('describes every source and work input field, including nested fields', () => {
    const knowledge = {
      createWork: vi.fn(),
      reviseWork: vi.fn(),
    };
    const catalog = createCatalog([
      ...sourceActionRegistrations({}),
      ...minimalWorkActionRegistrations({ knowledge }),
    ]);

    const visit = (schema: unknown, path: string): void => {
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
      const value = schema as {
        properties?: Record<string, unknown>;
        items?: unknown;
        oneOf?: unknown[];
      };
      for (const [name, property] of Object.entries(value.properties ?? {})) {
        const field = property as { description?: unknown };
        expect(field.description, `${path}.${name}`).toEqual(expect.any(String));
        expect(String(field.description).trim(), `${path}.${name}`).not.toBe('');
        visit(property, `${path}.${name}`);
      }
      visit(value.items, `${path}[]`);
      for (const [index, branch] of (value.oneOf ?? []).entries()) {
        visit(branch, `${path}.oneOf[${index}]`);
      }
    };

    for (const contract of catalog.list()) visit(contract.inputSchema, contract.name);
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

    await dispatch(
      {
        action: 'source.search',
        input: { source: 'connector-test', query: 'replay-term' },
      },
      { access, session: { replaySourceEndMs: 1_500 } }
    );
    expect(stored.search).toHaveBeenLastCalledWith(
      'connector-test',
      { source: 'connector-test', query: 'replay-term' },
      access,
      { maxSourceMs: 1_500 }
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
    expect(stored.search).toHaveBeenCalledTimes(2);
  });
});
