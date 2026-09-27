import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { W1ReportsConfig } from './config.js';
import type { StimulusIntake } from './stimulus-delivery.js';
import { scheduledReport } from './report-prompts.js';

interface ReportScheduleState {
  lastFullKey: string | null;
  lastReminderKey: string | null;
}

export interface ReportSchedulerOptions {
  config: W1ReportsConfig;
  statePath: string;
  intake: Pick<StimulusIntake, 'acceptScheduled'>;
  /** Includes queued/retrying inputs across restarts, excludes uncertain failed turns. */
  hasPendingReport: () => boolean;
  sendToOwner: (text: string, idempotencyKey: string) => Promise<void>;
  onError: (error: unknown) => void;
}

const KST_HOUR = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
});

function loadState(path: string): ReportScheduleState {
  if (!existsSync(path)) return { lastFullKey: null, lastReminderKey: null };
  const state: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    !state ||
    typeof state !== 'object' ||
    !['lastFullKey', 'lastReminderKey'].every((key) => {
      const value = (state as Record<string, unknown>)[key];
      return (
        value === null || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}:\d{2}$/.test(value))
      );
    })
  )
    throw new Error('Invalid report schedule state');
  return state as ReportScheduleState;
}

/** Produce scheduled owner turns; the mailbox holds the one-at-a-time boundary. */
export function createReportScheduler(options: ReportSchedulerOptions) {
  let state = loadState(options.statePath);
  let timer: ReturnType<typeof setInterval> | undefined;
  const tick = (now = new Date()): void => {
    if (options.hasPendingReport()) return;
    const parts = KST_HOUR.formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((entry) => entry.type === type)!.value;
    const hour = Number(part('hour'));
    const hourKey = `${part('year')}-${part('month')}-${part('day')}:${part('hour')}`;
    const full = options.config.full_report_hours.includes(hour);
    if (
      full
        ? state.lastFullKey === hourKey
        : hour < options.config.reminder_start_hour ||
          hour > options.config.reminder_end_hour ||
          state.lastReminderKey === hourKey
    )
      return;
    // A failed accepted turn is uncertain in the mailbox. R5 explicitly asks for
    // a new model attempt on the next tick; reusing its id would deduplicate it.
    options.intake.acceptScheduled({
      id: `report:${hourKey}:${randomUUID()}`,
      channelKey: 'schedule',
      occurredAt: now.getTime(),
      payload: { report: full ? 'full' : 'reminder', hourKey },
    });
  };
  return {
    tick,
    start: () => {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        try {
          tick();
        } catch (error) {
          options.onError(error);
        }
      }, 60_000);
      timer.unref();
    },
    // The daemon stops producers first, then drains the owner before Telegram.
    stop: () => {
      clearInterval(timer);
      timer = undefined;
    },
    onResult: async (
      row: Pick<MailboxRow, 'stimulusId' | 'payload'>,
      result: Pick<NativeTurnResult, 'response'>
    ): Promise<void> => {
      const { report, hourKey } = scheduledReport(row.payload);
      const text = result.response.trim();
      if (!text) throw new Error('Scheduled report returned empty output');
      await options.sendToOwner(text, `report:${hourKey}:${report}`);
      const next = { ...state, [report === 'full' ? 'lastFullKey' : 'lastReminderKey']: hourKey };
      mkdirSync(dirname(options.statePath), { recursive: true });
      const temporary = `${options.statePath}.tmp`;
      writeFileSync(temporary, JSON.stringify(next, null, 2), 'utf8');
      renameSync(temporary, options.statePath);
      state = next;
    },
  };
}

export type ReportScheduler = ReturnType<typeof createReportScheduler>;
