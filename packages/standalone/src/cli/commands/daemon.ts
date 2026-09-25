import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { StimulusReceipt } from '@jungjaehoon/mama-core/runtime/runtime';
import type { OwnerMessageInput, TurnIntake } from '../../gateways/turn-contract.js';
import { TelegramGateway, type TelegramGatewayOptions } from '../../gateways/telegram.js';
import { sourceDeltaStimulusId, type StimulusIntake } from '../../runtime/stimulus-delivery.js';
import {
  createOwnerRuntime,
  type OwnerRuntime,
  type OwnerRuntimeOptions,
} from '../../runtime/owner-runtime.js';
import { ownerMemoryScopes } from '../../runtime/action-surface.js';
import {
  startConnectorRuntime,
  type ConnectorRuntime,
  type ConnectorRuntimeOptions,
} from '../../runtime/connectors.js';
import { defaultConfigPath, loadConfig, type W1Config } from '../../runtime/config.js';
import { ensureMamaMcpConfig, resolveActionServerPath } from '../runtime/action-mcp-config.js';
import type { SourceDelta } from '../../connectors/framework/polling-scheduler.js';
import { createOwnerPolicyProvider } from '../../runtime/owner-policy.js';

const OWNER_PRINCIPAL_ID = 'owner';
const OWNER_AGENT_ID = 'owner-agent';
const OWNER_CONNECTORS = ['chatwork', 'slack', 'trello', 'kagemusha'] as const;
const OWNER_MEMORY_SCOPES = ownerMemoryScopes(OWNER_PRINCIPAL_ID, OWNER_CONNECTORS);

export interface DaemonLogger {
  info(line: string): void;
  error(line: string): void;
}

export interface DaemonGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  deliverResponse(sourceRef: string, response: string): Promise<void>;
}

export interface DaemonPaths {
  mamaRoot: string;
  runtimeRoot: string;
  workspaceDir: string;
  pluginDir: string;
  mcpConfigPath: string;
  socketPath: string;
  credentialPath: string;
  connectorsConfigPath: string;
  connectorsRoot: string;
  trelloStatePath: string;
  kagemushaDbPath: string;
  telegramLedgerPath: string;
}

export interface DaemonIsolationOptions {
  config: W1Config;
  paths: DaemonPaths;
  mcpServerPath?: string;
}

export interface DaemonBootDependencies {
  createOwnerRuntime?: (options: OwnerRuntimeOptions) => Promise<OwnerRuntime>;
  startConnectorRuntime?: (options: ConnectorRuntimeOptions) => Promise<ConnectorRuntime>;
  createTelegramGateway?: (options: TelegramGatewayOptions) => DaemonGateway;
  ensureIsolation?: (options: DaemonIsolationOptions) => void;
}

export interface DaemonBootOptions {
  home?: string;
  configPath?: string;
  config?: W1Config;
  logger?: DaemonLogger;
  mcpServerPath?: string;
  mode?: 'live' | 'replay';
  replay?: (context: DaemonReplayContext) => Promise<void>;
  dependencies?: DaemonBootDependencies;
}

export interface DaemonReplayContext {
  config: W1Config;
  paths: DaemonPaths;
  owner: OwnerRuntime;
  logger: DaemonLogger;
}

export interface DaemonHandle {
  readonly config: W1Config;
  readonly paths: DaemonPaths;
  readonly owner: OwnerRuntime;
  readonly connectors: ConnectorRuntime | null;
  readonly gateway: DaemonGateway | null;
  stop(): Promise<void>;
}

const defaultLogger: DaemonLogger = {
  info: (line) => console.log(line),
  error: (line) => console.error(line),
};

/**
 * A failed stage names what failed. Messages from this codebase never carry
 * secrets (tokens are read from the environment and never formatted into errors).
 */
function errorName(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const name = error.name.trim() !== '' ? error.name : 'Error';
  return `${name}: ${error.message}`;
}

function stage(logger: DaemonLogger, name: string): void {
  logger.info(`boot stage=${name}`);
}

function stageFailed(logger: DaemonLogger, name: string, error: unknown): void {
  logger.error(`boot stage=${name} failed error=${errorName(error)}`);
}

function stimulusAccepted(
  logger: DaemonLogger,
  kind: string,
  id: string,
  receipt: StimulusReceipt
): void {
  logger.info(`stimulus accepted kind=${kind} id=${id} state=${receipt.state}`);
}

function stimulusFailed(logger: DaemonLogger, kind: string, id: string): void {
  logger.error(`stimulus failed kind=${kind} id=${id}`);
}

function stimulusDelivered(logger: DaemonLogger, row: MailboxRow): void {
  logger.info(`stimulus delivered kind=${row.kind ?? 'unknown'} id=${row.stimulusId}`);
}

