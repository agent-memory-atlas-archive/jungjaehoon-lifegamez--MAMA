import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function resolveCallerHookPath(): string {
  return join(__dirname, '..', '..', 'runtime', 'claude-caller-hook.js');
}

/** Owner workspace project settings; the CLI still reads project,local only. */
export function ensureClaudeCallerHook(workspaceDir: string): void {
  workspaceDir = resolve(workspaceDir);
  const directory = join(workspaceDir, '.claude');
  const path = join(directory, 'settings.json');
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const command = `${quote(process.execPath)} ${quote(resolveCallerHookPath())}`;
  const hooks = settings.hooks ?? {};
  const previous = hooks.PreToolUse ?? [];
  // Replace only this host-owned registration, retaining other project settings.
  hooks.PreToolUse = [
    ...previous.filter(
      (entry: { hooks?: Array<{ command?: string }> }) =>
        !entry.hooks?.some((hook) => hook.command?.includes('claude-caller-hook.js'))
    ),
    { matcher: 'mcp__mama__.*', hooks: [{ type: 'command', command }] },
  ];
  settings.hooks = hooks;
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(workspaceDir, '.tmp'), { recursive: true, mode: 0o700 });
  // Both loaded scopes belong to this owner runtime; each gets the same sandbox.
  const localPath = join(directory, 'settings.local.json');
  const files = [
    { path, settings },
    ...(existsSync(localPath)
      ? [{ path: localPath, settings: JSON.parse(readFileSync(localPath, 'utf8')) }]
      : []),
  ];
  for (const file of files) {
    // Permission rules are passed on the CLI (claudeOwnerAllowedTools); a grant left in these
    // host-owned files would only widen them.
    delete file.settings.permissions;
    file.settings.sandbox = {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: [],
      filesystem: { allowWrite: [workspaceDir] },
    };
    file.settings.env = {
      ...file.settings.env,
      CLAUDE_CODE_TMPDIR: join(workspaceDir, '.tmp'),
    };
    writeFileSync(file.path, `${JSON.stringify(file.settings, null, 2)}\n`, { mode: 0o600 });
  }
}
