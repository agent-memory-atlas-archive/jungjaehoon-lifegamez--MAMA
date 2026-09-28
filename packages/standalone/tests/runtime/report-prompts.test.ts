import { describe, expect, it } from 'vitest';
import { buildScheduledReportPrompt } from '../../src/runtime/report-prompts.js';
import { buildBoardSlotShapeLines } from '../../src/operator/board-slot-instructions.js';

describe('scheduled report prompts', () => {
  it('omits wiki actions when wiki is disabled and names the delivery messenger', () => {
    const prompt = buildScheduledReportPrompt(
      { report: 'full', hourKey: '2026-09-27:08' },
      new Date('2026-09-27T00:00:00Z'),
      { wikiEnabled: false, messenger: 'slack', timeZone: 'UTC' }
    );
    expect(prompt).not.toContain('manage.wiki.');
    expect(prompt).toContain('Messenger: slack');
    expect(prompt).toContain('Slack mrkdwn');
  });

  it('keeps reminders on the session context and one board slot', () => {
    const prompt = buildScheduledReportPrompt(
      {
        report: 'reminder',
        hourKey: '2026-09-27:09',
        acknowledgedDeltas: { total: 0, cap: 50, items: [] },
      },
      new Date('2026-09-27T00:00:00Z'),
      { timeZone: 'UTC' }
    );
    expect(prompt).not.toContain('what this owner session already knows');
    expect(prompt).not.toContain('view="pipeline"');
    expect(prompt).not.toContain('Update only action_required');
    expect(prompt).not.toContain('5–8 most urgent open items');
    expect(prompt).not.toContain('Select the');
    expect(prompt).not.toContain('source.recent');
    expect(prompt).not.toContain('schedule.upcoming when this session has not read the calendar');
    expect(prompt).not.toContain('report.read');
  });

  it('ranks action_required by urgency for publishers and reminders, without a card count', () => {
    const shape = buildBoardSlotShapeLines().join(' ');
    const reminder = buildScheduledReportPrompt(
      {
        report: 'reminder',
        hourKey: '2026-09-27:09',
        acknowledgedDeltas: { total: 0, cap: 50, items: [] },
      },
      new Date('2026-09-27T00:00:00Z'),
      { timeZone: 'UTC' }
    );

    expect(shape).toContain('most urgent first');
    expect(shape).not.toMatch(/up to \d+ report-cards/);
    expect(reminder).not.toContain('5–8 most urgent open items');
  });

  it('lists acknowledged deltas with the host supplied cap and total', () => {
    const prompt = buildScheduledReportPrompt(
      {
        report: 'reminder',
        hourKey: '2026-09-27:09',
        acknowledgedDeltas: {
          total: 51,
          cap: 50,
          items: [
            {
              channelLabel: 'Work chat',
              sourceAt: '2026-09-26T23:42:00.000Z',
              preview: 'A change was submitted',
              observationRef: 'obs_1',
            },
          ],
        },
      },
      new Date('2026-09-27T00:00:00Z'),
      { timeZone: 'Asia/Seoul' }
    );

    expect(prompt).toContain(
      'Source deltas handled since the previous report (the latest 1 of 51; cap 50; some may already have reached the owner with [notify])'
    );
    expect(prompt).toContain('source=source_delta');
    expect(prompt).toContain('Work chat · 09-27 08:42 · A change was submitted · obs_1');
  });

  it('refuses a reminder without the handled source deltas', () => {
    expect(() =>
      buildScheduledReportPrompt(
        { report: 'reminder', hourKey: '2026-09-27:09' },
        new Date('2026-09-27T00:00:00Z'),
        { timeZone: 'Asia/Seoul' }
      )
    ).toThrow('A scheduled reminder needs the handled source deltas from the report scheduler');
  });
});
