import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, relative, resolve } from 'node:path';
import type {
  ActionCall,
  ActionContext,
  ActionDispatcher,
  ActionResult,
  WorkGraphPage,
} from '@jungjaehoon/mama-core';
import type { JudgmentAccess } from '@jungjaehoon/mama-core/knowledge';
import { requireViewerAuth } from './auth-middleware.js';
import { logCfAccessConfiguration } from './cf-access.js';
import type { ReportStore } from './report-handler.js';
import {
  listWikiPages,
  readWikiPages,
  WIKI_LIST_MAX_PATHS,
  WIKI_READ_MAX_PAGE_CHARS,
} from '../wiki/wiki-read.js';
import {
  mapArchiveGraphNode,
  shapeArchiveGraph,
  shapeGraphPage,
  shapeMemorySearch,
  shapeOperatorTasksFromItems,
  shapeWorkListDetail,
  shapeWorkListItems,
  type RevisionGraphRead,
  type ViewerEvidence,
  type ArchiveGraphResponse,
  type ViewerMemoryStats,
} from './viewer-data.js';

const GRAPH_KINDS = new Set([
  'memory',
  'case',
  'report',
  'edge',
  'raw',
  'registry',
  'observation',
  'entity',
]);
const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export interface ViewerConnectorStatus {
  name: string;
  enabled: boolean;
  healthy: boolean;
  lastPoll: string | null;
  channelCount: number | null;
}

export interface ViewerRuntimeConnector {
  name: string;
  enabled: boolean;
  state: 'connected' | 'disconnected' | 'unknown';
}

export interface ViewerRuntimeStatus {
  running: boolean;
  version: string;
  backend: string;
  model: string;
  startedAt: number;
  health: { score: number; status: string } | null;
  connectors: ViewerRuntimeConnector[];
}

export interface ViewerServerOptions {
  dispatch: ActionDispatcher;
  ownerAccess: JudgmentAccess;
  reportStore?: ReportStore | null;
  reportSseClients?: Set<ServerResponse>;
  wikiRoot?: string | null;
  port?: number;
  host?: string;
  viewerDirectory?: string;
  getConnectorStatus?: () => ViewerConnectorStatus[] | Promise<ViewerConnectorStatus[]>;
  getRuntimeStatus?: () => ViewerRuntimeStatus | Promise<ViewerRuntimeStatus>;
  getMemoryStats?: () => ViewerMemoryStats | Promise<ViewerMemoryStats>;
  logPath?: string;
}

export interface ViewerServer {
  readonly server: Server | null;
  readonly port: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

class ViewerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ViewerHttpError';
  }
}

function viewerDirectory(): string {
  const moduleDirectory = __dirname;
  const candidates = [
    process.env.MAMA_VIEWER_DIR,
    join(process.cwd(), 'packages', 'standalone', 'public', 'viewer'),
    resolve(moduleDirectory, '../../public/viewer'),
    resolve(moduleDirectory, '../../../public/viewer'),
  ].filter((candidate): candidate is string => typeof candidate === 'string');
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
  }
  throw new Error('Viewer assets are not installed');
}

function resolveApiPort(value: string | undefined): number {
  if (value === undefined) return 3847;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`MAMA_API_PORT must be an integer port between 1024 and 65535, got: ${value}`);
  }
  return port;
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function requestError(error: unknown): { status: number; code: string; message: string } {
  if (error instanceof ViewerHttpError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, code: 'VIEWER_INTERNAL_ERROR', message };
}

function parseLimit(params: URLSearchParams, defaultValue: number, maximum: number): number {
  const raw = params.get('limit');
  if (raw === null) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new ViewerHttpError(
      400,
      'INVALID_LIMIT',
      `limit must be an integer from 1 to ${maximum}`
    );
  }
  return value;
}

function parseKinds(params: URLSearchParams): string[] {
  const raw = params.get('kind');
  if (raw === null || raw.trim() === '') return [];
  const values = [
    ...new Set(
      raw
        .split(',')
        .map((kind) => kind.trim())
        .filter(Boolean)
    ),
  ];
  const unsupported = values.filter((kind) => !GRAPH_KINDS.has(kind));
  if (unsupported.length > 0) {
    throw new ViewerHttpError(
      400,
      'INVALID_GRAPH_KIND',
      `Unsupported graph kind: ${unsupported.join(', ')}`
    );
  }
  return values;
}