function pathsFor(configPath: string, config: W1Config): DaemonPaths {
  const mamaRoot = dirname(configPath);
  const runtimeRoot = join(mamaRoot, 'runtime');
  const workspaceDir = config.agent.codex_cwd ?? join(mamaRoot, 'workspace');
  const pluginDir = join(mamaRoot, '.empty-plugins');
  const mcpConfigPath = config.agent.tools?.mcp_config ?? join(runtimeRoot, 'mama-mcp-config.json');
  const connectorsRoot = join(mamaRoot, 'connectors');
  return {
    mamaRoot,
    runtimeRoot,
    workspaceDir,
    pluginDir,
    mcpConfigPath,
    socketPath: join(mamaRoot, 'runtime.sock'),
    credentialPath: join(runtimeRoot, 'session-credential'),
    connectorsConfigPath: join(mamaRoot, 'connectors.json'),
    connectorsRoot,
    trelloStatePath: join(connectorsRoot, 'trello-state.json'),
    // Kagemusha's own database, read-only (archive connector: ~/.kagemusha/kagemusha.db).
    kagemushaDbPath: join(dirname(mamaRoot), '.kagemusha', 'kagemusha.db'),
    telegramLedgerPath: join(runtimeRoot, 'telegram-message-ledger.json'),
  };
}

/** Create only the native-process isolation files; never remove product state. */
export function ensureDaemonIsolation(options: DaemonIsolationOptions): void {
  const { config, paths } = options;
  mkdirSync(paths.workspaceDir, { recursive: true });
  const gitDir = join(paths.workspaceDir, '.git');
  mkdirSync(gitDir, { recursive: true });
  const headPath = join(gitDir, 'HEAD');
  if (!existsSync(headPath)) writeFileSync(headPath, 'ref: refs/heads/main\n', { mode: 0o600 });

  if (config.agent.backend === 'claude') {
    mkdirSync(paths.pluginDir, { recursive: true });
    ensureMamaMcpConfig({
      mcpConfigPath: paths.mcpConfigPath,
      serverPath: options.mcpServerPath ?? resolveActionServerPath(),
      mamaHome: paths.mamaRoot,
    });
  }
}

function loggedOwnerIntake(intake: StimulusIntake, logger: DaemonLogger): TurnIntake {
  return {
    acceptOwnerMessage: (input: OwnerMessageInput) => {
      try {
        const receipt = intake.acceptOwnerMessage(input);
        stimulusAccepted(logger, 'owner_message', input.id, receipt);
        return receipt;
      } catch (error) {
        stimulusFailed(logger, 'owner_message', input.id);
        throw error;
      }
    },
    ...(intake.isPending === undefined ? {} : { isPending: intake.isPending }),
  };
}

async function stopOne(
  logger: DaemonLogger,
  name: string,
  stop: () => Promise<void> | void,
  errors: unknown[]
): Promise<void> {
  try {
    await stop();
  } catch (error) {
    errors.push(error);
    logger.error(`shutdown stage=${name} failed error=${errorName(error)}`);
  }
}

