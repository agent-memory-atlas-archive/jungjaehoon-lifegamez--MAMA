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
      { report: 'reminder', hourKey: '2026-09-27:09' },
      new Date('2026-09-27T00:00:00Z'),
      { timeZone: 'UTC' }
    );
    expect(prompt).toContain('what this owner session already knows');
    expect(prompt).toContain('view="pipeline"');
    expect(prompt).toContain('Update only action_required');
    expect(prompt).toContain('5–8 most urgent open items');
    expect(prompt).not.toContain('source.recent');
    expect(prompt).toContain('schedule.upcoming when this session has not read the calendar');
    expect(prompt).not.toContain('report.read');
  });

  it('sets the same action_required card cap for publishers and reminders', () => {
    const shape = buildBoardSlotShapeLines().join(' ');
    const reminder = buildScheduledReportPrompt(
      { report: 'reminder', hourKey: '2026-09-27:09' },
      new Date('2026-09-27T00:00:00Z'),
      { timeZone: 'UTC' }
    );

    expect(shape).toContain('up to 8 report-cards');
    expect(reminder).toContain('5–8 most urgent open items');
  });
});
