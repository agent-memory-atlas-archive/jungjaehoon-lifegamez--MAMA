import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import {
  createCatalog,
  createDispatcher,
  startRuntime,
  type RuntimeHandle,
  type NativeSessionHandle,
} from '@jungjaehoon/mama-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCoreDatabase } from '../../src/runtime/core-db.js';
import {
  createStimulusDelivery,
  createStimulusIntake,
  renderWindowQueue,
  sourceDeltaStimulusId,
} from '../../src/runtime/stimulus-delivery.js';

const homes: string[] = [];
const runtimes: RuntimeHandle[] = [];
const databases: Array<Awaited<ReturnType<typeof openCoreDatabase>>> = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0).reverse()) await runtime.stop();
  for (const database of databases.splice(0).reverse()) await database.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function boot(model: NativeSessionHandle['runTurn']) {
  const home = mkdtempSync(join(tmpdir(), 'mama-stimulus-'));
  homes.push(home);
  const database = await openCoreDatabase({ path: join(home, 'state.db') });
  const adapter = database.adapter as DatabaseInstance;
  databases.push(database);
  const runtime = await startRuntime({
    paths: { socketPath: join(home, 'runtime.sock') },
    catalog: createCatalog([]),
    dispatch: createDispatcher(createCatalog([])),
    principals: [
      {
        access: { principalId: 'owner', agentId: 'agent', scopes: [], actions: [] },
        credentialPath: join(home, 'credential'),
      },
    ],
    mailbox: { adapter },
    nativeSession: { runTurn: model, stop: async () => {} },
    delivery: {
      ...createStimulusDelivery({}),
      intervalMs: 0,
    },
  });
  runtimes.push(runtime);
  return { runtime, intake: createStimulusIntake(runtime, 'owner') };
}

