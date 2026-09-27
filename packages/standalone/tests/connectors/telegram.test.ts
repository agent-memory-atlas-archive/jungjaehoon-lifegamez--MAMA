import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TelegramConnector } from '../../src/connectors/telegram/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

const roots: string[] = [];
let stateFilePath = '';

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    enabled: true,
    pollIntervalMinutes: 5,
    channels: {
      '-1001234567890': { role: 'hub', name: 'project-chat' },
      '-1009999999999': { role: 'ignore', name: 'noise' },
    },
    auth: {
      type: 'token',
      tokenName: 'MAMA_TELEGRAM_SOURCE_TOKEN',
    },
    ...overrides,
  };
}

function makeConnector(config: ConnectorConfig = makeConfig()): TelegramConnector {
  return new TelegramConnector(config, stateFilePath);
}

function makeUpdate(overrides: Record<string, unknown> = {}) {
  return {
    update_id: 100001,
    message: {
      message_id: 42,
      from: { id: 111, first_name: 'fixture-person', username: 'fixture-user' },
      date: 1700000001,
      text: 'Hello from Telegram',
      chat: { id: -1001234567890, type: 'supergroup', title: 'Project Chat' },
    },
    ...overrides,
  };
}

function makeGetUpdatesResponse(updates: unknown[]) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({ ok: true, result: updates }),
  };
}

