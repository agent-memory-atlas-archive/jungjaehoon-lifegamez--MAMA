import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createKnowledge } from '../../src/knowledge/index.js';
import { openDatabase, type DatabaseHandle } from '../../src/storage/database.js';

const ACCESS = {
  principalId: 'principal-test',
  agentId: 'agent-test',
  scopes: [{ kind: 'project' as const, id: 'scope-test' }],
};

describe('Story R1: knowledge instance isolation', () => {
  const dirs: string[] = [];
  const handles: DatabaseHandle[] = [];

  afterAll(async () => {
    for (const handle of handles) {
      await handle.close();
    }
    for (const dir of dirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  async function openIsolated(name: string): Promise<DatabaseHandle> {
    const dir = await mkdtemp(path.join(tmpdir(), `mama-isolation-${name}-`));
    dirs.push(dir);
    const handle = await openDatabase({ path: path.join(dir, 'test.db') });
    handles.push(handle);
    return handle;
  }

  it('a judgment written on one instance is invisible on another', async () => {
    const first = await openIsolated('a');
    const second = await openIsolated('b');
    const knowledgeA = createKnowledge({ adapter: first.adapter });
    const knowledgeB = createKnowledge({ adapter: second.adapter });

    const receipt = await knowledgeA.appendJudgment(
      {
        commandId: 'cmd-isolation-1',
        topic: 'isolation-topic',
        summary: 'written on instance A',
        recordKind: 'judgment',
        scopes: ACCESS.scopes,
      },
      ACCESS
    );

    const pageA = knowledgeA.queryGraph(
      { seeds: [{ kind: 'memory', id: receipt.recordId }], view: 'detail' },
      ACCESS
    );
    expect(pageA.nodes.map((node) => node.ref.id)).toContain(receipt.recordId);

    expect(second.adapter.prepare('SELECT COUNT(*) AS n FROM decisions').get()).toEqual({
      n: 0,
    });
    expect(() =>
      knowledgeB.queryGraph(
        { seeds: [{ kind: 'memory', id: receipt.recordId }], view: 'detail' },
        ACCESS
      )
    ).toThrow();
  });
});
