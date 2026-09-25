import { describe, expect, it } from 'vitest';
import type { DatabaseInstance, Knowledge } from '@jungjaehoon/mama-core';
import { createActionSurface } from '../../src/runtime/action-surface.js';

describe('W1 action surface', () => {
  it('exposes the read-only viewer action and derives host tools from the catalog', () => {
    const surface = createActionSurface({
      adapter: {} as DatabaseInstance,
      knowledge: {} as Knowledge,
      ownerPrincipalId: 'owner-test',
      agentId: 'agent-test',
      connectors: ['chatwork', 'slack', 'trello', 'kagemusha'],
      scopes: [{ kind: 'project', id: 'workspace-test' }],
    });
    const expected = [
      'graph.query',
      'memory.save',
      'memory.search',
      'source.read',
      'source.search',
      'work.create',
      'work.list',
      'work.revise',
      'work.show',
    ];

    expect(
      surface.catalog
        .list()
        .map((contract) => contract.name)
        .sort()
    ).toEqual(expected);
    expect(surface.ownerAccess.actions.slice().sort()).toEqual(expected);
    expect(
      surface
        .hostToolDefinitions()
        .map((definition) => definition.name)
        .sort()
    ).toEqual(expected);
    expect(surface.catalog.list().filter((contract) => contract.name === 'work.list')).toHaveLength(
      1
    );
  });
});
