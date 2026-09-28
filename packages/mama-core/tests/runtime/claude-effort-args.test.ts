import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';

const workspace = mkdtempSync(join(tmpdir(), 'claude-effort-args-'));

function effortArg(model: string, effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max') {
  const process = new PersistentClaudeProcess({
    sessionId: 'effort-args',
    workspaceDir: workspace,
    model,
    effort,
  } as ConstructorParameters<typeof PersistentClaudeProcess>[0]);
  // Inspect the real launch arguments without starting Claude.
  const args = (process as unknown as { buildArgs(): string[] }).buildArgs();
  const index = args.indexOf('--effort');
  return index === -1 ? null : args[index + 1];
}

afterAll(() => rmSync(workspace, { recursive: true, force: true }));

describe('Claude --effort', () => {
  it.each([
    ['claude-opus-4-8', 'max', 'max'],
    ['claude-opus-4-7', 'xhigh', 'xhigh'],
    ['claude-sonnet-5', 'max', 'max'],
    ['claude-opus-5', 'xhigh', 'xhigh'],
    ['claude-opus-5-5', 'medium', 'medium'],
    ['claude-fable-5-1', 'xhigh', 'xhigh'],
    ['claude-sonnet-4-6', 'xhigh', 'high'],
    ['claude-opus-4-6', 'max', 'max'],
  ] as const)('passes the level %s accepts (%s → %s)', (model, effort, expected) => {
    expect(effortArg(model, effort)).toBe(expected);
  });

  it('passes no effort to a model without effort support', () => {
    expect(effortArg('claude-haiku-4-5', 'high')).toBeNull();
  });
});
