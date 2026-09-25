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
  type ReplayWindow,
} from './replay-source-catalog.js';
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
  settlePollMs?: number;
  settleTimeoutMs?: number;
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
  const times = sourceTimes(delta);
  if (times.length === 0) throw new Error('Replay delta must contain at least one ref');
  return { firstSourceAtMs: Math.min(...times), lastSourceAtMs: Math.max(...times) };
}

function deliveryState(row: MailboxRow | null): string {
  if (!row) return 'missing';
  return row.nativeDelivery?.state ?? 'not-dispatched';
}

export class ReplayFeeder {
  private readonly settlePollMs: number;
  private readonly settleTimeoutMs: number;
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
    this.settleTimeoutMs = options.settleTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.settlePollMs) || this.settlePollMs < 0) {
      throw new Error('settlePollMs must be a nonnegative safe integer');
    }
    if (!Number.isSafeInteger(this.settleTimeoutMs) || this.settleTimeoutMs < 1) {
      throw new Error('settleTimeoutMs must be a positive safe integer');
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

  private async waitForSettled(stimulusId: string): Promise<void> {
    let elapsed = 0;
    const maxAttempts = Math.max(
      1,
      Math.ceil(this.settleTimeoutMs / Math.max(this.settlePollMs, 1)) + 1
    );
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const row = this.row(stimulusId);
      this.assertNotLost(stimulusId, row);
      if (row.status === 'acked' && row.nativeDelivery?.state === 'settled') return;
      if (elapsed >= this.settleTimeoutMs || attempt + 1 >= maxAttempts) {
        throw new Error(
          `Replay stimulus ${stimulusId} did not settle (mailbox=${row.status}, native=${deliveryState(row)})`
        );
      }
      await this.sleep(this.settlePollMs);
      elapsed += Math.max(this.settlePollMs, 1);
    }
    throw new Error(`Replay stimulus ${stimulusId} did not settle`);
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
      const deltas = this.options.catalog.deltasForWindow(runId, window.startMs, window.endMs);
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
