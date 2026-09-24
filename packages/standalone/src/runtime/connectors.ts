import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import { loadConnector, LOADABLE_CONNECTORS } from '../connectors/index.js';
import {
  loadConnectorConfig,
  type ConnectorConfigLoadResult,
} from '../connectors/config-loader.js';
import { ConnectorRegistry } from '../connectors/framework/connector-registry.js';
import {
  PollingScheduler,
  type RawBatchCommittedCallback,
} from '../connectors/framework/polling-scheduler.js';
import {
  RawStore,
  mapNormalizedItemsToConnectorEventIndexInputs,
  type RawIndexSink,
} from '../storage/source-archive.js';
import { upsertConnectorEventIndex } from '../connectors/framework/event-index.js';

const ONE_DAY_MS = 86_400_000;

export interface ConnectorRuntimeOptions {
  configPath: string;
  rawPath: string;
  statePath: string;
  trelloStatePath?: string;
  kagemushaDbPath?: string;
  clock?: () => number;
  rawStore?: RawStore;
  coreAdapter?: DatabaseInstance;
  rawIndexSink?: RawIndexSink;
  acceptSourceDelta: RawBatchCommittedCallback;
  loadConnector?: typeof loadConnector;
  setInterval?: (handler: () => void, timeout: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
  configResult?: ConnectorConfigLoadResult;
}

export interface ConnectorRuntime {
  readonly registry: ConnectorRegistry;
  readonly scheduler: PollingScheduler;
  readonly enabledConnectorNames: readonly string[];
  pollNow(): Promise<void>;
  stop(): Promise<void>;
}

function coreIndexSink(adapter: DatabaseInstance): RawIndexSink {
  return (connectorName, items) => {
    for (const input of mapNormalizedItemsToConnectorEventIndexInputs(connectorName, items)) {
      upsertConnectorEventIndex(adapter, input);
    }
  };
}

function configurationOrThrow(
  result: ConnectorConfigLoadResult
): Extract<ConnectorConfigLoadResult, { ok: true }> {
  if (!result.ok) throw new Error(result.error.message);
  return result;
}

export async function startConnectorRuntime(
  options: ConnectorRuntimeOptions
): Promise<ConnectorRuntime> {
  const config = configurationOrThrow(
    options.configResult ?? loadConnectorConfig(options.configPath)
  );
  const supported = new Set<string>(LOADABLE_CONNECTORS);
  const enabledConnectorNames = config.enabledNames.filter((name) => supported.has(name));
  const channelConfigs = Object.fromEntries(
    enabledConnectorNames.map((name) => [name, config.config[name]?.channels ?? {}])
  );
  const registry = new ConnectorRegistry();
  const load = options.loadConnector ?? loadConnector;
  const rawStore = options.rawStore ?? new RawStore(options.rawPath);
  const ownsRawStore = options.rawStore === undefined;
  const clock = options.clock ?? Date.now;
  const bootstrapNow = clock();
  const indexSink =
    options.rawIndexSink ??
    (options.coreAdapter === undefined ? undefined : coreIndexSink(options.coreAdapter));
  if (indexSink === undefined) {
    if (ownsRawStore) rawStore.close();
    throw new Error('Connector runtime requires a core index projection port');
  }

  try {
    for (const name of enabledConnectorNames) {
      const connector = await load(name, config.config[name], {
        trelloStatePath: options.trelloStatePath,
        kagemushaDbPath: options.kagemushaDbPath,
      });
      await connector.init();
      registry.register(name, connector);
    }

    const scheduler = new PollingScheduler(rawStore, options.statePath, {
      rawIndexSink: indexSink,
      initialLookbackMs: ONE_DAY_MS,
      now: clock,
      initialNow: bootstrapNow,
    });
    const accept = options.acceptSourceDelta;
    await scheduler.pollAll(registry, channelConfigs, accept);

    const setIntervalFn = options.setInterval ?? setInterval;
    const clearIntervalFn = options.clearInterval ?? clearInterval;
    const timers: Array<
      [ReturnType<typeof setInterval>, (timer: ReturnType<typeof setInterval>) => void]
    > = [];
    for (const name of enabledConnectorNames) {
      const intervalMinutes = config.config[name]?.pollIntervalMinutes;
      if (intervalMinutes === undefined)
        throw new Error(`Missing poll interval for connector ${name}`);
      const timer = setIntervalFn(
        () => void scheduler.pollConnector(name, registry, channelConfigs, accept),
        intervalMinutes * 60_000
      );
      timers.push([timer, clearIntervalFn]);
    }

    let stopped = false;
    return {
      registry,
      scheduler,
      enabledConnectorNames,
      pollNow: () => scheduler.pollAll(registry, channelConfigs, accept),
      stop: async () => {
        if (stopped) return;
        stopped = true;
        for (const [timer, clear] of timers) clear(timer);
        scheduler.stop();
        await registry.disposeAll();
        if (ownsRawStore) rawStore.close();
      },
    };
  } catch (error) {
    await registry.disposeAll();
    if (ownsRawStore) rawStore.close();
    throw error;
  }
}
