import { mkdirSync } from 'node:fs';

import {
  createNativeSessionRunner,
  type NativeModelRunPort,
  type NativeSessionRunner,
  type NativeTurnRequest,
  type NativeTurnResult,
  type NativeSessionHost,
} from '@jungjaehoon/mama-core/runtime/native-turn';
import { CodexRuntimeProcess } from '@jungjaehoon/mama-core/runtime/runtime-process';
import { PersistentCLIAdapter } from '@jungjaehoon/mama-core/runtime/drivers/persistent-cli-adapter';
import { getSessionPool, type SessionPool } from '@jungjaehoon/mama-core/runtime/session-pool';
import type {
  BackendType,
  ContentBlock,
  HostExecutionContext,
  HostToolDefinition,
  IModelRunner,
  NativeInputReceipt,
} from '@jungjaehoon/mama-core/runtime/drivers/types';
import type {
  SubagentBridge,
  SubagentBridgeRequest,
} from '@jungjaehoon/mama-core/runtime/runtime-process';
import {
  projectClaudeNativeTools,
  type ClaudeToolRole,
} from '../agent/claude-native-tool-policy.js';
import { ensureMamaMcpConfig } from '../cli/runtime/action-mcp-config.js';
import type { RuntimeBackend, RuntimeEffort, RuntimeSandbox } from './config.js';
import type { ActionSurface } from './action-surface.js';
import type { OwnerPolicyProvider, OwnerPolicySnapshot } from './owner-policy.js';

export const OWNER_RUNTIME_SESSION_KEY = 'owner:runtime';

export interface NativeDriverOptions {
  backend: RuntimeBackend;
  model: string;
  workspaceDir: string;
  cwd: string;
  runtimeRoot: string;
  sandbox: RuntimeSandbox;
  requestTimeout: number;
  effort: RuntimeEffort;
  codexHome?: string;
  pluginDir?: string;
  mcpConfigPath?: string;
  createSubagentBridge: (info: SubagentBridgeRequest) => Promise<SubagentBridge | null>;
}

export interface NativeSessionRequest extends NativeTurnRequest {
  /** Per-turn Claude builtin role; catalog actions remain on the MCP surface. */
  nativeRole?: ClaudeToolRole;
  sourceMessageRef?: string;
  access?: unknown;
  parentModelRunId?: string | null;
  /** Host-stated inclusive source-time ceiling for the current replay turn. */
  replaySourceEndMs?: number;
}

export interface NativeSessionOptions {
  backend: RuntimeBackend;
  model: string;
  workspaceDir: string;
  runtimeRoot: string;
  actionSurface: ActionSurface;
  ownerSystemPrompt?: string;
  ownerPolicyProvider?: OwnerPolicyProvider;
  effort?: RuntimeEffort;
  timeout: number;
  maxTurns: number;
  runTokenBudget?: number;
  codexHome?: string;
  pluginDir?: string;
  codexSandbox?: RuntimeSandbox;
  mcpConfigPath?: string;
  mcpServerPath?: string;
  agent?: IModelRunner;
  createAgent?: (options: NativeDriverOptions) => IModelRunner;
  sessionPool?: SessionPool;
  modelRun?: NativeModelRunPort;
  replaySourceEndMs?: () => number | undefined;
}

export interface NativeSession {
  readonly backend: RuntimeBackend;
  readonly sessionKey: string;
  readonly supportsNativeSubagents: boolean;
  hostToolDefinitions(): HostToolDefinition[];
  isNewThread(sessionKey: string): boolean;
  runTurn(content: ContentBlock[], request?: NativeSessionRequest): Promise<NativeTurnResult>;
  steer(
    content: string,
    target: NativeInputReceipt,
    sessionKey: string
  ): Promise<NativeInputReceipt>;
  stop(): Promise<void>;
}

function actionToolDefinitions(surface: ActionSurface): HostToolDefinition[] {
  return surface.hostToolDefinitions().map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as HostToolDefinition['inputSchema'],
  }));
}

function toolContext(value: HostExecutionContext | null): {
  modelRunId?: string;
  gatewayCallId?: string;
  sourceMessageRef?: string;
  channelId?: string;
  replaySourceEndMs?: number;
} {
  if (!value) return {};
  const context = value as Record<string, unknown>;
  return {
    ...(typeof context.modelRunId === 'string' ? { modelRunId: context.modelRunId } : {}),
    ...(typeof context.gatewayCallId === 'string' ? { gatewayCallId: context.gatewayCallId } : {}),
    ...(typeof context.sourceMessageRef === 'string'
      ? { sourceMessageRef: context.sourceMessageRef }
      : {}),
    ...(typeof context.channelId === 'string' ? { channelId: context.channelId } : {}),
    ...(typeof context.replaySourceEndMs === 'number'
      ? { replaySourceEndMs: context.replaySourceEndMs }
      : {}),
  };
}

