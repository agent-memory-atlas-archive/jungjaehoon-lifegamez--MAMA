import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchAllRaw, searchRaw } from '../../src/connectors/framework/raw-query.js';
import { upsertConnectorEventIndex } from '../../src/connectors/framework/event-index.js';
import type { UpsertConnectorEventIndexInput } from '../../src/connectors/framework/connector-event-types.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';

describe('stored raw substring search', () => {
  let root: string;
  let database: Awaited<ReturnType<typeof openCoreDatabase>>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'raw-search-'));
    database = await openCoreDatabase({ path: join(root, 'core.db') });
  });

  afterEach(async () => {
    await database?.close();
    rmSync(root, { recursive: true, force: true });
  });

  function seed(sourceId: string, overrides: Partial<UpsertConnectorEventIndexInput> = {}) {
    return upsertConnectorEventIndex(database.adapter, {
      source_connector: 'connector-test',
      source_type: 'message',
      source_id: sourceId,
      channel: 'channel-test',
      content: 'review pending evidence',
      event_datetime: 100,
      observation: { observed_at: 2_000 },
      ...overrides,
    });
  }

  it.each(['alpha beta gamma delta', ' delta\t gamma\n beta　alpha '])(
    'matches every term across searchable fields, independently of order: %s',
    (query) => {
      seed('match', {
        title: 'alpha',
        content: 'beta',
        author: 'gamma',
        channel: 'delta',
      });
      seed('missing-term', { title: 'alpha', content: 'beta', author: 'gamma' });
      expect(searchAllRaw(database.adapter, { query }).hits.map((hit) => hit.source_id)).toEqual([
        'match',
      ]);
    }
  );

  it.each([
    ['日本語', 'これは日本語の文章です'],
    // A Latin term followed by a Hangul particle: 'bc' + U+B294.
    ['bc', 'bc\uB294 review pending'],
  ])('matches %s inside a sentence without token boundaries', (query, content) => {
    const saved = seed('match', { content });
    seed('unrelated');
    const result = searchRaw(database.adapter, { query, connectors: ['connector-test'] });
    expect(result.hits).toMatchObject([
      { source_id: 'match', raw_id: saved.current_observation_id },
    ]);
    expect(result.next_cursor).toBeNull();
  });

  it.each([
    ['%', 'progress 50%', 'progress 50'],
    ['_', 'asset_name', 'assetXname'],
    ['\\', 'folder\\file', 'folderfile'],
    ['50%_\\', 'literal 50%_\\ suffix', 'literal 50abcX suffix'],
  ])('treats LIKE metacharacters as literal text: %s', (query, literal, decoy) => {
    seed('literal', { content: literal });
    seed('decoy', { content: decoy });
    expect(searchAllRaw(database.adapter, { query }).hits.map((hit) => hit.source_id)).toEqual([
      'literal',
    ]);
  });

  it('pages every row once by capture time descending and index id ascending', () => {
    for (const [id, observedAt, content] of [
      ['d', 1_000, 'review'],
      ['b', 2_000, 'review review review'],
      ['e', 500, 'review'],
      ['a', 2_000, 'review followed by a longer explanation'],
      ['c', 2_000, 'review'],
    ] as const) {
      seed(id, { content, observation: { observed_at: observedAt } });
    }
    let cursor: string | undefined;
    const seen: string[] = [];
    for (let page = 0; page < 3; page += 1) {
      const result = searchAllRaw(database.adapter, { query: 'review', limit: 2, cursor });
      seen.push(...result.hits.map((hit) => hit.source_id));
      if (page < 2) expect(result.next_cursor).toBeTruthy();
      else expect(result.next_cursor).toBeNull();
      cursor = result.next_cursor ?? undefined;
    }
    expect(seen).toEqual(['b', 'a', 'c', 'd', 'e']);
  });

  it('keeps connector, channel, scope, source-time bounds and source-time ceilings', () => {
    const scoped = { memory_scope_kind: 'project', memory_scope_id: 'scope-test' };
    seed('lower-bound', { ...scoped, event_datetime: 120, observation: { observed_at: 2_000 } });
    // Said inside the window, captured days later by a backfill: still inside.
    seed('upper-bound', { ...scoped, event_datetime: 150, observation: { observed_at: 9_000 } });
    seed('wrong-connector', { ...scoped, source_connector: 'connector-other' });
    seed('wrong-channel', { ...scoped, channel: 'channel-other' });
    seed('wrong-scope-id', { ...scoped, memory_scope_id: 'scope-other' });
    seed('wrong-scope-kind', { ...scoped, memory_scope_kind: 'channel' });
    seed('before-source', { ...scoped, event_datetime: 119, observation: { observed_at: 2_500 } });
    seed('future-source', { ...scoped, event_datetime: 151 });
    seed('future-source-without-event-time', {
      ...scoped,
      event_datetime: null,
      source_timestamp_ms: 151,
    });
    const input = {
      query: 'evidence review',
      connectors: ['connector-test'],
      channels: ['channel-test'],
      scopes: [{ kind: 'project' as const, id: 'scope-test' }],
      fromMs: 120,
      toMs: 150,
      maxSourceMs: 150,
      limit: 1,
    };
    const first = searchAllRaw(database.adapter, input);
    expect(first.hits.map((hit) => hit.source_id)).toEqual(['upper-bound']);
    expect(first.next_cursor).toBeTruthy();
    const second = searchAllRaw(database.adapter, { ...input, cursor: first.next_cursor! });
    expect(second.hits.map((hit) => hit.source_id)).toEqual(['lower-bound']);
    expect(second.next_cursor).toBeNull();
    for (const maxSourceMs of [151, null, undefined]) {
      expect(() =>
        searchAllRaw(database.adapter, { ...input, cursor: first.next_cursor!, maxSourceMs })
      ).toThrow(/source-time ceiling changed/);
    }
  });

  it('uses event time, then source time for legacy rows without observations', () => {
    const event = seed('event-time', { event_datetime: 300, source_timestamp_ms: 100 });
    const source = seed('source-time', { event_datetime: null, source_timestamp_ms: 200 });
    for (const saved of [event, source]) {
      database.adapter
        .prepare(
          'UPDATE connector_event_index SET current_observation_id = NULL WHERE event_index_id = ?'
        )
        .run(saved.event_index_id);
    }
    expect(
      searchAllRaw(database.adapter, { query: 'evidence review', fromMs: 200, toMs: 300 }).hits
    ).toMatchObject([
      { source_id: 'event-time', created_at: '1970-01-01T00:00:00.300Z', observed_at: null },
      { source_id: 'source-time', created_at: '1970-01-01T00:00:00.200Z', observed_at: null },
    ]);
  });
});

describe('raw query input validation', () => {
  it('rejects an unknown scope kind before querying', () => {
    expect(() =>
      searchAllRaw({ prepare: () => ({ all: () => [], get: () => undefined }) } as never, {
        query: 'term',
        scopes: [{ kind: 'unknown-kind' as never, id: 'scope-test' }],
      })
    ).toThrow(/Invalid raw search scope kind/);
  });
});
