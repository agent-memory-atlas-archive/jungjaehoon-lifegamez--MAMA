import type { JsonValue } from '@jungjaehoon/mama-core/knowledge';
import { buildBoardHtmlVocabulary } from '../operator/board-slot-instructions.js';
import { epochAtLocalDateTime } from './timezone.js';
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
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const value = payload.acknowledgedDeltas;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const total = typeof value.total === 'number' ? value.total : 0;
  const cap = typeof value.cap === 'number' ? value.cap : 0;
  const items = Array.isArray(value.items) ? value.items : [];
  return [
    `Acknowledged source deltas (showing ${items.length} of ${total}; cap ${cap}) in ${timeZone}:`,
    ...items.flatMap((entry): string[] => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
      const channelLabel = typeof entry.channelLabel === 'string' ? entry.channelLabel : '';
      const sourceAt = typeof entry.sourceAt === 'string' ? entry.sourceAt : '';
      const preview = typeof entry.preview === 'string' ? entry.preview : '';
      const observationRef = typeof entry.observationRef === 'string' ? entry.observationRef : '';
      const time = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(sourceAt))
        .filter((part) => part.type !== 'literal')
        .map((part) => part.value);
      const localTime = `${time[0]}-${time[1]} ${time[2]}:${time[3]}`;
      const quotedPreview = wrapUntrustedContent('source_delta', JSON.stringify(preview)).replace(
        /\s+/g,
        ' '
      );
      return [`${channelLabel} · ${localTime} · preview=${quotedPreview} · ${observationRef}`];
    }),
  ];
}