describe('one stimulus intake and delivery', () => {
  it('renders the queue sections with complete KST source lines', () => {
    const text = renderWindowQueue({
      window: { startMs: 1, endMs: 2 },
      lines: [],
      sections: {
        a: [
          {
            candidate: {
              candidate: {
                key: 'work:item-1',
                kind: 'work',
                id: 'item-1',
                title: 'item-1',
                facts: {},
                hints: [],
              },
              confidence: 0.91,
              source: [],
            },
            relevance: 0.9,
            lines: [
              {
                connector: 'source',
                channelName: 'channel',
                author: 'actor',
                kstTime: '09-02 09:00',
                sourceAtMs: 1,
                observationRef: 'observation-1',
                text: 'full line A',
              },
            ],
          },
        ],
        b: [],
        c: [],
        suspectedDuplicates: [],
        unresolved: [],
      },
    });

    expect(text).toContain('## A.');
    expect(text).toContain('## B.');
    expect(text).toContain('## C.');
    expect(text).toContain('## Suspected duplicates');
    expect(text).toContain('## Unresolved');
    expect(text).toContain('[09-02 09:00] channel · actor · observation-1: full line A');
  });

  it('hashes a source delta identity from its coalesce key and ref set', () => {
    const base = {
      kind: 'source_delta' as const,
      collector: 'collector',
      channel: 'channel',
      coalesceKey: 'source:collector:channel',
      refs: [
        {
          connector: 'collector',
          observationRef: 'obs-1',
          sourceId: 'source-1',
          sourceEntityId: 'entity-1',
          channel: 'room-a',
          author: 'sender-a',
          contentPreview: 'bounded message text',
          sourceAt: '2026-01-01T00:00:00.000Z',
          observedAt: '2026-01-01T00:00:01.000Z',
          contentHash: null,
        },
        {
          connector: 'collector',
          observationRef: 'obs-2',
          sourceId: 'source-2',
          sourceEntityId: 'entity-2',
          sourceAt: '2026-01-01T00:01:00.000Z',
          observedAt: '2026-01-01T00:01:01.000Z',
          contentHash: null,
        },
      ],
      preview: ['bounded preview'],
    };
    const sameRefsDifferentOrder = { ...base, refs: [...base.refs].reverse() };

    expect(sourceDeltaStimulusId(base)).toMatch(/^source_delta:[0-9a-f]{64}$/);
    expect(sourceDeltaStimulusId(sameRefsDifferentOrder)).toBe(sourceDeltaStimulusId(base));
    expect(sourceDeltaStimulusId({ ...base, coalesceKey: 'source:collector:other' })).not.toBe(
      sourceDeltaStimulusId(base)
    );
  });

  it('serializes a source delta and owner message on owner:runtime', async () => {
    const order: string[] = [];
    const runTurn = vi.fn(async (content, request) => {
      const text = content[0]?.type === 'text' ? content[0].text : '';
      order.push(`start:${text.includes('source_delta') ? 'source' : 'owner'}`);
      request?.streamCallbacks?.onInputDispatch?.({
        backend: 'codex',
        sessionId: 'owner-thread',
        inputId: request.nativeInputId!,
      });
      request?.streamCallbacks?.onAccepted?.({
        backend: 'codex',
        sessionId: 'owner-thread',
        turnId: text.includes('source_delta') ? 'source-turn' : 'owner-turn',
      });
      await new Promise((resolve) => setImmediate(resolve));
      order.push(`end:${text.includes('source_delta') ? 'source' : 'owner'}`);
      return {
        response: 'answer',
        turns: 1,
        history: [],
        totalUsage: { input_tokens: 1, output_tokens: 1 },
        stopReason: 'end_turn' as const,
        modelRunId: null,
        modelRunProvenance: 'backend_no_run' as const,
      };
    });
    const { runtime, intake } = await boot(runTurn);
    intake.acceptSourceDelta({
      kind: 'source_delta',
      collector: 'collector',
      channel: 'channel',
      coalesceKey: 'source:collector:channel',
      refs: [
        {
          connector: 'collector',
          observationRef: 'obs-1',
          sourceId: 'source-1',
          sourceEntityId: 'entity-1',
          channel: 'room-a',
          channelName: 'client room',
          author: 'sender-a',
          contentPreview: 'bounded message text',
          sourceAt: '2026-01-01T00:00:00.000Z',
          observedAt: '2026-01-01T00:00:01.000Z',
          contentHash: null,
        },
      ],
      preview: ['new observation'],
      replay: {
        runId: 'run-1',
        windowId: 'window-1',
        windowStartMs: 1,
        windowEndMs: 2,
        ledgerDigest: [
          {
            commitmentId: 'commitment-1',
            revision: 3,
            title: 'Current item',
            stage: 'active',
            status: 'pending',
            assignee: 'worker',
            lastEventTime: '2026-01-01T00:00:00.000Z',
          },
        ],
        queue: {
          window: { startMs: 1, endMs: 2 },
          lines: [],
          sections: {
            a: [
              {
                candidate: {
                  candidate: {
                    key: 'work:commitment-1',
                    kind: 'work',
                    id: 'commitment-1',
                    title: 'Current item',
                    facts: {},
                    hints: [],
                  },
                  confidence: 0.9,
                  source: [],
                },
                relevance: 0.9,
                lines: [
                  {
                    connector: 'collector',
                    channelName: 'client room',
                    author: 'sender-a',
                    kstTime: '01-01 09:00',
                    sourceAtMs: 1,
                    observationRef: 'obs-1',
                    text: 'bounded message text',
                  },
                ],
              },
            ],
            b: [],
            c: [],
            suspectedDuplicates: [],
            unresolved: [],
          },
        },
        endInstructions: 'update the board, wiki, and lessons',
      },
    });
    intake.acceptOwnerMessage({
      id: 'message-1',
      channelKey: 'channel',
      occurredAt: 1,
      text: 'owner request',
    });

    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(runtime.mailbox?.depth()).toEqual({ pending: 0, claimed: 0, dead: 0 })
    );
    expect(order).toEqual(['start:owner', 'end:owner', 'start:source', 'end:source']);
    const prompts = runTurn.mock.calls.map((call) => call[0][0].text);
    expect(prompts.some((text) => text.includes('owner request'))).toBe(true);
    // Replay messages are one line each: channel, sender, observationRef, text; no ids or hashes.
    expect(
      prompts.some((text) =>
        text.includes('collector:client room · sender-a · obs-1: bounded message text')
      )
    ).toBe(false);
    expect(prompts.some((text) => text.includes('## A. Matched work'))).toBe(true);
    expect(
      prompts.some((text) =>
        text.includes('[01-01 09:00] client room · sender-a · obs-1: bounded message text')
      )
    ).toBe(true);
    expect(prompts.some((text) => text.includes('commitment-1 | r3 | Current item | active'))).toBe(
      true
    );
    expect(prompts.some((text) => text.includes('source-1') || text.includes('contentHash'))).toBe(
      false
    );
    expect(prompts.some((text) => text.includes('bounded message text'))).toBe(true);
    expect(prompts.some((text) => text.includes('update the board, wiki, and lessons'))).toBe(true);
    expect(
      prompts.some((text) =>
        text.includes('batched per connector (the first segment of the channel)')
      )
    ).toBe(true);
    expect(prompts.some((text) => text.includes('observationRefs'))).toBe(true);
    expect(runTurn.mock.calls.every((call) => call[1]?.sessionKey === 'owner:runtime')).toBe(true);
  });

  it('accepts and durably records a scheduled no-op without invoking the model', async () => {
    const runTurn = vi.fn();
    const { runtime, intake } = await boot(runTurn);
    intake.acceptScheduled({
      id: 'tick-1',
      channelKey: 'schedule',
      occurredAt: 1,
      payload: { schedule: 'tick' },
    });

    await vi.waitFor(() =>
      expect(runtime.mailbox?.readInput('tick-1', 'owner')?.status).toBe('acked')
    );
    expect(runTurn).not.toHaveBeenCalled();
    expect(runtime.mailbox?.readInput('tick-1', 'owner')?.nativeDelivery?.state).toBe('settled');
  });

  it('does not ack a native turn that throws after native acceptance', async () => {
    const runTurn = vi.fn(async (_content, request) => {
      request?.streamCallbacks?.onInputDispatch?.({
        backend: 'codex',
        sessionId: 'owner-thread',
        inputId: request.nativeInputId!,
      });
      request?.streamCallbacks?.onAccepted?.({
        backend: 'codex',
        sessionId: 'owner-thread',
        turnId: 'failed-turn',
      });
      throw new Error('native turn failed');
    });
    const { runtime, intake } = await boot(runTurn);
    intake.acceptOwnerMessage({
      id: 'input-1',
      channelKey: 'channel',
      occurredAt: 1,
      text: 'request',
    });

    await vi.waitFor(() => expect(runTurn).toHaveBeenCalledOnce());
    expect(runtime.mailbox?.readInput('input-1', 'owner')).toMatchObject({
      status: 'claimed',
      nativeDelivery: { state: 'uncertain', error: 'native turn failed' },
    });
  });

  it('passes a replay ceiling to one turn and clears it after delivery', async () => {
    const delivery = createStimulusDelivery({});
    delivery.setReplaySourceEndMs(1_500);
    const context = {
      nativeInputId: 'input',
      resultForReceipt: () => null,
      run: vi.fn(async (_content: unknown, request?: { replaySourceEndMs?: number }) => {
        expect(request?.replaySourceEndMs).toBe(1_500);
        return {} as never;
      }),
      steer: vi.fn(),
      wasDispatched: () => false,
      onInputDispatch: vi.fn(),
      onAccepted: vi.fn(),
    };
    await delivery.deliver(
      {
        id: 'replay-input',
        stimulusId: 'replay-input',
        principalId: 'owner',
        kind: 'source_delta',
        channelKey: 'channel',
        occurredAt: 1,
        refs: [],
        preview: [],
        status: 'claimed',
        attempts: 1,
        createdAt: 1,
        payload: undefined,
        coalesceKey: null,
      },
      context as never
    );
    expect(delivery.getReplaySourceEndMs()).toBeUndefined();
  });

  it('records a source delta occurrence at source time, not capture time', () => {
    const accepted: Stimulus[] = [];
    const intake = createStimulusIntake(
      {
        accept: (stimulus) => {
          accepted.push(stimulus);
          return { inputId: stimulus.id, state: 'accepted' };
        },
      },
      'owner'
    );

    intake.acceptSourceDelta({
      kind: 'source_delta',
      collector: 'collector',
      channel: 'channel',
      coalesceKey: 'source:collector:channel',
      refs: [
        {
          connector: 'collector',
          observationRef: 'observation-1',
          sourceId: 'source-1',
          sourceEntityId: 'entity-1',
          sourceAt: '2026-01-01T00:00:00.000Z',
          observedAt: '2026-02-01T00:00:00.000Z',
          contentHash: null,
        },
      ],
      preview: [],
    });

    expect(accepted[0]?.occurredAt).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
  });
});
