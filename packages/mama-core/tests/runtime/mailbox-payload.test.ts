import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';
import type { DatabaseAdapter } from '../../src/db-manager.js';
import { Mailbox, type Stimulus } from '../../src/runtime/mailbox.js';

const migrations = join(__dirname, '../../db/migrations');
const directories: string[] = [];
const adapters: DatabaseAdapter[] = [];

function directory(): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'mailbox-payload-'));
  directories.push(dir);
  return dir;
}

function open(path: string, migrationDir = migrations): DatabaseAdapter {
  const db = new NodeSQLiteAdapter({ dbPath: path }) as unknown as DatabaseAdapter;
  db.connect();
  db.runMigrations(migrationDir);
  adapters.push(db);
  return db;
}

function input(payload: unknown, extra: Partial<Stimulus> = {}): Stimulus {
  return {
    id: 'request-1',
    kind: 'scheduled',
    principalId: 'consumer-1',
    channelKey: 'input-1',
    occurredAt: 1000,
    payload,
    ...extra,
  } as Stimulus;
}

afterEach(() => {
  for (const db of adapters.splice(0)) db.disconnect();
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('v7 R2: consumer input survives acceptance and restart', () => {
  it('inspects only the served principal input without claiming it or sharing payload objects', () => {
    const mailbox = new Mailbox(open(join(directory(), 'state.db')));
    mailbox.enqueue(input({ body: 'accepted' }));
    expect(mailbox.readInput('request-1', 'someone-else')).toBeNull();
    const read = mailbox.readInput('request-1', 'consumer-1')!;
    expect(read).toMatchObject({ status: 'pending', attempts: 0 });
    (read.payload as { body: string }).body = 'changed by reader';
    expect(mailbox.readInput('request-1', 'consumer-1')).toMatchObject({
      payload: { body: 'accepted' },
    });
    const claimed = mailbox.claimNext()!;
    expect(mailbox.readInput('request-1', 'consumer-1')?.status).toBe('claimed');
    mailbox.ack(claimed.id);
    expect(mailbox.readInput('request-1', 'consumer-1')?.status).toBe('acked');
  });

  it('preserves the full payload across reopen, claim and retry without sharing mutable state', () => {
    const path = join(directory(), 'state.db');
    const db = open(path);
    const mailbox = new Mailbox(db, () => 1000);
    const payload = {
      instruction: 'compare retained versions',
      files: ['v1', 'v2'],
      sender: { id: 'person-1' },
    };
    mailbox.enqueue(input(payload));
    payload.files.push('not accepted');
    db.disconnect();
    adapters.splice(adapters.indexOf(db), 1);
    const reopened = new Mailbox(open(path), () => 100000);
    const row = reopened.claimNext();
    expect(row).toMatchObject({
      payload: {
        instruction: 'compare retained versions',
        files: ['v1', 'v2'],
        sender: { id: 'person-1' },
      },
    });
    reopened.retry(row!.id, 'not yet handed to native');
    const later = new Mailbox(adapters[0], () => 200000);
    expect(later.claimNext()).toMatchObject({ payload: { files: ['v1', 'v2'] }, attempts: 1 });
  });

  it('refuses a changed payload for the same accepted identity without losing the original', () => {
    const mailbox = new Mailbox(open(join(directory(), 'state.db')));
    mailbox.enqueue(input({ body: 'original' }));
    expect(() => mailbox.enqueue(input({ body: 'replacement' }))).toThrow(/payload.*conflict/i);
    expect(mailbox.claimNext()).toMatchObject({ payload: { body: 'original' } });
  });

  it('keeps different payloads separate even when the producer supplies one coalescing key', () => {
    const mailbox = new Mailbox(open(join(directory(), 'state.db')));
    mailbox.enqueue(input({ body: 'first' }, { coalesceKey: 'group' }));
    mailbox.enqueue(input({ body: 'second' }, { id: 'request-2', coalesceKey: 'group' }));
    expect(mailbox.claimNext()).toMatchObject({ payload: { body: 'first' } });
    expect(mailbox.claimNext()).toMatchObject({ payload: { body: 'second' } });
  });

  it.each([
    { field: undefined },
    { field: () => {} },
    { field: NaN },
    { field: Infinity },
    { field: 1n },
    { field: Symbol('lost') },
    { field: new Date(0) },
    { field: Object.assign(Array(2), { 1: 1 }) },
  ])('rejects values that JSON would lose or alter before accepting an input: %s', (payload) => {
    const mailbox = new Mailbox(open(join(directory(), 'state.db')));
    expect(() => mailbox.enqueue(input(payload))).toThrow();
    expect(mailbox.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 });
    expect(mailbox.enqueue(input({ body: 'corrected' }))).not.toBeNull();
  });

  it('preserves ordinary JSON keys including __proto__ and ignores object key order for identity', () => {
    const mailbox = new Mailbox(open(join(directory(), 'state.db')));
    const payload = JSON.parse('{"__proto__":{"note":"retained data"},"b":2,"a":1}');
    mailbox.enqueue(input(payload));
    expect(
      mailbox.enqueue(input(JSON.parse('{"a":1,"b":2,"__proto__":{"note":"retained data"}}')))
    ).toBeNull();
    expect(mailbox.claimNext()).toMatchObject({ payload });
  });

  it('upgrades a populated pre-payload database without inventing content for old inputs', () => {
    const dir = directory();
    const oldMigrations = join(dir, 'old-migrations');
    fs.mkdirSync(oldMigrations);
    for (const name of fs.readdirSync(migrations)) {
      if (/^\d+.*\.sql$/.test(name) && Number(name.slice(0, 3)) <= 86) {
        fs.copyFileSync(join(migrations, name), join(oldMigrations, name));
      }
    }
    const db = open(join(dir, 'state.db'), oldMigrations);
    db.prepare(
      `INSERT INTO mailbox_inputs
      (stimulus_id, kind, principal_id, channel_key, preview_json, occurred_at, created_at)
      VALUES ('old', 'scheduled', 'consumer-1', 'input-1', '["preview only"]', 1000, 1000)`
    ).run();
    db.runMigrations(migrations);
    const mailbox = new Mailbox(db);
    const old = mailbox.claimNext();
    expect(old).toMatchObject({ stimulusId: 'old', preview: ['preview only'] });
    expect(old).not.toHaveProperty('payload');
    mailbox.enqueue(input(null));
    expect(mailbox.claimNext()).toHaveProperty('payload', null);
    db.runMigrations(migrations);
    expect(db.prepare('SELECT COUNT(*) AS n FROM mailbox_inputs').get()).toEqual({ n: 2 });
  });
});
