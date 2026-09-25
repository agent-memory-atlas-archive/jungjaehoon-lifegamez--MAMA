import { createHash } from 'node:crypto';
import type { ActionContext, ActionRegistration, ActionSchemaObject } from '@jungjaehoon/mama-core';
import { recordLinkSchema, scopeRefSchema } from '@jungjaehoon/mama-core/api/catalog';
import {
  JudgmentError,
  type CommitmentView,
  type JudgmentAccess,
  type CreateWorkCommand,
  type Knowledge,
  type OwnerWorkPatch,
  type ReviseWorkCommand,
  type WorkRead,
} from '@jungjaehoon/mama-core/knowledge';

export interface WorkPorts {
  knowledge: Pick<Knowledge, 'createWork' | 'reviseWork'>;
}

export interface WorkListPorts {
  knowledge: Pick<Knowledge, 'readWork'>;
}

export interface WorkListViewContext {
  readonly knowledge: Pick<Knowledge, 'readWork'>;
  readonly access: JudgmentAccess;
  readonly now?: () => number;
}

export interface WorkListTextWindow {
  readonly value: string;
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly nextOffset: number | null;
  readonly complete: boolean;
}

type PublicWorkStatus = 'pending' | 'in_progress' | 'review' | 'blocked' | 'done' | 'cancelled';

interface WorkListFilter {
  readonly status?: PublicWorkStatus;
  readonly stage?: string;
  readonly project?: string;
  readonly text?: string;
  readonly asOf?: number;
  /** Items written at or after this epoch-ms instant: what an orchestrated turn changed. */
  readonly changedSince?: number;
}

interface WorkListCursor {
  readonly v: 1;
  readonly filter: string;
  readonly readVersion: string;
  readonly offset: number;
}

interface WorkListSnapshot {
  readonly items: readonly CommitmentView[];
  readonly readVersion: string;
  readonly observedAt: number;
}

interface WorkListOverview {
  success: true;
  view: 'overview';
  total: number;
  observedAt: string;
  readVersion: string;
  status: Record<PublicWorkStatus, number>;
  priority: Record<string, number>;
  channels: Array<{ channel: string | null; count: number }>;
  assignees: Array<{ assignee: string | null; count: number }>;
  due: { missing: number; overdue: number; upcoming: number; closed: number };
}

interface WorkListItems {
  success: true;
  view: 'items';
  tasks: Array<Record<string, unknown>>;
  total: number;
  returned: number;
  nextCursor: string | null;
  observedAt: string;
  readVersion: string;
}

interface WorkListDetail {
  success: true;
  view: 'detail';
  tasks: Array<Record<string, unknown>>;
  missingIds: Array<string | number>;
  observedAt: string;
}

export type WorkListViewResult = WorkListOverview | WorkListItems | WorkListDetail;

const WORK_LIST_DEFAULT_LIMIT = 25;
const WORK_LIST_MAX_LIMIT = 50;
const WORK_LIST_MAX_DETAIL_IDS = 4;
const WORK_LIST_DEFAULT_TEXT_LIMIT = 1_000;
const WORK_LIST_MAX_TEXT_LIMIT = 2_000;
const WORK_LIST_STATUSES: readonly PublicWorkStatus[] = [
  'pending',
  'in_progress',
  'review',
  'blocked',
  'done',
  'cancelled',
];
const WORK_LIST_PRIORITIES = ['high', 'normal', 'low'] as const;

function workListObject(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('work.list input must be an object');
  }
  return value as Record<string, unknown>;
}

function workListString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`work.list ${field} must be a string`);
  return value;
}