function modelToolResult(result: Awaited<ReturnType<ActionSurface['hostToolCall']>>): unknown {
  if (result.status === 'completed') {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    status: result.status,
    error: result.error,
  };
}

function driverOptions(
  options: NativeSessionOptions,
  bridge: NativeDriverOptions['createSubagentBridge']
): NativeDriverOptions {
  return {
    backend: options.backend,
    model: options.model,
    workspaceDir: options.workspaceDir,
    cwd: options.workspaceDir,
    runtimeRoot: options.runtimeRoot,
    sandbox: 'workspace-write',
    requestTimeout: options.timeout,
    effort: options.effort ?? 'medium',
    ...(options.codexHome === undefined ? {} : { codexHome: options.codexHome }),
    ...(options.pluginDir === undefined ? {} : { pluginDir: options.pluginDir }),
    ...(options.mcpConfigPath === undefined ? {} : { mcpConfigPath: options.mcpConfigPath }),
    createSubagentBridge: bridge,
  };
}

function createDriver(
  options: NativeSessionOptions,
  nativeOptions: NativeDriverOptions,
  bridge: NativeDriverOptions['createSubagentBridge']
): IModelRunner {
  if (options.backend === 'codex') {
    return new CodexRuntimeProcess({
      hostRootDir: options.runtimeRoot,
      model: options.model,
      cwd: nativeOptions.cwd,
      sandbox: nativeOptions.sandbox,
      requestTimeout: nativeOptions.requestTimeout,
      codexHome: options.codexHome,
      effort: nativeOptions.effort,
      createSubagentBridge: bridge,
    });
  }

  const mcpConfigPath = options.mcpConfigPath ?? `${options.runtimeRoot}/mama-mcp-config.json`;
  ensureMamaMcpConfig({
    mcpConfigPath,
    ...(options.mcpServerPath === undefined ? {} : { serverPath: options.mcpServerPath }),
    mamaHome: options.runtimeRoot,
  });
  return new PersistentCLIAdapter({
    workspaceDir: options.workspaceDir,
    model: options.model,
    mcpConfigPath,
    dangerouslySkipPermissions: true,
    pluginDir: nativeOptions.pluginDir,
    requestTimeout: nativeOptions.requestTimeout,
    effort: nativeOptions.effort as 'low' | 'medium' | 'high' | 'max',
  });
}

