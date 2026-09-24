import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { DatabaseInstance, Knowledge } from '@jungjaehoon/mama-core';
import type {
  IModelRunner,
  PromptResult,
  RunnerMetrics,
} from '@jungjaehoon/mama-core/runtime/drivers/types';
import { createActionSurface } from '../../src/runtime/action-surface.js';
import { createNativeSession, type NativeDriverOptions } from '../../src/runtime/native-session.js';

function surface() {
  return createActionSurface({
    adapter: {} as DatabaseInstance,
    knowledge: {} as Knowledge,
    ownerPrincipalId: 'owner',
    agentId: 'agent',
    connectors: ['chatwork', 'slack', 'trello', 'kagemusha'],
    scopes: [{ kind: 'project', id: 'scope' }],
  });
}

function runner(backend: 'codex' | 'claude'): IModelRunner {
  const prompt = vi.fn(
    async (): Promise<PromptResult> => ({
      response: 'answer',
      session_id: 'native-session',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  );
  const metrics: RunnerMetrics = {
    requestCount: 0,
    failureCount: 0,
    avgLatencyMs: 0,
    lastRequestAt: null,
  };
  return {
    backendType: backend,
    supportsNativeSubagents: true,
    reportsModelRuns: false,
    prompt,
    setSessionId: vi.fn(),
    setSystemPrompt: vi.fn(),
    isHealthy: () => true,
    getMetrics: () => metrics,
    stop: vi.fn(),
  };
}

describe('one owner native session', () => {
  it.each(['codex', 'claude'] as const)(
    'exposes the same eight catalog actions for %s',
    async (backend) => {
      const model = runner(backend);
      const session = createNativeSession({
        backend,
        model: 'test-model',
        workspaceDir: '/tmp/mama-native-workspace',
        runtimeRoot: '/tmp/mama-native-runtime',
        actionSurface: surface(),
        agent: model,
        ownerSystemPrompt: 'standing policy',
        maxTurns: 20,
        timeout: 1_000,
      });

      expect(
        session
          .hostToolDefinitions()
          .map((tool) => tool.name)
          .sort()
      ).toEqual([
        'graph.query',
        'memory.save',
        'memory.search',
        'source.read',
        'source.search',
        'work.create',
        'work.list',
        'work.revise',
      ]);
      await session.stop();
    }
  );

  it('keeps the Codex launch writable in the workspace and native-subagent capable', () => {
    let received: NativeDriverOptions | undefined;
    const model = runner('codex');
    const session = createNativeSession({
      backend: 'codex',
      model: 'test-model',
      workspaceDir: '/tmp/mama-native-workspace',
      runtimeRoot: '/tmp/mama-native-runtime',
      actionSurface: surface(),
      maxTurns: 41,
      timeout: 300_000,
      createAgent: (options) => {
        received = options;
        return model;
      },
    });

    expect(received).toMatchObject({
      cwd: '/tmp/mama-native-workspace',
      sandbox: 'workspace-write',
      requestTimeout: 300_000,
    });
    expect(received?.createSubagentBridge).toEqual(expect.any(Function));
    expect(model.supportsNativeSubagents).toBe(true);
    void session.stop();
  });

  it('uses the configured max-turn limit for the emergency host-call ceiling', async () => {
    const model = runner('codex');
    (model.prompt as ReturnType<typeof vi.fn>).mockImplementation(
      async (_content, _callbacks, options) => {
        for (let index = 0; index < 51; index += 1) {
          const result = await options?.hostToolBridge?.execute({
            callId: `call-${index}`,
            name: 'source.read',
            input: { offset: index, limit: 1 },
          });
          expect(result?.abort).not.toBe(true);
        }
        return {
          response: 'answer',
          session_id: 'native-session',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
    );
    const session = createNativeSession({
      backend: 'codex',
      model: 'test-model',
      workspaceDir: '/tmp/mama-native-workspace',
      runtimeRoot: '/tmp/mama-native-runtime',
      actionSurface: surface(),
      agent: model,
      maxTurns: 41,
      timeout: 1_000,
    });

    await expect(
      session.runTurn([{ type: 'text', text: 'bounded calls' }], { sessionKey: 'owner:runtime' })
    ).resolves.toMatchObject({ response: 'answer' });
    await session.stop();
  });

  it('projects Claude builtin tools from the turn role', async () => {
    const model = runner('claude');
    const session = createNativeSession({
      backend: 'claude',
      model: 'test-model',
      workspaceDir: '/tmp/mama-native-workspace',
      runtimeRoot: '/tmp/mama-native-runtime',
      actionSurface: surface(),
      agent: model,
      ownerSystemPrompt: 'standing policy',
      maxTurns: 20,
      timeout: 1_000,
    });

    await session.runTurn([{ type: 'text', text: 'stimulus' }], {
      sessionKey: 'owner:runtime',
      nativeRole: { allowedTools: ['Read', 'Bash'] },
    });
    expect((model.prompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toMatchObject({
      tools: 'Read,Bash',
    });
    await session.stop();
  });

  it('repairs Claude MCP config to the shared action server before the session starts', () => {
    const root = mkdtempSync(join(tmpdir(), 'native-config-'));
    try {
      const configPath = join(root, 'actions.json');
      const model = runner('claude');
      const session = createNativeSession({
        backend: 'claude',
        model: 'test-model',
        workspaceDir: join(root, 'workspace'),
        runtimeRoot: root,
        actionSurface: surface(),
        agent: model,
        maxTurns: 20,
        timeout: 1_000,
        mcpConfigPath: configPath,
        mcpServerPath: join(root, 'action-server.js'),
      });
      expect(JSON.parse(readFileSync(configPath, 'utf8'))).toMatchObject({
        mcpServers: {
          mama: {
            command: process.execPath,
            args: [join(root, 'action-server.js')],
            env: { MAMA_HOME: root },
          },
        },
      });
      void session.stop();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
