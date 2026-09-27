import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeSQLiteAdapter } from '../../src/db-adapter/node-sqlite-adapter.js';

const dirs: string[] = [];
const adapters: NodeSQLiteAdapter[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'f3-migrations-'));
  dirs.push(dir);
  const db = new NodeSQLiteAdapter({ dbPath: join(dir, 'state.db') });
  adapters.push(db);
  db.connect();
  db.runMigrations(join(__dirname, '../../db/migrations'));
  const consumer = join(dir, 'consumer');
  mkdirSync(consumer);
  return { db, consumer };
}
afterEach(() => {
  for (const db of adapters.splice(0)) db.disconnect();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('F3 migration source and view safety', () => {
  it.each([72, 73, 74, 77, 79])('F3.2 executes consumer migration %s as its own SQL', (version) => {
    const { db, consumer } = fixture();
    writeFileSync(
      join(consumer, `${version}-consumer.sql`),
      'CREATE TABLE consumer_marker (id INTEGER);'
    );
    db.runMigrations([{ name: 'consumer', dir: consumer }]);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='consumer_marker'").get()
    ).toBeDefined();
    expect(
      db
        .prepare('SELECT version FROM schema_version WHERE source=? AND version=?')
        .get('consumer', version)
    ).toBeDefined();
  });
  it('F3.2 never repairs core structures while running a consumer source', () => {
    const { db, consumer } = fixture();
    db.exec('DROP INDEX idx_tool_traces_channel_recency');
    writeFileSync(join(consumer, '068-tool-trace-diagnostics.sql'), '-- consumer-owned file');
    db.runMigrations([{ name: 'consumer', dir: consumer }]);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE name='idx_tool_traces_channel_recency'")
        .get()
    ).toBeUndefined();
  });
  it('F3.16 reads the native input view with malformed historical JSON', () => {
    const { db } = fixture();
    db.prepare(
      "INSERT INTO mailbox_inputs (id,stimulus_id,principal_id,channel_key,preview_json,status,occurred_at,created_at) VALUES (1,'stimulus','principal','lane','[]','pending',1,1)"
    ).run();
    db.prepare(
      "INSERT INTO native_input_deliveries (input_id,invocation_id,state,receipt_json,updated_at) VALUES (1,'native','accepted','{}',1)"
    ).run();
    db.prepare(
      "INSERT INTO model_runs (model_run_id,status,input_refs_json,created_at) VALUES (?,'committed',?,1)"
    ).run('bad', 'not-json');
    db.prepare(
      "INSERT INTO model_runs (model_run_id,status,input_refs_json,created_at) VALUES (?,'committed',?,1)"
    ).run('good', JSON.stringify({ principalId: 'principal', nativeInputId: 'native' }));
    db.exec('CREATE INDEX fixture_principal ON mailbox_inputs(principal_id)');
    for (const suffix of [
      '',
      " WHERE principal_id='principal'",
      " WHERE model_run_id='good'",
      " WHERE model_run_id='bad'",
      ' WHERE input_id=1',
    ]) {
      expect(() =>
        db.prepare('SELECT * FROM model_run_native_inputs' + suffix).all()
      ).not.toThrow();
    }
    expect(db.prepare('SELECT model_run_id FROM model_run_native_inputs').all()).toEqual([
      { model_run_id: 'good' },
    ]);
  });
});
