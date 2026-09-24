import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startConnectorRuntime } from '../../src/runtime/connectors.js';
import type { IConnector, NormalizedItem } from '../../src/connectors/framework/types.js';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { RawStore } from '../../src/storage/source-archive.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fake(name: string, items: NormalizedItem[]): IConnector {
  return {
    name,
    type: name === 'kagemusha' ? 'local' : 'api',
    init: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue({ healthy: true, lastPollTime: null, lastPollCount: 0 }),
    getAuthRequirements: vi.fn().mockReturnValue([]),
    authenticate: vi.fn().mockResolvedValue(true),
    poll: vi.fn().mockResolvedValue(items),
  };
}

describe('connector runtime', () => {
  it('initializes only the four supported enabled connectors and freezes the one-day window', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-runtime-'));
    roots.push(root);
    const configPath = join(root, 'connectors.json');
    const rawPath = join(root, 'raw');
    const statePath = join(root, 'state');
    const trelloStatePath = join(root, 'trello-state.json');
    const kagemushaDbPath = join(root, 'kagemusha.db');
    writeFileSync(
      configPath,
      JSON.stringify({
        slack: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { 'channel-key': { role: 'hub' } },
          auth: { type: 'token', tokenName: 'SLACK_BOT_TOKEN' },
        },
        chatwork: {
          enabled: false,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'token', tokenName: 'CHATWORK_API_TOKEN' },
        },
        trello: {
          enabled: true,
          pollIntervalMinutes: 10,
          channels: { 'board-key': { role: 'truth', boardId: 'board-key' } },
          auth: { type: 'token', tokenName: 'TRELLO_TOKEN' },
        },
        kagemusha: {
          enabled: true,
          pollIntervalMinutes: 15,
          channels: { 'kagemusha:chatwork:room-key': { role: 'hub' } },
          auth: { type: 'none' },
        },
        unsupported: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: {},
          auth: { type: 'none' },
        },
      }),
      'utf8'
    );
    const now = Date.parse('2024-01-02T00:00:00.000Z');
    const calls = new Map<string, IConnector>();
    const connectorPaths = new Map<string, unknown>();
    const deltas: unknown[] = [];
    const setIntervalMock = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>);
    const runtime = await startConnectorRuntime({
      configPath,
      rawPath,
      statePath,
      trelloStatePath,
      kagemushaDbPath,
      clock: () => now,
      rawIndexSink: vi.fn(),
      acceptSourceDelta: async (delta) => {
        deltas.push(delta);
      },
      loadConnector: async (name, _config, paths) => {
        connectorPaths.set(name, paths);
        const item: NormalizedItem = {
          source: name,
          sourceId: `${name}-source`,
          channel:
            name === 'slack'
              ? 'channel-key'
              : name === 'trello'
                ? 'board-key'
                : 'kagemusha:chatwork:room-key',
          author: 'actor-key',
          content: `${name}-content`,
          timestamp: new Date(now - 1_000),
          type: 'message',
        };
        const value = fake(name, [item]);
        calls.set(name, value);
        return value;
      },
      setInterval: setIntervalMock,
      clearInterval: vi.fn(),
    });
    expect([...calls.keys()]).toEqual(['slack', 'trello', 'kagemusha']);
    expect(connectorPaths.get('trello')).toEqual({ trelloStatePath, kagemushaDbPath });
    expect(connectorPaths.get('kagemusha')).toEqual({ trelloStatePath, kagemushaDbPath });
    for (const value of calls.values()) {
      expect(value.poll).toHaveBeenCalledWith(new Date(now - 86_400_000));
    }
    expect(deltas).toHaveLength(3);
    expect(setIntervalMock).toHaveBeenCalledTimes(3);
    await runtime.stop();
  });

  it('uses the real core adapter for the raw-to-index projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-runtime-index-'));
    roots.push(root);
    const configPath = join(root, 'connectors.json');
    const rawPath = join(root, 'raw');
    const statePath = join(root, 'state');
    const database = await openCoreDatabase({ path: join(root, 'core.db') });
    writeFileSync(
      configPath,
      JSON.stringify({
        slack: {
          enabled: true,
          pollIntervalMinutes: 5,
          channels: { 'channel-key': { role: 'hub' } },
          auth: { type: 'token', tokenName: 'SLACK_BOT_TOKEN' },
        },
      }),
      'utf8'
    );
    const now = Date.parse('2024-01-02T00:00:00.000Z');
    const runtime = await startConnectorRuntime({
      configPath,
      rawPath,
      statePath,
      clock: () => now,
      coreAdapter: database.adapter,
      acceptSourceDelta: vi.fn(),
      loadConnector: async (name) =>
        fake(name, [
          {
            source: name,
            sourceId: 'source-key',
            channel: 'channel-key',
            author: 'actor-key',
            content: 'source-content',
            timestamp: new Date(now - 1_000),
            type: 'message',
          },
        ]),
      setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
      clearInterval: vi.fn(),
    });
    await runtime.stop();
    expect(
      database.adapter
        .prepare(
          'SELECT source_connector, channel, content FROM connector_event_index WHERE source_id = ?'
        )
        .get('source-key')
    ).toEqual({
      source_connector: 'slack',
      channel: 'channel-key',
      content: 'source-content',
    });
    const raw = new RawStore(rawPath);
    try {
      expect(raw.query('slack', new Date(0))).toHaveLength(1);
    } finally {
      raw.close();
      await database.close();
    }
  });
});
