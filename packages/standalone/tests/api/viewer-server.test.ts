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
  actions: ['graph.query', 'memory.search', 'source.read', 'work.list', 'work.show'],
};

function completed(data: unknown): ActionResult {
  return { status: 'completed', data };
}

function workPage() {
  return {
    items: [
      {
        commitmentId: 'commitment-1',
        rowId: 1,
        revision: 1,
        latestJudgmentRef: { kind: 'memory', id: 'memory-1' },
        values: { title: 'work title', project: 'project-ref', stage: 'review' },
        withdrawn: false,
        basis: [{ kind: 'memory', id: 'memory-1' }],
        createdAt: 1,
        updatedAt: 2,
        history: [
          {
            revision: 1,
            operation: 'create',
            recordRef: { kind: 'memory', id: 'memory-1' },
            set: { title: 'work title' },
            clear: [],
            eventDatetime: 1,
            createdAt: 1,
          },
        ],
      },
    ],
    nextCursor: null,
    coverage: { returned: 1, total: 1, complete: true, reasons: [] },
  };
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

function makeRequest(
  server: ViewerServer,
  path: string
): Promise<{ status: number; body: string; headers: IncomingMessage['headers'] }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: server.port, path, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          })
        );
      }
    );
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
  const server = createViewerServer({ dispatch, ownerAccess, port: 0 });
  await server.start();
  try {
    await callback(server, calls);
  } finally {
    await server.stop();
  }
}

describe('viewer HTTP server', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists tasks through work.list and returns only the task projection', async () => {
    await withServer(
      async (call) => {
        expect(call.action).toBe('work.list');
        expect(call.input).toEqual({ history: 'current', limit: 5 });
        return completed(workPage());
      },
      async (server, calls) => {
        const response = await makeRequest(server, '/api/viewer/tasks?limit=5');
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
          tasks: [
            {
              commitmentId: 'commitment-1',
              title: 'work title',
              project: 'project-ref',
              stage: 'review',
            },
          ],
        });
        expect(calls).toHaveLength(1);
      }
    );
  });

  it('loads a task history, reads graph evidence, and cites source.read observations', async () => {
    await withServer(
      async (call) => {
        if (call.action === 'work.show') {
          expect(call.input).toEqual({
            commitmentId: 'commitment-1',
            history: 'all',
          });
          return completed(workPage());
        }
        if (call.action === 'graph.query') {
          const input = call.input as Record<string, unknown>;
          if (input.view === 'detail') {
            return completed(
              graphPage({
                nodes: [
                  {
                    ref: { kind: 'memory', id: 'memory-1' },
                    resolvedRef: { kind: 'memory', id: 'memory-1' },
                    label: 'topic',
                    data: {
                      kind: 'memory',
                      recordKind: 'commitment',
                      topic: 'topic',
                      summary: 'created the work',
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
              })
            );
          }
          return completed(
            graphPage({
              nodes: [
                {
                  ref: { kind: 'observation', id: 'observation-1' },
                  resolvedRef: { kind: 'observation', id: 'observation-1' },
                  label: 'connector:source-1',
                  data: {
                    kind: 'observation',
                    connector: 'connector',
                    sourceId: 'source-1',
                    sourceAt: 1,
                    observedAt: 2,
                    contentHash: 'hash',
                  },
                },
              ],
              edges: [
                {
                  id: 'edge-1',
                  relation: 'derived_from',
                  from: { kind: 'memory', id: 'memory-1' },
                  to: { kind: 'observation', id: 'observation-1' },
                  resolvedFrom: { kind: 'memory', id: 'memory-1' },
                  resolvedTo: { kind: 'observation', id: 'observation-1' },
                  attrs: null,
                },
              ],
            })
          );
        }
        if (call.action === 'source.read') {
          expect(call.input).toMatchObject({
            source: 'connector',
            observationRef: 'observation-1',
            content_offset: 0,
            content_limit: 4000,
          });
          return completed({
            source: 'connector',
            observationRef: 'observation-1',
            channel: 'channel-1',
            sourceAt: 1,
            observedAt: 2,
            content: 'preserved evidence',
          });
        }
        throw new Error(`unexpected action ${call.action}`);
      },
      async (server, calls) => {
        const response = await makeRequest(server, '/api/viewer/tasks/commitment-1');
        expect(response.status).toBe(200);
        const body = JSON.parse(response.body) as {
          revisions: Array<{ evidence: Array<{ observationRef: string; content: string }> }>;
        };
        expect(body.revisions[0]?.evidence).toEqual([
          {
            observationRef: 'observation-1',
            source: 'connector',
            channel: 'channel-1',
            sourceAt: 1,
            observedAt: 2,
            content: 'preserved evidence',
          },
        ]);
        expect(calls.map((call) => call.action)).toEqual([
          'work.show',
          'graph.query',
          'graph.query',
          'source.read',
        ]);
      }
    );
  });

  it('uses graph.query browse output, filters by generic kind, and reports the absent revision chain', async () => {
    await withServer(
      async (call) => {
        expect(call.action).toBe('graph.query');
        expect(call.input).toMatchObject({ view: 'browse', history: 'all' });
        return completed(
          graphPage({
            nodes: [
              {
                ref: { kind: 'memory', id: 'memory-1' },
                resolvedRef: { kind: 'memory', id: 'memory-1' },
                label: 'memory',
                data: {
                  kind: 'memory',
                  recordKind: 'commitment',
                  topic: 'topic',
                  summary: 'summary',
                  recordedAt: 1,
                  appliesFrom: null,
                  appliesUntil: null,
                  stateAtSnapshot: 'current',
                  replaces: [],
                  payload: {},
                  work: {
                    commitmentId: 'commitment-1',
                    rowId: 1,
                    revision: 1,
                    latestJudgmentRef: { kind: 'memory', id: 'memory-1' },
                  },
                  content: { complete: true, nextRead: null },
                },
              },
            ],
          })
        );
      },
      async (server) => {
        const response = await makeRequest(server, '/api/viewer/graph?kind=memory');
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toMatchObject({
          graph: { nodes: [{ ref: { kind: 'memory' } }] },
          missing: [{ kind: 'revision_chain' }],
        });
      }
    );
  });

  it('searches memory through memory.search', async () => {
    await withServer(
      async (call) => {
        expect(call.action).toBe('memory.search');
        expect(call.input).toEqual({ query: 'feedback', limit: 10 });
        return completed({
          success: true,
          count: 1,
          results: [{ id: 'memory-1', topic: 'topic', decision: 'feedback', created_at: 1 }],
        });
      },
      async (server) => {
        const response = await makeRequest(server, '/api/viewer/memory/search?q=feedback&limit=10');
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toEqual({
          count: 1,
          results: [{ id: 'memory-1', topic: 'topic', decision: 'feedback', created_at: 1 }],
        });
      }
    );
  });

  it('serves the carried viewer shell separately from dispatcher-backed API routes', async () => {
    await withServer(
      async () => {
        throw new Error('static viewer must not dispatch an action');
      },
      async (server, calls) => {
        const response = await makeRequest(server, '/viewer');
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('Tasks');
        expect(response.body).toContain('operator-mount');
        expect(response.body).toContain('Memory');
        expect(calls).toHaveLength(0);
      }
    );
  });
});