describe('TelegramConnector', () => {
  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-source-test-'));
    roots.push(root);
    stateFilePath = join(root, 'telegram-state.json');
    vi.restoreAllMocks();
    vi.stubEnv('MAMA_TELEGRAM_SOURCE_TOKEN', 'fixture-source-token');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  describe('name and type', () => {
    it('has name "telegram"', () => {
      const connector = makeConnector(makeConfig());
      expect(connector.name).toBe('telegram');
    });

    it('has type "api"', () => {
      const connector = makeConnector(makeConfig());
      expect(connector.type).toBe('api');
    });
  });

  describe('getAuthRequirements', () => {
    it('returns token auth requirement with MAMA_TELEGRAM_SOURCE_TOKEN', () => {
      const connector = makeConnector(makeConfig());
      const reqs = connector.getAuthRequirements();
      expect(reqs).toHaveLength(1);
      expect(reqs[0]?.type).toBe('token');
      expect(reqs[0]?.tokenName).toBe('MAMA_TELEGRAM_SOURCE_TOKEN');
    });
  });

  describe('init', () => {
    it('initializes successfully with a token', async () => {
      const connector = makeConnector(makeConfig());
      await expect(connector.init()).resolves.toBeUndefined();
    });

    it('throws when token is missing', async () => {
      const connector = makeConnector(
        makeConfig({ auth: { type: 'token', tokenName: 'MAMA_TELEGRAM_SOURCE_TOKEN' } })
      );
      vi.stubEnv('MAMA_TELEGRAM_SOURCE_TOKEN', '');
      await expect(connector.init()).rejects.toThrow(/token/i);
      vi.stubEnv('MAMA_TELEGRAM_SOURCE_TOKEN', 'fixture-source-token');
    });
  });

  describe('authenticate', () => {
    it('returns true when getMe responds with ok=true', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ ok: true, result: { id: 1 } }),
        })
      );
      const connector = makeConnector(makeConfig());
      await connector.init();
      expect(await connector.authenticate()).toBe(true);
    });

    it('returns false when fetch returns ok=false', async () => {
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
  });

  describe('poll', () => {
    it('returns empty array when no updates', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([])));
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toEqual([]);
    });

    it('uses update ids as the cursor instead of filtering by timestamp', async () => {
      const since = new Date('2024-01-01T00:00:00.000Z'); // epoch 1704067200
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          makeGetUpdatesResponse([
            makeUpdate({
              update_id: 1,
              message: { ...makeUpdate().message, message_id: 1, date: 1704067199 },
            }),
            makeUpdate({
              update_id: 2,
              message: { ...makeUpdate().message, message_id: 2, date: 1704067201 },
            }),
          ])
        )
      );
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(since);
      expect(items).toHaveLength(2);
      expect(items[1]?.timestamp.getTime()).toBe(1704067201 * 1000);
    });

    it('pages the update cursor and keeps messages in the since second', async () => {
      const since = new Date('2024-01-01T00:00:00.000Z');
      const first = Array.from({ length: 100 }, (_, index) =>
        makeUpdate({
          update_id: index + 1,
          message: { ...makeUpdate().message, message_id: index + 1, date: 1704067200 },
        })
      );
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(makeGetUpdatesResponse(first))
        .mockResolvedValueOnce(
          makeGetUpdatesResponse([
            makeUpdate({
              update_id: 101,
              message: { ...makeUpdate().message, message_id: 101, date: 1704067200 },
            }),
          ])
        );
      vi.stubGlobal('fetch', fetchMock);
      const connector = makeConnector(makeConfig());
      await connector.init();
      expect(await connector.poll(since)).toHaveLength(101);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(new URL(String(fetchMock.mock.calls[1]?.[0])).searchParams.get('offset')).toBe('101');
    });

    it('sets sourceId as "chatId:messageId"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([makeUpdate()])));
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.sourceId).toBe('-1001234567890:42');
    });

    it('sets source to "telegram"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([makeUpdate()])));
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.source).toBe('telegram');
    });

    it('sets author from first_name', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([makeUpdate()])));
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.author).toBe('fixture-person');
    });

    it('sets type to "message"', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([makeUpdate()])));
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items[0]?.type).toBe('message');
    });

    it('skips updates without message', async () => {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(
            makeGetUpdatesResponse([{ update_id: 200, edited_message: { text: 'edited' } }])
          )
      );
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(0);
    });

    it('skips messages without text', async () => {
      const update = makeUpdate();
      // Remove text from the message
      const msgWithoutText = { ...update.message };
      delete (msgWithoutText as Record<string, unknown>)['text'];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(makeGetUpdatesResponse([{ ...update, message: msgWithoutText }]))
      );
      const connector = makeConnector(makeConfig());
      await connector.init();
      const items = await connector.poll(new Date(0));
      expect(items).toHaveLength(0);
    });

    it('advances offset after poll', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValue(makeGetUpdatesResponse([makeUpdate({ update_id: 999 })]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = makeConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      // Second poll should use offset=1000
      await connector.poll(new Date(0));
      const secondCallUrl = String(mockFetch.mock.calls[1]?.[0]);
      expect(secondCallUrl).toContain('offset=1000');
    });

    it('pages all update batches inside a handoff and commits the final cursor only once', async () => {
      const firstPageUpdates = Array.from({ length: 100 }, (_, index) =>
        makeUpdate({
          update_id: index + 1,
          message: {
            ...makeUpdate().message,
            message_id: index + 1,
          },
        })
      );
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeGetUpdatesResponse(firstPageUpdates))
        .mockResolvedValueOnce(makeGetUpdatesResponse([makeUpdate({ update_id: 101 })]))
        .mockResolvedValueOnce(makeGetUpdatesResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = makeConnector(makeConfig());
      await connector.init();
      connector.beginPollHandoff();
      const firstPage = await connector.poll(new Date(0));
      expect(firstPage).toHaveLength(101);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(String(mockFetch.mock.calls[1]?.[0])).toContain('offset=101');
      connector.commitPoll();
      const secondPage = await connector.poll(new Date(0));
      expect(secondPage).toHaveLength(0);
      expect(String(mockFetch.mock.calls[2]?.[0])).toContain('offset=102');
    });

    it('does not commit the update offset when the handoff is aborted', async () => {
      const fullPage = Array.from({ length: 100 }, (_, index) =>
        makeUpdate({
          update_id: index + 1,
          message: { ...makeUpdate().message, message_id: index + 1 },
        })
      );
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeGetUpdatesResponse(fullPage))
        .mockResolvedValueOnce(makeGetUpdatesResponse([]))
        .mockResolvedValueOnce(makeGetUpdatesResponse(fullPage))
        .mockResolvedValueOnce(makeGetUpdatesResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const connector = makeConnector(makeConfig());
      await connector.init();
      connector.beginPollHandoff();
      expect(await connector.poll(new Date(0))).toHaveLength(100);
      connector.abortPollHandoff();
      const repeated = await connector.poll(new Date(0));

      expect(repeated).toHaveLength(100);
      expect(String(mockFetch.mock.calls[2]?.[0])).toContain('offset=0');
    });

    it('restores the committed update offset after connector restart', async () => {
      const mockFetch = vi
        .fn()
        .mockResolvedValueOnce(makeGetUpdatesResponse([makeUpdate({ update_id: 999 })]))
        .mockResolvedValueOnce(makeGetUpdatesResponse([]));
      vi.stubGlobal('fetch', mockFetch);
      const config = makeConfig();
      const first = makeConnector(config);
      await first.init();
      await first.poll(new Date(0));
      await first.dispose();

      const second = makeConnector(config);
      await second.init();
      await second.poll(new Date(0));
      expect(String(mockFetch.mock.calls[1]?.[0])).toContain('offset=1000');
    });

    it('fails the poll on a failed getUpdates page', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
      const connector = makeConnector(makeConfig());
      await connector.init();

      await expect(connector.poll(new Date(0))).rejects.toThrow(
        /Telegram poll failed while reading update pages; last error: getUpdates HTTP 503/
      );
      await expect(connector.healthCheck()).resolves.toMatchObject({ healthy: false });
    });
  });

  describe('healthCheck', () => {
    it('returns healthy after successful poll', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([])));
      const connector = makeConnector(makeConfig());
      await connector.init();
      await connector.poll(new Date(0));
      const health = await connector.healthCheck();
      expect(health.healthy).toBe(true);
    });

    it('tracks lastPollTime after poll', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(makeGetUpdatesResponse([])));
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
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ ok: true }),
        })
      );
      const connector = makeConnector(makeConfig());
      await connector.init();
      await connector.dispose();
      expect(await connector.authenticate()).toBe(false);
    });
  });
});
