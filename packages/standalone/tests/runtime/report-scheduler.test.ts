import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createReportScheduler } from '../../src/runtime/report-scheduler.js';
import type { ScheduledInput } from '../../src/runtime/stimulus-delivery.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reports-'));
  vi.stubEnv('HOME', root);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function setup() {
  const queued: ScheduledInput[] = [];
  const sent: string[] = [];
  const statePath = join(root, 'runtime', 'report-schedule-state.json');
  let pending = false;
  let send = async (text: string) => {
    sent.push(text);
  };
  const options = {
    config: { full_report_hours: [8, 13, 18], reminder_start_hour: 9, reminder_end_hour: 21 },
    statePath,
    intake: {
      acceptScheduled: (input: ScheduledInput) => {
        queued.push(input);
        pending = true;
        return { state: 'accepted' as const, inputId: input.id };
      },
    },
    hasPendingReport: () => pending,
    sendToOwner: (text: string, _key: string) => send(text),
    onError: (error: unknown) => {
      throw error;
    },
  };
  return {
    options,
    scheduler: createReportScheduler(options),
    queued,
    sent,
    statePath,
    setPending: (value: boolean) => {
      pending = value;
    },
    setSend: (value: typeof send) => {
      send = value;
    },
    result: () => ({ stimulusId: queued.at(-1)!.id, payload: queued.at(-1)!.payload }),
  };
}

describe('KST report scheduler', () => {
  it('uses one delivery identity across model attempts after the schedule write fails', async () => {
    const ctx = setup();
    const keys: string[] = [];
    const scheduler = createReportScheduler({
      ...ctx.options,
      sendToOwner: async (_text, key) => {
        keys.push(key);
      },
    });
    const now = new Date('2026-01-01T04:00:00Z');
    scheduler.tick(now);
    mkdirSync(join(root, 'runtime'), { recursive: true });
    mkdirSync(`${ctx.statePath}.tmp`);
    await expect(scheduler.onResult(ctx.result(), { response: 'first' })).rejects.toThrow();
    rmSync(`${ctx.statePath}.tmp`, { recursive: true });
    ctx.setPending(false);
    scheduler.tick(now);
    await scheduler.onResult(ctx.result(), { response: 'second' });
    expect(ctx.queued[0]!.id).not.toBe(ctx.queued[1]!.id);
    expect(keys).toEqual(['report:2026-01-01:13:full', 'report:2026-01-01:13:full']);
    await scheduler.onResult(
      { stimulusId: 'reminder-attempt', payload: { report: 'reminder', hourKey: '2026-01-01:13' } },
      { response: 'reminder' }
    );
    expect(keys.at(-1)).toBe('report:2026-01-01:13:reminder');
  });

  it('writes the full hour only after sending finishes and suppresses it after restart', async () => {
    const ctx = setup();
    const now = new Date('2026-01-01T23:05:00Z'); // next date, 08 KST
    ctx.scheduler.tick(now);
    expect(ctx.queued[0]!.payload).toEqual({ report: 'full', hourKey: '2026-01-02:08' });
    expect(existsSync(ctx.statePath)).toBe(false);
    let release!: () => void;
    ctx.setSend(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const result = ctx.scheduler.onResult(ctx.result(), { response: ' Full report ' });
    expect(existsSync(ctx.statePath)).toBe(false);
    ctx.scheduler.tick(now);
    expect(ctx.queued).toHaveLength(1);
    release();
    await result;
    expect(JSON.parse(readFileSync(ctx.statePath, 'utf8'))).toEqual({
      lastFullKey: '2026-01-02:08',
      lastReminderKey: null,
    });
    ctx.setPending(false);
    createReportScheduler(ctx.options).tick(now);
    expect(ctx.queued).toHaveLength(1);
  });

  it('leaves a failed send unwritten and asks the model again on the next tick', async () => {
    const ctx = setup();
    const now = new Date('2026-01-01T04:00:00Z');
    ctx.scheduler.tick(now);
    ctx.setSend(async () => {
      throw new Error('send failed');
    });
    await expect(ctx.scheduler.onResult(ctx.result(), { response: 'report' })).rejects.toThrow(
      'send failed'
    );
    expect(existsSync(ctx.statePath)).toBe(false);
    // The runtime parks the accepted failure uncertain, so it is no longer pending.
    ctx.setPending(false);
    ctx.scheduler.tick(new Date(now.getTime() + 60_000));
    expect(ctx.queued).toHaveLength(2);
    expect(ctx.queued[0]!.id).not.toBe(ctx.queued[1]!.id);
    ctx.setSend(async (text) => {
      ctx.sent.push(text);
    });
    await ctx.scheduler.onResult(ctx.result(), { response: 'new report' });
    expect(ctx.sent).toEqual(['new report']);
    expect(JSON.parse(readFileSync(ctx.statePath, 'utf8')).lastFullKey).toBe('2026-01-01:13');
  });

  it.each([
    ['2026-01-01T00:00:00Z', 'reminder', '2026-01-01:09'],
    ['2026-01-01T04:00:00Z', 'full', '2026-01-01:13'],
    ['2026-01-01T09:00:00Z', 'full', '2026-01-01:18'],
    ['2026-01-01T12:00:00Z', 'reminder', '2026-01-01:21'],
  ])('uses KST and excludes reminder at full hours: %s', async (iso, report, hourKey) => {
    const ctx = setup();
    ctx.scheduler.tick(new Date(iso));
    expect(ctx.queued[0]!.payload).toEqual({ report, hourKey });
    await ctx.scheduler.onResult(ctx.result(), { response: 'report' });
    ctx.setPending(false);
    ctx.scheduler.tick(new Date(iso));
    expect(ctx.queued).toHaveLength(1);
  });

  it('does not schedule outside the hours or overlap a queued report across hours/restart', () => {
    const ctx = setup();
    for (const iso of ['2026-01-01T13:00:00Z', '2026-01-01T22:00:00Z'])
      ctx.scheduler.tick(new Date(iso));
    expect(ctx.queued).toHaveLength(0);
    ctx.scheduler.tick(new Date('2026-01-01T23:00:00Z'));
    const restarted = createReportScheduler(ctx.options);
    restarted.tick(new Date('2026-01-02T00:00:00Z'));
    expect(ctx.queued).toHaveLength(1);
  });

  it('ticks every 60 seconds and stops producing on shutdown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T04:00:00Z'));
    const ctx = setup();
    ctx.scheduler.start();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(ctx.queued).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(ctx.queued).toHaveLength(1);
    ctx.scheduler.stop();
    ctx.setPending(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.queued).toHaveLength(1);
  });

  it('does not send or mark empty model output', async () => {
    const ctx = setup();
    ctx.scheduler.tick(new Date('2026-01-01T04:00:00Z'));
    await expect(ctx.scheduler.onResult(ctx.result(), { response: '  ' })).rejects.toThrow(
      /empty/i
    );
    expect(ctx.sent).toEqual([]);
    expect(existsSync(ctx.statePath)).toBe(false);
  });

  it('surfaces corrupt schedule state instead of silently forgetting delivered hours', () => {
    const ctx = setup();
    writeFileSync(join(root, 'broken.json'), '{');
    expect(() =>
      createReportScheduler({ ...ctx.options, statePath: join(root, 'broken.json') })
    ).toThrow();
  });
});
