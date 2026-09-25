import type { Mailbox, MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import { sourceDeltaStimulusId, type StimulusIntake } from '../runtime/stimulus-delivery.js';
import {
  advanceReplayCursor,
  assertReplayCursorIdentity,
  createReplayCursor,
  markReplayDelta,
  readReplayCursor,
  writeReplayCursor,
  type ReplayCursor,
} from './replay-cursor.js';
import {
  REPLAY_REFERENCE_CAP,
  REPLAY_WINDOW_SIZE_MS,
  ReplaySourceCatalog,
  type ReplayLedgerDigestItem,
  type ReplayWindow,
} from './replay-source-catalog.js';
import type { WindowQueue } from './window-queue.js';
import { ReplayLedger } from './replay-ledger.js';
import type { SourceDelta } from '../connectors/framework/polling-scheduler.js';

export interface ReplayFeederOptions {
  catalog: ReplaySourceCatalog;
  intake: Pick<StimulusIntake, 'acceptSourceDelta'>;
  mailbox: Pick<Mailbox, 'readInput'>;
  principalId: string;
  runId: string;
  policyFingerprint: string;
  fromMs: number;
  untilMs: number;
  cursorPath: string;
  ledgerPath: string;
  setReplaySourceEndMs: (value: number | undefined) => void;
  readLedgerDigest?: (asOfMs?: number) => readonly ReplayLedgerDigestItem[];
  buildQueue?: (
    window: ReplayWindow,
    ledgerDigest: readonly ReplayLedgerDigestItem[] | undefined
  ) => Promise<WindowQueue>;
  settlePollMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface ReplayPreflight {
  windows: readonly ReplayWindow[];
  deltas: readonly SourceDelta[];
  oversizedDeltas: number;
}

export interface ReplayFeederResult {
  runId: string;
  windows: number;
  deltas: number;
  settled: number;
  nextWindowStartMs: number;
}

function assertMs(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid`);
}

function sourceTimes(delta: SourceDelta): number[] {
  const values = delta.refs.map((ref) => Date.parse(ref.sourceAt));
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`Replay delta ${delta.channel} has an invalid source time`);
  }
  return values;
}

function deltaLedgerFields(delta: SourceDelta): {
  firstSourceAtMs: number;
  lastSourceAtMs: number;
} {
  if (delta.refs.length === 0) {
    if (delta.replay === undefined) throw new Error('Replay delta must contain a replay window');
    return {
      firstSourceAtMs: delta.replay.windowStartMs,
      lastSourceAtMs: delta.replay.windowStartMs,
    };
  }
  const times = sourceTimes(delta);
  return { firstSourceAtMs: Math.min(...times), lastSourceAtMs: Math.max(...times) };
}

export class ReplayFeeder {
  private readonly settlePollMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: ReplayFeederOptions) {
    if (options.principalId.trim() === '') throw new Error('Replay principalId is required');
    if (options.runId.trim() === '') throw new Error('Replay runId is required');
    if (options.policyFingerprint.trim() === '')
      throw new Error('Replay policyFingerprint is required');
    assertMs(options.fromMs, 'fromMs');
    assertMs(options.untilMs, 'untilMs');
    if (options.untilMs < options.fromMs) throw new Error('untilMs must not precede fromMs');
    this.settlePollMs = options.settlePollMs ?? 250;
    if (!Number.isSafeInteger(this.settlePollMs) || this.settlePollMs < 0) {
      throw new Error('settlePollMs must be a nonnegative safe integer');
    }
    this.sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  private existingCursor(): ReplayCursor | null {
    return readReplayCursor(this.options.cursorPath);
  }

  private identity(runId: string) {
    return {
      runId,
      policyFingerprint: this.options.policyFingerprint,
      fromMs: this.options.fromMs,
      untilMs: this.options.untilMs,
      windowSizeMs: REPLAY_WINDOW_SIZE_MS,
    } as const;
  }

  private resolvedRunId(existing: ReplayCursor | null): string {
    return existing?.runId ?? this.options.runId;
  }

  preflight(): ReplayPreflight {
    const existing = this.existingCursor();
    const runId = this.resolvedRunId(existing);
    if (existing) assertReplayCursorIdentity(existing, this.identity(runId));
    const windows = this.options.catalog.windows(this.options.fromMs, this.options.untilMs);
    const deltas = windows.flatMap((window) =>
      this.options.catalog.deltasForWindow(runId, window.startMs, window.endMs)
    );
    const oversizedDeltas = deltas.filter(
      (delta) => delta.refs.length > REPLAY_REFERENCE_CAP
    ).length;
    if (oversizedDeltas > 0) {
      throw new Error(
        `Replay preflight failed: ${String(oversizedDeltas)} delta(s) exceed ${String(REPLAY_REFERENCE_CAP)} refs`
      );
    }
    return Object.freeze({ windows, deltas: Object.freeze(deltas), oversizedDeltas });
  }

  private row(stimulusId: string): MailboxRow {
    const found = this.options.mailbox.readInput(stimulusId, this.options.principalId);
    if (!found) throw new Error(`Replay stimulus ${stimulusId} is missing from the mailbox`);
    return found;
  }

  private assertNotLost(stimulusId: string, row: MailboxRow): void {
    if (row.status === 'dead') {
      throw new Error(`Replay stimulus ${stimulusId} is dead; replay stopped`);
    }
    if (row.nativeDelivery?.state === 'uncertain') {
      throw new Error(`Replay stimulus ${stimulusId} is uncertain; replay stopped`);
    }
  }

  /**
   * Wait until the delivery settles. A model turn takes minutes, so there is no feeder-side
   * deadline: the turn has its own configured timeout, a pre-dispatch failure returns the row
   * to the mailbox's retry (dead after its attempts), and a post-dispatch failure is uncertain.
   * Dead and uncertain stop the replay loudly in assertNotLost.
   */
  private async waitForSettled(stimulusId: string): Promise<void> {
    for (;;) {
      const row = this.row(stimulusId);
      this.assertNotLost(stimulusId, row);
      if (row.status === 'acked' && row.nativeDelivery?.state === 'settled') return;
      await this.sleep(this.settlePollMs);
    }
  }

  private async deliverDelta(
    cursor: ReplayCursor,
    ledger: ReplayLedger,
    window: ReplayWindow,
    delta: SourceDelta
  ): Promise<ReplayCursor> {
    const stimulusId = sourceDeltaStimulusId(delta);
    const status = cursor.currentWindow.deltas[stimulusId];
    if (status === 'settled') return cursor;
    const source = deltaLedgerFields(delta);
    const ceiling = window.endMs - 1;
    if (ceiling < 0) throw new Error('Replay window has no inclusive source ceiling');
    this.options.setReplaySourceEndMs(ceiling);
    try {
      if (status === undefined) {
        const existing = this.options.mailbox.readInput(stimulusId, this.options.principalId);
        // The receipt's inputId is the mailbox row number, not the stimulus id; admission is
        // proven by reading the row back under the deterministic stimulus id below.
        if (!existing) this.options.intake.acceptSourceDelta(delta);
        const admitted = this.row(stimulusId);
        this.assertNotLost(stimulusId, admitted);
        cursor = markReplayDelta(cursor, stimulusId, 'accepted');
        writeReplayCursor(this.options.cursorPath, cursor);
        ledger.append({
          windowStartMs: window.startMs,
          windowEndMs: window.endMs,
          stimulusId,
          origin: delta.collector,
          channelKey: delta.channel,
          refCount: delta.refs.length,
          ...source,
          status: 'accepted',
        });
      }
      await this.waitForSettled(stimulusId);
      cursor = markReplayDelta(cursor, stimulusId, 'settled');
      writeReplayCursor(this.options.cursorPath, cursor);
      ledger.append({
        windowStartMs: window.startMs,
        windowEndMs: window.endMs,
        stimulusId,
        origin: delta.collector,
        channelKey: delta.channel,
        refCount: delta.refs.length,
        ...source,
        status: 'settled',
      });
      return cursor;
    } catch (error) {
      const row = this.options.mailbox.readInput(stimulusId, this.options.principalId);
      if (row?.status === 'dead' || row?.nativeDelivery?.state === 'uncertain') {
        ledger.append({
          windowStartMs: window.startMs,
          windowEndMs: window.endMs,
          stimulusId,
          origin: delta.collector,
          channelKey: delta.channel,
          refCount: delta.refs.length,
          ...source,
          status: row.nativeDelivery?.state === 'uncertain' ? 'uncertain' : 'dead',
        });
      }
      throw error;
    } finally {
      this.options.setReplaySourceEndMs(undefined);
    }
  }

  async run(): Promise<ReplayFeederResult> {
    const preflight = this.preflight();
    const existing = this.existingCursor();
    const runId = this.resolvedRunId(existing);
    let cursor = existing ?? createReplayCursor(this.identity(runId));
    if (!existing) writeReplayCursor(this.options.cursorPath, cursor);
    const ledger = new ReplayLedger(this.options.ledgerPath);
    let settled = 0;
    for (const window of preflight.windows) {
      if (cursor.nextWindowStartMs > window.startMs) continue;
      if (cursor.nextWindowStartMs < window.startMs) {
        throw new Error('Replay cursor skipped a source window');
      }
      if (
        cursor.currentWindow.startMs !== window.startMs ||
        cursor.currentWindow.endMs !== window.endMs
      ) {
        throw new Error('Replay cursor current window does not match the frozen source fence');
      }
      const ledgerDigest = this.options.readLedgerDigest?.(
        window.startMs === 0 ? 0 : window.startMs - 1
      );
      const queue = await this.options.buildQueue?.(window, ledgerDigest);
      const deltas = this.options.catalog.deltasForWindow(runId, window.startMs, window.endMs, {
        ...(ledgerDigest === undefined ? {} : { ledgerDigest }),
        ...(queue === undefined ? {} : { queue }),
      });
      for (const delta of deltas) {
        cursor = await this.deliverDelta(cursor, ledger, window, delta);
        settled += 1;
      }
      cursor = advanceReplayCursor(cursor);
      writeReplayCursor(this.options.cursorPath, cursor);
    }
    return {
      runId,
      windows: preflight.windows.length,
      deltas: preflight.deltas.length,
      settled,
      nextWindowStartMs: cursor.nextWindowStartMs,
    };
  }
}
