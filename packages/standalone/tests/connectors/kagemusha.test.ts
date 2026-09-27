import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Database from '../../src/sqlite.js';
import { KagemushaConnector } from '../../src/connectors/kagemusha/index.js';
import { canonicalChannelKey } from '../../src/connectors/framework/polling-scheduler.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(channels: Record<string, { role: 'hub' | 'ignore' }>) {
  return { enabled: true, pollIntervalMinutes: 5, channels, auth: { type: 'none' as const } };
}

function createDb(path: string): Database {
  const db = new Database(path);
  db.exec(`CREATE TABLE channel_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
  )`);
  return db;
}

describe('KagemushaConnector', () => {
  it('requires an explicit source database path', () => {
    expect(
      () =>
        new KagemushaConnector(
          config({ 'kagemusha:chatwork:room-key': { role: 'hub' } }),
          undefined as unknown as string
        )
    ).toThrow(/database path/i);
  });

  it('opens the source database read-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kagemusha-readonly-'));
    roots.push(root);
    const dbPath = join(root, 'source.db');
    const db = createDb(dbPath);
    db.close();

    const connector = new KagemushaConnector(
      config({ 'kagemusha:chatwork:room-key': { role: 'hub' } }),
      dbPath
    );
    await connector.init();
    try {
      const handle = (connector as unknown as { db: Database | null }).db;
      expect(handle).not.toBeNull();
      if (handle === null) throw new Error('Kagemusha connector did not open its database');
      expect(() =>
        handle
          .prepare(
            'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run('chatwork', 'room-key', 'actor-key', 'user', 'unexpected-write', 1_704_067_201_000)
      ).toThrow(/readonly/i);
    } finally {
      await connector.dispose();
    }
  });

  it('uses the canonical Kagemusha channel key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kagemusha-connector-'));
    roots.push(root);
    const db = createDb(join(root, 'source.db'));
    db.prepare(
      'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('chatwork', 'room-key', 'actor-key', 'user', 'source-content', 1_704_067_201_000);
    db.close();
    const connector = new KagemushaConnector(
      config({ 'room-key': { role: 'hub' } }),
      join(root, 'source.db')
    );
    await connector.init();
    const [item] = await connector.poll(new Date(0));
    expect(item).toMatchObject({
      source: 'kagemusha',
      channel: 'kagemusha:chatwork:room-key',
      type: 'message',
    });
    expect(item?.metadata).toMatchObject({
      originalPlatform: 'chatwork',
      originalChannel: 'room-key',
    });
    await connector.dispose();
  });

  it.each(['room-key', 'chatwork:room-key', 'kagemusha:chatwork:room-key'])(
    'admits the same configured key in the connector and scheduler: %s',
    async (key) => {
      const root = mkdtempSync(join(tmpdir(), 'kagemusha-channel-'));
      roots.push(root);
      const dbPath = join(root, 'source.db');
      const db = createDb(dbPath);
      db.prepare(
        'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).run('chatwork', 'room-key', 'actor', 'user', 'source-content', 1_000);
      db.close();
      const configured = config({ [key]: { role: 'hub' } });
      const connector = new KagemushaConnector(configured, dbPath);
      await connector.init();
      try {
        const items = await connector.poll(new Date(0));
        expect(items).toHaveLength(1);
        expect(canonicalChannelKey(items[0]!, { kagemusha: configured.channels })).toBe(
          'kagemusha:chatwork:room-key'
        );
      } finally {
        await connector.dispose();
      }
    }
  );

  it('does not read an origin channel that is absent from configuration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kagemusha-scope-'));
    roots.push(root);
    const db = createDb(join(root, 'source.db'));
    db.prepare(
      'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('slack', 'other-room', 'actor-key', 'user', 'source-content', 1_704_067_201_000);
    db.close();
    const connector = new KagemushaConnector(
      config({ 'room-key': { role: 'hub' } }),
      join(root, 'source.db')
    );
    await connector.init();
    expect(await connector.poll(new Date(0))).toEqual([]);
    await connector.dispose();
  });

  it('polls configured channel ids using epoch-millisecond source timestamps', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kagemusha-epoch-ms-'));
    roots.push(root);
    const dbPath = join(root, 'source.db');
    const db = createDb(dbPath);
    db.prepare(
      'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('slack', 'channel-key', 'actor-key', 'user', 'source-content', 1_704_067_201_000);
    db.close();

    const connector = new KagemushaConnector(config({ 'channel-key': { role: 'hub' } }), dbPath);
    await connector.init();
    try {
      const items = await connector.poll(new Date(1_704_067_200_000));
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        channel: 'kagemusha:slack:channel-key',
        timestamp: new Date(1_704_067_201_000),
      });
    } finally {
      await connector.dispose();
    }
  });

  it('pages all source messages with the created-at and id keyset', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kagemusha-keyset-'));
    roots.push(root);
    const dbPath = join(root, 'source.db');
    const db = createDb(dbPath);
    const insert = db.prepare(
      'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (let index = 0; index < 5_001; index += 1) {
      insert.run('kakao', 'room-key', 'actor-key', 'user', `source-${index}`, 1_704_067_201_000);
    }
    db.close();

    const connector = new KagemushaConnector(
      config({ 'kagemusha:kakao:room-key': { role: 'hub' } }),
      dbPath
    );
    await connector.init();
    try {
      await expect(connector.poll(new Date(1_704_067_200_000))).resolves.toHaveLength(5_001);
    } finally {
      await connector.dispose();
    }
  });
});
