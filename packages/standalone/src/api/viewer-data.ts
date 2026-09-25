import type {
  CommitmentPage,
  CommitmentRevision,
  CommitmentView,
} from '@jungjaehoon/mama-core/knowledge';
import type { WorkGraphPage } from '@jungjaehoon/mama-core';

export interface ViewerTaskSummary {
  commitmentId: string;
  rowId: number;
  revision: number;
  title: string | null;
  project: string | null;
  stage: string | null;
  assignee: string | null;
  lastEventTime: string | number | null;
  updatedAt: number;
  withdrawn: boolean;
}

export interface ViewerTaskList {
  tasks: ViewerTaskSummary[];
  nextCursor: string | null;
  coverage: CommitmentPage['coverage'];
}

export interface ViewerEvidence {
  observationRef: string;
  source: string;
  sourceAt?: number | null;
  observedAt?: number | null;
  content: string;
}

export interface RevisionGraphRead {
  record: WorkGraphPage['nodes'][number] | null;
  evidence: ViewerEvidence[];
}

export interface ViewerRevision {
  revision: number;
  operation: CommitmentRevision['operation'];
  recordRef: CommitmentRevision['recordRef'];
  eventTime: number;
  eventTimeSource: 'event' | 'recorded';
  recordedAt: number;
  summary: string | null;
  reasoning: string | null;
  change: CommitmentRevision['set'];
  clear: Array<keyof CommitmentRevision['set']>;
  feedback: string | null;
  roles: unknown[] | null;
  files: unknown[] | null;
  evidence: ViewerEvidence[];
}

export interface ViewerTaskDetail extends ViewerTaskSummary {
  revisions: ViewerRevision[];
}

export interface ViewerGraphResult {
  nodes: WorkGraphPage['nodes'];
  edges: WorkGraphPage['edges'];
  coverage: WorkGraphPage['coverage'];
  snapshot: WorkGraphPage['snapshot'];
  nextCursor: string | null;
}

export interface ViewerMemorySearchResult {
  count: number;
  results: unknown[];
}

function textField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function scalarField(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function arrayField(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function taskSummary(item: CommitmentView): ViewerTaskSummary {
  return {
    commitmentId: item.commitmentId,
    rowId: item.rowId,
    revision: item.revision,
    title: textField(item.values.title),
    project: textField(item.values.project),
    stage: textField(item.values.stage),
    assignee: textField(item.values.assignee ?? item.values.assigneeText),
    lastEventTime: scalarField(item.values.lastEventTime),
    updatedAt: item.updatedAt,
    withdrawn: item.withdrawn,
  };
}

export function shapeTaskList(page: CommitmentPage): ViewerTaskList {
  return {
    tasks: page.items.map(taskSummary),
    nextCursor: page.nextCursor,
    coverage: page.coverage,
  };
}

function refKey(ref: { kind: string; id: string }): string {
  return `${ref.kind}:${ref.id}`;
}

function recordText(
  read: RevisionGraphRead | undefined,
  field: 'summary' | 'reasoning'
): string | null {
  const data = read?.record?.data;
  if (!data || data.kind !== 'memory') return null;
  if (field === 'summary') return data.summary;
  return textField(data.payload.reasoning);
}

function revisionsFor(item: CommitmentView): CommitmentRevision[] {
  if (item.history === undefined) {
    throw new Error('work.show did not return revision history');
  }
  return [...item.history].sort(
    (left, right) =>
      (left.eventDatetime ?? left.createdAt) - (right.eventDatetime ?? right.createdAt) ||
      left.revision - right.revision
  );
}

export function shapeTaskDetail(
  page: CommitmentPage,
  reads: ReadonlyMap<string, RevisionGraphRead>
): ViewerTaskDetail {
  if (page.items.length !== 1) {
    throw new Error('work.show did not return exactly one task');
  }
  const item = page.items[0]!;
  const revisions = revisionsFor(item).map((revision): ViewerRevision => {
    const read = reads.get(refKey(revision.recordRef));
    const eventTime = revision.eventDatetime ?? revision.createdAt;
    return {
      revision: revision.revision,
      operation: revision.operation,
      recordRef: revision.recordRef,
      eventTime,
      eventTimeSource: revision.eventDatetime === null ? 'recorded' : 'event',
      recordedAt: revision.createdAt,
      summary: recordText(read, 'summary'),
      reasoning: recordText(read, 'reasoning'),
      change: revision.set,
      clear: revision.clear,
      feedback: textField(revision.set.feedback),
      roles: arrayField(revision.set.roles),
      files: arrayField(revision.set.files),
      evidence: read?.evidence ?? [],
    };
  });
  return { ...taskSummary(item), revisions };
}

export function shapeGraphPage(
  page: WorkGraphPage,
  kinds: readonly string[] = []
): ViewerGraphResult {
  if (kinds.length === 0) return page;
  const wanted = new Set(kinds);
  const nodes = page.nodes.filter((node) => wanted.has(node.ref.kind));
  const visible = new Set(nodes.map((node) => refKey(node.ref)));
  const edges = page.edges.filter(
    (edge) => visible.has(refKey(edge.from)) && visible.has(refKey(edge.to))
  );
  return { ...page, nodes, edges };
}

export function shapeMemorySearch(data: unknown): ViewerMemorySearchResult {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('memory.search returned a non-object result');
  }
  const result = data as { count?: unknown; results?: unknown };
  if (!Array.isArray(result.results) || !Number.isSafeInteger(result.count)) {
    throw new Error('memory.search returned no bounded result list');
  }
  return { count: result.count as number, results: result.results };
}
