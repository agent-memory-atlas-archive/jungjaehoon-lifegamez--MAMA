import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMAMACodexAppServerConfig } from '../../src/runtime/drivers/codex-home.js';
import { CodexRuntimeProcess } from '../../src/runtime/runtime-process.js';

describe('managed Codex shell configuration', () => {
  it('keeps shell and unified execution disabled by default', () => {
    const config = buildMAMACodexAppServerConfig();
    expect(config).toContain('shell_tool = false');
    expect(config).toContain('unified_exec = false');
    expect(config).toContain('sandbox_mode = "workspace-write"');
    expect(config).toContain('approval_policy = "on-request"');
  });

  it('enables only the shell when the consumer opts in', () => {
    const config = buildMAMACodexAppServerConfig('medium', ['# Consumer notes'], {
      shellTool: true,
    });
    expect(config).toContain('shell_tool = true');
    expect(config).toContain('unified_exec = false');
    expect(config).toBe(
      buildMAMACodexAppServerConfig('medium', ['# Consumer notes']).replace(
        'shell_tool = false',
        'shell_tool = true'
      )
    );
  });

  it('preserves the default output when the consumer explicitly disables the shell', () => {
    expect(buildMAMACodexAppServerConfig(undefined, undefined, { shellTool: false })).toBe(
      buildMAMACodexAppServerConfig()
    );
  });

  it.each([undefined, true] as const)(
    'writes the runtime shell option (%s) through the app-server driver',
    async (shellTool) => {
      const root = mkdtempSync(join(tmpdir(), 'codex-shell-config-'));
      const runtime = new CodexRuntimeProcess({
        hostRootDir: root,
        cwd: root,
        shellTool,
        // Configuration is written before spawn; no real CLI or owner turn is needed.
        command: join(root, 'missing-codex'),
      });
      try {
        await expect(runtime.prompt('prepare configuration')).rejects.toThrow('ENOENT');
        const config = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
        expect(config).toContain(shellTool ? 'shell_tool = true' : 'shell_tool = false');
        expect(config).toContain('unified_exec = false');
        expect(config).toContain('sandbox_mode = "workspace-write"');
      } finally {
        await runtime.stop();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
