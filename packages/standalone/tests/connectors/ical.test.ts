import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseICalendar } from '../../src/connectors/ical/parser.js';
import { loadConnector } from '../../src/connectors/index.js';

const calendar = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:event-1',
  'DTSTART;TZID=Asia/Seoul:20261001T100000',
  'DTEND;TZID=Asia/Seoul:20261001T110000',
  'SUMMARY:Planning\\, review',
  'STATUS:CONFIRMED',
  'LAST-MODIFIED:20260927T090000Z',
  'END:VEVENT',
  'END:VCALENDAR',
  '',
].join('\r\n');

describe('iCal connector', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.MAMA_ICAL_URL_PRIMARY;
  });

  it('parses VEVENT dates, escaped text, status and revisions', () => {
    expect(parseICalendar(calendar)).toEqual([
      {
        uid: 'event-1',
        start: '2026-10-01T01:00:00.000Z',
        end: '2026-10-01T02:00:00.000Z',
        summary: 'Planning, review',
        status: 'confirmed',
        revisionTime: Date.parse('2026-09-27T09:00:00Z'),
      },
    ]);
  });

  it('emits stable entity ids and unchanged revisions for raw-store deduplication', async () => {
    process.env.MAMA_ICAL_URL_PRIMARY = 'https://example.invalid/calendar.ics?secret=never-log';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => calendar });
    vi.stubGlobal('fetch', fetchMock);
    const connector = await loadConnector('ical', {
      enabled: true,
      pollIntervalMinutes: 5,
      auth: { type: 'token' },
      channels: { primary: { role: 'reference', name: 'Schedule', feedName: 'Feed' } },
    });
    await connector.init();
    const first = await connector.poll(new Date(0));
    const second = await connector.poll(new Date(0));
    expect(first[0]).toMatchObject({
      source: 'ical',
      channel: 'primary',
      sourceEntityId: 'primary:event-1',
      metadata: { feedName: 'Feed', summary: 'Planning, review' },
    });
    expect(second[0]?.sourceId).toBe(first[0]?.sourceId);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('names a failing feed without including its secret URL', async () => {
    process.env.MAMA_ICAL_URL_PRIMARY = 'https://example.invalid/secret-path';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('request failed https://example.invalid/secret-path'))
    );
    const connector = await loadConnector('ical', {
      enabled: true,
      pollIntervalMinutes: 5,
      auth: { type: 'token' },
      channels: { primary: { role: 'reference', name: 'Schedule' } },
    });
    await expect(connector.poll(new Date(0))).rejects.toThrow('iCal feed Schedule fetch failed');
    await expect(connector.healthCheck()).resolves.toMatchObject({
      error: 'iCal feed Schedule fetch failed',
    });
  });
});
