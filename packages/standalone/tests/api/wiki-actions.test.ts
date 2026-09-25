/**
 * manage.wiki.* action registrations — the §4.2 adapter seam for the wiki lane.
 * The vault binding, page publisher and per-attempt coverage stay host-owned;
 * the catalog reaches them through injected ports. These tests pin the contract
 * (unbound ports, caller-forged authority, contiguous-read coverage) through the
 * real dispatcher — not the executor's tool names.
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCatalog, createDispatcher, type ActionContext } from '@jungjaehoon/mama-core';
import { wikiActionRegistrations, type WikiPorts } from '../../src/api/wiki-actions.js';
import { wikiContentVersion } from '../../src/wiki/wiki-read.js';

const OWNER_DATE = '2026-09-06';

const ownerAccess: ActionContext['access'] = {
  // Dispatch compares the call against this grant; these are the actions
  // this file calls.
  actions: ['manage.wiki.publish', 'manage.wiki.read'],
  principalId: 'principal_owner_1',
  agentId: 'agent',
  scopes: [],
};

const wikiRange = {
  ownerDate: OWNER_DATE,
  rangeStartMs: Date.parse('2026-09-05T15:00:00.000Z'),
  rangeEndMs: Date.parse('2026-09-06T15:00:00.000Z'),
  connectors: ['slack'],
  updatedSince: '2026-09-05T15:00:00.000Z',
  updatedBefore: '2026-09-06T15:00:00.000Z',
};

function dispatch(ports: WikiPorts) {
  return createDispatcher(createCatalog(wikiActionRegistrations(ports)));
}

function vault(): string {
  const root = mkdtempSync(join(tmpdir(), 'mama-wiki-actions-'));
  mkdirSync(join(root, 'daily'));
  writeFileSync(join(root, 'Home.md'), '# Home');
  return root;
}

describe('manage.wiki.* action registrations', () => {
  it('advertises publish page objects and relative markdown read paths', async () => {
    const contracts = createCatalog(wikiActionRegistrations({})).list();
    const publish = contracts.find((contract) => contract.name === 'manage.wiki.publish');
    const page = publish?.inputSchema.properties?.pages.items;
    expect(page?.required).toEqual(['path', 'title', 'content']);
    expect(page?.properties?.content).toMatchObject({ type: 'string' });
    expect(page?.properties?.expectedContentVersion).toMatchObject({ oneOf: expect.any(Array) });
    const read = contracts.find((contract) => contract.name === 'manage.wiki.read');
    const pathPattern = read?.inputSchema.properties?.paths.items?.pattern;
    expect(new RegExp(pathPattern!).test('work/current.md')).toBe(true);
    expect(new RegExp(pathPattern!).test('work/current')).toBe(false);

    const publisher = vi.fn();
    const result = await dispatch({ publisher })(
      { action: 'manage.wiki.publish', input: { pages: ['work/current.md'] } },
      { access: ownerAccess }
    );
    expect(result).toMatchObject({ status: 'failed', error: { kind: 'invalid_input' } });
    expect(publisher).not.toHaveBeenCalled();
  });

  it('lists the read and publish actions', () => {
    const names = createCatalog(wikiActionRegistrations({}))
      .list()
      .map((contract) => contract.name);
    expect(names.sort()).toEqual(['manage.wiki.publish', 'manage.wiki.read']);
  });

  it('unbound wiki resources fail explicitly', async () => {
    const call = dispatch({});
    const read = await call(
      { action: 'manage.wiki.read', input: { paths: ['Home.md'] } },
      { access: ownerAccess }
    );
    expect(read).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_ERROR', message: expect.stringMatching(/vault path not configured/) },
    });
    const publish = await call(
      {
        action: 'manage.wiki.publish',
        input: { pages: [{ path: 'x.md', title: 't', type: 'entity', content: 'c' }] },
      },
      { access: ownerAccess, session: {} }
    );
    expect(publish).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_ERROR', message: expect.stringMatching(/publisher not configured/) },
    });
  });

  it('publish without a bound publisher reports the missing port through dispatch', async () => {
    const call = dispatch({});
    const result = await call(
      {
        action: 'manage.wiki.publish',
        input: { pages: [{ path: 'wiki/a', title: 'A', type: 'entity', content: 'x' }] },
      },
      { access: ownerAccess }
    );
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'TOOL_ERROR', message: expect.stringMatching(/publisher not configured/i) },
    });
  });

  it('input cannot grant an action and version preconditions reach the publisher unchanged', async () => {
    const publisher = vi.fn();
    const call = dispatch({ publisher });
    const forged = {
      pages: [
        {
          path: 'daily/2026-09-05.md',
          expectedContentVersion: null,
          title: 'forged',
          type: 'daily',
          content: 'c',
        },
      ],
      wikiTaskRange: wikiRange,
      workorderAttemptId: 7,
    };
    const result = await call(
      { action: 'manage.wiki.publish', input: forged },
      { access: ownerAccess }
    );
    expect(result).toMatchObject({ status: 'completed', data: { success: true } });
    expect(publisher).toHaveBeenCalledWith([
      expect.objectContaining({ expectedContentVersion: null }),
    ]);
    publisher.mockClear();
    const denied = await call(
      { action: 'manage.wiki.publish', input: forged },
      { access: { ...ownerAccess, actions: [] } }
    );
    expect(denied.status).not.toBe('completed');
    expect(publisher).not.toHaveBeenCalled();
  });

  it('manage.wiki.read without authority keeps the bounded plain-read contract', async () => {
    const root = vault();
    writeFileSync(join(root, 'daily', '2020-01-01.md'), 'historical evidence');
    const call = dispatch({ vault: { path: root, name: null } });
    const result = await call(
      {
        action: 'manage.wiki.read',
        input: { paths: ['daily/2020-01-01.md'], content_limit: 4 },
      },
      { access: ownerAccess }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { success: true, pages: [{ content: 'hist' }] },
    });
    const foreign = await call(
      { action: 'manage.wiki.read', input: { paths: ['../foreign.md'] } },
      { access: ownerAccess }
    );
    expect(foreign).toMatchObject({ status: 'failed', error: { code: 'TOOL_ERROR' } });
  });

  it('lists real wiki paths in bounded versioned pages before an exact read', async () => {
    const root = vault();
    const outside = mkdtempSync(join(tmpdir(), 'mama-wiki-outside-'));
    try {
      writeFileSync(join(root, 'daily', '2020-01-01.md'), 'dated');
      writeFileSync(join(root, 'index.md'), '# navigation');
      writeFileSync(join(root, 'log.md'), 'history');
      writeFileSync(join(outside, 'private.md'), 'outside');
      symlinkSync(join(outside, 'private.md'), join(root, 'linked.md'));
      const call = dispatch({ vault: { path: root, name: null } });

      const first = await call(
        { action: 'manage.wiki.read', input: { list_limit: 2 } },
        { access: ownerAccess }
      );
      expect(first).toMatchObject({
        status: 'completed',
        data: {
          paths: ['Home.md', 'daily/2020-01-01.md'],
          returned: 2,
          total: 4,
          nextCursor: 'daily/2020-01-01.md',
          readVersion: expect.any(String),
        },
      });
      const listed = first.data as { nextCursor: string; readVersion: string };
      const next = await call(
        {
          action: 'manage.wiki.read',
          input: {
            list_cursor: listed.nextCursor,
            list_version: listed.readVersion,
            list_limit: 2,
          },
        },
        { access: ownerAccess }
      );
      expect(next).toMatchObject({
        status: 'completed',
        data: { paths: ['index.md', 'log.md'], nextCursor: null, readVersion: listed.readVersion },
      });
      const index = await call(
        { action: 'manage.wiki.read', input: { paths: ['index.md'] } },
        { access: ownerAccess }
      );
      expect(index).toMatchObject({
        status: 'completed',
        data: { pages: [{ path: 'index.md', content: '# navigation' }] },
      });

      writeFileSync(join(root, 'daily', '2021-01-01.md'), 'new');
      const stale = await call(
        {
          action: 'manage.wiki.read',
          input: { list_cursor: listed.nextCursor, list_version: listed.readVersion },
        },
        { access: ownerAccess }
      );
      expect(stale).toMatchObject({
        status: 'failed',
        error: { code: 'TOOL_ERROR', message: expect.stringMatching(/list.*changed|restart/i) },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('a bound publishAdapter overrides the default publisher seam', async () => {
    const publishAdapter = { publish: vi.fn(() => ({ pagesPublished: 1, artifactsStored: 3 })) };
    const call = dispatch({ publisher: null, publishAdapter });
    const result = await call(
      {
        action: 'manage.wiki.publish',
        input: { pages: [{ path: 'wiki/a', title: 'A', type: 'entity', content: 'x' }] },
      },
      { access: ownerAccess }
    );
    expect(result).toMatchObject({
      status: 'completed',
      data: { success: true, artifactsStored: 3 },
    });
    expect(publishAdapter.publish).toHaveBeenCalledOnce();
  });

  it('wikiContentVersion still keys the read/publish version contract', () => {
    expect(wikiContentVersion('# Home')).toEqual(expect.any(String));
  });
});
