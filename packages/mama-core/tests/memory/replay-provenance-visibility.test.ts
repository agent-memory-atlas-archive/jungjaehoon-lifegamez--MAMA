import { describe, expect, it } from 'vitest';

import { isEventVisibleNow, toIndexedEvent } from '../../src/memory/provenance-live.js';

describe('replay source-time provenance visibility', () => {
  it('uses source_at instead of the shared import capture time', () => {
    const event = toIndexedEvent({
      event_index_id: 'observation-test',
      source_connector: 'connector-test',
      source_id: 'source-test',
      channel: 'channel-test',
      content: 'source body',
      observed_at: 10_000,
      source_at: 1_000,
      memory_scope_kind: null,
      memory_scope_id: null,
      project_id: null,
      tenant_id: null,
    });
    const base = {
      scopes: [],
      connectors: ['connector-test'],
      wideConnectors: ['connector-test'],
    };
    expect(isEventVisibleNow(event, { ...base, maxSourceMs: 1_500 })).toBe(true);
    expect(isEventVisibleNow(event, { ...base, maxSourceMs: 500 })).toBe(false);
  });
});
