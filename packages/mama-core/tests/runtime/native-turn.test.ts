import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNativeSessionRunner,
  type NativeSessionHost,
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
  it('allows twenty consecutive source reads when each input is different', async () => {
    const prompt = vi.fn(async (_content, _callbacks, options) => {
      const bridge = options?.hostToolBridge;
      expect(bridge).toBeDefined();
      for (let index = 0; index < 20; index += 1) {
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
});
