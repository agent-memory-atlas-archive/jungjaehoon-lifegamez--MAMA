import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import type { MailboxRow } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { NativeTurnResult } from '@jungjaehoon/mama-core/runtime/native-turn';
import type { StimulusReceipt } from '@jungjaehoon/mama-core/runtime/runtime';
import type { OwnerMessageInput, TurnIntake } from '../../gateways/turn-contract.js';
import { TelegramGateway, type TelegramGatewayOptions } from '../../gateways/telegram.js';
import {
  sourceDeltaStimulusId,
  stimulusFailureReason,
  type StimulusIntake,
} from '../../runtime/stimulus-delivery.js';
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
import { declareModelCache } from '../../runtime/model-cache.js';
import { sessionCredentialPath } from '../../runtime/session-credential.js';
import { ensureMamaMcpConfig, resolveActionServerPath } from '../runtime/action-mcp-config.js';
import type { SourceDelta } from '../../connectors/framework/polling-scheduler.js';
import { LOADABLE_CONNECTORS as OWNER_CONNECTORS } from '../../connectors/index.js';
import { createOwnerPolicyProvider } from '../../runtime/owner-policy.js';
import {
  createViewerServer as createDefaultViewerServer,
  type ViewerConnectorStatus,
  type ViewerServer,
  type ViewerServerOptions,
} from '../../api/viewer-server.js';
import { resolvePackageVersion } from '../../package-version.js';
import { readViewerMemoryStats } from '../../api/viewer-data.js';
import type { TelegramFileDeliveryResult } from '../../api/file-delivery.js';
import { buildBoardPublishLines } from '../../operator/board-slot-instructions.js';
import { createReportScheduler, type ReportScheduler } from '../../runtime/report-scheduler.js';

const OWNER_PRINCIPAL_ID = 'owner';
const OWNER_AGENT_ID = 'owner-agent';
const OWNER_MEMORY_SCOPES = ownerMemoryScopes(OWNER_PRINCIPAL_ID, OWNER_CONNECTORS);

export interface DaemonLogger {
  info(line: string): void;
  error(line: string): void;
}

export interface DaemonGateway {
  recentDeliveredMessageRefs(): string[];
  recoverPendingResponses(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  deliverResponse(sourceRef: string, response: string): Promise<void>;
  sendToOwner(text: string, idempotencyKey: string): Promise<void>;
  sendFile(
    path: string,
    caption: string | undefined,
    operationId: string
  ): Promise<TelegramFileDeliveryResult>;
}

export interface DaemonPaths {
  mamaRoot: string;
  runtimeRoot: string;
  workspaceDir: string;
  downloadsDir: string;
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
  createViewerServer?: (options: ViewerServerOptions) => ViewerServer;
  startConnectorRuntime?: (options: ConnectorRuntimeOptions) => Promise<ConnectorRuntime>;
  createTelegramGateway?: (options: TelegramGatewayOptions) => DaemonGateway;
  createReportScheduler?: typeof createReportScheduler;
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
  readonly viewer: ViewerServer | null;
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

function stimulusFailed(
  logger: DaemonLogger,
  kind: string,
  id: string,
  error: unknown,
  modelRunId: string | null = null
): void {
  logger.error(
    `stimulus failed kind=${kind} id=${id} model_run_id=${modelRunId} reason=${stimulusFailureReason(error)}`
  );
}

function stimulusDelivered(logger: DaemonLogger, row: MailboxRow, modelRunId: string | null): void {
  logger.info(
    `stimulus delivered kind=${row.kind ?? 'unknown'} id=${row.stimulusId} model_run_id=${modelRunId}`
  );
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
    downloadsDir: join(mamaRoot, 'downloads'),
    pluginDir,
    mcpConfigPath,
    socketPath: join(mamaRoot, 'runtime.sock'),
    credentialPath: sessionCredentialPath(mamaRoot),
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
  mkdirSync(paths.downloadsDir, { recursive: true, mode: 0o700 });
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
        stimulusFailed(logger, 'owner_message', input.id, error);
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
  let viewer: ViewerServer | null = null;
  let connectors: ConnectorRuntime | undefined;
  let gateway: DaemonGateway | null = null;
  let reportScheduler: ReportScheduler | undefined;
  let stopped = false;
  let deliveryReady = options.mode === 'replay';
  const startedAt = Date.now();
  let currentStage = 'config';

  const stopResources = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const errors: unknown[] = [];
    if (reportScheduler)
      await stopOne(logger, 'report_scheduler', () => reportScheduler!.stop(), errors);
    if (connectors) await stopOne(logger, 'connectors', () => connectors!.stop(), errors);
    if (viewer) await stopOne(logger, 'viewer', () => viewer!.stop(), errors);
    if (owner) await stopOne(logger, 'owner_runtime', () => owner!.stop(), errors);
    // The owner drains active result writers before their delivery port closes.
    if (gateway) await stopOne(logger, 'telegram', () => gateway!.stop(), errors);
    if (errors.length > 0) throw new AggregateError(errors, 'Daemon shutdown failed');
  };

