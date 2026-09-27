import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import {
  appendObservationVersion,
  readObservationVersion,
  searchOwnerObservationVersions,
} from '../../src/knowledge/observations.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';
import { isObservationVersionVisible } from '../../src/knowledge/observations.js';

function observe(sourceId: string, body: string, observedAt: number) {
  return appendObservationVersion(getAdapter(), {
    source: 'trello',
    sourceType: 'kanban_card',
    sourceId,
    sourceEntityId: 'card-1',
    channel: 'trello:board-1',
    author: 'owner',
    bodyLocation: { kind: 'raw', connectorName: 'trello', revisionSourceId: sourceId },
    producerVersionId: sourceId,
    sourceAt: null,
    observedAt,
    contentHash: `hash-${sourceId}-${body}-${observedAt}`,
  });
}

describe('Story TG-03/TG-04/TG-05/TG-06: immutable observation versions', () => {
  let path = '';

  beforeAll(async () => {
    path = await initTestDB('observation-versions');
  });

  it('exports observation and correction helpers from the package contract', async () => {
    const core = await import('../../src/index.js');

    expect(typeof core.appendObservationVersion).toBe('function');
    expect(typeof core.appendIdentityCorrection).toBe('function');
  });
  beforeEach(() => {
    getAdapter().prepare('DELETE FROM observation_versions').run();
  });
  afterAll(async () => cleanupTestDB(path));

  it('reports reader absence, missing version and hash mismatch without latest-body fallback', () => {
    const record = observe('card-1', 'A', 100);
    expect(readObservationVersion(getAdapter(), record.observationId)).toMatchObject({
      status: 'version_unavailable',
      reason: 'BODY_READER_UNAVAILABLE',
    });
    expect(
      readObservationVersion(getAdapter(), record.observationId, {
        readVersion: () => ({ status: 'version_unavailable', reason: 'VERSION_NOT_FOUND' }),
      })
    ).toMatchObject({ status: 'version_unavailable', reason: 'VERSION_NOT_FOUND' });
    expect(
      readObservationVersion(getAdapter(), record.observationId, {
        readVersion: () => ({ status: 'version_unavailable', reason: 'HASH_MISMATCH' }),
      })
    ).toMatchObject({ status: 'version_unavailable', reason: 'HASH_MISMATCH' });
  });

  it('rejects replay unless the complete immutable payload is byte-equivalent after canonicalization', () => {
    const adapter = getAdapter();
    const original = {
      source: 'synthetic',
      sourceId: 'message-1',
      producerVersionId: 'version-1',
      body: 'exact body',
      author: 'synthetic-author',
      sourceAt: 10,
      observedAt: 20,
      contentHash: 'synthetic-content-hash',
      metadata: { nested: { a: 1, b: 2 } },
      scope: { visibility: 'owner', principalId: 'principal-1', agentId: 'agent-1' },
    } as const;
    const first = appendObservationVersion(adapter, original);
    expect(
      appendObservationVersion(adapter, {
        ...original,
        metadata: { nested: { b: 2, a: 1 } },
      })
    ).toEqual(first);

    const conflicts = [
      { body: 'changed body' },
      { author: 'other-author' },
      { sourceAt: 11 },
      { observedAt: 21 },
      { metadata: { nested: { a: 1, b: 3 } } },
      { scope: { visibility: 'owner', principalId: 'principal-2', agentId: 'agent-1' } },
    ];
    for (const changed of conflicts) {
      expect(() => appendObservationVersion(adapter, { ...original, ...changed })).toThrowError(
        /observation.*conflict/i
      );
    }

    const located = {
      ...original,
      sourceId: 'message-2',
      body: undefined,
      bodyLocation: {
        kind: 'raw' as const,
        connectorName: 'synthetic',
        revisionSourceId: 'revision-1',
      },
    };
    appendObservationVersion(adapter, located);
    expect(() =>
      appendObservationVersion(adapter, {
        ...located,
        bodyLocation: { ...located.bodyLocation, revisionSourceId: 'revision-2' },
      })
    ).toThrowError(/observation.*conflict/i);
  });

  it('binds producer identity independently of a recomputed content hash', () => {
    const adapter = getAdapter();
    const original = {
      source: 'synthetic',
      sourceId: 'message-producer',
      producerVersionId: 'delivery-1',
      body: 'first body',
      observedAt: 40,
      contentHash: 'hash-first',
    } as const;
    const first = appendObservationVersion(adapter, original);

    expect(() =>
      appendObservationVersion(adapter, {
        ...original,
        body: 'changed body',
        contentHash: 'hash-changed',
      })
    ).toThrowError(/observation.*conflict/i);
    expect(adapter.prepare('SELECT COUNT(*) AS count FROM observation_versions').get()).toEqual({
      count: 1,
    });
    expect(first.observationId).toMatch(/^obs_/);
  });

  it('keeps content-addressed versions when the producer supplies no version identity', () => {
    const adapter = getAdapter();
    const first = appendObservationVersion(adapter, {
      source: 'synthetic',
      sourceId: 'mutable-message',
      body: 'A',
      observedAt: 50,
      contentHash: 'hash-a',
    });
    const second = appendObservationVersion(adapter, {
      source: 'synthetic',
      sourceId: 'mutable-message',
      body: 'B',
      observedAt: 51,
      contentHash: 'hash-b',
    });

    expect(second.observationId).not.toBe(first.observationId);
  });

  it('rejects an available body reader response whose hash differs from the observation', () => {
    const record = observe('card-reader-hash', 'A', 100);
    expect(
      readObservationVersion(getAdapter(), record.observationId, {
        readVersion: () => ({ status: 'available', body: 'different', contentHash: 'wrong-hash' }),
      })
    ).toMatchObject({ status: 'version_unavailable', reason: 'HASH_MISMATCH' });
  });

  it('searches owner observations by both signed principal and agent', () => {
    const adapter = getAdapter();
    for (const principalId of ['principal-a', 'principal-b']) {
      appendObservationVersion(adapter, {
        source: 'owner-message:slack',
        sourceId: `message-${principalId}`,
        producerVersionId: `delivery-${principalId}`,
        body: 'same searchable text',
        observedAt: principalId === 'principal-a' ? 60 : 61,
        contentHash: `hash-${principalId}`,
        scope: {
          visibility: 'owner',
          principalId,
          agentId: 'agent-1',
          channel: 'channel-1',
        },
      });
    }

    const result = searchOwnerObservationVersions(adapter, {
      query: 'searchable',
      principalId: 'principal-a',
      agentId: 'agent-1',
    });
    expect(result.items.map((item) => item.sourceId)).toEqual(['message-principal-a']);
    expect(result.items[0]).not.toHaveProperty('body');
    expect(result.items[0]).not.toHaveProperty('scope');
  });

  it.each([null, 7, ['cursor']])(
    'AC #7 rejects a decoded non-object owner cursor: %j',
    (decoded) => {
      expect(() =>
        searchOwnerObservationVersions(getAdapter(), {
          query: 'searchable',
          principalId: 'principal-a',
          agentId: 'agent-1',
          cursor: Buffer.from(JSON.stringify(decoded)).toString('base64url'),
        })
      ).toThrow('Invalid owner observation cursor.');
    }
  );

  it('enforces connector and channel authority alongside principal, agent, and scope', () => {
    const adapter = getAdapter();
    const raw = appendObservationVersion(adapter, {
      source: 'slack',
      sourceId: 'channel-denied',
      producerVersionId: 'delivery-channel-denied',
      body: 'same project, different channel',
      observedAt: 70,
      contentHash: 'hash-channel-denied',
      scope: {
        channel: 'channel-b',
        memoryScopeKind: 'project',
        memoryScopeId: 'project-a',
      },
    });
    const authority = {
      principalId: 'principal-a',
      agentId: 'agent-a',
      scopes: [{ kind: 'project' as const, id: 'project-a' }],
      connectors: ['slack'],
      channels: { slack: ['channel-a'] },
    };
    expect(isObservationVersionVisible(adapter, raw.observationId, authority)).toBe(false);

    const owner = appendObservationVersion(adapter, {
      source: 'owner-message:slack',
      sourceId: 'owner-channel-a',
      producerVersionId: 'owner-delivery-a',
      body: 'owner body',
      observedAt: 71,
      contentHash: 'hash-owner-channel-a',
      scope: {
        visibility: 'owner',
        principalId: 'principal-a',
        agentId: 'agent-a',
        channel: 'channel-a',
      },
    });
    expect(isObservationVersionVisible(adapter, owner.observationId, authority)).toBe(true);
    expect(
      isObservationVersionVisible(adapter, owner.observationId, {
        ...authority,
        principalId: 'principal-b',
      })
    ).toBe(false);
  });

  it('fails explicitly when stored metadata or scope JSON is malformed', () => {
    const adapter = getAdapter();
    const record = appendObservationVersion(adapter, {
      source: 'synthetic',
      sourceId: 'message-corrupt',
      body: 'body',
      observedAt: 30,
      contentHash: 'synthetic-hash-corrupt',
      metadata: { safe: true },
      scope: { memoryScopeKind: 'project', memoryScopeId: 'project-1' },
    });
    adapter
      .prepare('UPDATE observation_versions SET metadata_json = ? WHERE observation_id = ?')
      .run('{invalid', record.observationId);
    expect(() => readObservationVersion(adapter, record.observationId)).toThrowError(
      /metadata_json/i
    );
    adapter
      .prepare(
        'UPDATE observation_versions SET metadata_json = ?, scope_json = ? WHERE observation_id = ?'
      )
      .run('{}', '[]', record.observationId);
    expect(() => readObservationVersion(adapter, record.observationId)).toThrowError(/scope_json/i);
  });
});
