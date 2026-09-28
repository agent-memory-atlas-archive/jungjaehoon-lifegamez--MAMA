import {
  beginModelRun,
  commitModelRun,
  createKnowledge,
  failModelRun,
  generateEmbedding,
  readMemoryRecordsInScopes,
  startRuntime,
  type Knowledge,
  type KnowledgeOptions,
  type RuntimeHandle,
  type JudgmentAccess,
  type MemoryRecord,
  type MemoryScopeRef,
} from '@jungjaehoon/mama-core';
import { join, isAbsolute } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { NativeSessionHandle } from '@jungjaehoon/mama-core/runtime/runtime';
import type { NativeModelRunPort } from '@jungjaehoon/mama-core/runtime/native-turn';
import { createStoredSourceReader } from '../api/stored-source-reader.js';
import { readOpenWorkCandidates, runWorkListView } from '../api/work-actions.js';
import type { AttachmentActionPorts } from '../api/attachment-actions.js';
import { createPersistentReportStore } from '../api/report-persistence.js';
import { ObsidianWriter } from '../wiki/obsidian-writer.js';
import { RawStore } from '../storage/source-archive.js';
import type { RuntimeBackend, RuntimeEffort, RuntimeSandbox } from './config.js';
import { openCoreDatabase, type CoreDatabase } from './core-db.js';
import { createActionSurface, type ActionSurface } from './action-surface.js';
import { createNativeSession, type NativeSession } from './native-session.js';
import type { ActionDispatcher } from '@jungjaehoon/mama-core/api/dispatch';
import type { Mailbox } from '@jungjaehoon/mama-core/runtime/mailbox';
import type { TimeZoneSetting } from './timezone.js';
import { ownerSystemPrompt } from './owner-system-prompt.js';
import { storedSourceFamilies } from '../connectors/framework/stored-index-read.js';
import { createOwnerPolicyProvider, type OwnerPolicyProvider } from './owner-policy.js';
import { readRecentOwnerExchanges } from './recent-owner-exchanges.js';
import {
  createStimulusDelivery,
  createStimulusIntake,
  type ReplayClockDelivery,
  type GuidanceEntry,
  type StimulusDeliveryOptions,
  type StimulusIntake,
} from './stimulus-delivery.js';

export interface OwnerRuntimeOptions {
  backend: RuntimeBackend;
  model: string;
  databasePath: string;
  socketPath: string;
  credentialPath: string;
  runtimeRoot: string;
  timeZone: TimeZoneSetting;
  workspaceDir: string;
  ownerPrincipalId: string;
  agentId: string;
  scopes: readonly MemoryScopeRef[];
  connectors?: readonly string[];
  rawPath?: string;
  embedder?: KnowledgeOptions['embedder'];
  nativeSession?: NativeSessionHandle & Partial<Pick<NativeSession, 'callAction'>>;
  modelRun?: NativeModelRunPort;
  effort?: RuntimeEffort;
  timeout: number;
  runTokenBudget?: number;
  codexHome?: string;
  replayKeyFile?: string;
  codexSandbox?: RuntimeSandbox;
  mcpConfigPath?: string;
  mcpServerPath?: string;
  pluginDir?: string;
  reportPath?: string;
  wiki?: {
    enabled: boolean;
    vaultPath: string;
    wikiDir: string;
  };
  formattingRoutes?: { reports: string; notifications: string };
  ownerPolicyProvider?: OwnerPolicyProvider;
  onOwnerResult?: StimulusDeliveryOptions['onOwnerResult'];
  recentDeliveredOwnerMessages?: () => readonly string[];
  onSourceResult?: StimulusDeliveryOptions['onSourceResult'];
  onScheduledResult?: StimulusDeliveryOptions['onScheduledResult'];
  onNativeEventResult?: StimulusDeliveryOptions['onNativeEventResult'];
  onStimulusDelivered?: StimulusDeliveryOptions['onDelivered'];
  onStimulusFailed?: StimulusDeliveryOptions['onFailed'];
  onStimulusUncertain?: StimulusDeliveryOptions['onUncertain'];
  /** Keep accepted inputs queued while product delivery ports are starting. */
  deliveryReady?: () => boolean;
  maxTurns: number;
  attachmentPorts?: Pick<
    AttachmentActionPorts,
    'connectors' | 'telegram' | 'discord' | 'slack' | 'downloadsDir'
  >;
}

