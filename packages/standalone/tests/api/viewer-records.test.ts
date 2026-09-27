import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ActionDispatcher } from '@jungjaehoon/mama-core';
import type { JudgmentAccess } from '@jungjaehoon/mama-core/knowledge';
import { createReportStore } from '../../src/api/report-handler.js';
import { createViewerServer, type ViewerServer } from '../../src/api/viewer-server.js';

const roots: string[] = [];
const access: JudgmentAccess = {
  principalId: 'owner',
  agentId: 'owner-agent',
  scopes: [],
  connectors: [],
  actions: [],
};

function get(server: ViewerServer, path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: server.port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('viewer board and wiki record routes', () => {
  let server: ViewerServer | undefined;

  afterEach(async () => {
    await server?.stop();
    server = undefined;
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('reads the carried board store and configured wiki root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mama-viewer-records-'));
    roots.push(root);
    writeFileSync(
      join(root, 'case.md'),
      '---\ntitle: "Case"\ntype: "entity"\n---\n\n# Case\n\nCurrent evidence.\n',
      'utf8'
    );
    const reportStore = createReportStore();
    reportStore.update('briefing', '<div class="report-card">current</div>', 0);
    const reportSseClients = new Set<import('node:http').ServerResponse>();
    server = createViewerServer({
      dispatch: (async () => {
        throw new Error('record routes must not dispatch actions');
      }) as unknown as ActionDispatcher,
      ownerAccess: access,
      reportStore,
      reportSseClients,
      wikiRoot: root,
      port: 0,
    });
    await server.start();

    await expect(get(server, '/api/report')).resolves.toEqual({
      status: 200,
      body: {
        slots: [
          expect.objectContaining({
            slotId: 'briefing',
            html: '<div class="report-card">current</div>',
          }),
        ],
      },
    });
    await expect(get(server, '/api/wiki/tree')).resolves.toEqual({
      status: 200,
      body: { tree: [{ name: 'case.md', path: 'case.md', type: 'file' }] },
    });
    await expect(get(server, '/api/wiki/page?path=case.md')).resolves.toEqual({
      status: 200,
      body: expect.objectContaining({
        path: 'case.md',
        frontmatter: { title: '"Case"', type: '"entity"' },
        content: '\n# Case\n\nCurrent evidence.\n',
      }),
    });
  });

  it('counts the board header from the work ledger and the published action slot', async () => {
    const reportStore = createReportStore();
    reportStore.update(
      'action_required',
      '<div class="report-card">one</div><div class="report-card">two</div>',
      0
    );
    const calls: Array<Record<string, unknown>> = [];
    server = createViewerServer({
      dispatch: (async (call: { action: string; input: Record<string, unknown> }) => {
        calls.push(call.input);
        if (call.input.view === 'overview') {
          return {
            status: 'completed',
            data: {
              status: { pending: 3, in_progress: 2, review: 1, blocked: 0, done: 9, cancelled: 1 },
              due: { missing: 0, overdue: 2, upcoming: 4, closed: 10 },
            },
          };
        }
        return call.input.cursor === undefined
          ? {
              status: 'completed',
              data: {
                tasks: [{ assignee: 'Person A' }, { assignee: 'unconfirmed' }, { assignee: null }],
                nextCursor: 'page-2',
              },
            }
          : { status: 'completed', data: { tasks: [{ assignee: '' }], nextCursor: null } };
      }) as unknown as ActionDispatcher,
      ownerAccess: access,
      reportStore,
      reportSseClients: new Set(),
      port: 0,
    });
    await server.start();

    await expect(get(server, '/api/operator/summary')).resolves.toEqual({
      status: 200,
      body: {
        report: { actionRequired: 2, updatedAt: expect.any(Number) },
        work: { open: 6, review: 1, overdue: 2, unassigned: 3 },
      },
    });
    expect(calls.filter((input) => input.view === 'items')).toEqual([
      { view: 'items', status: ['pending', 'in_progress', 'review', 'blocked'], limit: 50 },
      {
        view: 'items',
        status: ['pending', 'in_progress', 'review', 'blocked'],
        limit: 50,
        cursor: 'page-2',
      },
    ]);
  });

  it('seeds report events from the same store used by the publisher', async () => {
    const reportStore = createReportStore();
    reportStore.update(
      'pipeline',
      '<table class="report-table"><tr><td>current</td></tr></table>',
      3
    );
    const reportSseClients = new Set<import('node:http').ServerResponse>();
    server = createViewerServer({
      dispatch: (async () => {
        throw new Error('report events must not dispatch actions');
      }) as unknown as ActionDispatcher,
      ownerAccess: access,
      reportStore,
      reportSseClients,
      port: 0,
    });
    await server.start();

    await new Promise<void>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: server!.port, path: '/api/report/events' },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (!chunk.includes('report-table')) return;
            expect(chunk).toContain('pipeline');
            res.destroy();
            resolve();
          });
          res.on('error', reject);
        }
      );
      req.on('error', (error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error);
      });
      req.end();
    });
  });
});
