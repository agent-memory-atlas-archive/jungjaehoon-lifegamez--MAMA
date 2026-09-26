import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeSessionRunner,
  type NativeSessionHost,
  type NativeModelRunPort,
} from '../../src/runtime/native-turn.js';
import { SessionPool } from '../../src/runtime/session-pool.js';
import type { HostToolCall, IModelRunner, PromptResult } from '../../src/runtime/drivers/types.js';

const pools: SessionPool[] = [];

afterEach(() => {
  for (const pool of pools.splice(0)) pool.dispose();
});

function runnerWithPrompt(prompt: IModelRunner['prompt'], maxTurns = 30) {
  const pool = new SessionPool();
  pools.push(pool);
  const agent = {
    backendType: 'codex' as const,
    reportsModelRuns: false,
    supportsNativeSubagents: false,
    prompt,
    stop: vi.fn(),
  } as unknown as IModelRunner;
  const tool = {
    type: 'function' as const,
    name: 'source.read',
    description: 'read one bounded source page',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: true,
    },
  };
  const host: NativeSessionHost<Record<string, never>> = {
    agent,
    backend: 'codex',
    model: 'test-model',
    maxTurns,
    isGatewayMode: true,
    runTokenBudget: 0,
    sessionPool: pool,
    turnPolicy: () => ({ channelKey: 'test-lane', systemLayers: [] }),
    executionContext: () => null,
    hostToolDefinitions: () => [tool],
    callTool: async (_name, input) => ({ success: true, data: input }),
  };
  return createNativeSessionRunner(host);
}

const promptResult = (): PromptResult => ({
  response: 'done',
  session_id: 'test-session',
  usage: { input_tokens: 1, output_tokens: 1 },
});

function toolCall(index: number, input: Record<string, unknown>): HostToolCall {
  return { callId: `call-${index}`, name: 'source.read', input };
}

describe('native host-tool loop signatures', () => {
  it('exposes whether a session key will open a new native thread', async () => {
    const runner = runnerWithPrompt(vi.fn(async () => promptResult()));

    expect(runner.isNewThread({ sessionKey: 'test-lane' })).toBe(true);

    await runner.runTurn([{ type: 'text', text: 'open the thread' }], {
      sessionKey: 'test-lane',
    });

    expect(runner.isNewThread({ sessionKey: 'test-lane' })).toBe(false);
  });

  it('allows more than fifty host calls when each input is different', async () => {
    const prompt = vi.fn(async (_content, _callbacks, options) => {
      const bridge = options?.hostToolBridge;
      expect(bridge).toBeDefined();
      for (let index = 0; index < 60; index += 1) {
        const result = await bridge!.execute(toolCall(index, { limit: 1, offset: index }));
        expect(result.abort).not.toBe(true);
      }
      return promptResult();
    });
    const runner = runnerWithPrompt(prompt);

    await expect(
      runner.runTurn([{ type: 'text', text: 'read the next pages' }], {
        sessionKey: 'test-lane',
      })
    ).resolves.toMatchObject({ response: 'done' });
  });

  it('aborts repeated identical source reads after the consecutive-call threshold', async () => {
    const prompt = vi.fn(async (_content, _callbacks, options) => {
      const bridge = options?.hostToolBridge;
      expect(bridge).toBeDefined();
      const results = [];
      for (let index = 0; index < 15; index += 1) {
        results.push(await bridge!.execute(toolCall(index, { limit: 1, offset: 0 })));
      }
      expect(results.slice(0, 14).every((result) => result.abort !== true)).toBe(true);
      expect(results[14]).toMatchObject({ abort: true, isError: true });
      return promptResult();
    });
    const runner = runnerWithPrompt(prompt);

    await expect(
      runner.runTurn([{ type: 'text', text: 'repeat one page' }], {
        sessionKey: 'test-lane',
      })
    ).resolves.toMatchObject({ response: 'done' });
  });

  it('commits the bounded final response as the model-run completion summary', async () => {
    const pool = new SessionPool();
    pools.push(pool);
    const response = 'x'.repeat(2_100);
    const commit = vi.fn<NativeModelRunPort['commit']>(async () => {});
    const modelRun: NativeModelRunPort = {
      begin: vi.fn(async () => 'model-run-test'),
      commit,
      fail: vi.fn(async () => {}),
    };
    const agent = {
      backendType: 'codex' as const,
      reportsModelRuns: true,
      supportsNativeSubagents: false,
      prompt: vi.fn(async () => ({
        response,
        session_id: 'test-session',
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
      stop: vi.fn(),
    } as unknown as IModelRunner;
    const host: NativeSessionHost<Record<string, never>> = {
      agent,
      backend: 'codex',
      model: 'test-model',
      maxTurns: 30,
      isGatewayMode: true,
      runTokenBudget: 0,
      sessionPool: pool,
      turnPolicy: () => ({ channelKey: 'test-lane', systemLayers: [] }),
      executionContext: () => null,
      hostToolDefinitions: () => [],
      callTool: async () => ({ success: true }),
      modelRun,
    };
    const runner = createNativeSessionRunner(host);

    await runner.runTurn([{ type: 'text', text: 'record the result' }], {
      sessionKey: 'test-lane',
    });

    expect(commit).toHaveBeenCalledWith('model-run-test', response.slice(0, 2_000), 2);
  });
});
