/**
 * SlackConnector — polls Slack channels through the Slack Web API client.
 * Auth token is read from the daemon environment.
 */

import type { WebClient } from '@slack/web-api';

import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';

export class SlackConnector implements IConnector {
  readonly name = 'slack';
  readonly type = 'api' as const;

  private readonly config: ConnectorConfig;
  private client: WebClient | null = null;
  private readonly userCache = new Map<string, string>();
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined;

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  async init(): Promise<void> {
    const token = process.env[this.config.auth.tokenName ?? 'SLACK_BOT_TOKEN'];
    if (!token) {
      throw new Error('Slack bot token not found in the daemon environment.');
    }
    const { WebClient } = await import('@slack/web-api');
    this.client = new WebClient(token);
  }

  async dispose(): Promise<void> {
    this.client = null;
    this.userCache.clear();
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.client !== null && this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [
      {
        type: 'token',
        tokenName: 'SLACK_BOT_TOKEN',
        description: 'Slack bot token with history and user lookup access.',
      },
    ];
  }

  async authenticate(): Promise<boolean> {
    try {
      if (!this.client) return false;
      await this.client.auth.test();
      return true;
    } catch {
      return false;
    }
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached !== undefined) return cached;
    if (!this.client) return userId;
    try {
      const result = await this.client.users.info({ user: userId });
      const name = result.user?.real_name ?? result.user?.name ?? userId;
      this.userCache.set(userId, name);
      return name;
    } catch {
      this.userCache.set(userId, userId);
      return userId;
    }
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    if (!this.client) throw new Error('SlackConnector not initialized');

    const items: NormalizedItem[] = [];
    let hadError = false;
    const oldest = (since.getTime() / 1000).toFixed(6);

    for (const [channelId, channelConfig] of Object.entries(this.config.channels)) {
      if (channelConfig.role === 'ignore') continue;
      try {
        let cursor: string | undefined;
        do {
          const result = await this.client.conversations.history({
            channel: channelId,
            oldest,
            limit: 200,
            ...(cursor === undefined ? {} : { cursor }),
          });
          for (const message of result.messages ?? []) {
            if (
              message.bot_id ||
              message.subtype === 'bot_message' ||
              !message.user ||
              !message.text
            ) {
              continue;
            }
            const timestamp = new Date(Number(message.ts) * 1000);
            if (!Number.isFinite(timestamp.getTime()) || timestamp.getTime() <= since.getTime())
              continue;
            items.push({
              source: 'slack',
              sourceId: `${channelId}:${message.ts}`,
              channel: channelConfig.name ?? channelId,
              author: await this.resolveUserName(message.user),
              content: message.text,
              timestamp,
              type: 'message',
              metadata: {
                channelId,
                ts: message.ts,
                ...(message.thread_ts === undefined ? {} : { threadTs: message.thread_ts }),
              },
            });
          }
          cursor = result.response_metadata?.next_cursor || undefined;
        } while (cursor !== undefined);
      } catch (error) {
        hadError = true;
        this.lastError = error instanceof Error ? error.message : String(error);
      }
    }

    if (hadError) throw new Error('Slack poll failed for one or more configured channels');
    items.sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    this.lastError = undefined;
    return items;
  }
}
