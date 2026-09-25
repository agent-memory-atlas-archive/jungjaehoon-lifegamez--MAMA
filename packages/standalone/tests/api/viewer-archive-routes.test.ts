import { request as httpRequest, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ActionCall,
  ActionContext,
  ActionDispatcher,
  ActionResult,
  WorkGraphPage,
} from '@jungjaehoon/mama-core';
import type { JudgmentAccess } from '@jungjaehoon/mama-core/knowledge';
import { createViewerServer, type ViewerServer } from '../../src/api/viewer-server.js';

const ownerAccess: JudgmentAccess = {
  principalId: 'owner',
  agentId: 'owner-agent',
  scopes: [{ kind: 'global', id: 'system' }],
  connectors: ['connector'],
  actions: [
    'graph.query',
    'memory.search',
    'memory.checkpoint.list',
    'work.list',
    'work.show',
    'source.read',
  ],
};

function completed(data: unknown): ActionResult {
  return { status: 'completed', data };
}

function graphPage(overrides: Partial<WorkGraphPage> = {}): WorkGraphPage {
  return {
    nodes: [],
    edges: [],
    coverage: { returned: 0, total: null, complete: true, reasons: [] },
    snapshot: { judgmentWatermark: 1, identityRevision: 1, asOf: 2 },
    nextCursor: null,
    ...overrides,
  };
}

function workPage() {
  return {
    items: [
      {
        commitmentId: 'commitment-1',
        rowId: 7,
        revision: 2,
        latestJudgmentRef: { kind: 'memory', id: 'memory-2' },
        values: {
          title: 'work title',
          status: 'in_progress',
          priority: 'high',
          assignee: 'worker',
          deadline: '2026-09-30',
          dueAt: '2026-09-30T09:00:00+09:00',
          deadlineOffsetMinutes: 540,
          latestEvent: 'review requested',
          sourceChannel: 'connector',
          autoCreated: true,
          confirmed: false,
        },
        withdrawn: false,
        basis: [{ kind: 'memory', id: 'memory-1' }],
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    nextCursor: null,
    coverage: { returned: 1, total: 1, complete: true, reasons: [] },
  };
}

function makeRequest(
  server: ViewerServer,
  path: string,
  method = 'GET'
): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
          headers: res.headers,
        })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(
  implementation: (call: ActionCall, context: ActionContext) => Promise<ActionResult>,
  callback: (server: ViewerServer, calls: ActionCall[]) => Promise<void>
): Promise<void> {
  const calls: ActionCall[] = [];
  const dispatch = vi.fn(async (call: ActionCall, context: ActionContext) => {
    calls.push(call);
    expect(context.access).toBe(ownerAccess);
    return implementation(call, context);
  }) as unknown as ActionDispatcher;
  const server = createViewerServer({
    dispatch,
    ownerAccess,
    port: 0,
    getConnectorStatus: async () => [
      {
        name: 'connector',
        enabled: true,
        healthy: true,
        lastPoll: '2026-09-25T00:00:00.000Z',
        channelCount: 1,
      },
    ],
    getRuntimeStatus: () => ({
      running: true,
      version: 'test',
      backend: 'codex',
      model: 'fixture-model',
      startedAt: 1,
      health: null,
      connectors: [{ name: 'connector', enabled: true, state: 'connected' }],
    }),
  });
  await server.start();
  try {
    await callback(server, calls);
  } finally {
    await server.stop();
  }
}

