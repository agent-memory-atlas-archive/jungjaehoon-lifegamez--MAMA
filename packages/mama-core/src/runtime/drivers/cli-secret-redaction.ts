import { readFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import type { CodexAppServerLaunchConfig } from './codex-home.js';

export function configuredSecretValues(launch: CodexAppServerLaunchConfig): Set<string> {
  const names = new Set<string>();
  const addJsonString = (source: string): void => {
    try {
      const name = JSON.parse(source) as unknown;
      if (typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        names.add(name);
      }
    } catch (error: unknown) {
      throw new Error('Codex app-server launch config contained malformed environment quoting', {
        cause: error,
      });
    }
  };

  for (const argument of launch.args) {
    for (const match of argument.matchAll(/env_vars\s*=\s*\[([^\]]*)\]/g)) {
      for (const quoted of match[1].matchAll(/"(?:\\.|[^"\\])*"/g)) {
        addJsonString(quoted[0]);
      }
    }
    for (const match of argument.matchAll(/bearer_token_env_var\s*=\s*("(?:\\.|[^"\\])*")/g)) {
      addJsonString(match[1]);
    }
    for (const match of argument.matchAll(/env_http_headers\s*=\s*\{([^}]*)\}/g)) {
      for (const binding of match[1].matchAll(/=\s*("(?:\\.|[^"\\])*")/g)) {
        addJsonString(binding[1]);
      }
    }
  }

  const values = new Set<string>();
  for (const name of names) {
    const value = launch.env[name];
    if (typeof value === 'string' && value.length > 0) {
      values.add(value);
    }
  }
  return values;
}

/** Exact configured values, never an entropy/token-length guess. */
export function redactConfiguredSecrets(value: string, secrets: ReadonlySet<string>): string {
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    if (secret) value = value.split(secret).join('[REDACTED]');
  }
  return value;
}

export function claudeConfiguredSecrets(
  configPath: string | undefined,
  env: NodeJS.ProcessEnv
): Set<string> {
  const values = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value) values.add(value);
  };
  for (const [name, value] of Object.entries(env)) {
    if (name !== 'MAX_THINKING_TOKENS' && /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(name))
      add(value);
  }
  if (!configPath) return values;
  type SecretConfig = {
    mcpServers?: Record<
      string,
      {
        env?: Record<string, string>;
        env_vars?: string[];
        headers?: Record<string, string>;
        http_headers?: Record<string, string>;
        bearer_token_env_var?: string;
        env_http_headers?: Record<string, string>;
      }
    >;
  };
  let config: SecretConfig;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8')) as SecretConfig;
  } catch {
    throw new Error('Native MCP secret configuration could not be read');
  }
  for (const server of Object.values(config.mcpServers ?? {})) {
    for (const value of Object.values(server.env ?? {})) add(value);
    for (const value of Object.values(server.headers ?? {})) add(value);
    for (const value of Object.values(server.http_headers ?? {})) add(value);
    for (const name of [
      ...(server.env_vars ?? []),
      ...Object.values(server.env_http_headers ?? {}),
    ])
      add(env[name]);
    if (server.bearer_token_env_var) add(env[server.bearer_token_env_var]);
  }
  return values;
}

/** Keep the possible credential suffix until the next chunk (including UTF-8 boundaries). */
export class SecretRedactingStream {
  private pending = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly overlap: number;
  constructor(
    private readonly secrets: ReadonlySet<string>,
    private readonly emit: (safe: string) => void
  ) {
    this.overlap = Math.max(0, ...[...secrets].map((secret) => secret.length - 1));
  }
  write(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    let cut = Math.max(0, this.pending.length - this.overlap);
    // Never split a complete match at the output boundary.
    for (const secret of this.secrets) {
      for (
        let start = this.pending.indexOf(secret);
        secret && start !== -1;
        start = this.pending.indexOf(secret, start + 1)
      ) {
        if (start < cut && start + secret.length > cut) cut = start;
      }
    }
    if (cut) this.emit(redactConfiguredSecrets(this.pending.slice(0, cut), this.secrets));
    this.pending = this.pending.slice(cut);
  }
  end(): void {
    this.pending += this.decoder.end();
    if (this.pending) this.emit(redactConfiguredSecrets(this.pending, this.secrets));
    this.pending = '';
  }
}
