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
      ...createStimulusDelivery({ standingText: 'standing policy' }),
      intervalMs: 0,
    },
  });
  runtimes.push(runtime);
  return { runtime, intake: createStimulusIntake(runtime, 'owner') };
}

describe('one stimulus intake and delivery', () => {
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
          sourceId: 'source-1',
          sourceEntityId: 'entity-1',
          sourceAt: '2026-01-01T00:00:00.000Z',
          observedAt: '2026-01-01T00:00:01.000Z',
          contentHash: null,
        },
      ],
      preview: ['new observation'],
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
    expect(prompts.every((text) => text.includes('standing policy'))).toBe(true);
    expect(prompts.some((text) => text.includes('owner request'))).toBe(true);
    expect(prompts.some((text) => text.includes('source-1'))).toBe(true);
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
});
