import { describe, expect, it } from 'vitest';
import {
  buildOwnerFullReportPrompt,
  buildScheduledReportPrompt,
  type ReportTurnOptions,
} from '../../src/runtime/report-prompts.js';
import { buildBoardSlotShapeLines } from '../../src/operator/board-slot-instructions.js';

const turn = (overrides: Partial<ReportTurnOptions> = {}): ReportTurnOptions => ({
  backend: 'codex',
  wikiEnabled: true,
  messenger: 'telegram',
  timeZone: 'UTC',
  ...overrides,
});

const noDeltas = {
  report: 'reminder',
  hourKey: '2026-09-27:09',
  acknowledgedDeltas: { total: 0, cap: 50, items: [] },
};

describe('scheduled report prompts', () => {
  it('omits wiki actions when wiki is disabled and names the delivery messenger', () => {
    const prompt = buildScheduledReportPrompt(
      { report: 'full', hourKey: '2026-09-27:08' },
      new Date('2026-09-27T00:00:00Z'),
      turn({ wikiEnabled: false, messenger: 'slack' })
    );
    expect(prompt).not.toContain('manage.wiki.');
    expect(prompt).toContain('Messenger: slack');
    // Messenger formats are standing rules; the report turn names the messenger only.
    expect(prompt).not.toContain('Slack mrkdwn');
  });

  it('carries the reminder steps in the reminder turn: session context and one board slot', () => {
    const prompt = buildScheduledReportPrompt(noDeltas, new Date('2026-09-27T00:00:00Z'), turn());
    expect(prompt.split('\n')[0]).toBe('[scheduled_task_reminder]');
    expect(prompt).toContain('Use what this session already knows');
    expect(prompt).toContain('work.list({ view: "pipeline" })');
    expect(prompt).toContain(
      'in the same code_act call when this session has not read the calendar'
    );
    expect(prompt).toContain(
      'Update only action_required with report.publish; scheduled full reports handle the other sections and the wiki.'
    );
    expect(prompt).not.toContain('source.recent');
    expect(prompt).not.toContain('report.read');
  });

  it('carries the full report steps in the scheduled full report turn', () => {
    const prompt = buildScheduledReportPrompt(
      { report: 'full', hourKey: '2026-09-27:08' },
      new Date('2026-09-27T00:00:00Z'),
      turn()
    );
    expect(prompt.split('\n')[0]).toBe('[scheduled_full_report]');
    expect(prompt).toContain('Changes since: 24h ago\n');
    expect(prompt).toContain(
      'Read in one code_act call: const [recent, open, days] = await Promise.all([source.recent({ since }), work.list({ view: "pipeline" }), schedule.upcoming({ days: 14 })]), with since set to that time.'
    );
    expect(prompt).toContain('Publish all four board sections with report.publish');
    expect(prompt).toContain('manage.wiki.update');
    expect(prompt).toContain('daily/YYYY-MM-DD.md');
    expect(prompt).toContain('Write the report in five parts, in order');
    // The class vocabulary is the report.publish contract's, not repeated per turn.
    expect(prompt).not.toContain('Slot HTML must use ONLY this class vocabulary');
  });

  it('gives an owner-requested full report the same steps over 24 hours, without the wiki resync', () => {
    const prompt = buildOwnerFullReportPrompt(new Date('2026-09-27T00:00:00Z'), turn());
    expect(prompt.split('\n')[0]).toBe('[owner_full_report]');
    expect(prompt).toContain('Changes since: 24h ago\n');
    expect(prompt).toContain('schedule.upcoming({ days: 14 })');
    expect(prompt).toContain('Publish all four board sections with report.publish');
    expect(prompt).toContain('Write the report in five parts, in order');
    expect(prompt).not.toContain('manage.wiki.');
  });

  it('names actions the way the Claude CLI exposes them', () => {
    const prompt = buildOwnerFullReportPrompt(
      new Date('2026-09-27T00:00:00Z'),
      turn({ backend: 'claude' })
    );
    // The tool is named as the CLI exposes it; the functions inside the code keep action names.
    expect(prompt).toContain('Read in one mcp__mama__code_act call');
    expect(prompt).toContain('mcp__mama__report_publish');
    expect(prompt).toContain('source.recent({ since })');
  });

  it('ranks action_required by urgency for publishers and reminders, without a card count', () => {
    const shape = buildBoardSlotShapeLines().join(' ');
    const reminder = buildScheduledReportPrompt(noDeltas, new Date('2026-09-27T00:00:00Z'), turn());

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
      turn({ timeZone: 'Asia/Seoul' })
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
        turn({ timeZone: 'Asia/Seoul' })
      )
    ).toThrow('A scheduled reminder needs the handled source deltas from the report scheduler');
  });
});
