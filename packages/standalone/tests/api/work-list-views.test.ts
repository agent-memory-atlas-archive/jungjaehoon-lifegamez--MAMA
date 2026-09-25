import { describe, expect, it, vi } from 'vitest';
import type { ActionContext } from '@jungjaehoon/mama-core';
import type {
  CommitmentPage,
  CommitmentRevision,
  CommitmentView,
  JudgmentAccess,
  WorkRead,
} from '@jungjaehoon/mama-core/knowledge';
import {
  runWorkListView,
  workListActionRegistrations,
  type WorkListViewContext,
} from '../../src/api/work-actions.js';

const access: JudgmentAccess = {
  principalId: 'principal-test',
  agentId: 'agent-test',
  scopes: [],
  actions: ['work.list'],
};

function revision(
  commitmentId: string,
  revisionNumber: number,
  values: Record<string, unknown>
): CommitmentRevision {
  return {
    revision: revisionNumber,
    operation: revisionNumber === 1 ? 'create' : 'revise',
    recordRef: { kind: 'memory', id: `memory-${commitmentId}-${revisionNumber}` },
    set: values,
    clear: [],
    eventDatetime: 1_700_000_000_000 + revisionNumber,
    createdAt: 1_700_000_000_000 + revisionNumber,
  };
}

function view(index: number, overrides: Partial<CommitmentView> = {}): CommitmentView {
  const commitmentId = `commitment-${index}`;
  const values = {
    title: `item-${index}`,
    description: `description-${index}`,
    status: index % 2 === 0 ? 'pending' : 'done',
    stage: `stage-${index % 2}`,
    project: `scope-${index % 2}`,
    priority: 'normal',
  };
  return {
    commitmentId,
    rowId: index,
    revision: 1,
    latestJudgmentRef: { kind: 'memory', id: `memory-${index}-1` },
    values,
    withdrawn: false,
    basis: [{ kind: 'memory', id: `memory-${index}-1` }],
    createdAt: 1_700_000_000_000 + index,
    updatedAt: 1_700_000_000_000 + index,
    ...overrides,
  };
}

function makeReader(initial: CommitmentView[]) {
  const state = { items: [...initial] };
  const readWork = vi.fn((query: WorkRead): CommitmentPage => {
    const wanted =
      query.commitmentId === undefined
        ? query.rowId === undefined
          ? undefined
          : state.items.find((item) => item.rowId === query.rowId)
        : state.items.find((item) => item.commitmentId === query.commitmentId);
    if (wanted !== undefined || query.commitmentId !== undefined || query.rowId !== undefined) {
      return {
        items: wanted === undefined ? [] : [query.history === 'all' ? withHistory(wanted) : wanted],
        nextCursor: null,
        coverage: { returned: wanted === undefined ? 0 : 1, total: 1, complete: true, reasons: [] },
      };
    }
    const offset = query.cursor === undefined ? 0 : Number(query.cursor);
    const limit = query.limit ?? 100;
    const items = state.items.slice(offset, offset + limit);
    const nextCursor =
      offset + items.length < state.items.length ? String(offset + items.length) : null;
    return {
      items: query.history === 'all' ? items.map(withHistory) : items,
      nextCursor,
      coverage: {
        returned: items.length,
        total: state.items.length,
        complete: nextCursor === null,
        reasons: nextCursor === null ? [] : ['more commitments follow this page'],
      },
    };
  });
  return { state, readWork };
}

function withHistory(item: CommitmentView): CommitmentView {
  const values = item.values as Record<string, unknown>;
  return {
    ...item,
    history: [revision(item.commitmentId, 1, values)],
  };
}

function context(readWork: WorkListViewContext['knowledge']['readWork']): WorkListViewContext {
  return { knowledge: { readWork }, access, now: () => 1_700_000_100_000 };
}

