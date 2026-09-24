import {
  coreActionRegistrations,
  createCatalog,
  createDispatcher,
  type ActionContext,
  type ActionContract,
  type ActionDispatcher,
} from '@jungjaehoon/mama-core';
import type { DatabaseInstance } from '@jungjaehoon/mama-core/db-manager';
import type { JudgmentAccess, Knowledge } from '@jungjaehoon/mama-core/knowledge';
import type { MemoryScopeRef } from '@jungjaehoon/mama-core/memory/types';
import { sourceActionRegistrations } from '../api/source-actions.js';
import { minimalWorkActionRegistrations } from '../api/work-actions.js';
import type { StoredSourceReader } from '../api/stored-source-reader.js';

const OWNER_ACTIONS = [
  'source.search',
  'source.read',
  'work.create',
  'work.revise',
  'work.list',
  'memory.save',
  'memory.search',
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

export function createActionSurface(options: ActionSurfaceOptions): ActionSurface {
  const core = coreActionRegistrations(options.knowledge, options.adapter).filter(({ contract }) =>
    ['memory.save', 'memory.search', 'work.list'].includes(contract.name)
  );
  const registrations = [
    ...core,
    ...sourceActionRegistrations({ stored: options.storedSourceReader }),
    ...minimalWorkActionRegistrations({ knowledge: options.knowledge }),
  ];
  const catalog = createCatalog(registrations);
  const dispatch = createDispatcher(catalog);
  const ownerAccess: JudgmentAccess = {
    principalId: options.ownerPrincipalId,
    agentId: options.agentId,
    scopes: options.scopes ?? [],
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
