import {
  appendOperationToolTrace,
  appendToolTrace,
  coreActionRegistrations,
  createCatalog,
  createDispatcher,
  type ActionContext,
  type ActionContract,
  type ActionDispatcher,
} from '@jungjaehoon/mama-core';
import type { ServerResponse } from 'node:http';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import type { JudgmentAccess, Knowledge } from '@jungjaehoon/mama-core/knowledge';
import type { MemoryScopeRef } from '@jungjaehoon/mama-core/memory/types';
import { reportActionRegistrations } from '../api/report-actions.js';
import { createReportPublisher, type ReportStore } from '../api/report-handler.js';
import { sourceActionRegistrations } from '../api/source-actions.js';
import { minimalWorkActionRegistrations } from '../api/work-actions.js';
import type { StoredSourceReader } from '../api/stored-source-reader.js';
import { wikiActionRegistrations, type WikiPorts } from '../api/wiki-actions.js';
import type { BoardSlots } from '../operator/board-read-views.js';

const OWNER_ACTIONS = [
  'graph.query',
  'source.search',
  'source.read',
  'memory.checkpoint.list',
  'work.create',
  'work.revise',
  'work.list',
  'work.show',
  'memory.save',
  'memory.search',
  'report.read',
  'report.publish',
  'manage.wiki.publish',
  'manage.wiki.read',
] as const;

const OWNER_CONNECTORS = ['chatwork', 'slack', 'trello', 'kagemusha'] as const;

export interface HostToolDefinition {
  name: string;
  description: string;
  inputSchema: ActionContract['inputSchema'];
}

export interface ActionSurfaceOptions {
  adapter: DatabaseInstance;
  knowledge: Knowledge;
  ownerPrincipalId: string;
  agentId: string;
  scopes?: readonly MemoryScopeRef[];
  connectors?: readonly string[];
  storedSourceReader?: StoredSourceReader | null;
  reportStore?: ReportStore | null;
  reportSseClients?: Set<ServerResponse>;
  wikiPorts?: WikiPorts;
}

export interface ActionSurface {
  catalog: ReturnType<typeof createCatalog>;
  dispatch: ActionDispatcher;
  ownerAccess: JudgmentAccess;
  hostToolDefinitions(): HostToolDefinition[];
  hostToolCall(
    name: string,
    input: unknown,
    operationId: string,
    context?: Omit<ActionContext, 'access' | 'operationId'>
  ): Promise<Awaited<ReturnType<ActionDispatcher>>>;
}

/** The owner grant spans the durable global/user records and connector roots. */
export function ownerMemoryScopes(
  ownerPrincipalId: string,
  connectors: readonly string[] = OWNER_CONNECTORS
): MemoryScopeRef[] {
  const scopes: MemoryScopeRef[] = [
    { kind: 'global', id: 'system' },
    { kind: 'user', id: ownerPrincipalId },
  ];
  for (const connector of connectors) {
    scopes.push({ kind: 'channel', id: connector }, { kind: 'project', id: connector });
  }
  return [...new Map(scopes.map((scope) => [`${scope.kind}\0${scope.id}`, scope])).values()];
}

function traceSummary(value: unknown): string | null {
  if (value === undefined) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? String(value);
  } catch {
    serialized = String(value);
  }
  return serialized.length <= 4_000 ? serialized : `${serialized.slice(0, 3_997)}...`;
}

export function createActionSurface(options: ActionSurfaceOptions): ActionSurface {
  const core = coreActionRegistrations(options.knowledge, options.adapter).filter(({ contract }) =>
    [
      'graph.query',
      'memory.save',
      'memory.search',
      'memory.checkpoint.list',
      'work.list',
      'work.show',
    ].includes(contract.name)
  );
  const reportSseClients = options.reportSseClients ?? new Set<ServerResponse>();
  const reportPorts =
    options.reportStore === undefined || options.reportStore === null
      ? {}
      : {
          publisher: createReportPublisher(options.reportStore, reportSseClients),
          reader: (): BoardSlots => {
            const slots: BoardSlots = {};
            for (const [name, slot] of Object.entries(options.reportStore!.getAll())) {
              slots[name] = {
                html: slot.html,
                basisRevision: slot.basisRevision,
                currentBasisRevision: slot.currentBasisRevision,
                freshness: slot.freshness,
                publishable: options.reportStore!.isPublishable(name),
                updatedAt: Number.isFinite(slot.updatedAt)
                  ? new Date(slot.updatedAt).toISOString()
                  : null,
              };
            }
            return slots;
          },
        };
  const registrations = [
    ...core,
    ...sourceActionRegistrations({ stored: options.storedSourceReader }),
    ...minimalWorkActionRegistrations({ knowledge: options.knowledge }),
    ...reportActionRegistrations(reportPorts),
    ...wikiActionRegistrations(options.wikiPorts ?? {}),
  ];
  const catalog = createCatalog(registrations);
  const dispatch = createDispatcher(catalog, {
    observeCall: async ({ action, operationId, input, result, durationMs, context }) => {
      const session = context.session;
      const common = {
        tool_name: action,
        gateway_call_id: session?.gatewayCallId ?? null,
        input_summary: traceSummary(input),
        output_summary: traceSummary(result),
        execution_status: result.status,
        duration_ms: durationMs,
        ...(result.status === 'failed' ? { failure_code: result.error.code } : {}),
      };
      if (session?.modelRunId) {
        const trace = await appendToolTrace(options.adapter, {
          ...common,
          model_run_id: session.modelRunId,
        });
        return trace.trace_id;
      }
      if (!operationId) return undefined;
      const trace = appendOperationToolTrace(options.adapter, {
        ...common,
        operation_id: operationId,
        actor_principal_id: context.access.principalId,
      });
      return trace.trace_id;
    },
  });
  const ownerAccess: JudgmentAccess = {
    principalId: options.ownerPrincipalId,
    agentId: options.agentId,
    scopes: [
      ...ownerMemoryScopes(options.ownerPrincipalId, options.connectors ?? OWNER_CONNECTORS),
      ...(options.scopes ?? []),
    ].filter(
      (scope, index, all) =>
        all.findIndex((candidate) => candidate.kind === scope.kind && candidate.id === scope.id) ===
        index
    ),
    connectors: options.connectors ?? OWNER_CONNECTORS,
    actions: [...OWNER_ACTIONS],
  };

  return {
    catalog,
    dispatch,
    ownerAccess,
    hostToolDefinitions: () =>
      catalog.list().map((contract) => ({
        name: contract.name,
        description: contract.summary,
        inputSchema: contract.inputSchema,
      })),
    hostToolCall: (name, input, operationId, context = {}) =>
      dispatch(
        { action: name, input, operationId },
        { ...context, access: ownerAccess, operationId }
      ),
  };
}

export { OWNER_ACTIONS, OWNER_CONNECTORS };
