/**
 * Role tool names that resolve to Claude CLI builtin tools. Catalog/MCP actions
 * are granted through a different surface; this map covers only the CLI's own
 * builtins.
 */
const CLAUDE_NATIVE_TOOL_MAP: Readonly<Record<string, string>> = {
  native_subagent: 'Agent',
  Read: 'Read',
  Write: 'Write',
  Edit: 'Edit',
  NotebookEdit: 'NotebookEdit',
  Bash: 'Bash',
  Glob: 'Glob',
  Grep: 'Grep',
  WebFetch: 'WebFetch',
  WebSearch: 'WebSearch',
};

const CLAUDE_BUILTIN_TOOLS: readonly string[] = [
  'Agent',
  'Read',
  'Write',
  'Edit',
  'NotebookEdit',
  'Bash',
  'Glob',
  'Grep',
  'WebFetch',
  'WebSearch',
];

export interface ClaudeToolRole {
  allowedTools?: readonly string[];
  blockedTools?: readonly string[];
}

function isBlocked(cliName: string, blocked: ReadonlySet<string>): boolean {
  if (blocked.has(cliName)) return true;
  return Object.entries(CLAUDE_NATIVE_TOOL_MAP).some(
    ([roleName, mapped]) => mapped === cliName && blocked.has(roleName)
  );
}

/** Project the turn's native builtin grant onto Claude's --tools value. */
export function projectClaudeNativeTools(role: ClaudeToolRole | undefined): string | undefined {
  const allowed = role?.allowedTools ?? [];
  const blocked = new Set(role?.blockedTools ?? []);
  if (blocked.has('*')) return '';
  if (allowed.includes('*')) {
    const granted = CLAUDE_BUILTIN_TOOLS.filter((tool) => !isBlocked(tool, blocked));
    return granted.length === CLAUDE_BUILTIN_TOOLS.length ? undefined : granted.join(',');
  }
  const granted = new Set<string>();
  for (const [roleName, cliName] of Object.entries(CLAUDE_NATIVE_TOOL_MAP)) {
    if (allowed.includes(roleName) && !blocked.has(roleName) && !blocked.has(cliName)) {
      granted.add(cliName);
    }
  }
  return [...granted].join(',');
}
