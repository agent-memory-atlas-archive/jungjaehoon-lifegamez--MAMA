/**
 * Persistent report store -- slots survive daemon restarts.
 * filePath is injected per test (Constraint 5: never the real ~/.mama).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPersistentReportStore } from '../../src/api/report-persistence.js';
import { createReportPublisher } from '../../src/api/report-handler.js';

const flushDebounce = () => new Promise((resolve) => setTimeout(resolve, 350));

describe('createPersistentReportStore', () => {
  let dir: string;
  let filePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'report-persist-'));
    filePath = join(dir, 'report-slots.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('restores slots from disk on creation, preserving updatedAt', async () => {
    const a = createPersistentReportStore({ filePath });
    a.update('briefing', '<p>persisted</p>', 3);
    const savedAt = a.get('briefing')!.updatedAt;
    await flushDebounce();
    expect(existsSync(filePath)).toBe(true);

    const b = createPersistentReportStore({ filePath });
    expect(b.get('briefing')?.html).toBe('<p>persisted</p>');
    expect(b.get('briefing')?.priority).toBe(3);
    expect(b.get('briefing')?.updatedAt).toBe(savedAt);
  });

  it('starts empty and warns when the snapshot is corrupt', () => {
    writeFileSync(filePath, '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const store = createPersistentReportStore({ filePath });

    expect(store.getAllSorted()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('persists deletions and coalesces bursts into one snapshot', async () => {
    const a = createPersistentReportStore({ filePath });
    a.update('one', '<p>1</p>', 0);
    a.update('two', '<p>2</p>', 1);
    a.delete('one');
    await flushDebounce();

    const b = createPersistentReportStore({ filePath });
    expect(b.get('one')).toBeUndefined();
    expect(b.get('two')?.html).toBe('<p>2</p>');
    expect(b.getAllSorted()).toHaveLength(1);
  });

  it('persists a mixed agent-authored batch atomically', async () => {
    const store = createPersistentReportStore({ filePath });
    store.update('briefing', '<div class="report-card">old</div>', 0);
    await flushDebounce();
    const publish = createReportPublisher(store, new Set());

    expect(
      publish({
        briefing: '<div class="report-card">new</div>',
        pipeline: '<div class="report-table">current</div>',
      })
    ).toMatchObject({ changedSlotIds: ['briefing', 'pipeline'] });
    expect(createPersistentReportStore({ filePath }).get('pipeline')?.html).toBe(
      '<div class="report-table">current</div>'
    );
  });

  it('makes a successful publish durable before returning', async () => {
    const store = createPersistentReportStore({ filePath });
    const publish = createReportPublisher(store, new Set());
    try {
      expect(publish({ briefing: '<div class="report-card">durable</div>' })).toMatchObject({
        changedSlotIds: ['briefing'],
      });
      expect(createPersistentReportStore({ filePath }).get('briefing')?.html).toBe(
        '<div class="report-card">durable</div>'
      );
    } finally {
      await flushDebounce();
    }
  });

  it('does not report success or retain a slot when durable publication fails', async () => {
    const badPath = join(dir, 'snapshot-directory');
    mkdirSync(badPath);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createPersistentReportStore({ filePath: badPath });
    const publish = createReportPublisher(store, new Set());
    try {
      expect(() => publish({ briefing: '<div class="report-card">unwritten</div>' })).toThrow();
      expect(store.get('briefing')).toBeUndefined();
    } finally {
      await flushDebounce();
      warn.mockRestore();
    }
  });

  it.each(['get', 'getAll', 'getAllSorted'] as const)(
    'returns a detached slot value from %s without corrupting persistence',
    async (reader) => {
      const store = createPersistentReportStore({ filePath });
      store.update('briefing', '<p>original</p>', 7);
      const originalUpdatedAt = store.get('briefing')!.updatedAt;
      const returned =
        reader === 'get'
          ? store.get('briefing')!
          : reader === 'getAll'
            ? store.getAll().briefing!
            : store.getAllSorted()[0]!;

      returned.html = '<p>tampered</p>';
      returned.priority = 99;
      returned.updatedAt = 0;

      expect(store.get('briefing')).toEqual({
        slotId: 'briefing',
        html: '<p>original</p>',
        priority: 7,
        updatedAt: originalUpdatedAt,
      });
      await flushDebounce();
      expect(createPersistentReportStore({ filePath }).get('briefing')).toEqual({
        slotId: 'briefing',
        html: '<p>original</p>',
        priority: 7,
        updatedAt: originalUpdatedAt,
      });
    }
  );
});