function workListInteger(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`work.list ${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function workListNonNegativeInteger(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`work.list ${field} must be a non-negative integer`);
  }
  return value as number;
}

function workListAsOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error('work.list asOf must be a non-negative epoch-millisecond integer');
  }
  return value as number;
}

function workListFilter(input: Record<string, unknown>): WorkListFilter {
  const rawStatus = workListString(input.status, 'status');
  if (rawStatus !== undefined && !WORK_LIST_STATUSES.includes(rawStatus as PublicWorkStatus)) {
    throw new Error(`work.list status must be one of ${WORK_LIST_STATUSES.join('|')}`);
  }
  return {
    ...(rawStatus === undefined ? {} : { status: rawStatus as PublicWorkStatus }),
    ...(input.stage === undefined ? {} : { stage: workListString(input.stage, 'stage') }),
    ...(input.project === undefined ? {} : { project: workListString(input.project, 'project') }),
    ...(input.text === undefined ? {} : { text: workListString(input.text, 'text') }),
    ...(input.asOf === undefined ? {} : { asOf: workListAsOf(input.asOf) }),
    ...(input.changedSince === undefined ? {} : { changedSince: workListAsOf(input.changedSince) }),
  };
}

function workListValueObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function workListText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function workListStatus(item: CommitmentView): PublicWorkStatus {
  const value = workListValueObject(item.values).status;
  if (typeof value === 'string' && WORK_LIST_STATUSES.includes(value as PublicWorkStatus)) {
    return value as PublicWorkStatus;
  }
  if (value !== undefined && value !== null) {
    throw new Error(
      `work.list encountered a status outside the contract: ${JSON.stringify(value)}`
    );
  }
  return item.withdrawn ? 'cancelled' : 'pending';
}

function workListPriority(item: CommitmentView): string {
  const value = workListText(workListValueObject(item.values).priority);
  return value !== null &&
    WORK_LIST_PRIORITIES.includes(value as (typeof WORK_LIST_PRIORITIES)[number])
    ? value
    : 'normal';
}

function workListEventTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return null;
}

function workListIso(value: unknown): string | null {
  const ms = workListEventTime(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function workListDueState(
  item: CommitmentView,
  now: number
):
  | 'closed'
  | 'exact_upcoming'
  | 'exact_overdue'
  | 'date_upcoming'
  | 'date_due'
  | 'date_overdue'
  | 'unscheduled' {
  const status = workListStatus(item);
  if (status === 'done' || status === 'cancelled') return 'closed';
  const values = workListValueObject(item.values);
  const exact = workListEventTime(values.dueAt ?? values.due_at);
  if (exact !== null) return exact > now ? 'exact_upcoming' : 'exact_overdue';
  const deadline = workListText(values.deadline ?? values.due_date);
  if (deadline === null || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return 'unscheduled';
  const deadlineMs = Date.parse(`${deadline}T00:00:00.000+09:00`);
  if (!Number.isFinite(deadlineMs)) return 'unscheduled';
  const today = new Date(now + 9 * 60 * 60 * 1_000).toISOString().slice(0, 10);
  if (deadline > today) return 'date_upcoming';
  if (deadline === today) return 'date_due';
  return 'date_overdue';
}

function workListCompact(item: CommitmentView, now: number): Record<string, unknown> {
  const values = workListValueObject(item.values);
  const status = workListStatus(item);
  const assignee = workListText(values.assignee ?? values.assigneeText ?? values.assignee_text);
  const deadline = workListText(values.deadline ?? values.due_date);
  const sourceChannel = workListText(values.sourceChannel ?? values.source_channel);
  const sourceEventId = workListText(values.sourceEventId ?? values.source_event_id);
  const latestEvent = workListText(values.latestEvent ?? values.latest_event);
  const compact: Record<string, unknown> = {
    id: item.rowId,
    commitmentId: item.commitmentId,
    revision: item.revision,
    title: workListText(values.title),
    status,
    stage: workListText(values.stage),
    project: workListText(values.project),
    temporal_state: workListDueState(item, now),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  const priority = workListPriority(item);
  if (priority !== 'normal') compact.priority = priority;
  const optional: Array<[string, unknown]> = [
    ['assignee', assignee],
    ['deadline', deadline],
    ['due_at', workListIso(values.dueAt ?? values.due_at)],
    [
      'deadline_offset_minutes',
      typeof values.deadlineOffsetMinutes === 'number'
        ? values.deadlineOffsetMinutes
        : typeof values.deadline_offset_minutes === 'number'
          ? values.deadline_offset_minutes
          : null,
    ],
    ['sourceChannel', sourceChannel],
    ['sourceEventId', sourceEventId],
    ['completion_criteria', workListText(values.completionCriteria ?? values.completion_criteria)],
    ['resolution_kind', workListText(values.resolutionKind ?? values.resolution_kind)],
    ['latest_event', latestEvent],
    ['lastEventTime', values.lastEventTime ?? values.last_event_time],
  ];
  for (const [key, value] of optional) {
    if (value !== null && value !== undefined) compact[key] = value;
  }
  if (values.autoCreated === true || values.auto_created === true) compact.auto_created = true;
  if (values.confirmed === true) compact.confirmed = true;
  if (item.withdrawn) compact.withdrawn = true;
  return compact;
}

function workListMatches(item: CommitmentView, filter: WorkListFilter): boolean {
  const values = workListValueObject(item.values);
  if (filter.status !== undefined && workListStatus(item) !== filter.status) return false;
  if (filter.stage !== undefined && workListText(values.stage) !== filter.stage) return false;
  if (filter.project !== undefined && workListText(values.project) !== filter.project) return false;
  if (filter.changedSince !== undefined && item.updatedAt < filter.changedSince) return false;
  if (filter.text !== undefined) {
    const needle = filter.text.toLocaleLowerCase();
    const haystack = [workListText(values.title), workListText(values.description)]
      .filter((value): value is string => value !== null)
      .join('\n')
      .toLocaleLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  return true;
}

function workListFingerprint(filter: WorkListFilter): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        filter.status ?? null,
        filter.stage ?? null,
        filter.project ?? null,
        filter.text ?? null,
        filter.asOf ?? null,
      ])
    )
    .digest('base64url')
    .slice(0, 22);
}

function workListReadVersion(items: readonly CommitmentView[]): string {
  const state = items.map((item) => ({
    commitmentId: item.commitmentId,
    rowId: item.rowId,
    revision: item.revision,
    latestJudgmentRef: item.latestJudgmentRef,
    values: item.values,
    withdrawn: item.withdrawn,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
  return createHash('sha256').update(JSON.stringify(state)).digest('base64url');
}

function workListReadSnapshot(ctx: WorkListViewContext, filter: WorkListFilter): WorkListSnapshot {
  const items: CommitmentView[] = [];
  const incompleteReasons: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const query: WorkRead = {
      history: 'current',
      limit: 100,
      ...(filter.asOf === undefined ? {} : { asOf: filter.asOf }),
      ...(cursor === undefined ? {} : { cursor }),
    };
    const page = ctx.knowledge.readWork(query, ctx.access);
    items.push(...page.items);
    incompleteReasons.push(
      ...page.coverage.reasons.filter((reason) => reason !== 'more commitments follow this page')
    );
    if (incompleteReasons.length > 0) {
      throw new Error(`work.list read is incomplete: ${incompleteReasons.join('; ')}`);
    }
    if (page.nextCursor === null) {
      break;
    }
    cursor = page.nextCursor;
  }
  const observedAt = ctx.now?.() ?? Date.now();
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new Error('work.list observed time must be a non-negative epoch-millisecond integer');
  }
  return { items: Object.freeze(items), readVersion: workListReadVersion(items), observedAt };
}

function encodeWorkListCursor(cursor: WorkListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeWorkListCursor(value: unknown, filter: WorkListFilter): WorkListCursor {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_096) {
    throw new Error('work.list cursor is malformed; restart the items read from the first page');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    throw new Error('work.list cursor is malformed; restart the items read from the first page');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('work.list cursor is malformed; restart the items read from the first page');
  }
  const candidate = parsed as Partial<WorkListCursor>;
  if (
    candidate.v !== 1 ||
    typeof candidate.filter !== 'string' ||
    typeof candidate.readVersion !== 'string' ||
    !Number.isSafeInteger(candidate.offset) ||
    (candidate.offset as number) < 0
  ) {
    throw new Error('work.list cursor is malformed; restart the items read from the first page');
  }
  if (candidate.filter !== workListFingerprint(filter)) {
    throw new Error(
      'work.list cursor belongs to a different query; restart the items read from the first page'
    );
  }
  return candidate as WorkListCursor;
}

function workListTextWindow(value: string, offset: number, limit: number): WorkListTextWindow {
  const points = Array.from(value);
  const start = Math.min(offset, points.length);
  const slice = points.slice(start, start + limit);
  const end = start + slice.length;
  const nextOffset = end < points.length ? end : null;
  return {
    value: slice.join(''),
    offset,
    limit,
    total: points.length,
    nextOffset,
    complete: nextOffset === null,
  };
}

function workListDetailIds(value: unknown): Array<string | number> {
  if (!Array.isArray(value) || value.length < 1 || value.length > WORK_LIST_MAX_DETAIL_IDS) {
    throw new Error(`work.list detail ids must contain 1 to ${WORK_LIST_MAX_DETAIL_IDS} ids`);
  }
  const ids = value.map((id) => {
    if (
      (typeof id !== 'string' && typeof id !== 'number') ||
      (typeof id === 'string' && id.trim() === '') ||
      (typeof id === 'number' && (!Number.isSafeInteger(id) || id < 1))
    ) {
      throw new Error('work.list detail ids must be nonblank commitment ids or positive row ids');
    }
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('work.list detail ids must be distinct');
  return ids;
}

function workListDetailRecord(
  item: CommitmentView,
  textOffset: number,
  textLimit: number,
  now: number
): Record<string, unknown> {
  if (item.history === undefined)
    throw new Error('work.list detail did not return revision history');
  const values = workListValueObject(item.values);
  const detailedValues = { ...values } as Record<string, unknown>;
  for (const field of ['title', 'description', 'latestEvent']) {
    const value = values[field];
    if (typeof value === 'string')
      detailedValues[field] = workListTextWindow(value, textOffset, textLimit);
  }
  const compact = workListCompact(item, now);
  return {
    ...compact,
    title:
      typeof values.title === 'string'
        ? workListTextWindow(values.title, textOffset, textLimit)
        : null,
    description:
      typeof values.description === 'string'
        ? workListTextWindow(values.description, textOffset, textLimit)
        : null,
    latestEvent:
      typeof values.latestEvent === 'string'
        ? workListTextWindow(values.latestEvent, textOffset, textLimit)
        : null,
    values: detailedValues,
    basis: item.basis,
    history: item.history,
    latestJudgmentRef: item.latestJudgmentRef,
  };
}

function workListDetail(input: Record<string, unknown>, ctx: WorkListViewContext): WorkListDetail {
  const ids = workListDetailIds(input.ids);
  const textOffset = workListNonNegativeInteger(input.text_offset, 'text_offset', 0);
  const textLimit = workListInteger(
    input.text_limit,
    'text_limit',
    WORK_LIST_DEFAULT_TEXT_LIMIT,
    1,
    WORK_LIST_MAX_TEXT_LIMIT
  );
  const asOf = workListAsOf(input.asOf);
  const now = ctx.now?.() ?? Date.now();
  const tasks: Array<Record<string, unknown>> = [];
  const missingIds: Array<string | number> = [];
  for (const id of ids) {
    const query: WorkRead = {
      history: 'all',
      ...(asOf === undefined ? {} : { asOf }),
      ...(typeof id === 'number' ? { rowId: id } : { commitmentId: id }),
    };
    const page = ctx.knowledge.readWork(query, ctx.access);
    const item = page.items[0];
    if (item === undefined) {
      missingIds.push(id);
      continue;
    }
    tasks.push(workListDetailRecord(item, textOffset, textLimit, now));
  }
  return {
    success: true,
    view: 'detail',
    tasks,
    missingIds,
    observedAt: new Date(now).toISOString(),
  };
}

function workListOverview(
  filter: WorkListFilter,
  snapshot: WorkListSnapshot,
  now: number
): WorkListOverview {
  const items = snapshot.items.filter((item) => workListMatches(item, filter));
  const status = Object.fromEntries(WORK_LIST_STATUSES.map((name) => [name, 0])) as Record<
    PublicWorkStatus,
    number
  >;
  const priority = Object.fromEntries(WORK_LIST_PRIORITIES.map((name) => [name, 0])) as Record<
    string,
    number
  >;
  const channels = new Map<string | null, number>();
  const assignees = new Map<string | null, number>();
  const due = { missing: 0, overdue: 0, upcoming: 0, closed: 0 };
  for (const item of items) {
    const values = workListValueObject(item.values);
    const itemStatus = workListStatus(item);
    status[itemStatus] += 1;
    const itemPriority = workListPriority(item);
    priority[itemPriority] = (priority[itemPriority] ?? 0) + 1;
    const channel = workListText(values.sourceChannel ?? values.source_channel);
    channels.set(channel, (channels.get(channel) ?? 0) + 1);
    const assignee = workListText(values.assignee ?? values.assigneeText ?? values.assignee_text);
    assignees.set(assignee, (assignees.get(assignee) ?? 0) + 1);
    const temporal = workListDueState(item, now);
    if (temporal === 'closed') due.closed += 1;
    else if (temporal === 'unscheduled') due.missing += 1;
    else if (temporal.endsWith('overdue')) due.overdue += 1;
    else due.upcoming += 1;
  }
  const sortedFacet = (values: Map<string | null, number>) =>
    [...values.entries()]
      .sort((left, right) => String(left[0] ?? '').localeCompare(String(right[0] ?? '')))
      .map(([value, count]) => ({
        [values === channels ? 'channel' : 'assignee']: value,
        count,
      })) as Array<{
      channel: string | null;
      assignee: string | null;
      count: number;
    }>;
  const channelRows = sortedFacet(channels).map((row) => ({
    channel: row.channel,
    count: row.count,
  }));
  const assigneeRows = sortedFacet(assignees).map((row) => ({
    assignee: row.assignee,
    count: row.count,
  }));
  return {
    success: true,
    view: 'overview',
    total: items.length,
    observedAt: new Date(snapshot.observedAt).toISOString(),
    readVersion: snapshot.readVersion,
    status,
    priority,
    channels: channelRows,
    assignees: assigneeRows,
    due,
  };
}

export function runWorkListView(rawInput: unknown, ctx: WorkListViewContext): WorkListViewResult {
  const input = workListObject(rawInput);
  const view = input.view === undefined ? 'items' : input.view;
  if (view !== 'overview' && view !== 'items' && view !== 'detail') {
    throw new Error('work.list view must be one of overview|items|detail');
  }
  if (view === 'detail') return workListDetail(input, ctx);
  const filter = workListFilter(input);
  const snapshot = workListReadSnapshot(ctx, filter);
  const now = ctx.now?.() ?? snapshot.observedAt;
  if (view === 'overview') return workListOverview(filter, snapshot, now);

  const limit = workListInteger(
    input.limit,
    'limit',
    WORK_LIST_DEFAULT_LIMIT,
    1,
    WORK_LIST_MAX_LIMIT
  );
  const decoded = input.cursor === undefined ? null : decodeWorkListCursor(input.cursor, filter);
  if (decoded !== null && decoded.readVersion !== snapshot.readVersion) {
    throw new Error(
      'work.list board changed since this cursor was issued; restart the items read from the first page'
    );
  }
  const filtered = snapshot.items.filter((item) => workListMatches(item, filter));
  const offset = decoded?.offset ?? 0;
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length < filtered.length ? offset + page.length : null;
  return {
    success: true,
    view: 'items',
    tasks: page.map((item) => workListCompact(item, now)),
    total: filtered.length,
    returned: page.length,
    nextCursor:
      nextOffset === null
        ? null
        : encodeWorkListCursor({
            v: 1,
            filter: workListFingerprint(filter),
            readVersion: snapshot.readVersion,
            offset: nextOffset,
          }),
    observedAt: new Date(snapshot.observedAt).toISOString(),
    readVersion: snapshot.readVersion,
  };
}

/** Archive callers used this name; keep the carried view contract name at the action boundary. */
export const runTaskListView = runWorkListView;

export function workListActionRegistrations(ports: WorkListPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'work.list',
        summary:
          'Read owner work progressively: overview counts, bounded items pages, or up to four detailed records with history and text continuation.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            view: { type: 'string', enum: ['overview', 'items', 'detail'] },
            ids: {
              type: 'array',
              minItems: 1,
              maxItems: WORK_LIST_MAX_DETAIL_IDS,
              items: {
                oneOf: [
                  { type: 'string', minLength: 1 },
                  { type: 'integer', minimum: 1 },
                ],
              },
            },
            limit: { type: 'integer', minimum: 1, maximum: WORK_LIST_MAX_LIMIT },
            cursor: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: WORK_LIST_STATUSES },
            stage: { type: 'string' },
            project: { type: 'string' },
            text: { type: 'string' },
            asOf: { type: 'integer', minimum: 0 },
            changedSince: {
              type: 'integer',
              minimum: 0,
              description:
                'Only items written at or after this epoch-ms time, e.g. the start of your turn.',
            },
            text_offset: { type: 'integer', minimum: 0 },
            text_limit: { type: 'integer', minimum: 1, maximum: WORK_LIST_MAX_TEXT_LIMIT },
            history: { type: 'string', enum: ['current', 'all'] },
          },
        },
        examples: [
          { title: 'Work overview', input: { view: 'overview' } },
          { title: 'First work page', input: { view: 'items', limit: WORK_LIST_DEFAULT_LIMIT } },
          { title: 'Work detail', input: { view: 'detail', ids: ['commitment-reference'] } },
        ],
      },
      exec: (input, context) =>
        runWorkListView(input, { knowledge: ports.knowledge, access: context.access }),
    },
  ];
}

const nullableText: ActionSchemaObject = {
  description: 'Optional text value; null clears the field, e.g. "reviewed" or null.',
  oneOf: [{ type: 'string' }, { type: 'null' }],
};

const workFileSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    locator: { type: 'string', minLength: 1, description: 'Relevant file locator.' },
    version: { type: 'string', minLength: 1, description: 'Relevant file version.' },
    hash: { type: 'string', minLength: 1, description: 'Relevant file content hash.' },
  },
  required: ['locator', 'version', 'hash'],
};

const workRoleSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: true,
  properties: {
    personRef: { type: 'string', minLength: 1, description: 'Person reference for the role.' },
    role: { type: 'string', minLength: 1, description: 'Role judged from evidence.' },
    evidenceRefs: {
      type: 'array',
      description: 'Stable observationRef handles supporting the role.',
      items: { type: 'string', minLength: 1 },
    },
    confirmed: {
      type: 'boolean',
      description:
        'True when evidence confirms the role; false is the explicit unconfirmed status.',
    },
  },
};

const workPatchSchema: ActionSchemaObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { ...nullableText, description: 'Work title, e.g. "Prepare release" or null.' },
    description: {
      ...nullableText,
      description: 'Work description, e.g. "Collect review" or null.',
    },
    status: {
      description:
        'Work status: pending, in_progress, review, blocked, done or cancelled; or null. The owner stage stays in stage.',
      oneOf: [
        {
          type: 'string',
          enum: ['pending', 'in_progress', 'review', 'blocked', 'done', 'cancelled'],
        },
        { type: 'null' },
      ],
    },
    priority: { ...nullableText, description: 'Work priority, e.g. "high" or null.' },
    dueAt: { ...nullableText, description: 'Due-time text, e.g. "2026-09-30" or null.' },
    deadline: { ...nullableText, description: 'Deadline text, e.g. "Friday" or null.' },
    deadlineOffsetMinutes: {
      description: 'Deadline offset from the stated event, e.g. 60 or null.',
      oneOf: [{ type: 'integer', minimum: -840, maximum: 840 }, { type: 'null' }],
    },
    stage: { ...nullableText, description: 'Current work stage, or null to clear it.' },
    project: {
      ...nullableText,
      description: 'project associated with the work, or null to clear it.',
    },
    lastEventTime: {
      ...nullableText,
      description:
        'Timezone-qualified ISO timestamp for the source event time, not replay time, or null.',
    },
    files: {
      description: 'Relevant file locator/version/hash entries preserved with the work, or null.',
      oneOf: [{ type: 'array', items: workFileSchema }, { type: 'null' }],
    },
    completionCriteria: {
      type: 'string',
      pattern: '\\S',
      description: 'Evidence-based completion rule, e.g. "Owner approves".',
    },
    assignee: { ...nullableText, description: 'Assigned person text, e.g. "person_123" or null.' },
    assigneeText: {
      ...nullableText,
      description: 'Unresolved assignee text, e.g. "reviewer" or null.',
    },
    latestEvent: {
      ...nullableText,
      description: 'Latest work event text, e.g. "review requested" or null.',
    },
    confirmed: {
      description: 'Whether the patch is confirmed, e.g. true or null.',
      oneOf: [{ type: 'boolean' }, { type: 'null' }],
    },
    roles: {
      description:
        'Evidence-backed role entries with personRef, role, evidenceRefs and confirmed; use false for an explicit unconfirmed status, or null.',
      oneOf: [{ type: 'array', items: workRoleSchema }, { type: 'null' }],
    },
    data: {
      description: 'Product-specific structured fields, e.g. {"stage":"review"} or null.',
      oneOf: [{ type: 'object' }, { type: 'null' }],
    },
  },
};

const commandFields: Record<string, ActionSchemaObject> = {
  topic: { type: 'string', minLength: 1, description: 'Work topic key, e.g. "release".' },
  summary: {
    type: 'string',
    minLength: 1,
    description: 'What changed and why, e.g. "Review is requested".',
  },
  reasoning: {
    type: 'string',
    minLength: 1,
    description: 'Decision reasoning, e.g. "The source confirms the handoff".',
  },
  scopes: {
    type: 'array',
    description: 'Work visibility scopes, e.g. [{"kind":"project","id":"project_123"}].',
    items: scopeRefSchema,
  },
  sourceRefs: {
    type: 'array',
    description: 'Stable observationRef citation handles, e.g. ["obs_123"].',
    items: { type: 'string', minLength: 1 },
  },
  links: {
    type: 'array',
    description:
      'Graph links from this revision: derived_from an observation it rests on; supersedes, amends or refines an earlier record it replaces or corrects; contradicts one it reverses; builds_on or synthesizes records it extends or combines; blocks or next_action_for another work item. E.g. [{"relation":"derived_from","target":{"kind":"observation","id":"obs_123"}}].',
    items: recordLinkSchema,
  },
  eventDatetime: {
    description:
      'Source event time as epoch milliseconds, not replay time, or null, e.g. 1760000000000.',
    oneOf: [{ type: 'number' }, { type: 'null' }],
  },
  recordedAt: {
    type: 'number',
    description: 'Record time as epoch milliseconds, e.g. 1760000000000.',
  },
  event: { type: 'object', description: 'Structured event details, e.g. {"kind":"review"}.' },
};

const createSchema: ActionSchemaObject = {
  type: 'object',
  required: ['topic', 'summary', 'set'],
  additionalProperties: false,
  properties: {
    ...commandFields,
    set: {
      ...workPatchSchema,
      description: 'Fields to set on the new work item, e.g. {"title":"Prepare release"}.',
    },
  },
};

const reviseSchema: ActionSchemaObject = {
  type: 'object',
  required: ['commitmentId', 'expectedRevision', 'topic', 'summary'],
  additionalProperties: false,
  properties: {
    ...commandFields,
    commitmentId: {
      type: 'string',
      minLength: 1,
      description: 'stable commitmentId citation handle to revise, e.g. "commitment_123".',
    },
    expectedRevision: {
      type: 'integer',
      minimum: 0,
      description: 'Revision read before editing, e.g. 2.',
    },
    set: {
      ...workPatchSchema,
      description: 'Fields to update on the existing work item, e.g. {"assignee":null}.',
    },
    clear: {
      type: 'array',
      description: 'Patch fields to clear, e.g. ["assignee"].',
      items: { type: 'string' },
    },
  },
};

function operationId(context: ActionContext, action: string): string {
  if (typeof context.operationId !== 'string' || context.operationId.trim() === '') {
    throw new JudgmentError('INVALID_COMMAND', `${action} requires operationId`);
  }
  return context.operationId;
}

function commandFieldsFrom(body: Record<string, unknown>): Record<string, unknown> {
  const { commitmentId: _commitmentId, expectedRevision: _expectedRevision, ...fields } = body;
  return fields;
}

export function assertReplayEventDatetime(
  body: Record<string, unknown>,
  context: ActionContext,
  action: 'work.create' | 'work.revise'
): void {
  const ceiling = context.session?.replaySourceEndMs;
  if (ceiling === undefined) return;
  if (!Number.isSafeInteger(ceiling) || ceiling < 0) {
    throw new JudgmentError(
      'REPLAY_SOURCE_CEILING_INVALID',
      'Replay source ceiling must be a nonnegative epoch millisecond integer'
    );
  }
  const eventDatetime = body.eventDatetime;
  if (
    typeof eventDatetime !== 'number' ||
    !Number.isSafeInteger(eventDatetime) ||
    eventDatetime <= 0
  ) {
    throw new JudgmentError(
      'REPLAY_EVENT_TIME_REQUIRED',
      `${action} requires eventDatetime during replay`
    );
  }
  if (eventDatetime > ceiling) {
    throw new JudgmentError(
      'REPLAY_EVENT_TIME_AFTER_CEILING',
      `${action} eventDatetime is later than the active replay source ceiling`
    );
  }
}

export function minimalWorkActionRegistrations(ports: WorkPorts): ActionRegistration[] {
  return [
    {
      contract: {
        name: 'work.create',
        recallableWrite: true,
        summary:
          'Create one owner-work commitment. Product fields such as assignee and roles remain part of the revision patch; links with relation derived_from cite the observations the work rests on.',
        inputSchema: createSchema,
        examples: [
          {
            title: 'Create owner work',
            input: {
              topic: 'work topic',
              summary: 'what the work means',
              set: { title: 'work title', assignee: 'assignee', roles: [] },
            },
          },
        ],
      },
      exec: (input, context) => {
        const body = input as Record<string, unknown>;
        assertReplayEventDatetime(body, context, 'work.create');
        return ports.knowledge.createWork(
          {
            ...body,
            ...commandFieldsFrom(body),
            commandId: operationId(context, 'work.create'),
            modelRunId: context.session?.modelRunId,
          } as unknown as CreateWorkCommand,
          context.access
        );
      },
    },
    {
      contract: {
        name: 'work.revise',
        recallableWrite: true,
        summary:
          'Revise owner work at an expected revision. The required summary states what changed and why, in one or two sentences. Compare-and-set prevents overwriting a revision the caller did not read; links with relation derived_from cite the observations the revision rests on.',
        inputSchema: reviseSchema,
        examples: [
          {
            title: 'Revise assignee and roles',
            input: {
              commitmentId: 'commitment-reference',
              expectedRevision: 1,
              topic: 'work topic',
              summary: 'what changed and why',
              set: { assignee: null, roles: [] },
            },
          },
        ],
      },
      exec: (input, context) => {
        const body = input as Record<string, unknown>;
        assertReplayEventDatetime(body, context, 'work.revise');
        const commitmentId = body.commitmentId;
        return ports.knowledge.reviseWork(
          {
            ...commandFieldsFrom(body),
            commitmentId,
            expectedRevision: body.expectedRevision,
            commandId: operationId(context, 'work.revise'),
            modelRunId: context.session?.modelRunId,
          } as unknown as ReviseWorkCommand,
          context.access
        );
      },
    },
  ];
}

export type { OwnerWorkPatch };
