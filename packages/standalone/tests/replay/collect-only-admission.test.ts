import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '../../src/sqlite.js';
import { RawStore } from '../../src/storage/source-archive.js';
import { importTrelloActions } from '../../src/replay/trello-import.js';
import { importKagemushaRows } from '../../src/replay/kagemusha-import.js';
import { drainRawProjections } from '../../src/replay/import-manifest.js';
import { ConnectorRegistry } from '../../src/connectors/framework/connector-registry.js';
import { PollingScheduler } from '../../src/connectors/framework/polling-scheduler.js';
import type { IConnector } from '../../src/connectors/framework/types.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe('failed collect-only imports', () => {
  it.each(['trello', 'kagemusha'])(
    'keeps %s history out of live admission after reopening',
    async (name) => {
      const root = mkdtempSync(join(tmpdir(), 'collect-only-'));
      roots.push(root);
      const configPath = join(root, 'connectors.json');
      writeFileSync(
        configPath,
        JSON.stringify({
          trello: {
            enabled: true,
            pollIntervalMinutes: 5,
            channels: { board: { role: 'truth', boardId: 'board' } },
            auth: { type: 'none' },
          },
          kagemusha: {
            enabled: true,
            pollIntervalMinutes: 5,
            channels: { 'line:room': { role: 'hub' } },
            auth: { type: 'none' },
          },
        })
      );
      const rawPath = join(root, 'raw');
      const raw = new RawStore(rawPath);
      const rawIndexSink = () => {
        throw new Error('projection unavailable');
      };
      if (name === 'trello') {
        await expect(
          importTrelloActions({
            connectorsConfigPath: configPath,
            rawStore: raw,
            rawIndexSink,
            credentials: { apiKey: 'fixture-key', token: 'fixture-token' },
            fromMs: 0,
            untilMs: 10_000,
            fetchImpl: async () =>
              new Response(
                JSON.stringify([
                  {
                    id: 'action',
                    type: 'createCard',
                    date: new Date(1000).toISOString(),
                    data: { card: { id: 'card' } },
                  },
                ])
              ),
          })
        ).rejects.toThrow('projection unavailable');
      } else {
        const sourceDbPath = join(root, 'source.db');
        const db = new Database(sourceDbPath);
        db.exec(`CREATE TABLE channel_messages (id INTEGER, channel TEXT, channel_id TEXT, user_id TEXT, role TEXT, content TEXT, created_at INTEGER);
        CREATE TABLE code_act_audit (id INTEGER, code TEXT, created_at INTEGER);
        INSERT INTO channel_messages VALUES (1, 'line', 'room', 'actor', 'user', 'historical evidence', 1000);`);
        db.close();
        await expect(
          importKagemushaRows({
            sourceDbPath,
            connectorsConfigPath: configPath,
            rawStore: raw,
            rawIndexSink,
            fromMs: 0,
            untilMs: 10_000,
          })
        ).rejects.toThrow('projection unavailable');
      }
      expect(raw.pendingProjectionCount(name)).toBe(1);
      raw.close();
      const reopened = new RawStore(rawPath);
      const registry = new ConnectorRegistry();
      registry.register(name, { name, poll: async () => [] } as unknown as IConnector);
      const sink = (_name: string, items: Array<{ sourceId: string }>) =>
        items.map((item) => ({ sourceId: item.sourceId, observationRef: `obs:${item.sourceId}` }));
      const scheduler = new PollingScheduler(reopened, join(root, 'state'), { rawIndexSink: sink });
      const admit = vi.fn();
      try {
        await scheduler.pollAll(registry, {}, admit);
        expect(admit).not.toHaveBeenCalled();
        expect(reopened.pendingProjectionCount(name)).toBe(1);
        expect(await drainRawProjections(reopened, sink)).toBe(1);
        expect(reopened.pendingProjectionCount(name)).toBe(0);
      } finally {
        reopened.close();
      }
    }
  );
});
