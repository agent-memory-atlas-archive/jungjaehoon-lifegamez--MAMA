import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersistentCLIAdapter } from '../../src/runtime/drivers/persistent-cli-adapter.js';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';
import {
  createNativeSessionRunner,
  type NativeSessionHost,
} from '../../src/runtime/native-turn.js';
import { SessionPool } from '../../src/runtime/session-pool.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

function fixture() {
  const processes: PersistentClaudeProcess[] = [];
  const sent: string[] = [];
  const live = new WeakSet<PersistentClaudeProcess>();
  vi.spyOn(PersistentClaudeProcess.prototype, 'start').mockImplementation(async function () {
    processes.push(this);
    live.add(this);
  });
  vi.spyOn(PersistentClaudeProcess.prototype, 'isAlive').mockImplementation(function () {
    return live.has(this);
  });
  vi.spyOn(PersistentClaudeProcess.prototype, 'stop').mockImplementation(function () {
    live.delete(this);
    this.emit('close');
  });
  vi.spyOn(PersistentClaudeProcess.prototype, 'sendMessage').mockImplementation(
    async function (text) {
      sent.push(text);
      return {
        response: 'answer',
        session_id: this.getSessionId(),
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    }
  );
  const agent = new PersistentCLIAdapter({
    workspaceDir: '/tmp/session-context-test',
    model: 'test-model',
  });
  const pool = new SessionPool();
  let policy = 'first-policy';
  const host: NativeSessionHost<Record<string, never>> = {
    agent,
    backend: 'claude',
    model: 'test-model',
    maxTurns: 10,
    isGatewayMode: false,
    runTokenBudget: 0,
    sessionPool: pool,
    turnPolicy: () => ({
      channelKey: 'test-session',
      systemLayers: [{ name: 'standing', content: policy, priority: 1 }],
      standingPolicy: true,
      sessionPolicyFingerprint: policy,
    }),
    executionContext: () => null,
    hostToolDefinitions: () => [],
    callTool: async () => ({ success: true }),
  };
  const runner = createNativeSessionRunner(host);
  cleanup.push(
    () => pool.dispose(),
    () => runner.stop()
  );
  const states: boolean[] = [];
  const run = () =>
    runner.runTurn([{ type: 'text', text: 'current input' }], {
      sessionKey: 'test-session',
      prepareSessionContent: async ({ isNewSession }) => {
        states.push(isNewSession);
        return [
          { type: 'text', text: isNewSession ? 'startup context; current input' : 'current input' },
        ];
      },
    });
  return {
    run,
    runner,
    pool,
    processes,
    states,
    sent,
    changePolicy: () => {
      policy = 'second-policy';
    },
  };
}

describe('settled session context before native input', () => {
  it('includes startup only on the first process and after process death', async () => {
    const f = fixture();
    await f.run();
    await f.run();
    f.processes[0]!.stop();
    await f.run();
    await f.run();
    expect(f.states).toEqual([true, false, true, false]);
    expect(f.sent).toEqual([
      'startup context; current input',
      'current input',
      'startup context; current input',
      'current input',
    ]);
  });

  it('settles policy replacement before composing startup content', async () => {
    const f = fixture();
    await f.run();
    f.changePolicy();
    await f.run();
    await f.run();
    expect(f.states).toEqual([true, true, false]);
    expect(f.processes).toHaveLength(2);
    expect(f.processes[0]!.isAlive()).toBe(false);
  });

  it('explicit reset drops the pool entry and retires the exact process', async () => {
    const f = fixture();
    await f.run();
    await f.runner.resetSession('test-session');
    expect(f.pool.peekSession('test-session')).toEqual({ busy: false });
    expect(f.processes[0]!.isAlive()).toBe(false);
    await f.run();
    await f.run();
    expect(f.states).toEqual([true, true, false]);
  });

  it('a failed context build sends nothing and does not consume startup', async () => {
    const f = fixture();
    await expect(
      f.runner.runTurn([], {
        sessionKey: 'test-session',
        prepareSessionContent: async () => {
          throw new Error('context unavailable');
        },
      })
    ).rejects.toThrow('context unavailable');
    expect(f.sent).toEqual([]);
    await f.run();
    expect(f.states).toEqual([true]);
  });

  it('rebuilds context if the retained process dies during asynchronous content assembly', async () => {
    const f = fixture();
    await f.run();
    const states: boolean[] = [];
    await f.runner.runTurn([], {
      sessionKey: 'test-session',
      prepareSessionContent: async ({ isNewSession }) => {
        states.push(isNewSession);
        if (!isNewSession) f.processes[0]!.stop();
        return [
          { type: 'text', text: isNewSession ? 'replacement startup' : 'stale continuation' },
        ];
      },
    });
    expect(states).toEqual([false, true]);
    expect(f.sent).toEqual(['startup context; current input', 'replacement startup']);
  });
});