describe('archive-compatible viewer routes', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('redirects the root and serves the carried operator shell', async () => {
    await withServer(
      async () => {
        throw new Error('static routes must not dispatch actions');
      },
      async (server, calls) => {
        const root = await makeRequest(server, '/');
        expect(root.status).toBe(302);
        expect(root.headers.location).toBe('/viewer');

        const viewer = await makeRequest(server, '/viewer');
        expect(viewer.status).toBe(200);
        expect(viewer.headers['content-type']).toContain('text/html');
        expect(viewer.body).toContain('operator-mount');
        expect(viewer.body).toContain('/viewer/operator/operator.js');
        expect(viewer.body).not.toContain('operator/triggers');
        for (const asset of [
          '/viewer/manifest.json',
          '/viewer/sw.js',
          '/viewer/icons/icon-192.png',
          '/viewer/operator/operator.js',
          '/viewer/operator/operator.css',
          '/favicon.ico',
        ]) {
          expect((await makeRequest(server, asset)).status, asset).toBe(200);
        }
        expect(calls).toHaveLength(0);
      }
    );
  });

  it('maps graph.query browse data to the archive graph response shape', async () => {
    await withServer(
      async (call) => {
        expect(call.action).toBe('graph.query');
        expect(call.input).toMatchObject({ view: 'browse', history: 'all', limit: 2 });
        return completed(
          graphPage({
            nodes: [
              {
                ref: { kind: 'memory', id: 'memory-1' },
                resolvedRef: { kind: 'memory', id: 'memory-1' },
                label: 'record',
                data: {
                  kind: 'memory',
                  recordKind: 'commitment',
                  topic: 'topic',
                  summary: 'summary',
                  recordedAt: 1,
                  appliesFrom: 1,
                  appliesUntil: null,
                  stateAtSnapshot: 'current',
                  replaces: [],
                  payload: { reasoning: 'reasoning' },
                  work: null,
                  content: { complete: true, nextRead: null },
                },
              },
            ],
            edges: [],
          })
        );
      },
      async (server) => {
        const response = await makeRequest(server, '/graph?limit=2');
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
          nodes: [
            {
              id: 'memory:memory-1',
              kind: 'memory',
              topic: 'topic',
              decision: 'summary',
              reasoning: 'reasoning',
            },
          ],
          edges: [],
          similarityEdges: [],
          meta: { source: 'graph.query:browse' },
        });
      }
    );
  });

  it('maps work.list to the archive operator task response shape', async () => {
    await withServer(
      async (call) => {
        expect(call.action).toBe('work.list');
        expect(call.input).toEqual({ history: 'all', limit: 50 });
        return completed(workPage());
      },
      async (server) => {
        const response = await makeRequest(server, '/api/operator/tasks');
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
          tasks: [
            {
              id: 7,
              commitment_id: 'commitment-1',
              title: 'work title',
              status: 'in_progress',
              priority: 'high',
              assignee: 'worker',
              due_date: '2026-09-30',
              due_at: '2026-09-30T00:00:00.000Z',
              source_channel: 'connector',
              latest_event: 'review requested',
              auto_created: true,
              confirmed: false,
              revision: 2,
            },
          ],
        });
      }
    );
  });

  it('uses the catalog dispatcher for memory search and exposes empty archive shapes', async () => {
    await withServer(
      async (call) => {
        if (call.action === 'memory.search') {
          expect(call.input).toEqual({ query: 'feedback', limit: 10 });
          return completed({ success: true, count: 1, results: [{ id: 'memory-1' }] });
        }
        throw new Error(`unexpected action ${call.action}`);
      },
      async (server, calls) => {
        const search = await makeRequest(server, '/api/mama/search?q=feedback&limit=10');
        expect(search.status).toBe(200);
        expect(JSON.parse(search.body)).toEqual({ count: 1, results: [{ id: 'memory-1' }] });

        const report = await makeRequest(server, '/api/report');
        expect(report.status).toBe(200);
        expect(JSON.parse(report.body)).toEqual({
          slots: [],
          reason: 'not available in this build',
        });

        const wiki = await makeRequest(server, '/api/wiki/tree');
        expect(wiki.status).toBe(200);
        expect(JSON.parse(wiki.body)).toEqual({
          tree: [],
          reason: 'not available in this build',
        });
        expect(calls.map((call) => call.action)).toEqual(['memory.search']);
      }
    );
  });

  it('serves runtime and connector state through read-only routes', async () => {
    await withServer(
      async () => completed({}),
      async (server) => {
        const runtime = await makeRequest(server, '/api/runtime/status');
        expect(runtime.status).toBe(200);
        expect(JSON.parse(runtime.body)).toMatchObject({ running: true, backend: 'codex' });

        const connectors = await makeRequest(server, '/api/connectors/status');
        expect(connectors.status).toBe(200);
        expect(JSON.parse(connectors.body)).toEqual({
          connectors: [
            {
              name: 'connector',
              enabled: true,
              healthy: true,
              lastPoll: '2026-09-25T00:00:00.000Z',
              channelCount: 1,
            },
          ],
        });
      }
    );
  });

  it('does not serve mutating graph routes', async () => {
    await withServer(
      async () => {
        throw new Error('mutating routes must not dispatch actions');
      },
      async (server) => {
        const response = await makeRequest(server, '/graph/update', 'POST');
        expect(response.status).toBe(405);
        expect(JSON.parse(response.body)).toMatchObject({
          code: 'METHOD_NOT_ALLOWED',
          message: 'read-only viewer: GET is required',
        });
      }
    );
  });
});
