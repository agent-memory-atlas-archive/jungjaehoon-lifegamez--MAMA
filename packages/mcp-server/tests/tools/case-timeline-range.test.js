/**
 * Tests for case_timeline_range MCP tool
 *
 * The tool is a thin adapter over `graph.query` view:'timeline'. Case
 * memberships on the twin-edge graph (`case_member` edges) are the designed
 * carrier — the dormant case_memberships ledger has no production writer and
 * the timeline does not read it. Merge chains resolve server-side through
 * canonical_case_id, surfaced as the seed node's resolvedRef.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { insertTwinEdge } from '@jungjaehoon/mama-core';
import { createCaseTimelineRangeTool } from '../../src/tools/case-timeline-range.js';
import { createMemoryTools } from '../../src/tools/index.js';
import { createActionCall, TEST_ACCESS } from '../helpers/action-call.js';

const CASE_ID = '11111111-1111-4111-8111-111111111111';
const MERGED_CASE_ID = '22222222-2222-4222-8222-222222222222';
const SCOPE = TEST_ACCESS.scopes[0];

function applyMigrations(db) {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const migrationsDir = resolve(testDir, '../../../mama-core/db/migrations');

  for (const file of readdirSync(migrationsDir)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
}

function createAdapter(db) {
  return {
    prepare(sql) {
      return db.prepare(sql);
    },
    transaction(fn) {
      return db.transaction(fn)();
    },
    exec(sql) {
      return db.exec(sql);
    },
  };
}

function seedScope(db) {
  db.prepare(`INSERT INTO memory_scopes (id, kind, external_id) VALUES (?, ?, ?)`).run(
    'scope-row-test',
    SCOPE.kind,
    SCOPE.id
  );
}

function seedCase(db, caseId, { canonical = null, updatedAt } = {}) {
  const scopeRefs = JSON.stringify([{ kind: SCOPE.kind, id: SCOPE.id }]);
  // case_truth timestamps are ISO 8601 TEXT — epoch numbers would land as
  // unparseable strings under TEXT affinity.
  const updatedAtIso = new Date(updatedAt).toISOString();
  db.prepare(
    `
      INSERT INTO case_truth (
        case_id, canonical_case_id, current_wiki_path, title, status,
        scope_refs, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
    `
  ).run(
    caseId,
    canonical,
    `cases/${caseId.slice(0, 8)}.md`,
    `Case ${caseId.slice(0, 8)}`,
    scopeRefs,
    updatedAtIso,
    updatedAtIso
  );
}

function seedDecision(db, id, { eventDatetime }) {
  db.prepare(
    `
      INSERT INTO decisions (
        id, topic, decision, reasoning, confidence, created_at, updated_at,
        event_date, event_datetime
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    id,
    'timeline/range',
    'Use bounded case timelines',
    'The UI needs a focused case history window.',
    0.9,
    eventDatetime,
    eventDatetime,
    '2026-04-10',
    eventDatetime
  );
  db.prepare(
    `INSERT INTO memory_scope_bindings (memory_id, scope_id, is_primary)
     VALUES (?, 'scope-row-test', 1)`
  ).run(id);
}

// The timeline reads observations, which is the core's own table. It used to read
// the connector event index, so this fixture wrote both; the index belongs to the
// package that has connectors and this consumer has none.
function seedRawEvent(db, eventIndexId, { eventDatetime }) {
  db.prepare(
    `INSERT INTO observation_versions
      (observation_id, source, source_id, source_type, source_locator, title, body,
       artifact_locator, source_at, observed_at, event_date, content_hash,
       metadata_json, scope_json, memory_scope_kind, memory_scope_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    eventIndexId,
    'drive',
    'artifact-version-1',
    'document',
    'drive:artifact-version-1',
    'artifact title',
    'artifact body',
    eventIndexId,
    eventDatetime,
    eventDatetime,
    null,
    'artifact-hash',
    '{}',
    JSON.stringify({ kind: SCOPE.kind, id: SCOPE.id }),
    SCOPE.kind,
    SCOPE.id
  );
}

function seedCaseMemberEdge(db, objectRef, { createdAt }) {
  insertTwinEdge(createAdapter(db), {
    edge_id: `edge-${randomUUID()}`,
    edge_type: 'case_member',
    subject_ref: { kind: 'case', id: CASE_ID },
    object_ref: objectRef,
    source: 'code',
    content_hash: randomBytes(32),
    created_at: createdAt,
  });
}

describe('case_timeline_range MCP tool', () => {
  let db;
  let tool;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applyMigrations(db);
    seedScope(db);
    seedCase(db, CASE_ID, { updatedAt: Date.parse('2026-04-18T00:00:00.000Z') });
    seedDecision(db, 'dec-timeline-range', {
      eventDatetime: Date.parse('2026-04-10T12:00:00.000Z'),
    });
    seedRawEvent(db, 'event-timeline-artifact', {
      eventDatetime: Date.parse('2026-04-11T12:00:00.000Z'),
    });
    seedCaseMemberEdge(
      db,
      { kind: 'memory', id: 'dec-timeline-range' },
      {
        createdAt: Date.parse('2026-04-10T13:00:00.000Z'),
      }
    );
    seedCaseMemberEdge(
      db,
      { kind: 'raw', id: 'event-timeline-artifact' },
      {
        createdAt: Date.parse('2026-04-11T13:00:00.000Z'),
      }
    );
    tool = createCaseTimelineRangeTool({ call: createActionCall(createAdapter(db)) });
  });

  afterEach(() => {
    db.close();
  });

  it('is registered in createMemoryTools', () => {
    const tools = createMemoryTools({ call: async () => ({}) });

    expect(tools.case_timeline_range).toBeDefined();
    expect(tools.case_timeline_range.name).toBe('case_timeline_range');
    expect(tools.case_timeline_range.name).toBe(tool.name);
  });

  it('returns the graph timeline page for a case seed', async () => {
    const result = await tool.handler({
      case_id: CASE_ID,
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-30T23:59:59.999Z',
      order: 'asc',
      limit: 10,
    });

    expect(result.case_id).toBe(CASE_ID);
    expect(result.terminal_case_id).toBe(CASE_ID);
    expect(result.resolved_via_case_id).toBeNull();

    const kinds = result.items.map((node) => node.data?.kind);
    expect(kinds).toContain('case');
    expect(kinds).toContain('memory');
    expect(kinds).toContain('raw');

    const memoryNode = result.items.find((node) => node.data?.kind === 'memory');
    expect(memoryNode.ref).toEqual({ kind: 'memory', id: 'dec-timeline-range' });
    expect(memoryNode.label).toBe('timeline/range');

    const rawNode = result.items.find((node) => node.data?.kind === 'raw');
    expect(rawNode.ref).toEqual({ kind: 'raw', id: 'event-timeline-artifact' });
    expect(rawNode.data.data.observation_ref ?? rawNode.data.data.current_observation_id).toBe(
      // One evidence space: the ref and the observation it cites are the same id.
      'event-timeline-artifact'
    );

    // Membership edges surface as graph edges, not a separate ledger read.
    const memberEdges = result.edges.filter((edge) => edge.relation === 'case_member');
    expect(memberEdges).toHaveLength(2);
    expect(memberEdges.map((edge) => edge.to.kind)).toEqual(
      expect.arrayContaining(['memory', 'raw'])
    );
  });

  it('resolves merged cases through the canonical chain', async () => {
    // MERGED_CASE_ID merged into CASE_ID; its edges belong to the survivor's
    // timeline even though the caller named the merged case.
    seedCase(db, MERGED_CASE_ID, {
      canonical: CASE_ID,
      updatedAt: Date.parse('2026-04-12T00:00:00.000Z'),
    });
    seedDecision(db, 'dec-merged-member', {
      eventDatetime: Date.parse('2026-04-12T12:00:00.000Z'),
    });
    insertTwinEdge(createAdapter(db), {
      edge_id: `edge-${randomUUID()}`,
      edge_type: 'case_member',
      subject_ref: { kind: 'case', id: MERGED_CASE_ID },
      object_ref: { kind: 'memory', id: 'dec-merged-member' },
      source: 'code',
      content_hash: randomBytes(32),
      created_at: Date.parse('2026-04-12T13:00:00.000Z'),
    });

    const result = await tool.handler({
      case_id: MERGED_CASE_ID,
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-30T23:59:59.999Z',
      order: 'asc',
    });

    // The seed folds to the terminal; the cluster's history answers.
    expect(result.terminal_case_id).toBe(CASE_ID);
    expect(result.resolved_via_case_id).toBe(MERGED_CASE_ID);
    expect(
      result.items.some(
        (node) => node.ref?.kind === 'memory' && node.ref.id === 'dec-merged-member'
      )
    ).toBe(true);
    // Cluster members expand both directions: the terminal case's own
    // members are part of the requested case's history too.
    expect(
      result.items.some(
        (node) => node.ref?.kind === 'memory' && node.ref.id === 'dec-timeline-range'
      )
    ).toBe(true);
  });

  it('honors the event window bounds', async () => {
    const result = await tool.handler({
      case_id: CASE_ID,
      from: '2026-04-11T00:00:00.000Z',
      to: '2026-04-11T23:59:59.999Z',
      order: 'asc',
    });

    const memoryIds = result.items
      .filter((node) => node.data?.kind === 'memory')
      .map((node) => node.ref.id);
    expect(memoryIds).not.toContain('dec-timeline-range');
  });
});
