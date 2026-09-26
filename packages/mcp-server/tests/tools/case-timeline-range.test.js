/**
 * Tests for case_timeline_range MCP tool
 */

import { initDB, getAdapter, closeDB } from '@jungjaehoon/mama-core/db-manager';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  caseTimelineRangeTool,
  resetCaseTimelineRangeAdapterForTest,
  setCaseTimelineRangeAdapterForTest,
} from '../../src/tools/case-timeline-range.js';
import { createMemoryTools } from '../../src/tools/index.js';

const CASE_ID = '11111111-1111-4111-8111-111111111111';

function seedTimelineCase(db) {
  const now = '2026-04-18T00:00:00.000Z';
  db.prepare(
    `
      INSERT INTO case_truth (
        case_id, current_wiki_path, title, status, created_at, updated_at
      )
      VALUES (?, ?, ?, 'active', ?, ?)
    `
  ).run(CASE_ID, 'cases/timeline-case.md', 'Timeline Case', now, now);

  db.prepare(
    `
      INSERT INTO decisions (
        id, topic, decision, reasoning, confidence, created_at, updated_at,
        event_date, event_datetime
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `
  ).run(
    'dec-timeline-range',
    'timeline/range',
    'Use bounded case timelines',
    'The UI needs a focused case history window.',
    0.9,
    Date.parse('2026-04-10T12:00:00.000Z'),
    Date.parse('2026-04-10T12:00:00.000Z'),
    '2026-04-10',
    Date.parse('2026-04-10T12:00:00.000Z')
  );

  db.prepare(
    `
      INSERT INTO case_memberships (
        case_id, source_type, source_id, role, confidence, reason, status,
        added_by, added_at, updated_at, user_locked
      )
      VALUES (?, 'decision', ?, 'primary', 0.91, 'seeded test membership',
              'active', 'wiki-compiler', ?, ?, 0)
    `
  ).run(CASE_ID, 'dec-timeline-range', now, now);

  db.prepare(
    `INSERT INTO observation_versions
      (observation_id, source, source_id, source_type, source_locator, title, body,
       source_at, observed_at, content_hash, metadata_json, scope_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    'obs-timeline-artifact',
    'drive',
    'artifact-version-1',
    'document',
    'drive:artifact-version-1',
    'artifact title',
    'artifact body',
    Date.parse('2026-04-11T12:00:00.000Z'),
    Date.parse('2026-04-11T12:00:00.000Z'),
    'artifact-hash',
    '{}',
    '{}'
  );
  db.prepare(
    `INSERT INTO case_memberships (
       case_id, source_type, source_id, role, confidence, reason, status,
       added_by, added_at, updated_at, user_locked
     ) VALUES (?, 'artifact', ?, 'evidence', 0.9, 'captured artifact',
       'active', 'wiki-compiler', ?, ?, 0)`
  ).run(CASE_ID, 'obs-timeline-artifact', now, now);
}

describe('case_timeline_range MCP tool', () => {
  let db;

  beforeEach(async () => {
    await initDB();
    db = getAdapter();
    db.prepare('DELETE FROM case_memberships').run();
    db.prepare('DELETE FROM case_truth').run();
    db.prepare('DELETE FROM decisions').run();
    db.prepare('DELETE FROM observation_versions').run();
    seedTimelineCase(db);
    setCaseTimelineRangeAdapterForTest(db);
  });

  afterEach(async () => {
    resetCaseTimelineRangeAdapterForTest();
    await closeDB();
  });

  it('is registered in createMemoryTools', () => {
    const tools = createMemoryTools();

    expect(tools.case_timeline_range).toBeDefined();
    expect(tools.case_timeline_range.name).toBe('case_timeline_range');
    expect(tools.case_timeline_range.name).toBe(caseTimelineRangeTool.name);
  });

  it('returns a plain case timeline range object', async () => {
    const result = await caseTimelineRangeTool.handler({
      case_id: CASE_ID,
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-30T23:59:59.999Z',
      order: 'asc',
      limit: 10,
      include_connector_enrichments: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        terminal_case_id: CASE_ID,
        resolved_via_case_id: null,
        chain: [CASE_ID],
      })
    );
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        item_type: 'decision',
        source_type: 'decision',
        source_id: 'dec-timeline-range',
        title: 'timeline/range',
        role: 'primary',
        membership_reason: 'seeded test membership',
      })
    );
    expect(result.items[1]).toEqual(
      expect.objectContaining({
        item_type: 'artifact',
        connector_event: expect.objectContaining({
          observation_ref: 'obs-timeline-artifact',
        }),
      })
    );
  });
  it('resolves a merged case through the canonical chain', async () => {
    const mergedId = '22222222-2222-4222-8222-222222222222';
    db.prepare(
      `INSERT INTO case_truth
      (case_id, canonical_case_id, current_wiki_path, title, status, created_at, updated_at)
      VALUES (?, ?, 'cases/merged.md', 'Merged case', 'active', ?, ?)`
    ).run(mergedId, CASE_ID, '2026-04-12T00:00:00.000Z', '2026-04-12T00:00:00.000Z');
    const result = await caseTimelineRangeTool.handler({ case_id: mergedId });
    expect(result.terminal_case_id).toBe(CASE_ID);
    expect(result.resolved_via_case_id).toBe(mergedId);
    expect(result.items.map((item) => item.source_id)).toEqual([
      'dec-timeline-range',
      'obs-timeline-artifact',
    ]);
  });

  it('honors event bounds, ordering and limit', async () => {
    const bounded = await caseTimelineRangeTool.handler({
      case_id: CASE_ID,
      from: '2026-04-11T00:00:00.000Z',
      to: '2026-04-11T23:59:59.999Z',
    });
    expect(bounded.items.map((item) => item.source_id)).toEqual(['obs-timeline-artifact']);
    const descending = await caseTimelineRangeTool.handler({
      case_id: CASE_ID,
      order: 'desc',
      limit: 1,
    });
    expect(descending.items.map((item) => item.source_id)).toEqual(['obs-timeline-artifact']);
  });
});