function actionFailureStatus(
  result: Extract<ActionResult, { status: 'failed' | 'unknown' }>
): number {
  if (result.error.kind === 'invalid_input') return 400;
  if (result.error.kind === 'denied') return 403;
  if (result.error.kind === 'unknown_action') return 501;
  return 502;
}

function graphRef(value: string): { kind: string; id: string } | null {
  const split = value.indexOf(':');
  if (split < 1 || split === value.length - 1) return null;
  const kind = value.slice(0, split);
  if (!GRAPH_KINDS.has(kind)) return null;
  return { kind, id: value.slice(split + 1) };
}

function notAvailable(): { reason: 'not available in this build' } {
  return { reason: 'not available in this build' };
}

interface WikiTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: WikiTreeNode[];
}

function wikiFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content: raw };
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split('\n')) {
    const separator = line.indexOf(':');
    if (separator > 0) {
      frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
  }
  return { frontmatter, content: match[2] };
}

function addWikiPath(root: WikiTreeNode[], path: string): void {
  const parts = path.split('/');
  let nodes = root;
  let prefix = '';
  parts.forEach((name, index) => {
    prefix = prefix === '' ? name : `${prefix}/${name}`;
    const type = index === parts.length - 1 ? 'file' : 'directory';
    let node = nodes.find((candidate) => candidate.name === name && candidate.type === type);
    if (!node) {
      node = { name, path: prefix, type };
      if (type === 'directory') node.children = [];
      nodes.push(node);
      nodes.sort((left, right) =>
        left.type === right.type
          ? left.name.localeCompare(right.name)
          : left.type === 'directory'
            ? -1
            : 1
      );
    }
    nodes = node.children ?? [];
  });
}

function wikiTree(root: string): WikiTreeNode[] {
  const paths: string[] = [];
  let cursor: string | null = null;
  let version: string | undefined;
  do {
    const page = listWikiPages({
      root,
      ...(cursor === null ? {} : { cursor }),
      ...(version === undefined ? {} : { version }),
      limit: WIKI_LIST_MAX_PATHS,
    });
    paths.push(...page.paths);
    cursor = page.nextCursor;
    version = page.readVersion;
  } while (cursor !== null);
  const tree: WikiTreeNode[] = [];
  for (const path of paths) addWikiPath(tree, path);
  return tree;
}

function wikiPage(root: string, path: string): Record<string, unknown> {
  const result = readWikiPages({
    root,
    paths: [path],
    contentLimit: WIKI_READ_MAX_PAGE_CHARS,
  });
  const page = result.pages[0];
  if (!page || !page.exists || page.content === null) {
    throw new ViewerHttpError(404, 'NOT_FOUND', 'Page not found');
  }
  const parsed = wikiFrontmatter(page.content);
  return {
    path: page.path,
    frontmatter: parsed.frontmatter,
    content: parsed.content,
    raw: page.content,
  };
}

