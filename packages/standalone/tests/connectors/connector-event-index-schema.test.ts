import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import { upsertConnectorEventIndex } from '../../src/connectors/framework/event-index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('connector event index schema', () => {
  it('belongs to the standalone migration source', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-schema-'));
    roots.push(root);
    const handle = await openCoreDatabase({ path: join(root, 'core.db') });
    try {
      expect(
        handle.adapter
          .prepare("SELECT version FROM schema_version WHERE source = 'standalone'")
          .get()
      ).toEqual({ version: 1 });
      expect(
        handle.adapter
          .prepare("SELECT name FROM sqlite_master WHERE name = 'connector_event_index'")
          .get()
      ).toEqual({ name: 'connector_event_index' });
      expect(
        handle.adapter
          .prepare("SELECT name FROM sqlite_master WHERE name = 'connector_event_index_fts'")
          .get()
      ).toBeUndefined();
    } finally {
      await handle.close();
    }
  });

  it('upgrades an existing FTS index without losing rows or breaking writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'connector-schema-upgrade-'));
    roots.push(root);
    const path = join(root, 'core.db');
    let handle = await openCoreDatabase({ path });
    try {
      // Reconstruct the pre-096 schema even when the fresh schema no longer has FTS.
      handle.adapter.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS connector_event_index_fts USING fts5(
          event_index_id UNINDEXED, title, content, author, channel,
          tokenize = 'unicode61 remove_diacritics 2'
        );
        CREATE TRIGGER IF NOT EXISTS trg_connector_event_index_ai
        AFTER INSERT ON connector_event_index BEGIN
          INSERT INTO connector_event_index_fts(event_index_id, title, content, author, channel)
          VALUES (NEW.event_index_id, NEW.title, NEW.content, NEW.author, NEW.channel);
        END;
        CREATE TRIGGER IF NOT EXISTS trg_connector_event_index_ad
        AFTER DELETE ON connector_event_index BEGIN
          DELETE FROM connector_event_index_fts WHERE event_index_id = OLD.event_index_id;
        END;
        CREATE TRIGGER IF NOT EXISTS trg_connector_event_index_au
        AFTER UPDATE OF title, content, author, channel ON connector_event_index BEGIN
          DELETE FROM connector_event_index_fts WHERE event_index_id = OLD.event_index_id;
          INSERT INTO connector_event_index_fts(event_index_id, title, content, author, channel)
          VALUES (NEW.event_index_id, NEW.title, NEW.content, NEW.author, NEW.channel);
        END;
        DELETE FROM schema_version WHERE source = 'core' AND version = 96;
      `);
      const input = {
        source_connector: 'connector-test',
        source_type: 'message',
        source_id: 'retained',
        content: 'retained source evidence',
        event_datetime: 100,
        observation: { observed_at: 1_000 },
      };
      const saved = upsertConnectorEventIndex(handle.adapter, input);
      expect(
        handle.adapter.prepare('SELECT COUNT(*) AS count FROM connector_event_index_fts').get()
      ).toEqual({ count: 1 });
      await handle.close();
      handle = await openCoreDatabase({ path });
      expect(
        handle.adapter
          .prepare(
            `SELECT name FROM sqlite_master
        WHERE name GLOB 'connector_event_index_fts*'
          OR name IN ('trg_connector_event_index_ai', 'trg_connector_event_index_au', 'trg_connector_event_index_ad')`
          )
          .all()
      ).toEqual([]);
      expect(
        handle.adapter
          .prepare(
            'SELECT content, current_observation_id FROM connector_event_index WHERE event_index_id = ?'
          )
          .get(saved.event_index_id)
      ).toEqual({
        content: input.content,
        current_observation_id: saved.current_observation_id,
      });
      upsertConnectorEventIndex(handle.adapter, { ...input, content: 'updated evidence' });
      upsertConnectorEventIndex(handle.adapter, { ...input, source_id: 'inserted' });
      handle.adapter
        .prepare('DELETE FROM connector_event_index WHERE source_id = ?')
        .run('inserted');
      expect(
        handle.adapter.prepare('SELECT source_id, content FROM connector_event_index').all()
      ).toEqual([{ source_id: 'retained', content: 'updated evidence' }]);
    } finally {
      await handle.close();
    }
  });
});
