import type { ConnectorConfig, IConnector } from './framework/types.js';

export * from './framework/index.js';

export const LOADABLE_CONNECTORS = [
  'chatwork',
  'slack',
  'trello',
  'kagemusha',
  'calendar',
] as const;

export type LoadableConnector = (typeof LOADABLE_CONNECTORS)[number];

export interface ConnectorLoadPaths {
  trelloStatePath?: string;
  kagemushaDbPath?: string;
}

const loaders: Record<
  LoadableConnector,
  (config: ConnectorConfig, paths?: ConnectorLoadPaths) => Promise<IConnector>
> = {
  chatwork: async (config) => new (await import('./chatwork/index.js')).ChatworkConnector(config),
  slack: async (config) => new (await import('./slack/index.js')).SlackConnector(config),
  calendar: async (config) => new (await import('./calendar/index.js')).CalendarConnector(config),
  trello: async (config, paths) => {
    if (paths?.trelloStatePath === undefined) throw new Error('Trello state file path is required');
    return new (await import('./trello/index.js')).TrelloConnector(config, paths.trelloStatePath);
  },
  kagemusha: async (config, paths) => {
    if (paths?.kagemushaDbPath === undefined)
      throw new Error('Kagemusha source database path is required');
    return new (await import('./kagemusha/index.js')).KagemushaConnector(
      config,
      paths.kagemushaDbPath
    );
  },
};

/**
 * Dynamic connector loader — avoids importing all connector deps at startup.
 * Optionally accepts a ConnectorConfig; if omitted, a minimal disabled config is used
 * (useful for CLI introspection like healthCheck or getAuthRequirements).
 */
export async function loadConnector(
  name: string,
  config?: ConnectorConfig,
  paths?: ConnectorLoadPaths
): Promise<IConnector> {
  if (!(LOADABLE_CONNECTORS as readonly string[]).includes(name)) {
    throw new Error(`Unsupported connector: ${name}`);
  }
  const effectiveConfig: ConnectorConfig = config ?? {
    enabled: false,
    pollIntervalMinutes: 5,
    channels: {},
    auth: { type: 'none' },
  };

  return loaders[name as LoadableConnector](effectiveConfig, paths);
}
