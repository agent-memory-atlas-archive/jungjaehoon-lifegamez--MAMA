import { describe, expect, it, vi } from 'vitest';
import { ConnectorRegistry } from '../../../src/connectors/framework/connector-registry.js';
import type { IConnector } from '../../../src/connectors/framework/types.js';

function connector(name: string): IConnector {
  return {
    name,
    type: 'api',
    init: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, lastPollTime: null, lastPollCount: 0 }),
    getAuthRequirements: vi.fn().mockReturnValue([]),
    authenticate: vi.fn().mockResolvedValue(true),
    poll: vi.fn().mockResolvedValue([]),
  };
}

describe('ConnectorRegistry', () => {
  it('registers, snapshots, and disposes connectors', async () => {
    const registry = new ConnectorRegistry();
    const first = connector('slack');
    registry.register('slack', first);
    expect(registry.get('slack')).toBe(first);
    const snapshot = registry.getActive();
    snapshot.clear();
    expect(registry.get('slack')).toBe(first);
    await registry.disposeAll();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(registry.getActive()).toEqual(new Map());
  });
});
