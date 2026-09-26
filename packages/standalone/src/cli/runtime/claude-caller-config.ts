import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function resolveCallerHookPath(): string {
  return join(__dirname, '..', '..', 'runtime', 'claude-caller-hook.js');
}

/** Owner workspace project settings; the CLI still reads project,local only. */
export function ensureClaudeCallerHook(workspaceDir: string): void {
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
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}
