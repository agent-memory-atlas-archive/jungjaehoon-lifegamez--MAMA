import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { getAdapter } from '../../src/db-manager.js';
import {
  appendObservationVersion,
  isObservationVersionVisible,
} from '../../src/knowledge/observations.js';
import { assertTwinRefsVisible } from '../../src/knowledge/access.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

describe('replay source-time visibility', () => {
  let dbPath = '';

  beforeAll(async () => {
    dbPath = await initTestDB('replay-source-visibility');
  });

  beforeEach(() => {
    getAdapter().prepare('DELETE FROM observation_versions').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it('hides later observations even when capture time is the same', () => {
    const common = {
      source: 'connector-test',
      sourceId: 'source',
      producerVersionId: 'version',
      body: 'source body',
      observedAt: 10_000,
      contentHash: 'hash',
      channel: 'channel-test',
    } as const;
    const before = appendObservationVersion(getAdapter(), {
      ...common,
      sourceAt: 1_000,
      sourceId: 'source-before',
      producerVersionId: 'version-before',
    });
    const after = appendObservationVersion(getAdapter(), {
      ...common,
      sourceAt: 2_000,
      sourceId: 'source-after',
      producerVersionId: 'version-after',
    });
    const authority = {
      principalId: 'principal-test',
      agentId: 'agent-test',
      connectors: ['connector-test'],
      connectorWideRead: ['connector-test'],
      maxSourceMs: 1_500,
    };

    expect(isObservationVersionVisible(getAdapter(), before.observationId, authority)).toBe(true);
    expect(isObservationVersionVisible(getAdapter(), after.observationId, authority)).toBe(false);
    expect(() =>
      assertTwinRefsVisible(
        getAdapter(),
        [{ kind: 'observation', id: after.observationId }],
        authority
      )
    ).toThrow(/not visible/i);
  });
});