  try {
    currentStage = 'config';
    stage(logger, 'config');
    config = options.config ?? loadConfig({ path: configPath, home: options.home });
    // launchd may have created the redirected log already; preserve its contents and tighten it.
    mkdirSync(dirname(config.logging.file), { recursive: true });
    const logDescriptor = openSync(config.logging.file, 'a', 0o600);
    try {
      fchmodSync(logDescriptor, 0o600);
    } finally {
      closeSync(logDescriptor);
    }
    declareModelCache();
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
    const deliverSourceResponse = async (
      row: MailboxRow,
      result: NativeTurnResult
    ): Promise<void> => {
      // Queue before sending: a delivery failure must not leave the board stale.
      const boardId = `delta-board:${row.stimulusId}`;
      const receipt = owner!.intake.acceptNativeEvent({
        id: boardId,
        channelKey: row.channelKey,
        occurredAt: row.occurredAt,
        payload: {
          text: [
            'Reconcile the board after the source delta turn.',
            'Read current work with work.list and the current board with report.read; read source context as needed.',
            'Write all four slots from current work so the board and the work ledger show the same state.',
            ...buildBoardPublishLines(),
            'Owner-facing text carries no commitment, observation, judgment or channel ids.',
            'Finish with [ack]. Do not use [notify].',
          ].join('\n'),
          sourceStimulusId: row.stimulusId,
          refs: row.refs.map((ref) => ({ ...ref })),
        },
      });
      stimulusAccepted(logger, 'native_event', boardId, receipt);

      const text = result.response.trim();
      const tagIndex = Math.max(text.lastIndexOf('[notify]'), text.lastIndexOf('[ack]'));
      const routed = tagIndex >= 0 ? text.slice(tagIndex) : '';
      const route = routed.startsWith('[notify]')
        ? 'notify'
        : routed.startsWith('[ack]')
          ? 'ack'
          : 'untagged';
      logger.info(`delta report route=${route} id=${row.stimulusId}`);
      if (route !== 'notify') return;
      const content = routed.slice('[notify]'.length).trim();
      if (!content) return;
      if (gateway === null) throw new Error('Telegram gateway is not available for a delta report');
      await gateway.sendToOwner(content, row.stimulusId);
    };
    const ownerFactory = dependencies.createOwnerRuntime ?? createOwnerRuntime;
    owner = await ownerFactory({
      backend: config.agent.backend,
      model: config.agent.model,
      databasePath: config.database.path,
      socketPath: paths.socketPath,
      credentialPath: paths.credentialPath,
      runtimeRoot: paths.mamaRoot,
      replayKeyFile: config.jev?.keyFile,
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
      attachmentPorts: {
        downloadsDir: paths.downloadsDir,
        connectors: () => connectors?.registry ?? null,
        telegram: () => gateway,
      },
      ...(config.wiki?.enabled
        ? {
            wiki: {
              enabled: true,
              vaultPath: config.wiki.vaultPath!,
              wikiDir: config.wiki.wikiDir!,
            },
          }
        : {}),
      ownerPolicyProvider,
      deliveryReady: () => deliveryReady,
      recentDeliveredOwnerMessages: () => gateway?.recentDeliveredMessageRefs() ?? [],
      ...(options.mode === 'replay'
        ? {}
        : {
            onOwnerResult: deliverOwnerResponse,
            onStimulusUncertain: async (row) => {
              if (row.kind !== 'owner_message') return;
              if (!gateway)
                throw new Error(
                  'Telegram gateway is not available for an interrupted owner response'
                );
              await gateway.recoverPendingResponses();
            },
            onSourceResult: deliverSourceResponse,
            onScheduledResult: async (row, result) => {
              if (!reportScheduler)
                throw new Error('Report scheduler is not available for a scheduled result');
              await reportScheduler.onResult(row, result);
            },
          }),
      onStimulusDelivered: (row, modelRunId) => stimulusDelivered(logger, row, modelRunId),
      onStimulusFailed: (row, reason, modelRunId) =>
        stimulusFailed(logger, row.kind ?? 'unknown', row.stimulusId, reason, modelRunId),
    });
    stage(logger, 'owner_runtime');

    currentStage = 'viewer';
    const viewerFactory = dependencies.createViewerServer ?? createDefaultViewerServer;
    viewer = viewerFactory({
      dispatch: owner.surface.dispatch,
      ownerAccess: owner.surface.ownerAccess,
      reportStore: owner.reportStore,
      reportSseClients: owner.reportSseClients,
      wikiRoot: owner.wikiRoot,
      logPath: config.logging.file,
      securityEvents: {
        path: join(paths.mamaRoot, 'logs', 'security-events.jsonl'),
        replay: options.mode === 'replay',
        sendToOwner: async (text, key) => {
          if (!gateway) throw new Error('Telegram gateway is not available for a security alert');
          await gateway.sendToOwner(text, key);
        },
      },
      getMemoryStats: () => readViewerMemoryStats(owner!.database.adapter),
      getRuntimeStatus: () => ({
        running: true,
        version: resolvePackageVersion(),
        backend: config.agent.backend,
        model: config.agent.model,
        startedAt,
        health: null,
        connectors: (connectors?.enabledConnectorNames ?? []).map((name) => ({
          name,
          enabled: true,
          state: connectors?.registry.get(name) ? ('connected' as const) : ('unknown' as const),
        })),
      }),
      getConnectorStatus: async (): Promise<ViewerConnectorStatus[]> => {
        if (!connectors) return [];
        const connectorRuntime = connectors;
        const health = await connectorRuntime.registry.healthCheckAll();
        return connectorRuntime.enabledConnectorNames.map((name) => {
          const current = health[name];
          return {
            name,
            enabled: true,
            healthy: current?.healthy === true,
            lastPoll: current?.lastPollTime?.toISOString() ?? null,
            channelCount: connectorRuntime.channelCounts[name] ?? null,
          };
        });
      },
    });
    await viewer.start();
    logger.info(`viewer server listening on port=${String(viewer.port)}`);
    stage(logger, 'viewer');

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
        viewer,
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
        stimulusFailed(logger, 'source_delta', id, error);
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
      const token = process.env.MAMA_TELEGRAM_TOKEN;
      if (!token?.trim())
        throw new Error(
          'MAMA_TELEGRAM_TOKEN is required; run mama secret set MAMA_TELEGRAM_TOKEN and restart through ~/.mama/start.sh'
        );
      const telegramFactory =
        dependencies.createTelegramGateway ??
        ((gatewayOptions) => new TelegramGateway(gatewayOptions));
      gateway = telegramFactory({
        token,
        intake: loggedOwnerIntake(owner.intake, logger),
        config: {
          enabled: config.telegram.enabled,
          allowedChats: config.telegram.allowed_chats,
          ownerUserIds: config.telegram.owner_user_ids,
          ownerChatId: config.telegram.owner_chat_id,
          polling: config.telegram.polling,
        },
        messageLedgerPath: paths.telegramLedgerPath,
        log: (line) => logger.info(line),
        onFatalError: (error) => {
          logger.error(`telegram fatal polling error=${stimulusFailureReason(error)}`);
          process.exit(1);
        },
        filesRoot: join(paths.workspaceDir, 'files'),
        downloadsDir: paths.downloadsDir,
      });
      await gateway.start();
      stage(logger, 'telegram');
      currentStage = 'report_scheduler';
      const schedulerFactory = dependencies.createReportScheduler ?? createReportScheduler;
      reportScheduler = schedulerFactory({
        config: config.reports,
        statePath: join(paths.runtimeRoot, 'report-schedule-state.json'),
        intake: {
          acceptScheduled: (input) => {
            const receipt = owner!.intake.acceptScheduled(input);
            stimulusAccepted(logger, 'scheduled', input.id, receipt);
            return receipt;
          },
        },
        // Mailbox state also covers a queued input restored at boot and a failure
        // before native dispatch that the runtime will retry itself. Accepted
        // failures park uncertain; R5 retries those as a new scheduled turn.
        hasPendingReport: () =>
          Boolean(
            owner!.database.adapter
              .prepare(
                `
          SELECT 1 FROM mailbox_inputs m
          LEFT JOIN native_input_deliveries n ON n.input_id = m.id
          WHERE m.principal_id = ? AND m.kind = 'scheduled'
            AND m.status IN ('pending', 'claimed')
            AND (n.state IS NULL OR n.state != 'uncertain') LIMIT 1
        `
              )
              .get(OWNER_PRINCIPAL_ID)
          ),
        sendToOwner: (text, key) => gateway!.sendToOwner(text, key),
        onError: (error) =>
          logger.error(`report scheduler failed reason=${stimulusFailureReason(error)}`),
      });
      reportScheduler.start();
      stage(logger, 'report_scheduler');
    } else {
      stage(logger, 'telegram:disabled');
    }
    deliveryReady = true;

    return {
      config,
      paths,
      owner,
      viewer,
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

function launchdService(command: 'print' | 'bootout') {
  const result = spawnSync('launchctl', [command, `gui/${process.getuid!()}/com.mama.server`], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  // launchctl print exits 113 when this user's service is not registered.
  if (result.status !== 0 && !(command === 'print' && result.status === 113)) {
    throw Object.assign(new Error(`launchctl ${command} failed`), {
      code: `LAUNCHCTL_${result.status ?? result.signal ?? 'UNKNOWN'}`,
    });
  }
  return result;
}

export function daemonStatus(): 'running' | 'stopped' {
  const result = launchdService('print');
  return result.status === 0 && /^\s*state = running\s*$/m.test(result.stdout)
    ? 'running'
    : 'stopped';
}

export function requestDaemonStop(): void {
  launchdService('bootout');
}
