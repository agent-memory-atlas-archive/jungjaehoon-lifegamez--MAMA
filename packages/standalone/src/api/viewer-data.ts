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
  channel?: string | null;
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
  createdAt: number;
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
  return {
    ...taskSummary(item),
    createdAt: revisions[0]?.eventTime ?? item.createdAt,
    updatedAt: revisions[revisions.length - 1]?.eventTime ?? item.updatedAt,
    revisions,
  };
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

export interface ArchiveOperatorTask {
  id: number;
  commitment_id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';
  priority: 'high' | 'normal' | 'low';
  assignee: string | null;
  due_date: string | null;
  due_at: string | null;
  deadline_offset_minutes: number | null;
  revision: number;
  temporal_state:
    | 'closed'
    | 'exact_upcoming'
    | 'exact_overdue'
    | 'date_upcoming'
    | 'date_due'
    | 'date_overdue'
    | 'unscheduled';
  source_channel: string | null;
  latest_event: string | null;
  auto_created: boolean;
  confirmed: boolean;
  created_at: number;
  updated_at: number;
}

export interface ArchiveGraphNode {
  id: string;
  kind?: string;
  state?: string;
  label?: string;
  topic?: string;
  decision_preview?: string;
  decision?: string;
  reasoning?: string;
  confidence?: number | null;
  created_at?: number;
  outcome?: string | null;
  [key: string]: unknown;
}

export interface ArchiveGraphEdge {
  id: string;
  from: string;
  to: string;
  relationship: string;
  reason?: string | null;
  [key: string]: unknown;
}

export interface ArchiveGraphResponse {
  nodes: ArchiveGraphNode[];
  edges: ArchiveGraphEdge[];
  similarityEdges: unknown[];
  meta: Record<string, unknown>;
  latency: number;
}

const TASK_STATUSES = new Set<ArchiveOperatorTask['status']>([
  'pending',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
]);
const TASK_PRIORITIES = new Set<ArchiveOperatorTask['priority']>(['high', 'normal', 'low']);

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function archiveStatus(value: unknown, withdrawn: boolean): ArchiveOperatorTask['status'] {
  if (typeof value === 'string' && TASK_STATUSES.has(value as ArchiveOperatorTask['status'])) {
    return value as ArchiveOperatorTask['status'];
  }
  return withdrawn ? 'cancelled' : 'pending';
}

function archivePriority(value: unknown): ArchiveOperatorTask['priority'] {
  return typeof value === 'string' && TASK_PRIORITIES.has(value as ArchiveOperatorTask['priority'])
    ? (value as ArchiveOperatorTask['priority'])
    : 'normal';
}

