import { lstatSync, readFileSync } from 'node:fs';

import type {
  AuthConfig,
  ChannelConfig,
  ConnectorConfig,
  ConnectorsConfig,
} from './framework/types.js';

export type ConnectorConfigLoadErrorCode = 'read_error' | 'parse_error' | 'validation_error';

export interface ConnectorConfigLoadError {
  readonly code: ConnectorConfigLoadErrorCode;
  readonly path: string;
  readonly message: string;
}

export type ConnectorConfigLoadResult =
  | {
      readonly ok: true;
      readonly config: ConnectorsConfig;
      readonly enabledNames: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: ConnectorConfigLoadError;
      readonly config: Record<string, never>;
      readonly enabledNames: readonly string[];
    };

const ROLES = new Set<ChannelConfig['role']>([
  'truth',
  'hub',
  'deliverable',
  'spoke',
  'reference',
  'ignore',
]);

class ConfigValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ConfigValidationError(`${field} must be an object`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigValidationError(`${field} must be nonblank text`);
  }
  return value;
}

function channel(value: unknown, field: string): ChannelConfig {
  const raw = record(value, field);
  if (typeof raw.role !== 'string' || !ROLES.has(raw.role as ChannelConfig['role'])) {
    throw new ConfigValidationError(`${field}.role must be a valid channel role`);
  }
  const result: ChannelConfig = { role: raw.role as ChannelConfig['role'] };
  if (raw.name !== undefined) result.name = text(raw.name, `${field}.name`);
  if (raw.boardId !== undefined) result.boardId = text(raw.boardId, `${field}.boardId`);
  return result;
}

function channels(value: unknown, field: string): Record<string, ChannelConfig> {
  const raw = record(value, field);
  const result = Object.create(null) as Record<string, ChannelConfig>;
  for (const [key, value] of Object.entries(raw)) {
    result[key] = channel(value, `${field}.${key}`);
  }
  return result;
}

function auth(value: unknown, field: string): AuthConfig {
  const raw = record(value, field);
  if (raw.type !== 'token' && raw.type !== 'none') {
    throw new ConfigValidationError(`${field}.type must be token or none`);
  }
  const result: AuthConfig = { type: raw.type };
  if (raw.tokenName !== undefined) result.tokenName = text(raw.tokenName, `${field}.tokenName`);
  return result;
}

function connector(value: unknown, field: string): ConnectorConfig {
  const raw = record(value, field);
  if (typeof raw.enabled !== 'boolean') {
    throw new ConfigValidationError(`${field}.enabled must be boolean`);
  }
  if (
    typeof raw.pollIntervalMinutes !== 'number' ||
    !Number.isFinite(raw.pollIntervalMinutes) ||
    raw.pollIntervalMinutes <= 0
  ) {
    throw new ConfigValidationError(
      `${field}.pollIntervalMinutes must be a finite number greater than zero`
    );
  }
  return {
    enabled: raw.enabled,
    pollIntervalMinutes: raw.pollIntervalMinutes,
    channels: channels(raw.channels, `${field}.channels`),
    auth: auth(raw.auth, `${field}.auth`),
  };
}

function validate(value: unknown): ConnectorsConfig {
  const raw = record(value, 'connectors');
  const result = Object.create(null) as ConnectorsConfig;
  const normalized = new Set<string>();
  let index = 0;
  for (const [name, value] of Object.entries(raw)) {
    const key = name.toLowerCase();
    if (normalized.has(key)) {
      throw new ConfigValidationError(`connectors contain a case collision at entry ${index}`);
    }
    normalized.add(key);
    result[key] = connector(value, `connectors.${name}`);
    index += 1;
  }
  return result;
}

function failure(
  code: ConnectorConfigLoadErrorCode,
  path: string,
  message: string
): ConnectorConfigLoadResult {
  return {
    ok: false,
    error: Object.freeze({ code, path, message }),
    config: Object.freeze(Object.create(null) as Record<string, never>),
    enabledNames: Object.freeze([]),
  };
}

export function loadConnectorConfig(path: string): ConnectorConfigLoadResult {
  if (typeof path !== 'string' || path.trim() === '') {
    return failure(
      'read_error',
      typeof path === 'string' ? path : '',
      'Connector configuration path is required'
    );
  }
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      return { ok: true, config: Object.create(null), enabledNames: Object.freeze([]) };
    }
    return failure('read_error', path, `Unable to inspect connector configuration at ${path}`);
  }

  let source: string;
  try {
    source = readFileSync(path, 'utf8');
  } catch {
    return failure('read_error', path, `Unable to read connector configuration at ${path}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return failure(
      'parse_error',
      path,
      `Connector configuration at ${path} contains malformed JSON`
    );
  }

  try {
    const config = validate(parsed);
    return {
      ok: true,
      config,
      enabledNames: Object.freeze(
        Object.entries(config)
          .filter(([, value]) => value.enabled)
          .map(([name]) => name)
      ),
    };
  } catch (error) {
    const message =
      error instanceof ConfigValidationError
        ? error.message
        : 'Connector configuration failed structural validation';
    return failure('validation_error', path, message);
  }
}
