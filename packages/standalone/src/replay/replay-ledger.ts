import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';

export type ReplayLedgerStatus = 'accepted' | 'settled' | 'dead' | 'uncertain';

export interface ReplayLedgerEntry {
  sequence: number;
  windowStartMs: number;
  windowEndMs: number;
  stimulusId: string;
  origin: string;
  channelFingerprint: string;
  refCount: number;
  firstSourceAtMs: number;
  lastSourceAtMs: number;
  status: ReplayLedgerStatus;
}

export interface ReplayLedgerDelta {
  windowStartMs: number;
  windowEndMs: number;
  stimulusId: string;
  origin: string;
  channelKey: string;
  refCount: number;
  firstSourceAtMs: number;
  lastSourceAtMs: number;
  status: ReplayLedgerStatus;
}

function assertMs(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} is invalid`);
}

function assertEntry(entry: ReplayLedgerEntry): void {
  if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1)
    throw new Error('Replay ledger sequence is invalid');
  assertMs(entry.windowStartMs, 'Replay ledger windowStartMs');
  assertMs(entry.windowEndMs, 'Replay ledger windowEndMs');
  assertMs(entry.firstSourceAtMs, 'Replay ledger firstSourceAtMs');
  assertMs(entry.lastSourceAtMs, 'Replay ledger lastSourceAtMs');
  if (entry.windowEndMs < entry.windowStartMs || entry.lastSourceAtMs < entry.firstSourceAtMs) {
    throw new Error('Replay ledger time order is invalid');
  }
  if (entry.stimulusId.trim() === '' || entry.origin.trim() === '')
    throw new Error('Replay ledger identity is invalid');
  if (!/^[a-f0-9]{64}$/.test(entry.channelFingerprint))
    throw new Error('Replay ledger channel fingerprint is invalid');
  if (!Number.isSafeInteger(entry.refCount) || entry.refCount < 1)
    throw new Error('Replay ledger refCount is invalid');
  if (!['accepted', 'settled', 'dead', 'uncertain'].includes(entry.status)) {
    throw new Error('Replay ledger status is invalid');
  }
}

function parseLedger(path: string): ReplayLedgerEntry[] {
  if (!existsSync(path)) return [];
  const source = readFileSync(path, 'utf8');
  if (source.trim() === '') return [];
  const entries = source
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as ReplayLedgerEntry);
  let previous = 0;
  for (const entry of entries) {
    assertEntry(entry);
    if (entry.sequence <= previous)
      throw new Error('Replay ledger sequence is not strictly increasing');
    previous = entry.sequence;
  }
  return entries;
}

export function readReplayLedger(path: string): readonly ReplayLedgerEntry[] {
  return Object.freeze(parseLedger(path));
}

export class ReplayLedger {
  private sequence: number;

  constructor(private readonly path: string) {
    const entries = parseLedger(path);
    this.sequence = entries.at(-1)?.sequence ?? 0;
    mkdirSync(dirname(path), { recursive: true });
  }

  append(delta: ReplayLedgerDelta): ReplayLedgerEntry {
    const entry: ReplayLedgerEntry = {
      sequence: this.sequence + 1,
      windowStartMs: delta.windowStartMs,
      windowEndMs: delta.windowEndMs,
      stimulusId: delta.stimulusId,
      origin: delta.origin,
      channelFingerprint: createHash('sha256').update(delta.channelKey, 'utf8').digest('hex'),
      refCount: delta.refCount,
      firstSourceAtMs: delta.firstSourceAtMs,
      lastSourceAtMs: delta.lastSourceAtMs,
      status: delta.status,
    };
    assertEntry(entry);
    const descriptor = openSync(this.path, 'a', 0o600);
    try {
      const line = `${JSON.stringify(entry)}\n`;
      writeFileSync(descriptor, line, 'utf8');
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.sequence = entry.sequence;
    return entry;
  }
}