export interface OwnerRuntime {
  readonly runtime: RuntimeHandle;
  readonly database: CoreDatabase;
  readonly knowledge: Knowledge;
  readonly surface: ActionSurface;
  readonly reportStore: ReturnType<typeof createPersistentReportStore>;
  readonly reportSseClients: Set<ServerResponse>;
  readonly wikiRoot: string | null;
  readonly intake: StimulusIntake;
  readonly acceptSourceDelta: StimulusIntake['acceptSourceDelta'];
  stop(): Promise<void>;
}

function runtimeEmbedder(options: OwnerRuntimeOptions): NonNullable<KnowledgeOptions['embedder']> {
  return (
    options.embedder ?? {
      embed: (text, role) => generateEmbedding(text, role),
    }
  );
}

function runtimeModelRun(
  options: OwnerRuntimeOptions,
  adapter: Parameters<typeof beginModelRun>[0]
): NativeModelRunPort {
  return {
    begin: async (request, cliSessionId) => {
      const current = request as
        | (typeof request & {
            sourceMessageRef?: string;
            parentModelRunId?: string | null;
          })
        | undefined;
      const record = beginModelRun(adapter, {
        model_id: options.model,
        model_provider: options.backend,
        agent_id: options.agentId,
        instance_id: current?.channelId ?? null,
        parent_model_run_id: current?.parentModelRunId ?? null,
        input_refs: {
          sessionKey: current?.sessionKey ?? null,
          cliSessionId,
          nativeInputId: current?.nativeInputId ?? null,
          sourceMessageRef: current?.sourceMessageRef ?? null,
        },
      });
      return record.model_run_id;
    },
    commit: async (modelRunId, summary, tokenCount) => {
      commitModelRun(adapter, modelRunId, summary, tokenCount);
    },
    fail: async (modelRunId, summary, tokenCount) => {
      failModelRun(adapter, modelRunId, summary, tokenCount);
    },
  };
}

function isOwnerGuidanceRecord(
  record: MemoryRecord
): record is MemoryRecord & { kind: GuidanceEntry['kind'] } {
  return (
    record.kind === 'lesson' ||
    record.kind === 'preference' ||
    record.kind === 'constraint' ||
    record.kind === 'workflow'
  );
}

