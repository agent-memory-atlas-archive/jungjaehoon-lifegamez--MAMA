import { describe, expect, it } from 'vitest';
import type { CommitmentPage } from '@jungjaehoon/mama-core/knowledge';
import type { WorkGraphPage } from '@jungjaehoon/mama-core';
import {
  shapeGraphPage,
  shapeMemorySearch,
  shapeOperatorTasks,
  shapeTaskDetail,
  shapeTaskList,
  type RevisionGraphRead,
} from '../../src/api/viewer-data.js';

const page = (items: CommitmentPage['items']): CommitmentPage => ({
  items,
  nextCursor: null,
  coverage: { returned: items.length, total: items.length, complete: true, reasons: [] },
});

describe('viewer data shaping', () => {
  it('projects the task list fields without inventing values for missing task fields', () => {
    const result = shapeTaskList(
      page([
        {
          commitmentId: 'commitment-1',
          rowId: 1,
          revision: 2,
          latestJudgmentRef: { kind: 'memory', id: 'memory-2' },
          values: {
            title: 'work title',
            project: 'project-ref',
            stage: 'review',
            assignee: 'person-ref',
            lastEventTime: 1_700_000_000_000,
          },
          withdrawn: false,
          basis: [],
          createdAt: 1_699_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
        {
          commitmentId: 'commitment-2',
          rowId: 2,
          revision: 1,
          latestJudgmentRef: { kind: 'memory', id: 'memory-3' },
          values: { title: 'another work' },
          withdrawn: false,
          basis: [],
          createdAt: 1_699_000_000_000,
          updatedAt: 1_699_000_000_000,
        },
      ])
    );

    expect(result.tasks).toEqual([
      {
        commitmentId: 'commitment-1',
        rowId: 1,
        revision: 2,
        title: 'work title',
        project: 'project-ref',
        stage: 'review',
        assignee: 'person-ref',
        lastEventTime: 1_700_000_000_000,
        updatedAt: 1_700_000_000_000,
        withdrawn: false,
      },
      {
        commitmentId: 'commitment-2',
        rowId: 2,
        revision: 1,
        title: 'another work',
        project: null,
        stage: null,
        assignee: null,
        lastEventTime: null,
        updatedAt: 1_699_000_000_000,
        withdrawn: false,
      },
    ]);
  });

  it('sorts revision history by event time and carries record, patch, roles, files, and evidence', () => {
    const work = page([
      {
        commitmentId: 'commitment-1',
        rowId: 1,
        revision: 2,
        latestJudgmentRef: { kind: 'memory', id: 'memory-2' },
        values: { title: 'work title' },
        withdrawn: false,
        basis: [
          { kind: 'memory', id: 'memory-1' },
          { kind: 'memory', id: 'memory-2' },
        ],
        createdAt: 1_700_000_000_200,
        updatedAt: 1_700_000_000_200,
        history: [
          {
            revision: 2,
            operation: 'revise',
            recordRef: { kind: 'memory', id: 'memory-2' },
            set: {
              feedback: 'feedback text',
              roles: [{ personRef: 'person-ref', role: 'reviewer', confirmed: false }],
              files: [{ locator: 'file-ref', version: 'v2', hash: 'hash-v2' }],
            },
            clear: [],
            eventDatetime: 1_700_000_000_200,
            createdAt: 1_700_000_000_201,
          },
          {
            revision: 1,
            operation: 'create',
            recordRef: { kind: 'memory', id: 'memory-1' },
            set: { title: 'work title' },
            clear: [],
            eventDatetime: 1_700_000_000_100,
            createdAt: 1_700_000_000_101,
          },
        ],
      },
    ]);
    const reads = new Map<string, RevisionGraphRead>([
      [
        'memory:memory-1',
        {
          record: {
            ref: { kind: 'memory', id: 'memory-1' },
            resolvedRef: { kind: 'memory', id: 'memory-1' },
            label: 'topic',
            data: {
              kind: 'memory',
              recordKind: 'commitment',
              topic: 'topic',
              summary: 'created the work',
              recordedAt: 1_700_000_000_101,
              appliesFrom: 1_700_000_000_100,
              appliesUntil: null,
              stateAtSnapshot: 'current',
              replaces: [],
              payload: { reasoning: 'reason for create' },
              work: {
                commitmentId: 'commitment-1',
                rowId: 1,
                revision: 1,
                latestJudgmentRef: { kind: 'memory', id: 'memory-2' },
              },
              content: { complete: true, nextRead: null },
            },
          } as WorkGraphPage['nodes'][number],
          evidence: [],
        },
      ],
      [
        'memory:memory-2',
        {
          record: {
            ref: { kind: 'memory', id: 'memory-2' },
            resolvedRef: { kind: 'memory', id: 'memory-2' },
            label: 'topic',
            data: {
              kind: 'memory',
              recordKind: 'commitment',
              topic: 'topic',
              summary: 'review changed the work',
              recordedAt: 1_700_000_000_201,
              appliesFrom: 1_700_000_000_200,
              appliesUntil: null,
              stateAtSnapshot: 'current',
              replaces: [],
              payload: { reasoning: 'reason for revision' },
              work: {
                commitmentId: 'commitment-1',
                rowId: 1,
                revision: 2,
                latestJudgmentRef: { kind: 'memory', id: 'memory-2' },
              },
              content: { complete: true, nextRead: null },
            },
          } as WorkGraphPage['nodes'][number],
          evidence: [
            {
              observationRef: 'observation-1',
              source: 'connector',
              channel: 'channel-1',
              content: 'preserved evidence',
              sourceAt: 1_700_000_000_150,
              observedAt: 1_700_000_000_160,
            },
          ],
        },
      ],
    ]);

    const result = shapeTaskDetail(work, reads);

    expect(result.revisions.map((revision) => revision.revision)).toEqual([1, 2]);
    expect(result.createdAt).toBe(1_700_000_000_100);
    expect(result.updatedAt).toBe(1_700_000_000_200);
    expect(result.revisions[0]).toMatchObject({
      summary: 'created the work',
      reasoning: 'reason for create',
      feedback: null,
      roles: null,
      files: null,
    });
    expect(result.revisions[1]).toMatchObject({
      summary: 'review changed the work',
      feedback: 'feedback text',
      roles: [{ personRef: 'person-ref', role: 'reviewer', confirmed: false }],
      files: [{ locator: 'file-ref', version: 'v2', hash: 'hash-v2' }],
      evidence: [
        {
          observationRef: 'observation-1',
          channel: 'channel-1',
          content: 'preserved evidence',
        },
      ],
    });
  });

  it('adds the commitment id and event-time bounds to the archive operator task shape', () => {
    const result = shapeOperatorTasks(
      page([
        {
          commitmentId: 'commitment-1',
          rowId: 7,
          revision: 2,
          latestJudgmentRef: { kind: 'memory', id: 'memory-2' },
          values: { title: 'work title' },
          withdrawn: false,
          basis: [],
          createdAt: 10,
          updatedAt: 20,
          history: [
            {
              revision: 2,
              operation: 'revise',
              recordRef: { kind: 'memory', id: 'memory-2' },
              set: {},
              clear: [],
              eventDatetime: 300,
              createdAt: 301,
            },
            {
              revision: 1,
              operation: 'create',
              recordRef: { kind: 'memory', id: 'memory-1' },
              set: { title: 'work title' },
              clear: [],
              eventDatetime: 100,
              createdAt: 101,
            },
          ],
        },
      ])
    );

    expect(result.tasks[0]).toMatchObject({
      commitment_id: 'commitment-1',
      created_at: 100,
      updated_at: 300,
    });
  });

  it('filters graph nodes and keeps only edges whose endpoints remain visible', () => {
    const graph: WorkGraphPage = {
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
            work: null,
            content: { complete: true, nextRead: null },
          },
        },
        {
          ref: { kind: 'observation', id: 'observation-1' },
          resolvedRef: { kind: 'observation', id: 'observation-1' },
          label: 'observation',
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
      coverage: { returned: 2, total: null, complete: true, reasons: [] },
      snapshot: { judgmentWatermark: 1, identityRevision: 1, asOf: 2 },
      nextCursor: null,
    };

    const filtered = shapeGraphPage(graph, ['memory']);

    expect(filtered.nodes.map((node) => node.ref.kind)).toEqual(['memory']);
    expect(filtered.edges).toEqual([]);
    expect(filtered.coverage).toEqual(graph.coverage);
  });

  it('keeps memory search result fields and count', () => {
    expect(
      shapeMemorySearch({
        success: true,
        count: 1,
        results: [
          {
            id: 'memory-1',
            topic: 'topic',
            decision: 'decision',
            reasoning: 'reasoning',
            created_at: 1,
          },
        ],
      })
    ).toEqual({
      count: 1,
      results: [
        {
          id: 'memory-1',
          topic: 'topic',
          decision: 'decision',
          reasoning: 'reasoning',
          created_at: 1,
        },
      ],
    });
  });
});
