import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from '../../src/sqlite.js';
import { RawStore } from '../../src/storage/source-archive.js';
import {
  importKagemushaRows,
  openKagemushaReadOnly,
  parseFeedbackAuditCode,
} from '../../src/replay/kagemusha-import.js';
import { readImportManifest, writeImportManifest } from '../../src/replay/import-manifest.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mama-replay-kagemusha-'));
  roots.push(root);
  return root;
}

function writeConnectors(path: string): void {
  writeFileSync(
    path,
    JSON.stringify({
      slack: {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: {
          'slack-canonical': { role: 'hub', kagemusha_channel_id: 'slack:source-a' },
        },
        auth: { type: 'none' },
      },
      chatwork: {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: {
          'chatwork-canonical': { role: 'hub', kagemusha_room_id: 17 },
        },
        auth: { type: 'none' },
      },
      kagemusha: {
        enabled: true,
        pollIntervalMinutes: 5,
        channels: {
          'kakao:source-a': { role: 'hub' },
          'line:source-a': { role: 'hub' },
          'telegram:source-a': { role: 'hub' },
          'airbnb:source-a': { role: 'hub' },
        },
        auth: { type: 'none' },
      },
    }),
    'utf8'
  );
}

function createSourceDb(path: string): Database {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE channel_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE code_act_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  return db;
}

function indexSink() {
  return (connector: string, items: Array<{ sourceId: string }>) =>
    items.map((item) => ({
      sourceId: item.sourceId,
      observationRef: `observation:${connector}:${item.sourceId}`,
    }));
}

