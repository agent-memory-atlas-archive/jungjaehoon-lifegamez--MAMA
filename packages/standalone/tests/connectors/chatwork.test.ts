import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatworkConnector } from '../../src/connectors/chatwork/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

const envName = 'CHATWORK_API_TOKEN';
const config: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { 'room-key': { role: 'hub', name: 'room-display' } },
  auth: { type: 'token', tokenName: envName },
};

describe('ChatworkConnector', () => {
  beforeEach(() => {
    process.env[envName] = 'fixture-chatwork-token';
  });

  afterEach(() => {
    delete process.env[envName];
    vi.unstubAllGlobals();
  });

  it('reads the token from the daemon environment and filters by source time', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [
        {
          message_id: 'old',
          account: { account_id: 1, name: 'actor-old', avatar_image_url: '' },
          body: 'old-content',
          send_time: 10,
          update_time: 10,
        },
        {
          message_id: 'new',
          account: { account_id: 2, name: 'actor-new', avatar_image_url: '' },
          body: 'new-content',
          send_time: 20,
          update_time: 20,
        },
      ],
    });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new ChatworkConnector(config);
    await connector.init();
    const items = await connector.poll(new Date(15_000));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source: 'chatwork',
      sourceId: 'room-key:new',
      channel: 'room-display',
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { 'X-ChatWorkToken': 'fixture-chatwork-token' },
    });
  });

  it('does not poll ignored rooms', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => [] });
    vi.stubGlobal('fetch', fetchMock);
    const connector = new ChatworkConnector({
      ...config,
      channels: { ignored: { role: 'ignore' } },
    });
    await connector.init();
    await connector.poll(new Date(0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a batch when a configured room fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    const connector = new ChatworkConnector(config);
    await connector.init();
    await expect(connector.poll(new Date(0))).rejects.toThrow(/poll failed/i);
  });
});