/** Open the W1 owner subject, then activate producers in their dependency order. */
export async function bootDaemon(options: DaemonBootOptions = {}): Promise<DaemonHandle> {
  const logger = options.logger ?? defaultLogger;
  const dependencies = options.dependencies ?? {};
  const configPath = options.configPath ?? defaultConfigPath(options.home ?? homedir());
  let config: W1Config;
  let paths: DaemonPaths;
  let owner: OwnerRuntime | undefined;
  let connectors: ConnectorRuntime | undefined;
  let gateway: DaemonGateway | null = null;
  let stopped = false;
  let currentStage = 'config';

  const stopResources = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const errors: unknown[] = [];
    if (gateway) await stopOne(logger, 'telegram', () => gateway!.stop(), errors);
    if (connectors) await stopOne(logger, 'connectors', () => connectors!.stop(), errors);
    if (owner) await stopOne(logger, 'owner_runtime', () => owner!.stop(), errors);
    if (errors.length > 0) throw new AggregateError(errors, 'Daemon shutdown failed');
  };

  try {
    currentStage = 'config';
    stage(logger, 'config');
    config = options.config ?? loadConfig({ path: configPath, home: options.home });
    paths = pathsFor(configPath, config);
    currentStage = 'isolation';
    const ensureIsolation = dependencies.ensureIsolation ?? ensureDaemonIsolation;
    ensureIsolation({
      config,
      paths,
      ...(options.mcpServerPath ? { mcpServerPath: options.mcpServerPath } : {}),
    });
    stage(logger, 'isolation');

    currentStage = 'owner_runtime';
    const ownerPolicyProvider = createOwnerPolicyProvider(paths.mamaRoot);
    const ownerPolicy = ownerPolicyProvider();
    logger.info(`owner policy: ${ownerPolicy.loaded ? 'loaded' : 'none'}`);
    const deliverOwnerResponse = async (
      row: MailboxRow,
      result: NativeTurnResult
    ): Promise<void> => {
      if (gateway === null)
        throw new Error('Telegram gateway is not available for an owner response');
      await gateway.deliverResponse(row.stimulusId, result.response);
    };
    const ownerFactory = dependencies.createOwnerRuntime ?? createOwnerRuntime;
    owner = await ownerFactory({
      backend: config.agent.backend,
      model: config.agent.model,
      databasePath: config.database.path,
      socketPath: paths.socketPath,
      credentialPath: paths.credentialPath,
      runtimeRoot: paths.mamaRoot,
      workspaceDir: paths.workspaceDir,
      ownerPrincipalId: OWNER_PRINCIPAL_ID,
      agentId: OWNER_AGENT_ID,
      scopes: OWNER_MEMORY_SCOPES,
      connectors: OWNER_CONNECTORS,
      rawPath: paths.connectorsRoot,
      effort: config.agent.effort,
      maxTurns: config.agent.max_turns,
      timeout: config.agent.timeout,
      runTokenBudget: config.agent.run_token_budget,
      ...(config.agent.codex_home === undefined ? {} : { codexHome: config.agent.codex_home }),
      codexSandbox: config.agent.codex_sandbox ?? 'workspace-write',
      ...(config.agent.backend === 'claude' ? { mcpConfigPath: paths.mcpConfigPath } : {}),
      pluginDir: paths.pluginDir,
      ownerPolicyProvider,
      ...(options.mode === 'replay' ? {} : { onOwnerResult: deliverOwnerResponse }),
      onStimulusDelivered: (row) => stimulusDelivered(logger, row),
      onStimulusFailed: (row) => stimulusFailed(logger, row.kind ?? 'unknown', row.stimulusId),
    });
    stage(logger, 'owner_runtime');

    if (options.mode === 'replay') {
      logger.info('replay collectors: disabled');
      currentStage = 'replay';
      if (!options.replay) throw new Error('Replay mode requires a replay feeder');
      await options.replay({ config, paths, owner, logger });
      stage(logger, 'replay');
      return {
        config,
        paths,
        owner,
        connectors: null,
        gateway: null,
        stop: stopResources,
      };
    }

    currentStage = 'connectors';
    const acceptSourceDelta = async (delta: SourceDelta): Promise<void> => {
      const id = sourceDeltaStimulusId(delta);
      try {
        const receipt = owner!.acceptSourceDelta(delta);
        stimulusAccepted(logger, 'source_delta', id, receipt);
      } catch (error) {
        stimulusFailed(logger, 'source_delta', id);
        throw error;
      }
    };
    const connectorFactory = dependencies.startConnectorRuntime ?? startConnectorRuntime;
    connectors = await connectorFactory({
      configPath: paths.connectorsConfigPath,
      rawPath: paths.connectorsRoot,
      statePath: paths.connectorsRoot,
      trelloStatePath: paths.trelloStatePath,
      kagemushaDbPath: paths.kagemushaDbPath,
      coreAdapter: owner.database?.adapter,
      acceptSourceDelta,
    });
    stage(logger, 'connectors');

    currentStage = 'telegram';
    if (config.telegram.enabled) {
      if (config.telegram.token === undefined) throw new Error('Telegram token is required');
      const telegramFactory =
        dependencies.createTelegramGateway ??
        ((gatewayOptions) => new TelegramGateway(gatewayOptions));
      gateway = telegramFactory({
        token: config.telegram.token,
        intake: loggedOwnerIntake(owner.intake, logger),
        config: {
          enabled: config.telegram.enabled,
          allowedChats: config.telegram.allowed_chats,
          ownerUserIds: config.telegram.owner_user_ids,
          polling: config.telegram.polling,
        },
        messageLedgerPath: paths.telegramLedgerPath,
      });
      await gateway.start();
      stage(logger, 'telegram');
    } else {
      stage(logger, 'telegram:disabled');
    }

    return {
      config,
      paths,
      owner,
      connectors,
      gateway,
      stop: stopResources,
    };
  } catch (error) {
    stageFailed(logger, currentStage, error);
    try {
      await stopResources();
    } catch {
      // Preserve the boot error; each cleanup failure was already logged by stopOne.
    }
    throw error;
  }
}

/** Foreground launchd entry: wait until SIGTERM/SIGINT, then close reverse-order stages. */
export async function runDaemon(options: DaemonBootOptions = {}): Promise<void> {
  const daemon = await bootDaemon(options);
  await new Promise<void>((resolve, reject) => {
    let finished = false;
    const finish = async (): Promise<void> => {
      if (finished) return;
      finished = true;
      try {
        await daemon.stop();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    process.once('SIGTERM', () => void finish());
    process.once('SIGINT', () => void finish());
  });
}

export interface MinimalPidRecord {
  pid: number;
}

function pidPath(home = homedir()): string {
  return process.env.MAMA_PID_FILE ?? join(home, '.mama', 'mama.pid');
}

export function readDaemonPid(home = homedir()): number | null {
  try {
    const value = JSON.parse(readFileSync(pidPath(home), 'utf8')) as MinimalPidRecord;
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0) return null;
    return value.pid;
  } catch {
    return null;
  }
}

export function daemonStatus(home = homedir()): 'running' | 'stopped' {
  const pid = readDaemonPid(home);
  if (pid === null) return 'stopped';
  try {
    process.kill(pid, 0);
    return 'running';
  } catch {
    return 'stopped';
  }
}

export function requestDaemonStop(home = homedir()): void {
  const pid = readDaemonPid(home);
  if (pid === null) return;
  process.kill(pid, 'SIGTERM');
}
