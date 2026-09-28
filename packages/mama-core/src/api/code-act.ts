/**
 * code_act: the agent runs one piece of JavaScript that calls several actions, instead of
 * one model round trip per action.
 *
 * Mechanism ported from Kagemusha's code-act sandbox and worker. The code runs in its own
 * Node process; every action it calls is relayed over IPC to this process and dispatched
 * with the calling turn's own context, so the grant, session and traces are the caller's.
 * The worker runs under Node's permission model: `vm` gives the code a clean namespace but
 * is not a boundary, and an escaped script must reach no files, processes or network.
 */
import { spawn } from 'node:child_process';
import type { ActionContract } from '../action-contracts.js';
import type { ActionContext, ActionRegistration } from './catalog.js';
import type { ActionDispatcher } from './dispatch.js';

const WORKER_SOURCE = `
const vm = require('node:vm');
const pending = new Map();
let nextId = 0;
function callTool(name, params) {
  const id = String(++nextId);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send({ type: 'callTool', id, name, params });
  });
}
function assignNested(root, path, fn) {
  let cursor = root;
  for (let i = 0; i < path.length - 1; i++) {
    if (!cursor[path[i]] || typeof cursor[path[i]] !== 'object') cursor[path[i]] = {};
    cursor = cursor[path[i]];
  }
  cursor[path[path.length - 1]] = fn;
}
process.on('disconnect', () => process.exit(1));
process.on('message', async (msg) => {
  if (msg.type === 'toolResult') {
    const call = pending.get(msg.id);
    if (!call) return;
    pending.delete(msg.id);
    if (msg.error !== undefined) call.reject(new Error(msg.error));
    else call.resolve(msg.result);
    return;
  }
  if (msg.type !== 'execute') return;
  const logs = [];
  const sandbox = {
    console: { log: (...args) => logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')) },
    callTool,
  };
  for (const name of msg.functionNames) {
    const proxy = (params) => callTool(name, params);
    if (name.includes('.')) assignNested(sandbox, name.split('.'), proxy);
    else sandbox[name] = proxy;
  }
  sandbox.globalThis = sandbox;
  try {
    const trimmed = msg.code.trim();
    const needsReturn =
      !trimmed.startsWith('return ') && !trimmed.startsWith('return\\n') && !trimmed.includes('\\n') &&
      !/^(if|for|while|var|let|const|switch|try|throw|class|function)\\b/.test(trimmed);
    const body = needsReturn ? 'return ' + trimmed : msg.code;
    const script = new vm.Script('(async () => { ' + body + '\\n})()', { filename: 'code_act.js' });
    const value = await script.runInContext(vm.createContext(sandbox), { timeout: msg.timeoutMs });
    process.send({ type: 'result', success: true, value, logs }, () => process.exit(0));
  } catch (error) {
    process.send(
      { type: 'result', success: false, logs, error: { name: error && error.name ? error.name : 'Error', message: error && error.message ? error.message : String(error) } },
      () => process.exit(0)
    );
  }
});
process.send({ type: 'ready' });
`;

export interface CodeActFunction {
  name: string;
  summary: string;
}

export interface CodeActHost {
  functions: readonly CodeActFunction[];
  call(name: string, input: unknown): Promise<unknown>;
}