describe('collect-only Kagemusha replay import', () => {
  it('extracts feedback text and attachment placeholders without executing audit code', () => {
    expect(
      parseFeedbackAuditCode(`
        const translatedText = "translated feedback";
        const rawBody = "raw feedback";
        return await forward_feedback({ translatedText, rawBody, chatworkRoomId: 17 });
      `)
    ).toEqual({
      translatedText: 'translated feedback',
      rawBody: 'raw feedback',
      chatworkRoomId: '17',
    });
    expect(
      parseFeedbackAuditCode(
        'return await forward_feedback({translatedText: "translated", slackFileIds: ["file-a", "file-b"]});'
      )
    ).toEqual({ translatedText: 'translated', slackFileIds: ['file-a', 'file-b'] });
    expect(
      parseFeedbackAuditCode(
        'return await forward_feedback({"translatedText":"translated JSON key","rawBody":"raw JSON key"});'
      )
    ).toEqual({ translatedText: 'translated JSON key', rawBody: 'raw JSON key' });
    expect(
      parseFeedbackAuditCode('return await contract_no_update({ reason: "no feedback" });')
    ).toBe(null);
  });

  it('imports feedback audit rows into the Kagemusha raw store as observations', async () => {
    const root = fixtureRoot();
    const sourcePath = join(root, 'kagemusha.db');
    const configPath = join(root, 'connectors.json');
    writeConnectors(configPath);
    const db = createSourceDb(sourcePath);
    db.prepare('INSERT INTO code_act_audit (code, created_at) VALUES (?, ?)').run(
      'return await forward_feedback({translatedText: "translated", rawBody: "raw", slackFileIds: ["file-a"]});',
      10_000
    );
    db.close();

    const raw = new RawStore(join(root, 'raw'));
    try {
      const result = await importKagemushaRows({
        sourceDbPath: sourcePath,
        connectorsConfigPath: configPath,
        rawStore: raw,
        rawIndexSink: indexSink(),
        timeZone: 'UTC',
        fromMs: 0,
        observedAtMs: 20_000,
      });
      expect(result.importedCount).toBe(1);
      expect(result.importedByOrigin).toEqual({ feedback: 1 });
      expect(result.countsByOriginDay.feedback).toEqual({ '1970-01-01': 1 });
      expect(result.untilMs).toBe(10_001);
      expect(raw.query('kagemusha', new Date(0))).toEqual([
        expect.objectContaining({
          sourceId: 'kagemusha:feedback:1',
          channel: 'kagemusha:feedback:slack:file-a',
          content: 'translated\n\nraw',
          metadata: expect.objectContaining({
            originalPlatform: 'feedback',
            slackFileIds: ['file-a'],
          }),
        }),
      ]);
    } finally {
      raw.close();
    }
  });

  it('uses read-only keyset paging, R2 channel continuity, and reports unmapped rows', async () => {
    const root = fixtureRoot();
    const sourcePath = join(root, 'kagemusha.db');
    const configPath = join(root, 'connectors.json');
    const rawPath = join(root, 'raw');
    writeConnectors(configPath);
    const db = createSourceDb(sourcePath);
    const sourceAt = Date.parse('2026-09-05T00:00:00.000Z');
    const insert = db.prepare(
      'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (let index = 0; index < 5_001; index += 1) {
      insert.run('kakao', 'kakao:source-a', 'actor', 'user', `kakao-${index}`, sourceAt);
    }
    for (const [origin, channel] of [
      ['line', 'line:source-a'],
      ['telegram', 'telegram:source-a'],
      ['airbnb', 'airbnb:source-a'],
      ['slack', 'slack:source-a'],
      ['slack', 'slack:unmapped'],
      ['chatwork', 'chatwork:17'],
      ['chatwork', 'chatwork:unmapped'],
    ]) {
      insert.run(origin, channel, 'actor', 'user', `${origin}-content`, sourceAt + 1);
    }
    db.close();

    const raw = new RawStore(rawPath);
    try {
      const first = await importKagemushaRows({
        sourceDbPath: sourcePath,
        connectorsConfigPath: configPath,
        rawStore: raw,
        rawIndexSink: indexSink(),
        timeZone: 'UTC',
        fromMs: sourceAt,
        observedAtMs: sourceAt + 100,
        pageSize: 97,
      });

      expect(first.importedCount).toBe(5_006);
      expect(first.unmappedByOrigin).toEqual({ slack: 1, chatwork: 1 });
      expect(raw.query('slack', new Date(0))).toHaveLength(1);
      expect(raw.query('slack', new Date(0))[0]).toMatchObject({
        source: 'slack',
        channel: 'slack-canonical',
      });
      expect(raw.query('chatwork', new Date(0))[0]).toMatchObject({
        source: 'chatwork',
        channel: 'chatwork-canonical',
      });
      expect(raw.query('kagemusha', new Date(0))).toHaveLength(5_004);
      expect(raw.query('kagemusha', new Date(0))[0]?.channel).toBe('kagemusha:kakao:source-a');
      expect(raw.listPendingProjections('slack')).toEqual([]);
      expect(raw.listPendingProjections('chatwork')).toEqual([]);
      expect(raw.listPendingProjections('kagemusha')).toEqual([]);

      const second = await importKagemushaRows({
        sourceDbPath: sourcePath,
        connectorsConfigPath: configPath,
        rawStore: raw,
        rawIndexSink: indexSink(),
        timeZone: 'UTC',
        fromMs: sourceAt,
        untilMs: first.untilMs,
        observedAtMs: sourceAt + 200,
        pageSize: 97,
      });
      expect(second.importedCount).toBe(0);
      expect(raw.query('kagemusha', new Date(0))).toHaveLength(5_004);
    } finally {
      raw.close();
    }
  });

  it('opens the source database read-only and records the exclusive import fence', () => {
    const root = fixtureRoot();
    const sourcePath = join(root, 'kagemusha.db');
    const db = createSourceDb(sourcePath);
    db.prepare(
      'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('kakao', 'kakao:source-a', 'actor', 'user', 'content', 10_000);
    db.close();

    const readonly = openKagemushaReadOnly(sourcePath);
    try {
      expect(() =>
        readonly
          .prepare(
            'INSERT INTO channel_messages (channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?)'
          )
          .run('kakao', 'kakao:source-a', 'actor', 'user', 'must-not-write', 10_001)
      ).toThrow(/readonly/i);
    } finally {
      readonly.close();
    }
  });

  it('writes and reads bounded manifest metadata without source content', () => {
    const root = fixtureRoot();
    const path = join(root, 'september-import-manifest.json');
    const manifest = {
      fromMs: 1,
      untilMs: 3,
      maxSourceAtMs: 2,
      countsByOriginDay: { kakao: { '2026-09-01': 2 } },
      rawObservationCount: 2,
      indexCount: 2,
      pendingProjectionCount: 0,
      unmappedByOrigin: { slack: 1 },
    };
    writeImportManifest(path, manifest);
    expect(readImportManifest(path)).toEqual(manifest);
    expect(readImportManifest(path)).not.toHaveProperty('content');
  });
});
