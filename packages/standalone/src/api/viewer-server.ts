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
import type { CommitmentPage, JudgmentAccess } from '@jungjaehoon/mama-core/knowledge';
import { requireViewerAuth } from './auth-middleware.js';
import {
  shapeGraphPage,
  shapeMemorySearch,
  shapeTaskDetail,
  shapeTaskList,
  type RevisionGraphRead,
  type ViewerEvidence,
} from './viewer-data.js';

const GRAPH_KINDS = new Set(['memory', 'case', 'report', 'edge', 'raw', 'registry', 'observation']);

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export interface ViewerServerOptions {
  dispatch: ActionDispatcher;
  ownerAccess: JudgmentAccess;
  port?: number;
  host?: string;
  viewerDirectory?: string;
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
      edge.to.kind !== 'observation'
    ) {
      continue;
    }
    const source = observations.get(edge.to.id);
    if (source === undefined || seen.has(edge.to.id)) continue;
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
      `source.read returned no readable observation for ${observationRef}`
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
    sourceAt: typeof row.sourceAt === 'number' ? row.sourceAt : null,
    observedAt: typeof row.observedAt === 'number' ? row.observedAt : null,
    content: row.content,
  };
}

export function createViewerServer(options: ViewerServerOptions): ViewerServer {
  const port = options.port ?? resolveApiPort(process.env.MAMA_API_PORT);
  const host = options.host ?? process.env.MAMA_API_HOST ?? '127.0.0.1';
  const root = options.viewerDirectory ?? viewerDirectory();
  let server: Server | null = null;
  let actualPort = port;
  let stopped = false;

  const callAction = async (action: string, input: Record<string, unknown>): Promise<unknown> => {
    const operationId = `viewer:${action}:${randomUUID()}`;
    const call: ActionCall = { action, input, operationId };
    const context: ActionContext = { access: options.ownerAccess, operationId };
    const result = await options.dispatch(call, context);
    if (result.status === 'completed') return result.data;
    throw new ViewerHttpError(actionFailureStatus(result), result.error.code, result.error.message);
  };

  const taskList = async (params: URLSearchParams): Promise<unknown> => {
    const input: Record<string, unknown> = {
      history: 'current',
      limit: parseLimit(params, 50, 100),
    };
    const cursor = params.get('cursor');
    if (cursor !== null) input.cursor = cursor;
    const page = (await callAction('work.list', input)) as CommitmentPage;
    return shapeTaskList(page);
  };

  const taskDetail = async (commitmentId: string): Promise<unknown> => {
    if (commitmentId.trim() === '') {
      throw new ViewerHttpError(400, 'INVALID_COMMITMENT_ID', 'commitment id must be nonblank');
    }
    const page = (await callAction('work.show', {
      commitmentId,
      history: 'all',
    })) as CommitmentPage;
    const item = page.items[0];
    if (!item || item.history === undefined) {
      throw new ViewerHttpError(
        502,
        'WORK_HISTORY_MISSING',
        'work.show returned no revision history'
      );
    }
    const reads = new Map<string, RevisionGraphRead>();
    for (const revision of item.history) {
      const detail = (await callAction('graph.query', {
        view: 'detail',
        seeds: [revision.recordRef],
        history: 'all',
      })) as WorkGraphPage;
      const record = memoryNode(detail, revision.recordRef.id);
      if (record === null) {
        throw new ViewerHttpError(
          502,
          'REVISION_RECORD_MISSING',
          `graph.query returned no record for revision ${String(revision.revision)}`
        );
      }
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
        const sourceData = await callAction('source.read', {
          source: candidate.source,
          view: 'stored',
          detail: 'full',
          observationRef: candidate.ref.id,
        });
        evidence.push(sourceReadEvidence(sourceData, candidate.source, candidate.ref.id));
      }
      reads.set(`${revision.recordRef.kind}:${revision.recordRef.id}`, { record, evidence });
    }
    return shapeTaskDetail(page, reads);
  };

  const graph = async (params: URLSearchParams): Promise<unknown> => {
    const input: Record<string, unknown> = {
      view: 'browse',
      history: 'all',
      limit: parseLimit(params, 300, 2000),
    };
    const cursor = params.get('cursor');
    if (cursor !== null) input.cursor = cursor;
    const relations = params.get('relation');
    if (relations !== null && relations.trim() !== '') {
      input.relations = relations
        .split(',')
        .map((relation) => relation.trim())
        .filter(Boolean);
    }
    const page = (await callAction('graph.query', input)) as WorkGraphPage;
    const filtered = shapeGraphPage(page, parseKinds(params));
    return {
      graph: filtered,
      missing: [
        {
          kind: 'revision_chain',
          message:
            'graph.query returns commitment revisions as memory nodes with data.work, but it does not return revision-to-revision edges; task detail reads work.show history all.',
        },
      ],
    };
  };

  const memorySearch = async (params: URLSearchParams): Promise<unknown> => {
    const query = params.get('q');
    const input: Record<string, unknown> = { limit: parseLimit(params, 20, 200) };
    if (query !== null && query.trim() !== '') input.query = query;
    return shapeMemorySearch(await callAction('memory.search', input));
  };

  const serveStatic = (pathname: string, req: IncomingMessage, res: ServerResponse): boolean => {
    if (pathname === '/') {
      res.writeHead(302, { Location: '/viewer' });
      res.end();
      return true;
    }
    const relativePath =
      pathname === '/viewer' || pathname === '/viewer/'
        ? 'viewer.html'
        : pathname.startsWith('/viewer/')
          ? pathname.slice('/viewer/'.length)
          : null;
    if (relativePath === null || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    const filePath = resolve(root, relativePath);
    const rel = relative(root, filePath);
    if (rel.startsWith('..') || rel.includes('..' + '/')) return false;
    try {
      if (!statSync(filePath).isFile()) return false;
      const content = readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[extname(filePath)] ?? 'application/octet-stream',
      });
      res.end(req.method === 'HEAD' ? undefined : content);
      return true;
    } catch {
      return false;
    }
  };

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
    if (url.pathname.startsWith('/api/viewer/')) {
      if (req.method !== 'GET') {
        json(res, 405, { error: true, code: 'METHOD_NOT_ALLOWED', message: 'GET is required' });
        return;
      }
      if (!requireViewerAuth(req, res)) return;
      const parts = url.pathname.split('/').filter(Boolean);
      const result =
        parts[1] === 'viewer' && parts[2] === 'tasks' && parts.length === 3
          ? await taskList(url.searchParams)
          : parts[1] === 'viewer' && parts[2] === 'tasks' && parts.length === 4
            ? await taskDetail(decodeURIComponent(parts[3]!))
            : parts[1] === 'viewer' && parts[2] === 'graph' && parts.length === 3
              ? await graph(url.searchParams)
              : parts[1] === 'viewer' &&
                  parts[2] === 'memory' &&
                  parts[3] === 'search' &&
                  parts.length === 4
                ? await memorySearch(url.searchParams)
                : null;
      if (result === null) {
        json(res, 404, { error: true, code: 'NOT_FOUND', message: 'Viewer endpoint not found' });
        return;
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
          if (!res.headersSent)
            json(res, failure.status, {
              error: true,
              code: failure.code,
              message: failure.message,
            });
          else res.end();
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
      await new Promise<void>((resolveClose, rejectClose) => {
        current.close((error) => (error ? rejectClose(error) : resolveClose()));
      });
    },
  };
}
