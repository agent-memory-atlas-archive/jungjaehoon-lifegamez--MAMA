/**
 * The read window dispatch states when the caller states none.
 *
 * "A citation must not out-read reading" used to hold only where a host assembled
 * the window from a verified envelope. A program calling over the socket carries
 * no envelope, so it got no window -- and the rule held only by the action's own
 * fail-closed default. The principal's grant already says what it may read.
 */
import { describe, expect, it } from 'vitest';

import { createCatalog, createDispatcher, type ActionContext } from '../../src/index.js';

function catalogSeeingItsContext() {
  let seen: ActionContext | undefined;
  const dispatch = createDispatcher(
    createCatalog([
      {
        contract: {
          name: 'test.context',
          summary: 'test-only: returns the context the dispatcher built.',
          inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        },
        exec: (_input, context) => {
          seen = context;
          return {};
        },
      },
    ])
  );
  return { dispatch, read: () => seen };
}

const baseAccess = {
  principalId: 'p',
  agentId: 'a',
  scopes: [],
  actions: ['test.context'],
};

describe('dispatch composes a read window from the principal grant', () => {
  it('carries the grant connectors, channels, projects and tenant', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    await dispatch(
      { action: 'test.context', input: {} },
      {
        access: {
          ...baseAccess,
          connectors: ['trello'],
          channels: { trello: ['board-1'] },
          projectRefs: [{ kind: 'project', id: 'proj-1' }],
          tenantId: 'default',
        },
      }
    );
    expect(read()?.readAllowance).toEqual({
      connectors: ['trello'],
      channels: { trello: ['board-1'] },
      projectIds: ['proj-1'],
      tenantId: 'default',
      maxObservedMs: null,
    });
  });

  it('carries the grant observation clamp, so a citation cannot out-read reading in time', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    await dispatch(
      { action: 'test.context', input: {} },
      {
        access: {
          ...baseAccess,
          connectors: ['trello'],
          tenantId: 'default',
          maxObservedMs: 1_700_000_000_000,
        },
      }
    );
    expect(read()?.readAllowance?.maxObservedMs).toBe(1_700_000_000_000);
  });

  it('a grant naming connectors without a tenant reads nothing, not everything', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    await dispatch(
      { action: 'test.context', input: {} },
      { access: { ...baseAccess, connectors: ['trello'] } }
    );
    expect(read()?.readAllowance).toEqual({ connectors: [], tenantId: null });
  });

  it('keeps only an explicit connector-wide read when no tenant is stated', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    await dispatch(
      { action: 'test.context', input: {} },
      {
        access: {
          ...baseAccess,
          connectors: ['chatwork', 'trello'],
          connectorWideRead: ['chatwork'],
          projectRefs: [{ kind: 'project', id: 'owner-workspace' }],
        },
      }
    );
    expect(read()?.readAllowance).toEqual({
      connectors: ['chatwork'],
      wideConnectors: ['chatwork'],
      projectIds: ['owner-workspace'],
      tenantId: null,
      maxObservedMs: null,
    });
  });

  it('a grant naming no connectors reads no raw events', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    await dispatch({ action: 'test.context', input: {} }, { access: { ...baseAccess } });
    expect(read()?.readAllowance?.connectors).toEqual([]);
  });

  it('a window the host composed wins over the derived one', async () => {
    const { dispatch, read } = catalogSeeingItsContext();
    const hostWindow = { connectors: ['slack'], tenantId: 'default' };
    await dispatch(
      { action: 'test.context', input: {} },
      {
        access: { ...baseAccess, connectors: ['trello'], tenantId: 'default' },
        readAllowance: hostWindow,
      }
    );
    expect(read()?.readAllowance).toBe(hostWindow);
  });
});
