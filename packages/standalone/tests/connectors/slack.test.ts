import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SlackConnector } from '../../src/connectors/slack/index.js';
import type { ConnectorConfig } from '../../src/connectors/framework/types.js';

const slack = vi.hoisted(() => ({
  WebClient: vi.fn(),
  authTest: vi.fn(),
  history: vi.fn(),
  usersInfo: vi.fn(),
}));

vi.mock('@slack/web-api', () => ({ WebClient: slack.WebClient }));

const envName = 'SLACK_BOT_TOKEN';
const config: ConnectorConfig = {
  enabled: true,
  pollIntervalMinutes: 5,
  channels: { 'channel-key': { role: 'hub', name: 'channel-display' } },
  auth: { type: 'token', tokenName: envName },
};

describe('SlackConnector', () => {
  beforeEach(() => {
    process.env[envName] = 'fixture-slack-token';
    slack.WebClient.mockImplementation(() => ({
      auth: { test: slack.authTest },
      conversations: { history: slack.history },
      users: { info: slack.usersInfo },
    }));
    slack.authTest.mockResolvedValue({ ok: true });
    slack.history.mockReset();
    slack.usersInfo.mockReset();
  });

  afterEach(() => {
    delete process.env[envName];
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('polls paginated history through the SDK and resolves authors', async () => {
    slack.history
      .mockResolvedValueOnce({
        messages: [{ ts: '20.000', user: 'user-key', text: 'source-content' }],
        response_metadata: { next_cursor: 'next-page' },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: '21.000', user: 'user-key', text: 'second-content' }],
        response_metadata: { next_cursor: '' },
      });
    slack.usersInfo.mockResolvedValue({ user: { real_name: 'actor-a' } });
    const connector = new SlackConnector(config);
    await connector.init();
    expect(slack.WebClient).toHaveBeenCalledWith('fixture-slack-token');
    const items = await connector.poll(new Date(15_000));
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      source: 'slack',
      channel: 'channel-display',
      author: 'actor-a',
    });
    expect(slack.history).toHaveBeenNthCalledWith(1, {
      channel: 'channel-key',
      oldest: '15.000000',
      limit: 200,
    });
    expect(slack.history).toHaveBeenNthCalledWith(2, {
      channel: 'channel-key',
      oldest: '15.000000',
      limit: 200,
      cursor: 'next-page',
    });
  });

  it('skips bot messages and ignored channels', async () => {
    slack.history.mockResolvedValue({
      messages: [
        { ts: '20.000', user: 'user-key', text: 'bot', bot_id: 'bot-key' },
        { ts: '21.000', user: 'user-key', text: 'human' },
      ],
      response_metadata: { next_cursor: '' },
    });
    const connector = new SlackConnector({
      ...config,
      channels: {
        'channel-key': { role: 'hub' },
        ignored: { role: 'ignore' },
      },
    });
    await connector.init();
    expect(slack.WebClient).toHaveBeenCalledWith('fixture-slack-token');
    const items = await connector.poll(new Date(0));
    expect(items.map((item) => item.content)).toEqual(['human']);
    expect(slack.history.mock.calls.filter(([input]) => input.channel === 'ignored')).toHaveLength(
      0
    );
  });

  it('fails the whole poll when one room fails without advancing poll state', async () => {
    slack.history.mockImplementation(async ({ channel }: { channel: string }) => {
      if (channel === 'failed-channel') throw new Error('room request failed');
      return { messages: [], response_metadata: { next_cursor: '' } };
    });
    const connector = new SlackConnector({
      ...config,
      channels: {
        'working-channel': { role: 'hub' },
        'failed-channel': { role: 'hub' },
      },
    });
    await connector.init();

    await expect(connector.poll(new Date(0))).rejects.toThrow(/one or more configured channels/i);
    expect(await connector.healthCheck()).toMatchObject({
      lastPollTime: null,
      lastPollCount: 0,
      error: 'room request failed',
    });
  });
});
