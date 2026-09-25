import {
  beginModelRun,
  commitModelRun,
  createKnowledge,
  failModelRun,
  generateEmbedding,
  startRuntime,
  type Knowledge,
  type KnowledgeOptions,
  type RuntimeHandle,
  type JudgmentAccess,
  type MemoryScopeRef,
} from '@jungjaehoon/mama-core';
import { join, isAbsolute } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { NativeSessionHandle } from '@jungjaehoon/mama-core/runtime/runtime';
import type { NativeModelRunPort } from '@jungjaehoon/mama-core/runtime/native-turn';
import { createStoredSourceReader } from '../api/stored-source-reader.js';
import { createPersistentReportStore } from '../api/report-persistence.js';
import type { WikiPage } from '../wiki/types.js';
import { ObsidianWriter } from '../wiki/obsidian-writer.js';
import { RawStore } from '../storage/source-archive.js';
import type { RuntimeBackend, RuntimeEffort, RuntimeSandbox } from './config.js';
import { openCoreDatabase, type CoreDatabase } from './core-db.js';
import { createActionSurface, type ActionSurface } from './action-surface.js';
import { createNativeSession } from './native-session.js';
import { ownerSystemPrompt } from './owner-system-prompt.js';
import { createOwnerPolicyProvider, type OwnerPolicyProvider } from './owner-policy.js';
import {
  createStimulusDelivery,
  createStimulusIntake,
  type ReplayClockDelivery,
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
  workspaceDir: string;
  ownerPrincipalId: string;
  agentId: string;
  scopes: readonly MemoryScopeRef[];
  connectors?: readonly string[];
  rawPath?: string;
  embedder?: KnowledgeOptions['embedder'];
  nativeSession?: NativeSessionHandle;
  modelRun?: NativeModelRunPort;
  effort?: RuntimeEffort;
  timeout: number;
  runTokenBudget?: number;
  codexHome?: string;
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
  ownerPolicyProvider?: OwnerPolicyProvider;
  onOwnerResult?: StimulusDeliveryOptions['onOwnerResult'];
  onSourceResult?: StimulusDeliveryOptions['onSourceResult'];
  onScheduledNoop?: StimulusDeliveryOptions['onScheduledNoop'];
  onNativeEventResult?: StimulusDeliveryOptions['onNativeEventResult'];
  onStimulusDelivered?: StimulusDeliveryOptions['onDelivered'];
  onStimulusFailed?: StimulusDeliveryOptions['onFailed'];
  maxTurns: number;
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
  /** Set the ceiling for the next serialized replay turn; delivery clears it when done. */
  readonly setReplaySourceEndMs: (value: number | undefined) => void;
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

/** Assemble the one owner database, catalog, native session and mailbox runtime. */
export async function createOwnerRuntime(options: OwnerRuntimeOptions): Promise<OwnerRuntime> {
  const database = await openCoreDatabase({ path: options.databasePath });
  let rawStore: RawStore | undefined;
  let nativeSession: NativeSessionHandle | undefined = options.nativeSession;
  let delivery: ReplayClockDelivery | undefined;
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
              const publishedPages: WikiPage[] = [];
              for (const page of pages) {
                const path = writer.writePage(page);
                publishedPages.push({ ...page, path });
              }
              writer.updateIndexIncrementally(publishedPages);
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
      reportStore,
      reportSseClients,
      wikiPorts,
    });
    const access: JudgmentAccess = surface.ownerAccess;
    const standingText = ownerSystemPrompt(options.backend);
    const ownerPolicyProvider =
      options.ownerPolicyProvider ?? createOwnerPolicyProvider(options.runtimeRoot);
    if (nativeSession === undefined) {
      nativeSession = createNativeSession({
        backend: options.backend,
        model: options.model,
        workspaceDir: options.workspaceDir,
        runtimeRoot: options.runtimeRoot,
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
      ...(options.onOwnerResult === undefined ? {} : { onOwnerResult: options.onOwnerResult }),
      ...(options.onSourceResult === undefined ? {} : { onSourceResult: options.onSourceResult }),
      ...(options.onScheduledNoop === undefined
        ? {}
        : { onScheduledNoop: options.onScheduledNoop }),
      ...(options.onNativeEventResult === undefined
        ? {}
        : { onNativeEventResult: options.onNativeEventResult }),
      ...(options.onStimulusDelivered === undefined
        ? {}
        : { onDelivered: options.onStimulusDelivered }),
      ...(options.onStimulusFailed === undefined ? {} : { onFailed: options.onStimulusFailed }),
    });
    const intakeRuntime = await startRuntime({
      paths: { socketPath: options.socketPath },
      catalog: surface.catalog,
      dispatch: surface.dispatch,
      principals: [{ access, credentialPath: options.credentialPath }],
      sessionFacts: () => {
        const ceiling = delivery?.getReplaySourceEndMs();
        return ceiling === undefined ? undefined : { replaySourceEndMs: ceiling };
      },
      mailbox: { adapter: database.adapter },
      nativeSession,
      delivery,
      reclaimStaleSocket: true,
    });
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
      setReplaySourceEndMs: (value) => {
        delivery!.setReplaySourceEndMs(value);
      },
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
