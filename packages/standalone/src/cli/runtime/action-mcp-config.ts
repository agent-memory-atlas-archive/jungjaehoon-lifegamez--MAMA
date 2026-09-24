import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

export interface EnsureMamaMcpConfigOptions {
  mcpConfigPath: string;
  serverPath?: string;
  mamaHome: string;
}

export interface EnsureMamaMcpConfigResult {
  changed: boolean;
  serverPath: string;
}

export const MAMA_MCP_SERVER_NAME = 'mama';

const nodeRequire = createRequire(__filename);

export function resolveActionServerPath(): string {
  return nodeRequire.resolve('@jungjaehoon/mama-server/src/action-server.js');
}

function validEntry(value: unknown, serverPath: string, mamaHome: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as { command?: unknown; args?: unknown; env?: unknown };
  const env = entry.env as Record<string, unknown> | undefined;
  return (
    entry.command === process.execPath &&
    Array.isArray(entry.args) &&
    entry.args.length === 1 &&
    entry.args[0] === serverPath &&
    env?.MAMA_HOME === mamaHome
  );
}

/** Keep Claude's one MCP registration pointed at the shared action socket. */
export function ensureMamaMcpConfig(
  options: EnsureMamaMcpConfigOptions
): EnsureMamaMcpConfigResult {
  const serverPath = options.serverPath ?? resolveActionServerPath();
  let parsed: Record<string, unknown> = {};
  if (existsSync(options.mcpConfigPath)) {
    const value: unknown = JSON.parse(readFileSync(options.mcpConfigPath, 'utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  }
  const servers = parsed.mcpServers;
  if (
    servers &&
    typeof servers === 'object' &&
    !Array.isArray(servers) &&
    validEntry(
      (servers as Record<string, unknown>)[MAMA_MCP_SERVER_NAME],
      serverPath,
      options.mamaHome
    ) &&
    !Object.hasOwn(servers, 'code-act')
  ) {
    return { changed: false, serverPath };
  }
  const nextServers: Record<string, unknown> =
    servers && typeof servers === 'object' && !Array.isArray(servers)
      ? { ...(servers as Record<string, unknown>) }
      : {};
  delete nextServers['code-act'];
  nextServers[MAMA_MCP_SERVER_NAME] = {
    command: process.execPath,
    args: [serverPath],
    env: { MAMA_HOME: options.mamaHome },
  };
  parsed.mcpServers = nextServers;
  mkdirSync(dirname(options.mcpConfigPath), { recursive: true });
  writeFileSync(options.mcpConfigPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return { changed: true, serverPath };
}
