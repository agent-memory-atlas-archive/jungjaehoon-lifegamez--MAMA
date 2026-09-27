import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';

class FakeChild extends EventEmitter {
  killed = false;
  signals: string[] = [];
  kill(signal: string): boolean {
    this.signals.push(signal);
    // Node marks a child killed as soon as a signal is delivered, whether or not it exits.
    this.killed = true;
    return true;
  }
}

function timedOut(child: FakeChild): void {
  const proc = new PersistentClaudeProcess({ sessionId: 'fixture-session' } as never);
  (proc as unknown as { process: FakeChild }).process = child;
  (proc as unknown as { handleTimeout(): void }).handleTimeout();
}

describe('persistent CLI request timeout', () => {
  afterEach(() => vi.useRealTimers());

  it('escalates to SIGKILL when the child ignores SIGTERM', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    timedOut(child);
    vi.advanceTimersByTime(3000);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not SIGKILL a child that exited after SIGTERM', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    timedOut(child);
    child.emit('exit', null, 'SIGTERM');
    vi.advanceTimersByTime(3000);
    expect(child.signals).toEqual(['SIGTERM']);
  });
});
