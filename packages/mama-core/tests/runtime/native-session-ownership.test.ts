import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeSessionRunner,
  type NativeSessionHost,
} from '../../src/runtime/native-turn.js';
import { SessionPool } from '../../src/runtime/session-pool.js';
import type { HostExecutionContext, IModelRunner } from '../../src/runtime/drivers/types.js';

const pools: SessionPool[] = [];
afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose();
});

function fixture(channelKey: string) {
  const pool = new SessionPool();
  pools.push(pool);
  const prompt = vi.fn(async () => {
    expect(pool.peekSession(channelKey).busy).toBe(true);
    return {
      response: 'native answer',
      session_id: 'native-test-session',
      usage: { input_tokens: 1, output_tokens: 1 },
    };
  });
  const agent: IModelRunner = {
    backendType: 'claude',
    supportsNativeSubagents: false,
    reportsModelRuns: false,
    prompt,
    setSessionId: () => {},
    setSystemPrompt: () => {},
    isHealthy: () => true,
    getMetrics: () => ({ requestCount: 0, failureCount: 0, avgLatencyMs: 0, lastRequestAt: null }),
    stop: () => {},
  };
  const host: NativeSessionHost<HostExecutionContext> = {
    agent,
    backend: 'claude',
    model: 'native-test',
    maxTurns: 1,
    isGatewayMode: true,
    runTokenBudget: 0,
    sessionPool: pool,
    turnPolicy: () => ({ channelKey, systemLayers: [] }),
    executionContext: () => null,
    hostToolDefinitions: () => [],
    callTool: async () => null,
  };
  return { pool, prompt, runner: createNativeSessionRunner(host) };
}

describe('W5 native session ownership', () => {
  it('acquires and releases the core session when a claimed turn supplies no CLI session ID', async () => {
    const h = fixture('telegram:public-claimed');
    await expect(
      h.runner.runTurn([{ type: 'text', text: 'request' }], {
        sessionKey: 'telegram:public-claimed',
      })
    ).resolves.toMatchObject({ response: 'native answer' });
    expect(h.prompt).toHaveBeenCalledOnce();
    expect(h.pool.peekSession('telegram:public-claimed').busy).toBe(false);
  });

  it('does not run or release a session another caller already holds', async () => {
    const key = 'telegram:foreign-lock';
    const h = fixture(key);
    const foreign = h.pool.getSession(key);
    await expect(
      h.runner.runTurn([{ type: 'text', text: 'request' }], { sessionKey: key })
    ).rejects.toThrow(/session.*busy/i);
    expect(h.prompt).not.toHaveBeenCalled();
    expect(h.pool.peekSession(key)).toEqual({ sessionId: foreign.sessionId, busy: true });
    h.pool.releaseSession(key, foreign.sessionId);
  });

  it('reuses one core session ID on the next turn with the same key', async () => {
    const key = 'telegram:public-continuity';
    const h = fixture(key);
    await h.runner.runTurn([{ type: 'text', text: 'first' }], { sessionKey: key });
    const firstId = h.pool.peekSession(key).sessionId;
    await h.runner.runTurn([{ type: 'text', text: 'second' }], { sessionKey: key });
    expect(h.pool.peekSession(key)).toEqual({ sessionId: firstId, busy: false });
    expect(h.prompt).toHaveBeenCalledTimes(2);
  });

  it('releases its own session after a model failure so the next turn can run', async () => {
    const key = 'telegram:failed-continuity';
    const h = fixture(key);
    h.prompt.mockRejectedValueOnce(new Error('synthetic model failure'));
    await expect(
      h.runner.runTurn([{ type: 'text', text: 'first' }], { sessionKey: key })
    ).rejects.toThrow('synthetic model failure');
    expect(h.pool.peekSession(key).busy).toBe(false);
    await expect(
      h.runner.runTurn([{ type: 'text', text: 'second' }], { sessionKey: key })
    ).resolves.toMatchObject({ response: 'native answer' });
  });
});
