import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from '../../src/sqlite.js';
import {
  REPLAY_WINDOW_SIZE_MS,
  ReplaySourceCatalog,
  readReplaySourceEvents,
  type ReplaySourceEvent,
} from '../../src/replay/replay-source-catalog.js';

const HOUR = 60 * 60 * 1_000;
const start = Date.parse('2026-09-01T00:00:00.000+09:00');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(overrides: Partial<ReplaySourceEvent> = {}): ReplaySourceEvent {
  return {
    connector: 'slack',
    sourceId: 'source-a',
    observationRef: 'observation-a',
    channelKey: 'channel-a',
    sourceAtMs: start + HOUR,
    observedAtMs: start + 100 * HOUR,
    rawRowId: 1,
    ...overrides,
  };
}

describe('ReplaySourceCatalog', () => {
  it('sorts source events globally, then emits one delta per connector channel', () => {
    const catalog = new ReplaySourceCatalog([
      event({
        connector: 'trello',
        sourceId: 'source-c',
        observationRef: 'observation-c',
        channelKey: 'board-a',
        sourceAtMs: start + 3 * HOUR,
        rawRowId: 3,
      }),
      event({
        connector: 'slack',
        sourceId: 'source-b',
        observationRef: 'observation-b',
        sourceAtMs: start + 2 * HOUR,
        rawRowId: 2,
      }),
      event({ sourceAtMs: start + HOUR, rawRowId: 1 }),
      event({
        connector: 'slack',
        sourceId: 'source-d',
        observationRef: 'observation-d',
        channelKey: 'channel-b',
        sourceAtMs: start + HOUR,
        rawRowId: 4,
      }),
    ]);

    const deltas = catalog.deltasForWindow('run-1', start, start + 12 * HOUR);

    expect(deltas.map((delta) => `${delta.collector}:${delta.channel}`)).toEqual([
      'slack:channel-a',
      'slack:channel-b',
      'trello:board-a',
    ]);
    expect(deltas[0]?.refs.map((ref) => ref.sourceId)).toEqual(['source-a', 'source-b']);
    expect(deltas[0]).toMatchObject({
      kind: 'source_delta',
      occurredAt: start + 2 * HOUR,
      replay: {
        runId: 'run-1',
        windowId: `window:${start}:${start + 12 * HOUR}`,
        windowStartMs: start,
        windowEndMs: start + 12 * HOUR,
      },
    });
    expect(deltas[0]?.refs[0]?.observedAt).toBe(new Date(start + 100 * HOUR).toISOString());
  });

  it('keeps descriptors immutable and rejects an event outside its declared range', () => {
    const descriptor = event();
    const catalog = new ReplaySourceCatalog([descriptor]);
    descriptor.sourceId = 'mutated-after-construction';

    expect(catalog.eventsForWindow(start, start + 12 * HOUR)[0]?.sourceId).toBe('source-a');
    expect(catalog.eventsForWindow(start + 12 * HOUR, start + 24 * HOUR)).toEqual([]);
    expect(REPLAY_WINDOW_SIZE_MS).toBe(12 * HOUR);
  });

  it('creates KST-aligned half-day windows through the frozen fence', () => {
    const catalog = new ReplaySourceCatalog([]);
    const windows = catalog.windows(start, start + 25 * HOUR);

    expect(windows).toEqual([
      { startMs: start, endMs: start + 12 * HOUR },
      { startMs: start + 12 * HOUR, endMs: start + 24 * HOUR },
      { startMs: start + 24 * HOUR, endMs: start + 25 * HOUR },
    ]);
  });

  it('uses the immutable row id from every raw store when a raw root is supplied', () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-replay-catalog-'));
    roots.push(root);
    mkdirSync(join(root, 'slack'), { recursive: true });
    const raw = new Database(join(root, 'slack', 'raw.db'));
    raw.exec(`
      CREATE TABLE raw_items (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
    raw
      .prepare('INSERT INTO raw_items (id, source_id, timestamp) VALUES (?, ?, ?)')
      .run(77, 'source-a', start + HOUR);
    raw.close();
    const adapter = {
      prepare: () => ({
        all: () => [
          {
            connector: 'slack',
            source_id: 'source-a',
            observation_ref: 'observation-a',
            channel_key: 'channel-a',
            source_at_ms: start + HOUR,
            raw_row_id: 1,
            observed_at_ms: start + 2 * HOUR,
            source_entity_id: 'source-a',
            metadata_json: null,
            content_hash: null,
          },
        ],
      }),
    };

    expect(
      readReplaySourceEvents(adapter, start, start + 12 * HOUR, { rawRoot: root })[0]?.rawRowId
    ).toBe(77);
  });
});
