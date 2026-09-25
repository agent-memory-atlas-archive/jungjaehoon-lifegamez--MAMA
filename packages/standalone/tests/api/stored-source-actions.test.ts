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

  it('returns one result per batch ref when replay ceiling hides a future observation', () => {
    const rows = new Map<string, Record<string, unknown>>([
      [
        'observation-readable',
        {
          observation_id: 'observation-readable',
          source: 'connector-test',
          source_id: 'source-readable',
          producer_version_id: null,
          body: 'readable source body',
          body_location_json: null,
          author: 'author-test',
          source_at: 1_000,
          observed_at: 1_100,
          content_hash: 'hash-readable',
          metadata_json: '{}',
          scope_json: '{}',
          source_type: null,
          source_locator: null,
          title: null,
          artifact_locator: null,
          artifact_title: null,
          event_date: null,
          source_entity_id: null,
          channel: 'channel-test',
          project_id: null,
          tenant_id: null,
          memory_scope_kind: null,
          memory_scope_id: null,
        },
      ],
      [
        'observation-future',
        {
          observation_id: 'observation-future',
          source: 'connector-test',
          source_id: 'source-future',
          producer_version_id: null,
          body: 'future source body',
          body_location_json: null,
          author: 'author-test',
          source_at: 2_000,
          observed_at: 2_100,
          content_hash: 'hash-future',
          metadata_json: '{}',
          scope_json: '{}',
          source_type: null,
          source_locator: null,
          title: null,
          artifact_locator: null,
          artifact_title: null,
          event_date: null,
          source_entity_id: null,
          channel: 'channel-test',
          project_id: null,
          tenant_id: null,
          memory_scope_kind: null,
          memory_scope_id: null,
        },
      ],
    ]);
    const reader = createStoredSourceReader({
      adapter: {
        prepare: (sql: string) => ({
          get: (...args: unknown[]) => {
            const ref = String(args[0]);
            const row = rows.get(ref);
            if (sql.includes('SELECT o.channel')) {
              const ceiling = args[2];
              if (
                !row ||
                row.source !== args[1] ||
                (typeof ceiling === 'number' && Number(row.source_at) > ceiling)
              ) {
                return undefined;
              }
              return { channel: row.channel };
            }
            if (sql.includes('SELECT * FROM observation_versions')) return row;
            return undefined;
          },
          all: () => [],
        }),
      } as never,
      ownerPrincipalId: () => 'owner-test',
    });

    const result = reader.read(
      'connector-test',
      {
        observationRefs: ['observation-readable', 'observation-future'],
        content_limit: 100,
      },
      {
        principalId: 'owner-test',
        agentId: 'agent-test',
        actions: ['source.read'],
        connectors: ['connector-test'],
        scopes: [],
      },
      { maxSourceMs: 1_500 }
    );

    expect(result).toMatchObject({
      source: 'connector-test',
      mode: 'stored',
      results: [
        {
          observationRef: 'observation-readable',
          status: 'completed',
          data: { content: 'readable source body' },
        },
        {
          observationRef: 'observation-future',
          status: 'failed',
          error: {
            code: 'stored_source_not_found',
            message: 'No stored observation exists for this source and reference',
          },
        },
      ],
    });
  });
});