/** Build one persistent owner session over the shared core native turn runner. */
export function createNativeSession(options: NativeSessionOptions): NativeSession {
  if (options.agent && options.createAgent) {
    throw new Error('Native session accepts an agent or a driver factory, not both');
  }
  if (
    options.backend === 'codex' &&
    options.codexSandbox !== undefined &&
    options.codexSandbox !== 'workspace-write'
  ) {
    throw new Error('The owner Codex session requires the workspace-write sandbox');
  }
  mkdirSync(options.workspaceDir, { recursive: true });
  const tools = actionToolDefinitions(options.actionSurface);
  const runnerRef: { current?: NativeSessionRunner<HostExecutionContext> } = {};
  const bridge: NativeDriverOptions['createSubagentBridge'] = (info) =>
    runnerRef.current?.createSubagentBridge(info) ?? Promise.resolve(null);
  const configuredMcpOptions =
    options.backend === 'claude' &&
    (options.mcpConfigPath !== undefined || options.mcpServerPath !== undefined)
      ? {
          ...options,
          mcpConfigPath: options.mcpConfigPath ?? `${options.runtimeRoot}/mama-mcp-config.json`,
        }
      : options;
  if (
    configuredMcpOptions.backend === 'claude' &&
    configuredMcpOptions.mcpConfigPath !== undefined
  ) {
    ensureMamaMcpConfig({
      mcpConfigPath: configuredMcpOptions.mcpConfigPath,
      ...(configuredMcpOptions.mcpServerPath === undefined
        ? {}
        : { serverPath: configuredMcpOptions.mcpServerPath }),
      mamaHome: configuredMcpOptions.runtimeRoot,
    });
  }
  const nativeOptions = driverOptions(configuredMcpOptions, bridge);
  const agent =
    configuredMcpOptions.agent ??
    configuredMcpOptions.createAgent?.(nativeOptions) ??
    createDriver(configuredMcpOptions, nativeOptions, bridge);
  const sessionPool = options.sessionPool ?? getSessionPool();
  const standingPrompt = options.ownerSystemPrompt ?? '';
  const ownerPolicyProvider = options.ownerPolicyProvider;
  const emptyOwnerPolicy: OwnerPolicySnapshot = {
    content: null,
    fingerprint: '',
    loaded: false,
  };
  const defaultRole: ClaudeToolRole = { allowedTools: ['*'] };

  const host: NativeSessionHost<HostExecutionContext> = {
    agent,
    backend: options.backend as BackendType,
    model: options.model,
    maxTurns: options.maxTurns,
    isGatewayMode: options.backend === 'codex',
    runTokenBudget: options.runTokenBudget ?? 0,
    sessionPool,
    useLanes: false,
    turnPolicy: (request) => {
      const current = request as NativeSessionRequest | undefined;
      const systemPrompt = current?.systemPrompt ?? standingPrompt;
      const ownerPolicy = ownerPolicyProvider?.() ?? emptyOwnerPolicy;
      const role = current?.nativeRole ?? defaultRole;
      const nativeTools = options.backend === 'claude' ? projectClaudeNativeTools(role) : undefined;
      const systemLayers = [
        ...(systemPrompt ? [{ name: 'owner-standing', content: systemPrompt, priority: 1 }] : []),
        ...(ownerPolicy.content
          ? [{ name: 'owner-policy', content: ownerPolicy.content, priority: 2 }]
          : []),
      ];
      const buildSystemLayers = async () => {
        const currentOwnerPolicy = ownerPolicyProvider?.() ?? emptyOwnerPolicy;
        return [
          ...(systemPrompt ? [{ name: 'owner-standing', content: systemPrompt, priority: 1 }] : []),
          ...(currentOwnerPolicy.content
            ? [{ name: 'owner-policy', content: currentOwnerPolicy.content, priority: 2 }]
            : []),
        ];
      };
      return {
        channelKey: current?.sessionKey ?? OWNER_RUNTIME_SESSION_KEY,
        systemLayers,
        reanchorLayers: buildSystemLayers,
        resumeLayers: buildSystemLayers,
        sessionPolicyFingerprint: JSON.stringify({
          backend: options.backend,
          model: options.model,
          nativeTools: nativeTools ?? null,
          systemPrompt,
          ownerPolicyFingerprint: ownerPolicy.fingerprint,
        }),
        ...(options.backend === 'codex' ? { nativeCwd: options.workspaceDir } : {}),
        ...(nativeTools === undefined ? {} : { nativeTools }),
        standingPolicy: true,
      };
    },
    executionContext: (request) => {
      const current = request as NativeSessionRequest | undefined;
      const replaySourceEndMs = current?.replaySourceEndMs ?? options.replaySourceEndMs?.();
      return {
        ...(typeof current?.modelRunId === 'string' ? { modelRunId: current.modelRunId } : {}),
        ...(typeof current?.sourceMessageRef === 'string'
          ? { sourceMessageRef: current.sourceMessageRef }
          : {}),
        channelId: current?.channelId ?? current?.sessionKey ?? OWNER_RUNTIME_SESSION_KEY,
        agentId: options.actionSurface.ownerAccess.agentId,
        ...(replaySourceEndMs === undefined ? {} : { replaySourceEndMs }),
      };
    },
    hostToolDefinitions: () => tools,
    ...(options.modelRun === undefined ? {} : { modelRun: options.modelRun }),
    callTool: async (name, input, context) => {
      const facts = toolContext(context);
      if (!facts.gatewayCallId) {
        throw new Error('Native action call is missing its tool-call identity');
      }
      return modelToolResult(
        await options.actionSurface.hostToolCall(name, input, facts.gatewayCallId, {
          session: {
            ...(facts.modelRunId === undefined ? {} : { modelRunId: facts.modelRunId }),
            gatewayCallId: facts.gatewayCallId,
            ...(facts.sourceMessageRef === undefined
              ? {}
              : { sourceMessageRef: facts.sourceMessageRef }),
            ...(facts.channelId === undefined ? {} : { channelId: facts.channelId }),
            ...(facts.replaySourceEndMs === undefined
              ? {}
              : { replaySourceEndMs: facts.replaySourceEndMs }),
          },
        })
      );
    },
  };

  runnerRef.current = createNativeSessionRunner(host);
  return {
    backend: options.backend,
    sessionKey: OWNER_RUNTIME_SESSION_KEY,
    supportsNativeSubagents: agent.supportsNativeSubagents === true,
    hostToolDefinitions: () => [...tools],
    isNewThread: (sessionKey) => runnerRef.current!.isNewThread({ sessionKey }),
    runTurn: (content, request) => {
      const nativeRequest = {
        ...(request ?? {}),
        sessionKey: request?.sessionKey ?? OWNER_RUNTIME_SESSION_KEY,
        access: options.actionSurface.ownerAccess,
        prepareAccess: request?.prepareAccess ?? (async () => options.actionSurface.ownerAccess),
      } as NativeTurnRequest;
      return runnerRef.current!.runTurn(content, nativeRequest);
    },
    steer: (content, target, sessionKey) => runnerRef.current!.steer(content, target, sessionKey),
    stop: () => runnerRef.current!.stop(),
  };
}

export type { ContentBlock, NativeTurnResult };
