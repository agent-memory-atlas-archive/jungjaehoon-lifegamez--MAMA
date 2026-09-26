import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PersistentCLIAdapter } from '../../src/runtime/drivers/persistent-cli-adapter.js';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';

it('carries the consumer noninteractive permission mode into persistent Claude args', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'claude-permissions-'));
  let args: string[] = [];
  vi.spyOn(PersistentClaudeProcess.prototype, 'start').mockImplementation(async function () {
    // Inspect the real launch arguments without starting Claude or a model turn.
    args = (this as unknown as { buildArgs(): string[] }).buildArgs();
  });
  vi.spyOn(PersistentClaudeProcess.prototype, 'isAlive').mockReturnValue(true);
  vi.spyOn(PersistentClaudeProcess.prototype, 'sendMessage').mockResolvedValue({
    response: 'answer',
    session_id: 'test-session',
  });
  vi.spyOn(PersistentClaudeProcess.prototype, 'stop').mockImplementation(async function () {
    this.emit('close');
  });
  const agent = new PersistentCLIAdapter({
    workspaceDir: workspace,
    permissionMode: 'dontAsk',
  });
  try {
    await agent.prompt('input');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('dontAsk');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('project,local');
    expect(args[args.indexOf('--plugin-dir') + 1]).toBe(join(workspace, '.empty-plugins'));
    expect(args).not.toContain('--no-session-persistence');
  } finally {
    await agent.stop();
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  }
});
