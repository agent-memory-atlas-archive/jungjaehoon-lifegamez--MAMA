import { createHash } from 'node:crypto';
import type {
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';
import { readConnectorState, writeConnectorState } from '../framework/connector-state.js';
import { parseICalendar } from './parser.js';

export class ICalConnector implements IConnector {
  readonly name = 'ical';
  readonly type = 'api' as const;
  private readonly feeds: Array<{ key: string; name: string; envName: string }>;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined;
  private readonly synced: Set<string>;
  private pendingSynced: Set<string> | null = null;

  constructor(
    config: ConnectorConfig,
    private readonly statePath: string
  ) {
    this.feeds = Object.entries(config.channels).map(([key, channel]) => ({
      key,
      name: channel.feedName ?? channel.name ?? key,
      envName: `MAMA_ICAL_URL_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`,
    }));
    this.synced = new Set(
      readConnectorState(statePath, (value) => {
        const synced = (value as { synced?: unknown } | null)?.synced;
        if (!Array.isArray(synced) || !synced.every((key) => typeof key === 'string')) {
          throw new Error('iCal connector state must list synced feed keys');
        }
        return synced as string[];
      }) ?? []
    );
  }
  commitPoll(): void {
    if (this.pendingSynced === null) return;
    for (const key of this.pendingSynced) this.synced.add(key);
    this.pendingSynced = null;
    writeConnectorState(this.statePath, { synced: [...this.synced].sort() });
  }
  abortPollHandoff(): void {
    this.pendingSynced = null;
  }
  async init(): Promise<void> {
    for (const feed of this.feeds) {
      if (!process.env[feed.envName])
        throw new Error(`iCal feed ${feed.name} has no ${feed.envName} secret`);
    }
  }
  async dispose(): Promise<void> {}
  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }
  getAuthRequirements() {
    return this.feeds.map((feed) => ({
      type: 'token' as const,
      tokenName: feed.envName,
      description: `Secret URL for iCal feed ${feed.name}`,
    }));
  }
  async authenticate(): Promise<boolean> {
    return this.feeds.every((feed) => Boolean(process.env[feed.envName]));
  }
  async poll(_since: Date): Promise<NormalizedItem[]> {
    const output: NormalizedItem[] = [];
    try {
      const pendingSynced = new Set<string>();
      for (const feed of this.feeds) {
        const url = process.env[feed.envName];
        if (!url) throw new Error(`iCal feed ${feed.name} has no configured secret`);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20_000);
        let response: Response;
        try {
          response = await fetch(url, { signal: controller.signal });
        } catch {
          clearTimeout(timeout);
          throw new Error(`iCal feed ${feed.name} fetch failed`);
        }
        if (!response.ok) {
          clearTimeout(timeout);
          throw new Error(`iCal feed ${feed.name} fetch failed with HTTP ${response.status}`);
        }
        let body: string;
        try {
          body = await response.text();
        } catch {
          clearTimeout(timeout);
          throw new Error(`iCal feed ${feed.name} response could not be read`);
        }
        clearTimeout(timeout);
        let events;
        try {
          events = parseICalendar(body);
        } catch {
          throw new Error(`iCal feed ${feed.name} parse failed: invalid calendar data`);
        }
        for (const event of events) {
          const fields = { ...event, feedName: feed.name, feedKey: feed.key };
          const { revisionTime: _revisionTime, ...revisionFields } = fields;
          const version = createHash('sha256')
            .update(JSON.stringify(revisionFields))
            .digest('hex')
            .slice(0, 24);
          output.push({
            source: 'ical',
            sourceId: `${feed.key}:${event.uid}:${version}`,
            sourceEntityId: `${feed.key}:${event.uid}`,
            channel: feed.key,
            author: 'unknown',
            content: `${event.summary} | ${event.start} ~ ${event.end}`,
            timestamp: new Date(event.revisionTime),
            type: 'event',
            sourceCursor: version,
            metadata: {
              ...fields,
              start: event.start,
              end: event.end,
              summary: event.summary,
              status: event.status,
            },
            ...(!this.synced.has(feed.key) ? { collectOnly: true } : {}),
          });
        }
        pendingSynced.add(feed.key);
      }
      this.pendingSynced = pendingSynced;
      this.lastPollTime = new Date();
      this.lastPollCount = output.length;
      this.lastError = undefined;
      return output;
    } catch (error) {
      this.lastPollTime = new Date();
      this.lastPollCount = 0;
      this.lastError = error instanceof Error ? error.message : String(error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