function archiveGraphPage(pages: WorkGraphPage[], nextCursor: string | null): WorkGraphPage {
  const nodes = new Map<string, WorkGraphPage['nodes'][number]>();
  const edges = new Map<string, WorkGraphPage['edges'][number]>();
  const last = pages[pages.length - 1];
  for (const page of pages) {
    for (const node of page.nodes) nodes.set(graphNodeKey(node), node);
    for (const edge of page.edges) edges.set(edge.id, edge);
  }
  if (!last) {
    throw new ViewerHttpError(502, 'GRAPH_QUERY_INVALID', 'graph.query returned no page');
  }
  return {
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    coverage: last.coverage,
    snapshot: last.snapshot,
    nextCursor,
  };
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1_000;

function kstStamp(ms: number): string {
  return `${new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ')} KST`;
}

function edgeLabelSummary(node: WorkGraphPage['nodes'][number]): string {
  if (node.data.kind !== 'memory') return node.label;
  const at = node.data.recordedAt ? kstStamp(node.data.recordedAt) : '';
  return `${at} ${node.data.topic}: ${node.data.summary}`;
}

function graphNodeKey(node: WorkGraphPage['nodes'][number]): string {
  return `${node.ref.kind}:${node.ref.id}`;
}

function memoryNode(page: WorkGraphPage, id: string): WorkGraphPage['nodes'][number] | null {
  return (
    page.nodes.find(
      (node) => node.ref.kind === 'memory' && node.ref.id === id && node.data.kind === 'memory'
    ) ?? null
  );
}

function observationEvidence(
  page: WorkGraphPage,
  revisionRef: { kind: string; id: string }
): Array<{ ref: { kind: string; id: string }; source: string }> {
  const observations = new Map<string, string>();
  for (const node of page.nodes) {
    if (node.ref.kind === 'observation' && node.data.kind === 'observation') {
      observations.set(node.ref.id, node.data.connector);
    }
  }
  const evidence: Array<{ ref: { kind: string; id: string }; source: string }> = [];
  const seen = new Set<string>();
  for (const edge of page.edges) {
    if (
      edge.relation !== 'derived_from' ||
      edge.from.kind !== revisionRef.kind ||
      edge.from.id !== revisionRef.id ||
      edge.to.kind !== 'observation' ||
      seen.has(edge.to.id)
    ) {
      continue;
    }
    const source = observations.get(edge.to.id);
    if (source === undefined) continue;
    seen.add(edge.to.id);
    evidence.push({ ref: edge.to, source });
  }
  return evidence;
}

function sourceReadEvidence(data: unknown, source: string, observationRef: string): ViewerEvidence {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new ViewerHttpError(
      502,
      'SOURCE_READ_INVALID',
      `source.read returned no observation for ${observationRef}`
    );
  }
  const row = data as Record<string, unknown>;
  if (typeof row.content !== 'string') {
    throw new ViewerHttpError(
      502,
      'SOURCE_READ_INVALID',
      `source.read returned no content for ${observationRef}`
    );
  }
  return {
    observationRef,
    source,
    ...(typeof row.channel === 'string' ? { channel: row.channel } : {}),
    sourceAt: typeof row.sourceAt === 'number' ? row.sourceAt : null,
    observedAt: typeof row.observedAt === 'number' ? row.observedAt : null,
    content: row.content,
  };
}

function readLogTail(
  logPath: string | undefined,
  params: URLSearchParams
): Record<string, unknown> {
  const tail = parseLimit(params, 500, 2_000);
  if (logPath === undefined || !existsSync(logPath)) {
    return {
      lines: [],
      total: 0,
      totalBytes: 0,
      fileSize: 0,
      mtime: 0,
      truncated: false,
      ...notAvailable(),
    };
  }
  const metadata = statSync(logPath);
  const source = readFileSync(logPath, 'utf8');
  const allLines = source.split(/\r?\n/).filter((line) => line.length > 0);
  const sinceRaw = params.get('since');
  const since = sinceRaw === null ? 0 : Number(sinceRaw);
  const lines = Number.isFinite(since) && metadata.mtimeMs <= since ? [] : allLines.slice(-tail);
  return {
    lines,
    total: allLines.length,
    totalBytes: metadata.size,
    fileSize: metadata.size,
    mtime: metadata.mtimeMs,
    truncated: allLines.length > lines.length,
  };
}

