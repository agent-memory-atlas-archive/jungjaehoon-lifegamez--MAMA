import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import { buildBoardHtmlVocabulary } from '../operator/board-slot-instructions.js';
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

/** Port the report instructions using the product's current actions and board slots. */
export function buildScheduledReportPrompt(
  payload: JsonValue | undefined,
  now: Date,
  options: { wikiEnabled?: boolean; messenger?: string; timeZone: string }
): string {
  const { report, previousFullReportAt } = scheduledReport(payload);
  const timeZone = options.timeZone;
  const recentSince =
    previousFullReportAt === null
      ? '24h ago'
      : new Date(
          epochAtLocalDateTime(
            `${previousFullReportAt.slice(0, 10)}T${previousFullReportAt.slice(11)}:00:00`,
            timeZone
          )
        ).toISOString();
  const instructions =
    report === 'full' ? ['[scheduled_full_report]'] : ['[scheduled_task_reminder]'];
  const hostData = [
    `Current time: ${now.toLocaleString('ko-KR', { timeZone })} (${timeZone})`,
    ...(report === 'full' ? [`Previous full report boundary: ${recentSince}`] : []),
    ...(report === 'full' ? buildBoardHtmlVocabulary(timeZone) : []),
    ...(report === 'reminder' ? acknowledgedDeltaLines(payload, timeZone) : []),
  ];
  return [
    ...instructions,
    ...hostData,
    'Owner-facing text carries no commitment, observation, judgment or channel ids; use readable work titles and sentences.',
    `Messenger: ${options.messenger ?? 'telegram'}. Format the final output for this messenger: Telegram HTML subset with no Markdown; Discord Markdown; Slack mrkdwn. Board div/span/CSS belongs only in report.publish. No code-block wrapper, working notes or [notify]/[ack] tags.`,
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
