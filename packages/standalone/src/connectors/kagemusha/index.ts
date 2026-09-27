import { canonicalChannelKey } from '../framework/polling-scheduler.js';
import Database from '../../sqlite.js';
import type { SQLiteDatabase } from '../../sqlite.js';
import type {
  AuthRequirement,
  ConnectorConfig,
  ConnectorHealth,
  IConnector,
  NormalizedItem,
} from '../framework/types.js';

interface ChannelMessage {
  id: number | string;
  channel: string;
  channel_id: string;
  user_id: string;
  role: string;
  content: string;
  created_at: number | string;
}

interface KagemushaTask {
  id: number | string;
  title: string;
  status: string;
  priority: string;
  deadline: number | null;
  source_room: string | null;
  auto_created: number;
  updated_at: number | string;
}

const MESSAGE_PAGE_SIZE = 1_000;

function timestamp(value: number | string): number {
  const parsed = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Kagemusha source timestamp is invalid');
  return parsed;
}

export class KagemushaConnector implements IConnector {
  readonly name = 'kagemusha';
  readonly type = 'local' as const;

  private readonly config: ConnectorConfig;
  private readonly dbPath: string;
  private db: SQLiteDatabase | null = null;
  private lastPollTime: Date | null = null;
  private lastPollCount = 0;
  private lastError: string | undefined;

  constructor(config: ConnectorConfig, dbPath: string) {
    if (typeof dbPath !== 'string' || dbPath.trim() === '') {
      throw new Error('Kagemusha source database path is required');
    }
    this.config = config;
    this.dbPath = dbPath;
  }

  async init(): Promise<void> {
    try {
      this.db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    } catch (error) {
      throw new Error(
        `Kagemusha source database could not be opened: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async dispose(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async healthCheck(): Promise<ConnectorHealth> {
    return {
      healthy: this.db !== null && this.lastError === undefined,
      lastPollTime: this.lastPollTime,
      lastPollCount: this.lastPollCount,
      error: this.lastError,
    };
  }

  getAuthRequirements(): AuthRequirement[] {
    return [{ type: 'none', description: 'The local source database requires no token.' }];
  }

  async authenticate(): Promise<boolean> {
    return this.db !== null;
  }

  private channelKey(origin: string, channel: string): string {
    const prefix = `${origin}:`;
    const suffix = channel.startsWith(prefix) ? channel.slice(prefix.length) : channel;
    return `kagemusha:${origin}:${suffix}`;
  }

  private accepts(origin: string, channelId: string): boolean {
    const canonical = this.channelKey(origin, channelId);
    return (
      canonicalChannelKey(
        { source: this.name, channel: canonical },
        { [this.name]: this.config.channels }
      ) !== null
    );
  }

  private messageItem(row: ChannelMessage): NormalizedItem | null {
    const channel = this.channelKey(row.channel, row.channel_id);
    if (!this.accepts(row.channel, row.channel_id)) return null;
    return {
      source: 'kagemusha',
      sourceId: `kagemusha:${row.channel}:${row.channel_id}:${row.id}`,
      sourceEntityId: `kagemusha:${row.channel}:${row.channel_id}:${row.id}`,
      channel,
      author: row.user_id,
      content: row.content,
      timestamp: new Date(timestamp(row.created_at)),
      type: 'message',
      metadata: {
        originalPlatform: row.channel,
        originalChannel: row.channel_id,
        kagemushaMessageId: String(row.id),
        role: row.role,
      },
    };
  }

  private taskItem(row: KagemushaTask): NormalizedItem | null {
    const sourceRoom = row.source_room ?? 'system';
    const channel = this.channelKey('kagemusha-tasks', sourceRoom);
    if (!this.accepts('kagemusha-tasks', sourceRoom)) return null;
    const deadline =
      row.deadline === null ? 'none' : new Date(row.deadline).toISOString().slice(0, 10);
    return {
      source: 'kagemusha',
      sourceId: `kagemusha:task:${row.id}`,
      sourceEntityId: `kagemusha:task:${row.id}`,
      channel,
      author: 'kagemusha',
      content: `[Task] ${row.title} | status:${row.status} | priority:${row.priority} | deadline:${deadline}`,
      timestamp: new Date(timestamp(row.updated_at)),
      type: 'kanban_card',
      metadata: {
        originalPlatform: 'kagemusha-tasks',
        originalChannel: sourceRoom,
        taskId: String(row.id),
        status: row.status,
        priority: row.priority,
        deadline: row.deadline,
        autoCreated: row.auto_created === 1,
      },
    };
  }

  async poll(since: Date): Promise<NormalizedItem[]> {
    if (!this.db) throw new Error('KagemushaConnector not initialized');
    const items: NormalizedItem[] = [];
    let hadError = false;
    try {
      let afterCreatedAt = since.getTime();
      let afterId: number | string = 0;
      let keepPaging = true;
      while (keepPaging) {
        const rows = this.db
          .prepare(
            `SELECT *
               FROM channel_messages
              WHERE role = 'user'
                AND (created_at > ? OR (created_at = ? AND id > ?))
              ORDER BY created_at ASC, id ASC
              LIMIT ?`
          )
          .all(afterCreatedAt, afterCreatedAt, afterId, MESSAGE_PAGE_SIZE) as ChannelMessage[];
        for (const row of rows) {
          const item = this.messageItem(row);
          if (item) items.push(item);
        }
        if (rows.length < MESSAGE_PAGE_SIZE) {
          keepPaging = false;
          continue;
        }
        const last = rows[rows.length - 1];
        if (!last) throw new Error('Kagemusha keyset page ended without a last row');
        const lastCreatedAt = timestamp(last.created_at);
        if (
          lastCreatedAt < afterCreatedAt ||
          (lastCreatedAt === afterCreatedAt && last.id <= afterId)
        ) {
          throw new Error('Kagemusha keyset pagination made no progress');
        }
        afterCreatedAt = lastCreatedAt;
        afterId = last.id;
      }
    } catch (error) {
      hadError = true;
      this.lastError = error instanceof Error ? error.message : String(error);
    }

    try {
      const rows = this.db
        .prepare('SELECT * FROM tasks WHERE updated_at > ? ORDER BY updated_at ASC LIMIT 500')
        .all(since.getTime()) as KagemushaTask[];
      for (const row of rows) {
        const item = this.taskItem(row);
        if (item) items.push(item);
      }
    } catch {
      // Older source databases may not contain task rows.
    }

    if (hadError) throw new Error('Kagemusha poll failed for the source message table');

    this.lastPollTime = new Date();
    this.lastPollCount = items.length;
    this.lastError = undefined;
    return items;
  }
}