/** Assemble the one owner database, catalog, native session and mailbox runtime. */
export async function createOwnerRuntime(options: OwnerRuntimeOptions): Promise<OwnerRuntime> {
  const database = await openCoreDatabase({ path: options.databasePath });
  let rawStore: RawStore | undefined;
  let nativeSession: OwnerRuntimeOptions['nativeSession'] = options.nativeSession;
  let delivery: ReplayClockDelivery | undefined;
  let ownerMailbox: Mailbox | undefined;
  const reportStore = createPersistentReportStore({
    filePath: options.reportPath ?? join(options.runtimeRoot, 'report-slots.json'),
  });
  const reportSseClients = new Set<ServerResponse>();
  let wikiRoot: string | null = null;
  try {
    const knowledge = createKnowledge({
      adapter: database.adapter,
      embedder: runtimeEmbedder(options),
    });
    if (options.rawPath !== undefined) rawStore = new RawStore(options.rawPath);
    const storedSourceReader =
      rawStore === undefined
        ? null
        : createStoredSourceReader({
            adapter: database.adapter,
            ownerPrincipalId: () => options.ownerPrincipalId,
            rawStore: () => rawStore ?? null,
          });
    const wikiPorts = options.wiki?.enabled
      ? (() => {
          if (options.wiki.vaultPath.trim() === '' || options.wiki.wikiDir.trim() === '') {
            throw new Error('Enabled wiki requires vaultPath and wikiDir');
          }
          wikiRoot = isAbsolute(options.wiki.wikiDir)
            ? options.wiki.wikiDir
            : join(options.wiki.vaultPath, options.wiki.wikiDir);
          const writer = new ObsidianWriter(wikiRoot, '.');
          writer.ensureDirectories();
          return {
            vault: { path: writer.getWikiPath(), name: null },
            publisher: (
              pages: Parameters<
                NonNullable<import('../api/wiki-actions.js').WikiPorts['publisher']>
              >[0]
            ) => {
              const versioned = pages.some((page) => page.expectedContentVersion !== undefined);
              if (versioned) {
                writer.writePagesAtomically(pages);
                return;
              }
              for (const page of pages) writer.writePage(page);
              // No host-written index: the owner agent keeps the table of contents (Home.md),
              // as in the archive v5 layout; appended "Published" blocks only grew the page.
              writer.appendLog('compile', `Published ${pages.length} pages`);
            },
          };
        })()
      : {};
    const surface = createActionSurface({
      adapter: database.adapter,
      knowledge,
      ownerPrincipalId: options.ownerPrincipalId,
      agentId: options.agentId,
      scopes: options.scopes,
      connectors: options.connectors,
      storedSourceReader,
      timeZone: options.timeZone,
      configPath: join(options.runtimeRoot, 'config.yaml'),
      isOwnerMessageTurn: (sourceMessageRef) =>
        ownerMailbox?.readInput(sourceMessageRef, options.ownerPrincipalId)?.kind ===
        'owner_message',
      reportStore,
      reportSseClients,
      wikiPorts,
      attachmentPorts: {
        ...(options.attachmentPorts ?? {}),
        stored: storedSourceReader,
        workspaceDir: options.workspaceDir,
      },
    });
    const access: JudgmentAccess = surface.ownerAccess;
    const standingText = ownerSystemPrompt(
      options.backend,
      null,
      storedSourceFamilies(database.adapter, access.connectors!),
      options.wiki?.enabled ?? false,
      options.timeZone.get()
    );
    const ownerPolicyProvider =
      options.ownerPolicyProvider ?? createOwnerPolicyProvider(options.runtimeRoot);
    if (nativeSession === undefined) {
      nativeSession = createNativeSession({
        backend: options.backend,
        model: options.model,
        workspaceDir: options.workspaceDir,
        runtimeRoot: options.runtimeRoot,
        replayKeyFile: options.replayKeyFile,
        actionSurface: surface,
        // The standing text is the session's system prompt: sent on a new thread and
        // re-supplied when a durable thread resumes after a restart.
        ownerSystemPrompt: standingText,
        ownerPolicyProvider,
        ...(options.effort === undefined ? {} : { effort: options.effort }),
        timeout: options.timeout,
        maxTurns: options.maxTurns,
        ...(options.runTokenBudget === undefined ? {} : { runTokenBudget: options.runTokenBudget }),
        ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
        ...(options.codexSandbox === undefined ? {} : { codexSandbox: options.codexSandbox }),
        ...(options.mcpConfigPath === undefined ? {} : { mcpConfigPath: options.mcpConfigPath }),
        ...(options.mcpServerPath === undefined ? {} : { mcpServerPath: options.mcpServerPath }),
        ...(options.pluginDir === undefined ? {} : { pluginDir: options.pluginDir }),
        modelRun: options.modelRun ?? runtimeModelRun(options, database.adapter),
        replaySourceEndMs: () => delivery?.getReplaySourceEndMs(),
      });
    }
    delivery = createStimulusDelivery({
      backend: options.backend,
      timeZone: options.timeZone,
      wikiEnabled: options.wiki?.enabled ?? false,
      formattingRoutes: options.formattingRoutes ?? {
        reports: 'telegram',
        notifications: 'telegram',
      },
      readResult: (row) =>
        row.nativeDelivery?.receipt
          ? intakeRuntime.mailbox!.nativeInputs.resultForReceipt(
              row.nativeDelivery.receipt,
              row.principalId
            )
          : null,
      ...(options.onStimulusUncertain === undefined
        ? {}
        : { onUncertain: options.onStimulusUncertain }),
      recentOwnerExchanges: (row) =>
        readRecentOwnerExchanges(
          intakeRuntime.mailbox!,
          options.recentDeliveredOwnerMessages?.() ?? [],
          row
        ),
      guidanceResolver: async () =>
        (
          await readMemoryRecordsInScopes(database.adapter, [...access.scopes], {
            kind: ['lesson', 'preference', 'constraint', 'workflow'],
          })
        ).filter(isOwnerGuidanceRecord),
      openWorkPipeline: async () =>
        runWorkListView(
          { view: 'pipeline' },
          { knowledge, access, timeZone: options.timeZone.get() }
        ),
      openWorkCandidates: async () =>
        readOpenWorkCandidates({
          knowledge,
          adapter: database.adapter,
          access,
          timeZone: options.timeZone.get(),
        }),
      boardSnapshot: async () =>
        Object.fromEntries(
          Object.entries(reportStore.getAll()).map(([slotId, slot]) => [
            slotId,
            {
              html: slot.html,
              updatedAt: slot.updatedAt,
            },
          ])
        ),
      ...(options.onOwnerResult === undefined ? {} : { onOwnerResult: options.onOwnerResult }),
      ...(options.onSourceResult === undefined ? {} : { onSourceResult: options.onSourceResult }),
      ...(options.onScheduledResult === undefined
        ? {}
        : { onScheduledResult: options.onScheduledResult }),
      ...(options.onNativeEventResult === undefined
        ? {}
        : { onNativeEventResult: options.onNativeEventResult }),
      ...(options.onStimulusDelivered === undefined
        ? {}
        : { onDelivered: options.onStimulusDelivered }),
      ...(options.onStimulusFailed === undefined ? {} : { onFailed: options.onStimulusFailed }),
    });
    const socketDispatch: ActionDispatcher = Object.assign(
      async (...[call, context]: Parameters<ActionDispatcher>) => {
        const caller = context.session?.nativeCaller;
        if (caller !== undefined) {
          if (
            options.backend !== 'claude' ||
            context.access.principalId !== options.ownerPrincipalId ||
            !nativeSession?.callAction
          ) {
            throw new Error('Native caller attribution requires the Claude owner session');
          }
          return nativeSession.callAction(call, caller);
        }
        return surface.dispatch(call, context);
      },
      { contracts: surface.dispatch.contracts }
    );
    const intakeRuntime = await startRuntime({
      paths: { socketPath: options.socketPath },
      catalog: surface.catalog,
      dispatch: socketDispatch,
      principals: [{ access, credentialPath: options.credentialPath }],
      sessionFacts: (_access, request) => {
        const ceiling = delivery?.getReplaySourceEndMs();
        return {
          ...(ceiling === undefined ? {} : { replaySourceEndMs: ceiling }),
          ...(request.session?.nativeCaller === undefined
            ? {}
            : { nativeCaller: request.session.nativeCaller }),
        };
      },
      mailbox: { adapter: database.adapter },
      nativeSession,
      delivery: {
        ...delivery,
        ...(options.deliveryReady === undefined ? {} : { ready: options.deliveryReady }),
      },
      reclaimStaleSocket: true,
    });
    ownerMailbox = intakeRuntime.mailbox;
    const intake = createStimulusIntake(intakeRuntime, options.ownerPrincipalId);
    let stopped = false;
    return {
      runtime: intakeRuntime,
      database,
      knowledge,
      surface,
      reportStore,
      reportSseClients,
      wikiRoot,
      intake,
      acceptSourceDelta: intake.acceptSourceDelta,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        await intakeRuntime.stop();
        rawStore?.close();
        await database.close();
      },
    };
  } catch (error) {
    rawStore?.close();
    await database.close();
    throw error;
  }
}
