import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import { actionName, type OwnerRuntimeBackend } from './owner-system-prompt.js';
import { epochAtLocalDateTime, localStamp } from './timezone.js';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';

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
  if (
    previousFullReportAt !== undefined &&
    previousFullReportAt !== null &&
    typeof previousFullReportAt !== 'string'
  ) {
    throw new Error('Scheduled report previousFullReportAt must be a time or null');
  }
  return {
    report: payload.report,
    hourKey: payload.hourKey,
    previousFullReportAt: typeof previousFullReportAt === 'string' ? previousFullReportAt : null,
  };
}

export interface ReportTurnOptions {
  backend: OwnerRuntimeBackend;
  wikiEnabled: boolean;
  messenger: string;
  timeZone: string;
}

/** A scheduled report turn: its data and the steps for that report, as Kagemusha's report prompts carry them. */
export function buildScheduledReportPrompt(
  payload: JsonValue | undefined,
  now: Date,
  options: ReportTurnOptions
): string {
  const { report, previousFullReportAt } = scheduledReport(payload);
  if (report === 'full') return fullReportTurn(true, previousFullReportAt, now, options);
  const action = (name: string): string => actionName(options.backend, name);
  return [
    '[scheduled_task_reminder]',
    currentTime(now, options.timeZone),
    ...acknowledgedDeltaLines(payload, options.timeZone),
    `- Use what this session already knows and read the compact open-work list with work.list({ view: "pipeline" }), with schedule.upcoming({ days: 14 }) in the same ${action('code_act')} call when this session has not read the calendar. Read source originals only when needed to resolve a material uncertainty.`,
    '- Choose the open items that most need attention this hour, including every item waiting on an owner decision and any deadline affected by a calendar event or holiday, and summarize the handled source deltas above as the changes since the previous report.',
    `- Update only action_required with ${action('report.publish')}; scheduled full reports handle the other sections${options.wikiEnabled ? ' and the wiki' : ''}.`,
    '- Return a short reminder the owner can read at a glance, most urgent or nearest deadline first, under a title that names the top priorities.',
    `Messenger: ${options.messenger}`,
  ].join('\n');
}

/** The full report turn an owner message receives when it contains a registered phrase. */
export function buildOwnerFullReportPrompt(now: Date, options: ReportTurnOptions): string {
  return fullReportTurn(false, null, now, options);
}

function currentTime(now: Date, timeZone: string): string {
  return `Current time: ${now.toLocaleString('ko-KR', { timeZone })} (${timeZone})`;
}

function fullReportTurn(
  scheduled: boolean,
  previousFullReportAt: string | null,
  now: Date,
  options: ReportTurnOptions
): string {
  const action = (name: string): string => actionName(options.backend, name);
  const since =
    previousFullReportAt === null
      ? '24h ago'
      : new Date(
          epochAtLocalDateTime(
            `${previousFullReportAt.slice(0, 10)}T${previousFullReportAt.slice(11)}:00:00`,
            options.timeZone
          )
        ).toISOString();
  return [
    scheduled ? '[scheduled_full_report]' : '[owner_full_report]',
    currentTime(now, options.timeZone),
    `Changes since: ${since}${previousFullReportAt === null ? '' : ' (the previous full report)'}`,
    `- Read in one ${action('code_act')} call: const [recent, open, days] = await Promise.all([source.recent({ since }), work.list({ view: "pipeline" }), schedule.upcoming({ days: 14 })]), with since set to that time. Read originals with source.read when a recent line changes the report; distinguish an empty result from failed or stale collection.`,
    '- Compare every open deadline with the event and holiday calendar, using event end times when deciding whether a booking overlaps. Name work items under each stage and list every item waiting on an owner decision with the decision requested. Say plainly when there were no changes.',
    `- Publish all four board sections with ${action('report.publish')} before writing the text report.`,
    ...(scheduled && options.wikiEnabled
      ? [
          `- After publishing the board, update each changed topic wiki page as a resync with ${action('manage.wiki.update')}, creating one with ${action('manage.wiki.publish')} only when no topic page fits; split separate topic page updates across subagents inside this turn. Write the daily/YYYY-MM-DD.md journal grouped by project with one entry per moved item, and put lessons under lessons/.`,
        ]
      : []),
    '- Write the report in five parts, in order: key situation today (with the owner schedule and holidays); needs a response; needs a decision; pipeline with each stage and item; next actions.',
    `Messenger: ${options.messenger}`,
  ].join('\n');
}

function acknowledgedDeltaLines(payload: JsonValue | undefined, timeZone: string): string[] {
  const value =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload.acknowledgedDeltas
      : undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof value.total !== 'number' ||
    typeof value.cap !== 'number' ||
    !Array.isArray(value.items)
  )
    throw new Error(
      'A scheduled reminder needs the handled source deltas from the report scheduler'
    );
  const lines = value.items.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.channelLabel !== 'string' ||
      typeof entry.sourceAt !== 'string' ||
      typeof entry.preview !== 'string' ||
      typeof entry.observationRef !== 'string'
    )
      throw new Error(
        'A handled source delta needs channelLabel, sourceAt, preview and observationRef'
      );
    return `${entry.channelLabel} · ${localStamp(entry.sourceAt, timeZone)} · ${entry.preview} · ${entry.observationRef}`;
  });
  return [
    `Source deltas handled since the previous report (the latest ${lines.length} of ${value.total}; cap ${value.cap}; some may already have reached the owner with [notify]), times in ${timeZone}:`,
    lines.length === 0 ? 'none' : wrapUntrustedContent('source_delta', lines.join('\n')),
  ];
}
