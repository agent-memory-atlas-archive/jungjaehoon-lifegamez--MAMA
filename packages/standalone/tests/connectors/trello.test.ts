import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TrelloConnector } from '../../src/connectors/trello/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

let root: string;
const envName = 'MAMA_TRELLO_TOKEN';
const config: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { 'channel-key': { role: 'truth', name: 'board-display', boardId: 'board-key' } },
  auth: { type: 'token', tokenName: envName },
};

function lists(cards: unknown[]): unknown[] {
  return [{ id: 'list-key', name: 'list-display', cards }];
}

describe('TrelloConnector', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'trello-connector-'));
    vi.stubEnv('HOME', root);
    vi.stubEnv('MAMA_TRELLO_KEY', 'fixture-key');
    vi.stubEnv(envName, 'fixture-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  it('uses separately stored MAMA_TRELLO_KEY and MAMA_TRELLO_TOKEN', async () => {
    vi.stubEnv('MAMA_TRELLO_KEY', 'fixture-separate-key');
    vi.stubEnv('MAMA_TRELLO_TOKEN', 'fixture-separate-token');
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      expect(parsed.searchParams.get('key') === 'fixture-separate-key').toBe(true);
      expect(parsed.searchParams.get('token') === 'fixture-separate-token').toBe(true);
      return { ok: true };
    });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new TrelloConnector(
      { ...config, auth: { type: 'token', tokenName: 'MAMA_TRELLO_TOKEN' } },
      join(root, 'state.json')
    );
    await connector.init();
    expect(await connector.authenticate()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit state file path', () => {
    expect(() => new TrelloConnector(config, undefined as unknown as string)).toThrow(
      /state file path/i
    );
  });

  it('filters the initial poll by card activity time', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        lists([
          {
            id: 'old-card',
            name: 'old',
            idMembers: [],
            labels: [],
            dateLastActivity: '2023-12-31T23:59:59.000Z',
          },
          {
            id: 'new-card',
            name: 'new',
            idMembers: [],
            labels: [],
            dateLastActivity: '2024-01-01T00:00:01.000Z',
          },
        ]),
    });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new TrelloConnector(config, join(root, 'state.json'));
    await connector.init();
    const items = await connector.poll(new Date('2024-01-01T00:00:00.000Z'));
    expect(items.map((item) => item.sourceId)).toEqual(['board-key:new-card:1704067201000']);
  });

  it('stages card state until the poll handoff is committed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () =>
        lists([
          {
            id: 'card-key',
            name: 'card',
            idMembers: [],
            labels: [],
            dateLastActivity: '2024-01-01T00:00:01.000Z',
          },
        ]),
    });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new TrelloConnector(config, join(root, 'state.json'));
    await connector.init();
    connector.beginPollHandoff?.();
    await connector.poll(new Date(0));
    connector.abortPollHandoff?.();
    connector.beginPollHandoff?.();
    expect(await connector.poll(new Date(0))).toHaveLength(1);
    connector.commitPoll?.();
    expect(await connector.poll(new Date(0))).toHaveLength(0);
  });
});