describe('progressive work.list views', () => {
  it('returns a bounded compact items page and keeps detail-only evidence out', () => {
    const reader = makeReader(Array.from({ length: 30 }, (_, index) => view(index + 1)));

    const result = runWorkListView({}, context(reader.readWork));

    expect(result).toMatchObject({ view: 'items', returned: 25, total: 30 });
    expect(result.tasks).toHaveLength(25);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(result.readVersion).toEqual(expect.any(String));
    expect(result.tasks[0]).toMatchObject({ commitmentId: 'commitment-1', title: 'item-1' });
    expect(result.tasks[0]).not.toHaveProperty('description');
    expect(result.tasks[0]).not.toHaveProperty('basis');
    expect(result.tasks[0]).not.toHaveProperty('history');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(6_000);
  });

  it('filters status, stage, project, and title or description before paging', () => {
    const reader = makeReader([
      view(1, {
        values: {
          title: 'alpha',
          description: 'needle',
          status: 'pending',
          stage: 'stage-1',
          project: 'scope-1',
        },
      }),
      view(2, {
        values: {
          title: 'beta',
          description: 'other',
          status: 'done',
          stage: 'stage-0',
          project: 'scope-0',
        },
      }),
      view(3, {
        values: {
          title: 'gamma',
          description: 'other',
          status: 'pending',
          stage: 'stage-0',
          project: 'scope-0',
        },
      }),
    ]);

    expect(
      runWorkListView(
        { view: 'items', status: 'pending', stage: 'stage-1', project: 'scope-1', text: 'needle' },
        context(reader.readWork)
      ).tasks.map((task) => task.commitmentId)
    ).toEqual(['commitment-1']);
  });

  it('rejects a cursor after the commitment read version changes', () => {
    const reader = makeReader(Array.from({ length: 30 }, (_, index) => view(index + 1)));
    const first = runWorkListView({}, context(reader.readWork));
    reader.state.items[0] = view(1, { values: { title: 'changed', status: 'pending' } });

    expect(() => runWorkListView({ cursor: first.nextCursor }, context(reader.readWork))).toThrow(
      /changed.*restart/i
    );
  });

  it('surfaces an incomplete commitment page instead of hiding scope gaps', () => {
    const readWork = vi
      .fn()
      .mockReturnValueOnce({
        items: [],
        nextCursor: '1',
        coverage: {
          returned: 0,
          total: 2,
          complete: false,
          reasons: [
            'more commitments follow this page',
            "1 commitment(s) outside the caller's scopes",
          ],
        },
      })
      .mockReturnValueOnce({
        items: [],
        nextCursor: null,
        coverage: { returned: 0, total: 2, complete: true, reasons: [] },
      });

    expect(() => runWorkListView({}, context(readWork))).toThrow(/incomplete|outside the caller/i);
  });

  it('returns up to four full records with basis, history, and code-point text continuation', () => {
    const longText = 'x'.repeat(2_301);
    const reader = makeReader([
      view(1, {
        values: { title: 'one', description: longText },
        revision: 2,
        history: [revision('commitment-1', 1, { title: 'one' })],
      }),
    ]);

    const first = runWorkListView(
      { view: 'detail', ids: ['commitment-1'], text_limit: 1_000 },
      context(reader.readWork)
    );
    const task = first.tasks[0]!;
    expect(first.missingIds).toEqual([]);
    expect(task).toHaveProperty('basis');
    expect(task).toHaveProperty('history');
    expect(task.values.description).toMatchObject({ total: 2_301, nextOffset: 1_000 });

    const second = runWorkListView(
      { view: 'detail', ids: ['commitment-1'], text_offset: 1_000, text_limit: 2_000 },
      context(reader.readWork)
    );
    expect(second.tasks[0]!.values.description).toMatchObject({
      value: longText.slice(1_000),
      complete: true,
      nextOffset: null,
    });
  });

  it('registers work.list as the product progressive contract', () => {
    const registration = workListActionRegistrations({ knowledge: { readWork: vi.fn() } }).at(0)!;
    expect(registration.contract.name).toBe('work.list');
    expect(registration.contract.inputSchema.properties?.view?.enum).toEqual([
      'overview',
      'items',
      'detail',
    ]);
    expect(registration.contract.summary).toContain('bounded');
  });

  it('dispatches the current commitment reader under the caller access', async () => {
    const reader = makeReader([view(1)]);
    const registration = workListActionRegistrations({
      knowledge: { readWork: reader.readWork },
    })[0]!;
    const result = await registration.exec({ view: 'items', limit: 1 }, {
      access,
      operationId: 'read-work-list',
    } as ActionContext);

    expect(result).toMatchObject({ view: 'items', returned: 1 });
    expect(reader.readWork).toHaveBeenCalledWith(expect.anything(), access);
  });
});