function validDate(value: string | null): boolean {
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function normalizeDueAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function temporalState(
  status: ArchiveOperatorTask['status'],
  dueAt: string | null,
  dueDate: string | null,
  now: number
): ArchiveOperatorTask['temporal_state'] {
  if (status === 'done' || status === 'cancelled') return 'closed';
  if (dueAt !== null) return Date.parse(dueAt) > now ? 'exact_upcoming' : 'exact_overdue';
  if (dueDate === null || !validDate(dueDate)) return 'unscheduled';
  const today = new Date(now).toISOString().slice(0, 10);
  if (dueDate > today) return 'date_upcoming';
  if (dueDate === today) return 'date_due';
  return 'date_overdue';
}

function operatorTaskEventTimes(item: CommitmentView): { createdAt: number; updatedAt: number } {
  if (item.history === undefined || item.history.length === 0) {
    return { createdAt: item.createdAt, updatedAt: item.updatedAt };
  }
  const revisions = [...item.history].sort(
    (left, right) =>
      (left.eventDatetime ?? left.createdAt) - (right.eventDatetime ?? right.createdAt) ||
      left.revision - right.revision
  );
  return {
    createdAt: revisions[0]!.eventDatetime ?? revisions[0]!.createdAt,
    updatedAt:
      revisions[revisions.length - 1]!.eventDatetime ?? revisions[revisions.length - 1]!.createdAt,
  };
}

function archiveTask(item: CommitmentView, now: number): ArchiveOperatorTask {
  const values = recordValue(item.values);
  const eventTimes = operatorTaskEventTimes(item);
  const status = archiveStatus(values.status, item.withdrawn);
  const dueDate = stringValue(values.deadline);
  const dueAt = normalizeDueAt(values.dueAt);
  const offset =
    typeof values.deadlineOffsetMinutes === 'number' &&
    Number.isSafeInteger(values.deadlineOffsetMinutes)
      ? values.deadlineOffsetMinutes
      : null;
  return {
    id: item.rowId,
    commitment_id: item.commitmentId,
    title: stringValue(values.title) ?? '',
    status,
    priority: archivePriority(values.priority),
    assignee: stringValue(values.assignee ?? values.assigneeText),
    due_date: dueDate !== null && validDate(dueDate) ? dueDate : null,
    due_at: dueAt,
    deadline_offset_minutes: offset,
    revision: item.revision,
    temporal_state: temporalState(status, dueAt, dueDate, now),
    source_channel: stringValue(values.sourceChannel ?? values.source_channel),
    latest_event: stringValue(values.latestEvent ?? values.latest_event),
    auto_created: values.autoCreated === true || values.auto_created === true,
    confirmed: values.confirmed === true,
    created_at: eventTimes.createdAt,
    updated_at: eventTimes.updatedAt,
  };
}

export function shapeOperatorTasks(
  page: CommitmentPage,
  options: { now?: number; status?: string; sourceChannel?: string; limit?: number } = {}
): { tasks: ArchiveOperatorTask[]; reason?: string } {
  const now = options.now ?? Date.now();
  let tasks = page.items.map((item) => archiveTask(item, now));
  if (options.status !== undefined) tasks = tasks.filter((task) => task.status === options.status);
  if (options.sourceChannel !== undefined) {
    tasks = tasks.filter((task) => task.source_channel === options.sourceChannel);
  }
  if (options.limit !== undefined) tasks = tasks.slice(0, options.limit);
  return { tasks };
}

function graphRef(ref: { kind: string; id: string }): string {
  return `${ref.kind}:${ref.id}`;
}

function preview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= 220 ? normalized : `${normalized.slice(0, 220)}...`;
}

export function mapArchiveGraphNode(node: WorkGraphPage['nodes'][number]): ArchiveGraphNode {
  const data = node.data;
  const memory = data.kind === 'memory' ? data : null;
  const summary = memory?.summary ?? node.label;
  const payload = memory?.payload ?? null;
  return {
    id: graphRef(node.ref),
    kind: data.kind,
    state: memory?.stateAtSnapshot,
    label: node.label,
    topic: memory?.topic ?? data.kind,
    decision_preview: preview(summary),
    decision: summary,
    reasoning: payload && typeof payload.reasoning === 'string' ? payload.reasoning : undefined,
    outcome: payload && typeof payload.outcome === 'string' ? payload.outcome : null,
    confidence: null,
    created_at: memory?.recordedAt ?? (data.kind === 'observation' ? data.observedAt : 0),
  };
}

export function mapArchiveGraphEdge(edge: WorkGraphPage['edges'][number]): ArchiveGraphEdge {
  const attrs = recordValue(edge.attrs);
  return {
    id: edge.id,
    from: graphRef(edge.resolvedFrom),
    to: graphRef(edge.resolvedTo),
    relationship: edge.relation,
    reason: typeof attrs.reason_text === 'string' ? attrs.reason_text : null,
  };
}

export function shapeArchiveGraph(
  page: WorkGraphPage,
  latency: number,
  kinds: readonly string[] = []
): ArchiveGraphResponse {
  const nodes = page.nodes.map(mapArchiveGraphNode);
  const edges = page.edges.map(mapArchiveGraphEdge);
  if (kinds.length === 0) {
    return {
      nodes,
      edges,
      similarityEdges: [],
      meta: {
        total_nodes: nodes.length,
        total_edges: edges.length,
        similarity_edges: 0,
        partial: page.nextCursor !== null,
        next_cursor: page.nextCursor,
        source: 'graph.query:browse',
      },
      latency,
    };
  }
  const wanted = new Set(kinds);
  const visible = new Set(
    page.nodes.filter((node) => wanted.has(node.ref.kind)).map((node) => graphRef(node.ref))
  );
  const filteredNodes = nodes.filter((node) => visible.has(node.id));
  const filteredEdges = edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to));
  return {
    nodes: filteredNodes,
    edges: filteredEdges,
    similarityEdges: [],
    meta: {
      total_nodes: filteredNodes.length,
      total_edges: filteredEdges.length,
      similarity_edges: 0,
      partial: page.nextCursor !== null,
      next_cursor: page.nextCursor,
      source: 'graph.query:browse',
    },
    latency,
  };
}
