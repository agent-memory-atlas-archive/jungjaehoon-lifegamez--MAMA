import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import * as yaml from 'js-yaml';

export type RuntimeBackend = 'claude' | 'codex';
export type RuntimeEffort = 'low' | 'medium' | 'high' | 'max' | 'xhigh';
export type RuntimeSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';

export interface W1AgentConfig {
  backend: RuntimeBackend;
  model: string;
  effort: RuntimeEffort;
  max_turns: number;
  timeout: number;
  run_token_budget: number;
  codex_home?: string;
  codex_cwd?: string;
  codex_sandbox?: RuntimeSandbox;
  tools?: { mcp_config?: string };
}

export interface W1TelegramConfig {
  enabled: boolean;
  token?: string;
  allowed_chats: string[];
  owner_user_ids: string[];
  polling: boolean;
}

export interface W1WikiConfig {
  enabled: boolean;
  vaultPath?: string;
  wikiDir?: string;
}

export interface W1Config {
  version: 1;
  agent: W1AgentConfig;
  database: { path: string };
  logging: { level: 'debug' | 'info' | 'warn' | 'error'; file: string };
  telegram: W1TelegramConfig;
  wiki?: W1WikiConfig;
}

export interface LoadConfigOptions {
  path?: string;
  configPath?: string;
  home?: string;
}

export interface ParseConfigOptions {
  home?: string;
}

interface ParseState {
  readonly ignored: string[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const CONFIG_KEYS = ['version', 'agent', 'database', 'logging', 'telegram', 'wiki'] as const;
const AGENT_KEYS = [
  'backend',
  'model',
  'effort',
  'max_turns',
  'timeout',
  'run_token_budget',
  'codex_home',
  'codex_cwd',
  'codex_sandbox',
  'tools',
] as const;

function object(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function collectIgnoredKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  state: ParseState
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) state.ignored.push(path === '' ? key : `${path}.${key}`);
  }
}

