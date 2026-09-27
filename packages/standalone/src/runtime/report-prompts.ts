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
export function buildScheduledReportPrompt(
  payload: JsonValue | undefined,
  now: Date,
  options: { wikiEnabled?: boolean; messenger?: string } = {}
): string {
  const { report } = scheduledReport(payload);
  const common = [
    `Current time: ${now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (KST)`,
    'Checklist: call source.recent since the last full report (or 24h ago), work.list with view="pipeline", and schedule.upcoming with days=14.',
    'Read originals with source.read when a recent line changes the report; distinguish an empty result from failed or stale collection.',
    'Compare every open deadline with the event and holiday calendar; use event end times when deciding whether a booking overlaps.',
    'Name work items under each stage. List every item waiting on an owner decision, with the decision requested.',
    'Say plainly when there were no changes. Include the owner schedule section and list its upcoming events and holidays.',
  ];
  const instructions =
    report === 'full'
      ? [
          '[scheduled_full_report]',
          ...common,
          ...buildBoardPublishLines(),
          ...(options.wikiEnabled === false
            ? []
            : [
                'After publishing the board, update the wiki page for each work item changed since its last wiki update with manage.wiki.update (or manage.wiki.publish for a new case); split several page updates across subagents inside this turn.',
              ]),
          'Write the Korean report in five parts, in order: key situation today; needs a response; needs a decision; pipeline with each stage and item; next actions. Put the owner schedule and holidays under key situation today.',
        ]
      : [
          '[scheduled_task_reminder]',
          ...common,
          'Use the checklist evidence to select the 5–8 most urgent open items. Include every item waiting on an owner decision and any deadline affected by a calendar event or holiday.',
          'Update action_required with report.publish({ slots: { action_required: "<html>" } }); the full reports and delta turns refresh the other slots and the wiki.',
          'Return only a concise Korean reminder of 3–6 lines, most urgent or nearest deadline first, under a short Korean title that names the top N priorities.',
        ];
  return [
    ...instructions,
    'Owner-facing text carries no commitment, observation, judgment or channel ids; use readable work titles and sentences.',
    `Messenger: ${options.messenger ?? 'telegram'}. Format the final output for this messenger: Telegram HTML subset with no Markdown; Discord Markdown; Slack mrkdwn. Board div/span/CSS belongs only in report.publish. No code-block wrapper, working notes or [notify]/[ack] tags.`,
  ].join('\n');
}
