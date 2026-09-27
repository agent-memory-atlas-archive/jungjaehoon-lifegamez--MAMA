import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DiscordConnector } from '../../src/connectors/discord/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

const roots: string[] = [];
let stateFilePath = '';

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    channels: {
      '111222333444555': { role: 'hub', name: 'project-channel' },
      '999888777666555': { role: 'ignore', name: 'ignored-fixture' },
      '000111222333444': { role: 'ignore', name: 'noise' },
    },
    auth: {
      type: 'token',
      tokenName: 'MAMA_DISCORD_TOKEN',
    },
    ...overrides,
  };
}

function makeConnector(config: ConnectorConfig = makeConfig()): DiscordConnector {
  return new DiscordConnector(config, stateFilePath);
}

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: '987654321098765432',
    content: 'Hello from Discord',
    timestamp: '2023-11-14T22:13:21.000Z',
    author: {
      id: '123456789012345678',
      username: 'fixture-user',
      bot: false,
    },
    ...overrides,
  };
}

function makeOkResponse(messages: unknown[]) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue(messages),
  };
}

describe('DiscordConnector', () => {
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'discord-connector-test-'));
    roots.push(root);
    stateFilePath = join(root, 'discord-state.json');
    vi.restoreAllMocks();
    vi.stubEnv('MAMA_DISCORD_TOKEN', 'fixture-discord-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  describe('name and type', () => {
    it('has name "discord"', () => {
      const connector = makeConnector(makeConfig());
      expect(connector.name).toBe('discord');
    });

    it('has type "api"', () => {
      const connector = makeConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns token auth requirement with MAMA_DISCORD_TOKEN', () => {
      const connector = makeConnector(makeConfig());
      const reqs = connector.getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('token');
      expect(reqs[0]?.tokenName).toBe('MAMA_DISCORD_TOKEN');
    });
  });

  describe('init', () => {
    it('initializes successfully with a token', async () => {
      const connector = makeConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when token is missing', async () => {
      const connector = makeConnector(
        makeConfig({ auth: { type: 'token', tokenName: 'MAMA_DISCORD_TOKEN' } })
      );
      vi.stubEnv('MAMA_DISCORD_TOKEN', '');
      await expect(connector.init()).rejects.toThrow(/token/i);
      vi.stubEnv('MAMA_DISCORD_TOKEN', 'fixture-discord-token');
    });
  });

  describe('authenticate', () => {
    it('returns true when /users/@me responds with 200', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const connector = makeConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(true);
    });

    it('returns false when response is not ok', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
      const connector = makeConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });

    it('returns false when not initialized', async () => {
      const connector = makeConnector(makeConfig());
      expect(await connector.authenticate()).toBe(false);
    });

    it('returns false when fetch throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
      const connector = makeConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(false);
    });

    it('sends Authorization: Bot header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);
      const connector = makeConnector(makeConfig());
      await connector.init();
      await connector.authenticate();
      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers?.['Authorization']).toBe('Bot fixture-discord-token');
    });
  });

  describe('poll', () => {
    it('returns empty array when no messages', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse([])));
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('fails the whole poll when a configured channel fetch fails', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
      const connector = makeConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub' } } })
      );
      await connector.init();

      await expect(connector.poll(new Date(0))).rejects.toThrow(
        /Discord poll failed for 1 of 1 configured channels; last error: channel 111222333444555 page 1 HTTP 503/
      );
      await expect(connector.healthCheck()).resolves.toMatchObject({ healthy: false });
    });

    it('restores the committed channel cursor after connector restart', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(makeOkResponse([makeMessage({ id: '100000000000000001' })]))
        .mockResolvedValueOnce(
          makeOkResponse([
            makeMessage({ id: '100000000000000001' }),
            makeMessage({ id: '100000000000000002' }),
          ])
        );
      vi.stubGlobal('fetch', fetchMock);
      const config = makeConfig({ channels: { '111222333444555': { role: 'hub' } } });
      const first = makeConnector(config);
      await first.init();
      await first.poll(new Date(0));
      await first.dispose();

      const second = makeConnector(config);
      await second.init();
      const items = await second.poll(new Date(0));
      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('111222333444555:100000000000000002');
    });

    it('does not commit the channel cursor when the handoff is aborted', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(makeOkResponse([makeMessage({ id: '100000000000000001' })]))
        .mockResolvedValueOnce(makeOkResponse([makeMessage({ id: '100000000000000001' })]));
      vi.stubGlobal('fetch', fetchMock);
      const connector = makeConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub' } } })
      );
      await connector.init();
      connector.beginPollHandoff();
      await connector.poll(new Date(0));
      connector.abortPollHandoff();
      const items = await connector.poll(new Date(0));

      expect(items).toHaveLength(1);
    });

    it('pages backward through a large initial channel backlog', async () => {
      const newestId = 1_000_000_000_000_000_100n;
      const firstPage = Array.from({ length: 100 }, (_, index) =>
        makeMessage({ id: String(newestId - BigInt(index)) })
      );
      const olderMessage = makeMessage({ id: String(newestId - 100n) });
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(makeOkResponse(firstPage))
        .mockResolvedValueOnce(makeOkResponse([olderMessage]));
      vi.stubGlobal('fetch', fetchMock);
      const connector = makeConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));

      expect(items).toHaveLength(101);
      expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.has('before')).toBe(true);
    });

    it('skips channels with role "ignore"', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeOkResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = makeConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));

      const calledUrls = mockFetch.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(calledUrls.some((u) => u.includes('111222333444555'))).toBe(true);
      expect(calledUrls.some((u) => u.includes('999888777666555'))).toBe(false);
      expect(calledUrls.some((u) => u.includes('000111222333444'))).toBe(false);
    });

    it('filters messages by timestamp > since', async () => {
      const since = new Date('2024-01-01T00:00:00.000Z');
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            makeOkResponse([
              makeMessage({ id: '1', timestamp: '2023-12-31T23:59:59.000Z' }),
              makeMessage({ id: '2', timestamp: '2024-01-01T00:00:01.000Z' }),
            ])
          )
      );
      const connector = makeConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(since);
      expect(items).toHaveLength(1);
      expect(items[0]?.sourceId).toBe('111222333444555:2');
    });

    it('sets sourceId as "channelId:messageId"', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(makeOkResponse([makeMessage({ id: '42' })]))
      );
      const connector = makeConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toBe('111222333444555:42');
    });

    it('sets source to "discord"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse([makeMessage()])));
      const connector = makeConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.source).toBe('discord');
    });

    it('sets author from username', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            makeOkResponse([
              makeMessage({ author: { id: '1', username: 'fixture-person-2', bot: false } }),
            ])
          )
      );
      const connector = makeConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('fixture-person-2');
    });

    it('sets type to "message"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse([makeMessage()])));
      const connector = makeConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.type).toBe('message');
    });

    it('skips bot messages', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            makeOkResponse([makeMessage({ author: { id: '1', username: 'mybot', bot: true } })])
          )
      );
      const connector = makeConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(0);
    });

    it('skips messages without content', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(makeOkResponse([makeMessage({ content: '' })]))
      );
      const connector = makeConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub', name: 'proj' } } })
      );
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(0);
    });

    it('sends Authorization: Bot header', async () => {
      const mockFetch = vi.fn().mockResolvedValue(makeOkResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = makeConnector(
        makeConfig({ channels: { '111222333444555': { role: 'hub' } } })
      );
      await connector.init();
      await connector.poll(new Date(0));
      const headers = mockFetch.mock.calls[0]?.[1]?.headers as Record<string, string>;
      expect(headers?.['Authorization']).toBe('Bot fixture-discord-token');
    });
  });

  describe('healthCheck', () => {
    it('returns healthy after successful poll', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse([])));
      const connector = makeConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('tracks lastPollTime after poll', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeOkResponse([])));
      const connector = makeConnector(makeConfig());
      await connector.init();
      const before = new Date();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.lastPollTime).not.toBeNull();
      expect(health.lastPollTime!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    });
  });

  describe('dispose', () => {
    it('clears token so authenticate returns false', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
      const connector = makeConnector(makeConfig());
      await connector.init();
      await connector.dispose();
      expect(await connector.authenticate()).toBe(false);
    });
  });
});
