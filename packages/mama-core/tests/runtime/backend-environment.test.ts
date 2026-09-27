import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';
import { PersistentClaudeProcess } from '../../src/runtime/drivers/persistent-cli-process.js';
import { buildMAMACodexAppServerConfig } from '../../src/runtime/drivers/codex-home.js';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('consumer backend isolation options', () => {
  it('replaces the inherited environment at Claude spawn and sends Read denies on the CLI', async () => {
    const home = mkdtempSync(join(tmpdir(), 'backend-env-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('TEST_SECRET', 'synthetic');
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      kill: vi.fn(),
      pid: 12345,
      killed: false,
    });
    vi.mocked(spawn).mockReturnValue(child as never);
    const process = new PersistentClaudeProcess({
      workspaceDir: home,
      sessionId: 'fixture',
      processEnv: { PATH: '/usr/bin', HOME: home },
      env: { CHILD_SETTING: 'enabled' },
      allowedTools: ['Read'],
      disallowedTools: [`Read(/${home}/private/**)`],
      permissionMode: 'dontAsk',
    });
    try {
      await process.start();
      const [, args, options] = vi.mocked(spawn).mock.calls[0]!;
      const env = (options as { env: NodeJS.ProcessEnv }).env;
      expect(Object.hasOwn(env, 'TEST_SECRET')).toBe(false);
      expect(env.CHILD_SETTING).toBe('enabled');
      expect(env.HOME).toBe(home);
      expect(args).toEqual(
        expect.arrayContaining(['--disallowedTools', `Read(/${home}/private/**)`])
      );
    } finally {
      process.stop();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('uses a named deny-read profile without the legacy sandbox override', () => {
    const config = buildMAMACodexAppServerConfig(undefined, undefined, {
      deniedReadPaths: ['/private/credential'],
    });
    expect(config).toContain('default_permissions = "host-workspace"');
    expect(config).toContain('extends = ":workspace"');
    expect(config).toContain('"/private/credential" = "deny"');
    expect(config).toContain('approval_policy = "never"');
    expect(config).toContain('[permissions.host-workspace.network]\nenabled = false');
    expect(config).not.toContain('sandbox_mode');
  });
});