export interface CodeActResult {
  success: boolean;
  value?: unknown;
  error?: { name: string; message: string };
  logs: string[];
  hostCallCount: number;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;

function firstSentence(text: string): string {
  return text.split(/(?<=[.!?])\s/, 1)[0]!.trim();
}

function listTools(functions: readonly CodeActFunction[], query: unknown): CodeActFunction[] {
  const sorted = [...functions].sort((left, right) => left.name.localeCompare(right.name));
  const text = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (text === '') return sorted;
  const tokens = text.split(/\s+/);
  return sorted
    .map((fn) => {
      const haystack = `${fn.name} ${fn.summary}`.toLowerCase();
      return { fn, score: tokens.filter((token) => haystack.includes(token)).length };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.fn);
}

function renderHelp(functions: readonly CodeActFunction[], query: unknown): string {
  const found = listTools(functions, query);
  if (found.length === 0) return 'No matching functions. Call help() for all of them.';
  return [
    'Each function is async and takes one input object: `return await work.list({ view: "pipeline" })`.',
    'A name with a colon is called as `memory["read:provenance"]({...})` or `callTool("memory.read:provenance", {...})`.',
    'Independent calls go together: `const [a, b] = await Promise.all([f({...}), g({...})])`.',
    '',
    ...found.map((fn) => `- ${fn.name}: ${firstSentence(fn.summary)}`),
  ].join('\n');
}

/** Run the code in a fresh worker process; host calls are answered by `host.call`. */
export function runCodeAct(
  code: string,
  host: CodeActHost,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CodeActResult> {
  const startedAt = Date.now();
  let hostCallCount = 0;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--permission', '-e', WORKER_SOURCE], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    let settled = false;
    const settle = (result: Omit<CodeActResult, 'hostCallCount' | 'durationMs'>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve({ ...result, hostCallCount, durationMs: Date.now() - startedAt });
    };
    const timer = setTimeout(
      () =>
        settle({
          success: false,
          error: { name: 'TimeoutError', message: `code_act timed out after ${timeoutMs}ms` },
          logs: [],
        }),
      timeoutMs
    );
    child.stderr!.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const builtins: Record<string, (input: unknown) => unknown> = {
      help: (input) => renderHelp(host.functions, input),
      list_tools: (input) => listTools(host.functions, input),
    };
    child.on(
      'message',
      async (msg: {
        type: string;
        id?: string;
        name?: string;
        params?: unknown;
        success?: boolean;
        value?: unknown;
        error?: { name: string; message: string };
        logs?: string[];
      }) => {
        if (msg.type === 'ready') {
          child.send({
            type: 'execute',
            code,
            functionNames: [...host.functions.map((fn) => fn.name), ...Object.keys(builtins)],
            timeoutMs,
          });
          return;
        }
        if (msg.type === 'callTool') {
          hostCallCount += 1;
          const builtin = builtins[msg.name!];
          try {
            const result = builtin ? builtin(msg.params) : await host.call(msg.name!, msg.params);
            if (child.connected) child.send({ type: 'toolResult', id: msg.id, result });
          } catch (error) {
            if (child.connected)
              child.send({
                type: 'toolResult',
                id: msg.id,
                error: error instanceof Error ? error.message : String(error),
              });
          }
          return;
        }
        if (msg.type === 'result') {
          settle(
            msg.success
              ? { success: true, value: msg.value, logs: msg.logs ?? [] }
              : { success: false, error: msg.error, logs: msg.logs ?? [] }
          );
        }
      }
    );
    child.on('error', (error) =>
      settle({ success: false, error: { name: 'WorkerError', message: error.message }, logs: [] })
    );
    child.on('exit', (exitCode, signal) => {
      // A clean exit follows the result message; anything else lost the result.
      if (exitCode === 0 && signal === null) return;
      settle({
        success: false,
        error: {
          name: 'WorkerError',
          message: `code_act worker exited (code=${exitCode}, signal=${signal})${stderr ? `: ${stderr.trim().slice(0, 500)}` : ''}`,
        },
        logs: [],
      });
    });
  });
}

export const CODE_ACT_CONTRACT: ActionContract = {
  name: 'code_act',
  summary:
    'Run JavaScript that calls several actions in one step instead of one call per action. Every action you may call is an async function by its name, for example `return await work.list({ view: "pipeline" })`; make independent calls together with `Promise.all`, and call `help()` for the list. The code runs in a separate process with no file, process or network access; its return value, console.log lines and any error come back.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['code'],
    properties: {
      code: {
        type: 'string',
        minLength: 1,
        description:
          'The body of an async function, e.g. const [open, days] = await Promise.all([work.list({ view: "pipeline" }), schedule.upcoming({ days: 14 })]); return { open, days };',
      },
    },
  },
};

/**
 * The code_act action over a dispatcher built after it: the functions are the actions the
 * caller is granted, and each call is dispatched with the caller's own context.
 */
export function codeActRegistration(dispatcher: () => ActionDispatcher): ActionRegistration {
  return {
    contract: CODE_ACT_CONTRACT,
    exec: async (input, context: ActionContext) => {
      const dispatch = dispatcher();
      const granted = new Set(context.access.actions ?? []);
      const functions = dispatch.contracts
        .filter(
          (contract) => contract.name !== CODE_ACT_CONTRACT.name && granted.has(contract.name)
        )
        .map((contract) => ({ name: contract.name, summary: contract.summary }));
      let calls = 0;
      return runCodeAct((input as { code: string }).code, {
        functions,
        call: async (name, params) => {
          calls += 1;
          const result = await dispatch(
            {
              action: name,
              input: params ?? {},
              operationId: `${context.operationId ?? 'code_act'}#${calls}`,
            },
            context
          );
          if (result.status === 'completed') return result.data;
          throw new Error(`${result.error.code}: ${result.error.message}`);
        },
      });
    },
  };
}
