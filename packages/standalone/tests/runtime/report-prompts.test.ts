import { describe, expect, it } from 'vitest';
import { buildScheduledReportPrompt } from '../../src/runtime/report-prompts.js';

describe('scheduled report prompts', () => {
  it('omits wiki actions when wiki is disabled and names the delivery messenger', () => {
    const prompt = buildScheduledReportPrompt(
      { report: 'full', hourKey: '2026-09-27:08' },
      new Date('2026-09-27T00:00:00Z'),
      { wikiEnabled: false, messenger: 'slack' }
    );
    expect(prompt).not.toContain('manage.wiki.');
    expect(prompt).toContain('Messenger: slack');
    expect(prompt).toContain('Slack mrkdwn');
  });
});
