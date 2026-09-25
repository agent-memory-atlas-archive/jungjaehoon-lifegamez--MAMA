import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from '../../src/sqlite.js';

const roots: string[] = [];
const script = join(__dirname, '../../../../scripts/replay/verify-september.mjs');

interface VerificationResult {
  importCoverage: { differences: number; missingStableIds: number };
  trelloCoverage: { differences: number };
  replayOrder: {
    sequenceViolations: number;
    windowViolations: number;
    duplicateDeliveries: number;
  };
  revisionEventTimes: { nullEventDatetime: number; nullAssignmentAppliesFrom: number };
  taskShape: {
    withStage: number;
    withProject: number;
    withLastEventTime: number;
    withFiles: number;
    withRoles: number;
  };
  unresolvableCitations: number;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('September replay verification', () => {
  it('prints aggregate coverage, order, event-time, shape and citation counts only', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-september-verify-'));
    roots.push(root);
    const sourcePath = join(root, 'kagemusha.db');
    const source = new Database(sourcePath);
    source.exec(`
      CREATE TABLE channel_messages (
        id INTEGER PRIMARY KEY,
        channel TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    const sourceAt = Date.parse('2026-09-01T00:00:00.000+09:00');
    source
      .prepare(
        'INSERT INTO channel_messages (id, channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(1, 'kakao', 'room', 'actor', 'user', 'content-a', sourceAt);
    source
      .prepare(
        'INSERT INTO channel_messages (id, channel, channel_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(2, 'kakao', 'room', 'actor', 'user', 'content-b', sourceAt + 1);
    source.close();

    mkdirSync(join(root, 'raw', 'kagemusha'), { recursive: true });
    const rawPath = join(root, 'raw', 'kagemusha', 'raw.db');
    const raw = new Database(rawPath);
    raw.exec(`
      CREATE TABLE raw_items (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL,
        source TEXT NOT NULL,
        channel TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        metadata TEXT
      )
    `);
    const rawInsert = raw.prepare(
      'INSERT INTO raw_items (id, source_id, source, channel, author, content, timestamp, type, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    rawInsert.run(
      1,
      'kagemusha:kakao:room:1',
      'kagemusha',
      'kagemusha:kakao:room',
      'actor',
      'content-a',
      sourceAt,
      'message',
      JSON.stringify({ originalPlatform: 'kakao', kagemushaMessageId: '1' })
    );
    rawInsert.run(
      2,
      'kagemusha:kakao:room:2',
      'kagemusha',
      'kagemusha:kakao:room',
      'actor',
      'content-b',
      sourceAt + 1,
      'message',
      JSON.stringify({ originalPlatform: 'kakao', kagemushaMessageId: '2' })
    );
    raw.close();

    mkdirSync(join(root, 'raw', 'trello'), { recursive: true });
    const trelloPath = join(root, 'raw', 'trello', 'raw.db');
    const trello = new Database(trelloPath);
    trello.exec(`
      CREATE TABLE raw_items (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL,
        source TEXT NOT NULL,
        channel TEXT NOT NULL,
        author TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        metadata TEXT
      )
    `);
    trello
      .prepare(
        'INSERT INTO raw_items (id, source_id, source, channel, author, content, timestamp, type, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        1,
        'action-1',
        'trello',
        'board-key',
        'trello',
        '{}',
        sourceAt,
        'kanban_card',
        JSON.stringify({ boardId: 'board-a' })
      );
    trello.close();

    const mamaDbPath = join(root, 'memory.db');
    const mama = new Database(mamaDbPath);
    mama.exec(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY,
        record_kind TEXT,
        event_datetime INTEGER,
        source_refs_json TEXT,
        payload_json TEXT
      );
      CREATE TABLE commitment_assignments (
        commitment_id TEXT,
        revision INTEGER,
        record_id TEXT,
        set_json TEXT,
        clear_json TEXT,
        applies_from INTEGER
      );
      CREATE TABLE observation_versions (observation_id TEXT PRIMARY KEY);
      CREATE TABLE commitments (commitment_id TEXT PRIMARY KEY)
    `);
    mama.prepare('INSERT INTO observation_versions (observation_id) VALUES (?)').run('obs-1');
    mama.prepare('INSERT INTO commitments (commitment_id) VALUES (?)').run('commitment-1');
    mama
      .prepare(
        'INSERT INTO decisions (id, record_kind, event_datetime, source_refs_json, payload_json) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        'record-1',
        'commitment',
        sourceAt,
        JSON.stringify(['obs-1']),
        JSON.stringify({ commitmentId: 'commitment-1' })
      );
    mama
      .prepare(
        'INSERT INTO commitment_assignments (commitment_id, revision, record_id, set_json, clear_json, applies_from) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        'commitment-1',
        1,
        'record-1',
        JSON.stringify({
          stage: 'active',
          project: 'project-a',
          lastEventTime: new Date(sourceAt).toISOString(),
          files: [],
          roles: [
            { personRef: 'person-a', role: 'maker', evidenceRefs: ['obs-1'], confirmed: true },
          ],
        }),
        JSON.stringify([]),
        sourceAt
      );
    mama.close();

    const untilMs = sourceAt + 12 * 60 * 60 * 1_000;
    const manifestPath = join(root, 'manifest.json');
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        fromMs: sourceAt,
        untilMs,
        maxSourceAtMs: sourceAt + 1,
        countsByOriginDay: { kakao: { '2026-09-01': 2 } },
        trelloCountsByBoardDay: { 'board-a': { '2026-09-01': 1 } },
        rawObservationCount: 3,
        indexCount: 3,
        pendingProjectionCount: 0,
      })}\n`,
      'utf8'
    );
    writeFileSync(
      join(root, 'ledger.jsonl'),
      `${JSON.stringify({ sequence: 1, windowStartMs: sourceAt, windowEndMs: untilMs, stimulusId: 'stimulus-1', origin: 'kagemusha', channelFingerprint: '0'.repeat(64), refCount: 2, firstSourceAtMs: sourceAt, lastSourceAtMs: sourceAt + 1, status: 'accepted' })}\n${JSON.stringify({ sequence: 2, windowStartMs: sourceAt, windowEndMs: untilMs, stimulusId: 'stimulus-1', origin: 'kagemusha', channelFingerprint: '0'.repeat(64), refCount: 2, firstSourceAtMs: sourceAt, lastSourceAtMs: sourceAt + 1, status: 'settled' })}\n`,
      'utf8'
    );
    writeFileSync(
      join(root, 'cursor.json'),
      `${JSON.stringify({ version: 1, runId: 'run-1', policyFingerprint: 'policy-1', fromMs: sourceAt, untilMs, windowSizeMs: 12 * 60 * 60 * 1_000, nextWindowStartMs: untilMs, currentWindow: { startMs: untilMs, endMs: untilMs, deltas: {} } })}\n`,
      'utf8'
    );

    const output = execFileSync(
      process.execPath,
      [
        script,
        '--kagemusha-db',
        sourcePath,
        '--mama-db',
        mamaDbPath,
        '--raw-root',
        join(root, 'raw'),
        '--manifest',
        manifestPath,
        '--ledger',
        join(root, 'ledger.jsonl'),
        '--cursor',
        join(root, 'cursor.json'),
      ],
      { encoding: 'utf8' }
    );
    const result = JSON.parse(output) as VerificationResult;
    expect(result.importCoverage.differences).toBe(0);
    expect(result.importCoverage.missingStableIds).toBe(0);
    expect(result.trelloCoverage.differences).toBe(0);
    expect(result.replayOrder.sequenceViolations).toBe(0);
    expect(result.replayOrder.windowViolations).toBe(0);
    expect(result.replayOrder.duplicateDeliveries).toBe(0);
    expect(result.revisionEventTimes.nullEventDatetime).toBe(0);
    expect(result.revisionEventTimes.nullAssignmentAppliesFrom).toBe(0);
    expect(result.taskShape.withStage).toBe(1);
    expect(result.taskShape.withProject).toBe(1);
    expect(result.taskShape.withLastEventTime).toBe(1);
    expect(result.taskShape.withFiles).toBe(1);
    expect(result.taskShape.withRoles).toBe(1);
    expect(result.unresolvableCitations).toBe(0);
  });
});
