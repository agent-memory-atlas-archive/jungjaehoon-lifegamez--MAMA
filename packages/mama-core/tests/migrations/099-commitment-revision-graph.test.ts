import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { getAdapter } from '../../src/db-manager.js';
import { createKnowledge } from '../../src/knowledge/index.js';
import { cleanupTestDB, initTestDB } from '../helpers/test-utils.js';

const access = {
  principalId: 'principal-migration',
  agentId: 'agent-migration',
  scopes: [{ kind: 'project' as const, id: 'scope-migration' }],
};

describe('migration 099: commitment revision graph', () => {
  let dbPath = '';

  beforeAll(async () => {
    dbPath = await initTestDB('commitment-revision-migration');
  });

  beforeEach(() => {
    const db = getAdapter();
    db.prepare('DELETE FROM commitment_assignments').run();
    db.prepare('DELETE FROM commitments').run();
    db.prepare('DELETE FROM judgment_commands').run();
    db.prepare('DELETE FROM command_bindings').run();
    db.prepare('DELETE FROM twin_edges').run();
    db.prepare('DELETE FROM memory_events').run();
    db.prepare('DELETE FROM memory_scope_bindings').run();
    db.prepare('DELETE FROM memory_scopes').run();
    db.prepare('DELETE FROM embeddings').run();
    db.prepare('DELETE FROM decisions').run();
  });

  afterAll(async () => cleanupTestDB(dbPath));

  it("backfills consecutive edges idempotently and keeps each record's topic", async () => {
    const knowledge = createKnowledge({ adapter: getAdapter() });
    const created = await knowledge.createWork(
      {
        commandId: 'migration-fixture-create',
        topic: 'create-topic',
        summary: 'first record',
        set: { title: 'History fixture' },
        scopes: access.scopes,
      },
      access
    );
    const second = await knowledge.reviseWork(
      {
        commandId: 'migration-fixture-revise-2',
        commitmentId: created.commitmentId,
        expectedRevision: 1,
        summary: 'second record',
        set: { feedback: 'second' },
        scopes: access.scopes,
      },
      access
    );
    const third = await knowledge.reviseWork(
      {
        commandId: 'migration-fixture-revise-3',
        commitmentId: created.commitmentId,
        expectedRevision: 2,
        summary: 'third record',
        set: { feedback: 'third' },
        scopes: access.scopes,
      },
      access
    );
    const db = getAdapter();
    db.prepare("DELETE FROM twin_edges WHERE edge_type = 'builds_on'").run();
    db.prepare('UPDATE decisions SET topic = ? WHERE id = ?').run(
      'authored-topic-two',
      second.recordRef.id
    );
    db.prepare('UPDATE decisions SET topic = ? WHERE id = ?').run(
      'authored-topic-three',
      third.recordRef.id
    );

    const migrationsDir = join(__dirname, '..', '..', 'db', 'migrations');
    db.prepare("DELETE FROM schema_version WHERE source = 'core' AND version = 99").run();
    db.runMigrations(migrationsDir);
    const firstRun = db
      .prepare(
        "SELECT edge_id, edge_idempotency_key, content_hash, length(content_hash) AS hash_length FROM twin_edges WHERE edge_type = 'builds_on' ORDER BY subject_id"
      )
      .all();
    const topicsAfterFirstRun = db
      .prepare('SELECT topic FROM decisions WHERE id IN (?, ?, ?) ORDER BY id')
      .all(created.recordRef.id, second.recordRef.id, third.recordRef.id);
    db.prepare("DELETE FROM schema_version WHERE source = 'core' AND version = 99").run();
    db.runMigrations(migrationsDir);
    const secondRun = db
      .prepare(
        "SELECT edge_id, edge_idempotency_key, content_hash, length(content_hash) AS hash_length FROM twin_edges WHERE edge_type = 'builds_on' ORDER BY subject_id"
      )
      .all();
    const topicsAfterSecondRun = db
      .prepare('SELECT topic FROM decisions WHERE id IN (?, ?, ?) ORDER BY id')
      .all(created.recordRef.id, second.recordRef.id, third.recordRef.id);

    expect(secondRun).toEqual(firstRun);
    expect(topicsAfterSecondRun).toEqual(topicsAfterFirstRun);
    expect(firstRun).toHaveLength(2);
    expect(
      (firstRun as Array<{ edge_idempotency_key: string | null; hash_length: number }>).every(
        (edge) => edge.edge_idempotency_key === null && edge.hash_length === 32
      )
    ).toBe(true);
    const page = knowledge.queryGraph(
      {
        view: 'timeline',
        seeds: [created.recordRef, second.recordRef, third.recordRef],
        history: 'all',
      },
      access
    );
    expect(page.edges.filter((edge) => edge.relation === 'builds_on')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: second.recordRef, to: created.recordRef }),
        expect.objectContaining({ from: third.recordRef, to: second.recordRef }),
      ])
    );
    const topicOf = (id: string) =>
      (db.prepare('SELECT topic FROM decisions WHERE id = ?').get(id) as { topic: string }).topic;
    // The migration links revisions; it does not rewrite a consumer's stored topics.
    expect(topicOf(created.recordRef.id)).toBe('create-topic');
    expect(topicOf(second.recordRef.id)).toBe('authored-topic-two');
    expect(topicOf(third.recordRef.id)).toBe('authored-topic-three');
  });
});