function warnIgnored(names: readonly string[]): void {
  if (names.length > 0) console.warn(`ignored in W1: ${names.join(', ')}`);
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`${path} must be nonblank text`);
  }
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ConfigError(`${path} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function stringList(value: unknown, path: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfigError(`${path} must be an array of strings`);
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function optionalText(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : text(value, path);
}

function wikiPath(value: string, home: string): string {
  const expanded =
    value === '~'
      ? home
      : value.startsWith('~/')
        ? join(home, value.slice(2))
        : value.replace(/^\$\{HOME\}(?=\/|$)/, home);
  return isAbsolute(expanded) ? expanded : value;
}

function configPath(value: string, home: string): string {
  const expanded =
    value === '~'
      ? home
      : value.startsWith('~/')
        ? join(home, value.slice(2))
        : value.replace(/^\$\{HOME\}(?=\/|$)/, home);
  return isAbsolute(expanded) ? expanded : resolve(home, expanded);
}

function parseAgent(value: unknown, home: string, state: ParseState): W1AgentConfig {
  const raw = object(value, 'agent');
  collectIgnoredKeys(raw, AGENT_KEYS, 'agent', state);
  const backend = text(raw.backend, 'agent.backend');
  if (backend !== 'claude' && backend !== 'codex') {
    throw new ConfigError('agent.backend must be claude or codex');
  }
  const effort = (raw.effort ?? 'medium') as string;
  if (!['low', 'medium', 'high', 'max', 'xhigh'].includes(effort)) {
    throw new ConfigError('agent.effort is not a supported effort level');
  }
  const sandbox = raw.codex_sandbox;
  if (
    sandbox !== undefined &&
    !['read-only', 'workspace-write', 'danger-full-access'].includes(String(sandbox))
  ) {
    throw new ConfigError('agent.codex_sandbox is not a supported sandbox');
  }
  let tools: W1AgentConfig['tools'];
  if (raw.tools !== undefined) {
    const toolConfig = object(raw.tools, 'agent.tools');
    collectIgnoredKeys(toolConfig, ['mcp_config'], 'agent.tools', state);
    tools = {
      ...(toolConfig.mcp_config === undefined
        ? {}
        : { mcp_config: configPath(text(toolConfig.mcp_config, 'agent.tools.mcp_config'), home) }),
    };
  }
  const codexHome = optionalText(raw.codex_home, 'agent.codex_home');
  const codexCwd = optionalText(raw.codex_cwd, 'agent.codex_cwd');
  return {
    backend: backend as RuntimeBackend,
    model: text(raw.model, 'agent.model'),
    effort: effort as RuntimeEffort,
    max_turns: integer(raw.max_turns, 'agent.max_turns', 1),
    timeout: integer(raw.timeout, 'agent.timeout', 1),
    run_token_budget: integer(raw.run_token_budget ?? 0, 'agent.run_token_budget'),
    ...(codexHome === undefined ? {} : { codex_home: configPath(codexHome, home) }),
    ...(codexCwd === undefined ? {} : { codex_cwd: configPath(codexCwd, home) }),
    ...(sandbox === undefined ? {} : { codex_sandbox: sandbox as RuntimeSandbox }),
    ...(tools === undefined ? {} : { tools }),
  };
}

function deriveTelegramOwnerIds(
  telegramRaw: Record<string, unknown>,
  allowedChats: readonly string[]
): string[] {
  if (telegramRaw.owner_user_ids !== undefined) {
    return Array.from(
      new Set(
        stringList(telegramRaw.owner_user_ids, 'telegram.owner_user_ids').map((id) => id.trim())
      )
    );
  }

  const normalizedAllowedChatIds = Array.from(new Set(allowedChats.map((chatId) => chatId.trim())));
  const positiveAllowedChatIds = normalizedAllowedChatIds.filter((chatId) =>
    /^[1-9]\d*$/.test(chatId)
  );
  const [onlyOwnerId] = positiveAllowedChatIds;
  return onlyOwnerId === undefined ? [] : positiveAllowedChatIds.length === 1 ? [onlyOwnerId] : [];
}

function parseConfigValue(
  value: unknown,
  options: ParseConfigOptions = {}
): { config: W1Config; ignored: readonly string[] } {
  const home = options.home ?? homedir();
  const state: ParseState = { ignored: [] };
  const raw = object(value, 'config');
  collectIgnoredKeys(raw, CONFIG_KEYS, '', state);
  if (raw.version !== 1) throw new ConfigError('version must be 1');
  const database = object(raw.database, 'database');
  collectIgnoredKeys(database, ['path'], 'database', state);
  const logging = object(raw.logging, 'logging');
  collectIgnoredKeys(logging, ['level', 'file'], 'logging', state);
  const level = text(logging.level, 'logging.level');
  if (!['debug', 'info', 'warn', 'error'].includes(level)) {
    throw new ConfigError('logging.level is not supported');
  }
  const telegramRaw = raw.telegram === undefined ? {} : object(raw.telegram, 'telegram');
  collectIgnoredKeys(
    telegramRaw,
    ['enabled', 'token', 'allowed_chats', 'owner_user_ids', 'polling'],
    'telegram',
    state
  );
  if (typeof (telegramRaw.enabled ?? false) !== 'boolean') {
    throw new ConfigError('telegram.enabled must be boolean');
  }
  if (telegramRaw.polling !== undefined && typeof telegramRaw.polling !== 'boolean') {
    throw new ConfigError('telegram.polling must be boolean');
  }
  const allowedChats = stringList(telegramRaw.allowed_chats, 'telegram.allowed_chats');
  const wikiRaw = raw.wiki === undefined ? undefined : object(raw.wiki, 'wiki');
  if (wikiRaw !== undefined)
    collectIgnoredKeys(wikiRaw, ['enabled', 'vaultPath', 'wikiDir'], 'wiki', state);
  let wiki: W1WikiConfig | undefined;
  if (wikiRaw !== undefined) {
    if (typeof (wikiRaw.enabled ?? false) !== 'boolean') {
      throw new ConfigError('wiki.enabled must be boolean');
    }
    const enabled = (wikiRaw.enabled ?? false) as boolean;
    const vaultPath = optionalText(wikiRaw.vaultPath, 'wiki.vaultPath');
    const rawWikiDir = optionalText(wikiRaw.wikiDir, 'wiki.wikiDir');
    if (enabled && (vaultPath === undefined || rawWikiDir === undefined)) {
      throw new ConfigError('enabled wiki requires wiki.vaultPath and wiki.wikiDir');
    }
    wiki = {
      enabled,
      ...(vaultPath === undefined ? {} : { vaultPath: configPath(vaultPath, home) }),
      ...(rawWikiDir === undefined ? {} : { wikiDir: wikiPath(rawWikiDir, home) }),
    };
  }
  return {
    config: {
      version: 1,
      agent: parseAgent(raw.agent, home, state),
      database: { path: configPath(text(database.path, 'database.path'), home) },
      logging: {
        level: level as W1Config['logging']['level'],
        file: configPath(text(logging.file, 'logging.file'), home),
      },
      telegram: {
        enabled: (telegramRaw.enabled ?? false) as boolean,
        ...(telegramRaw.token === undefined
          ? {}
          : { token: text(telegramRaw.token, 'telegram.token') }),
        allowed_chats: allowedChats,
        owner_user_ids: deriveTelegramOwnerIds(telegramRaw, allowedChats),
        // Absent means the daemon polls, as in the archive gateway (`polling !== false`);
        // only an explicit `false` hands inbound polling to another instance.
        polling: (telegramRaw.polling ?? true) as boolean,
      },
      ...(wiki === undefined ? {} : { wiki }),
    },
    ignored: Object.freeze(state.ignored),
  };
}

export function parseConfig(value: unknown, options: ParseConfigOptions = {}): W1Config {
  return parseConfigValue(value, options).config;
}

export function defaultConfigPath(home = homedir()): string {
  return join(home, '.mama', 'config.yaml');
}

export function loadConfig(options: LoadConfigOptions = {}): W1Config {
  const path = options.path ?? options.configPath ?? defaultConfigPath(options.home);
  let parsed: unknown;
  try {
    parsed = yaml.load(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Cannot load config ${path}: ${message}`);
  }
  const loaded = parseConfigValue(parsed, { home: options.home });
  warnIgnored(loaded.ignored);
  return loaded.config;
}
