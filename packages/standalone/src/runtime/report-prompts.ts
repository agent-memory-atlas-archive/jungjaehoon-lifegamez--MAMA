import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import { buildBoardPublishLines } from '../operator/board-slot-instructions.js';

export interface ScheduledReport {
  report: 'full' | 'reminder';
  hourKey: string;
  previousFullReportAt: string | null;
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
  const previousFullReportAt = payload.previousFullReportAt;
  if (previousFullReportAt !== undefined && previousFullReportAt !== null && typeof previousFullReportAt !== 'string') {
    throw new Error('Scheduled report previousFullReportAt must be a time or null');
  }
  return {
    report: payload.report,
    hourKey: payload.hourKey,
    previousFullReportAt: typeof previousFullReportAt === 'string' ? previousFullReportAt : null,
  };
}

/** Port the report instructions using the product's current actions and board slots. */
export function buildScheduledReportPrompt(
  payload: JsonValue | undefined,
  now: Date,
  options: { wikiEnabled?: boolean; messenger?: string } = {}
): string {
  const { report, previousFullReportAt } = scheduledReport(payload);
  const recentSince = previousFullReportAt === null
    ? '24h ago'
    : `${previousFullReportAt.slice(0, 10)}T${previousFullReportAt.slice(11)}:00:00+09:00`;
  const fullReportChecklist = [
    `Current time: ${now.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} (KST)`,
    `Checklist: call source.recent with since="${recentSince}" for changes since that time, work.list with view="pipeline", and schedule.upcoming with days=14.`,
    'Read originals with source.read when a recent line changes the report; distinguish an empty result from failed or stale collection.',
    'Compare every open deadline with the event and holiday calendar; use event end times when deciding whether a booking overlaps.',
    'Name work items under each stage. List every item waiting on an owner decision, with the decision requested.',
    'Say plainly when there were no changes. Include the owner schedule section and list its upcoming events and holidays.',
  ];
  const instructions =
    report === 'full'
      ? [
          '[scheduled_full_report]',
          ...fullReportChecklist,
          ...buildBoardPublishLines(),
          ...(options.wikiEnabled === false
            ? []
            : [
                'After publishing the board, update each affected topic wiki page with manage.wiki.update, creating one with manage.wiki.publish only when no topic page fits; split separate topic page updates across subagents inside this turn. Write the daily/YYYY-MM-DD.md journal grouped by project with one entry per moved item, and put lessons under lessons/.',
              ]),
          'Write the Korean report in five parts, in order: key situation today; needs a response; needs a decision; pipeline with each stage and item; next actions. Put the owner schedule and holidays under key situation today.',
        ]
      : [
          '[scheduled_task_reminder]',
          'Use what this owner session already knows and call work.list with view="pipeline" for the compact open-work list. Read source originals only when needed to resolve a material uncertainty.',
          'Call schedule.upcoming when this session has not read the calendar.',
          'Select the 5–8 most urgent open items. Include every item waiting on an owner decision and any deadline affected by a calendar event or holiday.',
          'Update only action_required with report.publish({ slots: { action_required: "<html>" } }); scheduled full reports handle the other slots and wiki resync.',
          'Return only a concise Korean reminder of 3–6 lines, most urgent or nearest deadline first, under a short Korean title that names the top N priorities.',
        ];
  return [
    ...instructions,
    'Owner-facing text carries no commitment, observation, judgment or channel ids; use readable work titles and sentences.',
    `Messenger: ${options.messenger ?? 'telegram'}. Format the final output for this messenger: Telegram HTML subset with no Markdown; Discord Markdown; Slack mrkdwn. Board div/span/CSS belongs only in report.publish. No code-block wrapper, working notes or [notify]/[ack] tags.`,
  ].join('\n');
}
