import { randomUUID } from 'node:crypto';
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
import {
  startConnectorRuntime,
  type ConnectorRuntime,
  type ConnectorRuntimeOptions,
} from '../../runtime/connectors.js';
import { defaultConfigPath, loadConfig, type W1Config } from '../../runtime/config.js';
import { ensureMamaMcpConfig, resolveActionServerPath } from '../runtime/action-mcp-config.js';
import type { SourceDelta } from '../../connectors/framework/polling-scheduler.js';

const SCHEDULED_TICK_INTERVAL_MS = 60_000;
const OWNER_PRINCIPAL_ID = 'owner';
const OWNER_AGENT_ID = 'owner-agent';
const OWNER_MEMORY_SCOPES = [{ kind: 'global' as const, id: 'system' }];
const OWNER_CONNECTORS = ['chatwork', 'slack', 'trello', 'kagemusha'] as const;

export interface DaemonLogger {
  info(line: string): void;
  error(line: string): void;
}

export interface DaemonGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  deliverResponse(sourceRef: string, response: string): Promise<void>;
}

export interface DaemonScheduledTick {
  stop(): Promise<void> | void;
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

export interface DaemonScheduledTickOptions {
  intake: Pick<StimulusIntake, 'acceptScheduled'>;
  logger: DaemonLogger;
  now?: () => number;
  setInterval?: (handler: () => void, timeout: number) => ReturnType<typeof setInterval>;
  clearInterval?: (timer: ReturnType<typeof setInterval>) => void;
}

export interface DaemonBootDependencies {
  createOwnerRuntime?: (options: OwnerRuntimeOptions) => Promise<OwnerRuntime>;
  startConnectorRuntime?: (options: ConnectorRuntimeOptions) => Promise<ConnectorRuntime>;
  createTelegramGateway?: (options: TelegramGatewayOptions) => DaemonGateway;
  createScheduledTick?: (options: DaemonScheduledTickOptions) => DaemonScheduledTick;
  ensureIsolation?: (options: DaemonIsolationOptions) => void;
}

export interface DaemonBootOptions {
  home?: string;
  configPath?: string;
  config?: W1Config;
  logger?: DaemonLogger;
  mcpServerPath?: string;
  dependencies?: DaemonBootDependencies;
}

export interface DaemonHandle {
  readonly config: W1Config;
  readonly paths: DaemonPaths;
  readonly owner: OwnerRuntime;
  readonly connectors: ConnectorRuntime;
  readonly gateway: DaemonGateway | null;
  readonly scheduled: DaemonScheduledTick;
  stop(): Promise<void>;
}

const defaultLogger: DaemonLogger = {
  info: (line) => console.log(line),
  error: (line) => console.error(line),
};

function errorName(error: unknown): string {
  return error instanceof Error && error.name.trim() !== '' ? error.name : 'Error';
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
    kagemushaDbPath: join(connectorsRoot, 'kagemusha.db'),
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

export function createScheduledNoopTick(options: DaemonScheduledTickOptions): DaemonScheduledTick {
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  let stopped = false;

  const tick = (): void => {
    if (stopped) return;
    const id = `scheduled:${randomUUID()}`;
    try {
      const receipt = options.intake.acceptScheduled({
        id,
        channelKey: 'scheduled',
        occurredAt: now(),
      });
      stimulusAccepted(options.logger, 'scheduled', id, receipt);
    } catch (error) {
      stimulusFailed(options.logger, 'scheduled', id);
      throw error;
    }
  };

  tick();
  const timer = setIntervalFn(tick, SCHEDULED_TICK_INTERVAL_MS);
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    (timer as { unref?: () => void }).unref?.();
  }
  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    },
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
  let scheduled: DaemonScheduledTick | undefined;
  let stopped = false;
  let currentStage = 'config';

  const stopResources = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const errors: unknown[] = [];
    if (scheduled) await stopOne(logger, 'scheduled', () => scheduled!.stop(), errors);
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
      timeout: config.agent.timeout,
      runTokenBudget: config.agent.run_token_budget,
      ...(config.agent.codex_home === undefined ? {} : { codexHome: config.agent.codex_home }),
      codexSandbox: config.agent.codex_sandbox ?? 'workspace-write',
      ...(config.agent.backend === 'claude' ? { mcpConfigPath: paths.mcpConfigPath } : {}),
      pluginDir: paths.pluginDir,
      onOwnerResult: deliverOwnerResponse,
      onStimulusDelivered: (row) => stimulusDelivered(logger, row),
      onStimulusFailed: (row) => stimulusFailed(logger, row.kind ?? 'unknown', row.stimulusId),
    });
    stage(logger, 'owner_runtime');

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

    currentStage = 'scheduled';
    const scheduledFactory = dependencies.createScheduledTick ?? createScheduledNoopTick;
    scheduled = scheduledFactory({ intake: owner.intake, logger });
    stage(logger, 'scheduled');

    return {
      config,
      paths,
      owner,
      connectors,
      gateway,
      scheduled,
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
