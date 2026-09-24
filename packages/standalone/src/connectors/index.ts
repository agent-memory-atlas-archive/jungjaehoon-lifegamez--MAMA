export * from './framework/index.js';

export const LOADABLE_CONNECTORS = ['chatwork', 'slack', 'trello', 'kagemusha'] as const;

export type LoadableConnector = (typeof LOADABLE_CONNECTORS)[number];

export interface ConnectorLoadPaths {
  trelloStatePath?: string;
  kagemushaDbPath?: string;
}

/**
 * Dynamic connector loader — avoids importing all connector deps at startup.
 * Optionally accepts a ConnectorConfig; if omitted, a minimal disabled config is used
 * (useful for CLI introspection like healthCheck or getAuthRequirements).
 */
export async function loadConnector(
  name: string,
  config?: import('./framework/types.js').ConnectorConfig,
  paths?: ConnectorLoadPaths
): Promise<import('./framework/types.js').IConnector> {
  if (!(LOADABLE_CONNECTORS as readonly string[]).includes(name)) {
    throw new Error(`Unsupported connector: ${name}`);
  }
  const mod = await import(`./${name}/index.js`);
  // Find the export that ends with 'Connector'
  const connectorKey = Object.keys(mod).find((k) => k.endsWith('Connector'));
  if (!connectorKey) throw new Error(`No connector class found in module: ${name}`);

  const effectiveConfig: import('./framework/types.js').ConnectorConfig = config ?? {
    enabled: false,
    pollIntervalMinutes: 5,
    channels: {},
    auth: { type: 'none' },
  };

  if (name === 'trello') {
    if (paths?.trelloStatePath === undefined) throw new Error('Trello state file path is required');
    return new mod[connectorKey](effectiveConfig, paths.trelloStatePath);
  }
  if (name === 'kagemusha') {
    if (paths?.kagemushaDbPath === undefined)
      throw new Error('Kagemusha source database path is required');
    return new mod[connectorKey](effectiveConfig, paths.kagemushaDbPath);
  }
  return new mod[connectorKey](effectiveConfig);
}