export function createViewerServer(options: ViewerServerOptions): ViewerServer {
  logCfAccessConfiguration();
  const port = options.port ?? resolveApiPort(process.env.MAMA_API_PORT);
  const host = options.host ?? process.env.MAMA_API_HOST ?? '127.0.0.1';
  const root = options.viewerDirectory ?? viewerDirectory();
  let server: Server | null = null;
  let actualPort = port;
  let stopped = false;
  const reportClients = options.reportSseClients ?? new Set<ServerResponse>();

  const callAction = async (action: string, input: Record<string, unknown>): Promise<unknown> => {
    const operationId = `viewer:${action}:${randomUUID()}`;
    const call: ActionCall = { action, input, operationId };
    const context: ActionContext = { access: options.ownerAccess, operationId };
    const result = await options.dispatch(call, context);
    if (result.status === 'completed') return result.data;
    throw new ViewerHttpError(actionFailureStatus(result), result.error.code, result.error.message);
  };

  const listTasks = async (params: URLSearchParams): Promise<unknown> => {
    const limit = parseLimit(params, 50, 50);
    const status = params.get('status') ?? undefined;
    const sourceChannel = params.get('source_channel') ?? undefined;
    const page = await callAction('work.list', {
      view: 'items',
      limit,
      ...(status === undefined ? {} : { status }),
    });
    const shaped = shapeOperatorTasksFromItems(page, { status: undefined, sourceChannel });
    return {
      tasks: shaped.tasks,
      ...(shaped.nextCursor === null
        ? {}
        : { nextCursor: shaped.nextCursor, coverage: shaped.coverage }),
    };
  };

  const legacyTaskList = async (params: URLSearchParams): Promise<unknown> => {
    const page = await callAction('work.list', {
      view: 'items',
      limit: parseLimit(params, 50, 50),
    });
    return shapeWorkListItems(page);
  };

  const legacyTaskDetail = async (commitmentId: string): Promise<unknown> => {
    if (commitmentId.trim() === '') {
      throw new ViewerHttpError(400, 'INVALID_COMMITMENT_ID', 'commitment id must be nonblank');
    }
    const detail = await callAction('work.list', {
      view: 'detail',
      ids: [commitmentId],
    });
    if (
      detail === null ||
      typeof detail !== 'object' ||
      Array.isArray(detail) ||
      !Array.isArray((detail as { tasks?: unknown }).tasks)
    ) {
      throw new ViewerHttpError(502, 'WORK_DETAIL_INVALID', 'work.list returned no detail tasks');
    }
    const item = (detail as { tasks: unknown[] }).tasks[0];
    if (item === undefined || item === null || typeof item !== 'object' || Array.isArray(item))
      throw new ViewerHttpError(
        404,
        'NOT_FOUND',
        'work.list returned no detail for the commitment'
      );
    const history = (item as { history?: unknown }).history;
    if (!Array.isArray(history))
      throw new ViewerHttpError(
        502,
        'WORK_HISTORY_MISSING',
        'work.list detail returned no revision history'
      );
    const reads = new Map<string, RevisionGraphRead>();
    for (const rawRevision of history) {
      if (
        rawRevision === null ||
        typeof rawRevision !== 'object' ||
        Array.isArray(rawRevision) ||
        (rawRevision as { recordRef?: unknown }).recordRef === undefined
      ) {
        throw new ViewerHttpError(
          502,
          'WORK_HISTORY_INVALID',
          'work.list detail history is invalid'
        );
      }
      const revision = rawRevision as { recordRef: { kind: string; id: string } };
      const detail = (await callAction('graph.query', {
        view: 'detail',
        seeds: [revision.recordRef],
        history: 'all',
      })) as WorkGraphPage;
      const record = memoryNode(detail, revision.recordRef.id);
      if (!record)
        throw new ViewerHttpError(
          502,
          'REVISION_RECORD_MISSING',
          'graph.query returned no revision record'
        );
      const neighbors = (await callAction('graph.query', {
        view: 'neighbors',
        seeds: [revision.recordRef],
        direction: 'out',
        relations: ['derived_from'],
        history: 'all',
        maxDepth: 1,
        limit: 100,
      })) as WorkGraphPage;
      const evidence: ViewerEvidence[] = [];
      for (const candidate of observationEvidence(neighbors, revision.recordRef)) {
        const source = await callAction('source.read', {
          source: candidate.source,
          view: 'stored',
          detail: 'full',
          observationRef: candidate.ref.id,
          content_offset: 0,
          content_limit: 4_000,
        });
        evidence.push(sourceReadEvidence(source, candidate.source, candidate.ref.id));
      }
      reads.set(`${revision.recordRef.kind}:${revision.recordRef.id}`, { record, evidence });
    }
    return shapeWorkListDetail(detail, reads);
  };

  const legacyGraph = async (params: URLSearchParams): Promise<unknown> => {
    const page = (await callAction('graph.query', {
      view: 'browse',
      history: 'all',
      limit: parseLimit(params, 300, 2_000),
      ...(params.get('cursor') === null ? {} : { cursor: params.get('cursor') }),
    })) as WorkGraphPage;
    return {
      graph: shapeGraphPage(page, parseKinds(params)),
      missing: [
        {
          kind: 'revision_chain',
          message:
            'graph.query does not expose revision-to-revision edges; use work.show history all.',
        },
      ],
    };
  };

  const operatorSummary = async (): Promise<unknown> => {
    const page = await callAction('work.list', { view: 'items', limit: 50 });
    const tasks = shapeOperatorTasksFromItems(page).tasks;
    return {
      report: { actionRequired: null },
      tasks: { unconfirmed: tasks.filter((task) => task.auto_created && !task.confirmed).length },
      triggers: { active: null, disabled: null, fired: null, succeeded: null, failed: null },
      reason: 'trigger machinery and report slots are not available in this build',
    };
  };

  const graph = async (params: URLSearchParams): Promise<ArchiveGraphResponse> => {
    const started = Date.now();
    const limit = parseLimit(params, 300, 2_000);
    const history = params.get('history') === 'current' ? 'current' : 'all';
    const pages: WorkGraphPage[] = [];
    const nodes = new Set<string>();
    let cursor: string | null = params.get('cursor');
    let pageCount = 0;
    do {
      const input: Record<string, unknown> = {
        view: 'browse',
        history,
        limit: Math.min(500, Math.max(1, limit - nodes.size)),
      };
      if (cursor !== null) input.cursor = cursor;
      const page = (await callAction('graph.query', input)) as WorkGraphPage;
      pages.push(page);
      for (const node of page.nodes) nodes.add(graphNodeKey(node));
      cursor = page.nextCursor;
      pageCount += 1;
    } while (cursor !== null && nodes.size < limit && pageCount < 20);
    return shapeArchiveGraph(
      archiveGraphPage(pages, cursor),
      Date.now() - started,
      parseKinds(params)
    );
  };

  const graphDetail = async (params: URLSearchParams): Promise<unknown> => {
    const id = params.get('id');
    if (!id) throw new ViewerHttpError(400, 'MISSING_ID', 'Missing required parameter: id');
    const ref = graphRef(id);
    if (!ref) throw new ViewerHttpError(400, 'INVALID_ID', 'id must be a graph reference');
    const page = (await callAction('graph.query', {
      view: 'detail',
      seeds: [ref],
      history: 'all',
    })) as WorkGraphPage;
    const node = page.nodes.find((candidate) => graphNodeKey(candidate) === id);
    if (!node) throw new ViewerHttpError(404, 'NOT_FOUND', 'Decision not found');
    const mapped = mapArchiveGraphNode(node);
    // The graph carries references only; the detail reads what they point at through the
    // same owner actions the agent uses, so a fact's history is readable, not just its ids.
    if (node.data.kind === 'observation') {
      const read = (await callAction('source.read', {
        source: node.data.connector,
        observationRef: node.ref.id,
      })) as { channel?: string; author?: string; sourceAt?: number; content?: string };
      const when = typeof read.sourceAt === 'number' ? kstStamp(read.sourceAt) : '';
      return {
        node: {
          ...mapped,
          topic: read.channel ?? mapped.topic,
          decision: `**${when} · ${read.channel ?? ''} · ${read.author ?? ''}**\n\n${read.content ?? ''}`,
        },
      };
    }
    if (node.data.kind === 'memory') {
      const provenance = (await callAction('memory.read:provenance', {
        memory_id: node.ref.id,
      })) as {
        events?: Array<{ channel: string | null; observedAt: string | null; excerpt: string }>;
      };
      const earlier = page.edges
        .filter(
          (edge) =>
            `${edge.resolvedFrom.kind}:${edge.resolvedFrom.id}` === id &&
            edge.resolvedTo.kind === 'memory'
        )
        .map((edge) =>
          page.nodes.find(
            (candidate) =>
              graphNodeKey(candidate) === `${edge.resolvedTo.kind}:${edge.resolvedTo.id}`
          )
        )
        .filter((candidate) => candidate !== undefined && candidate.data.kind === 'memory')
        .map((candidate) => `- ${edgeLabelSummary(candidate!)}`);
      const evidence = (provenance.events ?? []).map(
        (event) => `- ${event.observedAt ?? ''} ${event.channel ?? ''}: ${event.excerpt}`
      );
      const sections = [
        mapped.reasoning ?? '',
        evidence.length > 0 ? `**Evidence**\n${evidence.join('\n')}` : '',
        earlier.length > 0 ? `**Earlier records**\n${earlier.join('\n')}` : '',
      ].filter((section) => section !== '');
      return { node: { ...mapped, reasoning: sections.join('\n\n') } };
    }
    return { node: mapped };
  };

  const graphSimilar = async (params: URLSearchParams): Promise<unknown> => {
    const id = params.get('id');
    if (!id) throw new ViewerHttpError(400, 'MISSING_ID', 'Missing required parameter: id');
    const ref = graphRef(id);
    if (!ref) throw new ViewerHttpError(400, 'INVALID_ID', 'id must be a graph reference');
    const page = (await callAction('graph.query', {
      view: 'detail',
      seeds: [ref],
      history: 'all',
    })) as WorkGraphPage;
    const node = page.nodes.find((candidate) => graphNodeKey(candidate) === id);
    if (!node || node.data.kind !== 'memory') {
      return { id, similar: [], count: 0, ...notAvailable() };
    }
    const query = `${node.data.topic} ${node.data.summary.slice(0, 400)}`.trim();
    const searched = (await callAction('memory.search', { query, limit: 6 })) as {
      results?: unknown;
    };
    const similar = Array.isArray(searched.results)
      ? searched.results
          .filter((candidate): candidate is Record<string, unknown> => {
            if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
              return false;
            }
            const candidateId = String(candidate.id ?? '');
            return candidateId !== ref.id && candidateId !== id;
          })
          .slice(0, 5)
          .map((candidate) => ({
            id: String(candidate.id ?? ''),
            topic: typeof candidate.topic === 'string' ? candidate.topic : '',
            decision:
              typeof candidate.decision === 'string'
                ? candidate.decision
                : typeof candidate.summary === 'string'
                  ? candidate.summary
                  : '',
            similarity:
              typeof candidate.similarity === 'number'
                ? candidate.similarity
                : typeof candidate.final_score === 'number'
                  ? candidate.final_score
                  : 0,
            outcome: typeof candidate.outcome === 'string' ? candidate.outcome : null,
          }))
      : [];
    return { id, similar, count: similar.length };
  };

  const memorySearch = async (params: URLSearchParams): Promise<unknown> => {
    const query = params.get('q');
    const input: Record<string, unknown> = { limit: parseLimit(params, 20, 200) };
    if (query !== null && query.trim() !== '') input.query = query;
    return shapeMemorySearch(await callAction('memory.search', input));
  };

  const checkpoints = async (): Promise<unknown> => {
    return callAction('memory.checkpoint.list', { limit: 50 });
  };

  const handleReportEvents = (req: IncomingMessage, res: ServerResponse): void => {
    if (!options.reportStore) {
      json(res, 503, { error: true, code: 'NOT_AVAILABLE', message: 'Report store is not wired' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    reportClients.add(res);
    res.write(
      `event: report-update\ndata: ${JSON.stringify({ slots: options.reportStore.getAllSorted() })}\n\n`
    );
    const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      reportClients.delete(res);
    });
  };

  const serveStatic = (pathname: string, req: IncomingMessage, res: ServerResponse): boolean => {
    if (pathname === '/') {
      res.writeHead(302, { Location: '/viewer' });
      res.end();
      return true;
    }
    let filePath: string | null = null;
    if (pathname === '/favicon.ico') {
      filePath = resolve(root, '..', 'favicon.ico');
    } else if (pathname === '/viewer' || pathname === '/viewer/') {
      filePath = resolve(root, 'viewer.html');
    } else if (pathname.startsWith('/viewer/')) {
      filePath = resolve(root, pathname.slice('/viewer/'.length));
    }
    if (filePath === null || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const rel = relative(root, filePath);
    if (pathname === '/favicon.ico') {
      if (relative(resolve(root, '..'), filePath).startsWith('..')) return false;
    } else if (rel.startsWith('..') || rel.includes('..' + '/') || rel.includes('\\')) {
      return false;
    }
    try {
      if (!statSync(filePath).isFile()) return false;
      const content = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
      return true;
    } catch {
      return false;
    }
  };

  const apiPath = (pathname: string): boolean =>
    pathname.startsWith('/api/') ||
    pathname === '/graph' ||
    pathname === '/graph/detail' ||
    pathname === '/graph/similar' ||
    pathname === '/checkpoints' ||
    pathname === '/graph/update';

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const origin = req.headers.origin;
    if (typeof origin === 'string' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === '/health' && req.method === 'GET') {
      json(res, 200, { status: 'ok' });
      return;
    }
    if (apiPath(url.pathname)) {
      if (req.method !== 'GET') {
        json(res, 405, {
          error: true,
          code: 'METHOD_NOT_ALLOWED',
          message: 'read-only viewer: GET is required',
        });
        return;
      }
      if (!(await requireViewerAuth(req, res))) return;

      if (url.pathname === '/api/report/events') {
        handleReportEvents(req, res);
        return;
      }

      let result: unknown;
      if (url.pathname === '/graph' || url.pathname === '/api/graph') {
        result = await graph(url.searchParams);
      } else if (url.pathname === '/graph/detail' || url.pathname === '/api/graph/detail') {
        result = await graphDetail(url.searchParams);
      } else if (url.pathname === '/graph/similar' || url.pathname === '/api/graph/similar') {
        result = await graphSimilar(url.searchParams);
      } else if (url.pathname === '/checkpoints' || url.pathname === '/api/checkpoints') {
        result = await checkpoints();
      } else if (url.pathname === '/api/mama/search') result = await memorySearch(url.searchParams);
      else if (url.pathname === '/api/viewer/tasks')
        result = await legacyTaskList(url.searchParams);
      else if (url.pathname.startsWith('/api/viewer/tasks/')) {
        result = await legacyTaskDetail(
          decodeURIComponent(url.pathname.slice('/api/viewer/tasks/'.length))
        );
      } else if (url.pathname === '/api/viewer/graph') result = await legacyGraph(url.searchParams);
      else if (url.pathname === '/api/viewer/memory/search')
        result = await memorySearch(url.searchParams);
      else if (url.pathname === '/api/operator/tasks') result = await listTasks(url.searchParams);
      else if (url.pathname === '/api/operator/summary') result = await operatorSummary();
      else if (url.pathname === '/api/report') {
        if (!options.reportStore) {
          throw new ViewerHttpError(503, 'NOT_AVAILABLE', 'Report store is not wired');
        }
        result = { slots: options.reportStore.getAllSorted() };
      } else if (url.pathname === '/api/wiki/tree') {
        if (!options.wikiRoot) {
          throw new ViewerHttpError(503, 'NOT_AVAILABLE', 'Wiki root is not configured');
        }
        result = { tree: wikiTree(options.wikiRoot) };
      } else if (url.pathname === '/api/wiki/page') {
        if (!options.wikiRoot) {
          throw new ViewerHttpError(503, 'NOT_AVAILABLE', 'Wiki root is not configured');
        }
        const path = url.searchParams.get('path');
        if (!path) throw new ViewerHttpError(400, 'MISSING_PATH', 'path query param is required');
        result = wikiPage(options.wikiRoot, path);
      } else if (url.pathname === '/api/runtime/status') {
        if (!options.getRuntimeStatus) {
          throw new ViewerHttpError(503, 'NOT_AVAILABLE', 'not available in this build');
        }
        result = await options.getRuntimeStatus();
      } else if (url.pathname === '/api/connectors/status') {
        if (!options.getConnectorStatus) {
          result = { connectors: [], ...notAvailable() };
        } else {
          result = { connectors: await options.getConnectorStatus() };
        }
      } else if (url.pathname === '/api/connectors/activity') {
        result = { connectors: [], ...notAvailable() };
      } else if (url.pathname.startsWith('/api/connectors/') && url.pathname.endsWith('/feed')) {
        const connector = decodeURIComponent(
          url.pathname.slice('/api/connectors/'.length, -'/feed'.length)
        );
        result = { connector, feed: [], itemCount: 0, ...notAvailable() };
      } else if (url.pathname === '/api/metrics/health') {
        result = {
          score: null,
          status: 'unavailable',
          components: [],
          checks: [],
          summary: null,
          ...notAvailable(),
        };
      } else if (url.pathname === '/api/dashboard/status') {
        if (!options.getMemoryStats) {
          throw new ViewerHttpError(
            503,
            'NOT_AVAILABLE',
            'Viewer memory database is not configured'
          );
        }
        result = { memory: await options.getMemoryStats() };
      } else if (url.pathname === '/api/logs/daemon') {
        result = readLogTail(options.logPath, url.searchParams);
      } else if (url.pathname === '/api/cron') {
        result = { jobs: [], ...notAvailable() };
      } else if (url.pathname.startsWith('/api/cron/')) {
        result = { logs: [], ...notAvailable() };
      } else if (url.pathname === '/api/tokens/summary') {
        result = { today: {}, week: {}, month: {}, ...notAvailable() };
      } else if (url.pathname === '/api/tokens/by-agent') {
        result = { agents: [], ...notAvailable() };
      } else if (url.pathname === '/api/tokens/daily') {
        result = { days: [], ...notAvailable() };
      } else if (
        url.pathname === '/api/skills' ||
        url.pathname === '/api/skills/catalog' ||
        url.pathname === '/api/skills/search'
      ) {
        result = { skills: [], ...notAvailable() };
      } else if (url.pathname.startsWith('/api/intelligence/')) {
        const key = url.pathname.slice('/api/intelligence/'.length);
        result =
          key === 'activity'
            ? { activity: [], limit: 0, ...notAvailable() }
            : key === 'summary'
              ? { text: '', generatedAt: null, ...notAvailable() }
              : key === 'projects' || key === 'pipeline'
                ? { [key]: [], ...notAvailable() }
                : key === 'notices'
                  ? { notices: [], ...notAvailable() }
                  : { alerts: [], ...notAvailable() };
      } else {
        throw new ViewerHttpError(404, 'NOT_FOUND', 'Viewer endpoint not found');
      }
      json(res, 200, result);
      return;
    }

    if (serveStatic(url.pathname, req, res)) return;
    json(res, 404, { error: true, code: 'NOT_FOUND', message: 'Not found' });
  };

  return {
    get server() {
      return server;
    },
    get port() {
      return actualPort;
    },
    async start(): Promise<void> {
      if (server !== null) return;
      if (stopped) throw new Error('Viewer server cannot restart after stop');
      const candidate = createServer((req, res) => {
        void handle(req, res).catch((error) => {
          const failure = requestError(error);
          if (!res.headersSent) {
            json(res, failure.status, {
              error: true,
              code: failure.code,
              message: failure.message,
            });
          } else {
            res.end();
          }
        });
      });
      await new Promise<void>((resolveListen, rejectListen) => {
        candidate.once('error', rejectListen);
        candidate.listen({ port, host, exclusive: false }, () => resolveListen());
      });
      server = candidate;
      const address = candidate.address();
      if (!address || typeof address === 'string')
        throw new Error('Viewer server did not expose a port');
      actualPort = address.port;
    },
    async stop(): Promise<void> {
      if (server === null) {
        stopped = true;
        return;
      }
      const current = server;
      server = null;
      stopped = true;
      for (const client of reportClients) client.end();
      reportClients.clear();
      await new Promise<void>((resolveClose, rejectClose) => {
        current.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}
