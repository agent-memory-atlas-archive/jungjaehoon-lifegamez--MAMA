import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import { buildBoardPublishLines } from '../operator/board-slot-instructions.js';

export interface ScheduledReport {
  report: 'full' | 'reminder';
  hourKey: string;
}

export function scheduledReport(payload: JsonValue | undefined): ScheduledReport {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    (payload.report !== 'full' && payload.report !== 'reminder') ||
    typeof payload.hourKey !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}:\d{2}$/.test(payload.hourKey)
  ) {
    throw new Error(
      'Scheduled report requires { report: full | reminder, hourKey: YYYY-MM-DD:HH }'
    );
  }
  return { report: payload.report, hourKey: payload.hourKey };
}

/** Port the report instructions using the product's current actions and board slots. */
export function buildScheduledReportPrompt(payload: JsonValue | undefined, now: Date): string {
  const { report } = scheduledReport(payload);
  const common = [
    `Current time: ${now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (KST)`,
    'Read current work with work.list and the current board with report.read.',
    'Use source.search and source.read for recent conversations and source evidence as needed; check collection gaps separately from no change.',
  ];
  const instructions =
    report === 'full'
      ? [
          '[scheduled_full_report]',
          ...common,
          'Read recent sources (start with the last 24 hours) together with current work before reporting.',
          'Update the wiki page for each work item changed since the last wiki update with manage.wiki.update (or manage.wiki.publish for a new case), before or with the board publish; choose the pages yourself; when several pages change, split them across subagents inside this turn.',
          ...buildBoardPublishLines(),
          'Return the full report in Korean with five parts in this order: key situation today, needs a response, needs a decision, pipeline, next actions.',
        ]
      : [
          '[scheduled_task_reminder]',
          ...common,
          'Read open work, order by priority then deadline, and select the top 5–8 items.',
          'Include what changed since the previous report that was not already notified, including gathered non-urgent updates. Judge urgency and relevance yourself.',
          'Update action_required with report.publish({ slots: { action_required: "<html>" } }); describe the action for its board HTML vocabulary. Use the report tool, not a file or shell write, to publish the board.',
          'Return only a concise Korean reminder of 3–6 lines, most urgent or nearest deadline first, under a short Korean title that names the top N priorities.',
        ];
  return [
    ...instructions,
    'Owner-facing text carries no commitment, observation, judgment or channel ids; use readable work titles and sentences.',
    'Format the final output with the standing Telegram formatting guide (bold titles, links to originals, quotes). Board div/span/CSS belongs only in report.publish. No code-block wrapper, working notes or [notify]/[ack] tags.',
  ].join('\n');
}
