import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { REPLAY_WINDOW_SIZE_MS } from './replay-source-catalog.js';

export type ReplayDeltaStatus = 'accepted' | 'settled';

export interface ReplayCursorWindow {
  startMs: number;
  endMs: number;
  deltas: Record<string, ReplayDeltaStatus>;
}

export interface ReplayCursor {
  version: 1;
  runId: string;
  policyFingerprint: string;
  fromMs: number;
  untilMs: number;
  windowSizeMs: number;
  nextWindowStartMs: number;
  currentWindow: ReplayCursorWindow;
}

export interface ReplayCursorIdentity {
  runId: string;
  policyFingerprint: string;
  fromMs: number;
  untilMs: number;
  windowSizeMs?: number;
}

function assertEpochMs(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a nonnegative epoch-millisecond integer`);
  }
}

function assertIdentity(identity: ReplayCursorIdentity): void {
  if (identity.runId.trim() === '' || identity.policyFingerprint.trim() === '') {
    throw new Error('Replay cursor identity is required');
  }
  assertEpochMs(identity.fromMs, 'fromMs');
  assertEpochMs(identity.untilMs, 'untilMs');
  if (identity.untilMs < identity.fromMs) throw new Error('untilMs must not precede fromMs');
  const windowSizeMs = identity.windowSizeMs ?? REPLAY_WINDOW_SIZE_MS;
  if (!Number.isSafeInteger(windowSizeMs) || windowSizeMs < 1) {
    throw new Error('windowSizeMs must be a positive safe integer');
  }
}

function nextWindow(identity: ReplayCursorIdentity, startMs: number): ReplayCursorWindow {
  return {
    startMs,
    endMs: Math.min(startMs + (identity.windowSizeMs ?? REPLAY_WINDOW_SIZE_MS), identity.untilMs),
    deltas: {},
  };
}

export function createReplayCursor(identity: ReplayCursorIdentity): ReplayCursor {
  assertIdentity(identity);
  return {
    version: 1,
    runId: identity.runId,
    policyFingerprint: identity.policyFingerprint,
    fromMs: identity.fromMs,
    untilMs: identity.untilMs,
    windowSizeMs: identity.windowSizeMs ?? REPLAY_WINDOW_SIZE_MS,
    nextWindowStartMs: identity.fromMs,
    currentWindow: nextWindow(identity, identity.fromMs),
  };
}

function parseStatus(value: unknown, field: string): ReplayDeltaStatus {
  if (value !== 'accepted' && value !== 'settled')
    throw new Error(`${field} has an invalid status`);
  return value;
}

function normalizeCursor(value: unknown): ReplayCursor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Replay cursor must contain an object');
  }
  const row = value as Record<string, unknown>;
  if (row.version !== 1) throw new Error('Replay cursor version is unsupported');
  if (typeof row.runId !== 'string' || row.runId.trim() === '')
    throw new Error('Replay cursor runId is invalid');
  if (typeof row.policyFingerprint !== 'string' || row.policyFingerprint.trim() === '') {
    throw new Error('Replay cursor policyFingerprint is invalid');
  }
  assertEpochMs(row.fromMs, 'cursor.fromMs');
  assertEpochMs(row.untilMs, 'cursor.untilMs');
  assertEpochMs(row.nextWindowStartMs, 'cursor.nextWindowStartMs');
  if (
    row.untilMs < row.fromMs ||
    row.nextWindowStartMs < row.fromMs ||
    row.nextWindowStartMs > row.untilMs
  ) {
    throw new Error('Replay cursor range is invalid');
  }
  if (!Number.isSafeInteger(row.windowSizeMs) || Number(row.windowSizeMs) < 1) {
    throw new Error('Replay cursor windowSizeMs is invalid');
  }
  const windowSizeMs = Number(row.windowSizeMs);
  const current = row.currentWindow;
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    throw new Error('Replay cursor currentWindow is invalid');
  }
  const currentRow = current as Record<string, unknown>;
  assertEpochMs(currentRow.startMs, 'cursor.currentWindow.startMs');
  assertEpochMs(currentRow.endMs, 'cursor.currentWindow.endMs');
  if (currentRow.endMs < currentRow.startMs || currentRow.startMs !== row.nextWindowStartMs) {
    throw new Error('Replay cursor current window does not match nextWindowStartMs');
  }
  if (
    !currentRow.deltas ||
    typeof currentRow.deltas !== 'object' ||
    Array.isArray(currentRow.deltas)
  ) {
    throw new Error('Replay cursor deltas are invalid');
  }
  const deltas: Record<string, ReplayDeltaStatus> = {};
  for (const [id, status] of Object.entries(currentRow.deltas)) {
    if (id.trim() === '') throw new Error('Replay cursor contains a blank stimulus id');
    deltas[id] = parseStatus(status, `Replay cursor delta ${id}`);
  }
  return {
    version: 1,
    runId: row.runId,
    policyFingerprint: row.policyFingerprint,
    fromMs: row.fromMs,
    untilMs: row.untilMs,
    windowSizeMs,
    nextWindowStartMs: row.nextWindowStartMs,
    currentWindow: {
      startMs: currentRow.startMs,
      endMs: currentRow.endMs,
      deltas,
    },
  };
}

export function readReplayCursor(path: string): ReplayCursor | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    throw new Error(
      `Replay cursor is unreadable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return normalizeCursor(parsed);
}

export function assertReplayCursorIdentity(
  cursor: ReplayCursor,
  identity: ReplayCursorIdentity
): void {
  assertIdentity(identity);
  const windowSizeMs = identity.windowSizeMs ?? REPLAY_WINDOW_SIZE_MS;
  if (
    cursor.runId !== identity.runId ||
    cursor.policyFingerprint !== identity.policyFingerprint ||
    cursor.fromMs !== identity.fromMs ||
    cursor.untilMs !== identity.untilMs ||
    cursor.windowSizeMs !== windowSizeMs
  ) {
    throw new Error('Replay cursor identity does not match the requested run');
  }
}

/** Write a cursor with flush-and-rename so a crash leaves the previous cursor intact. */
export function writeReplayCursor(path: string, cursor: ReplayCursor): void {
  const normalized = normalizeCursor(cursor);
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

export function markReplayDelta(
  cursor: ReplayCursor,
  stimulusId: string,
  status: ReplayDeltaStatus
): ReplayCursor {
  if (stimulusId.trim() === '') throw new Error('Replay stimulus id is required');
  const existing = cursor.currentWindow.deltas[stimulusId];
  if (existing === 'settled' && status === 'accepted') {
    throw new Error(`Replay delta ${stimulusId} cannot return from settled to accepted`);
  }
  return {
    ...cursor,
    currentWindow: {
      ...cursor.currentWindow,
      deltas: { ...cursor.currentWindow.deltas, [stimulusId]: status },
    },
  };
}

export function advanceReplayCursor(cursor: ReplayCursor): ReplayCursor {
  if (Object.values(cursor.currentWindow.deltas).some((status) => status !== 'settled')) {
    throw new Error('Replay cursor cannot advance before every delta settles');
  }
  const nextWindowStartMs = cursor.currentWindow.endMs;
  return {
    ...cursor,
    nextWindowStartMs,
    currentWindow: {
      startMs: nextWindowStartMs,
      endMs: Math.min(nextWindowStartMs + cursor.windowSizeMs, cursor.untilMs),
      deltas: {},
    },
  };
}
