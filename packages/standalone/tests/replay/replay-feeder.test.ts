import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { StimulusReceipt } from '@jungjaehoon/mama-core/runtime/runtime';
import { sourceDeltaStimulusId, type StimulusIntake } from '../../src/runtime/stimulus-delivery.js';
import {
  ReplaySourceCatalog,
  type ReplaySourceEvent,
} from '../../src/replay/replay-source-catalog.js';
import { ReplayFeeder } from '../../src/replay/replay-feeder.js';

const HOUR = 60 * 60 * 1_000;
const start = Date.parse('2026-09-01T00:00:00.000+09:00');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function event(overrides: Partial<ReplaySourceEvent> = {}): ReplaySourceEvent {
  return {
    connector: 'slack',
    sourceId: 'source-a',
    observationRef: 'observation-a',
    channelKey: 'channel-a',
    sourceAtMs: start + HOUR,
    observedAtMs: start + 10 * HOUR,
    rawRowId: 1,
    ...overrides,
  };
}

function row(
  stimulusId: string,
  status: MailboxRow['status'],
  state: 'settled' | 'prepared' | 'uncertain'
) {
  return {
    id: 1,
    stimulusId,
    principalId: 'owner',
    kind: 'source_delta' as const,
    channelKey: 'channel-a',
    refs: [],
    preview: [],
    replyTo: null,
    coalesceKey: null,
    occurredAt: start + HOUR,
    createdAt: start,
    status,
    attempts: 0,
    nativeDelivery: {
      invocationId: 'invocation-1',
      state,
      dispatch: null,
      receipt: null,
      error: null,
    },
  } satisfies MailboxRow;
}

function harness(
  events: readonly ReplaySourceEvent[],
  overrides: {
    onAccept?: (id: string, delta: Parameters<StimulusIntake['acceptSourceDelta']>[0]) => void;
    readInput?: (id: string) => MailboxRow | null;
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), 'mama-replay-feeder-'));
  roots.push(root);
  const accepted = new Map<string, MailboxRow>();
  const ceilings: Array<number | undefined> = [];
  const intake: Pick<StimulusIntake, 'acceptSourceDelta'> = {
    acceptSourceDelta: vi.fn((delta) => {
      const id = sourceDeltaStimulusId(delta);
      const acceptedRow = row(id, 'acked', 'settled');
      accepted.set(id, acceptedRow);
      overrides.onAccept?.(id, delta);
      // Like the core runtime: inputId is the mailbox row number, not the stimulus id.
      return { inputId: String(accepted.size), state: 'accepted' } satisfies StimulusReceipt;
    }),
  };
  const feeder = new ReplayFeeder({
    catalog: new ReplaySourceCatalog(events),
    intake,
    mailbox: {
      readInput: (id: string, _principalId: string) =>
        overrides.readInput?.(id) ?? accepted.get(id) ?? null,
    },
    principalId: 'owner',
    runId: 'run-1',
    policyFingerprint: 'policy-1',
    fromMs: start,
    untilMs: start + 12 * HOUR,
    cursorPath: join(root, 'cursor.json'),
    ledgerPath: join(root, 'ledger.jsonl'),
    setReplaySourceEndMs: (value) => ceilings.push(value),
    settlePollMs: 0,
    settleTimeoutMs: 100,
    sleep: async () => {},
  });
  return { feeder, intake, accepted, ceilings, root };
}

describe('ReplayFeeder', () => {
  it('accepts and settles deltas sequentially with a source-time ceiling', async () => {
    const order: string[] = [];
    const { feeder, ceilings, root } = harness(
      [
        event({
          sourceId: 'source-b',
          observationRef: 'observation-b',
          sourceAtMs: start + 2 * HOUR,
          rawRowId: 2,
        }),
        event({
          connector: 'trello',
          sourceId: 'source-c',
          observationRef: 'observation-c',
          channelKey: 'board-a',
          sourceAtMs: start + 3 * HOUR,
          rawRowId: 3,
        }),
      ],
      {
        onAccept: (id) => order.push(id),
      }
    );

    const result = await feeder.run();

    expect(result).toMatchObject({ windows: 1, deltas: 2, settled: 2 });
    expect(order).toHaveLength(2);
    expect(ceilings).toContain(start + 12 * HOUR - 1);
    const cursor = JSON.parse(readFileSync(join(root, 'cursor.json'), 'utf8')) as {
      nextWindowStartMs: number;
      currentWindow: { deltas: Record<string, string> };
    };
    expect(cursor.nextWindowStartMs).toBe(start + 12 * HOUR);
    expect(Object.values(cursor.currentWindow.deltas)).toEqual([]);
    expect(readFileSync(join(root, 'ledger.jsonl'), 'utf8').trim().split('\n')).toHaveLength(4);
  });

  it('fails the preflight before accepting a channel with more than 500 refs', async () => {
    const events = Array.from({ length: 501 }, (_, index) =>
      event({
        sourceId: `source-${index}`,
        observationRef: `observation-${index}`,
        sourceAtMs: start + HOUR,
        rawRowId: index + 1,
      })
    );
    const { feeder, intake } = harness(events);

    await expect(feeder.run()).rejects.toThrow(/500 refs/);
    expect(intake.acceptSourceDelta).not.toHaveBeenCalled();
  });

  it('stops on an uncertain native delivery without advancing the window', async () => {
    const { feeder, root } = harness([event()], {
      readInput: (id) => row(id, 'claimed', 'uncertain'),
    });

    await expect(feeder.run()).rejects.toThrow(/uncertain|settled/i);
    const cursor = JSON.parse(readFileSync(join(root, 'cursor.json'), 'utf8')) as {
      nextWindowStartMs: number;
    };
    expect(cursor.nextWindowStartMs).toBe(start);
  });
});
